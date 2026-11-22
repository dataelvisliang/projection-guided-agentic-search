# Embedding neighbor expansion

Status: implemented as `topic-ring-probe-v3`.

Baseline: `topic-ring-probe-v2` in `PROJECTION_AGENT_SEARCH.md`. The accepted change is `topic-ring-probe-v3`. Ring Probe stays the operator for map landscape, density, and topic judgment. The stored `neighbors` column is the operator for one-hop similarity.

## Data

`web-app/public/atlas/data/dataset.parquet` stores `neighbors` as a struct `{ ids, distances }`. The pipeline writes it in `data_pipeline/2_reduce_dimensions.py`: cosine nearest neighbors on the original embedding, `N_NEIGHBORS = 15`, position 0 is the row itself with distance about 0. List positions correspond. Those ids are the same positional order as `__row_index__`.

A hop reads one row's lists, drops self, and stops. A neighbor's own list is never opened.

## Two uses

### 1. Judge context inside `flexible_search`

`ToolExecutor.expand` used to take the first 12 direct rows and search a Euclidean disk of radius 0.045 on `projection_x` / `projection_y`. That disk is replaced by the stored lists.

Admission stays as it is today:

- Only neighbors whose description matches a full phrase, or at least two direct tokens, reach the Analyzer (`neighborEligible`).
- At most 13 of the 50 Analyzer slots are reserved (`min(13, ceil(50 * 0.25))`).
- Those rows are context. Their ids are removed from `evidence_ids`, highlights, and workspace-set scopes.
- The neighbor point must lie inside the judged ring and the immutable request scope.

`match_type` becomes `embedding_neighbor`. `evidence_type` becomes `embedding_neighbor_context`. Session, workspace scope, and chat highlight filters exclude that type the same way they now exclude `cluster_neighbor`.

No projection-radius query remains on this path. `MAP_SEARCH_PROJECTION_RADIUS` and `MAP_SEARCH_PROJECTION_RADIUS_CAP` go away when nothing else reads them. There is no silent fallback to the plane.

### 2. Explicit similarity tool `similar_reviews`

The model calls this when the user asks for reviews like particular rows, a small selection, or a previous result. It is a lookup, not a topic search.

```text
similar_reviews
  seed_ids?: int[1..12]
  workspace_set_id?: string
  region?: {min_x, max_x, min_y, max_y}
  limit?: int, default 25, max 50
  reason: string
```

Seed source, in order:

1. `seed_ids` when present. They must belong to the current scope. If `workspace_set_id` is also set, they must belong to that set too.
2. Otherwise `workspace_set_id`. Its direct row ids only; aggregate sets are rejected. Take the lowest 12 ids.
3. Otherwise the request selection, and only when that selection has 1 to 12 ids.

Any other case is denied, including an empty selection and a selection larger than 12 with no named seeds. The tool must not pick 12 arbitrary rows from the whole table.

Returned neighbors have no lexical gate. They are citable only as `evidence_kind: "row_examples"` with `bounded: true` and no category cards. They never become `accepted_rings`.

## Lookup

One guarded read against the request-local `reviews` relation:

- Load `neighbors.ids` and `neighbors.distances` for the chosen seeds.
- Zip the two lists by position. Do not cross them.
- Drop an entry when `neighbor_id = seed_id`, when it is list position 0, or when `cosine_distance <= 1e-6`.
- Keep a neighbor id once, with its smallest cosine distance and the seed that produced it.
- The neighbor row must exist in the current scope. For judge context it must also fall inside the ring. For `similar_reviews`, `region` is an optional extra filter; omitted means the request scope only.
- Order by cosine distance ascending, then neighbor id ascending.
- Judge context returns at most 25. `similar_reviews` uses its `limit`.
- A seed with a null or malformed struct is skipped. The result carries a warning. If the column itself is missing, the action fails. No plane search is substituted.
- Second-hop ids are absent even when they are close on the map.

The result of `similar_reviews` is:

```text
method: embedding_neighbors_v1
hop: 1
seeds: the ids actually read
rows: id, seed_id, cosine_distance, match_type embedding_neighbor, plus the ordinary review columns
warnings
row_count
```

No `candidate_rings`, `seed_islands`, `intent_fit`, or category. Seeds are the query and are not rows in `rows`.

## Session rules

`similar_reviews` is a data action. It is not `sql_query`, not a judge, and it does not emit rings.

- Denied before the playbook is loaded, while a tool result is still unobserved, while wrap-up is required, and after the refinement stop.
- Denied while a viable ring is waiting for `flexible_search` or `transition_ring`.
- At most two calls per assistant turn.
- The same seed set, region, and limit is a repeated search shape.
- It does not count toward the dimension-scan judge budget, the two-SQL-before-judge budget, or the three-refinement budget.
- It does not establish terms. `semantic_count` still cannot run description SQL until a lexical search has done that.
- A successful call gets a `result_set_id`. A later `workspace_set_id` may narrow to its neighbor ids. It cannot widen the request selection.
- `complete_answer` may name that result set only with `row_examples`, `bounded: true`, and an empty category list. `accepted_rings`, `exact_sql`, `literal_proxy`, and `no_evidence` cannot cite it.

`row_examples` text tells the model to use this tool for similarity, and to keep using SQL or `map_search` for a named field or an explicit wording. The answer describes similar reviews. It does not call them a topic, a cluster, or a region.

Other playbook procedures stay on Ring Probe. The prompt may say that one-hop embedding neighbors answer "similar to these reviews" and that map proximity still does not establish a topic. User-visible progress does not mention the column, cosine, or the tool name.

## Tests

- Position 0 and a zero distance are absent from both outputs.
- A neighbor's neighbor is absent unless it is itself a neighbor of a chosen seed.
- The same neighbor reached from two seeds keeps the smaller distance.
- Ids outside the request selection are absent, and the base table is unchanged.
- Judge expansion drops neighbors outside the ring. `similar_reviews` without `region` can return an in-scope neighbor outside a previously judged ring.
- A phrase match or two token hits can occupy an Analyzer context slot. A neighbor with neither does not. Neither id appears in `evidence_ids`.
- `similar_reviews` returns a neighbor that shares no query words.
- The action creates no candidate ring.
- It is denied while a ring is awaiting judgment, and denied when the only available seeds are an unbounded full-table selection.
- `accepted_rings` cannot cite its result set. `row_examples` with `bounded: true` can.
- A missing struct on one seed warns and continues. A missing column fails the action.
- The expansion SQL no longer contains the 0.045 radius predicate.

## Out of scope

Multi-hop walks, online KNN, changing `k`, seeding rings from neighbor lists, density or topic discovery through this column, and any Use Case or conversation workflow.
