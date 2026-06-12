# job2cool/backend/orchestrator.py
"""
The HR-pack orchestrator.

From a plain-language hiring need it produces the requested deliverables — Job
Offer, Technical Interviews, Onboarding Plan, Cultural & Team Fit — writing each
LIVE into its own document (one buffer = one tab) while narrating progress to the
Assistant chat in cv's SSE contract ({delta} + final {meta}).

Behaviour notes:
  * On-demand deliverables: a generic hiring need produces the FULL package; a
    request that names specific deliverable(s) produces only those (one tab each).
  * Job Offer: `ma2-360m-dpo-b01` drafts, `gemma-4` refines + RAG-grounds. When
    both are selected, BOTH versions are kept (a "Job Offer (MA2)" buffer holds
    the raw draft) so the UI can toggle between them.
  * Voice: a short <voice>…</voice> line is streamed so the avatar speaks a brief
    summary rather than the whole answer (the cv pattern).
  * Generous max_tokens so long sections aren't truncated (gemma ctx = 131072).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, AsyncIterator

import httpx

import buffers
import cache
import services

# Output caps — generous so long sections aren't truncated (model ctx 131072).
SECTION_MAX = 8192
INTRO_MAX = 1024
DPO_MAX = 1200
SUMMARY_MAX = 320


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


# --- evidence formatting -----------------------------------------------------
def _evidence_block(ev: dict, limit: int = 6) -> str:
    parts: list[str] = []
    for c in (ev.get("chunks") or [])[:limit]:
        src = c.get("source_path") or ""
        txt = (c.get("text") or "").strip()
        if txt:
            parts.append(f"[source: {src}]\n{txt}")
    for x in (ev.get("excerpts") or [])[:3]:
        txt = (x.get("text") or x.get("snippet") or "").strip()
        if txt:
            parts.append(f"[graph excerpt]\n{txt}")
    return "\n\n".join(parts)


def _sources_footer(ev: dict) -> str:
    srcs = ev.get("sources") or []
    return ("\n\n_Sources: " + ", ".join(sorted(set(srcs))) + "_") if srcs else ""


# --- deliverables ------------------------------------------------------------
SECTIONS = [
    {
        "key": "offer", "title": "Job Offer",
        "query": "{need} role responsibilities required skills",
        "instruction": (
            "Refine the DRAFT below into a polished, professional **Job Offer**. "
            "Keep these subsections: a one-paragraph Summary, Required Skills "
            "(bulleted), Responsibilities (bulleted), and a short 'What we offer' "
            "note. Fix any factual oddities from the draft, align it to the "
            "evidence, and keep it concise. Output Markdown, starting at level-3 "
            "headings (###). Do not repeat the section title."),
    },
    {
        "key": "interview", "title": "Technical Interviews",
        "query": "technical interview questions evaluation criteria for {need}",
        "instruction": (
            "Write a **Technical Interview** plan for this role: 4-6 themed areas, "
            "each with 2-3 example questions and what a strong answer shows, plus "
            "a short scoring rubric. Ground it in the evidence where relevant. "
            "Markdown, level-3 headings (###). Do not repeat the section title."),
    },
    {
        "key": "onboarding", "title": "Onboarding Plan",
        "query": "30 60 90 day onboarding plan for {need}",
        "instruction": (
            "Write a **30-60-90 day Onboarding Plan**: goals, activities and "
            "resources for each phase, grounded in the evidence. Markdown, "
            "level-3 headings (###). Do not repeat the section title."),
    },
    {
        "key": "culture", "title": "Cultural & Team Fit",
        "query": "team culture collaboration agile values for {need}",
        "instruction": (
            "Write a **Cultural & Team Fit** assessment framework: the cultural "
            "signals to look for, example behavioural questions, and a short "
            "evaluation guide, grounded in the evidence. Markdown, level-3 "
            "headings (###). Do not repeat the section title."),
    },
]
_SECTION_BY_KEY = {s["key"]: s for s in SECTIONS}

# Cues that scope a request to specific deliverable(s); otherwise full package.
_CUES = {
    "offer": ["job offer", "job description", "offer letter", "write an offer",
              "create a job", "draft an offer", " jd"],
    "interview": ["interview", "technical question", "screening question"],
    "onboarding": ["onboard", "30-60-90", "30/60/90", "ramp-up", "ramp up"],
    "culture": ["culture", "team fit", "cultural"],
}
_FULL_CUES = ["package", "full", "everything", "complete pack", "hiring pack",
              "whole", "all of", "entire"]

INTRO_SYSTEM = (
    "You are Diana, the HR Assistant. Given a plain-language hiring need, you "
    "assemble the requested hiring deliverables (job offer, technical interviews, "
    "onboarding plan, cultural & team fit) grounded in the company knowledge "
    "base, writing them into the open document. If the user asks who you are, say "
    "\"I'm Diana, your HR Assistant\". Reply in 2-3 sentences: confirm the role "
    "you understood and say you're generating the documents now. Think briefly "
    "first inside <think>...</think>.")

SECTION_SYSTEM = (
    "You are job2cool, an expert HR content writer. You write one section of a "
    "hiring package at a time, grounded in the provided company evidence. Be "
    "concrete, professional and concise. Output Markdown only.")


def _requested_sections(need: str) -> list[str]:
    """Which deliverables the request wants. A generic role need → full package;
    a request that names specific deliverable(s) → only those."""
    txt = " " + (need or "").lower() + " "
    if any(f in txt for f in _FULL_CUES):
        return [s["key"] for s in SECTIONS]
    hit = [k for k, cues in _CUES.items() if any(c in txt for c in cues)]
    if hit and len(hit) < len(SECTIONS):
        return [s["key"] for s in SECTIONS if s["key"] in hit]  # keep canonical order
    return [s["key"] for s in SECTIONS]


async def _role_label(client: httpx.AsyncClient, need: str) -> str:
    try:
        lbl = await services.llm_complete(
            client, services.GEMMA_MODEL,
            [{"role": "user", "content":
              f"In 2-5 words, name the job role in this hiring need. Reply with "
              f"ONLY the role title, nothing else:\n\n{need}"}],
            max_tokens=16, temperature=0.1, timeout=30, think=False)
        lbl = (lbl or "").strip().strip('"').splitlines()[0].strip()
        return lbl or "New Role"
    except Exception:
        return "New Role"


async def run_chat(message: str, history: list[dict],
                   config: dict | None = None) -> AsyncIterator[str]:
    """Yield cv-contract SSE for one HR-pack turn."""
    config = config or {}
    offer_sources = set(config.get("offer_sources") or ["ma2", "gemma", "rag"])
    use_ma2 = "ma2" in offer_sources
    use_gemma_offer = "gemma" in offer_sources
    use_rag_offer = "rag" in offer_sources
    need = (message or "").strip()
    if not need:
        yield _sse({"delta": "Tell me the hiring need and I'll build the pack."})
        yield "data: [DONE]\n\n"
        return

    async with httpx.AsyncClient() as client:
        # 1) Role + domain + requested deliverables --------------------------
        role = await _role_label(client, need)
        domain = await services.resolve_onboard_domain(client, need)
        domains = [domain]
        requested = _requested_sections(need)
        secs = [_SECTION_BY_KEY[k] for k in requested]
        offer_both = ("offer" in requested) and use_ma2 and use_gemma_offer

        # Buffers (= tabs) are created lazily, one per requested deliverable,
        # right before that deliverable generates — so tabs appear and focus
        # one-by-one as each answer is written.
        section_bufs: dict[str, Any] = {}

        # 2) Conversational intro (streamed; carries <think>) ----------------
        try:
            async for delta in services.llm_stream(
                    client, services.GEMMA_MODEL,
                    [{"role": "system", "content": INTRO_SYSTEM},
                     {"role": "user", "content": need}],
                    max_tokens=INTRO_MAX, temperature=0.5):
                yield _sse({"delta": delta})
        except Exception:
            yield _sse({"delta": f"Building the {role} documents.\n"})

        # Brief spoken summary — the avatar speaks the <voice> only, not the
        # whole answer (cv pattern). Stripped from the visible text by cv-chat.
        names = ", ".join(s["title"] for s in secs)
        what = "package" if len(secs) > 1 else secs[0]["title"].lower()
        yield _sse({"delta":
            f"\n\n<voice>Sure. I'm preparing the {role} {what} now — {names}. "
            f"I'll write it into the document for you.</voice>"})

        yield _sse({"delta": f"\n\n_Role: **{role}** · grounding in `{domain}`._\n"
                             f"_Generating ({0}/{len(secs)})…_\n"})

        # 3) Generate requested deliverables ---------------------------------
        total_chunks = 0
        cited: list[dict] = []
        cited_excerpts: list[dict] = []
        agg_entities: dict[str, dict] = {}
        agg_edges: dict[tuple, dict] = {}
        evidence_all: list[str] = []
        for i, sec in enumerate(secs, start=1):
            # Create this deliverable's tab now (opens + focuses in the UI).
            buf = buffers.create(name=sec["title"],
                                 initial_content=f"# {sec['title']}\n\n_Generating…_")
            section_bufs[sec["key"]] = buf
            yield _sse({"delta": f"\n▸ **{sec['title']}** — researching…"})
            query = sec["query"].format(need=need)
            ev = await services.graph_and_vector_search(
                client, query, domains, top_k=6)
            total_chunks += len(ev.get("chunks") or [])
            evidence = _evidence_block(ev)

            for c in (ev.get("chunks") or []):
                cache.put_chunk(c)
            cited.extend((ev.get("chunks") or [])[:2])
            for x in (ev.get("excerpts") or []):
                cache.put_chunk(x)
            cited_excerpts.extend((ev.get("excerpts") or [])[:2])
            for e in (ev.get("entities") or []):
                if e.get("id"):
                    agg_entities.setdefault(e["id"], e)
            for ed in (ev.get("edges") or []):
                k = (ed.get("source"), ed.get("type"), ed.get("target"))
                if all(k):
                    agg_edges.setdefault(k, ed)
            if evidence:
                evidence_all.append(evidence)

            is_offer = sec["key"] == "offer"

            # MA2 (DPO) draft — offer only, only if selected.
            draft = ""
            if is_offer and use_ma2:
                try:
                    draft = await services.llm_complete(
                        client, services.DPO_MODEL,
                        [{"role": "user", "content": need}],
                        max_tokens=DPO_MAX, temperature=0.3, timeout=120)
                except Exception:
                    draft = ""
            # When both MA2 and gemma are selected, keep the raw MA2 draft in its
            # own buffer so the Job Offer tab can toggle between the two versions.
            if is_offer and offer_both and draft:
                buffers.create(name="Job Offer (MA2)",
                               initial_content=f"# Job Offer (MA2)\n\n{draft.strip()}")

            gemma_composes = (not is_offer) or use_gemma_offer
            include_evidence = bool(evidence) and (not is_offer or use_rag_offer)

            if is_offer and not gemma_composes and draft:
                section_md = draft  # MA2-authoritative
            else:
                user_parts = [f"Hiring need: {need}", f"Role: {role}"]
                if draft:
                    user_parts.append(
                        "DRAFT (from the offer model, refine this):\n" + draft)
                if include_evidence:
                    user_parts.append("Company evidence:\n" + evidence)
                user_parts.append(sec["instruction"])
                section_md = await services.llm_complete(
                    client, services.GEMMA_MODEL,
                    [{"role": "system", "content": SECTION_SYSTEM},
                     {"role": "user", "content": "\n\n".join(user_parts)}],
                    max_tokens=SECTION_MAX, temperature=0.4, timeout=300)

            body = f"# {sec['title']}\n\n{section_md.strip()}{_sources_footer(ev)}"
            buffers.replace(buf.buffer_id, body)
            yield _sse({"delta": f" ✓ _( {i}/{len(secs)} )_"})

        # 4) Grounded, cited summary + turn cache ----------------------------
        turn_id = hashlib.sha1((need + str(total_chunks)).encode()).hexdigest()[:12]
        summary = await _cited_summary(client, role, cited_excerpts or cited)
        yield _sse({"delta": "\n\n" + summary})

        cache.put_turn(turn_id, question=need,
                       evidence="\n\n".join(evidence_all),
                       answer=summary,
                       entities=list(agg_entities.values()),
                       edges=list(agg_edges.values()),
                       domains=domains)

        yield _sse({"delta": "\n\n✅ **Done.** "
                             + ("All documents are" if len(secs) > 1
                                else "The document is")
                             + " in your workspace — review, edit, or ask me to "
                               "adjust any section."})
        yield _sse({"meta": {"turn_id": turn_id,
                             "buffers": [b.buffer_id for b in section_bufs.values()],
                             "deliverables": [s["title"] for s in secs],
                             "offer_ma2": bool(offer_both),
                             "role": role, "domain": domain,
                             "retrieved_chunks": total_chunks,
                             "retrieved_entities": len(agg_entities),
                             "retrieved_edges": len(agg_edges),
                             "avg_similarity": 0.0}})
        yield "data: [DONE]\n\n"


async def _cited_summary(client: httpx.AsyncClient, role: str,
                         chunks: list[dict]) -> str:
    """A 2-3 sentence grounded summary that cites sources with the
    [markdown_chunk:<hex>] tags the chat renders as clickable badges."""
    seen: list[str] = []
    labeled: list[str] = []
    for c in chunks:
        hx = cache.put_chunk(c)
        if not hx or hx in seen:
            continue
        seen.append(hx)
        labeled.append(f"(source: {c.get('source_path')})\n"
                       f"{(c.get('text') or c.get('snippet') or '')[:400]}")
        if len(labeled) >= 6:
            break
    if not labeled:
        return ("This was generated from the role description; the knowledge "
                "base returned no grounding passages for it.")
    ev = "\n\n".join(labeled)
    try:
        summary = await services.llm_complete(
            client, services.GEMMA_MODEL,
            [{"role": "system", "content":
              "You write a concise 2-3 sentence grounded summary. Plain prose, "
              "no preamble, no headings."},
             {"role": "user", "content":
              f"In 2-3 sentences, summarize how the company knowledge base "
              f"informed this {role} hiring work.\n\nEvidence:\n\n{ev}"}],
            max_tokens=SUMMARY_MAX, temperature=0.3, timeout=120, think=False)
    except Exception:
        summary = ""
    if not summary.strip():
        summary = f"This {role} work draws on the company knowledge base."
    tags = " ".join(f"[markdown_chunk:{hx}]" for hx in seen)
    return f"{summary.strip()}\n\n**Sources:** {tags}"
