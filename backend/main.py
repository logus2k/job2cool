# job2cool/backend/main.py
"""
job2cool-backend — the HR-assistant orchestrator (the "alpha adapter").

It preserves cv's Assistant API contract toward the frontend (chat SSE, citation
resolution, graph trace, score) while orchestrating the hiring/onboarding "pack"
flow over noted's shared services on noted-network:

  - agent_server (:7701)  OpenAI-compatible LLM. gemma-4 orchestrates; the
                          ma2-360m-dpo-b01 model drafts the job offer.
  - noted-rag   (:8200)   dense vector retrieval (per-domain `<id>__corpus`).
  - noted-graph (:5523)   knowledge-graph retrieval / synthesis.
  - noted-tools (:7702)   MCP user-tool host (optional).
  - noted       (:8123)   KB/Explorer + document-file APIs (read-only reuse).

Serving model: this backend serves the (stripped) noted shell statically and
REVERSE-PROXIES the shell's read-only KB/Explorer/DocumentViewer `/api/*` calls to
noted's backend, while OWNING the Assistant routes (/api/chat, /api/citation,
/api/graph_trace, /api/score_answer) and the live-document buffer
(/api/buffers/*). That keeps the shell working with minimal duplication, the
Assistant on cv's contract, and the live doc in-process.

COPY-ONLY: this project never modifies noted or cv. See documents/project_plan.md.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import buffers
import orchestrator

# --- service endpoints (internal noted-network names; env-overridable) -------
AGENT_SERVER  = os.getenv("AGENT_SERVER_URL",  "http://agent_server:7701")
NOTED_RAG     = os.getenv("NOTED_RAG_URL",     "http://noted-rag:8200")
NOTED_GRAPH   = os.getenv("NOTED_GRAPH_URL",   "http://noted-graph:5523")
NOTED_TOOLS   = os.getenv("NOTED_TOOLS_URL",   "http://noted-tools:7702")
NOTED_BACKEND = os.getenv("NOTED_BACKEND_URL", "http://noted:8123")

# Models (both co-resident on agent_server, selected per request by `model`).
GEMMA_MODEL = os.getenv("JOB2COOL_GEMMA_MODEL", "gemma-4")
DPO_MODEL   = os.getenv("JOB2COOL_DPO_MODEL",   "ma2-360m-dpo-b01")

# Default KB domains the agent fans out over (multi-domain RAG, like noted).
JOB2COOL_DOMAINS = [
    d.strip() for d in os.getenv(
        "JOB2COOL_DOMAINS",
        "jobs_onboard_devops,ai_and_jobs,prod_mng,sw_arch",
    ).split(",") if d.strip()
]

FRONTEND_DIR = Path(os.getenv("JOB2COOL_FRONTEND_DIR",
                              str(Path(__file__).resolve().parent.parent / "frontend")))

app = FastAPI(title="job2cool-backend", version="0.1.0")

# `/api/*` prefixes this backend OWNS (everything else under /api proxies to
# noted). Keep in sync as Assistant routes land in S4.
_OWNED_API_PREFIXES = ("health", "chat", "citation", "graph_trace",
                       "score_answer", "buffers", "job2cool")


# --- health / connectivity ---------------------------------------------------
async def _probe(client: httpx.AsyncClient, name: str, url: str) -> dict:
    try:
        r = await client.get(url, timeout=5)
        return {"service": name, "url": url, "ok": r.status_code == 200,
                "status": r.status_code}
    except Exception as e:
        return {"service": name, "url": url, "ok": False,
                "error": f"{type(e).__name__}: {e}"}


@app.get("/api/health")
async def health():
    checks = [
        ("agent_server", f"{AGENT_SERVER}/v1/models"),
        ("noted-rag",    f"{NOTED_RAG}/health"),
        ("noted-graph",  f"{NOTED_GRAPH}/health"),
        ("noted-tools",  f"{NOTED_TOOLS}/health"),
        ("noted",        f"{NOTED_BACKEND}/api/domains"),
    ]
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*(_probe(client, n, u) for n, u in checks))
    deps_ok = all(r["ok"] for r in results)
    return JSONResponse({
        "status": "ok" if deps_ok else "degraded",
        "service": "job2cool-backend",
        "models": {"gemma": GEMMA_MODEL, "dpo": DPO_MODEL},
        "domains": JOB2COOL_DOMAINS,
        "dependencies": results,
    })


# --- Assistant (cv contract) + live-document buffers (owned by job2cool) ------
class ChatRequest(BaseModel):
    message: str = ""
    history: list = []


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """HR-pack turn — streams cv-contract SSE while writing the live document."""
    return StreamingResponse(
        orchestrator.run_chat(req.message, req.history or []),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/buffers/events/stream")
async def buffer_events_stream():
    """SSE stream of live-document changes (the reused shell subscribes here)."""
    async def gen():
        yield "event: hello\ndata: {}\n\n"
        async for ev in buffers.subscribe():
            yield f"data: {json.dumps(ev)}\n\n"
    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/buffers/{buffer_id}/save")
async def buffer_save(buffer_id: str):
    buf = buffers.get(buffer_id)
    if not buf:
        return JSONResponse({"detail": "buffer not found"}, status_code=404)
    # TODO(S7): persist to the KB; for now the buffer lives in memory.
    return {"ok": True, "buffer_id": buffer_id, "name": buf.name}


# cv-contract endpoints the Assistant calls — minimal stubs, fleshed out in S3.
@app.get("/api/citation/{tag}")
async def citation(tag: str):
    return JSONResponse({"kind": "chunk", "title": "Source", "fields": [],
                         "body": "", "section_path": ""})


class GraphTraceRequest(BaseModel):
    entity_ids: list = []
    chunk_ids: list = []
    message: str = ""


@app.post("/api/graph_trace")
async def graph_trace(req: GraphTraceRequest):
    return {"seeds": [], "entities": [], "edges": []}


class ScoreRequest(BaseModel):
    turn_id: str


@app.post("/api/score_answer")
async def score_answer(req: ScoreRequest):
    return {"error": "scoring not enabled yet"}


# --- reverse proxy: shell's read-only KB/Explorer/Document APIs -> noted ------
# A shared client with no timeout cap on reads (some KB endpoints stream).
_proxy_client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None))
_HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive",
               "transfer-encoding", "te", "trailer", "upgrade",
               "proxy-authorization", "proxy-authenticate"}


@app.api_route("/api/{path:path}",
               methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy_api(path: str, request: Request):
    """Forward any /api/* not owned by this backend to noted's backend, so the
    reused shell (Explorer, DocumentViewer, KB admin) works unchanged."""
    top = path.split("/", 1)[0]
    if top in _OWNED_API_PREFIXES:
        # Owned but not yet implemented (S4) -> explicit 404 rather than a
        # misleading proxy round-trip.
        return JSONResponse({"detail": f"/api/{path} not implemented yet"},
                            status_code=404)
    url = f"{NOTED_BACKEND}/api/{path}"
    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in _HOP_BY_HOP}
    body = await request.body()
    req = _proxy_client.build_request(
        request.method, url, params=request.query_params,
        headers=headers, content=body)
    upstream = await _proxy_client.send(req, stream=True)
    resp_headers = {k: v for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_BY_HOP}

    async def _body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(_body(), status_code=upstream.status_code,
                             headers=resp_headers)


# --- static shell ------------------------------------------------------------
# noted's frontend references everything under `static/...`; mirror its mounts.
_WALLPAPERS = FRONTEND_DIR / "wallpapers"
if _WALLPAPERS.is_dir():
    app.mount("/wallpapers", StaticFiles(directory=str(_WALLPAPERS)), name="wallpapers")
if FRONTEND_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def index():
    idx = FRONTEND_DIR / "index.html"
    if idx.is_file():
        return FileResponse(str(idx))
    return JSONResponse({"detail": "frontend not found"}, status_code=404)
