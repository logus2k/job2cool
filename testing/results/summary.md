# Results — Summary (aggregate tables)

> **Status: PLACEHOLDER — not yet executed.** All cells are `—` until `run_eval.py` runs.
> Run date: `TODO` · Commit: `TODO` · Stack: agent_server gemma-4 + ma2-360m-dpo-b01, full job2cool.

---

## Table 1 — Job-Offer quality by config (the mandated (a)/(b)/(c) isolation)

Mean over offer-producing cases (T01–T10, T12-t1, n=`—`). Judge: gemma-4 rubric (suite §4).

| Config | Structural completeness (% 4-section) | Faithfulness-to-request (1–5) | Language quality (1–5) | Repetition-free (1–5) | **Mean quality** |
|---|---|---|---|---|---|
| **(a)** base SmolLM2-360M | — | — | — | — | — |
| **(b)** `ma2-360m-dpo-b01` (alone) | — | — | — | — | — |
| **(c)** full job2cool (offer section) | — | — | — | — | — |

**Reading (to write on completion):** (a)→(b) isolates A1+A2; (b)→(c) isolates the A3 final stage
for the offer deliverable. `TODO: 1–2 sentence interpretation.`

---

## Table 2 — System-only capabilities (config (c))

Behaviours (a)/(b) structurally cannot do. n/N over applicable cases.

| Metric | Value | N | Notes |
|---|---|---|---|
| Section-segregation accuracy | — | — | exactly the requested deliverables |
| Domain-resolution accuracy (incl. fallback) | — | — | correct `jobs_onboard_*` or correct fallback |
| Resolvable-citation rate | — % | — | chunk → valid PDF page (bbox where graph-grounded) |
| RAGAS faithfulness (mean) | — | — | `/api/score_answer` |
| RAGAS answer-relevance (mean) | — | — | `/api/score_answer` |
| Refusal correctness (T11) | — | 1 | ask-back, no generation |
| Memory correctness (T12) | — | 1 | folds prior role; updates Onboarding only |
| Mean latency / turn | — s | — | wall-clock |

---

## Table 3 — Carried A1/A2 baselines (context; not re-run here)

| # | Configuration | Metric | Result |
|---|---|---|---|
| (a) | SmolLM2-360M base | In-domain PPL (Djinni) | 16.37 |
| (a) | SmolLM2-360M base | Validation PPL | 11.66 |
| (b) | `ma2-360m-sft` | Validation PPL | 4.54 |
| (b) | `ma2-360m-dpo-b01` | Validation PPL | 6.01 (β=0.10) |
| (b) | `ma2-360m-dpo-b01` vs SFT | Win-rate (Granite, order-swap) | 8–0 / 20 |
| (b) | A1 LoRA merge | In-domain PPL (Djinni) | 11.38 (−31%) |

---

## Headline takeaways (write on completion)

1. `TODO — what (b)→(c) shows about the A3 contribution for the offer.`
2. `TODO — what Table 2 shows that no fine-tuning could provide (routing/grounding/refusal).`
3. `TODO — wash-out verdict (see wash_out.md).`
