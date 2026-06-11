# job2cool/backend/buffers.py
"""
Live-document buffers — the editable Markdown doc the Assistant writes into.

Modeled on noted's `notes_buffer` + `doc_events` machinery (copied, simplified;
noted is never modified). An in-memory doc buffer is mutated by the doc-CRUD
tools (create/append/replace/read) and every change is fanned out to subscribers
over an SSE stream, which the (reused) noted frontend already listens to at
`/api/buffers/events/stream` and renders live in its DocumentViewer.

Single-process, in-memory — fine for one uvicorn worker; revisit if we scale out.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field


@dataclass
class DocBuffer:
    buffer_id: str
    name: str
    content: str = ""
    path: str | None = None


_buffers: dict[str, DocBuffer] = {}
_subscribers: set[asyncio.Queue] = set()


# --- pub/sub -----------------------------------------------------------------
def _doc_payload(buf: DocBuffer) -> dict:
    return {
        "type": "doc_changed",
        "doc": {
            "buffer_id": buf.buffer_id,
            "name": buf.name,
            "content": buf.content or "",
            "path": buf.path,
            "kind": "buffer",
        },
        "size": len(buf.content or ""),
        "ts": time.time(),
    }


def _fanout(buf: DocBuffer) -> None:
    payload = _doc_payload(buf)
    for q in list(_subscribers):
        try:
            q.put_nowait(payload)
        except Exception:
            pass


async def subscribe():
    """Async generator of doc events for one SSE client."""
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)
    try:
        while True:
            yield await q.get()
    finally:
        _subscribers.discard(q)


# --- CRUD --------------------------------------------------------------------
def create(name: str | None = None, initial_content: str = "") -> DocBuffer:
    bid = uuid.uuid4().hex[:12]
    buf = DocBuffer(buffer_id=bid, name=name or f"pack-{bid}.md",
                    content=initial_content or "")
    _buffers[bid] = buf
    _fanout(buf)
    return buf


def get(buffer_id: str) -> DocBuffer | None:
    return _buffers.get(buffer_id)


def append(buffer_id: str, content: str, separator: str = "\n\n") -> DocBuffer | None:
    buf = _buffers.get(buffer_id)
    if buf is None:
        return None
    buf.content = (buf.content + separator + content) if buf.content else content
    _fanout(buf)
    return buf


def replace(buffer_id: str, content: str) -> DocBuffer | None:
    buf = _buffers.get(buffer_id)
    if buf is None:
        return None
    buf.content = content
    _fanout(buf)
    return buf


def bind_path(buffer_id: str, path: str) -> DocBuffer | None:
    buf = _buffers.get(buffer_id)
    if buf is None:
        return None
    buf.path = path
    return buf
