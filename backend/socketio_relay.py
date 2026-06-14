"""Socket.IO relay: graph-engine build progress -> job2cool browser.

job2cool-backend runs its OWN Socket.IO server (the KB UI connects here) plus a
Socket.IO *client* to the graph engine (noted-graph). When a browser joins a
domain's room, we make sure our upstream client is subscribed to the same domain
on the graph; the graph's ``kb:progress`` events are then re-emitted to the
browser room. Event-driven end-to-end — no polling.

Frontend: ``io(origin, {path: '<base>/socket.io'})`` -> ``emit('join',
{domain_id})`` -> receives ``kb:progress`` ``{domain_id, progress:{...}}``.
"""
from __future__ import annotations

import asyncio
import logging
import os

import socketio

logger = logging.getLogger("job2cool.socketio")

# The graph engine's Socket.IO endpoint. Direct (not via kb-service — the REST
# façade doesn't carry Socket.IO); job2cool-backend reaches it on noted-network.
GRAPH_SOCKET_URL = os.environ.get("GRAPH_SOCKET_URL", "http://noted-graph:5523")

# Server the browser connects to (mounted by main.py via socketio.ASGIApp).
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
# Client to the graph engine. reconnection=True handles drops after first connect.
_up = socketio.AsyncClient(reconnection=True, reconnection_attempts=0)
_joined: set[str] = set()   # domains our upstream client is subscribed to
_started = False


def _room(domain_id: str) -> str:
    return f"kb:{domain_id}"


# ---- browser-facing server ----
@sio.event
async def join(sid, data):
    """A browser subscribes to a domain's live progress. ``data={'domain_id'}``."""
    dom = data.get("domain_id") if isinstance(data, dict) else None
    if not dom:
        return {"error": "domain_id required"}
    await sio.enter_room(sid, _room(dom))
    if dom not in _joined:                 # first watcher of this domain
        _joined.add(dom)
        if _up.connected:
            try:
                await _up.emit("join", {"domain_id": dom})
            except Exception as exc:
                logger.debug("upstream join(%s) failed: %s", dom, exc)
    return {"joined": _room(dom)}


@sio.event
async def leave(sid, data):
    dom = data.get("domain_id") if isinstance(data, dict) else None
    if dom:
        await sio.leave_room(sid, _room(dom))
    return {"left": dom}


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
            except Exception as exc:
                logger.warning("graph socket connect failed (%s); retrying", exc)
                await asyncio.sleep(5)

    asyncio.create_task(_connect_loop())
