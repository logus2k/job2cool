# job2cool — Evaluation Test Suite

This folder holds the **MA3 baseline-comparison evaluation** required by the final-project
brief: isolate the final-stage (A3) contribution by comparing the full system against
**(a)** the base pretrained model and **(b)** the A2 aligned model with no system, plus the
system-only capability metrics and the qualitative worked examples for the report.

## Files

| File | Purpose |
|---|---|
| [`evaluation_suite.md`](evaluation_suite.md) | The suite: configs, the fixed prompt set (12 cases), metrics, and the exact execution procedure |
| [`run_eval.py`](run_eval.py) | The harness that executes the suite and writes raw results to `results/raw/` |
| [`aggregate_results.py`](aggregate_results.py) | Aggregates `results/raw/*.json` → `results/testing_results.md` |
| [`results/testing_results.md`](results/testing_results.md) | **The consolidated results** — Table 1 (a/b/c isolation), Table 2 (system metrics), Table 3 (wash-out), per-case detail. Feeds report §5/§7 |
| `results/raw/{ID}.json` | Per-case raw outputs (offers, MA2 drafts, deliverables, scores) |

## Status

- **Suite + placeholders:** written.
- **Configs (b) `ma2-360m-dpo-b01`, (c) full system, and the judge `gemma-4`:** reachable now over HTTP (verified live).
- **Config (a) base SmolLM2-360M:** weights present in the HF cache; **requires a `transformers`+`torch` venv** (the one outstanding setup step — see `evaluation_suite.md` §6).
- **Execution:** NOT yet run. All result cells are placeholders (`—` / `TODO`). Run on owner's go.

## How to execute (summary)

```
# one-time: (a)-runtime
python3 -m venv testing/.venv-eval
testing/.venv-eval/bin/pip install -r testing/requirements-eval.txt   # torch (cpu), transformers

# run the suite (drives the live shared services for (b)/(c)/judge)
testing/.venv-eval/bin/python testing/run_eval.py            # full
testing/.venv-eval/bin/python testing/run_eval.py --case T01 # single case
```

The harness writes raw JSON to `results/raw/`; the `results/*.md` placeholder tables are then
filled from that (by the harness `--write-md`, or by hand). See `evaluation_suite.md` for the
full procedure and the judge rubric.
