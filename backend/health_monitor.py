"""Live dependency-health monitor → job2cool browser over Socket.IO.

job2cool-backend already runs a Socket.IO server (``socketio_relay.sio``) for KB
build-progress. This module adds a second channel on the SAME server that pushes
the health of job2cool's request-path dependencies to the Help & Support page.

Design (matches the project's event-driven rule):
  * The BROWSER never polls. It subscribes once (``health:subscribe``) and then
    only listens for ``health:status`` pushes. A CSS-animation watchdog on the
    client decays the "live feed" badge green→yellow→orange→red if pushes stop —
    no client-side timer.
  * The SERVER is the event source. A single asyncio loop probes the containers
    and emits a snapshot every ``HEALTH_PROBE_INTERVAL`` seconds — but ONLY while
    at least one browser is in the ``health`` room (watcher-gated; nobody looking
    ⇒ no probing). This periodic probe is server-side liveness detection, the
    only way to notice a container going down — distinct from browser polling.

Status per container:
  * connection error / timeout            → "down"     (red)
  * HTTP 5xx                              → "degraded" (orange)
  * any other HTTP response (<500, incl. 2xx/204/404) → "ok" (green, liveness)

Targets are the REAL containers (hardcoded internal names) — note these differ
from the functional env vars: e.g. NOTED_RAG_URL points at the kb-service façade,
but here we want the noted-rag container itself. websearch_server is excluded:
it lives on mcp_internal only and is unreachable from job2cool-backend (probing
it via mcp-service is a future enhancement).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

import httpx

import socketio_relay  # reuse the already-mounted Socket.IO server

sio = socketio_relay.sio
logger = logging.getLogger("job2cool.health")
logger.setLevel(logging.INFO)
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    logger.addHandler(_h)
    logger.propagate = False

HEALTH_ROOM = "health"
INTERVAL = float(os.getenv("HEALTH_PROBE_INTERVAL", "10"))  # seconds between heartbeats

# websearch_server is mcp_internal-only (unreachable from here), so we observe it
# THROUGH mcp-service's /backends/health passthrough.
MCP_SERVICE = os.getenv("MCP_SERVICE_URL", "http://mcp-service:8080").rstrip("/")

# (container_id, probe_url) — container_id matches architecture.js NODE ids.
TARGETS: list[tuple[str, str]] = [
    ("agent_server",   os.getenv("HM_AGENT_URL",    "http://agent_server:7701/v1/models")),
    ("kb-service",     os.getenv("HM_KB_URL",       "http://kb-service:8080/health")),
    ("mcp-service",    os.getenv("HM_MCP_URL",      "http://mcp-service:8080/health")),
    ("noted-tools",    os.getenv("HM_TOOLS_URL",    "http://noted-tools:7702/health")),
    ("noted-rag",      os.getenv("HM_RAG_URL",      "http://noted-rag:8200/health")),
    ("noted-graph",    os.getenv("HM_GRAPH_URL",    "http://noted-graph:5523/health")),
    ("noted",          os.getenv("HM_NOTED_URL",    "http://noted:8123/api/domains")),
    ("llama-vision",   os.getenv("HM_LLAMA_URL",    "http://llama-vision:8500/health")),
    ("noted-arcadedb", os.getenv("HM_ARCADE_URL",   "http://noted-arcadedb:2480/api/v1/ready")),
    ("stt_server",     os.getenv("HM_STT_URL",      "http://stt_server:2700/health")),
    ("tts_server",     os.getenv("HM_TTS_URL",      "http://tts_server:7700/health")),
    ("avatar_server",  os.getenv("HM_AVATAR_URL",   "http://avatar_server:7800/")),
]

_snapshot: dict = {"ts": 0, "statuses": {}}
_client: httpx.AsyncClient | None = None
_started = False


def _classify(status_code: int | None) -> str:
    if status_code is None:
        return "down"
    if status_code >= 500:
        return "degraded"
    return "ok"


async def _probe_one(client: httpx.AsyncClient, cid: str, url: str) -> tuple[str, str]:
    try:
        r = await client.get(url, timeout=5)
        return cid, _classify(r.status_code)
    except Exception:  # noqa: BLE001 — any connect/timeout error means unreachable
        return cid, "down"


async def _probe_websearch_via_mcp(client: httpx.AsyncClient) -> str:
    """websearch_server isn't directly reachable; ask mcp-service to report it.
    If mcp-service itself can't be reached, we can't tell → 'down' (the only path
    to websearch is gone)."""
    try:
        r = await client.get(f"{MCP_SERVICE}/backends/health", timeout=5)
        if r.status_code == 200:
            return (r.json().get("backends") or {}).get("websearch_server", "down")
    except Exception:  # noqa: BLE001
        pass
    return "down"


async def probe_all() -> dict[str, str]:
    global _client
    if _client is None:
        _client = httpx.AsyncClient()
    pairs = await asyncio.gather(*(_probe_one(_client, c, u) for c, u in TARGETS))
    statuses = {c: s for c, s in pairs}
    statuses["websearch_server"] = await _probe_websearch_via_mcp(_client)
    return statuses


def _watchers() -> int:
    """How many browsers are subscribed to the health room (auto-decrements on
    disconnect, since Socket.IO removes dropped sids from rooms)."""
    try:
        return sum(1 for _ in sio.manager.get_participants("/", HEALTH_ROOM))
    except Exception:  # noqa: BLE001 — API shape fallback: assume someone's there
        return 1


async def _enter(sid: str, room: str) -> None:
    res = sio.enter_room(sid, room)
    if asyncio.iscoroutine(res):
        await res


async def _leave(sid: str, room: str) -> None:
    res = sio.leave_room(sid, room)
    if asyncio.iscoroutine(res):
        await res


def _payload() -> dict:
    return {"ts": _snapshot["ts"], "interval": INTERVAL, "statuses": _snapshot["statuses"]}


async def _refresh_and_emit() -> None:
    _snapshot["statuses"] = await probe_all()
    _snapshot["ts"] = int(time.time() * 1000)
    await sio.emit("health:status", _payload(), room=HEALTH_ROOM)


# ---- browser-facing events ----
async def _on_subscribe(sid, data=None):
    """A browser opens Help & Support. Join the room, send the cached snapshot
    immediately (instant paint), then kick a fresh probe for everyone."""
    await _enter(sid, HEALTH_ROOM)
    if _snapshot["statuses"]:
        await sio.emit("health:status", _payload(), room=sid)
    await _refresh_and_emit()
    return {"subscribed": True, "interval": INTERVAL}


async def _on_unsubscribe(sid, data=None):
    await _leave(sid, HEALTH_ROOM)
    return {"unsubscribed": True}


sio.on("health:subscribe", _on_subscribe)
sio.on("health:unsubscribe", _on_unsubscribe)


async def start() -> None:
    """Start the watcher-gated heartbeat loop. Idempotent."""
    global _started
    if _started:
        return
    _started = True

    async def _loop():
        while True:
            try:
                if _watchers() > 0:
                    await _refresh_and_emit()
            except Exception as exc:  # noqa: BLE001 — never let the loop die
                logger.warning("health probe tick failed: %s", exc)
            await asyncio.sleep(INTERVAL)

    asyncio.create_task(_loop())
    logger.info("health monitor started (interval=%ss, %d targets)", INTERVAL, len(TARGETS))
