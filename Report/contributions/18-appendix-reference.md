# 18. Appendix — Reference

## 18.1 Backend-owned API surface

`job2cool-backend` owns these `/api/*` prefixes (everything else proxies to
kb-service, with noted fall-through): `health, chat, citation, graph_trace,
score_answer, buffers, job2cool, agents, mcp`.

Selected owned endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | the HR orchestration flow (SSE) |
| `GET /api/buffers/events/stream` · `POST /api/buffers/{id}/save` | live-doc SSE; save (stub) |
| `GET /api/citation/{tag}` | resolve a citation → source/page/bbox |
| `POST /api/graph_trace` · `POST /api/score_answer` | last-turn graph; RAGAS judge |
| `GET /api/job2cool/me` | authenticated identity (oauth2-proxy) |
| `GET/PUT/PATCH/DELETE /api/job2cool/chats[/{id}]` | Projects (private/shared) |
| `GET /api/job2cool/candidates` · `/candidates/{id}` | Candidates browse/search; detail |
| `/api/agents/*` · `/api/mcp/*` | agent presets; tools/skills host (proxied) |

New **additive** noted-rag endpoints created for the candidate ingest (copy-only
respected): `POST /upsert_records` (bulk embed+upsert, own flat metadata,
token-budget sub-batching, `skip_existing`, **read-back `verified`**); `POST
/list_records` (paginated/ by-id browse).

## 18.2 Configuration (environment variables)

| Var | Default | Role |
|---|---|---|
| `JOB2COOL_GEMMA_MODEL` | `gemma-4` | orchestrator/composer model id |
| `JOB2COOL_DPO_MODEL` | `ma2-360m-dpo-b01` | the A1/A2 Job-Offer specialist |
| `JOB2COOL_JUDGE` | gemma-4 | RAGAS judge model |
| `JOB2COOL_QUERY_REWRITER` | `cv_query_rewriter` | vector-query rewriter preset |
| `JOB2COOL_DOMAINS` | `jobs_onboard_devops,ai_and_jobs,prod_mng,sw_arch` | citation-resolver fallback list (not per-turn routing) |
| `AGENT_SERVER_URL` | `http://agent_server:7701` | LLM endpoint |
| `NOTED_RAG_URL` / `NOTED_GRAPH_URL` / `NOTED_BACKEND_URL` | kb-service / engines | retrieval + KB gateway |
| `MCP_SERVICE_URL` · `MCP_ADMIN_TOKEN` · `MCP_APP` | mcp-service | tools/skills host |
| `HEALTH_PROBE_INTERVAL` | `10`s | health monitor cadence |
| `CANDIDATES_COLLECTION` | `jobs_candidates__corpus` | candidate vector collection |
| Embedder: `parallel` | `1` | **slot cap** (the OOM fix, §13) in `agent_server/data/agent_config.json` |

## 18.3 Request-path containers (verified live)

`proxy_server`, `oauth2-proxy`, `job2cool-backend`, `agent_server`, `llama-vision`,
`kb-service`, `mcp-service`, `websearch_server`, `noted-rag`, `noted-graph`,
`noted-arcadedb`, `noted`, `stt_server`, `tts_server`, `avatar_server`.
*Excluded from the request path (KB ingestion/ops only):* noted's Airflow ×5,
Postgres, Redis, MLflow, MinIO, Evidently, noted-serving, noted-tools.

## 18.4 KB domains (verified live)

**Onboarding (10 of 11 populated):** `jobs_onboard_{architect, backend, data, devops,
frontend, general, ml_ai, mobile, qa, security}` — missing: `embedded`.
**Candidates:** `jobs_candidates` (210,048 vectors, vector-only).
**Thematic/other (sample):** `jobs_eng_culture`, `ai_and_jobs`, `prod_mng`, `sw_arch`,
`reports`, plus research corpora (`ai_papers`, `ai_democracy`, `eu_ai`,
`national_ai_agendas`, …) and the `cv` / `noted` corpora.

## 18.5 Module inventory

**Backend** (`backend/`): `main.py` (FastAPI + routes + proxy + Socket.IO mount),
`orchestrator.py` (the agentic pipeline), `services.py` (LLM + hybrid RAG),
`buffers.py` (live docs), `cache.py` (chunk/turn caches), `health_monitor.py` (live
probes), `socketio_relay.py` (kb-progress + health push).
**Frontend** (`frontend/js2c/`): `kb.js`, `agents.js`, `mcp.js` (Skills/Tools),
`chats.js` (Projects), `candidates.js`, `help.js`, `architecture.js` (the SVG map),
`pdfcite.js` (PDF+bbox), `sidepanel.js`; `widget/cv-chat.js` (Diana).
**Scripts:** `ingest_candidates.py`, `requirements-ingest.txt`.

## 18.6 Glossary

| Term | Meaning |
|---|---|
| **Diana** | the user-facing persona of job2cool (the HR assistant) |
| **α adapter** | `job2cool-backend`; preserves the cv chat contract, orchestrates over shared services |
| **A1 / A2 / A3** | Mini-Assignment 1 (domain adaptation) / 2 (alignment) / 3 (this system) |
| **`ma2-360m-dpo-b01`** | the A1+A2 model: SmolLM2-360M, domain-adapted + DPO-aligned Job-Offer drafter |
| **hybrid RAG** | concurrent vector (ChromaDB+bge-m3) + graph (noted-graph) retrieval, merged, dense hits reranked |
| **`[markdown_chunk:hex]` / `[E:id]` / `[R:…]`** | citation tags for chunks / entities / edges |
| **slot (llama.cpp)** | a concurrent sequence-processing lane; each retains an 8192-context buffer — the OOM cause (§13) |
| **read-back ack** | `/upsert_records` confirms written rows by re-reading ids from ChromaDB before acking |
| **copy-only guardrail** | build from copies; consume shared services without modifying them (one authorised exception) |
| **TalentForge AI** | the mockup (`homepage_mockup.png`) used as the UI layout reference |

## 18.7 Source documents (provenance)

This contributions set supersedes/updates: `documents/project_plan.md` (v1 history),
`documents/project_plan_v2.md` (partly stale current state),
`documents/candidates_technical_architecture.md` (as-designed candidate matching),
`documents/infrastructure_monitoring.md` (live map),
`Report/ma3_report_structure.md` & `Report/ma3_repor_v1.md` (the report skeleton +
§1–2 prose). Where those disagree with the running system, **this set and the verified
live state win** (see `00-index.md` staleness note).
