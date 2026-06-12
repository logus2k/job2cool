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
import re
from typing import Any, AsyncIterator

import httpx

import buffers
import cache
import services

# Output caps — generous so long sections aren't truncated (model ctx 131072).
SECTION_MAX = 8192
INTRO_MAX = 4096
DPO_MAX = 1200
SUMMARY_MAX = 320


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


# --- evidence formatting -----------------------------------------------------
_CITATION_RULES = (
    "## Citation rule\n"
    "Each documentation chunk and excerpt below has a header line of the form "
    "`### [markdown_chunk:<hex>]  source: <path>`. The complete bracketed string "
    "is the only valid citation tag for that passage. Graph items use `[E:<id>]` "
    "(entity) and `[R:<src>><type>><target>]` (relationship) tags. Cite only the "
    "specific load-bearing claims that quote or paraphrase the evidence — most "
    "sentences need no tag. When you cite, copy the bracketed tag "
    "character-for-character, right after the sentence it supports. Never invent "
    "a tag.\n"
)


def _evidence_block(ev: dict, limit: int = 6) -> str:
    """Format vector chunks + graph entities/edges/excerpts into one evidence
    block for the composing LLM — cv's `_build_evidence` shape: tagged passages
    ([markdown_chunk:<hex>]), knowledge-graph entities ([E:<id>] label (type) —
    description) and relationships ([R:<src>><type>><tgt>]), then graph-grounded
    excerpts, behind a citation-rules preamble so the model is grounded in the
    graph structure and can cite it inline. Caches each chunk/excerpt so its
    [markdown_chunk:<hex>] tag resolves to the source PDF."""
    parts: list[str] = []

    chunks = ev.get("chunks") or []
    if chunks:
        parts.append("## Documentation chunks (most relevant passages)")
        for c in chunks[:limit]:
            hx = cache.put_chunk(c)
            tag = f"[markdown_chunk:{hx}]" if hx else "[markdown_chunk:?]"
            parts.append(f"### {tag}  source: {c.get('source_path') or ''}")
            if c.get("section_path"):
                parts.append(f"_section: {c['section_path']}_")
            parts.append((c.get("text") or "").strip())
            parts.append("")

    entities = ev.get("entities") or []
    edges = ev.get("edges") or []
    if entities or edges:
        parts.append("## Knowledge-graph context")
        for e in entities[:25]:
            label = e.get("label") or e.get("id")
            etype = e.get("type", "")
            desc = ((e.get("properties") or {}).get("description") or "").strip()
            line = f"- [E:{e.get('id')}] {label} ({etype})"
            if desc:
                line += f" — {desc}"
            parts.append(line)
        for ed in edges[:25]:
            parts.append(f"- [R:{ed.get('source')}>{ed.get('type')}>"
                         f"{ed.get('target')}]")
        parts.append("")

    excerpts = ev.get("excerpts") or []
    if excerpts:
        parts.append("## Graph-grounded excerpts")
        for x in excerpts[:8]:
            hx = cache.put_chunk(x)
            tag = f"[markdown_chunk:{hx}]" if hx else "[markdown_chunk:?]"
            parts.append(f"### {tag}")
            parts.append((x.get("text") or x.get("snippet") or "").strip())
            parts.append("")

    if not parts:
        return ""
    return _CITATION_RULES + "\n" + "\n".join(parts)


def _sources_footer(ev: dict) -> str:
    srcs = ev.get("sources") or []
    return ("\n\n_Sources: " + ", ".join(sorted(set(srcs))) + "_") if srcs else ""


def _cited_sources(ev: dict) -> str:
    """A clickable Sources line for a section: the section's graph excerpts as
    [markdown_chunk:hex] tags (resolvable to a PDF + bbox). Falls back to plain
    filenames when the section has no resolvable excerpts."""
    hexes: list[str] = []
    for x in (ev.get("excerpts") or [])[:4]:
        hx = cache.put_chunk(x)
        if hx and hx not in hexes:
            hexes.append(hx)
    if hexes:
        return "\n\n**Sources:** " + " ".join(f"[markdown_chunk:{h}]" for h in hexes)
    return _sources_footer(ev)


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

INTRO_SYSTEM = (
    "You are Diana, the HR Assistant. Given a plain-language hiring need, you "
    "assemble the requested hiring deliverables (job offer, technical interviews, "
    "onboarding plan, cultural & team fit) grounded in the company knowledge "
    "base, writing them into the open document. If the user asks who you are, say "
    "\"I'm Diana, your HR Assistant\".\n\n"
    "Every turn you do TWO things, in order: first reason privately inside ONE "
    "<think>...</think> block, then write a short visible reply.\n\n"
    "Thinking section format (applies ONLY to your internal reasoning block, NOT "
    "to the user-visible reply):\n"
    "- You think privately inside ONE <think>...</think> block per turn - never "
    "two consecutive think blocks.\n"
    "- INSIDE your reasoning block, structure your thoughts with first-level "
    "Markdown headings (# Title) marking each distinct phase. Two to five "
    "headings is typical; do not pad with extra phases. For a hiring request the "
    "phases are, for example: understanding the hiring need; the role and its "
    "seniority signals; which deliverables are being requested; how each "
    "requested deliverable should be shaped; and what company knowledge it "
    "should be grounded in.\n"
    "- Write the body of each phase as a few sentences of plain prose under its "
    "heading - reason concretely, do not just restate the headings.\n\n"
    "Visible reply (everything after </think>): 2-3 sentences that confirm the "
    "role you understood and say you are generating the requested documents now. "
    "Plain prose - no headings, no <think> tags, no <voice> tag.")

SECTION_SYSTEM = (
    "You are job2cool, an expert HR content writer. You write one section of a "
    "hiring package at a time, grounded in the provided company evidence. Be "
    "concrete, professional and concise.\n\n"
    "First reason privately inside ONE <think>...</think> block, then write the "
    "section. Thinking section format (applies ONLY to the <think> block, never "
    "to the written section):\n"
    "- Structure your reasoning with first-level Markdown headings (# Title) for "
    "each distinct phase. Two to five headings is typical; do not pad. Useful "
    "phases: what this section must cover; which pieces of the provided company "
    "evidence are relevant; where the evidence is thin or missing; how to "
    "structure the section.\n"
    "- Write the body of each phase as a few sentences of plain prose under its "
    "heading.\n\n"
    "After </think>, output the section as Markdown only - no <think> tags, no "
    "preamble.")


async def _requested_sections(client: httpx.AsyncClient, need: str) -> list[str]:
    """Which deliverables the request wants — classified by the LLM so phrasing
    like 'job description' maps to just the offer, while a generic hiring need or
    an explicit 'full package' maps to all four. Robust to substrings that broke
    the old keyword heuristic (e.g. 'full-stack'). Falls back to all on error."""
    keys = [s["key"] for s in SECTIONS]
    try:
        out = await services.llm_complete(
            client, services.GEMMA_MODEL,
            [{"role": "system", "content":
              "You classify a hiring request by which deliverables it asks for."},
             {"role": "user", "content":
              "Deliverables and their keywords:\n"
              "- offer: a job offer / job description / job posting\n"
              "- interview: technical interview questions or plan\n"
              "- onboarding: an onboarding plan (30-60-90)\n"
              "- culture: a cultural & team-fit assessment\n\n"
              "Which deliverable(s) does the request below ask for? If it asks "
              "for a full/complete hiring package, OR is a general hiring need "
              "that does not name a specific deliverable, answer exactly: all\n"
              "Otherwise answer ONLY the matching keyword(s), comma-separated "
              "(e.g. 'offer' or 'offer, interview'). No other words.\n\n"
              f"Request: {need}\n\nAnswer:"}],
            max_tokens=24, temperature=0.0, think=False, timeout=30)
        out = (out or "").strip().lower()
        if "all" in out:
            return keys
        hit = [k for k in keys if k in out]
        return hit or keys
    except Exception:
        return keys


async def _role_label(client: httpx.AsyncClient, need: str) -> str:
    """Return the job role title, or "" when the request (with conversation
    context already folded in) names NO concrete position — so the caller asks
    which role instead of inventing one."""
    try:
        lbl = await services.llm_complete(
            client, services.GEMMA_MODEL,
            [{"role": "user", "content":
              "Identify the job position in this hiring request. If a concrete "
              "role is named, reply with ONLY its title (2-5 words). If the "
              "request does NOT name a specific job position, reply with exactly: "
              f"NONE\n\nRequest: {need}"}],
            max_tokens=16, temperature=0.0, timeout=30, think=False)
        lbl = (lbl or "").strip().strip('"').splitlines()[0].strip()
        if not lbl or lbl.strip(" .!\"'").upper() == "NONE":
            return ""
        return lbl
    except Exception:
        return ""


def _strip_blocks(text: str) -> str:
    t = re.sub(r"<(think|voice)>[\s\S]*?</\1>", "", str(text or ""))
    t = re.sub(r"\[(markdown_chunk:[0-9a-f]+|E:[^\]]+|R:[^\]]+|C\d+)\]", "", t)
    return t.strip()


def _extract_think(text: str) -> str:
    """Pull the content of the (possibly truncated) <think>...</think> block out
    of a raw streamed reply — so the judge can be shown Diana's reasoning."""
    m = re.search(r"<think>([\s\S]*?)</think>", text or "")
    if m:
        return m.group(1).strip()
    m = re.search(r"<think>([\s\S]*)$", text or "")  # unclosed / truncated
    return m.group(1).strip() if m else ""


async def _resolve_need(client: httpx.AsyncClient, history: list[dict],
                        message: str) -> str:
    """Make the latest message self-contained using the conversation, so a
    follow-up like 'also find interview questions' inherits the role and skills
    from earlier turns. This is the context that cv keeps and job2cool was
    dropping. Falls back to the raw message."""
    turns = [h for h in (history or []) if isinstance(h, dict) and h.get("content")]
    if not turns:
        return message
    lines: list[str] = []
    for m in turns[-6:]:
        who = "User" if m.get("role") == "user" else "Diana"
        txt = _strip_blocks(m.get("content"))
        if txt:
            lines.append(f"{who}: {txt[:400]}")
    if not lines:
        return message
    convo = "\n".join(lines)
    try:
        out = await services.llm_complete(
            client, services.GEMMA_MODEL,
            [{"role": "system", "content":
              "You rewrite the user's latest message in an HR hiring chat into "
              "ONE self-contained request, resolving references to earlier turns "
              "(carry over the role title and its required skills)."},
             {"role": "user", "content":
              f"Conversation so far:\n{convo}\n\nLatest user message: {message}\n\n"
              "Rewrite the latest message as one self-contained sentence that "
              "includes the relevant role and skills from the conversation. "
              "Reply with ONLY the rewritten request."}],
            max_tokens=80, temperature=0.1, think=False, timeout=30)
        return (out or "").strip().strip('"') or message
    except Exception:
        return message


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
        # 0) Resolve the message against the conversation (memory/context) ---
        need = await _resolve_need(client, history, need)

        # 1) Role + domain + requested deliverables --------------------------
        role = await _role_label(client, need)
        if not role:
            # No identifiable position (in this message or the conversation) ->
            # ASK which role, do not invent one or generate anything.
            ask = ("Happy to help. Which job position are you hiring for? "
                   "Tell me the role and any key skills, and I'll prepare it.")
            yield _sse({"delta": ask})
            yield _sse({"delta": "\n\n<voice>Sure. Which job position are you "
                                 "hiring for? Tell me the role and I'll prepare "
                                 "it for you.</voice>"})
            yield _sse({"meta": {
                "turn_id": hashlib.sha1(need.encode()).hexdigest()[:12],
                "buffers": [], "deliverables": [], "role": "", "domain": "",
                "retrieved_chunks": 0, "retrieved_entities": 0,
                "retrieved_edges": 0, "avg_similarity": 0.0}})
            yield "data: [DONE]\n\n"
            return
        domain = await services.resolve_onboard_domain(client, need)
        domains = [domain]
        requested = await _requested_sections(client, need)
        secs = [_SECTION_BY_KEY[k] for k in requested]
        names = ", ".join(s["title"] for s in secs)
        offer_both = ("offer" in requested) and use_ma2 and use_gemma_offer

        # Buffers (= tabs) are created lazily, one per requested deliverable,
        # right before that deliverable generates — so tabs appear and focus
        # one-by-one as each answer is written.
        section_bufs: dict[str, Any] = {}

        # 2) Conversational intro (streamed; carries <think>) ----------------
        intro_parts: list[str] = []
        try:
            async for delta in services.llm_stream(
                    client, services.GEMMA_MODEL,
                    [{"role": "system", "content": INTRO_SYSTEM},
                     {"role": "user", "content":
                      f"{need}\n\n(You are generating ONLY these deliverables: "
                      f"{names}. Confirm exactly these in your reply — do not "
                      f"promise a full package unless all four are listed.)\n\n"
                      f"Do BOTH, in order: first reason inside a "
                      f"<think>...</think> block using 2-5 headed phases, then "
                      f"write your 2-3 sentence confirmation."}],
                    max_tokens=INTRO_MAX, temperature=0.5):
                intro_parts.append(delta)
                yield _sse({"delta": delta})
        except Exception:
            yield _sse({"delta": f"Building the {role} documents.\n"})
        # Diana's reasoning (the Thinking panel) + visible confirmation, kept for
        # the judge so it scores the whole turn, not just the chat summary.
        intro_raw = "".join(intro_parts)
        intro_thinking = _extract_think(intro_raw)
        intro_visible = _strip_blocks(intro_raw)

        # Brief spoken summary — the avatar speaks the <voice> only, not the
        # whole answer (cv pattern). Stripped from the visible text by cv-chat.
        if len(secs) == 1:
            voice = (f"Sure. I'm preparing the {secs[0]['title'].lower()} for a "
                     f"{role} now. I'll write it into the document for you.")
        else:
            voice = (f"Sure. I'm preparing the {role} hiring package now: {names}. "
                     f"I'll write it into the document for you.")
        yield _sse({"delta": f"\n\n<voice>{voice}</voice>"})

        yield _sse({"delta": f"\n\n_Role: **{role}** · grounding in `{domain}`._\n"
                             f"_Generating ({0}/{len(secs)})…_\n"})

        # 3) Generate requested deliverables ---------------------------------
        total_chunks = 0
        cited: list[dict] = []
        cited_excerpts: list[dict] = []
        agg_entities: dict[str, dict] = {}
        agg_edges: dict[tuple, dict] = {}
        evidence_all: list[str] = []
        doc_bodies: list[str] = []   # what Diana wrote to the workspace (for the judge)
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
                user_parts.append(
                    "Do BOTH, in order: first reason inside a <think>...</think> "
                    "block using 2-5 headed phases over the evidence, then write "
                    "the section as Markdown. After each sentence that uses the "
                    "evidence, append its exact citation tag verbatim — "
                    "[markdown_chunk:<hex>] for passages, [E:<id>] for graph "
                    "entities, [R:<...>] for relationships; never invent a tag.")
                section_md = await services.llm_complete(
                    client, services.GEMMA_MODEL,
                    [{"role": "system", "content": SECTION_SYSTEM},
                     {"role": "user", "content": "\n\n".join(user_parts)}],
                    max_tokens=SECTION_MAX, temperature=0.4, timeout=300)

            body = f"# {sec['title']}\n\n{section_md.strip()}{_cited_sources(ev)}"
            buffers.replace(buf.buffer_id, body)
            doc_bodies.append(body)
            yield _sse({"delta": f" ✓ _( {i}/{len(secs)} )_"})

        # 4) Closing chat note (grounding + gaps + nudge) + turn cache --------
        turn_id = hashlib.sha1((need + str(total_chunks)).encode()).hexdigest()[:12]
        remaining = [s["title"] for s in SECTIONS if s["key"] not in set(requested)]
        note = await _closing_note(client, role, need, names, domain,
                                   remaining, cited_excerpts or cited)
        yield _sse({"delta": "\n\n" + note})

        cache.put_turn(turn_id, question=need,
                       evidence="\n\n".join(evidence_all),
                       thinking=intro_thinking,
                       documents="\n\n---\n\n".join(doc_bodies),
                       answer=(intro_visible + "\n\n" + note).strip(),
                       entities=list(agg_entities.values()),
                       edges=list(agg_edges.values()),
                       domains=domains)

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


def _humanize_list(items: list[str]) -> str:
    """'a' -> 'a'; 'a','b' -> 'a or b'; 'a','b','c' -> 'a, b, or c'."""
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} or {items[1]}"
    return ", ".join(items[:-1]) + f", or {items[-1]}"


async def _closing_note(client: httpx.AsyncClient, role: str, need: str,
                        deliverables: str, domain: str, remaining: list[str],
                        chunks: list[dict]) -> str:
    """Diana's brief chat note AFTER the document(s) are written. It deliberately
    does NOT recap the document content (that lives in the mid pane). Instead:
    (1) confirm what landed in the workspace, (2) flag — grounded in the
    evidence — where the KB was thin so the user knows what to double-check, and
    (3) nudge the next deliverable. The genuinely useful, non-redundant part is
    the coverage/gap note."""
    are = "are" if "," in deliverables else "is"
    lead = (f"Done — the **{deliverables}** for a {role} {are} in your workspace"
            + (f", grounded in `{domain}`" if domain else "") + ".")

    # (2) Grounded coverage/gap note — the only LLM-generated part, so the gap is
    # real (from the evidence) and not invented.
    labeled: list[str] = []
    for c in chunks:
        txt = (c.get("text") or c.get("snippet") or "").strip()
        if txt:
            labeled.append(f"(source: {c.get('source_path')})\n{txt[:400]}")
        if len(labeled) >= 6:
            break
    gap = ""
    if labeled:
        try:
            gap = await services.llm_complete(
                client, services.GEMMA_MODEL,
                [{"role": "system", "content":
                  "You write ONE short sentence for an HR user about EVIDENCE "
                  "COVERAGE — what the company knowledge base did NOT cover well "
                  "for this hiring work, so the user knows what to double-check "
                  "in the document. Base it ONLY on the evidence provided; if "
                  "coverage looks complete, say so briefly. Do NOT recap the "
                  "document. Plain prose, exactly one sentence, no preamble."},
                 {"role": "user", "content":
                  f"Hiring work: {deliverables} for a {role}.\n"
                  f"Request: {need}\n\nEvidence:\n\n" + "\n\n".join(labeled)}],
                max_tokens=SUMMARY_MAX, temperature=0.3, timeout=120, think=False)
            gap = (gap or "").strip()
        except Exception:
            gap = ""

    # (3) Next-step nudge — accurate, built from deliverables NOT generated.
    nudge = ""
    human = _humanize_list([r.lower() for r in remaining])
    if human:
        nudge = f"Want me to prepare the {human} next?"

    return " ".join(p for p in (lead, gap, nudge) if p)
