# job2cool/backend/orchestrator.py
"""
The HR-pack orchestrator (S5).

A backend-sequenced pipeline (the v1 default for §6.D — reliable with small
models): from a plain-language hiring need it produces the four-artifact pack
— Job Offer, Technical Interviews, Onboarding Plan, Cultural & Team Fit — writing
each section LIVE into the editable document (via buffers) while narrating
progress to the Assistant chat in cv's SSE contract ({delta} + final {meta}).

Models: `ma2-360m-dpo-b01` drafts the raw offer; `gemma-4` refines, RAG-grounds,
and composes every section. Retrieval is the aggregated graph+vector search over
the active KB domains.

The agent prompts here are the v1 DEFAULTS (the owner may replace them later).
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any, AsyncIterator

import httpx

import buffers
import services

DOMAINS = [d.strip() for d in os.getenv(
    "JOB2COOL_DOMAINS",
    "jobs_onboard_devops,ai_and_jobs,prod_mng,sw_arch").split(",") if d.strip()]


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


# --- prompts (v1 defaults) ---------------------------------------------------
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
        "use_dpo": True,
    },
    {
        "key": "interview", "title": "Technical Interviews",
        "query": "technical interview questions evaluation criteria for {need}",
        "instruction": (
            "Write a **Technical Interview** plan for this role: 4-6 themed areas, "
            "each with 2-3 example questions and what a strong answer shows, plus "
            "a short scoring rubric. Ground it in the evidence where relevant. "
            "Markdown, level-3 headings (###). Do not repeat the section title."),
        "use_dpo": False,
    },
    {
        "key": "onboarding", "title": "Onboarding Plan",
        "query": "30 60 90 day onboarding plan for {need}",
        "instruction": (
            "Write a **30-60-90 day Onboarding Plan**: goals, activities and "
            "resources for each phase, grounded in the evidence. Markdown, "
            "level-3 headings (###). Do not repeat the section title."),
        "use_dpo": False,
    },
    {
        "key": "culture", "title": "Cultural & Team Fit",
        "query": "team culture collaboration agile values for {need}",
        "instruction": (
            "Write a **Cultural & Team Fit** assessment framework: the cultural "
            "signals to look for, example behavioural questions, and a short "
            "evaluation guide, grounded in the evidence. Markdown, level-3 "
            "headings (###). Do not repeat the section title."),
        "use_dpo": False,
    },
]

INTRO_SYSTEM = (
    "You are job2cool, an HR hiring assistant. Given a plain-language hiring "
    "need, you assemble a complete hiring package (job offer, technical "
    "interviews, onboarding plan, cultural & team fit) grounded in the company "
    "knowledge base, writing it into the open document. Reply in 2-3 sentences: "
    "confirm the role you understood and say you're generating the package now. "
    "Think briefly first inside <think>...</think>.")

SECTION_SYSTEM = (
    "You are job2cool, an expert HR content writer. You write one section of a "
    "hiring package at a time, grounded in the provided company evidence. Be "
    "concrete, professional and concise. Output Markdown only.")


async def _role_label(client: httpx.AsyncClient, need: str) -> str:
    try:
        lbl = await services.llm_complete(
            client, services.GEMMA_MODEL,
            [{"role": "user", "content":
              f"In 2-5 words, name the job role in this hiring need. Reply with "
              f"ONLY the role title, nothing else:\n\n{need}"}],
            max_tokens=16, temperature=0.1, timeout=30)
        lbl = (lbl or "").strip().strip('"').splitlines()[0].strip()
        return lbl or "New Role"
    except Exception:
        return "New Role"


async def run_chat(message: str, history: list[dict]) -> AsyncIterator[str]:
    """Yield cv-contract SSE for one HR-pack turn."""
    need = (message or "").strip()
    if not need:
        yield _sse({"delta": "Tell me the hiring need and I'll build the pack."})
        yield "data: [DONE]\n\n"
        return

    async with httpx.AsyncClient() as client:
        # 1) Title + role-aware onboarding domain + live document ------------
        role = await _role_label(client, need)
        domain = await services.resolve_onboard_domain(client, need)
        domains = [domain]
        # One buffer (= one mosaic panel) per deliverable; created up front as
        # placeholders so the mosaic lays out immediately, then filled in.
        section_bufs = {
            sec["key"]: buffers.create(
                name=sec["title"],
                initial_content=f"# {sec['title']}\n\n_Pending…_")
            for sec in SECTIONS
        }

        # 2) Conversational intro (streamed; carries <think> for the panel) ---
        intro_msgs = [{"role": "system", "content": INTRO_SYSTEM},
                      {"role": "user", "content": need}]
        try:
            async for delta in services.llm_stream(
                    client, services.GEMMA_MODEL, intro_msgs,
                    max_tokens=400, temperature=0.5):
                yield _sse({"delta": delta})
        except Exception:
            yield _sse({"delta": f"Building the hiring package for **{role}**.\n"})

        yield _sse({"delta": f"\n\n_Role: **{role}** · grounding onboarding in "
                             f"`{domain}`._\n"})
        yield _sse({"delta": "\n_Generating the hiring package "
                             f"(0/{len(SECTIONS)})…_\n"})

        # 3) Section pipeline -> live doc ------------------------------------
        total_chunks = 0
        for i, sec in enumerate(SECTIONS, start=1):
            yield _sse({"delta": f"\n▸ **{sec['title']}** — researching…"})
            query = sec["query"].format(need=need)
            ev = await services.graph_and_vector_search(
                client, query, domains, top_k=6)
            total_chunks += len(ev.get("chunks") or [])
            evidence = _evidence_block(ev)

            draft = ""
            if sec.get("use_dpo"):
                try:
                    draft = await services.llm_complete(
                        client, services.DPO_MODEL,
                        [{"role": "user", "content": need}],
                        max_tokens=600, temperature=0.3, timeout=120)
                except Exception:
                    draft = ""

            user_parts = [f"Hiring need: {need}", f"Role: {role}"]
            if draft:
                user_parts.append(f"DRAFT (from the offer model, refine this):\n{draft}")
            if evidence:
                user_parts.append(f"Company evidence:\n{evidence}")
            user_parts.append(sec["instruction"])
            section_md = await services.llm_complete(
                client, services.GEMMA_MODEL,
                [{"role": "system", "content": SECTION_SYSTEM},
                 {"role": "user", "content": "\n\n".join(user_parts)}],
                max_tokens=1400, temperature=0.4, timeout=200)

            body = f"# {sec['title']}\n\n{section_md.strip()}{_sources_footer(ev)}"
            buffers.replace(section_bufs[sec["key"]].buffer_id, body)
            yield _sse({"delta": f" ✓ added to the document  "
                                 f"_( {i}/{len(SECTIONS)} )_"})

        # 4) Close out --------------------------------------------------------
        turn_id = hashlib.sha1(need.encode()).hexdigest()[:12]
        yield _sse({"delta": "\n\n✅ **Hiring package complete.** All four "
                             "documents are in your workspace — review, edit, "
                             "or ask me to adjust any section."})
        yield _sse({"meta": {"turn_id": turn_id,
                             "buffers": [b.buffer_id for b in section_bufs.values()],
                             "role": role,
                             "domain": domain,
                             "retrieved_chunks": total_chunks,
                             "retrieved_entities": 0,
                             "retrieved_edges": 0,
                             "avg_similarity": 0.0}})
        yield "data: [DONE]\n\n"
