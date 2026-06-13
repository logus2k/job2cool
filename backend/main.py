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
import re
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import buffers
import cache
import orchestrator
import services

# Judge with gemma-4 + explicit JSON (the cv_rag_judge preset's grammar 400s here).
JUDGE_MODEL = os.getenv("JOB2COOL_JUDGE",
                        os.getenv("JOB2COOL_GEMMA_MODEL", "gemma-4"))
JUDGE_SYSTEM = (
    "You are a strict, fair judge of an HR assistant's output. You receive: "
    "USER QUERY (what the user asked); SOURCE MATERIAL (the full pool of approved "
    "grounding for this turn — it combines the company knowledge base and, for a "
    "Job Offer, a specialist offer draft Diana refines; every passage in it is "
    "valid grounding on its own); DIANA'S THINKING (her private reasoning, for "
    "background); and WORKSPACE DOCUMENTS (the hiring deliverables Diana "
    "produced — these are her response, and the only thing you score). "
    "Output ONLY a JSON object (no prose, no code fence) of the form "
    '{"faithfulness": <0..1>, "answer_relevance": <0..1>, "rationale": "<text>"}. '
    "faithfulness = how well the claims in the WORKSPACE DOCUMENTS are supported "
    "by the SOURCE MATERIAL, taken as one pool. Judge by MEANING, not wording: a "
    "claim is faithful when its substance is supported by any part of the pool, "
    "counting direct statements, paraphrases, reasonable synthesis, and "
    "professional elaboration that stays consistent with a concept the pool "
    "covers. When the pool covers a concept (for example continuous improvement / "
    "Kaizen), a claim that builds on that concept is fully grounded even if the "
    "wording differs. A skill, technology, seniority, or requirement the USER "
    "QUERY explicitly asks for is also grounded — restating what the user "
    "requested is responsive, not fabrication. Reserve a deduction for a claim "
    "whose substance has no basis anywhere in the pool or the user's request — a "
    "fabricated tool, metric, employer, or requirement that nobody stated or "
    "implied. Documents whose every claim is supported score 1.0. "
    "answer_relevance = how well the WORKSPACE DOCUMENTS address the USER QUERY. "
    "rationale = 2-4 complete sentences; when you deduct, name the specific claim "
    "from the WORKSPACE DOCUMENTS that the SOURCE MATERIAL does not support, and "
    "finish every sentence.")

# --- service endpoints (internal noted-network names; env-overridable) -------
AGENT_SERVER  = os.getenv("AGENT_SERVER_URL",  "http://agent_server:7701")
NOTED_RAG     = os.getenv("NOTED_RAG_URL",     "http://noted-rag:8200")
NOTED_GRAPH   = os.getenv("NOTED_GRAPH_URL",   "http://noted-graph:5523")
NOTED_TOOLS   = os.getenv("NOTED_TOOLS_URL",   "http://noted-tools:7702")
NOTED_BACKEND = os.getenv("NOTED_BACKEND_URL", "http://noted:8123")
# Shared MCP tool/skill host. The frontend Skills/Tools admin UI talks to it
# through this backend (which holds the admin token so the browser never does).
MCP_SERVICE     = os.getenv("MCP_SERVICE_URL", "http://mcp-service:8080").rstrip("/")
MCP_ADMIN_TOKEN = os.getenv("MCP_ADMIN_TOKEN", "")
MCP_APP         = os.getenv("MCP_APP", "job2cool")

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


# --- identity (oauth2-proxy) -------------------------------------------------
# nginx (with oauth2-proxy --set-xauthrequest=true) forwards the authenticated
# user's identity as X-Forwarded-* headers — same pattern as jobunter. The email
# is the canonical key. When the headers are absent (local dev without the proxy)
# we report "not authenticated" so the UI can fall back gracefully.
_GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
_userinfo_cache: dict[str, tuple[float, dict]] = {}  # access_token -> (expires_at, claims)


async def _google_userinfo(access_token: str) -> dict:
    """Fetch Google profile claims (name, picture) for an access token.

    Google omits name/picture from the ID token; they live only at the UserInfo
    endpoint. Cached briefly per access token (the token rotates ~hourly).
    """
    if not access_token:
        return {}
    now = time.time()
    hit = _userinfo_cache.get(access_token)
    if hit and hit[0] > now:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(_GOOGLE_USERINFO_URL,
                                  headers={"Authorization": f"Bearer {access_token}"})
        info = r.json() if r.status_code == 200 else {}
        if r.status_code != 200:
            print(f"[me-debug] userinfo HTTP {r.status_code}: {r.text[:120]}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[me-debug] userinfo error: {type(e).__name__}: {e}", flush=True)
        info = {}
    if info:
        if len(_userinfo_cache) > 256:
            _userinfo_cache.clear()
        _userinfo_cache[access_token] = (now + 600, info)
    return info


@app.get("/api/job2cool/me")
async def me(request: Request):
    """Echo the authenticated identity from oauth2-proxy headers.

    Email/user/preferred-username come from the X-Auth-Request-* set; the richer
    Google profile claims (name, picture) are fetched from Google's UserInfo
    endpoint using the access token forwarded as X-Access-Token
    (oauth2-proxy --pass-access-token).
    """
    email = (request.headers.get("X-Forwarded-Email") or "").strip()
    user = (request.headers.get("X-Forwarded-User") or "").strip()
    pref = (request.headers.get("X-Forwarded-Preferred-Username") or "").strip() or None
    access_token = (request.headers.get("X-Access-Token") or "").strip()

    info = await _google_userinfo(access_token)
    print(f"[me-debug] X-Access-Token len={len(access_token)} "
          f"userinfo_keys={sorted(info.keys())} name={info.get('name')!r}", flush=True)
    name = (info.get("name") or "").strip() or pref
    picture = (info.get("picture") or "").strip() or None
    email = email or (info.get("email") or "").strip()

    return JSONResponse({
        "email": email or None,
        "user": user or None,
        "display_name": name,
        "picture": picture,
        "authenticated": bool(email),
    }, headers={"Cache-Control": "no-store"})


# --- chat history persistence (per-user, on-disk; survives restarts) ---------
# Option A: job2cool owns chat threads, keyed by the authenticated email, stored
# on a mounted volume. Threads auto-save each turn from the widget; the Chats
# view lists them; selecting one reloads the whole conversation.
JOB2COOL_DATA_DIR = os.getenv("JOB2COOL_DATA_DIR", "/app/data")
_CHATS_DIR = os.path.join(JOB2COOL_DATA_DIR, "chats")
_TID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _chat_user_dir(request: Request) -> str:
    email = (request.headers.get("X-Forwarded-Email") or "").strip().lower()
    key = re.sub(r"[^a-z0-9._-]", "_", email) if email else "anon"
    d = os.path.join(_CHATS_DIR, key)
    os.makedirs(d, exist_ok=True)
    return d


class ChatThreadIn(BaseModel):
    title: str = ""
    messages: list = []


@app.get("/api/job2cool/chats")
async def chats_list(request: Request):
    d = _chat_user_dir(request)
    out = []
    for fn in os.listdir(d):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, fn)) as f:
                t = json.load(f)
            out.append({"thread_id": t.get("thread_id") or fn[:-5],
                        "title": t.get("title") or "Untitled",
                        "updated_at": t.get("updated_at") or 0,
                        "message_count": len(t.get("messages") or [])})
        except Exception:  # noqa: BLE001
            continue
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return JSONResponse({"chats": out})


@app.get("/api/job2cool/chats/{tid}")
async def chats_get(tid: str, request: Request):
    if not _TID_RE.match(tid):
        return JSONResponse({"error": "bad id"}, status_code=400)
    p = os.path.join(_chat_user_dir(request), tid + ".json")
    if not os.path.isfile(p):
        return JSONResponse({"error": "not found"}, status_code=404)
    with open(p) as f:
        return JSONResponse(json.load(f))


@app.put("/api/job2cool/chats/{tid}")
async def chats_put(tid: str, body: ChatThreadIn, request: Request):
    if not _TID_RE.match(tid):
        return JSONResponse({"error": "bad id"}, status_code=400)
    p = os.path.join(_chat_user_dir(request), tid + ".json")
    now = time.time()
    created = now
    if os.path.isfile(p):
        try:
            with open(p) as f:
                created = json.load(f).get("created_at") or now
        except Exception:  # noqa: BLE001
            pass
    rec = {"thread_id": tid, "title": (body.title or "Untitled")[:120],
           "created_at": created, "updated_at": now, "messages": body.messages}
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, p)
    return JSONResponse({"ok": True, "thread_id": tid, "updated_at": now})


class ChatRenameIn(BaseModel):
    title: str = ""


@app.patch("/api/job2cool/chats/{tid}")
async def chats_rename(tid: str, body: ChatRenameIn, request: Request):
    if not _TID_RE.match(tid):
        return JSONResponse({"error": "bad id"}, status_code=400)
    p = os.path.join(_chat_user_dir(request), tid + ".json")
    if not os.path.isfile(p):
        return JSONResponse({"error": "not found"}, status_code=404)
    with open(p) as f:
        rec = json.load(f)
    rec["title"] = (body.title or "Untitled")[:120]
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, p)
    return JSONResponse({"ok": True, "title": rec["title"]})


@app.delete("/api/job2cool/chats/{tid}")
async def chats_delete(tid: str, request: Request):
    if not _TID_RE.match(tid):
        return JSONResponse({"error": "bad id"}, status_code=400)
    p = os.path.join(_chat_user_dir(request), tid + ".json")
    if os.path.isfile(p):
        os.remove(p)
        return JSONResponse({"deleted": True})
    return JSONResponse({"deleted": False}, status_code=404)


# --- Assistant (cv contract) + live-document buffers (owned by job2cool) ------
class ChatRequest(BaseModel):
    message: str = ""
    history: list = []
    config: dict = {}   # e.g. {"offer_sources": ["ma2","gemma","rag"]}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """HR-pack turn — streams cv-contract SSE while writing the live document."""
    return StreamingResponse(
        orchestrator.run_chat(req.message, req.history or [], req.config or {}),
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


# cv-contract endpoints the Assistant calls (citation / graph / score).
@app.get("/api/citation/{tag}")
async def citation(tag: str):
    """Resolve a clicked [markdown_chunk:<hex>] tag to navigable provenance:
    source_path + section + body text, and — when noted-graph indexes the chunk —
    page_no + bbox + regions so the viewer can open the PDF and highlight it."""
    raw = tag.strip().strip("[]").strip()
    hx = raw.split(":", 1)[1] if raw.startswith("markdown_chunk:") else raw
    cached = cache.get_chunk(hx) or {}

    turn = cache.last_turn() or {}
    domains = turn.get("domains") or JOB2COOL_DOMAINS
    region_hit = None
    async with httpx.AsyncClient() as client:
        region_hit = await services.resolve_chunk_regions(client, hx, domains)

    src = (region_hit or {}).get("source_path") or cached.get("source_path") or ""
    section = ((region_hit or {}).get("section_path")
               or cached.get("section_path") or "")
    body = ((region_hit or {}).get("snippet")
            or cached.get("text") or "")
    domain_id = ((region_hit or {}).get("domain_id")
                 or cached.get("kb_id") or "")
    regions = (region_hit or {}).get("regions") or []

    if not src and not body:
        return JSONResponse({"kind": "chunk", "title": "Source", "fields": [],
                             "body": "(source not found)", "section_path": "",
                             "source_path": "", "domain_id": "", "regions": []})
    fields = []
    if src:
        fields.append(["Document", src])
    if section:
        fields.append(["Section", section])
    if regions:
        fields.append(["Page", str(regions[0].get("page_no", ""))])
    return JSONResponse({
        "kind": "chunk", "title": "Source passage", "fields": fields,
        "body": body, "section_path": section,
        "source_path": src, "domain_id": domain_id,
        "page_no": (regions[0].get("page_no") if regions else None),
        "regions": regions,
    })


class GraphTraceRequest(BaseModel):
    entity_ids: list = []
    chunk_ids: list = []
    message: str = ""


@app.post("/api/graph_trace")
async def graph_trace(req: GraphTraceRequest):
    """Return the most recent turn's merged knowledge-graph (entities/edges)."""
    turn = cache.last_turn()
    if not turn:
        return {"seeds": [], "entities": [], "edges": []}
    return {"seeds": req.entity_ids or [],
            "entities": turn.get("entities") or [],
            "edges": turn.get("edges") or []}


class ScoreRequest(BaseModel):
    turn_id: str


def _docs_for_judge(docs: str | None) -> str:
    """Strip inline citation tags before judging — they are provenance markers,
    not claims, and the judge otherwise mistakes a stray tag for a fabrication."""
    if not docs:
        return "(none)"
    return re.sub(r"\[(?:markdown_chunk:[0-9a-f]+|E:[^\]]+|R:[^\]]+)\]", "", docs)


@app.post("/api/score_answer")
async def score_answer(req: ScoreRequest):
    """RAGAS-style judge over the cached (question, evidence, answer)."""
    turn = cache.get_turn(req.turn_id)
    if not turn:
        return {"error": "turn not found"}
    ma2 = (turn.get("ma2_offer") or "").strip()
    # One combined grounding pool — presenting evidence and the MA2 draft as
    # separate labelled sources made the judge cross-validate them (deducting
    # when a claim was in one but not the other). Merged, any passage grounds.
    # MA2 goes first so the small judge model attends to it (it's the compact,
    # offer-specific source that's easy to lose after a long evidence block).
    sm_parts = []
    if ma2:
        sm_parts.append(f"[Specialist offer draft Diana refines]\n{ma2}")
    sm_parts.append(f"[Company knowledge base]\n{turn.get('evidence') or '(none)'}")
    source_material = "\n\n".join(sm_parts)
    judge_user = (
        f"USER QUERY:\n{turn.get('question', '')}\n\n"
        f"SOURCE MATERIAL (one pool of approved grounding — any passage here is "
        f"valid on its own):\n{source_material}\n\n"
        f"DIANA'S THINKING (background context):\n"
        f"{turn.get('thinking') or '(none captured)'}\n\n"
        f"WORKSPACE DOCUMENTS (what Diana wrote into the document pane):\n"
        f"{_docs_for_judge(turn.get('documents'))}")
    try:
        async with httpx.AsyncClient() as client:
            content = await services.llm_complete(
                client, JUDGE_MODEL,
                [{"role": "system", "content": JUDGE_SYSTEM},
                 {"role": "user", "content": judge_user}],
                max_tokens=700, temperature=0.1, timeout=60, think=False)
        m = re.search(r"\{[\s\S]*\}", content)
        if not m:
            return {"error": "judge returned no JSON", "raw": content[:200]}
        v = json.loads(m.group(0))
        return {"turn_id": req.turn_id,
                "faithfulness": float(v.get("faithfulness") or 0.0),
                "answer_relevance": float(v.get("answer_relevance") or 0.0),
                "rationale": str(v.get("rationale") or "")[:800]}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


# --- reverse proxy: shell's read-only KB/Explorer/Document APIs -> noted ------
# A shared client with no timeout cap on reads (some KB endpoints stream).
_proxy_client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None))
_HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive",
               "transfer-encoding", "te", "trailer", "upgrade",
               "proxy-authorization", "proxy-authenticate"}


# --- MCP tool/skill host proxy (declared BEFORE the /api/* catch-all) --------
@app.api_route("/api/mcp/{path:path}",
               methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy_mcp(path: str, request: Request):
    """Forward Skills/Tools admin calls to mcp-service. This backend holds the
    admin bearer token (writes) so the browser never sees it, and pins the app
    scope to job2cool by default."""
    params = dict(request.query_params)
    params.setdefault("app", MCP_APP)
    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in _HOP_BY_HOP and k.lower() != "authorization"}
    if MCP_ADMIN_TOKEN:
        headers["Authorization"] = f"Bearer {MCP_ADMIN_TOKEN}"
    body = await request.body()
    req = _proxy_client.build_request(
        request.method, f"{MCP_SERVICE}/{path}", params=params,
        headers=headers, content=body, timeout=httpx.Timeout(95.0, read=95.0))
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
