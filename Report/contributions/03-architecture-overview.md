# 3. System Architecture

## 3.1 Pattern: the α-adapter

job2cool is a **custom frontend + a custom orchestration backend
(`job2cool-backend`, the "α adapter")** that drives a set of **shared, already-running
services** rather than rebuilding them. The backend preserves the chat contract the
Diana widget (an evolved fork of the `cv` assistant) expects, and internally
orchestrates the HR flow over the model server, the retrieval engines, and the KB
gateway.

```
Browser  (logus2k.com/job2cool  or  localhost:4920)
  ├─ frontend/index.html   custom HR UI: left nav, Workspace (doc|PDF split), Settings
  ├─ widget/cv-chat.js     Diana: chat + Thinking/Graph/Score/citations + STT/TTS/avatar
  └─ js2c/*.js             KB, Agents, Skills, Tools, Projects, Candidates, Help views
        │ (same origin)
        ▼
  job2cool-backend  (FastAPI, container, host :4920)
        ├─ OWNS:  /api/chat (SSE) · /api/buffers/* (live-doc SSE) · /api/citation
        │         /api/graph_trace · /api/score_answer · /api/job2cool/* (me, chats,
        │         candidates) · /api/agents/* · /api/mcp/* · Socket.IO (kb + health)
        ├─ PROXIES every other /api/* → kb-service (KB/doc APIs), with noted fall-through
        └─ CALLS shared services:
             agent_server:7701   gemma-4 + ma2-360m-dpo-b01  (OpenAI-compatible)
             kb-service:8080     KB gateway → noted-rag + noted-graph (+ arcadedb)
             mcp-service:8080    tools/skills host (+ websearch_server)
             llama-vision:8500   bge-m3 embeddings + bge-reranker (via the engines)
  Voice (STT/TTS/avatar): browser → proxy origin → stt/tts/avatar_server (not via backend)
```

The full topology — 16 request-path containers across three Docker networks — is
rendered and **live-health-monitored by the system itself** (see §12). The
architecture is therefore self-documenting: the same diagram is both the design
artifact and a running dashboard.

## 3.2 Key design decisions

**Embed only the assistant, not the whole noted shell.** Early plans considered
adopting `noted`'s full frontend shell. The decision (recorded in
`documents/project_plan.md` §6) was to embed only the evolved `cv` chat widget
(Diana) and build a purpose-built HR UI around it. The noted shell is preserved at
`frontend/shell.html` but is unused.

**Reuse the serving stack (the "B1" decision).** Rather than re-implement chat,
tool-calling, vector/graph RAG, and live-document buffers, the project reuses the
existing `agent_server`, retrieval engines, and KB tooling, and concentrates its
own effort on the **orchestration layer and HR-specific UX**. The rationale: those
services are already built and tested; the project's contribution is the system
*around* the aligned model, not a new inference stack. This is also what makes the
arc honest — A3 is an integration layer, not a from-scratch rebuild.

**Copy-only, non-destructive guardrail.** Everything is built from *copies* of the
`cv`/`noted` client files, customised in `job2cool/`; the shared services are
consumed in place and not modified. There is **one documented, owner-authorised
exception**: a one-line `overflow:hidden` fix in noted's `frontend/css/panels.css`
(and a rebuild of the noted service). This guardrail is a real engineering
constraint with real costs (it forced, e.g., new endpoints in the shared engines to
be additive — see §07, §13) and is revisited in the trade-offs discussion (§15).

**The adapter owns a precise prefix set; everything else proxies.** The backend
owns a fixed list of API prefixes (`health, chat, citation, graph_trace,
score_answer, buffers, job2cool, agents, mcp`); every other `/api/*` call is
reverse-proxied to `kb-service`, which composes the KB management/document APIs and
falls through to `noted` only for source-PDF file serving. This keeps the KB
management surface working with minimal duplication while the Assistant runs on the
`cv` contract.

## 3.3 Networks & identity

`job2cool-backend` joins two external Docker networks: **`noted-network`** (the
shared services) and **`logus2k_network`** (the voice stack and the site proxy).
Public access is via **`proxy_server`** (nginx) behind **`oauth2-proxy`** (Google
identity); the backend reads the authenticated user from `X-Forwarded-*` headers
(`/api/job2cool/me`), which drives the left-nav profile and the private/shared
project model (§10). Voice (STT/TTS/avatar) is reached **browser → proxy origin →
voice services**, never through the backend — which is why audio works on the
deployed origin but not on a bare `localhost:4920`.

## 3.4 Why this architecture serves the assignment

The α-adapter cleanly separates the three things the assignment cares about:

1. **The aligned model (A1/A2)** stays a discrete, swappable component on
   `agent_server` — visible, not dissolved into the system.
2. **The integrated components (A3)** — RAG, agentic orchestration, LLM-as-judge,
   and performance optimization of the serving stack — live in well-bounded places
   (the backend orchestrator, the KB gateway and engines, the judge endpoint, and
   the embedder configuration), making each one easy to describe, justify, and
   evaluate (§04, §14).
3. **Reproducibility** is tractable: a single `docker compose up -d --build` brings
   the backend up against the shared stack; the entry points (web UI; CLI ingestion)
   are explicit (§17).
