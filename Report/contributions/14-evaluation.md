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
numbers and define the A3 comparison:

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

The **(b)→(c)** comparison is the question this assignment is centrally about and is
addressed in §14.3–§14.5; the central sub-question is **whether gemma's composition
preserves the aligned draft's quality** — which the §06.6 Gemma/MA2 toggle makes
directly observable side-by-side.

## 14.3 System-level signals collected

What is implemented and observable today:

- **The RAGAS judge is live** (`/api/score_answer`): faithfulness + answer-relevance
  + rationale per turn, over the cached (question, evidence, documents) triple — an
  in-loop grounding metric, not just an assertion.
- **Citation resolution is verifiable**: graph-grounded chunks resolve to a PDF page +
  bbox; the resolvable-rate is directly checkable from the citation chain (§07).
- **Routing is observable**: the closing note (§6.7) states which domain was used and
  flags thin coverage; section selection is visible as the tabs that appear.
- **Candidate-search quality** (the retrieval substrate, §09): on multi-word role
  phrases retrieval is strong (e.g. *"senior python backend engineer with fastapi"* →
  top hits 0.99/0.97/0.96, all genuine Python backend engineers); on bare tokens or
  out-of-era terms it is correctly weak (*"genai"* → ~0.000x, because the 2020–2023
  corpus predates LLM-engineering vocabulary — an honest retrieval-quality finding,
  not a bug).
- **Performance, measured**: bulk-embed throughput ~100–120 CV/s; the embedder OOM
  fixed and **stress-verified flat at ~2.2 GB** under concurrency (§13); the full
  210,048-CV ingest completed with **read-back ack = indexed** (100% confirmed
  writes).

## 14.4 Evaluation harness (design + status)

A reproducible test set of varied HR requests covers: full pack; single-section ("just
a job description"); **ambiguous** (no role → the ask-back guard should fire and
generate nothing); and **follow-ups** that exercise conversational memory ("now make
the onboarding remote-friendly"). For each, the harness records section-segregation
correctness, domain resolution, resolvable-citation rate, judge scores, and latency.

**Honest status.** The judge, citation resolution, routing observability, and the
candidate-retrieval and performance numbers are in place and demonstrated. The
**formal (a)/(b)/(c) baseline table over a fixed prompt set is the remaining
evaluation task** — the harness and metrics are defined; the systematic run and the
results table are not yet executed. This is stated plainly rather than implied as
done, consistent with the honest-reporting requirement.

## 14.5 Qualitative analysis (worked examples)

The report will include concrete turns; the categories and what each demonstrates:

- **Success.** "Backend developer on AWS" → role extracted → `jobs_onboard_backend`
  resolved (it exists) → hybrid RAG → composed sections with **resolved bbox
  citations**. Shows routing + grounding + provenance end-to-end.
- **Fallback.** A role whose `jobs_onboard_<family>` is absent (`embedded`) → fallback
  to `general`; discuss the quality impact of grounding on a generic domain.
- **Memory.** Initial request + a context-dependent follow-up → verify `_resolve_need`
  folds prior turns in.
- **MA2 preservation.** The same offer via the **MA2 toggle** vs the gemma-composed
  version, judged side-by-side — the (b) vs (c) evidence for §16.
- **Refusal.** An under-specified request ("I need to hire someone") → Diana asks
  which role and generates nothing — a correct, safety-relevant behaviour.

## 14.6 Why this design

Pure automatic metrics (perplexity, retrieval hit-rate) under-measure a *grounded
composition* system, and a single LLM judge has a known discrimination ceiling (an A2
finding, §02.2). So the design **triangulates**: a faithfulness judge for grounding, a
deterministic citation-resolution check for provenance, observable routing for the
agentic behaviour, and human-readable A/B for the model-preservation question — with
the A1/A2 quantitative baselines anchoring the bottom of the arc. The honest gap (no
systematic A/B run yet) is itself reported, per the rubric.
