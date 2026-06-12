# job2cool/backend/cache.py
"""
Per-process caches that back the Assistant's citation / graph / score features.

  - chunk cache: retrieved RAG chunks keyed by the citation hex (sha1(id)[:12]),
    so a clicked [markdown_chunk:<hex>] tag resolves to its source text/path.
  - turn cache:  per-turn (question, evidence, answer, graph) so /api/graph_trace
    and /api/score_answer can resolve a finished turn.

In-memory, FIFO-evicted, single-process — same posture as cv-backend.
"""
from __future__ import annotations

import hashlib

_CHUNK_MAX = 2048
_chunks: dict[str, dict] = {}

_TURN_MAX = 256
_turns: dict[str, dict] = {}
_last_turn_id: list[str | None] = [None]


def chunk_hex(chunk_id: str) -> str:
    """The hex used in the [markdown_chunk:<hex>] citation tag (cv convention)."""
    if not chunk_id:
        return ""
    if chunk_id.startswith("markdown_chunk:"):
        return chunk_id.split(":", 1)[1]
    return hashlib.sha1(chunk_id.encode("utf-8")).hexdigest()[:12]


def put_chunk(chunk: dict) -> str:
    """Cache a chunk; return its citation hex."""
    hx = chunk_hex(chunk.get("id") or "")
    if not hx:
        return ""
    _chunks[hx] = chunk
    if len(_chunks) > _CHUNK_MAX:
        for k in list(_chunks)[: len(_chunks) - _CHUNK_MAX]:
            _chunks.pop(k, None)
    return hx


def get_chunk(hx: str) -> dict | None:
    return _chunks.get(hx)


def put_turn(turn_id: str, **fields) -> None:
    _turns[turn_id] = fields
    _last_turn_id[0] = turn_id
    if len(_turns) > _TURN_MAX:
        for k in list(_turns)[: len(_turns) - _TURN_MAX]:
            _turns.pop(k, None)


def get_turn(turn_id: str) -> dict | None:
    return _turns.get(turn_id)


def last_turn() -> dict | None:
    tid = _last_turn_id[0]
    return _turns.get(tid) if tid else None
