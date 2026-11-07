# Remaining research and product work

Current implementation and acceptance rules are in [Topic Ring Probe v2](PROJECTION_AGENT_SEARCH.md).

- Record a live pilot for `topic-ring-probe-v2`. Circle-planner reports do not validate this runtime.
- Human-annotate region relevance and distinctness. Analyzer scores are not ground truth.
- Compare fixed-grid, density-first, random spatial exploration, and adaptive agent search under equal sample and token budgets.
- Measure semantic coverage, duplicate findings, tool and sample efficiency, latency, and provider cost.
- Add another dataset adapter and test projection parameters without introducing runtime embeddings.
