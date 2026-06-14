"""Socket.IO relay: graph-engine build progress -> job2cool browser.

job2cool-backend runs its OWN Socket.IO server (the KB UI connects here) plus a
Socket.IO *client* to the graph engine (noted-graph). When a browser joins a
domain's room, we make sure our upstream client is subscribed to the same domain
on the graph; the graph's ``kb:progress`` events are then re-emitted to the
browser room. Event-driven end-to-end — no polling.

Upstream subscriptions are reference-counted: the relay joins a graph room when
the FIRST browser watches a domain and leaves it when the LAST one stops (or
disconnects), so we don't accumulate dead subscriptions.

Frontend: ``io(origin, {path: '<base>/socket.io'})`` -> ``emit('join',
{domain_id})`` -> receives ``kb:progress`` ``{domain_id, progress:{...}}``.
"""
from __future__ import annotations

import asyncio
import logging
import os

import socketio

# Give the relay its own stdout handler: uvicorn configures its own loggers but
# not the root logger, so app-logger records were being swallowed. With this,
# upstream connect/reconnect/subscription lines show up in `docker logs`.
logger = logging.getLogger("job2cool.socketio")
logger.setLevel(logging.INFO)
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    logger.addHandler(_h)
    logger.propagate = False

# The graph engine's Socket.IO endpoint. Direct (not via kb-service — the REST
# façade doesn't carry Socket.IO); job2cool-backend reaches it on noted-network.
GRAPH_SOCKET_URL = os.environ.get("GRAPH_SOCKET_URL", "http://noted-graph:5523")

# Server the browser connects to (mounted by main.py via socketio.ASGIApp).
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
# Client to the graph engine. reconnection=True handles drops after first connect.
_up = socketio.AsyncClient(reconnection=True, reconnection_attempts=0)

_watchers: dict[str, int] = {}        # domain_id -> number of browser clients watching
_sid_rooms: dict[str, set[str]] = {}  # browser sid -> domains it joined
_joined: set[str] = set()             # domains our upstream client is subscribed to
_started = False


def _room(domain_id: str) -> str:
    return f"kb:{domain_id}"


async def _enter(sid: str, room: str) -> None:
    res = sio.enter_room(sid, room)
    if asyncio.iscoroutine(res):
        await res


async def _leave_sio(sid: str, room: str) -> None:
    res = sio.leave_room(sid, room)
    if asyncio.iscoroutine(res):
        await res


async def _release(sid: str, dom: str) -> None:
    """Drop one watcher of `dom`; unsubscribe upstream when it hits zero."""
    await _leave_sio(sid, _room(dom))
    rooms = _sid_rooms.get(sid)
    if rooms:
        rooms.discard(dom)
    n = _watchers.get(dom, 0) - 1
    if n > 0:
        _watchers[dom] = n
        return
    _watchers.pop(dom, None)
    if dom in _joined:
        _joined.discard(dom)
        if _up.connected:
            try:
                await _up.emit("leave", {"domain_id": dom})
                logger.info("upstream unsubscribed %s (no more watchers)", dom)
            except Exception as exc:
                logger.debug("upstream leave(%s) failed: %s", dom, exc)


# ---- browser-facing server ----
@sio.event
async def join(sid, data):
    """A browser subscribes to a domain's live progress. ``data={'domain_id'}``."""
    dom = data.get("domain_id") if isinstance(data, dict) else None
    if not dom:
        return {"error": "domain_id required"}
    await _enter(sid, _room(dom))
    _sid_rooms.setdefault(sid, set()).add(dom)
    _watchers[dom] = _watchers.get(dom, 0) + 1
    if dom not in _joined:                 # first watcher of this domain
        _joined.add(dom)
        if _up.connected:
            try:
                await _up.emit("join", {"domain_id": dom})
                logger.info("upstream subscribed %s (first watcher)", dom)
            except Exception as exc:
                logger.debug("upstream join(%s) failed: %s", dom, exc)
    return {"joined": _room(dom)}


@sio.event
async def leave(sid, data):
    dom = data.get("domain_id") if isinstance(data, dict) else None
    if dom:
        await _release(sid, dom)
    return {"left": dom}


@sio.event
async def disconnect(sid):
    for dom in list(_sid_rooms.get(sid, ())):
        await _release(sid, dom)
    _sid_rooms.pop(sid, None)


# ---- upstream graph client ----
@_up.on("kb:progress")
async def _relay(data):
    dom = data.get("domain_id") if isinstance(data, dict) else None
    if dom:
        await sio.emit("kb:progress", data, room=_room(dom))


@_up.event
async def connect():
    logger.info("graph socket connected; re-subscribing %d room(s)", len(_joined))
    for dom in list(_joined):              # re-subscribe after (re)connect
        try:
            await _up.emit("join", {"domain_id": dom})
        except Exception as exc:
            logger.debug("re-join(%s) failed: %s", dom, exc)


@_up.event
async def disconnect():
    logger.warning("graph socket disconnected; will auto-reconnect")


async def start():
    """Connect the upstream client (with connect-time retry; reconnection after
    that is handled by python-socketio). Idempotent."""
    global _started
    if _started:
        return
    _started = True

    async def _connect_loop():
        # Connection establishment only — NOT state polling. Once connected,
        # python-socketio's own reconnection keeps it alive.
        while not _up.connected:
            try:
                await _up.connect(GRAPH_SOCKET_URL, socketio_path="socket.io",
                                  transports=["websocket", "polling"])
                logger.info("graph socket connected at %s", GRAPH_SOCKET_URL)
            except Exception as exc:
                logger.warning("graph socket connect failed (%s); retrying", exc)
                await asyncio.sleep(5)

    asyncio.create_task(_connect_loop())
