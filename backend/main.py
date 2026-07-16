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
import socketio
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import buffers
import cache
import health_monitor
import orchestrator
import services
import socketio_relay

# Judge with gemma-4 + explicit JSON (the cv_rag_judge preset's grammar 400s here).
# Empty => use whatever model is ACTIVE in agent_server (resolved at call time).
# Set JOB2COOL_JUDGE only to pin the judge to a specific model.
JUDGE_MODEL = os.getenv("JOB2COOL_JUDGE", "")
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
NOTED_BACKEND = os.getenv("NOTED_BACKEND_URL", "http://noted:8123")
# Shared MCP tool/skill host. The frontend Skills/Tools admin UI talks to it
# through this backend (which holds the admin token so the browser never does).
MCP_SERVICE     = os.getenv("MCP_SERVICE_URL", "http://mcp-service:8080").rstrip("/")
MCP_ADMIN_TOKEN = os.getenv("MCP_ADMIN_TOKEN", "")
MCP_APP         = os.getenv("MCP_APP", "job2cool")

# The chat model is whatever is ACTIVE in agent_server (resolved via
# services.active_model); job2cool no longer pins a model id. DPO is its own.
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
                       "score_answer", "buffers", "job2cool", "agents", "mcp")


@app.on_event("startup")
async def _seed_job2cool_agents():
    """Seed the editable job2cool_* agent presets from the inline defaults
    (idempotent; never overwrites user edits). Lets the Agents UI manage Diana's
    templates while keeping the constants as fallback."""
    async with httpx.AsyncClient() as client:
        await services.ensure_agent_preset(client, "job2cool_orchestrator", orchestrator.INTRO_SYSTEM)
        await services.ensure_agent_preset(client, "job2cool_composer", orchestrator.SECTION_SYSTEM)
        await services.ensure_agent_preset(client, "job2cool_judge", JUDGE_SYSTEM)
        await services.ensure_agent_preset(client, "job2cool_router", orchestrator.ROUTER_SYSTEM)
        await services.ensure_agent_preset(client, "job2cool_converse", orchestrator.CONVERSE_SYSTEM)


@app.on_event("startup")
async def _start_socketio_relay():
    """Connect the upstream Socket.IO client to the graph engine so KB build
    progress streams to the browser (relayed by socketio_relay.sio)."""
    await socketio_relay.start()


@app.on_event("startup")
async def _start_health_monitor():
    """Start the watcher-gated dependency-health heartbeat (pushed to the Help &
    Support page over Socket.IO; probes only while a browser is watching)."""
    await health_monitor.start()


# --- health / connectivity ---------------------------------------------------
async def _probe(client: httpx.AsyncClient, name: str, url: str) -> dict:
    try:
        r = await client.get(url, timeout=5)
        return {"service": name, "url": url, "ok": 200 <= r.status_code < 300,
                "status": r.status_code}
    except Exception as e:
        return {"service": name, "url": url, "ok": False,
                "error": f"{type(e).__name__}: {e}"}


@app.get("/api/health")
async def health():
    checks = [
        ("agent_server",      f"{AGENT_SERVER}/v1/models"),
        ("graph_server",      f"{services.ARCADEDB_URL}/api/v1/ready"),
        ("embeddings_server", f"{services.EMBED_URL}/health"),
    ]
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*(_probe(client, n, u) for n, u in checks))
        try:
            active = await services.active_model(client)
        except Exception:
            active = "(unresolved)"
    deps_ok = all(r["ok"] for r in results)
    return JSONResponse({
        "status": "ok" if deps_ok else "degraded",
        "service": "job2cool-backend",
        "models": {"gemma": active, "dpo": DPO_MODEL},
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
    except Exception:  # noqa: BLE001
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


def _user_email(request: Request) -> str:
    return (request.headers.get("X-Forwarded-Email") or "").strip().lower()


def _user_key(request: Request) -> str:
    email = _user_email(request)
    return re.sub(r"[^a-z0-9._-]", "_", email) if email else "anon"


def _chat_user_dir(request: Request) -> str:
    d = os.path.join(_CHATS_DIR, _user_key(request))
    os.makedirs(d, exist_ok=True)
    return d


def _shared_dir() -> str:
    """Shared projects live here (visible to every authenticated user), each
    tagged with its `owner_key`. Private projects stay in the per-user dir."""
    d = os.path.join(_CHATS_DIR, "_shared")
    os.makedirs(d, exist_ok=True)
    return d


class ChatThreadIn(BaseModel):
    title: str = ""        # project name (user-given at creation)
    description: str = ""   # optional project description
    visibility: str = "private"   # "private" (owner only) | "shared" (all users)
    role: str = ""         # detected hiring role (workspace bar + default name)
    messages: list = []
    documents: dict = {}   # workspace doc snapshot {order:[], content:{}}
    panels: list = []      # per-assistant-turn {thinking, trace, score} for replay


def _list_entry(rec: dict, fn: str, is_owner: bool) -> dict:
    return {"thread_id": rec.get("thread_id") or fn[:-5],
            "title": rec.get("title") or "Untitled",
            "description": rec.get("description") or "",
            "visibility": rec.get("visibility") or "private",
            "owner": rec.get("owner") or "",
            "is_owner": is_owner,
            "role": rec.get("role") or "",
            "updated_at": rec.get("updated_at") or 0,
            "message_count": len(rec.get("messages") or [])}


@app.get("/api/job2cool/chats")
async def chats_list(request: Request):
    me = _user_key(request)
    out = []
    # My private projects (existing per-user files default to private).
    md = _chat_user_dir(request)
    for fn in os.listdir(md):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(md, fn)) as f:
                out.append(_list_entry(json.load(f), fn, True))
        except Exception:  # noqa: BLE001
            continue
    # Shared projects (visible to everyone); is_owner gates edit/delete.
    sd = _shared_dir()
    for fn in os.listdir(sd):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(sd, fn)) as f:
                rec = json.load(f)
            out.append(_list_entry(rec, fn, rec.get("owner_key") == me))
        except Exception:  # noqa: BLE001
            continue
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return JSONResponse({"chats": out})


def _find_project(tid: str, request: Request):
    """Return (path, record, is_owner) for tid from the user's private dir or the
    shared dir; (None, None, False) if not found / not visible to this user."""
    me = _user_key(request)
    priv = os.path.join(_chat_user_dir(request), tid + ".json")
    if os.path.isfile(priv):
        try:
            return priv, json.load(open(priv)), True
        except Exception:  # noqa: BLE001
            return priv, {}, True
    shar = os.path.join(_shared_dir(), tid + ".json")
    if os.path.isfile(shar):
        try:
            rec = json.load(open(shar))
        except Exception:  # noqa: BLE001
            rec = {}
        return shar, rec, (rec.get("owner_key") == me)
    return None, None, False


@app.get("/api/job2cool/chats/{tid}")
async def chats_get(tid: str, request: Request):
    if not _TID_RE.match(tid):
        return JSONResponse({"error": "bad id"}, status_code=400)
    path, rec, is_owner = _find_project(tid, request)
    if not path:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({**rec, "is_owner": is_owner})


@app.put("/api/job2cool/chats/{tid}")
async def chats_put(tid: str, body: ChatThreadIn, request: Request):
    if not _TID_RE.match(tid):
        return JSONResponse({"error": "bad id"}, status_code=400)
    me = _user_key(request)
    priv_p = os.path.join(_chat_user_dir(request), tid + ".json")
    shar_p = os.path.join(_shared_dir(), tid + ".json")
    shared = (body.visibility or "private").lower() == "shared"
    existing = None
    for pth in (priv_p, shar_p):
        if os.path.isfile(pth):
            try:
                existing = json.load(open(pth))
            except Exception:  # noqa: BLE001
                existing = {}
            break
    # Can't edit a shared project owned by someone else.
    if existing and existing.get("visibility") == "shared" \
            and existing.get("owner_key") and existing.get("owner_key") != me:
        return JSONResponse({"error": "forbidden — owned by another user"}, status_code=403)
    now = time.time()
    rec = {"thread_id": tid, "title": (body.title or "Untitled")[:120],
           "description": (body.description or "")[:500],
           "visibility": "shared" if shared else "private",
           "owner": (existing or {}).get("owner") or _user_email(request),
           "owner_key": (existing or {}).get("owner_key") or me,
           "role": (body.role or "")[:120],
           "created_at": (existing or {}).get("created_at") or now,
           "updated_at": now, "messages": body.messages,
           "documents": body.documents or {}, "panels": body.panels or []}
    target = shar_p if shared else priv_p
    tmp = target + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, target)
    # Visibility changed → remove the copy in the other location.
    other = priv_p if shared else shar_p
    if other != target and os.path.isfile(other):
        try:
            os.remove(other)
        except OSError:
            pass
    return JSONResponse({"ok": True, "thread_id": tid, "updated_at": now,
                         "visibility": rec["visibility"]})


class ChatRenameIn(BaseModel):
    title: str = ""
    description: str | None = None


@app.patch("/api/job2cool/chats/{tid}")
async def chats_rename(tid: str, body: ChatRenameIn, request: Request):
    if not _TID_RE.match(tid):
        return JSONResponse({"error": "bad id"}, status_code=400)
    path, rec, is_owner = _find_project(tid, request)
    if not path:
        return JSONResponse({"error": "not found"}, status_code=404)
    if not is_owner:
        return JSONResponse({"error": "forbidden — only the owner can edit"}, status_code=403)
    rec["title"] = (body.title or rec.get("title") or "Untitled")[:120]
    if body.description is not None:
        rec["description"] = (body.description or "")[:500]
    rec["updated_at"] = time.time()
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, path)
    return JSONResponse({"ok": True, "title": rec["title"]})


@app.delete("/api/job2cool/chats/{tid}")
async def chats_delete(tid: str, request: Request):
    if not _TID_RE.match(tid):
        return JSONResponse({"error": "bad id"}, status_code=400)
    path, rec, is_owner = _find_project(tid, request)
    if not path:
        return JSONResponse({"deleted": False}, status_code=404)
    if not is_owner:
        return JSONResponse({"error": "forbidden — only the owner can delete"}, status_code=403)
    os.remove(path)
    return JSONResponse({"deleted": True})


# --- Company Profile (one shared record: logo + header/footer for exports) ----
# A single company-wide record reused by every generated document at export time
# (the browser print path injects it as a repeating page header/footer). Readable
# by any authenticated user; editable by an admin allowlist (JOB2COOL_ADMIN_EMAILS,
# comma-separated) — if that env is unset, any authenticated user may edit.
_PROFILE_PATH = os.path.join(JOB2COOL_DATA_DIR, "company_profile.json")
_ADMIN_EMAILS = {e for e in re.split(r"[,\s]+",
                 os.getenv("JOB2COOL_ADMIN_EMAILS", "").lower()) if e}
_DEFAULT_PROFILE = {"logo": "", "header": "", "footer": ""}
# Cap the embedded logo: it is inlined as a data-URI into every printed page, so
# keep it small. ~2.7M base64 chars ≈ 2MB decoded.
_LOGO_MAX = 2_700_000


def _is_company_admin(request: Request) -> bool:
    email = _user_email(request)
    if not email:
        return False
    return (not _ADMIN_EMAILS) or (email in _ADMIN_EMAILS)


def _load_profile() -> dict:
    try:
        rec = json.load(open(_PROFILE_PATH))
        return {**_DEFAULT_PROFILE, **(rec if isinstance(rec, dict) else {})}
    except Exception:  # noqa: BLE001 — missing/corrupt → defaults
        return dict(_DEFAULT_PROFILE)


class CompanyProfileIn(BaseModel):
    logo: str = ""      # data-URI (data:image/*;base64,...) or ""
    header: str = ""
    footer: str = ""


@app.get("/api/job2cool/company-profile")
async def company_profile_get(request: Request):
    rec = _load_profile()
    return JSONResponse({**rec, "can_edit": _is_company_admin(request)},
                        headers={"Cache-Control": "no-store"})


@app.put("/api/job2cool/company-profile")
async def company_profile_put(body: CompanyProfileIn, request: Request):
    if not _is_company_admin(request):
        return JSONResponse(
            {"error": "forbidden — only an administrator can edit the company profile"},
            status_code=403)
    logo = (body.logo or "").strip()
    if logo and not re.match(r"^data:image/[a-z.+-]+;base64,", logo, re.I):
        return JSONResponse({"error": "logo must be an image data-URI"}, status_code=400)
    if len(logo) > _LOGO_MAX:
        return JSONResponse({"error": "logo image too large (max ~2MB)"}, status_code=400)
    rec = {"logo": logo,
           "header": (body.header or "")[:500],
           "footer": (body.footer or "")[:500],
           "updated_by": _user_email(request), "updated_at": time.time()}
    os.makedirs(JOB2COOL_DATA_DIR, exist_ok=True)
    tmp = _PROFILE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, _PROFILE_PATH)
    return JSONResponse({"ok": True})


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
        # Replay current buffers so a page refresh restores the workspace.
        for ev in buffers.snapshot():
            yield f"data: {json.dumps(ev)}\n\n"
        async for ev in buffers.subscribe():
            yield f"data: {json.dumps(ev)}\n\n"
    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/buffers/clear")
async def buffers_clear():
    """Reset the workspace documents (called when the user starts a New Chat)."""
    buffers.clear()
    return JSONResponse({"ok": True})


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
    memo = cache.get_cite(hx)
    if memo is not None:
        return JSONResponse(memo)
    cached = cache.get_chunk(hx) or {}

    turn = cache.last_turn() or {}
    domains = turn.get("domains") or JOB2COOL_DOMAINS
    region_hit = None
    async with httpx.AsyncClient() as client:
        region_hit = await services.resolve_chunk_regions(client, hx, domains)
        # Dense-corpus chunks use a different id scheme than the graph, so they
        # miss the hex lookup. Cross-walk by content to recover PDF regions so
        # the citation opens the PDF instead of showing text only.
        if (not region_hit or not region_hit.get("regions")) \
                and cached.get("source_path") and cached.get("text"):
            cw = await services.resolve_chunk_via_content(client, cached, domains)
            if cw:
                region_hit = cw

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
    payload = {
        "kind": "chunk", "title": "Source passage", "fields": fields,
        "body": body, "section_path": section,
        "source_path": src, "domain_id": domain_id,
        "page_no": (regions[0].get("page_no") if regions else None),
        "regions": regions,
    }
    # Memoize resolved citations that found a PDF region so a repeat click is
    # instant (skips the graph lookup + content cross-walk).
    if regions:
        cache.put_cite(hx, payload)
    return JSONResponse(payload)


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
                client, JUDGE_MODEL or await services.active_model(client),
                [{"role": "system", "content": await services.get_agent_prompt(
                    client, "job2cool_judge", JUDGE_SYSTEM)},
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


# --- Candidates browser (owned: /api/job2cool/candidates) --------------------
# Read-only list/detail over the ingested candidate-CV corpus
# (jobs_candidates__corpus). Browse pages via noted-rag /list_records; free-text
# search via noted-rag /search (semantic), enriched with full metadata by id.
CANDIDATES_COLLECTION = os.getenv("CANDIDATES_COLLECTION", "jobs_candidates__corpus")


def _cand_card(rec: dict) -> dict:
    m = rec.get("metadata") or {}
    text = rec.get("text") or ""
    return {
        "id": rec.get("id"),
        "candidate_id": m.get("id") or "",
        "position": m.get("position") or "",
        "primary_keyword": m.get("primary_keyword") or "",
        "english_level": m.get("english_level") or "",
        "experience_years": m.get("experience_years"),
        "snippet": text[:240],
    }


@app.get("/api/job2cool/candidates")
async def candidates_list(offset: int = 0, limit: int = 30, q: str = "",
                          primary_keyword: str = "", english_level: str = "",
                          min_experience: int = -1):
    """List candidate CVs. With `q`: semantic search (rerank floor disabled so
    nearest matches always surface). Without `q`: paginated browse + optional
    metadata filters (primary_keyword / english_level / min_experience)."""
    limit = max(1, min(limit, 100))
    q = (q or "").strip()

    if q:
        try:
            v = await services._embed_dense(_proxy_client, q)
            rows = await services._arcade(_proxy_client, services.CANDIDATES_DB,
                "SELECT chunk_id AS id, text, metadata_json FROM "
                "(SELECT expand(vector.neighbors('Chunk[embedding]', :v, :k)))",
                {"v": v, "k": 60})
            res = await services._rerank_results(_proxy_client, q,
                                                 [x.get("text") or "" for x in rows])
            ranked = sorted(res, key=lambda x: -float(x["relevance_score"]))
        except Exception as e:  # noqa: BLE001
            return {"mode": "search", "total": 0, "items": [], "error": str(e)}
        items = []
        for x in ranked[:limit]:
            i = int(x.get("index", 0))
            if not (0 <= i < len(rows)):
                continue
            row = rows[i]
            try:
                m = json.loads(row.get("metadata_json") or "{}")
            except Exception:
                m = {}
            card = _cand_card({"id": row.get("id"), "metadata": m, "text": row.get("text") or ""})
            card["score"] = round(services._sigmoid(float(x.get("relevance_score") or 0.0)), 4)
            items.append(card)
        return {"mode": "search", "total": len(items), "items": items}

    conds, params = [], {}
    if primary_keyword:
        conds.append("primary_keyword = :pk"); params["pk"] = primary_keyword
    if english_level:
        conds.append("english_level = :el"); params["el"] = english_level
    if min_experience >= 0:
        conds.append("experience_years >= :me"); params["me"] = min_experience
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    try:
        tot = await services._arcade(_proxy_client, services.CANDIDATES_DB,
                                     f"SELECT count(*) AS n FROM Chunk{where}", params)
        total = tot[0]["n"] if tot else 0
        rows = await services._arcade(_proxy_client, services.CANDIDATES_DB,
            f"SELECT chunk_id AS id, text, metadata_json FROM Chunk{where} "
            "ORDER BY chunk_id SKIP :off LIMIT :lim",
            {**params, "off": offset, "lim": limit})
    except Exception as e:  # noqa: BLE001
        return {"mode": "browse", "total": 0, "items": [], "error": str(e)}
    items = []
    for row in rows:
        try:
            m = json.loads(row.get("metadata_json") or "{}")
        except Exception:
            m = {}
        items.append(_cand_card({"id": row.get("id"), "metadata": m, "text": row.get("text") or ""}))
    return {"mode": "browse", "total": total,
            "offset": offset, "limit": limit, "items": items}


@app.get("/api/job2cool/candidates/{cid}")
async def candidate_detail(cid: str):
    """Full detail for one candidate: structured fields + the whole CV text."""
    try:
        rows = await services._arcade(_proxy_client, services.CANDIDATES_DB,
            "SELECT chunk_id AS id, text, metadata_json FROM Chunk "
            "WHERE chunk_id = :id LIMIT 1", {"id": cid})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"upstream: {e}")
    if not rows:
        raise HTTPException(status_code=404, detail="candidate not found")
    try:
        m = json.loads(rows[0].get("metadata_json") or "{}")
    except Exception:
        m = {}
    return {
        "id": rows[0].get("id"),
        "candidate_id": m.get("id") or "",
        "position": m.get("position") or "",
        "primary_keyword": m.get("primary_keyword") or "",
        "english_level": m.get("english_level") or "",
        "experience_years": m.get("experience_years"),
        "cv_chars": m.get("cv_chars"),
        "cv": rows[0].get("text") or "",
    }


# --- reverse proxy: shell's read-only KB/Explorer/Document APIs -> noted ------
# A shared client with no timeout cap on reads (some KB endpoints stream).
_proxy_client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None))
_HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive",
               "transfer-encoding", "te", "trailer", "upgrade",
               "proxy-authorization", "proxy-authenticate"}


# --- agent_server preset admin proxy (declared BEFORE the /api/* catch-all) --
@app.api_route("/api/agents/{path:path}",
               methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy_agents(path: str, request: Request):
    """Forward the Agents view to agent_server's preset admin API
    (/admin/api/agents). The view filters to job2cool_* presets."""
    url = f"{AGENT_SERVER}/admin/api/agents" + (f"/{path}" if path else "")
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


# Wrap the FastAPI app so uvicorn serves both the REST/SSE API and the Socket.IO
# relay (KB build progress) on the same port. The container CMD runs
# `main:asgi_app`. /socket.io is handled by Socket.IO; everything else by FastAPI.
asgi_app = socketio.ASGIApp(socketio_relay.sio, other_asgi_app=app, socketio_path="socket.io")
