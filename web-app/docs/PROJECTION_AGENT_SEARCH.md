# Topic Ring Probe

Version: `topic-ring-probe-v2`. The search unit is a bounded rectangular ring, not a circle or an individual keyword hit. Projection geometry generates hypotheses; review text establishes evidence.

## Dataset adaptation

`reviews` is the Topic table: one point is one wine review, the ID is `__row_index__`, and the search text is `description`. Country, variety, price and points support exact analytics. This dataset has no conversation, turn, company, journey or trace fields. Those original workflows are not fabricated. SQL runs in server DuckDB-WASM, with the same normalization and retrieval SQL used by the browser data engine.

## Turn and navigation protocol

1. Load exactly one workflow as the only tool in the first assistant tool turn. The session enforces the gate and checks SDK request boundaries.
2. Report concise business-language progress with the first search phase and later phase changes.
3. Focused or facet questions can start with regionless `flexible_search`. Its result is discovery only: each major island must be judged separately before supporting a topic answer. Broad discovery starts with normalized density grids, using global injected bounds and the 48/96/128/160/192/256 ladder.
4. Once a data action returns viable rings, the next data action must be region-constrained `flexible_search`. Alternatively, `transition_ring` explicitly records mixed, weak or off-intent navigation. A mixed ring can be split or shifted once; weak/off-intent rings are discarded as navigation candidates. None of these transitions accepts evidence.
5. After one region judgment, the remaining frontier does not prevent refining that ring or visiting siblings. Unexplored rings require a bounded final answer.
6. `complete_answer` runs alone, except for progress. The runtime renders its explanation, validated category cards and suggested followups. Card tokens cannot be injected through the explanation.

Tool execution is serialized so each state transition is validated against the preceding result. This is an intentional difference from the reference application's parallel batches. The model still owns all navigation decisions.

## Evidence contract

- A topic category is eligible only with a bounded region, nonempty directly relevant evidence IDs, positive sample/support counts, non-low fit, non-fallback analysis, and known coherent or mixed content.
- Analyzer `coherence` is a separate content judgment (`coherent`, `mixed`, `low`), not a geometric inference. High fit is >= 0.8; medium is >= 0.55. Medium or mixed evidence requires `bounded: true`.
- Regionless results, fallback summaries and low-fit rings cannot support topic conclusions. Directly judged rows in a rejected ring can still support bounded isolated examples, never a cluster claim.
- Projection neighbors stay inside the requested region and immutable request scope. Only phrase matches or two-token matches reach the Analyzer, with up to 13 of its 50 slots reserved for context. Neighbor IDs never become direct evidence or map highlights.
- Representative evidence IDs are intersected with the actual direct Analyzer input. Separate accepted categories produce separate saved cards; duplicate Analyzer names are disambiguated.
- Coverage is computed from the final Analyzer sample. No-term sampling uses the scope's occupied cells rather than treating its match coverage as zero. Warnings cannot be overridden by high fit. Expanded returned-cell coverage can clear the warning after reaching the reference 10% threshold; this is retrieval coverage, not semantic prevalence.
- Answers flag samples below 100 reviews as potentially unrepresentative. A bounded answer is `partial_success`, including one containing high-fit rings.

## Structured evidence and workspace sets

Every successful data action receives a `result_set_id`. Tools can use `workspace_set_id` to narrow subsequent queries to its returned direct IDs. Sets cannot widen the immutable request selection. Aggregate-only sets without row IDs cannot be used as row scopes.

`complete_answer` names its evidence kind and result-set IDs:

- `accepted_rings`: validated category names from current-turn region judgments.
- `exact_sql`: successful SQL sets under `exact_analytics`; no Analyzer or card required.
- `literal_proxy`: successful SQL after observed semantic search evidence, with a named literal/proxy condition and bounded language. Candidate matches are not semantic prevalence.
- `row_examples`: explicit returned rows, or bounded isolated directly judged evidence. No cluster cards.
- `no_evidence`: bounded completion with no cited evidence.

SQL is one guarded SELECT/WITH, capped at 1000 rows. Row queries receive IDs; aggregates and CTEs are not incorrectly rewritten. SQL text matching is restricted to explicit literal analytics or established, labeled proxy counts. External readers and qualified access to the unscoped reviews relation are rejected.

## Scope and cross-turn context

The browser hydrates all selected IDs rather than sending the 500-row preview as the selection. The server validates IDs and creates a request-local scoped relation; empty selections stay empty. All SQL, sampling, islands, counts and expansion use that relation. Concurrent requests do not mutate a shared view.

The response includes up to 20 recent ring states with support and intent fit. The browser returns this ledger on the next turn. A selection fingerprint prevents replay across different scopes. Historical state guides navigation only and cannot supply current-turn accepted evidence. Repeating an unchanged accepted/rejected region for the same question is blocked; a changed question can judge it anew. Clearing the chat clears the ledger.

## Budgets and ownership

`searchContract.ts` owns schemas, playbooks, prompts and limits. `SearchSession` owns evidence, the ledger, transitions and terminal state. The Agents SDK owns model/tool turns. `ToolExecutor` owns retrieval; the Analyzer owns text judgment. Budgets include agent and reported Analyzer tokens.

- At most two SQL calls per assistant turn before the first Judge; narrow exact/row paths are exceptions.
- Dimension scan stops after four SQL calls or two Judge calls, whichever cap is reached first. The per-turn SQL rule still applies.
- Search repetition ignores cosmetic prompt changes. After viable evidence, three refinement attempts or two consecutive non-improving judgments stop retrieval. New relevant IDs, themes or improved fit count as improvement. A newly generated refinement ring can receive its Judge before stopping.
- 35 actions, 80,000 reported tokens, 120 seconds. Final actions are reserved for completion. Terminal state is absorbing.

All chat/Agent/Analyzer defaults are `anthropic/claude-haiku-5.5`. `OPENROUTER_MODEL` and `OPENROUTER_ANALYZER_MODEL` remain optional deployment overrides. Analyzer reasoning is disabled. Historical experiment records retain their original model identifiers.

## Validation

Run `npm test` and `npm run build` in `web-app`. Tests include real DuckDB-WASM queries, selection isolation, region-constrained expansion, normalization, count semantics, workspace scopes, evidence rejection and state transitions. The build also type-checks server APIs and tests via `tsconfig.api.json`. Live-model quality and cost require a separately recorded pilot; passing deterministic contract tests does not establish retrieval quality.
