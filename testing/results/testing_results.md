# Evaluation Results — job2cool MA3 baseline comparison

> Auto-generated from `results/raw/*.json` · cases present: **12** (T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12) · device: GPU (a base via PyTorch; b/c/judge served).
> (a) base SmolLM2-360M · (b) ma2-360m-dpo-b01 · (c) full job2cool. Judge = gemma-4 rubric (1–5). See `evaluation_suite.md`.

## Table 1 — Job-Offer quality by config (the (a)/(b)/(c) isolation)

| Config | Structural (1–5) | Faithfulness | Language | Repetition-free | Mean |
|---|---|---|---|---|---|
| (a) base SmolLM2-360M | 1.5 | 1.5 | 1.8 | 2.6 | **1.85** |
| (b) ma2-360m-dpo-b01 | 4.3 | 4.2 | 4.2 | 4.4 | **4.28** |
| (c) full job2cool (offer) | 4.9 | 4.9 | 4.7 | 4.0 | **4.62** |

_n = 10 offer cases._ Expected story: (a) floor → (b) aligned jump → (c) comparable offer + the system capabilities below that (a)/(b) cannot do.

## Table 2 — System-only capabilities (config (c))

| Metric | Value |
|---|---|
| Domain-resolution accuracy | 9/10 |
| Section-segregation accuracy | 9/10 |
| Resolvable-citation rate | 85/85 (100%) |
| RAGAS faithfulness (mean) | 0.97 |
| RAGAS answer-relevance (mean) | 1.0 |
| Refusal correct (T11) | yes |
| Memory case present (T12) | yes |
| Mean (c) latency | 40.07 s |

## Table 3 — Wash-out (MA2 draft A vs Gemma offer B)

| Case | Verdict (A=MA2 / B=Gemma) | strict-agree |
|---|---|---|
| T01 | tie | False |
| T02 | A | True |
| T03 | B | True |
| T04 | B | True |
| T05 | tie | False |
| T06 | B | True |
| T07 | B | True |
| T08 | B | True |
| T09 | tie | False |
| T10 | tie | False |

**Tally:** MA2-better 1 · Tie 4 · Gemma-better 5

## Per-case detail

| Case | a struct | b struct | c struct | (c) domain | (c) deliv | cites (res) | RAGAS f/r | lat a/b/c |
|---|---|---|---|---|---|---|---|---|
| T01 | 1 | 4 | 5 | jobs_onboard_backend | 4 | 10(10) | 1.0/1.0 | 4.2/7.93/52.88 |
| T02 | 2 | 5 | 5 | jobs_onboard_devops | 1 | 6(6) | 1.0/1.0 | 8.72/11.0/20.19 |
| T03 | 2 | 4 | 5 | jobs_onboard_ml_ai | 4 | 20(20) | 1.0/1.0 | 4.28/12.2/61.18 |
| T04 | 1 | 5 | 5 | jobs_onboard_frontend | 1 | 5(5) | 0.95/1.0 | 8.69/13.49/17.92 |
| T05 | 2 | 2 | 5 | jobs_onboard_qa | 1 | 15(15) | 0.95/1.0 | 15.4/0.31/22.77 |
| T06 | 1 | 5 | 5 | jobs_onboard_security | 1 | 4(4) | 0.95/1.0 | 8.2/10.98/18.43 |
| T07 | 1 | 5 | 5 | jobs_onboard_general | 4 | 8(8) | 1.0/1.0 | 4.01/13.86/49.73 |
| T08 | 1 | 5 | 5 | jobs_onboard_mobile | 4 | 4(4) | 0.95/1.0 | 0.54/7.46/49.39 |
| T09 | 2 | 4 | 5 | jobs_onboard_architect | 4 | 5(5) | 1.0/1.0 | 6.93/10.95/55.59 |
| T10 | 2 | 4 | 4 | jobs_onboard_general | 4 | 8(8) | 0.95/1.0 | 5.8/9.6/52.63 |

> Full text outputs (offers, MA2 drafts, deliverables) are in `results/raw/{ID}.json`.
