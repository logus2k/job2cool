# MA3 Report Structure

---

## 1. Introduction
- Introduce job2cool / Diana as the final system of the trilogy: built on a model already
  domain-adapted (MA1) and aligned (MA2), this work wraps it into a complete system that
  turns a plain-language hiring need into a grounded, citable, editable pack of HR documents
  (Job Offer, Technical Interviews, Onboarding Plan, Cultural & Team Fit)
- One or two sentences on the arc: `ma2-360m-dpo-b01` (specialist Job-Offer drafter, DPO-aligned)
  + `gemma-4` (general orchestrator) → a final system with hybrid RAG (vector + graph) over a
  company KB and an LLM-driven, multi-step agentic pipeline (need resolution, role/domain
  classification, section selection, composition, citation)
- Identify the two new components required by the assignment:
  1. **Hybrid RAG** (vector + graph, with graph-based chunk resolution) over the
     `jobs_onboard_<family>` knowledge base
  2. **Tool use / agentic behaviour**: multi-step pipeline orchestrated by gemma-4
     (conversational memory, role classification, section selection, composition, citation)
- Status statement: system is functional end-to-end; the TalentForge AI-inspired layout is
  largely implemented (left nav rail, workspace bar with Share/Export All, per-deliverable
  tabs, cards overview, generation-progress stepper); remaining UI gaps are the "soon"
  placeholder nav items (Home, Templates, Documents, Candidates, Company Profile, Help &amp;
  Support) and STT/TTS/avatar availability only via the `logus2k.com/job2cool` proxy, not on
  `localhost:4920`

---

## 2. Pipeline Overview (A1 → A2 → A3 Arc)
- **Diagram (required):** `Base pretrained model → MA1 (domain adaptation, NL-need → Job Offer format)
  → MA2 (DPO alignment → ma2-360m-dpo-b01) → MA3 (job2cool: multi-model orchestration + RAG + UI)`
- **MA1:** continued pretraining of SmolLM2-360M on 12k IT job postings; full FT vs LoRA experiment;
  best result: 360M LoRA (PPL 11.38 in-domain); output: domain-fluent text completer
- **MA2:** SFT (Alpaca template, 7,500 instruction pairs from Gemma 4 ETL teacher) + DPO via RLAIF;
  four-beta probe, peak at β=0.10; result: `ma2-360m-dpo-b01`, the specialist Job-Offer drafter
  used in MA3. Key findings carried forward: template-locked generation, decoder bug
  (`repetition_penalty=1.3`), Granite judge ceiling
- **MA3:** `ma2-360m-dpo-b01` is not replaced but specialised — it is one component inside job2cool,
  responsible for drafting Job Offers, while gemma-4 handles orchestration and RAG-grounded composition
  of all other sections
- This section is the map referenced again in §7 (Reflection): does RAG make domain adaptation
  redundant? Likely no — MA1/MA2 specifically address Job Offer quality and style; RAG addresses
  grounding for the other three sections. Complementary, not substitutes

---

## 3. System Design

### 3.1 Architecture overview
- Pattern: custom frontend + `job2cool-backend` (α adapter) orchestrating over shared noted/cv services
- Architecture diagram: browser → job2cool-backend → {agent_server (`gemma-4` + `ma2-360m-dpo-b01`),
  noted-rag, noted-graph, noted (proxied KB/doc APIs)}
- Networks: job2cool-backend joins `noted-network` + `logus2k_network` (both external)
- Decision not to adopt the full noted shell: only the Diana/cv-chat widget is embedded;
  the noted shell is preserved at `frontend/shell.html` but unused
- **Copy-only guardrail:** built from copies of cv/noted files; shared services consumed without
  modification — with one documented exception (a `panels.css` `overflow:hidden` fix in noted,
  owner-requested and justified)
- Justify reuse: agent_server, noted-rag, and noted-graph are already tested infrastructure;
  project focus is the orchestration layer and HR-specific UX, not rebuilding serving

### 3.2 Component 1 — Hybrid RAG (vector + graph) over a domain KB
- KB organised as `jobs_onboard_<family>` domains: devops, architect, backend, data_eng,
  embedded, mobile, frontend, general, ml_ai, qa, security
- Vector search: noted-rag `POST /search_multi` (ChromaDB HNSW + bge-reranker-v2-m3)
- Graph search: noted-graph `/research/{domain}/retrieve` + `/chunk/{tag}` (entities,
  relationships, chunk-level bounding boxes)
- Aggregated: `graph_and_vector_search` runs vector and graph retrieval **concurrently**
  (`asyncio.gather`); the vector query is LLM-rewritten first via `formulate_query`
  (reusing the `cv_query_rewriter` preset — no new preset needed), the graph query uses
  the raw question (entity-name search handles conversational phrasing better than a
  rewritten phrase); results are joined into one evidence block (chunks tagged
  `[markdown_chunk:hex]`, entities `[E:id]`, edges `[R:src>type>tgt]`, graph-grounded
  excerpts also tagged `[markdown_chunk:hex]`) but are **not** cross-reranked after merging;
  per-section domain routing resolves `jobs_onboard_<family>` by classifying the hiring need
- **Justification for RAG over further fine-tuning:** the onboarding KB is broad and dynamic
  (owner still adding domains); RAG allows knowledge updates without retraining; the graph
  component enables precise per-chunk citations (PDF page + bounding box) that fine-tuning alone
  cannot provide
- Integration: orchestrator passes aggregated RAG context to gemma-4 for section composition;
  cited chunks appear as clickable `[markdown_chunk:hex]` badges in chat and in each document tab,
  resolving to PDF split pane with bbox overlay
- **Current limitation:** only `jobs_onboard_devops` and `jobs_onboard_architect` exist today;
  fallback chain: `jobs_onboard_general` → any existing `jobs_onboard_*`. All sections currently
  ground on the resolved onboarding domain; per-section domains (interview banks, culture, benefits)
  are not yet provided

### 3.3 Component 2 — Multi-step agentic orchestration
- `orchestrator.run_chat` is an LLM-decided pipeline (not rule- or regex-based):
  1. `_resolve_need` — rewrites the request using the last 6 turns (conversational memory),
     folding the role and skills from earlier turns into a self-contained sentence; falls back
     to the raw message
  2. `_role_label` — extracts the job title with Gemma (`think=False`, `max_tokens=16`);
     if no concrete position is found, Diana asks which role and returns early without generating
     any documents
  3. `resolve_onboard_domain` — LLM-classifies the role into one of 11 `ONBOARD_FAMILIES`,
     then probes `available_corpus_domains` (lazy, process-lifetime cache of noted-rag
     `/collections`) for the matching `jobs_onboard_<family>`; fallback chain:
     `jobs_onboard_general` → any existing `jobs_onboard_*` → hard-coded default
  4. `_requested_sections` — LLM-classifies which deliverables are requested (`think=False`,
     `max_tokens=24`); maps phrases like "job description" to `offer` only, or a generic
     hiring need to all four; replaced an earlier keyword heuristic that mis-fired on
     substrings (e.g. "full-stack" falsely matched "full package")
  5. Streamed conversational intro — Gemma (`llm_stream`, `INTRO_SYSTEM`, `INTRO_MAX=4096`,
     `temperature=0.5`) confirms the role and requested deliverables; the raw stream
     (including `<think>…</think>`) is forwarded to cv-chat where `ThinkingParser` renders
     the reasoning live in the Thinking panel; a `<voice>…</voice>` tag is appended so the
     avatar speaks a brief spoken summary rather than the full answer
  6. Per section (for each requested deliverable):
     - buffer tab is created **lazily**, immediately before that section starts generating
       (tabs appear and focus one-by-one in the UI as each section completes)
     - `graph_and_vector_search` (concurrent vector + graph retrieval)
     - if `offer` section and `use_ma2`: MA2 draft via `llm_complete` (`DPO_MAX=1200`);
       if `offer_both` (MA2 + Gemma both selected), the raw MA2 draft is written to a
       separate "Job Offer (MA2)" buffer so the UI can toggle between the two versions
     - Gemma composes the section (`SECTION_SYSTEM`, `SECTION_MAX=8192`, `temperature=0.4`,
       `timeout=300`); if an MA2 draft exists, it is included as a "refine this" DRAFT prompt
     - `buffers.replace` writes the finished section to the live buffer; `_cited_sources`
       appends a clickable Sources line using `[markdown_chunk:hex]` tags from graph excerpts
       (falls back to plain filenames when no resolvable excerpts are present)
  7. `_closing_note` — three-part post-generation message: (1) deterministic confirmation of
     what landed in the workspace and which KB domain was used; (2) one LLM sentence
     (`think=False`, `SUMMARY_MAX=320`) grounded in the actual retrieved evidence, flagging
     where KB coverage was thin; (3) next-deliverable nudge if not all four were requested
  8. `cache.put_turn` records the full turn (question, evidence, thinking, documents, answer,
     entities, edges, domains) for `/api/graph_trace` and `/api/score_answer`
- **Justification for dynamic design:** HR requests are ambiguous and variable; a fixed pipeline
  would force all four documents on every request; conversational memory allows iterative refinement
  ("now adjust the onboarding plan for a remote team")
- **`think=False` on all non-streaming `llm_complete` utility calls** (role classify, query
  rewrite, domain resolve, section classify, closing gap note, judge) — without this, gemma-4
  spends its entire token budget in `<think>` and returns empty visible content; the conversational
  intro uses `llm_stream` which always streams raw output including `<think>` blocks, and is the
  **only** call where thinking is intentionally left enabled (the Thinking panel renders it live).
  Concrete example of an implementation-vs-model-behaviour trade-off; revisited in §6

### 3.4 Models used
- **gemma-4** (`gemma-4` on agent_server): general orchestrator/composer, 128K context,
  vision + reasoning; `think=True` for generation, `think=False` for utility passes
- **ma2-360m-dpo-b01** (`ma2-360m-dpo-b01` on agent_server): the model from MA1+MA2 —
  SmolLM2-360M domain-adapted and DPO-aligned for Job Offer generation; ~430 tok/s, ~0.7 s/response;
  co-resident with gemma-4, selectable by model id; active when `ma2` is in `offer_sources`
- **Judge:** gemma-4 with explicit JSON instruction (not a separate preset); `cv_rag_judge`
  preset was tried and took ~400 s per call on this stack — replaced; limitation: Gemma judges
  its own outputs (no cross-judge isolation)
- **Query rewriter:** `cv_query_rewriter` preset (reused from cv stack; no new preset needed)
- **Settings toggle (`offer_sources`):** MA2 / Gemma / RAG multi-select; when both MA2 and Gemma
  are active, the Job Offer tab shows a Gemma / MA2 segmented toggle for direct comparison

---

## 4. Implementation Details

### 4.1 Backend
- FastAPI (`job2cool-backend`): owns `/api/chat` (SSE), `/api/buffers/*` (live-doc SSE),
  `/api/citation/{tag}`, `/api/graph_trace`, `/api/score_answer`; catch-all `/api/{path}`
  reverse-proxies to noted:8123
- Live documents: in-memory `DocBuffer` per deliverable + asyncio pub/sub → SSE; token caps
  set generously to avoid mid-generation truncation: `SECTION_MAX=8192` (Gemma section
  composition), `INTRO_MAX=4096` (intro stream), `DPO_MAX=1200` (MA2 draft),
  `SUMMARY_MAX=320` (closing gap note); Gemma's context is 131072 so none of these are
  system-level limits, just conservative output bounds
- Citation resolution: `[markdown_chunk:hex]` → noted-graph `/chunk/{tag}` → source path,
  page number, bbox regions; bbox only available for graph excerpts (dense-search chunks open
  PDF without a box — documented limitation)
- Chunk/turn caching (`cache.py`): chunk cache keyed by `sha1(chunk_id)[:12]` hex
  (FIFO-evicted, max 2048 entries); turn cache keyed by `turn_id` (max 256 entries), stores
  question, evidence, thinking, documents, answer, entities, edges, domains; backs
  `/api/score_answer` and `/api/graph_trace` without re-querying
- `/api/buffers/{buffer_id}/save` is a stub: it acknowledges the save but does not persist
  to disk or to the KB (deferred; marked `TODO(S7)` in code)
- Audio routing (STT/TTS/avatar): handled by the existing nginx proxy on
  `logus2k.com/job2cool`; not available on `localhost:4920` — explicit decision not to touch
  nginx config
- `available_corpus_domains`: lazily fetches the list of `<domain>__corpus` collections from
  noted-rag at first use and caches the result for the process lifetime; used by
  `resolve_onboard_domain` to confirm a `jobs_onboard_<family>` actually exists before routing
- Key env vars: `JOB2COOL_GEMMA_MODEL`, `JOB2COOL_DPO_MODEL`, `JOB2COOL_JUDGE`,
  `JOB2COOL_QUERY_REWRITER`, `JOB2COOL_DOMAINS` (fallback domain list used only by the
  citation resolver when no turn is cached, not in per-turn orchestration; default:
  `jobs_onboard_devops,ai_and_jobs,prod_mng,sw_arch`) — full list in appendix

### 4.2 Frontend and target layout
- Custom UI (`frontend/index.html`): gold accent `#ffe19b` (`--primary`); layout is a
  full-viewport flex row: left nav rail (`.sidenav`) + right main area (`.main`); main area
  contains a workspace top bar (`.wsbar`) with title + Share + Export All buttons, a tab bar
  (`.tabbar`), and a split doc/PDF pane (`.docpane` = `#doccol` | `#pdfcol`); Assistant
  (Diana) and Settings are left nav items, not header buttons
- **Diana widget** (cv-chat.js, patched in ~5 places): config passthrough, new-turn signal,
  citation handler → PDF split pane, base-relative asset paths (for `/job2cool/` sub-path
  deployment), Diana persona + `diana.png` + 20 short greetings
- **PDF rendering** (`js2c/pdfcite.js`): custom pdf.js renderer (`window.JOB2COOL_RENDER_PDF`)
  renders the cited page(s) into the split-pane container; ResizeObserver re-renders on width
  change; bbox overlay (`vp.convertToViewportRectangle`) only for graph-indexed chunks (chunks
  retrieved from noted-graph `/research/{domain}/chunk/{tag}` carry `regions[{page_no,bbox}]`);
  dense-vector-only chunks open the PDF but show no highlight (documented limitation)
- Three global hooks injected by `index.html` for cv-chat.js to call:
  `window.JOB2COOL_NEW_TURN` (reset tabs on send), `window.JOB2COOL_OPEN_PDF` (open split
  pane on citation click), `window.JOB2COOL_CONFIG` (settings object read with every POST)
- Per-tab: Copy MD + PDF export (print-in-place via `window.print()`); Job Offer tab: Gemma /
  MA2 segmented toggle when both versions exist
- **TalentForge AI mockup (`homepage_mockup.png`) — layout reference, not branding spec:**
  - Left nav rail (**implemented**): brand/logo, "+ New Request", Home / AI Assistant /
    My Workspace / Templates / Documents / Candidates / Company Profile / Settings, Help &amp;
    Support + user profile; placeholder items carry a "soon" badge and route to a toast
  - Center workspace (**implemented**): workspace top bar (package title + Share + Export All);
    per-deliverable tabs created on demand; All-Documents overview (cards grid per deliverable
    with icon, description, status badge, "Open Document" button; Generation Progress stepper)
  - Right: Diana / cv-chat (implemented)
  - Color: mockup uses indigo/violet; job2cool keeps gold `#ffe19b` accent
- **Remaining frontend gaps:** placeholder nav items are stubs only (no destination pages);
  STT/TTS/avatar work only on `logus2k.com/job2cool` (nginx proxy), not `localhost:4920`

---

## 5. Evaluation

### 5.1 Evaluation design
- What "the system works" means: (a) correct section segregation from a natural-language request;
  (b) generated content is grounded in verifiable citations (PDF + page + bbox where applicable);
  (c) Job Offer quality from MA2 is preserved once integrated (gemma composition does not degrade
  the specialist draft)
- Metrics: correct section-segregation rate; resolvable-citation rate (chunk → valid PDF);
  LLM-judge score (`/api/score_answer`) over responses; per-turn latency
- Test set: varied HR requests — full pack, single-section, ambiguous (no role specified),
  follow-ups that exercise conversational memory; describe construction (manual / synthetic)

### 5.2 Baselines and quantitative results
- (a) `ma2-360m` without DPO (pre-MA2): Job Offer in isolation, no system
- (b) `ma2-360m-dpo-b01` (MA2 result) in isolation: no RAG, no orchestration; MA2 §6 numbers carry across
- (c) Full job2cool system (MA3): RAG + orchestration + DPO-b01 draft + Gemma composition
- Results table using metrics from §5.1
- Central question: is the Job Offer quality from MA2 preserved or degraded once it passes
  through gemma's composition step? (b) vs (c) isolates this

### 5.3 Qualitative analysis
- Real example turns: request → generated sections → citations
- Success case: clear role request (e.g. "backend developer on AWS") → correct domain
  resolution, RAG over `jobs_onboard_backend`, resolved bbox citations
- Fallback case: domain not yet in KB (e.g. "frontend", "ml_ai") → fallback to general;
  discuss quality impact
- Memory case: initial request + follow-up ("now adjust the onboarding plan") → verify
  `_resolve_need` uses context correctly

---

## 6. Critical Discussion
- **What worked:** end-to-end pipeline verified (chat → DPO+Gemma+RAG → live tabs); citations
  in chat and in documents resolved to PDF+page+bbox; on-demand LLM-segregated tabs created
  lazily as each section completes; configurable settings knobs (`offer_sources` multi-select);
  Gemma/MA2 Job Offer toggle; conversation memory (`_resolve_need`); ask-for-role guard;
  TalentForge AI-inspired layout implemented (left nav rail, workspace bar, cards overview,
  progress stepper, Share/Export All); closing grounded gap note per turn
- **What didn't work / honest limitations:**
  - Only 2 of 11 `jobs_onboard_*` domains exist — limits real evaluation of RAG for most roles
  - Per-section domains (interview banks, culture, benefits) not yet provided; all sections
    ground on the single resolved onboarding domain — an approximation, not the final design
  - Audio (STT/TTS/avatar) works only via proxy (`logus2k.com/job2cool`), not
    `localhost:4920` — nginx config not modified (explicit decision)
  - Nav items outside "My Workspace" and "AI Assistant" are stubs (toast only)
  - `/api/buffers/{buffer_id}/save` does not persist to disk or KB (stub)
  - Gemma judges its own outputs (cross-judge isolation traded for operational practicality)
- **Trade-offs:**
  - `think=False` for utility calls: necessary to avoid empty responses, but potentially limits
    classification and summarisation quality
  - LLM-decided pipeline vs predictability: flexible for ambiguous requests, harder to test deterministically
  - Reuse of shared services vs autonomy: saves development time, introduces infrastructure dependency
    and the copy-only constraint (already requiring one exception)
- **What would be done differently / next steps:** complete the remaining 9 `jobs_onboard_*`
  KB domains; differentiate domains per section (offer, interview, culture each from a
  specialist corpus); implement the stub nav pages; browser verification pass (split-PDF,
  STT/TTS/avatar via nginx proxy); dedicated judge model on a separate inference slot to
  restore cross-judge isolation; persist buffers to disk (remove the save stub)

---

## 7. Reflection on the Three-Stage Arc (A1 → A2 → A3)
- Which stage contributed most? MA1+MA2 are **directly visible** in the final product:
  `ma2-360m-dpo-b01` is literally the Job Offer drafter inside the system, not replaced or diluted
- Did RAG (MA3) make MA1/MA2 redundant? No — RAG addresses grounding and broad domain knowledge
  (onboarding, interviews, culture); MA1/MA2 specifically address the quality and style of Job Offer
  writing. Complementary, not substitutes — argued with concrete examples from §5
- Was anything bypassed? If Gemma's composition heavily rewrites the DPO-b01 draft, the effect
  of MA2 alignment may be partially masked — verify empirically via (b) vs (c) in §5.2
- Honest closing assessment: MA3 is above all an **orchestration and UX layer** on top of the work
  done in MA1/MA2 — its added value lies in making the aligned model usable in a real pipeline,
  not in replacing it

---

## 8. Conclusion
- Summary: job2cool / Diana delivers a functional system that turns plain-language HR requests
  into a grounded, citable, editable pack of documents, built on `ma2-360m-dpo-b01` from MA1/MA2
- Briefly restate the main limitations (only 2 of 11 KB domains populated, per-section domain
  routing not yet differentiated, nav placeholder pages not implemented, save stub, Gemma
  self-judging, STT/TTS/avatar localhost limitation)
- Future work: remaining KB domains, per-section domain routing, activating nav pages,
  componentization (reusable MCP/Explorer/RAG-admin), browser verification pass

---

## Appendices
- Environment variable / configuration list: `JOB2COOL_GEMMA_MODEL` (default `gemma-4`),
  `JOB2COOL_DPO_MODEL` (default `ma2-360m-dpo-b01`), `JOB2COOL_JUDGE` (default gemma),
  `JOB2COOL_QUERY_REWRITER` (default `cv_query_rewriter`), `JOB2COOL_DOMAINS` (fallback
  domain list for citation resolver; default `jobs_onboard_devops,ai_and_jobs,prod_mng,sw_arch`),
  `JOB2COOL_FRONTEND_DIR`, `AGENT_SERVER_URL`, `NOTED_RAG_URL`, `NOTED_GRAPH_URL`,
  `NOTED_TOOLS_URL`, `NOTED_BACKEND_URL`
- Full architecture diagram (detailed version of project plan §1)
- TalentForge AI mockup (`homepage_mockup.png`) as UI target + current-state screenshots
- Repository setup: `docker compose up -d --build`; `logus2k.com/job2cool` vs `localhost:4920`
