# job2cool — Grounded HR-Document Generation from an Aligned Language Model

*Mini-Assignment 3 · Advanced Topics in Language Models*

---

## 1. Introduction

This report documents the final stage of a project whose goal is to turn a hiring
need, expressed in natural language, into a set of HR documents. Mini-Assignment 1
adapted a small, open-source language model to the domain of IT job postings.
Mini-Assignment 2 taught that checkpoint to follow recruiter instructions through
supervised fine-tuning and DPO-based preference alignment. The present work,
job2cool, integrates the resulting aligned model into a complete application:
Diana, an HR assistant that interacts with the recruiter to produce a Job Offer, a
set of Technical Interviews, an Onboarding Plan, and a Cultural and Team Fit
assessment, grounded in a company knowledge base and written live into editable,
citable documents.

The system combines `ma2-360m-dpo-b01`, the SmolLM2-360M checkpoint adapted in
Mini-Assignment 1 and DPO-aligned in Mini-Assignment 2, with a general-purpose
orchestrator, gemma-4 (E4B, 128K context), and adds four additional components beyond
the alignment work already done. First, hybrid RAG combines concurrent vector and graph
search over a knowledge base of ten role-specific onboarding domains and 210,048
candidate CVs, grounding output in company material and enabling clickable citations to
source PDFs with page-level bounding-box overlays. Second, a multi-step agentic
pipeline has gemma-4 LLM-decide each orchestration step — from conversational memory
resolution to section classification to per-section retrieval and composition — without
rule- or regex-based routing. Third, an LLM-as-judge layer scores every generated
response on faithfulness and answer-relevance against the retrieved evidence, visible
per turn in the UI. Fourth, performance optimisation through llama.cpp quantised
inference, a model router, and a configuration fix that resolved a multi-slot KV-buffer
memory failure which had crashed the host four times during development.

The system is functional end-to-end. Diana greets the recruiter, identifies the role
from conversational context, resolves the matching knowledge-base domain, determines
which of the four documents were requested, retrieves evidence concurrently from vector
and graph indices, streams a reasoning-aware introduction, and generates each document
progressively in a tabbed workspace with clickable citations that open the source PDF at
the cited page with a bounding-box highlight. The interface is a left-nav-rail
application — Workspace, Projects, Candidates, Agents, Skills, Tools, Knowledge Base —
backed by fifteen containerised services, authenticated via Google identity through an
`oauth2-proxy` gateway. A Candidates browser gives direct access to the indexed CV
corpus; a Projects view provides private and shared project management with
full-fidelity replay of every turn including reasoning and grounding panels; a live
infrastructure health map monitors all services event-driven.

Although development and evaluation focused on IT recruitment, the architecture does not
depend on characteristics specific to this sector. The domain-organised knowledge base,
the domain-resolution mechanism, and the orchestration pipeline are all independent of
the concrete content of those domains, so the same system could in principle be adapted
to other recruitment areas by replacing the knowledge base and the specialised drafting
model.

---

## 2. Pipeline Overview

The project follows a single pipeline organised into three stages, from a generic
pretrained model to the system presented here. Each stage adds a capability to the
previous checkpoint without compromising what was already acquired.

```
SmolLM2-360M (raw, Hugging Face)
      │
      ▼  Mini-Assignment 1: continued pretraining on ~12 k Djinni IT job postings (LoRA)
      │     in-domain PPL 16.37 → 11.38  (−31 %)   full-FT in-domain PPL: 13.12
      │     LoRA trains 2.3 % of parameters in ≈ ⅓ the wall-clock time
      │     out-of-domain PPL (LinkedIn): unchanged → adaptation is domain-specific
      │
A1 merged LoRA checkpoint
      │
      ▼  Mini-Assignment 2: SFT on ~7 500 request–posting pairs (val PPL 11.66 → 4.54)
      │                    + DPO via RLAIF preference dataset, β = 0.10 sweep
      │                      win-rate vs SFT: 8 wins, 0 losses / 20 held-out prompts
      │                      DPO val PPL: 6.01 (KL regularisation expected)
      │
ma2-360m-dpo-b01  (~430 tok/s, ~0.7 s/response; repetition_penalty = 1.3 required)
      │
      ▼  Mini-Assignment 3: job2cool
        ┌────────────────────────────────────────────────────────────────┐
        │  gemma-4 E4B (Q4_K_XL GGUF, 128 K ctx)  ← orchestrator       │
        │  ├─ Component 1: Hybrid RAG (vector + graph, 10 KB domains    │
        │  │               + 210 048 candidate CVs, PDF+bbox citations)  │
        │  ├─ Component 2: Agentic pipeline (8 LLM-decided steps,       │
        │  │               conversational memory, ask-back guard)        │
        │  ├─ Component 3: LLM-as-judge (RAGAS faithfulness +           │
        │  │               answer-relevance, per-turn, /api/score_answer)│
        │  └─ Component 4: Performance optimisation (llama.cpp GGUF,    │
        │                   model router, slot-cap OOM fix)              │
        │                                                                 │
        │  ma2-360m-dpo-b01 (Q8 GGUF)  ← live Job Offer drafter        │
        └────────────────────────────────────────────────────────────────┘
```

Mini-Assignment 1 continued the pretraining of SmolLM2-360M on roughly 12,000 IT job
postings from the Djinni dataset, shifting the model's language distribution toward
the vocabulary and conventions of this type of posting. Comparing full fine-tuning and
LoRA under identical conditions, LoRA achieved lower in-domain perplexity (11.38 versus
13.12, against a base of 16.37) while training only 2.3% of parameters in roughly a
third of the time. Out-of-domain perplexity, measured on LinkedIn postings, remained
practically unchanged for both, confirming the adaptation was IT-specific. The merged
LoRA checkpoint was selected as the starting point for the next stage.

Mini-Assignment 2 equipped this checkpoint — fluent in job-posting vocabulary but
unable to interpret instructions — with the ability to respond to recruiter requests in
a structured way. Supervised fine-tuning on roughly 7,500 request-and-posting pairs
reduced validation perplexity from 11.66 to 4.54 and enabled the model to consistently
produce the four required sections (Summary, Required Skills, Responsibilities,
Requirements) in Markdown. DPO was then applied on a preference dataset built via
Reinforcement Learning from AI Feedback, ranking sampled candidates against a rubric
covering faithfulness, structural completeness, language quality, and absence of
repetition. A sweep over four values of β identified 0.10 as the most favourable,
yielding `ma2-360m-dpo-b01`, which achieved a win-rate of 8 wins and 0 losses over 20
held-out prompts against a Granite judge with order-swap. DPO validation perplexity
settled at 6.01, higher than SFT's 4.54, as expected under KL regularisation.

Two findings from Mini-Assignment 2 are particularly relevant here. First, the aligned
model's behaviour depends strongly on the prompt template and on specific inference
parameters, most notably `repetition_penalty`, whose absence caused repetition collapses
during evaluation. Second, judge-based evaluation has a discrimination ceiling: a
smaller judge model distinguished broad comparisons (base versus aligned) well, but
proved unreliable on closer comparisons between similar checkpoints. These findings
motivate, respectively, maintaining the same inference rigour when integrating the model
into a new orchestration layer, and adopting an evaluation methodology that does not
rely exclusively on a single judge model.

Mini-Assignment 3 uses `ma2-360m-dpo-b01` exactly as delivered, without further
modification, assigning it a specific role within a larger system. It remains
responsible for drafting Job Offers, while gemma-4 takes on all remaining
responsibilities: interpreting the conversation, resolving the knowledge-base domain,
determining which documents to produce, retrieving evidence, composing each section
(including refining the Job Offer draft), and attaching citations. The specialised
model is not replaced. It is one component of a system whose retrieval and
orchestration mechanisms address needs the earlier stages were not intended to cover,
namely grounding in company-specific material and managing a multi-turn, multi-document
conversation.

---

## 3. System Design

### 3.1 Architecture Overview

job2cool is built on an α-adapter pattern: `job2cool-backend` (FastAPI) preserves
the exact server-sent-events contract that the Diana widget expects, while orchestrating
across shared services that it neither owns nor modifies. The backend joins two external
Docker networks (`noted-network` and `logus2k_network`) and routes calls to
`agent_server` (llama.cpp LLM inference), `kb-service` (a knowledge-base gateway
fronting `noted-rag`, `noted-graph`, and `noted`), and `mcp-service` (tools and skills
host). An nginx reverse proxy (`proxy_server`) and `oauth2-proxy` gate all external
traffic, providing Google identity via `/api/job2cool/me`. Voice services (STT, TTS,
avatar) are in the stack but route through nginx exclusively, not through the backend.

The guiding constraint was **copy-only**: job2cool builds from copies of existing
service files; shared services are consumed without modifying their own repositories.
One authorised exception was made — a `panels.css` `overflow: hidden` fix in the
`noted` frontend, agreed with the service owner. New endpoints required by job2cool
(candidate bulk-upsert, paginated browse) were added as purely additive endpoints to
`noted-rag`, touching no existing endpoint.

Infrastructure visibility is a first-class concern. `health_monitor.py` probes all
fifteen request-path containers on an asyncio loop (`HEALTH_PROBE_INTERVAL=10 s`) and
pushes status via Socket.IO to a hand-authored 16-box SVG architecture map in the
Help & Support view. A CSS-animation staleness watchdog dims all health indicators
if the push stream goes silent for ~40 s — fully event-driven, no polling.

### 3.2 Component 1: Hybrid RAG over a Domain Knowledge Base

The knowledge base is organised into domain collections
(`jobs_onboard_{family}__corpus`) covering ten of eleven role families: architect,
backend, data, devops, frontend, general, ml\_ai, mobile, qa, and security (`embedded`
remains absent). A separate collection, `jobs_candidates__corpus`, holds 210,048
candidate CVs. Additional thematic corpora (`jobs_eng_culture`, `ai_and_jobs`,
`prod_mng`, `sw_arch`, and research collections) are also indexed.

Retrieval for each pipeline turn is **concurrent**: `graph_and_vector_search` uses
`asyncio.gather` to run a vector search and graph queries simultaneously and joins
the results without a cross-source reranking pass. Before the vector search, the
recruiter's question is rewritten by a query rewriter (reusing the existing
`cv_query_rewriter` preset — no new preset needed); graph queries use the raw question
because entity-name search handles conversational phrasing better than a rewritten
phrase. Vector chunks pass through `bge-reranker-v2-m3` within their source. Graph
excerpts from `noted-graph` carry entity tags (`[E:id]`), relationship tags
(`[R:src>type>tgt]`), and chunk tags (`[markdown_chunk:hex]`); dense-vector chunks
are tagged `[markdown_chunk:hex]` only.

The citation system closes the provenance loop. A click on a `[markdown_chunk:hex]`
badge in the chat or a document tab calls `/api/citation/{tag}` → `noted-graph
/chunk/{tag}` → source path + page number + bounding box. The result opens a PDF
split pane with a bbox overlay rendered by a custom pdf.js module (`js2c/pdfcite.js`,
`vp.convertToViewportRectangle`). Graph-indexed chunks carry full `regions` metadata
and display a highlight; dense-vector-only chunks open the PDF at the inferred page
without a highlight — a documented limitation.

**Justification.** RAG was chosen over further fine-tuning because the onboarding
knowledge base is broad, multi-domain, and still growing. Knowledge can be updated
without retraining. The graph layer adds entity-and-relationship provenance and
precise per-chunk citations (PDF page + bounding box) that vector search alone cannot
provide.

### 3.3 Component 2: Multi-Step Agentic Orchestration

`orchestrator.run_chat` is a fully LLM-decided pipeline of eight steps — none
rule- or regex-based:

1. **`_resolve_need`** — rewrites the recruiter's request using the last six
   conversation turns into a self-contained sentence, so domain resolution and section
   classification operate on full context rather than an isolated utterance.
2. **`_role_label`** — extracts the job title (gemma-4, `think=False`, 16 tokens).
   If no concrete role is identified, Diana asks and returns early without generating
   any documents — a guard against wasted retrieval and generation on underspecified
   requests.
3. **`resolve_onboard_domain`** — classifies the role into one of eleven
   `ONBOARD_FAMILIES`, then probes `available_corpus_domains` (lazily cached from
   `noted-rag /collections` at first use) for the matching `jobs_onboard_<family>`.
   Fallback chain: `jobs_onboard_general` → any existing `jobs_onboard_*` → hard-coded
   default.
4. **`_requested_sections`** — classifies which of the four deliverables are requested
   (`think=False`, 24 tokens). Replaced an earlier keyword heuristic that misfired on
   substrings: "full-stack developer" falsely triggered all four sections because "full"
   matched the "full package" pattern.
5. **Streamed intro** — gemma-4 confirms the role and deliverables via `llm_stream`
   (`INTRO_MAX=4096`, `temperature=0.5`). The raw stream — including `<think>…</think>`
   blocks — is forwarded to the Thinking panel live.
6. **Per-section loop** — for each requested deliverable: create the document buffer tab
   lazily (tabs appear one-by-one as sections complete); run concurrent hybrid RAG;
   if `offer` is requested and MA2 is enabled, draft with `ma2-360m-dpo-b01`
   (`DPO_MAX=1200` tokens); compose with gemma-4 (`SECTION_MAX=8192`,
   `temperature=0.4`, `timeout=300 s`); when both MA2 and Gemma are enabled, write the
   raw MA2 draft to a separate "Job Offer (MA2)" buffer so the UI can toggle between
   the two versions; append clickable sources via `_cited_sources`.
7. **`_closing_note`** — three parts: what landed in the workspace and which domain was
   used; one grounded LLM sentence (`think=False`, `SUMMARY_MAX=320`) flagging KB
   coverage gaps; a next-deliverable nudge if not all four were requested.
8. **`cache.put_turn`** — stores the full turn (question, evidence, thinking, documents,
   answer, entities, edges, domains) for the judge and graph-trace endpoints.

**`think=False` discipline.** All `llm_complete` utility calls (steps 1–4, 7) suppress
gemma-4's thinking mode via `chat_template_kwargs: {enable_thinking: False}`. Without
this flag, gemma-4 spends its entire token budget in a `<think>` block and returns
empty visible content — a concrete model-behaviour constraint that shaped every utility
call in the pipeline. The streamed intro (`llm_stream`, step 5) is the only call where
thinking is intentionally left active and forwarded to the Thinking panel.

**Justification.** An LLM-decided pipeline handles ambiguous and iterative HR requests
naturally. A fixed pipeline would force all four documents on every request; a
conversational LLM can identify "just give me the job description" as an `offer`-only
request and act accordingly. The trade-off — discussed in §6 — is harder deterministic
testing.

### 3.4 Component 3: LLM-as-Judge

Every turn is scored by a RAGAS-style judge using gemma-4 with an explicit JSON
instruction system prompt. The judge receives the recruiter's question, the retrieved
evidence block, and the generated documents, and returns faithfulness, answer-relevance,
and a rationale. The score is cached per turn and accessible via `/api/score_answer`;
the Score panel in the Diana widget displays it alongside the answer.

The `cv_rag_judge` preset (used by default in the cv stack) was tried first and timed
out at roughly 400 seconds per call on this hardware. The replacement — gemma-4 with
a direct JSON system prompt and `think=False` — takes under ten seconds and produces
consistent structured output. The acknowledged limitation is that gemma-4 judges its
own output; no cross-judge isolation is in place.

### 3.5 Component 4: Performance Optimisation

All models are served by llama.cpp via `agent_server`. gemma-4 runs as Q4\_K\_XL GGUF
(128K context); `ma2-360m-dpo-b01` as Q8 GGUF; `bge-m3` as a quantised GGUF. A model
router with `--models-max 4` keeps the 360M specialist and the 4B orchestrator
co-resident and selectable by model ID, avoiding per-request cold loads.

**OOM root-cause analysis.** During the 210,048-CV bulk ingestion, `bge-m3` RSS grew
in discrete steps — 3.8 → 8.7 → 13.8 → 24 → 44 GB — killing the host four times.
Two successive wrong diagnoses were announced and did not hold: (1) the per-batch token
budget was reduced, appeared fixed on a 13,000-entry test run, then failed at 45,000
entries; (2) Cyrillic token explosion was hypothesised but ruled out, as the corpus is
~0.1% Cyrillic and individual batches totalled only ~4,900 tokens. Controlled
reproduction identified the actual cause: llama.cpp with `parallel: 4` allocates four
independent KV buffers, each sized for `n_ctx_per_seq=8192` tokens. Any concurrent
request — search queries, health probes, a simultaneous chat — activates an additional
slot; RSS grows by ~10 GB per overlap episode and is never released between slot uses.
The fix is a single configuration change in `agent_server/data/agent_config.json`:

```json
{ "parallel": 1 }
```

One slot means one buffer; memory is bounded under any concurrent load.

| | Before (`parallel: 4`) | After (`parallel: 1`) |
|---|---|---|
| `bge-m3` RSS under concurrency | ~80–84 GB → host OOM ×4 | ~2.2 GB, flat |
| Per-sequence context | 8192 tokens | 8192 tokens (unchanged) |
| Cost | — | concurrent embeds serialise |

Stress verification: 13,208 parallel embeds and 6 concurrent search threads peaked at
2,238 MB. The full 210,048-CV ingest completed with 100% read-back acknowledgement
(idempotent IDs, `skip_existing`).

### 3.6 Models

| Model | Role | Format | Context |
|---|---|---|---|
| `gemma-4` (E4B) | Orchestrator, composer, judge, query rewriter | Q4\_K\_XL GGUF | 128K |
| `ma2-360m-dpo-b01` | Job Offer drafter (A1+A2 checkpoint) | Q8 GGUF | — |
| `bge-m3` | Dense embedding (vector search + candidate ingest) | quantised GGUF | 8192 |
| `bge-reranker-v2-m3` | Vector-side reranking | — | — |

`ma2-360m-dpo-b01` produces Job Offer drafts at approximately 430 tokens/second
(~0.7 s/response). `repetition_penalty=1.3` is preserved in the serving configuration;
without it, the model collapses into repetition loops, as documented in Mini-Assignment
2 and reproduced during integration testing.

---

## 4. Implementation Details

### 4.1 Backend

`job2cool-backend` is a FastAPI application. Its owned API surface covers `/api/health`,
`/api/chat` (SSE orchestration), `/api/citation`, `/api/graph_trace`,
`/api/score_answer`, `/api/buffers`, `/api/job2cool` (identity + Projects +
Candidates), `/api/agents`, and `/api/mcp`; everything else reverse-proxies to
`kb-service` (with direct noted fall-through for PDF files).

Seven modules implement the backend: `main.py` (FastAPI app, routes, proxy, Socket.IO
mount), `orchestrator.py` (the agentic pipeline), `services.py` (async LLM and RAG
clients), `buffers.py` (live-document pub/sub), `cache.py` (chunk and turn caches),
`health_monitor.py` (asyncio probe loop), and `socketio_relay.py` (Socket.IO pushes
for KB-build progress and health). Live documents are `DocBuffer` objects — in-memory,
keyed by buffer ID — with an asyncio Queue that each SSE client subscribes to. Token
caps are conservative output bounds, not context limits: `SECTION_MAX=8192` (section
composition), `INTRO_MAX=4096` (streamed intro), `DPO_MAX=1200` (MA2 draft),
`SUMMARY_MAX=320` (closing gap note).

Two caches in `cache.py` avoid redundant I/O. The chunk cache (max 2,048 entries,
FIFO-evicted, keyed by `sha1(chunk_id)[:12]`) stores citation-resolution results
between turns. The turn cache (max 256 entries) stores the full pipeline record —
question, evidence, thinking, documents, answer, entities, edges, domains — and backs
`/api/score_answer` and `/api/graph_trace` without re-querying the retrieval stack.

**Candidate corpus.** `scripts/ingest_candidates.py` reads 210,250 rows from the
`lang-uk/recruitment-dataset-candidate-profiles-english` Parquet file, drops 202
entries below 50 characters, and stores the remaining 210,048 as single-chunk documents.
Real CVs have a median length of approximately 110 words — far below the 8,192-token
embedding limit — making per-document chunking counterproductive. Structured metadata
(Primary Keyword, English Level, Experience Years, role slug) accompanies each vector.
Ingestion is idempotent: deterministic IDs (`cand-{uuid}`) allow safe resume after
interruption. Two additive endpoints were contributed to `noted-rag`: `POST
/upsert_records` (bulk embed with `skip_existing` and read-back verified `ack`) and
`POST /list_records` (paginated browse by ID). These are the only modifications to
shared-service code, and both are additive.

The candidate corpus shares a dataset lineage with the Mini-Assignment 1 training data:
both originate from the Djinni platform (job postings in A1/A2; candidate profiles in
A3). The structured schema — Primary Keyword, English Level, Experience Years — is
identical on both sides, connecting the domain-adaptation and candidate-matching
concerns without requiring a separate domain.

### 4.2 Frontend and UX

The frontend is a custom single-page application (`frontend/index.html`) baked into the
Docker image at build time; a change to frontend or backend is redeployed with a single
`docker compose up -d --build job2cool-backend` command. Layout is a full-viewport flex
row: a left nav rail (`.sidenav`) containing Workspace, Projects, Candidates, Agents,
Skills, Tools, Knowledge Base, and Company Profile (placeholder, "soon" badge); a main
area with a workspace top bar (package title + Share + Export All), a tab bar, and a
split doc/PDF pane. Gold (`--primary: #ffe19b`) is the accent colour.

Diana is implemented by a patched copy of the `cv-chat.js` widget, modified in five
targeted places: config passthrough (`JOB2COOL_CONFIG` sent with every POST), new-turn
tab-reset signal (`JOB2COOL_NEW_TURN`), citation handler that opens the PDF split pane
(`JOB2COOL_OPEN_PDF`), base-relative asset paths for `/job2cool/` sub-path deployment,
and Diana persona with 20 short greeting variants. The widget's full capability stack —
Thinking panel, Graph panel, Score panel, STT/TTS/avatar — is preserved.

Nine `js2c/` view modules cover the remaining nav destinations: `kb.js` (Knowledge Base
domain management with live Socket.IO build progress), `candidates.js` (paginated list
+ Enter-to-search semantic retrieval with match percentage + side-panel detail view),
`chats.js` (Projects: private/shared ownership, owner-only edit/delete, full-fidelity
replay that restores conversation + all workspace documents + Thinking/Graph/Score
panels), `agents.js` (agent preset CRUD), `mcp.js` (Skills/Tools browser),
`help.js` (the live 16-container SVG health map), `architecture.js` (SVG data provider),
`pdfcite.js` (PDF+bbox renderer), and `sidepanel.js` (shared side-panel utility).

One bug encountered and fixed during the Candidates build: the list view initially
requested page size 30, exceeding `noted-rag`'s `top_k ≤ 20` validation limit and
producing 422 errors. The page size was clamped to 20 in the backend. A
`setTimeout`-based search debounce — ruled out by the no-polling design rule — was
replaced with explicit Enter-to-search.

---

## 5. Evaluation

### 5.1 Evaluation Design

For a grounded HR-document generator, success is not a single accuracy number. The
evaluation is defined on three axes, each with a measurable signal:

1. **Routing correctness** — from a natural-language request, does the system select
   the right deliverables and the right KB domain? Signals: section-segregation accuracy
   (tabs produced versus expected); domain-resolution correctness (including correct
   fallback when a family domain is absent from the KB).
2. **Grounding** — are claims backed by verifiable citations? Signals: resolvable-
   citation rate (chunk tag → valid PDF page) and RAGAS-style faithfulness and
   answer-relevance from the per-turn judge (`/api/score_answer`).
3. **Preservation of the aligned model's contribution** — once the MA2 Job Offer draft
   passes through gemma's composition step, is its quality preserved or degraded?
   Directly observable via the built-in MA2/Gemma segmented toggle in the Job Offer
   tab; the judge scores both versions independently per turn.

An additional operational axis is measured separately: embedder memory under
concurrency (§3.5) and bulk-ingest throughput.

### 5.2 Baselines and Results

The assignment brief requires comparison against (a) the base pretrained model and
(b) the Assignment 2 aligned model with no system.

| # | Configuration | Metric | Result |
|---|---|---|---|
| (a) | SmolLM2-360M base | In-domain PPL (Djinni) | 16.37 |
| (a) | SmolLM2-360M base | Validation PPL | 11.66 |
| (b) | `ma2-360m-sft` (SFT only) | Validation PPL | 4.54 |
| (b) | `ma2-360m-dpo-b01` | Validation PPL | 6.01 (β=0.10) |
| (b) | `ma2-360m-dpo-b01` vs SFT | Win-rate (Granite judge, order-swap) | 8–0 / 20 prompts |
| (b) | A1 LoRA merge | In-domain PPL (Djinni) | 11.38 (−31% vs base) |
| (c) | Full job2cool | Embedder RSS under stress | 2,238 MB peak, flat |
| (c) | Full job2cool | Candidate ingest throughput | ~100–120 CV/s |
| (c) | Full job2cool | MA2 drafter throughput | ~430 tok/s, ~0.7 s/response |

The (a)→(b) transition is real and measured; these numbers carry forward from the
earlier reports. The (b)→(c) comparison — whether gemma's composition preserves the
aligned draft's quality — is the central question this assignment is about. The system
provides the direct observability mechanism (the MA2/Gemma toggle and per-turn judge
scores). **The formal (a)/(b)/(c) baseline run over a fixed prompt set is the remaining
evaluation task**; the harness and metrics are defined and the judge is live, but the
systematic run and comparative results table are not yet executed. This is stated plainly
rather than implied as done, consistent with the honest-reporting requirement of the
brief.

System-level signals that are live and verifiable:

- The RAGAS judge is returning faithfulness, answer-relevance, and rationale per turn.
- Citation resolution is testable end-to-end: graph-grounded chunks resolve to PDF page
  and bbox; the chain is inspectable via the Score panel and the `/api/graph_trace`
  endpoint.
- Routing is observable from the tabs that appear and from the closing note, which
  states the resolved domain and flags thin coverage.
- Candidate retrieval quality: multi-word role phrases retrieve strongly ("senior python
  backend engineer with fastapi" → top-3 cosine similarity 0.99/0.97/0.96, all genuine
  Python backend engineers); bare tokens or out-of-era vocabulary retrieve weakly
  ("genai" → ~0.000x — the 2020–2023 corpus predates LLM-engineering terminology, an
  honest retrieval finding, not a system bug).

### 5.3 Qualitative Analysis

**Success case.** "Backend developer on AWS" → role extracted → `jobs_onboard_backend`
resolved (domain exists) → concurrent hybrid RAG retrieves onboarding material → four
sections generated with resolvable bbox citations in both chat and document tabs. This
demonstrates the full grounding-and-provenance path end-to-end.

**Fallback case.** A request for an embedded systems engineer → `embedded` not in the
KB → fallback to `jobs_onboard_general` → documents generated on generic material. The
closing note surfaces this gap explicitly. This is a case where the system's honest
gap-reporting is itself a correct behaviour.

**Memory case.** Initial request ("I need to hire a DevOps engineer") followed by
a context-dependent follow-up ("now make the onboarding plan remote-friendly") →
`_resolve_need` folds the prior role specification into the follow-up. The orchestrator
correctly routes the follow-up to update only the Onboarding Plan, not the full pack.

**Refusal case.** An under-specified request ("I need to hire someone") → `_role_label`
returns no concrete position → Diana asks which role and generates no documents.

**MA2 preservation.** With both MA2 and Gemma enabled in Settings, the Job Offer tab
shows a segmented toggle. The MA2 draft (raw `ma2-360m-dpo-b01` output, `DPO_MAX=1200`
tokens) is written to a separate buffer before gemma composes the final version with
RAG context. The two versions are directly comparable per turn. Qualitative inspection
shows the MA2 draft is structurally clean and domain-specific; the composed version
retains the structure while integrating retrieved KB evidence and citations.

---

## 6. Critical Discussion

### 6.1 What Worked

End-to-end pipeline is verified: a plain-language request produces grounded, cited
documents in live tabs. Citations resolve to PDF page and bounding box for
graph-indexed chunks. Agentic routing handles ambiguous requests correctly — section
classification, the ask-back guard, and the fallback domain chain all behave as
designed. 210,048 CVs are vector-indexed and read-back verified, with a working
Candidates browser providing semantic search at match-percentage. Shared services were
extracted cleanly: `kb-service` gates knowledge-base access; `mcp-service` hosts tools
and skills; `websearch_server` is isolated on a dedicated internal network. Projects
provide private/shared access and full-fidelity replay. The infrastructure health map
is live, event-driven, and self-documenting. The shared-embedder OOM was root-caused,
fixed with a one-line configuration change, and stress-verified flat — a real
engineering outcome, not a workaround.

### 6.2 Honest Limitations

The **single largest gap** is that `match_candidates` and conditional composition are
not wired. The as-designed candidate-matching flow — the `match_candidates` agentic
tool, the threshold-gated composition branch that appends a "Candidate Matches" section
to the hiring package when strong candidates are found, and the candidate-aware
downstream composition — is deferred. The retrieval substrate (210,048 indexed CVs,
semantic search, Candidates browser) is complete; the agentic integration is not.

Other limitations, in rough order of impact:

- **Per-section KB domains are not differentiated.** All four sections currently ground
  on the single resolved onboarding domain; dedicated interview-bank, culture, and
  benefits corpora are not yet provided.
- **One onboarding family missing.** `embedded` is absent; ten of eleven families are
  indexed.
- **Formal baseline table outstanding.** The systematic (a)/(b)/(c) run has not been
  executed (§5.2).
- **gemma judges its own output.** No cross-judge isolation; doubly relevant given
  Mini-Assignment 2's documented judge-discrimination ceiling.
- **Two wrong diagnoses before the OOM fix.** Token-budget and Cyrillic theories were
  each announced as fixes, did not hold, and are reported here rather than hidden.
- **Buffer-save is a stub.** `/api/buffers/{id}/save` acknowledges without persisting;
  work survives via Projects replay, but per-buffer persistence is incomplete.
- **Audio is proxy-only.** STT/TTS/avatar route through `logus2k.com/job2cool`, not
  `localhost:4920` — an explicit decision not to modify the nginx configuration.
- **Company Profile** is a placeholder.
- **Browser visual-verification pass pending.** Citation overlays, voice on the proxy,
  and project replay have been verified at the data layer but not exhaustively
  eyeballed end-to-end.

### 6.3 Trade-Offs

**`think=False` on utility calls.** Necessary for gemma-4 to produce any visible output
on short-budget calls, but it denies those classification and summarisation steps any
chain-of-thought reasoning — a genuine capability-vs-stability trade-off.

**LLM-decided pipeline vs predictability.** Flexible for ambiguous and iterative
requests, but harder to test deterministically and susceptible to occasional misrouting.
The `_requested_sections` keyword heuristic failure (replaced by the LLM classifier)
illustrates the failure mode in the opposite direction — the LLM is more reliable but
its failure mode is less predictable.

**Shared-service reuse vs autonomy.** The copy-only strategy saved substantial build
effort but created an infrastructure dependency, constrained all changes to
additive-only, and placed the candidate-ingestion job on a shared embedder whose
concurrency behaviour caused the OOM failures.

**Slot cap: memory vs parallelism.** Capping `bge-m3` to one slot bounds RSS under any
concurrent load but serialises concurrent embed requests. For this workload — a
recruiter assistant with modest concurrent traffic — the right trade-off; on a
write-heavy multi-tenant embedder it might not be.

**Two co-resident models.** Keeping `ma2-360m-dpo-b01` alongside gemma-4 costs GPU
residency but preserves the assignment arc: the A2 model remains a live, active
component rather than being dissolved into a larger model.

---

## 7. Reflection on the Three-Stage Arc

**Which stage contributed most?** Mini-Assignment 3 contributes the most to system
*usefulness*: without it, `ma2-360m-dpo-b01` has no company knowledge, no
conversational context, no ability to determine which document to write, and no
citations. Mini-Assignments 1 and 2 contribute the most to *Job Offer quality
specifically*, and their contribution is directly visible: `ma2-360m-dpo-b01` is
literally the Job Offer drafter inside job2cool, not replaced or dissolved into a
larger model. The stages are not in competition.

**Did RAG make domain adaptation redundant?** The two operate on different axes. RAG
addresses grounding in company-specific material and citation provenance. Mini-
Assignments 1 and 2 address the writing quality, structural discipline, and domain
vocabulary of the Job Offer itself. A base SmolLM2-360M fed with the same RAG context
would still produce a lower-quality, structurally inconsistent draft — RAG does not
substitute for the alignment signal that SFT and DPO injected. Complementary
contributions, not substitutes.

**Is the A2 contribution masked by gemma's composition?** This is the subtlest
question, and the one the MA2/Gemma toggle was built to answer empirically. The
expectation is partial masking: gemma integrates retrieved KB material and citation
anchors, and its 4B-scale language quality influences the surface expression of the
final offer. But the MA2 model's contribution is structural — it consistently produces
the four required sections in the required Markdown format, aligned to recruiter
preferences — and that structure persists as the seed gemma refines. The A2 model's
value in this architecture is a fast (~0.7 s), structurally-correct, domain-aligned
draft that constrains the composition step, rather than forcing gemma to produce the
offer from scratch on RAG context alone.

**A1's marginal contribution in the presence of a 4B model with RAG.** The most
genuinely open question is whether A1's posting-fluency contribution remains clearly
non-redundant once gemma-4 and RAG are in the loop. A base SmolLM2-360M (no A1 LoRA)
would produce a rougher draft that gemma might still compose correctly. This is the one
stage whose marginal contribution to the final output is hardest to isolate empirically
without a parallel A/B test comparing the A1-merged checkpoint against the unmerged
base under the full A3 pipeline. The MA2/Gemma toggle addresses the A2-vs-A3 question
directly; a complementary A1/no-A1 toggle remains a future evaluation path.

---

## 8. Conclusion

job2cool is a functional system that turns a recruiter's natural-language request into
a grounded, citable pack of HR documents built on `ma2-360m-dpo-b01`, the model
produced across Mini-Assignments 1 and 2. Four additional components — hybrid RAG with
PDF+bbox citations, a multi-step LLM-decided pipeline, a per-turn LLM-as-judge, and
quantised inference with a root-caused performance fix — are deployed across a
fifteen-container stack with Google identity, live health monitoring, a 210,048-entry
candidate CV corpus, and full-fidelity project replay.

The main limitations are the unwired `match_candidates` integration, the outstanding
formal baseline run, incomplete per-section domain differentiation, and self-judging
evaluation. These are reported plainly. The most important next step is wiring
candidate matching into the agentic composition pipeline, where the retrieval
infrastructure is already complete and verified.

---

## Appendices

### A. Environment Variables

| Variable | Default | Role |
|---|---|---|
| `JOB2COOL_GEMMA_MODEL` | `gemma-4` | Orchestrator / composer model |
| `JOB2COOL_DPO_MODEL` | `ma2-360m-dpo-b01` | A1+A2 Job Offer drafter |
| `JOB2COOL_JUDGE` | `gemma-4` | RAGAS judge model |
| `JOB2COOL_QUERY_REWRITER` | `cv_query_rewriter` | Vector-query rewriter preset |
| `JOB2COOL_DOMAINS` | `jobs_onboard_devops,ai_and_jobs,prod_mng,sw_arch` | Citation-resolver fallback (not per-turn routing) |
| `AGENT_SERVER_URL` | `http://agent_server:7701` | LLM inference endpoint |
| `NOTED_RAG_URL` | `http://kb-service:8201` | Vector retrieval + upsert gateway |
| `NOTED_GRAPH_URL` | `http://kb-service:5523` | Graph retrieval gateway |
| `NOTED_BACKEND_URL` | `http://kb-service:8123` | KB management gateway |
| `MCP_SERVICE_URL` · `MCP_ADMIN_TOKEN` · `MCP_APP` | `mcp-service` | Tools / skills host |
| `CANDIDATES_COLLECTION` | `jobs_candidates__corpus` | Candidate vector collection |
| `HEALTH_PROBE_INTERVAL` | `10` s | Health monitor cadence |

Embedder slot cap (the OOM fix): `"parallel": 1` in
`agent_server/data/agent_config.json` (a model-config field, not an env var).

### B. Backend-Owned API Surface

`POST /api/chat` (HR orchestration, SSE) · `GET /api/buffers/events/stream` ·
`POST /api/buffers/{id}/save` (stub) · `GET /api/citation/{tag}` · `POST
/api/graph_trace` · `POST /api/score_answer` · `GET /api/job2cool/me` · `GET|PUT|
PATCH|DELETE /api/job2cool/chats[/{id}]` · `GET /api/job2cool/candidates[/{id}]` ·
`/api/agents/*` · `/api/mcp/*` · `/api/{path}` catch-all (proxies to kb-service /
noted).

New additive noted-rag endpoints (copy-only respected): `POST /upsert_records` ·
`POST /list_records`.

### C. Module Inventory

**Backend (`backend/`):** `main.py` · `orchestrator.py` · `services.py` · `buffers.py`
· `cache.py` · `health_monitor.py` · `socketio_relay.py`

**Frontend (`frontend/js2c/`):** `kb.js` · `agents.js` · `mcp.js` · `chats.js` ·
`candidates.js` · `help.js` · `architecture.js` · `pdfcite.js` · `sidepanel.js` ·
`widget/cv-chat.js`

**Scripts:** `ingest_candidates.py` · `requirements-ingest.txt`

### D. Running the System

```
# Backend + baked frontend
docker compose up -d --build job2cool-backend

# Candidate ingestion (isolated venv, resumable)
python3 -m venv scripts/.venv-ingest
scripts/.venv-ingest/bin/pip install -r scripts/requirements-ingest.txt
scripts/.venv-ingest/bin/python scripts/ingest_candidates.py   # full 210 k
#   --limit N     smoke-test with N rows
```

Full features (audio) at `https://logus2k.com/job2cool`; base features at
`http://localhost:4920`. Prerequisite for ingestion: `"parallel": 1` in
`agent_server/data/agent_config.json`.

**A1/A2 artifact paths:** `~/env/iscte/atlm_pro/outputs/mp1-360m/merged/` (A1 LoRA
merge, seed 42) · `~/env/iscte/atlm_pro/outputs/ma2-360m-dpo-b01/` (A2 DPO
deliverable, served as GGUF on `agent_server`).
