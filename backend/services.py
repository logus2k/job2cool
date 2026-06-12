# job2cool/backend/services.py
"""
Thin async clients for the shared noted-network services job2cool orchestrates.

  - agent_server  : OpenAI-compatible chat (gemma-4 orchestrator + ma2 DPO),
                    both streaming and non-streaming.
  - noted-rag     : multi-domain vector retrieval (search_multi), preceded by an
                    LLM query-rewrite (the pattern cv uses: the reranker scores
                    focused content phrases far better than raw questions).
  - noted-graph   : per-domain graph retrieve (mode=local).

All calls fail soft where the orchestrator can degrade gracefully.
"""
from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator
from urllib.parse import quote

import httpx

AGENT_SERVER = os.getenv("AGENT_SERVER_URL", "http://agent_server:7701")
NOTED_RAG    = os.getenv("NOTED_RAG_URL",    "http://noted-rag:8200")
NOTED_GRAPH  = os.getenv("NOTED_GRAPH_URL",  "http://noted-graph:5523")

GEMMA_MODEL = os.getenv("JOB2COOL_GEMMA_MODEL", "gemma-4")
DPO_MODEL   = os.getenv("JOB2COOL_DPO_MODEL",   "ma2-360m-dpo-b01")
# Reuse cv's query-rewriter preset by default (it already exists on agent_server).
QUERY_REWRITER = os.getenv("JOB2COOL_QUERY_REWRITER", "cv_query_rewriter")


# --- LLM ---------------------------------------------------------------------
async def llm_complete(client: httpx.AsyncClient, model: str,
                       messages: list[dict], *, max_tokens: int = 1200,
                       temperature: float = 0.4, timeout: float = 180,
                       think: bool = True) -> str:
    """Non-streaming completion -> assistant content (reasoning stripped).
    Pass think=False for utility passes (classification, summaries) so the model
    doesn't spend its whole budget inside <think> and return empty content."""
    body: dict = {"model": model, "messages": messages, "stream": False,
                  "max_tokens": max_tokens, "temperature": temperature}
    if not think:
        body["chat_template_kwargs"] = {"enable_thinking": False}
    r = await client.post(
        f"{AGENT_SERVER}/v1/chat/completions", json=body, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    content = ((data.get("choices") or [{}])[0]
               .get("message", {}).get("content", "")) or ""
    return _strip_think(content)


async def llm_stream(client: httpx.AsyncClient, model: str,
                     messages: list[dict], *, max_tokens: int = 1200,
                     temperature: float = 0.4,
                     timeout: float = 240) -> AsyncIterator[str]:
    """Stream assistant content deltas (raw — includes any <think> blocks so the
    Assistant's Thinking panel can render them)."""
    async with client.stream(
        "POST", f"{AGENT_SERVER}/v1/chat/completions",
        json={"model": model, "messages": messages, "stream": True,
              "max_tokens": max_tokens, "temperature": temperature},
        timeout=timeout,
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line or not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                break
            try:
                obj = json.loads(payload)
                delta = obj["choices"][0]["delta"].get("content") or ""
            except Exception:
                delta = ""
            if delta:
                yield delta


def _strip_think(text: str) -> str:
    import re
    t = re.sub(r"<think>[\s\S]*?</think>\s*", "", text or "")
    t = re.sub(r"<think>[\s\S]*$", "", t)  # unclosed (truncated) think
    return t.strip()


# --- RAG: query rewrite + multi-domain vector + graph ------------------------
async def formulate_query(client: httpx.AsyncClient, text: str) -> str:
    """LLM-rewrite a need/section topic into a focused retrieval phrase
    (cv_query_rewriter). Fails soft to the raw text."""
    try:
        q = await llm_complete(client, QUERY_REWRITER,
                               [{"role": "user", "content": text}],
                               max_tokens=48, temperature=0.1, timeout=30,
                               think=False)
        q = (q or "").strip().strip('"').strip("'").splitlines()[0].strip()
        return q or text
    except Exception:
        return text


async def search_multi(client: httpx.AsyncClient, query: str,
                       domains: list[str], top_k: int = 6) -> list[dict]:
    """Multi-domain vector retrieval over `<domain>__corpus` collections."""
    collections = [f"{d}__corpus" for d in domains]
    try:
        r = await client.post(
            f"{NOTED_RAG}/search_multi",
            json={"query": query, "collections": collections, "top_k": top_k},
            timeout=40,
        )
        r.raise_for_status()
        return r.json().get("chunks") or []
    except Exception:
        return []


async def resolve_chunk_regions(client: httpx.AsyncClient, hx: str,
                                domains: list[str]) -> dict | None:
    """Resolve a [markdown_chunk:hex] to its PDF provenance (source_path +
    page_no + bbox + regions) via noted-graph's per-domain /chunk lookup —
    the data the viewer needs to open the PDF and draw the bbox highlight.
    Fans out across the turn's domains; first hit wins. None if unresolved
    (e.g. a dense-corpus-only chunk that noted-graph doesn't index)."""
    tag = f"markdown_chunk:{hx}"
    for d in domains:
        try:
            r = await client.get(
                f"{NOTED_GRAPH}/research/{d}/chunk/{quote(tag, safe=':')}",
                timeout=5)
            if r.status_code == 200:
                j = r.json() or {}
                j["domain_id"] = d
                return j
        except Exception:
            continue
    return None


async def graph_retrieve(client: httpx.AsyncClient, question: str,
                         domain: str) -> dict:
    """Per-domain knowledge-graph retrieval (mode=local). Fails soft to {}."""
    try:
        r = await client.post(
            f"{NOTED_GRAPH}/research/{domain}/retrieve",
            json={"question": question, "mode": "local"},
            timeout=40,
        )
        r.raise_for_status()
        return r.json() or {}
    except Exception:
        return {}


# --- role-aware onboarding-domain selection ----------------------------------
# The intended per-role onboarding family (the owner adds these over time).
ONBOARD_FAMILIES = [
    "devops", "architect", "backend", "data_eng", "embedded", "mobile",
    "frontend", "general", "ml_ai", "qa", "security",
]
_corpus_cache: dict[str, Any] = {"domains": None}


async def available_corpus_domains(client: httpx.AsyncClient) -> set[str]:
    """Domains that actually have a `<id>__corpus` collection in noted-rag
    (i.e. are retrievable). Cached for the process lifetime."""
    if _corpus_cache["domains"] is not None:
        return _corpus_cache["domains"]
    found: set[str] = set()
    try:
        r = await client.get(f"{NOTED_RAG}/collections", timeout=8)
        r.raise_for_status()
        for c in (r.json().get("collections") or []):
            name = c.get("name") or ""
            if name.endswith("__corpus"):
                found.add(name[: -len("__corpus")])
    except Exception:
        pass
    _corpus_cache["domains"] = found
    return found


async def classify_role_family(client: httpx.AsyncClient, need: str) -> str:
    """Pick the best-matching onboarding role family for a hiring need."""
    options = ", ".join(ONBOARD_FAMILIES)
    try:
        out = await llm_complete(
            client, GEMMA_MODEL,
            [{"role": "user", "content":
              f"Classify this hiring need into exactly ONE of these role "
              f"families: {options}. Reply with ONLY the keyword.\n\n{need}"}],
            max_tokens=8, temperature=0.0, timeout=30, think=False)
        word = "".join(ch for ch in (out or "").lower() if ch.isalnum() or ch == "_")
        for fam in ONBOARD_FAMILIES:
            if fam in word:
                return fam
    except Exception:
        pass
    return "general"


async def resolve_onboard_domain(client: httpx.AsyncClient, need: str) -> str:
    """Resolve a hiring need to an EXISTING onboarding domain: the role-matched
    `jobs_onboard_<family>` if present, else `jobs_onboard_general`, else any
    existing `jobs_onboard_*`, else the first configured fallback domain."""
    fam = await classify_role_family(client, need)
    avail = await available_corpus_domains(client)
    candidate = f"jobs_onboard_{fam}"
    if candidate in avail:
        return candidate
    if "jobs_onboard_general" in avail:
        return "jobs_onboard_general"
    onb = sorted(d for d in avail if d.startswith("jobs_onboard_"))
    if onb:
        return onb[0]
    return (avail and sorted(avail)[0]) or "jobs_onboard_devops"


async def graph_and_vector_search(client: httpx.AsyncClient, question: str,
                                  domains: list[str], top_k: int = 6) -> dict:
    """Aggregated retrieval — job2cool's replica of noted's `graph_and_vector_
    search` tool: vector (search_multi over all domains) AND per-domain graph
    retrieve, run concurrently and merged into one evidence set.

    Returns {chunks, entities, edges, excerpts, sources}. The vector query is
    LLM-rewritten first (focused phrase); the graph side uses the raw question
    (its entity-name search handles conversational phrasing) — same split cv
    uses, but aggregated into a single operation.
    """
    import asyncio

    search_query = await formulate_query(client, question)

    async def _vector() -> list[dict]:
        return await search_multi(client, search_query, domains, top_k=top_k)

    async def _graph(domain: str) -> dict:
        return await graph_retrieve(client, question, domain)

    results = await asyncio.gather(_vector(), *[_graph(d) for d in domains])
    chunks = results[0] or []
    graphs = results[1:]

    entities: dict[str, dict] = {}
    edges: dict[tuple, dict] = {}
    excerpts: list[dict] = []
    for g in graphs:
        for e in (g.get("entities") or []):
            eid = e.get("id")
            if eid and eid not in entities:
                entities[eid] = e
        for ed in (g.get("edges") or []):
            key = (ed.get("source"), ed.get("type"), ed.get("target"))
            if all(key) and key not in edges:
                edges[key] = ed
        excerpts.extend(g.get("chunk_excerpts") or [])

    sources = []
    seen_src = set()
    for c in chunks:
        sp = c.get("source_path")
        if sp and sp not in seen_src:
            seen_src.add(sp)
            sources.append(sp)

    return {
        "query": search_query,
        "chunks": chunks,
        "entities": list(entities.values()),
        "edges": list(edges.values()),
        "excerpts": excerpts,
        "sources": sources,
    }
