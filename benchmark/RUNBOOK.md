# Benchmark Runbook

## Current Topic Ring Probe runtime

The current implementation is `topic-ring-probe-v2`; configuration is `configs/topic_ring_probe_v2.json`. Earlier `par-agent-v3` circle-planner configs and reports are historical. Record fresh runs for the current runtime. Contract tests cover evidence and navigation invariants; they do not establish semantic retrieval quality. Exact SQL queries can complete without an Analyzer; bounded results are partial successes.


## 1. Freeze a system

Record the Git commit, model identifier, prompts, tool schema, projection artifact, dataset checksum, and system configuration. Do not modify thresholds between test queries.

## 2. Run systems

Run every system on the same query split and seeds `17`, `29`, and `43`. Enforce equivalent output depth and, for agent systems, record actual token, latency, tool, and probe costs.

Write one JSON object per `(query_id, system_id, seed)` to `benchmark/runs/<system_id>.jsonl`. The format is defined in `schemas/run.schema.json`.

### Development-only PAR pilot

Current contract: `par-agent-v3`, recorded in `configs/par_agent_v3.json`. Run from `web-app`, using the same task compiler as chat:

```powershell
npm exec -- tsx ../benchmark/scripts/run_sdk_par_pilot.ts wine-dev-005 wine-dev-006 wine-dev-010
```

The Agent defines a sourced task, scans, batch-inspects, optionally refines/compares, then requests finish. A one-batch success is valid. `contract_pass` measures the protocol; `task_success` measures the target terminal; neither measures human relevance. Inspect the compiled task and the evidence, not just the sequence.

An optional `--oracle-task-spec` uses benchmark annotations as additional input and is explicitly labeled `oracle_task_spec`. It is not the product gate. Live runs write a completed JSONL plus incremental `.trace.jsonl`; costs remain null when unreported. Do not use the legacy Python runner for v3: it embeds a historical loop and obsolete prompt contract.

To debug thresholds without polluting the blind benchmark pool, prepare a calibration sheet from a pilot run:

```powershell
python benchmark/scripts/prepare_pilot_calibration.py --run benchmark/runs/pilot/par_pilot_20260712T153808Z.jsonl --output-jsonl benchmark/reports/pilot_calibration_20260712T153808Z.jsonl --output-md benchmark/reports/pilot_calibration_20260712T153808Z.md
```

Calibration sheets may show model scores and recommended actions because they are for development diagnosis. Do not use them as final blind labels.

For `par_v1`, download the completed chat, then convert it:

```powershell
python benchmark/scripts/extract_trajectory.py exported-chat.md --output benchmark/trajectories/wine-test-001-seed17.json
python benchmark/scripts/trajectory_to_run.py benchmark/trajectories/wine-test-001-seed17.json --query-id wine-test-001 --seed 17 --output benchmark/runs/par_v1.jsonl
```

Static systems should set agent-only costs such as `tool_calls` and `probes` to zero. Failed runs remain in the file with empty results and an explanatory `stop_reason`; do not silently rerun only unfavorable failures.

## 3. Pool blindly

```powershell
python benchmark/scripts/pool_candidates.py --runs benchmark/runs --output benchmark/annotations/pool.jsonl --depth 20
```

The pool hides system provenance in `pool.sources.json`. Do not give that file to annotators.

## 4. Annotate

Duplicate each pooled unit for at least two annotators. Store completed labels in `annotations/judgments.jsonl` following `schemas/judgment.schema.json` and `ANNOTATION_GUIDE.md`.

For SDK pilot traces, first reconstruct a blind pool from recorded geometry and deterministic samples with `scripts/prepare_sdk_blind_pool.ts`. Its default `--scope selected` labels returned findings; use `--scope inspected` when auditing a no-evidence outcome, so rejected regions are reviewed too. Keep its `.sources.json` hidden until the annotation pass is finished. AI-assisted reviews must use a distinct annotator ID and artifact; they do not count toward the two independent human annotations.

## 5. Validate

```powershell
python benchmark/scripts/validate.py
```

Resolve validation errors before evaluation.

## 6. Evaluate development data

```powershell
python benchmark/metrics/evaluate.py --runs benchmark/runs --judgments benchmark/annotations/judgments.jsonl --pool-sources benchmark/annotations/pool.sources.json --split dev --output benchmark/reports/dev_results.json
```

Threshold and prompt changes are allowed only here. Log every attempted configuration, not only the best one.

## 7. Evaluate frozen test data once

```powershell
python benchmark/metrics/evaluate.py --runs benchmark/runs --judgments benchmark/annotations/judgments.jsonl --pool-sources benchmark/annotations/pool.sources.json --split test --output benchmark/reports/test_results.json
```

Report all seven systems, all three seeds, failures, confidence intervals, per-task results, quality metrics, and cost metrics. A later system change requires a new version and fresh test evaluation.

## Required ablations

- Full `par_v1`.
- No XY access (`agent_ann`).
- XY without high-D diagnostic (`agent_xy`).
- No purity in utility.
- No intent match in utility.
- No refinement.
- No semantic stopping.
- Static XY retrieval without an agent.

The primary claim is supported only if improvements concentrate in exploration/comparison tasks and remain meaningful after accounting for token and latency cost.
