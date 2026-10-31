# Atlas Web: Core Search Strategy and Design (Rebuild Reference)



Audience: an engineer or coding agent who needs to understand, and be able to rebuild, how the Atlas Web agent searches its data. Everything here was read from the source on master (commit a436e9b, 2026-10-31). File and line references point into the `Embedding Atlas JS` repo.



---



## 0. One-paragraph summary



Atlas is a 2-D embedding map (a scatter plot) of CoCounsel Tax/Accounting/Audit user messages or extracted use cases, loaded into DuckDB-WASM in the browser. An LLM agent answers analytical questions by calling browser-executed tools. There is no vector search in the Web app. "Semantic" recall comes from the map geometry: the embedding projection already places similar text near each other, so the agent searches over bounded map regions ("rings" or "tiles") rather than over keywords or individual rows. Keywords are only seeds that locate candidate regions. The default strategy is called **Ring Probe**: hypothesize intent, seed candidate rings (SQL density grids, user selections, label centroids, or keyword hits), judge each ring with a region-constrained `flexible_search` (lexical retrieval plus an LLM "Analyzer" that returns a category, themes, and an `intent_fit` score), then accept, split, move to a neighbor/sibling ring, or discard. Final answers are synthesized only from accepted rings and returned evidence, rendered as `{{Category}}` cards.



---



## 1. Data and mental model



### 1.1 Two exploration modes `src/tools/agentModeConfig.js`)



| | Topic mode (default) | Use Case mode |

|---|---|---|

| DuckDB table | `atlas_topics` | `atlas_use_cases` |

| One point = | one user message (turn) | one conversation's extracted use case |

| ID / highlight column | `messages_id` | `conversation_id` |

| Searchable text columns | `content`, `company_name`, `tools_used` | `content`, `use_case_name/action/object/subject/expected_output`, `user_request_output`, `use_case_domain_context`, `doc_intent_label_context` |

| Default search columns | `['content']` | all searchable columns |

| Column weights | all 1 | action 9, object 8, expected_output 8, request_output 7, name 6, subject 5, domain 4, doc_intent 4, content 1 |

| Row order tiebreak | `turn ASC, created_at_date DESC, messages_id ASC` | `created_at_date DESC, conversation_id ASC` |

| Default dedupe | `message` | `conversation` |

| Same-conversation context / multiturn / feature flags | yes | no |



Each mode has a separate whitelist of filter fields `TOPIC_FILTER_FIELDS`, `USE_CASE_FILTER_FIELDS`); filters outside the whitelist are silently dropped by `buildFilterConditions`.



### 1.2 Core assumptions the strategy depends on



- `projection_x`, `projection_y` are a 2-D projection of text embeddings. Nearby points usually share language or intent. Coordinates are not labels; dense regions are candidate topics/families, not a taxonomy.

- Point relevance and region coherence are separate judgments. Rejecting a region does not invalidate a row inside it whose own relevance was established; such a row is kept only as isolated evidence and is never expanded or called a cluster.

- Dense regions answer "what are users asking overall". They are the wrong first step for cross-cutting facets (exports, spreadsheet output, uploaded docs, review burden) because those scatter across many topics.

- In Topic mode, a set of message points can belong to fewer conversations. Never equate point count with conversation count.

- Topic discovery defaults to `filters: {turn: 1}` (follow-ups inflate counts with "thanks"/rephrasing), except for follow-up, friction, multi-turn, or journey questions.



### 1.3 Data flow



```

Snowflake -> Express gateway -> ZSTD Parquet stream -> DuckDB-WASM (browser)

                                                         |

                       scatter plot (vendor/embedding-atlas) + all agent tool SQL

```



The server never runs the agent's search SQL. It only (a) proxies LLM calls, (b) serves playbooks, (c) runs the Analyzer / Multiturn Analyzer LLM calls, (d) fetches BrainTrust traces.



---



## 2. System layers



```

User question

   |

   v

AgentChatWidget.jsx  -- builds per-turn context (data scope, projection bounds,

   |                    map labels, selection, highlights, Workbench snapshot)

   v

useAgentChat.js  -- client-side agent loop (max 35 iterations)

   |      POST /api/agent/stream  (SSE; system prompt built server-side)

   |<---- tool_use blocks

   v

toolExecutor.js  -- executes tools in browser, tools in one batch run in parallel (Promise.all)

   |   sql_query, map_search, flexible_search  -> DuckDB-WASM via Mosaic Coordinator

   |   flexible_search -> POST /api/analyzer (LLM)

   |   multiturn_analyzer -> POST /api/multiturn-analyzer (LLM)

   |   pull_log -> POST /api/braintrust/logs

   |   load_workflow_playbook -> POST /api/agent/workflow-playbook

   v

agentWorkspace.js -- records every tool result into DuckDB Workbench tables,

                     returns result_set_id, builds ring-probe ledger for next turn

```



Models `src/llm/index.js`): agent `claude-sonnet-5-5`; Analyzer default `claude-haiku-5-5` (thinking disabled), `claude-sonnet-5` allowed.



---



## 3. Turn protocol (how a single user turn runs)



1. **Playbook gate (code-enforced).** The first assistant tool message of every user turn must be exactly one `load_workflow_playbook` call. `ToolExecutor.requiresWorkflowPlaybook` blocks `sql_query`, `map_search`, `flexible_search`, `pull_log`, `multiturn_analyzer`, `workspace_update` with an error `required_next_step: Call load_workflow_playbook first`) until a playbook is loaded. `resetWorkflowPlaybook()` is called at the start of every user turn `useAgentChat.js:431`).

2. The system prompt contains only a TOC of playbooks (title + "Intent fit" extracted by `formatPlaybookToc`). The full playbook text is fetched by the tool and returned as a tool result, so it lands in context only for the chosen workflow.

3. **report_progress** is called alongside the first data tool (and on later phase changes): at most two business-language sentences, no tool names/SQL/IDs.

4. Data tools run; batches execute in parallel.

5. **complete_answer** `ready_to_answer: true`, 0-3 `suggested_followups` with kind `compare|breakdown|investigate|validate`) must be the only non-progress tool in its response. After its result, the model streams the user-facing answer as plain text.

6. At iteration 34 of 35 the client injects a wrap-up instruction forcing `complete_answer`.

7. Confidentiality block is placed first in every system prompt: never reveal tools, playbooks, Ring Probe, SQL, table/column names, or tile mechanics to the user.



---



## 4. The core strategy: Ring Probe



### 4.1 Definition



A **ring** (also "tile") is a bounded map region `{min_x, max_x, min_y, max_y}`, normally produced by a SQL grid query returning `COUNT` plus `MIN/MAX` of the projection inside a cell. The ring, not the row, is the unit of search and evidence. Large rings maximize recall; small or shifted rings maximize purity.



### 4.2 State machine (intended for both modes; only the Use Case prompt states it explicitly)



Where it is written: the five-step state machine with explicit `accept` / `mixed` / `weak` / `off-intent` transitions appears verbatim only in the Use Case system prompt (`buildUseCaseAgentSystemPrompt`, server.js ~2665-2671 and ~2711), and in the Use Case `map_search` / `flexible_search` tool descriptions (toolDefinitions.js ~1020, ~1105-1109). The Topic prompt (`AGENT_SYSTEM_PROMPT` ~1182, ~1117) and the Topic `flexible_search` description (~496-511) declare Ring Probe the default and describe "Tile Probe" (score tile density/support, check purity, split mixed tiles, probe neighbor/sibling tiles, run `flexible_search` only on accepted tiles), which is the same loop in looser wording without the named transition states. CLAUDE.md says the state machine applies to both modes. When rebuilding, decide whether to give the Topic prompt the explicit version too.



1. **Hypothesis.** Infer the intended topic, job, facet, workflow stage, or evidence need from intent, not from matching words. For targeted/ambiguous requests, build 2-4 candidate interpretations and search each separately (never one giant OR).

2. **Seed ring.** Create bounded candidate rings from any of: SQL density grid, live map selection, Workbench set scope, map label centroids, or keyword seed hits grouped into islands. Keywords never decide the workflow, the next step, cluster switching, or the answer.

3. **Judge ring.** Inspect support/density, purity (Topic: content snippets/term distributions; Use Case: top `use_case_action/object/output/subject` and `doc_intent_*` distributions), coverage, and intent signals.

4. **Transition.**

   - `accept` -> immediately run region-constrained `flexible_search` (the Analyzer/Judge checkpoint).

   - `mixed` -> split/refine the ring once (finer grid or shifted bounds), then `flexible_search` or move to a sibling.

   - `weak` -> probe a neighbor or sibling ring.

   - `off-intent` -> discard or change the hypothesis.

5. **Synthesize** only from accepted rings with adequate support, purity, and `intent_fit`. Never from scattered points, raw keyword hits, or visual proximity.



### 4.3 Hard controls (source noted per rule)



- No consecutive SQL-only assistant turns once SQL has returned viable candidate ring boundaries. Source: CLAUDE.md; the agent sees it only in Use Case mode ("Avoid broad SQL-only probing after a viable ring exists", "before issuing another broad SQL-only turn").

- Before the first `flexible_search`, at most two SQL queries in one assistant turn. Source: CLAUDE.md only. This rule is not in any agent prompt or tool description, so the model is never told it.

- Once a viable ring exists, the next data-tool batch must include region-constrained `flexible_search`. If no viable ring exists yet, SQL exploration continues (no fixed numeric budget). Source: CLAUDE.md and the Use Case prompt; the Topic prompt only says to run `flexible_search` on accepted tiles.

- The rules below are in the prompts for both modes.

   - SQL finds and refines rings; `flexible_search` judges them; answers cite accepted-ring evidence.

   - At most 3 refinement attempts or 2 non-improving searches after the first viable evidence; then answer with a caveat or ask one clarification.

   - Each new search must change the evidence state (different interpretation, region size, anchors, or structured verification). Repeating a search shape is forbidden.



**Important for rebuilding:** these Ring Probe controls are at best prompt-level, and the two SQL-budget rules above are missing from the Topic prompt entirely (the "at most two SQL" rule is missing from both). Nothing in code counts SQL calls or blocks a SQL-only turn. The code-enforced controls are: the playbook gate, the `dimension_signal_scan` budget (4 `sql_query`, 2 `flexible_search`, then a synthetic `stop_condition_met: true` result), the 35-iteration cap, and the hard tool-result signals described in section 5 (`coverage_warning`, `seed_islands`, `conversation_concentration`). `tests/test_ring_probe_default_workflow.mjs` only asserts that the prompt strings exist.



### 4.4 Exceptions (narrower tool path allowed)



Exact structured analytics, explicit literal keyword counts, direct row/example lookup, and single-conversation trace inspection.



### 4.5 Grid ladder (normalized bins from injected bounds)



Always bin with the injected projection bounds, never `projection_x * N`:



```sql

SELECT FLOOR((projection_x - {min_x}) / {range_x} * 48) AS gx,

       FLOOR((projection_y - {min_y}) / {range_y} * 48) AS gy,

       COUNT(*) AS cnt, AVG(projection_x) AS cx, AVG(projection_y) AS cy,

       MIN(projection_x) AS min_x, MAX(projection_x) AS max_x,

       MIN(projection_y) AS min_y, MAX(projection_y) AS max_y

FROM atlas_topics WHERE turn = 1

GROUP BY 1, 2 ORDER BY cnt DESC LIMIT 10

```



- 48x48: broad landscape start.

- 96x96: top/densest visual cluster start.

- 128, 160, 192, 256: refinement inside a mixed cell (add a `projection_x BETWEEN ... AND projection_y BETWEEN ...` clause).

- Use Case: avoid treating cells under about 60 rows as a top global cluster unless a rare pocket was requested. Never rank clusters by extracted-label frequency.



### 4.6 Seed islands (keyword hits -> rings)



Keyword hits from `map_searchflexible_search` are grouped into grid cells `seed_islands`). Distant islands stay separate; each major island gets its own region-constrained `flexible_search` and its own card. Never do row-level nearest-neighbor expansion over seed IDs and merge the neighbors.



### 4.7 Map labels as extra seeds



The client passes up to 120 coarse (level 0) TF-IDF cluster labels from the embedding-atlas component: `x, y, relative_priority, text` `AgentChatWidget.jsx:51`). Rules: labels are lexical seed positions only, never evidence; never pick a hypothesis because its wording matches a label; never name a category from a label; a region without a label is not empty; a ring supported by both a label and an independent seed is stronger; labels describe the full loaded map, not the active selection; never mention labels to the user.



### 4.8 Ring probe ledger (cross-turn frontier)



Every tool result is recorded in `agent_workspace_events` with `metadata.probed_regions` `agentWorkspace.js:probedRegionsFromToolCall`): the requested `region` if one was passed, otherwise the returned `seed_islands`. On the next turn, `buildRingLedgerLines` renders up to 20 distinct regions (from the latest 40 tool events) with kind, support, and `intent_fit` into the Workbench snapshot, plus the instruction: do not re-probe high-fit or rejected regions; prefer unlisted neighbors/siblings; say when the frontier is unexplored.



---



## 5. Retrieval engine: `map_search` `toolExecutor.js:2028`)



Deterministic, lexical, runs in DuckDB-WASM, no index, no vectors. It is both a user-facing tool and the first stage of `flexible_search`.



### 5.1 Text normalization (must be identical in JS and SQL)



JS `normalizeSearchText`): lowercase -> `&` to  `and`  -> delete apostrophes `' ‘ ’ ʼ` -> every run of `[^a-z0-9()]` to one space -> trim.

SQL `normalizedColumnSql`): the same chain with `lower`, `replace`, `regexp_replace`. Matching is `normalized(column) LIKE '%normalized(term)%'`. A divergence silently drops rows (a past bug: `&` handled differently). The schema docs give the agent the same SQL expression so literal SQL counts agree with retrieval.



Note: the per-column scoring expression `mapSearchColumnTermCondition`) uses a simpler normalization (no `&`/apostrophe folding). Matching uses the full one; scoring is approximate.



### 5.2 Search plan `buildMapSearchPlan`)



- Inputs: `query` + `terms` (each truncated to 90 chars).

- `direct_phrases` = normalized raw inputs of length >= 3.

- `direct_tokens` = tokens of length >= 3 not in a small stopword list. Use Case mode also drops low-signal tokens `tax`, `use`, `case`, `user`, `client`, `help`, ...) when more than one token remains.

- `expanded_terms` = deterministic morphology only: plural/singular `s` add/remove for tokens longer than 4, not `ss`), singularized phrases. No synonyms; domain variants must be supplied by the agent in `terms`.

- All terms capped at 12 (warning emitted).

- Use Case mode with terms and no region emits a warning telling the agent to treat terms as seed generators and follow Ring Probe.



### 5.3 Three ranking paths



1. *`ranked`** (default for `map_search`): one SQL. Score = phrase hits x10 x column weight + token hits x2 x weight + variant hits x1 x weight. Order by `lexical_score`, `matched_term_count`, `phrase_score`, mode row order. Optional dedupe to best row per conversation via `ROW_NUMBER() OVER (PARTITION BY conversation_id ...)`.

2. *`recall` with terms** (default for `flexible_search`), ranking method `multi_pass_rrf_grid_v1`:

   - Passes (each its own SQL, up to 180 IDs): `phrase` (phrases, weight 8, OR/AND per match_mode), `all_tokens` (all tokens AND, weight 4, only if more than one token), `any_token` (OR, weight 2), `morphology` (variants, weight 1).

   - Reciprocal Rank Fusion: `score += 1 / (60 + rank + 1)` per pass; keep top 360; record `recall_pass_count` and pass names.

   - Re-fetch fused rows with full lexical scores, then **diversify** `selectDiversifiedMapRows`): first a "strong" quota of top rows (40% of limit in Topic, 20% in Use Case, minimum 6), then round-robin across 48x48 grid cells (Use Case key = grid cell + action|object|output family), with a Use Case per-family cap of max(4, 20% of limit).

3. *`recall` without terms** (region- or filter-only), method `scope_stratified_grid_v1`: sample up to 6 rows per 48x48 cell inside the scope (pool 360), then diversify. Reason: with no lexical score, the ranked path would just return the newest rows in one corner of the ring.



### 5.4 Clusters / seed islands `buildMapSearchClusters`)



Group all direct matches (not just returned rows) into 48x48 cells using global map bounds; take the 48 densest cells, then `selectSpreadIslands` picks 8 that are at least 2 cells apart (Chebyshev distance), backfilling with the densest remaining. Each island carries `bbox`, `support_count`, `distinct_conversations`, `dominant_conversation_share`, `conversation_fragmentation` `single_conversation_dominant` when one conversation holds at least 50% and at least 3 rows), sample IDs, and the region contract:



```

region_role: candidate_navigation_region

region_coherence_status: unvalidated

semantic_cluster_status: unconfirmed

direct_evidence_disposition: region_rejection_does_not_decide_row_relevance

```



### 5.5 Expansion rows `expand_clusters`, default false in map_search, true in flexible_search recall)



- Recall path: `fetchProjectionNeighborRows`: rows within Euclidean radius 0.045 (max 0.2) of the first 12 seed rows, excluding direct IDs, ordered by distance, up to `max_expanded` (25 default, 100 max).

- Ranked path: `fetchExpandedClusterRows`: rows inside island bboxes padded by 35% (minimum width 0.03).

- Expansion rows are `match_type: cluster_neighbor`, never highlighted, never direct evidence.



### 5.6 Control signals returned to the agent



- `projection_coverage` `buildProjectionCoverageDiagnostics`): 48x48 cell counts for scope, direct matches, returned rows, and analyzer context; row/conversation/grid coverage ratios.

- `coverage_warning` `evaluateCoverageWarning`), only when the scope has more than 100 cells:

  - direct-match grid coverage < 3% -> `high`, `very_low_projection_coverage`, `requires_expansion_for_broad_scope: true`.

  - < 10% -> `medium`, `low_projection_coverage`, requires expansion.

  - Analyzer spread: cells touched by analyzed rows divided by min(rows, direct-match cells); below 0.5 -> `analyzer_context_clustered`. (Comparing to the full match footprint instead would fire permanently; that was a fixed bug.)

  - Contract: for broad landscape/facet questions, do not finalize while `requires_expansion_for_broad_scope` is true; narrow rare topics may answer with a scope caveat.

- `conversation_concentration`: top-conversation share, rows per conversation, short-message (< 60 chars) share. `context_recommended` (Topic only) when concentration is high (8+ rows and top share >= 0.3 with 3+ rows, or >= 2 returned rows per conversation, or >= 3 total matches per conversation) or short-message share >= 0.25. `multiturn_recommended` when high.

- `lexical_match_count`, `distinct_conversations`: candidate retrieval coverage, never semantic prevalence.



---



## 6. Judge: `flexible_search` `toolExecutor.js:2236`)



`flexible_search` = `map_search` (recall, clusters on, expansion on) + Analyzer LLM. In Ring Probe it is the Judge step and should normally receive an exact SQL-derived `region`.



### 6.1 Pipeline



1. Run `map_search` with `search_strategy: recall`, `expand_clusters: true`, `max_expanded: 25`, `limit: 50` (max 100).

2. Zero rows -> return `category: "No Results"`, `intent_fit: 0`, with refinement suggestion.

3. Topic mode: if `include_conversation_context` or `context_recommended`, attach same-conversation turns windowed around the matched turn (default 6, max 12 turns, 700 chars per turn). The window leans forward because the post-pushback turn is the outcome signal.

4. **Lexical gate on neighbors:** a projection-neighbor row is eligible for the Analyzer only if it matched a phrase term or at least two terms.

5. **Budget reservation:** of 50 Analyzer slots, reserve 25% (up to 13) for eligible neighbor rows, so a full page of direct hits cannot crowd out spatial context.

6. Each row is shaped by `_analyzerInputForConversation` (content truncated to 3500 chars; `evidence_type: direct_lexical_match | projection_neighbor_context`; mode-specific metadata).

7. POST `/api/analyzer` (30 s timeout, 1 retry, 1 s backoff). On failure, `generateFallbackAnalysis`: top-5 frequent words as themes, `intent_fit 0.5`, `fallback: true`.

8. Return the Analyzer output plus all map_search diagnostics; `evidence_idshighlightIds` are only direct rows; a `cacheEntry` is emitted for the `{{Category}}` card UI.



### 6.2 Analyzer contract `server.js:3196` Topic, `:3303` Use Case, endpoint `:3381`)



Input message: `FOCUS: <prompt>` followed by numbered rows with metadata lines and content. Output JSON:



```json

{

  "category": "2-4 word label",

  "themes": ["2-5 themes; for facet prompts these are jobs-to-be-done, not tax topics"],

  "summary": "1-2 sentences, no prevalence claims beyond the sample",

  "intent_fit": 0.0,

  "intent_fit_label": "high|medium|low",

  "off_intent_signals": [],

  "refinement_suggestion": "",

  "representative_evidence_ids": [],

  "metadata_insights": {}

}

```



`intent_fit` thresholds: high >= 0.8, medium 0.55-0.79, low < 0.55. Server clamps to [0,1] and defaults to 0.75 if missing; JSON parse failure yields a "General Tax Questions" fallback with 0.5.



### 6.3 How the agent uses the Judge result



- high fit + coherent samples + adequate coverage -> accept ring, keep card.

- medium -> narrow, split, or answer with bounded language.

- low -> never answer from it; refine, change interpretation, or ask.

- two interpretations both fit -> present the split or ask.

- `prompt` must restate user intent and grouping key (topic vs job-to-be-done vs region).



---



## 7. `sql_query` `toolExecutor.js:2432`)



- Guardrails: strip leading comments; must start with `SELECT` or `WITH`; exactly one statement (string/comment-aware split); forbidden words `DROP DELETE INSERT UPDATE ALTER CREATE TRUNCATE EXEC EXECUTE` (checked outside string literals). Results capped at 1000 rows.

- `ensureHighlightIdForRowQuery`: for a simple non-aggregate row query on the mode table that lacks the ID column, prepend `id_column` to the SELECT so rows highlight on the map. Aggregates (GROUP BY, COUNT/AVG/SUM/MIN/MAX/DATE_TRUNC/FLOOR), DISTINCT, and `SELECT *` are left alone.

- Queries touching `traces_cache`, `trace_summary_cache`, `trace_steps_cache` route through `queryTracesCache`.

- Policy: SQL is never the semantic keyword search engine. `content ILIKE` is allowed only for an explicit literal count, or after search established the terms and the result is labeled literal/proxy. For semantic prevalence, SQL must not appear in the same first batch as `map_searchflexible_search`. Parenthesize every OR group.



---



## 8. Other tools (brief)



- **multiturn_analyzer** (Topic only): finds conversations with 2-20 turns matching terms/filters/region`workspace_set_id`, deterministic sample (seedable, default 15, max 30), reconstructs user-side turns only, LLM classifies topics and behaviors (deepening, correcting, rephrasing, pivoting, iterating). Its term matching is substring, so for varied wording the agent should run `flexible_search` first and pass its `result_set_id` as `workspace_set_id`. "Resolution" is always a proxy.

- **pull_log**: BrainTrust trace for one conversation; `date` (row `created_at_date`) is required; full-conversation only up to 20 turns; `detail_level` transcript | summary (default) | full. Root-cause procedure: find the first causal mistake.

- **workspace_update**: pin/unpin/deactivate events, activate/deactivate sets, history. No raw SQL.

- **Workbench handoff**: after every successful tool, `recordToolResult` saves rows as a set and the executor injects `result_set_id` into the tool result, so tools can chain within one turn via `workspace_set_id`.



---



## 9. Playbooks `server.js:1534` Topic, `:2270` Use Case)



Each playbook has sections: Intent, Intent fit, Intent boundary, Required tools, Tool order, Procedure, Stop rules, Answer shape, Failure modes. The TOC order `WORKFLOW_PLAYBOOK_PRIORITY`) is the routing priority shown to the model.



Topic: `pull_log_root_cause`, `artifact_analysis`, `multiturn_behavior`, `region_tile_discovery`, `facet_use_case_discovery`, `topic_exploration`, `semantic_count`, `trend_temporal`, `dimension_signal_scan`, `exact_analytics`, `account_comparison`, `workbench_context`, `row_examples`.



Use Case: `use_case_cross_conversation_journey`, `use_case_conversation_inspection`, `use_case_doc_intent_context`, `use_case_opportunity_analysis`, `use_case_facet_output_action`, `use_case_landscape_catalog`, `use_case_dense_cluster_region`, `use_case_temporal_trend_analysis`, `use_case_exact_analytics`, `use_case_concrete_examples`, `use_case_workbench_context`.



Key search-relevant playbooks:



| Playbook | Seeding | Judge | Stop |

|---|---|---|---|

| `topic_exploration` | Focused: `flexible_search` directly (2-4 parallel calls for ambiguous intents). Broad/selected/mixed: Tile Probe SQL grid. Sparse seeds: group into islands, SQL subgrid expansion. | `flexible_search` per accepted tile | non-low fit, distinct themes, coverage fits scope |

| `facet_use_case_discovery` | `flexible_search` first with facet + 2-4 anchor families, `turn:1`, recall. Never start from dense clusters. Facet hits may become seed tiles, facet stays the validation anchor. | same call | job groups coherent; group by job-to-be-done, not tax topic |

| `semantic_count` | First batch: `flexible_searchmap_search` only, SQL forbidden. | SQL only after a literal/proxy condition is defined | count meaning unambiguous (exact, literal/proxy, or candidate coverage). Cross-cutting behaviors (pushback, retries): iterate "pattern rings": seed with flexible_search, read observed wording, measure each pattern with normalized SQL, check purity via flexible_search, accumulate distinct rows until marginal yield is negligible; still a lower bound. |

| `region_tile_discovery` | Selection/coordinates; subgrid if large/mixed | `flexible_search` per tile | each dense subregion has a card |

| `use_case_landscape_catalog` | 48 or 96 grid, rank by density + purity, refine mixed cells; never send a coarse cell to flexible_search | region-constrained `flexible_search` with job-to-be-done prompt | 3-6 coherent families |

| `use_case_facet_output_action` | spatial-first; facet is a seed generator and validation anchor; islands kept separate | 2-5 region-constrained calls, one per sub-family | separate cards per sub-family; regionless whole-map cards are not final |

| `use_case_cross_conversation_journey` | boundary order: `current_user_product_access` -> permission codes / subscription -> semantic continuity -> date order -> user/company as validation only | Ring Probe per stage | 2-5 ordered chains with confidence; list rejected joins |

| `dimension_signal_scan` | SQL | flexible_search | code budget: 4 SQL, 2 flexible_search |



---



## 10. Per-turn context injected into the user message `AgentChatWidget.jsx` ~960-1100)



- Data scope: mode, available and loaded date range, mode/turn filters.

- Projection bounds: min/max/range for x and y, row counts, plus Ring Probe and grid-ladder reminders and mode-specific purity guidance. This is what makes normalized-bin SQL possible.

- Map labels (section 4.7).

- Live visual highlights and live map selection (up to 12 hydrated sample rows each).

- Workbench snapshot: categorized context (current_focus, user_selection, retrieval_result, visual_state, tool_evidence, answer_memory, pinned_evidence, workspace_config), `default_context_category`, `active_set_id`, and the ring probe ledger.

- Cross-turn replay `agentHistory.js`): compact evidence of earlier data-tool calls is replayed (last 8 user turns; budgets drop oldest evidence first).



---



## 11. Evidence semantics and answer contract



- Always distinguish: exact SQL count, literal/proxy count (state the condition), candidate retrieval coverage `lexical_match_count`, `distinct_conversations`), qualitative sample, direct trace evidence. Phrase retrieval as "X candidate matches, sampled Y, Z relevant".

- Flag samples under 100 rows as potentially unrepresentative.

- `{{Category Name}}` tokens: only names returned by `flexible_search`, each alone on its own line, never inside tables or bold. The card is the sample surface; do not repeat samples in prose.

- Highlighting: only tool-returned IDs; never claim something is "selected/highlighted" without a tool result in the current turn.

- Answer shape: lead with the insight, 2-5 bullets, cards, optional one-line "Scope:". No process narration, no internal names.



---



## 12. Constants (all in `toolExecutor.js`)



| Constant | Value | Meaning |

|---|---|---|

| `MAP_SEARCH_DEFAULT_LIMIT` / `MAX_LIMIT` | 50 / 100 | returned direct rows |

| `MAP_SEARCH_MAX_TERMS` | 12 | term cap after expansion |

| `MAP_SEARCH_MIN_TOKEN_LENGTH` | 3 | token filter |

| `MAP_SEARCH_RECALL_PASS_LIMIT` | 180 | IDs per recall pass |

| `MAP_SEARCH_RECALL_POOL_LIMIT` | 360 | fused pool |

| `MAP_SEARCH_RECALL_RRF_K` | 60 | RRF constant |

| `CLUSTER_GRID_SIZE` | 48 | seed island / stratification grid |

| `MAP_SEARCH_CLUSTER_CANDIDATE_LIMIT` / `CLUSTER_LIMIT` | 48 / 8 | island candidates / returned islands |

| `MAP_SEARCH_ISLAND_MIN_SEPARATION` | 2 cells | island spacing |

| `MAP_SEARCH_PROJECTION_RADIUS` | 0.045 (cap 0.2) | neighbor radius |

| `MAP_SEARCH_STRATIFIED_PER_CELL` | 6 | rows per cell, no-term recall |

| `MAP_SEARCH_COVERAGE_GRID_SIZE` | 48 | coverage grid |

| `COVERAGE_MIN_SCOPE_CELLS` | 100 | warning applies above this |

| `COVERAGE_HIGH/MEDIUM_WARNING_RATIO` | 0.03 / 0.10 | coverage thresholds |

| `ANALYZER_SPREAD_WARNING_RATIO` | 0.5 | clustered-sample threshold |

| `ANALYZER_MAX_CONVERSATIONS` | 50 | Analyzer rows |

| `ANALYZER_PROJECTION_CONTEXT_SHARE` | 0.25 | reserved neighbor share |

| `ANALYZER_CONTENT_LIMIT` | 3500 chars | per row |

| `ANALYZER_TIMEOUT_MS` | 30000 | plus 1 retry |

| `CONVERSATION_CONTEXT_DEFAULT/MAX_TURNS` | 6 / 12 | same-conversation window |

| agent `maxIterations` `useAgentChat.js`) | 35 | loop cap |



---



## 13. Legacy / dead code (do not rebuild)



`legacyFlexibleSearch`, `clusterMatches`, `proportionalSample`, `callJudge` `toolExecutor.js:2539-2988`) and the `/api/judge` endpoint `server.js:3127`) implement an older keyword -> cluster -> proportional sample -> LLM 0-10 relevance Judge -> Analyzer pipeline `JUDGE_*` constants). Nothing calls `legacyFlexibleSearch`. In the current design the "Judge" role is played by the Analyzer's `intent_fit`.



The MCP server `mcp/`) is separate and additionally has `atlas_rag_search` (vector RAG with 2-4 facet rewrites, union with per-facet recall, rerank against the original question). The Web app has no vector search.



---



## 14. Rebuild checklist



1. Load the mode table into DuckDB-WASM with `projection_x/y` and the mode ID column; compute and inject projection bounds and coarse map labels into each user turn.

2. Implement mode config (table, ID column, search columns, weights, filter whitelist, row order).

3. Implement normalization once and generate both the JS and SQL versions from the same rules; test `&`, curly apostrophes, punctuation.

4. Implement `map_search`: plan -> ranked or recall (4 passes + RRF + grid/family diversification) or stratified no-term sampling -> seed islands with spacing and region contract -> optional neighbor expansion -> coverage diagnostics and warning -> conversation concentration.

5. Implement `flexible_search`: recall map_search -> optional windowed conversation context -> lexical gate and 25% budget reservation for neighbors -> Analyzer LLM with the JSON contract above -> fallback -> card cache entry.

6. Implement guarded `sql_query` with ID auto-injection.

7. Implement the Workbench: record every tool result as a set, return `result_set_id`, support `workspace_set_id` scoping, store `probed_regions`, render the ledger next turn.

8. Implement the turn protocol: playbook TOC in system prompt, mandatory first `load_workflow_playbook` enforced in the executor, `report_progress`, `complete_answer`, 35-iteration cap, parallel tool batches.

9. Port the system prompts and playbooks (Ring Probe state machine, grid ladder, hard controls, evidence semantics, confidentiality). If you want the Ring Probe hard controls to be reliable, consider enforcing them in code (count SQL-only turns and SQL calls before the first `flexible_search`); today they rely on the model.

10. Render `{{Category}}` tokens as cards and merge tool-returned IDs into map highlights `useAgentChat.js:extractHighlightIds`).



## 15. File map



| Concern | File |

|---|---|

| Mode config | `src/tools/agentModeConfig.js` |

| Tool schemas and tool-level strategy text | `src/tools/toolDefinitions.js` |

| Tool execution, retrieval algorithms | `src/tools/toolExecutor.js` |

| Agent loop | `src/hooks/useAgentChat.js` |

| Cross-turn evidence replay | `src/hooks/agentHistory.js` |

| Per-turn context (bounds, labels, selection) | `src/components/AgentChatWidget.jsx` |

| Map labels capture | `src/components/EmbeddingAtlasTab.jsx` |

| Workbench, ring ledger | `src/services/agentWorkspace.js` |

| System prompts | `server.js` `AGENT_SYSTEM_PROMPT` ~1061, `buildUseCaseAgentSystemPrompt` ~2636, `buildAgentSystemPrompt` ~2767) |

| Playbooks | `server.js` `WORKFLOW_PLAYBOOKS` ~1534, `USE_CASE_WORKFLOW_PLAYBOOKS` ~2270) |

| Analyzer prompts and endpoint | `server.js` (~3196, ~3303, `/api/analyzer` ~3381) |

| Prompt-presence tests | `tests/test_ring_probe_default_workflow.mjs` |