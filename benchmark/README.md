# Projection-Augmented Retrieval Benchmark

The current agent runtime is Topic Ring Probe v2 (`benchmark/configs/topic_ring_probe_v2.json`). Run it with the [runbook](RUNBOOK.md). The frozen `wine-par-v1` benchmark and the circle-planner pilot below are historical comparison material. They do not validate the current runtime.

This benchmark evaluates whether an LLM agent benefits from treating a 2D embedding projection as an operational search space.

Version `v1` contains 30 Wine Atlas queries across exact retrieval, semantic retrieval, open-ended exploration, and regional comparison. Ten development queries may be used for threshold tuning; twenty test queries are frozen for final reporting.

## Quick start

```powershell
python benchmark/scripts/validate.py
python benchmark/scripts/pool_candidates.py --runs benchmark/runs --output benchmark/annotations/pool.jsonl
python benchmark/metrics/evaluate.py --runs benchmark/runs --judgments benchmark/annotations/judgments.jsonl --output benchmark/reports/results.json
```

## PAR pilot runner

Before creating final blind labels, use the pilot runner on development queries to verify that the agentic projection-search loop is actually reproducible:

```powershell
python benchmark/scripts/run_par_pilot.py --query-ids wine-dev-005 wine-dev-006 wine-dev-010 --sample-size 4 --max-steps 5
python benchmark/scripts/prepare_pilot_calibration.py --run benchmark/runs/pilot/par_pilot_20260712T153808Z.jsonl --output-jsonl benchmark/reports/pilot_calibration_20260712T153808Z.jsonl --output-md benchmark/reports/pilot_calibration_20260712T153808Z.md
```

The pilot JSONL exposes `query_id`, `tool_sequence`, `accepted`, `rejected`, `frontier`, `purity`, `intent_match`, `stop_reason`, `final_answer`, `tokens`, `latency`, and `cost_usd` for quick trajectory inspection. Pilot calibration sheets are not blind evaluation artifacts; they are for debugging thresholds and analyzer behavior before formal annotation.

Do not tune utility weights, purity thresholds, prompts, or budgets on the test split. Any system change after observing test results requires a new benchmark version.

See [ANNOTATION_GUIDE.md](ANNOTATION_GUIDE.md) for blind labeling and [RUNBOOK.md](RUNBOOK.md) for the experiment protocol.
