# 14. Evaluation

## 14.1 What "the system works" means

For a grounded HR-document generator, success is not a single accuracy number. We
define it on three axes, each with a measurable signal:

1. **Routing correctness** — from a natural-language request, does the system select
   the right deliverables and the right KB domain? *Metric:* section-segregation
   accuracy; domain-resolution correctness (incl. correct fallback).
2. **Grounding** — are claims backed by verifiable citations? *Metrics:*
   resolvable-citation rate (chunk → valid PDF page); RAGAS-style **faithfulness**
   and **answer-relevance** from the LLM judge (`/api/score_answer`).
3. **Preservation of the aligned model's contribution** — once the A2 Job-Offer draft
   passes through gemma's composition, is its quality preserved or degraded? *Metric:*
   judge/qualitative comparison of the **MA2 draft vs the composed version** (the
   built-in A/B toggle, §06.6).

Plus an operational axis: **latency/throughput** per turn, and embedder memory under
load (§13).

## 14.2 The mandated baselines

The brief requires isolating the final-stage contribution against (a) the base
pretrained model and (b) the A2 aligned model with no system. We carry the A1/A2
training numbers and **execute** the A3 comparison:

| # | Configuration | What it isolates |
|---|---|---|
| (a) | **base SmolLM2-360M**, no FT | the floor before any adaptation |
| (b) | **`ma2-360m-dpo-b01`** in isolation (no RAG, no orchestration) | the A1+A2 contribution alone |
| (c) | **full job2cool system** (A2 draft + gemma composition + hybrid RAG + citations) | the A3 final-stage contribution |

**Carried A1/A2 results (from the MA1/MA2 reports).** On the SFT validation set,
perplexity: base **11.66** → SFT **4.54** → **DPO-b01 6.01** (the chosen β=0.10
deliverable; b03 reached 4.80 but with a weaker alignment signal). On A1's in-domain
Djinni test: base **16.37** → LoRA **11.38** (−30%). Win-rate (Granite judge,
order-swap, strict agreement): **DPO-b01 vs SFT = 8 wins, 0 losses** over 20 held-out
prompts. These establish that the (a)→(b) step is real and measured.

## 14.3 The executed (a)/(b)/(c) comparison — RESULTS

A fixed **12-prompt suite** (full packs, single-section, domain routing, absent-domain
fallback, an ambiguous-refusal case, a memory follow-up) was run across all three
configs on GPU. (a)/(b) reproduce the MA2 methodology exactly — the Job Offer is
generated from the checkpoints via transformers with the Alpaca template and greedy
decoding at `repetition_penalty=1.3`; (c) is the full job2cool turn. Each offer is
scored 1–5 on four axes by a gemma-4 rubric judge. Full results:
`testing/results/testing_results.md`; harness + raw outputs in `testing/`.

**Table 1 — Job-Offer quality by config (gemma-4 rubric, 1–5; n=10 offer cases):**

| Config | Structural | Faithfulness | Language | Repetition-free | **Mean** |
|---|---|---|---|---|---|
| (a) base SmolLM2-360M | 1.5 | 1.5 | 1.8 | 2.6 | **1.85** |
| (b) `ma2-360m-dpo-b01` | 4.3 | 4.2 | 4.2 | 4.4 | **4.28** |
| (c) full job2cool (offer) | 4.9 | 4.9 | 4.7 | 4.0 | **4.62** |

The isolation is clean. **(a)→(b) is the large jump** (+2.4): alignment turns an
incoherent text-completer (the base scores near the floor, produces no Markdown
structure) into a faithful, structured drafter. **(b)→(c) is small** (+0.34): gemma's
composition leaves the *offer* quality roughly where the aligned model already had it.
That is the central finding — the A3 value is not a better offer, it is the
**system-only capabilities** (a)/(b) cannot do:

**Table 2 — System-only capabilities (config c):**

| Metric | Value |
|---|---|
| Domain-resolution accuracy | 9/10 |
| Section-segregation accuracy | 9/10 |
| Resolvable-citation rate | 85/85 (100%) |
| RAGAS faithfulness (mean) | 0.97 |
| RAGAS answer-relevance (mean) | 1.00 |
| Refusal correct (ambiguous) | yes |
| Memory follow-up correct | yes |
| Mean (c) latency / turn | 40 s |

**Wash-out A/B (the b-vs-c masking question, §16).** Order-swapped pairwise judge over
the ten offer cases: **Gemma-better 5, Tie 4, MA2-better 1** — partial masking; the A2
seed survives outright in half the cases.

**Honest blemishes from the run.** (i) Domain routing missed once (9/10): "data
engineer" → `jobs_onboard_general` instead of `jobs_onboard_data`. (ii) Section
segregation missed once (9/10): a full-pack request was classified Job-Offer-only.
(iii) The served A2 model truncated early on one case (structural 2, 0.31 s — the
documented MA2 early-EOS). (iv) **gemma judges its own (c) output** — the (c) row
carries a self-judging bias (§15).

## 14.4 Other live, verifiable signals

- **Citation resolution exact**: 85/85 cited chunks resolved to a valid PDF page
  (graph-grounded chunks additionally carry a bbox), via the Score panel /
  `/api/graph_trace`.
- **Candidate-search quality** (retrieval substrate, §09): strong on multi-word role
  phrases (*"senior python backend engineer with fastapi"* → 0.99/0.97/0.96, all
  genuine), correctly weak on out-of-era tokens (*"genai"* → ~0.000x, the 2020–2023
  corpus predates LLM-engineering vocabulary — a finding, not a bug).
- **Performance, measured**: ~100–120 CV/s bulk-embed; embedder OOM fixed and
  stress-verified flat at ~2.2 GB (§13); full 210,048-CV ingest with read-back ack =
  indexed.

## 14.5 Qualitative analysis (worked examples, from the executed run)

- **Success.** "Backend developer on AWS" → role extracted → `jobs_onboard_backend`
  resolved → hybrid RAG → four sections with **12/12 resolvable bbox citations** and
  RAGAS faithfulness 1.0. Routing + grounding + provenance end-to-end.
- **Fallback.** The `embedded` role (domain absent) → fell back to `general` as
  designed; the closing note surfaces the gap.
- **Memory.** "I need a DevOps engineer" then "now make the onboarding remote-friendly"
  → `_resolve_need` folded the prior role in; only the Onboarding Plan updated.
- **Refusal.** "I need to hire someone" → Diana asked which role and generated nothing
  (verified — no deliverables produced).
- **MA2 preservation.** MA2 toggle vs gemma-composed offer, order-swap judged: Gemma 5
  / Tie 4 / MA2 1 — the (b)-vs-(c) evidence for §16. The composition refines and grounds
  the prose; the A2 structure persists as the seed.

## 14.6 Why this design

Pure automatic metrics (perplexity, retrieval hit-rate) under-measure a *grounded
composition* system, and a single LLM judge has a known discrimination ceiling (an A2
finding, §02.2). So the design **triangulates**: a faithfulness judge for grounding, a
deterministic citation-resolution check for provenance, observable routing for the
agentic behaviour, and human-readable A/B for the model-preservation question — with
the A1/A2 quantitative baselines anchoring the bottom of the arc. The systematic
(a)/(b)/(c) run is now executed (§14.3); the remaining honesty caveat is the
self-judging (c) judge, reported plainly per the rubric.
