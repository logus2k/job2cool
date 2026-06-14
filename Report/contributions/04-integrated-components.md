# 4. Integrated Course Components

The assignment requires **at least two** additional course techniques layered on
top of the A1 fine-tuning and A2 alignment (which themselves do not count toward the
two). job2cool integrates **four**, each solving a problem the aligned model cannot
solve on its own. This section states the integration story; each component is
developed in a later section and evaluated in §14.

| # | Component (course bucket) | Problem it solves | Detail / Eval |
|---|---|---|---|
| 1 | **Retrieval-Augmented Generation** (vector store, hybrid retrieval, re-ranking) | The aligned model knows *how* to write a posting but knows nothing of the company's actual onboarding/interview/culture material, and cannot prove a claim's source. | §05, §07 / §14 |
| 2 | **Tool use / agentic behaviour** (multi-step planning, function-style routing) | A single prompt cannot interpret an ambiguous request, hold context across turns, decide *which* documents to produce, route to the right KB domain, and sequence drafting+composition. | §06 / §14 |
| 3 | **LLM-as-a-judge evaluation** (RAGAS-style faithfulness / answer-relevance) | Grounding must be *measured*, not asserted; the system needs an in-loop signal of whether composed sections stay faithful to retrieved evidence. | §06.6, §14 |
| 4 | **Performance optimization** (inference engine, quantization, KV-cache/slot/batching) | The serving stack must run a 4B orchestrator + a 360M specialist + embedder + reranker on one GPU, and survive a 210k-document bulk-embedding job without OOM. | §13 / §14 |

A fifth bucket, **advanced reasoning (Chain-of-Thought)**, is present but counted as
supporting rather than headline: gemma-4 emits inline `<think>…</think>` reasoning
that the orchestrator both relies on (the conditional/section-selection steps) and
surfaces live in the Thinking panel. We do not over-claim it as a fully separate
component because it is the model's native behaviour rather than an engineered
strategy like self-consistency or ToT.

## 4.1 Component 1 — Retrieval-Augmented Generation

**Form.** Hybrid retrieval over a per-domain knowledge base: dense **vector** search
(ChromaDB + bge-m3 embeddings) **and** **graph** retrieval (noted-graph entities,
relationships, chunk-level page/bounding-box provenance), run **concurrently** and
merged into one evidence block; the vector query is LLM-rewritten first, the graph
query uses the raw question. Re-ranking (bge-reranker-v2-m3, a cross-encoder) orders
dense hits. The candidate-matching layer (§08–§09) adds a **structured
pre-filter + vector + rerank** form of hybrid retrieval on candidate metadata.

**Why RAG over more fine-tuning.** The onboarding/interview/culture knowledge is
broad and *dynamic* (domains are still being added); RAG lets the knowledge change
without retraining, and the graph half yields **per-chunk citations to a PDF page +
bounding box** that fine-tuning cannot provide. RAG addresses *grounding*, which is
orthogonal to the *writing quality* A1/A2 addressed (the §16 wash-out argument).

**How it connects.** The orchestrator retrieves per section and passes the evidence
to gemma-4 for composition; cited chunks become clickable `[markdown_chunk:hex]`
badges in chat and in each document, resolving to a PDF split-pane with a bbox
overlay (§07).

## 4.2 Component 2 — Agentic orchestration

**Form.** `orchestrator.run_chat` is an **LLM-decided** multi-step pipeline (not
rules/regex): resolve the need against conversation memory → extract the role (ask
back if absent) → classify the role into a KB domain family and confirm the domain
exists → classify which deliverables are requested → stream a reasoning intro → for
each section: lazily open a tab, retrieve, optionally call the A2 drafter, compose
with gemma, write live, attach citations → close with a grounded coverage note.
Each decision is a model call with a tight contract; the candidate-matching design
(§08) extends this into **state-dependent branching** (candidate-aware vs generic
downstream).

**Why agentic.** HR requests are ambiguous and variable; a fixed pipeline would
force all four documents every time and could not support follow-ups ("now adjust
the onboarding plan for a remote team"). Routing, memory, and section selection are
exactly the capabilities a 360M specialist lacks — the reason a second, orchestrating
model exists at all (§02.4).

## 4.3 Component 3 — LLM-as-a-judge

**Form.** A RAGAS-style judge (`/api/score_answer`) scores a turn's composed
documents against the retrieved evidence on **faithfulness** and **answer-relevance**
with a rationale, surfaced in the Score panel. The MA2 stage already established a
disciplined judge methodology (cross-judge role split, order-swap protocol, and an
explicit *judge-discrimination ceiling*); §14 carries those lessons forward and §15
records the honest limitation that gemma currently judges its own output.

**Why a judge.** "The system works" must be operationalised. For a grounded
generator the load-bearing property is faithfulness-to-source; an LLM judge gives a
scalable signal of it that pure retrieval metrics (did a citation resolve?) do not.

## 4.4 Component 4 — Performance optimization

**Form.** The serving stack runs on **llama.cpp** (the `llama-vision` router) with
**Q8/Q4 quantized** GGUF weights for every model (gemma-4 Q4_K_XL, the A2 model,
bge-m3 Q8, bge-reranker Q8), co-resident under a model router with bounded RAM
cache. The headline optimization work is an **inference-engine memory fix**: the
210k-CV bulk embed repeatedly OOM-killed the shared embedder until it was
root-caused to **per-slot KV/compute-buffer retention under concurrency** and fixed
by capping bge-m3 to a single slot — a **KV-cache/slot/batching optimization** that
made the bulk job survivable while leaving correctness (8192-token capacity) intact.
Two new bulk endpoints add **token-budgeted batching** and **read-back-verified
idempotent upsert** (§13).

**Why it counts.** This is squarely the assignment's "inference engines
(llama.cpp), quantization, KV-cache optimization, batching strategies" bucket — and
it is not cosmetic: without it the candidate corpus could not be ingested at all
(it failed four times). It is also a genuine engineering-and-debugging contribution
with a clean root-cause analysis (§13), which the rubric's "sound engineering" and
"honest reporting of failures" criteria reward.

## 4.5 How the four compose

The components are not independent add-ons; they interlock around the aligned model:

- The **agentic** layer decides *when* to call the A2 drafter and *what* to retrieve;
- **RAG** supplies the evidence and the citations the composition is grounded in;
- the **judge** measures whether that grounding held;
- **performance optimization** is what makes the whole stack — orchestrator,
  specialist, embedder, reranker — run together on one GPU and ingest the corpus the
  retrieval depends on.

The result is a coherent system in which the A1/A2 model is a *specialist component*
and the four A3 components are the machinery that makes it usable, grounded,
measurable, and deployable.
