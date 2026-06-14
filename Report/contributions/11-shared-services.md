# 11. Shared Services & Componentization

A theme of the build was extracting reusable platform services so job2cool (and, in
principle, the sibling `cv`/`noted` apps) consume well-bounded gateways rather than
reaching into each other's internals. This realises the "componentization roadmap"
the original plan deferred to a later phase.

## 11.1 kb-service — the KB gateway

`kb-service` is the **knowledge-base gateway** job2cool talks to: the backend's
`NOTED_RAG_URL` / `NOTED_GRAPH_URL` / `NOTED_BACKEND_URL` point at it, and it composes
the KB management + document APIs from the underlying engines (noted-rag, noted-graph,
arcadedb) itself — `/api/domains`, `/api/domains/{id}/status`, document
upload/delete — falling through to `noted` only for source-PDF file serving. It is
also where the **live KB build-progress** relay originates: the graph engine emits
`kb:progress` events that surface in the job2cool KB view (§12).

The benefit is decoupling: job2cool depends on a *stable KB contract*, not on the
specific engines behind it; the engines can be moved or replaced without touching the
app. (Full engine-stack decoupling — moving the engines onto a KB-owned
compose/network and dropping noted's MLOps wiring — was scoped but deliberately not
done; the in-place progress emitter was implemented instead. This is recorded as
deferred work, §15.)

## 11.2 mcp-service — the tools/skills host

`mcp-service` is the **shared MCP tool/skill host**. It serves the job2cool Skills and
Tools admin views (through the backend, which holds the admin token so the browser
never does) over a standard MCP surface plus REST, scoped per app
(`/mcp/{app}/`, app = `job2cool`). It replaces the older per-app `noted-tools` host;
the job2cool backend's `/api/mcp/*` prefix proxies to it. Auth-gated admin keeps
tool creation/editing behind the backend.

## 11.3 websearch_server — isolated tool backend

`websearch_server` is a tool backend (browser-based search via Camoufox) that lives on
an **isolated network** (`mcp_internal`) and is therefore unreachable directly from
job2cool-backend. It is consumed *through* mcp-service, including for health: the live
monitor observes it via a side-effect-free `GET /backends/health` passthrough on
mcp-service (§12). The isolation is deliberate — a tool that drives a headless browser
is sandboxed away from the app network.

## 11.4 Why this matters for the assignment

Two of the assignment's concerns map onto this work:

- **Tool use / agentic** — mcp-service + websearch_server are the function-calling /
  external-API substrate the agentic component can grow into (the orchestrator's
  tool surface is hosted here).
- **Maintainability trade-off** (a §15 theme) — extracting gateways cost build effort
  and adds network hops, but buys decoupling and a single place to evolve the KB and
  tool contracts. The copy-only guardrail made *additive* extraction the only option,
  which is why these are new services rather than edits to the originals.

## 11.5 Service inventory (request path)

The shared services job2cool depends on at request time (full health-probe list in
§12 / §18):

| Service | Role |
|---|---|
| `agent_server` | OpenAI-compatible LLM (gemma-4 + ma2-360m-dpo-b01) |
| `llama-vision` | llama.cpp model router (gemma, ma2, bge-m3, bge-reranker) |
| `kb-service` | KB gateway → noted-rag + noted-graph (+ arcadedb) |
| `noted-rag` | vector store (ChromaDB) + bulk ingest endpoints (§9, §13) |
| `noted-graph` | graph retrieval + chunk page/bbox provenance + `kb:progress` |
| `noted-arcadedb` | graph store |
| `noted` | source-PDF/document file serving (fall-through only) |
| `mcp-service` | tools/skills host |
| `websearch_server` | isolated web-search tool backend |
| `proxy_server` / `oauth2-proxy` | edge + Google identity |
| `stt_server` / `tts_server` / `avatar_server` | voice (via proxy origin) |
