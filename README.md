# job2cool — "Diana", the HR Assistant

> ## 🟢 Live demo
> **job2cool is deployed and available for testing at <https://logus2k.com/job2cool>.**
> You can try it there directly — no local setup required. The instructions below are
> for reviewers who want to replicate the full stack locally.

job2cool turns a plain-language hiring need into a complete, RAG-grounded hiring
package, written live into a workspace by a chat assistant named **Diana**. From a
single conversation Diana produces, on demand:

- **Job Offer** (drafted by a specialist model, refined and grounded by Gemma)
- **Technical Interviews** (with expected answers and a scoring rubric)
- **Onboarding Plan** (30-60-90 day)
- **Cultural & Team Fit** assessment
- **Candidate match** (ranked against the open Job Offer or the role)

Every claim can cite its source, and clicking a citation opens the source PDF at the
highlighted passage.

job2cool is the **"alpha adapter"**: a custom frontend plus a FastAPI backend that
orchestrate the HR flow over a set of **shared services** (LLMs, retrieval,
knowledge graph, tools, speech). It does not run those services itself; it joins
their Docker networks and calls them. This README explains how to stand it up
together with those dependencies.

---

## 1. Architecture at a glance

```
                  Browser  →  http://localhost:4920   (or the hosted demo)
                          │
                 ┌────────▼─────────┐
                 │  job2cool-backend │  FastAPI + Socket.IO   (container, host :4920)
                 │  (frontend BAKED) │
                 └──┬───────┬────────┘
                    │       │
   ┌────────────────┘       └───────────────────────────────┐
   │ noted-network                                           │ logus2k_network
   │                                                         │
 agent_server:7701   kb-service:8080 ─▶ noted-rag:8200     stt_server:2700
 (gemma-4,            (façade /rag,      noted-graph:5523    tts_server:7700
  ma2-360m-dpo-b01,    /graph)           llama-vision:8500   avatar_server:7800
  cv_query_rewriter)  mcp-service:8080  noted:8123
```

- The **backend** (`backend/`) owns the Assistant API (`/api/chat` SSE, live-document
  buffers, citation→PDF resolution, graph trace, the RAGAS-style judge) and reverse
  proxies the read-only KB/Explorer calls to noted.
- The **frontend** (`frontend/`) is **baked into the image** (not bind-mounted), so
  any frontend or backend change requires an image rebuild (see §7).
- Speech (STT/TTS/avatar) is provided by the agent/avatar stack and is fully wired up
  in the hosted deployment (the live demo). A local `localhost:4920` run is text-only.

---

## 2. Dependency stack

job2cool reuses services that belong to the **noted** stack (network `noted-network`)
and the **agent/avatar** stack (network `logus2k_network`). These must already be
running.

| Service | Address (in-network) | Required | Purpose |
|---|---|---|---|
| `agent_server` | `http://agent_server:7701` | yes | LLMs: `gemma-4` (orchestrator/composer), `ma2-360m-dpo-b01` (offer drafter), `cv_query_rewriter` |
| `kb-service` | `http://kb-service:8080` | yes | KB gateway; forwards `/rag`→noted-rag and `/graph`→noted-graph |
| `noted-rag` | `http://noted-rag:8200` | yes | dense vector search over `<domain>__corpus` collections |
| `noted-graph` | `http://noted-graph:5523` | yes | knowledge-graph retrieval + chunk→PDF region resolution |
| `llama-vision` | `http://llama-vision:8500` | yes | embeddings (`bge-m3`) + rerank (`bge-reranker-v2-m3`) |
| `mcp-service` | `http://mcp-service:8080` | yes | shared tools/skills host (web_search) + the Skills/Tools admin UI |
| `noted` | `http://noted:8123` | yes | document-file serving + read-only KB/Explorer fallback |
| `stt_server` / `tts_server` / `avatar_server` | `:2700` / `:7700` / `:7800` | optional | Diana's voice + talking-avatar (hosted deployment only) |

> The container also probes `noted-arcadedb` for the live infrastructure-health view;
> it degrades gracefully if a probe target is absent.

### 2.1 Source repositories (clone these to replicate)

Every dependency is open-source under **`https://github.com/logus2k/<repo>`**. To run
the full stack locally, clone job2cool plus the repositories below and bring up each
stack (each repo has its own `docker-compose.yml` and README).

| Repository | Provides | Needed for |
|---|---|---|
| [`agent_server`](https://github.com/logus2k/agent_server) | the LLM server (`gemma-4`, `ma2-360m-dpo-b01`, `cv_query_rewriter`) **and `llama-vision`** (embeddings `bge-m3` + rerank), defined in the same compose | core — all generation + retrieval |
| [`noted`](https://github.com/logus2k/noted) | the KB engines: **noted** backend (doc serving) + **noted-rag** (vector) + **noted-graph** (knowledge graph). Monorepo. | core — grounding, citations, candidate corpus |
| [`kb`](https://github.com/logus2k/kb) | **kb-service**, the KB gateway that forwards `/rag` and `/graph` to the noted engines | core — job2cool talks to KB through this |
| [`mcp`](https://github.com/logus2k/mcp) | **mcp-service**, the shared tools/skills host (the `web_search` tool, Skills/Tools admin) | core — web search + Skills/Tools UI |
| [`websearch_server`](https://github.com/logus2k/websearch_server) | the Camoufox web-search backend invoked by the mcp `web_search` tool | web-search intent |
| [`avatar_server`](https://github.com/logus2k/avatar_server) | Diana's talking-avatar video stream | voice/avatar (optional) |
| [`tts_server`](https://github.com/logus2k/tts_server) | text-to-speech (Kokoro) | voice (optional) |
| [`stt_server`](https://github.com/logus2k/stt_server) | speech-to-text | voice input (optional) |

**Third-party image** (pulled automatically by the noted stack, not cloned):
**ArcadeDB** (`noted-arcadedb`, used by noted-graph).

> Not required to run job2cool: `noted-tools` (a former MCP host, no longer called) and
> the `cv` repo (job2cool's chat widget originated there but is vendored into
> `frontend/widget/`, so the cv repo is not a runtime dependency).
>
> Running job2cool **behind a domain** (TLS, Google login, voice routing) additionally
> needs an nginx reverse proxy and an oauth2-proxy; those are deployment concerns and
> are not required to replicate the app locally.

---

## 3. Prerequisites

- **Docker** and **Docker Compose v2**.
- The two **external Docker networks** must already exist (created by the other
  stacks):
  - `noted-network` (the noted stack)
  - `logus2k_network` (the agent/avatar stack)
- The **shared services in §2 must be up** on those networks. Clone and start them
  from their repositories (see **§2.1 Source repositories**).
- The required **models** must be loaded in `agent_server`: `gemma-4`,
  `ma2-360m-dpo-b01`, `cv_query_rewriter`.
- The required **knowledge-base domains** must exist in noted-rag/noted-graph
  (see §6).

Verify the networks exist:

```bash
docker network ls | grep -E 'noted-network|logus2k_network'
```

If either is missing, start its owning stack first (job2cool will fail to start with
an "network ... not found" error otherwise).

---

## 4. Setup and run (Docker Compose — the normal path)

From the repository root (`job2cool/`):

```bash
# 1. (optional) set secrets / overrides — see §5 for the full list
export MCP_ADMIN_TOKEN="<same token as mcp/.env>"
export JOB2COOL_ADMIN_EMAILS="you@example.com"   # who may edit Company Profile

# 2. build the image (bakes backend + frontend) and start the container
docker compose up -d --build job2cool-backend

# 3. check it is healthy
docker compose logs -f job2cool-backend
```

`docker-compose.yml` wires the environment (service URLs, models, domains) and joins
both external networks. The container listens on **`:4920`**.

**Access**

- **Local run:** open `http://localhost:4920/` directly. This is the full app
  (chat, generation, citations, candidate match, workspace) as **text** — no voice/
  avatar and no per-user identity, which are wired up only in the hosted deployment.
- **Hosted experience** (identity + voice/avatar): the live demo at
  <https://logus2k.com/job2cool>.

---

## 5. Configuration reference (environment variables)

All have sensible in-network defaults; override only what you need.

**Functional**

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_SERVER_URL` | `http://agent_server:7701` | LLM server (OpenAI-compatible) |
| `NOTED_RAG_URL` | `http://kb-service:8080/rag` | vector search endpoint |
| `NOTED_GRAPH_URL` | `http://kb-service:8080/graph` | knowledge-graph endpoint |
| `NOTED_BACKEND_URL` | `http://kb-service:8080` | KB/document gateway |
| `MCP_SERVICE_URL` | `http://mcp-service:8080` | shared tools/skills host |
| `MCP_ADMIN_TOKEN` | (compose default) | admin token for tool/skill writes; keep in sync with `mcp/.env` |
| `MCP_APP` | `job2cool` | the app namespace in mcp-service |
| `JOB2COOL_GEMMA_MODEL` | `gemma-4` | orchestrator/composer model |
| `JOB2COOL_DPO_MODEL` | `ma2-360m-dpo-b01` | Job Offer drafter |
| `JOB2COOL_QUERY_REWRITER` | `cv_query_rewriter` | retrieval query rewriter |
| `JOB2COOL_DOMAINS` | `jobs_onboard_devops,ai_and_jobs,prod_mng,sw_arch` | KB domains searched for grounding |
| `CANDIDATES_COLLECTION` | `jobs_candidates__corpus` | candidate-CV vector collection |
| `JOB2COOL_ADMIN_EMAILS` | (empty) | comma list of emails allowed to edit the **Company Profile**; if empty, any authenticated user may edit |
| `JOB2COOL_DATA_DIR` | `/app/data` | on-disk store (chat threads, `company_profile.json`) |
| `JOB2COOL_FRONTEND_DIR` | `/app/frontend` | served static frontend (set automatically in the image) |

**Health-probe overrides** — the `HM_*` and `HEALTH_PROBE_INTERVAL` variables only
retarget the live infrastructure-health view; the defaults match the in-network
service addresses and rarely need changing.

---

## 6. Knowledge base setup

Grounding and candidate matching read from collections that must already exist in
noted-rag / noted-graph:

- **Grounding domains** listed in `JOB2COOL_DOMAINS`. Each needs a
  `<domain>__corpus` vector collection and a built graph. Documents are ingested and
  graphs built through the noted/kb-service KB tooling. Citations open PDFs only for
  documents the graph has indexed (a dense-only chunk is cross-walked to its graph
  chunk at click time; see the project docs).
- **Candidate corpus** `jobs_candidates__corpus` for the candidate-match feature.
  To (re)ingest CVs from a parquet/dataset, use the isolated host script:

  ```bash
  python3 -m venv scripts/.venv-ingest
  scripts/.venv-ingest/bin/pip install -r scripts/requirements-ingest.txt
  scripts/.venv-ingest/bin/python scripts/ingest_candidates.py   # see the script header for args
  ```

---

## 7. Rebuilding after changes

The frontend is **baked into the image**, so there is no live-reload:

```bash
docker compose up -d --build job2cool-backend
```

Then **hard-refresh** the browser (static JS is served without a cache-busting query),
e.g. Ctrl/Cmd+Shift+R.

---

## 8. Data and persistence

`./data` is mounted to `/app/data` and holds:

- `data/chats/` — per-user and shared project threads (conversation + workspace docs +
  replay panels).
- `data/company_profile.json` — the shared logo/header/footer used on exported PDFs.

These survive container restarts and rebuilds. They are git-ignored.

---

## 9. Local development without Docker (optional)

You can run the backend on the host against the in-network services (you need network
reachability to them, e.g. by running on the same Docker host / on `noted-network`).

```bash
python3.12 -m venv .venv_job2cool
.venv_job2cool/bin/pip install -r backend/requirements.txt

# point the *_URL vars at reachable addresses, then:
JOB2COOL_FRONTEND_DIR="$PWD/frontend" \
  .venv_job2cool/bin/uvicorn main:asgi_app --app-dir backend --host 0.0.0.0 --port 4920
```

`backend/requirements.txt` is the single source of runtime dependencies. It is
pinned and validated: a clean virtualenv installing only this file imports the entire
backend (FastAPI app + Socket.IO ASGI wrapper) with no missing packages.

---

## 10. Auxiliary tooling

Two helper toolchains have **their own, separate** requirements files (kept out of the
runtime image on purpose):

- **Candidate ingestion** — `scripts/requirements-ingest.txt` (`pyarrow`, `requests`).
  See §6.
- **Evaluation harness** — `testing/requirements-eval.txt` (`torch`, `transformers`,
  `requests`) and `testing/README.md`. The base-model baseline runs locally via
  transformers; the system/judge configs are HTTP-only.

---

## 11. Repository layout

```
job2cool/
├── backend/                 FastAPI orchestrator (Diana)
│   ├── main.py              API + reverse proxy + Socket.IO ASGI app
│   ├── orchestrator.py      run_chat: intent router + per-section RAG/compose
│   ├── services.py          agent_server / RAG / graph / candidates clients
│   ├── buffers.py cache.py  live-document buffers + chunk/turn caches
│   ├── health_monitor.py    live infrastructure-health push
│   ├── socketio_relay.py    Socket.IO server (KB build progress, health)
│   ├── Dockerfile
│   └── requirements.txt     ← validated runtime dependencies
├── frontend/                baked-in UI (index.html, js2c/, widget/, vendor/)
├── scripts/                 candidate ingestion (own venv + requirements)
├── testing/                 evaluation harness (own venv + requirements)
├── documents/               architecture + project plans (project_plan_v2.md is authoritative)
├── data/                    persisted chat threads + company profile (git-ignored)
└── docker-compose.yml
```

---

## 12. Troubleshooting

- **Container won't start, "network noted-network not found"** — start the noted and
  agent/avatar stacks first so both external networks and the shared services exist
  (§3).
- **No audio / Diana doesn't speak** — expected on a local `localhost:4920` run; voice
  and avatar are wired up only in the hosted deployment (§4). Text generation is unaffected.
- **A frontend change isn't showing** — rebuild the image and hard-refresh (§7).
- **Citations show text instead of opening the PDF** — the cited document is not
  graph-indexed for that domain; (re)build the domain's graph so chunks resolve to PDF
  regions (§6).
- **Can't edit the Company Profile** — set `JOB2COOL_ADMIN_EMAILS` to include your
  signed-in email (§5).
