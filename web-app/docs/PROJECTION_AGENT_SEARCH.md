# Topic Ring Probe

Version: `topic-ring-probe-v1`. This replaces the circle planner (`par-agent-v3`). The search unit is a ring: a rectangle `{min_x, max_x, min_y, max_y}` on the review map. Keywords only locate rings. `flexible_search` judges a ring and returns `intent_fit`. Answers cite accepted rings.

The dataset stays `reviews`. It plays the Topic table: one point is one review, the id is `__row_index__`, and the default search text is `description`. There is no `turn`, conversation id, company, or trace table, so this build does not implement Use Case mode, same-conversation context, multiturn analysis, or trace lookup.

## Ownership

- `searchContract.ts`: Topic tool schemas, playbook text, limits, and the agent instructions.
- `SearchSession`: validates the playbook gate, SQL budget, ring transitions, repeated search shapes, and `complete_answer`. It does not choose the next ring.
- OpenAI Agents SDK: owns model and tool turns. A new model request resets the per-turn SQL count.
- `ToolExecutor`: guarded SQL, lexical `map_search`, and `flexible_search` over server DuckDB. No vector index.
- Analyzer: one ring sample in, the Topic JSON contract out (`category`, `themes`, `summary`, `intent_fit`).

## Tools

- `load_workflow_playbook` must be the first tool. The directory is `topic_exploration`, `region_tile_discovery`, `facet_use_case_discovery`, `semantic_count`, `exact_analytics`, `dimension_signal_scan`, and `row_examples`.
- `sql_query` is one `SELECT` or `WITH` over `reviews`, capped at 1000 rows. Density grids use `FLOOR((projection_x - min_x) / range_x * N)`.
- `map_search` normalizes text the same way in JavaScript and SQL, then runs a ranked query or recall (phrase, all tokens, any token, morphology, reciprocal rank fusion) and groups direct hits into seed islands.
- `flexible_search` is recall `map_search` plus the Analyzer. Neighbors inside radius 0.045 reach the Analyzer only when they match a phrase or at least two terms, and 25% of the 50 slots (at most 13) are reserved for them.
- `report_progress` and `complete_answer` close the turn. `{{Category}}` names must come from `flexible_search`.

## Controls enforced in the session

- No search tool runs before a playbook is loaded.
- Before the first `flexible_search`, at most two SQL queries run in one assistant turn. `exact_analytics` and `row_examples` are the narrower exceptions.
- Once a SQL or seed search has returned a ring, the next data tool must be region-constrained `flexible_search`.
- `semantic_count` and `facet_use_case_discovery` cannot start with SQL.
- `dimension_signal_scan` stops after 4 SQL calls and 2 `flexible_search` calls.
- A repeated search shape is rejected. After the first judged result, 3 refinements or 2 non-improving searches end retrieval.
- `intent_fit` is high at or above 0.8, medium from 0.55, and low below that. A low ring cannot be cited. A medium ring requires `bounded: true`.
- The loop cap is 35 actions. At action 34 the session only accepts `complete_answer` or `report_progress`.

The model remains the OpenRouter model in `OPENROUTER_MODEL` (default `z-ai/glm-5.3-flash`). Wall-clock and token caps are runtime guards around that loop.
