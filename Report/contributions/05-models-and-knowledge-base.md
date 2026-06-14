# 5. Models & Knowledge Base

## 5.1 Models in the request path

All models in the serving path are **open-source**, quantized, and co-resident on a
single GPU under the `llama-vision` llama.cpp router (§13). No closed API is used
anywhere in the request path.

| Role | Model id | What / why |
|---|---|---|
| **Orchestrator / composer** | `gemma-4` | Gemma-4 (E4B-class), 128K context, vision + reasoning; Q4_K_XL GGUF. Drives the agentic pipeline and composes RAG-grounded sections. Returns reasoning as inline `<think>…</think>` in `content`. |
| **Job-Offer specialist** | `ma2-360m-dpo-b01` | The **A1+A2 model** — SmolLM2-360M domain-adapted (A1) and DPO-aligned (A2). NL hiring need → Markdown Job Offer (Summary / Required Skills / Responsibilities / Requirements). ~430 tok/s, ~0.7 s/response. Active when `ma2 ∈ offer_sources`. |
| **Judge** | `gemma-4` + explicit JSON instruction | RAGAS-style faithfulness / answer-relevance judge. The `cv_rag_judge` preset was tried but took ~400 s/call on this stack and was replaced. Honest limitation: gemma judges its own output (§15). |
| **Query rewriter** | `cv_query_rewriter` preset | Reused from the cv stack to rewrite the vector query — no new preset authored. |
| **Embeddings** | `bge-m3` (Q8) | bge-m3 dense embeddings (1024-dim, cls pooling, cosine), 8192 context. Used for KB chunks, candidate CVs, and queries. |
| **Reranker** | `bge-reranker-v2-m3` (Q8) | Cross-encoder re-ranking of dense hits. |

The orchestrator runs with **`think=True` for generation** and **`think=False` for
every utility call** (role/section classification, query rewrite, domain resolution,
closing note, judge). This is a deliberate, load-bearing setting: without it gemma
spends its entire token budget inside `<think>` and returns empty visible content
(§06.7). The only call that intentionally streams thinking is the conversational
intro, whose `<think>` blocks are rendered live in the Thinking panel.

**Model-choice note (the A2 model is kept, not replaced).** §02.4 argues the
rationale: the 360M specialist is excellent and fast at its one aligned task but
cannot orchestrate; gemma-4 is the open-source orchestrator added alongside it. Both
are selectable per request by model id on the same OpenAI-compatible endpoint.

## 5.2 Knowledge base: domain organisation

The KB is a set of **per-domain corpora**, each a ChromaDB collection
`<domain_id>__corpus` plus a graph project. Two families matter for the HR flow:

**Role onboarding domains — `jobs_onboard_<family>`.** Eleven role families are
defined (`ONBOARD_FAMILIES`): architect, backend, data(_eng), devops, embedded,
frontend, general, ml_ai, mobile, qa, security. **Ten exist and are populated
today** — architect, backend, data, devops, frontend, general, ml_ai, mobile, qa,
security (only `embedded` is not yet created). *This corrects the older docs, which
still state "only 2 of 11 exist."* Per turn, gemma classifies the role into a family
and the orchestrator confirms the matching `jobs_onboard_<family>` actually exists
before routing, with a fallback chain `→ jobs_onboard_general → any existing
jobs_onboard_* → default` (§06.3).

**The candidate corpus — `jobs_candidates`.** A vector-only domain holding
**210,048** internal candidate CVs (§09). It is consulted only by the Candidates
browser / candidate-matching layer, never by the document-composition retrieval, so
CV chunks never contaminate Job-Offer or onboarding composition.

Other thematic domains exist on the shared stack (e.g. `ai_and_jobs`, `prod_mng`,
`sw_arch`, `jobs_eng_culture`, plus several research corpora) and are available to
the multi-domain fan-out; the full live list is in §18.

## 5.3 How retrieval uses the KB

Composition retrieval is **multi-domain hybrid** (§07): for a section, the resolved
onboarding domain is queried with concurrent vector + graph retrieval, the vector
query LLM-rewritten and the graph query raw, merged into a single evidence block
with citation tags. **Current approximation:** all four sections currently ground on
the *single* resolved onboarding domain; the as-designed per-section domains
(interview banks, culture, benefits) are not yet provided, so e.g. the Cultural &
Team Fit section is grounded on onboarding material rather than a dedicated culture
corpus. This is an honest limitation (§15) and the main piece of "more KB content"
in future work.

## 5.4 The Djinni lineage (why the corpora fit)

The KB and the candidate corpus share a lineage with the A1/A2 training data. A1/A2
adapted on the **Djinni job-descriptions** corpus (141,897 IT postings;
`Primary Keyword`, `English Level`, `Exp Years`). The MA3 candidate corpus is the
**candidate-side sibling** (`lang-uk/recruitment-dataset-candidate-profiles-english`,
210,250 CVs) with the *same structured vocabulary* (`Primary Keyword`,
`English Level`, `Experience Years`). That shared schema is what makes a job posting's
requirements filter directly into a candidate query with no translation (§08), and it
ties the three assignments to one publisher's release: jobs for model training
(A1/A2), candidates for retrieval-side matching (A3).
