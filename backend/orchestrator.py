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
CONVERSE_MAX = 1500
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


def _grounding_prose(ev: dict) -> str:
    """Lean, prose-only grounding for the JUDGE — source passages + entity
    descriptions, without the citation tags/preamble or the terse entity/edge
    triple-lists that bloat the LLM-facing evidence block. A focused context the
    small judge model can actually verify claims against."""
    parts: list[str] = []
    for c in (ev.get("chunks") or [])[:6]:
        t = (c.get("text") or "").strip()
        if t:
            parts.append(f"[{c.get('source_path') or 'source'}] {t}")
    for x in (ev.get("excerpts") or [])[:8]:
        t = (x.get("text") or x.get("snippet") or "").strip()
        if t:
            parts.append(f"[excerpt] {t}")
    descs = []
    for e in (ev.get("entities") or [])[:25]:
        d = ((e.get("properties") or {}).get("description") or "").strip()
        if d:
            descs.append(f"- {e.get('label') or e.get('id')}: {d}")
    if descs:
        parts.append("Key concepts:\n" + "\n".join(descs))
    return "\n\n".join(parts)


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
            "The DRAFT below is the authoritative Job Offer from a specialist "
            "offer model — use it as your basis. Reproduce its content "
            "faithfully: keep its Summary, its Required Skills and "
            "Responsibilities (including the specific tools, frameworks and "
            "technologies it names) and its overall shape, even where the company "
            "evidence does not mention them. Use the company evidence in a "
            "supporting role only — to correct a clear factual error in the draft "
            "and to add any genuinely missing, relevant detail. Present the result "
            "as a polished, professional **Job Offer** with these subsections: a "
            "one-paragraph Summary, Required Skills (bulleted), Responsibilities "
            "(bulleted), and a short 'What we offer' note. Output Markdown "
            "starting at level-3 headings (###); do not repeat the section "
            "title."),
    },
    {
        "key": "interview", "title": "Technical Interviews",
        "query": "technical interview questions evaluation criteria model answers for {need}",
        "instruction": (
            "Write a **Technical Interview** guide for this role that a "
            "NON-TECHNICAL interviewer can run (e.g. a first-pass / triage "
            "screen). Include 6-9 questions grouped into themed areas, UNLESS "
            "the hiring need asks for a specific number of questions, in which "
            "case produce exactly that many. For EVERY "
            "question include, as labelled sub-points: **Question**; **Expected "
            "answer** — a concise model answer in plain language stating the key "
            "points a correct response must contain, so a non-technical "
            "interviewer can check the candidate against it; and **Look for / "
            "red flags** — what a strong answer sounds like versus a weak or "
            "incorrect one. End with a short scoring rubric. Ground it in the "
            "evidence where relevant. Markdown, level-3 (###) headings for the "
            "themed areas with a clear sub-structure per question; do not repeat "
            "the section title."),
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

# Candidates is a deliverable too, but it is MATCHED from the CV pool (vector +
# rerank) rather than composed from the knowledge base — so it lives outside
# SECTIONS and is handled by its own step, while still landing as one Workspace
# document (one tab), exactly like the four composed deliverables.
CANDIDATES_TITLE = "Candidates"


def _docs_map(snapshot) -> dict:
    """name -> content for the current workspace buffers (one entry per tab)."""
    out: dict = {}
    for ev in snapshot:
        d = ev.get("doc") or {}
        if d.get("name") and d.get("content"):
            out[d["name"]] = d["content"]
    return out


def _candidate_query(docs: dict, project_name: str, fallback: str):
    """Build the candidate-matching query + a human label for what we ranked
    against. Ranks against the open Job Offer (the job description, the richest
    signal) when one exists, else the role/title plus the request text."""
    jd = (docs.get("Job Offer") or docs.get("Job Offer (MA2)") or "").strip()
    if jd:
        return jd, "the open Job Offer"
    query = (fallback or "").strip()
    if project_name and project_name.lower() not in query.lower():
        query = f"{project_name}. {query}".strip()
    return (query or project_name), "the requested role"


_CV_BULLET = re.compile(r"^(\s*)[•‣◦●▪·–]\s+")
_CV_LISTITEM = re.compile(r"^\s*([-*]|\d+\.)\s+")


def _normalize_cv_md(text: str) -> str:
    """Make a raw CV render as Markdown: convert bullet glyphs (•, ‣, ◦, …) to '-',
    and insert a blank line before a list run so `marked` renders it as a real list
    (CVs often place bullets directly under an intro line with no blank line)."""
    out: list[str] = []
    for ln in (text or "").replace("\r\n", "\n").split("\n"):
        ln = _CV_BULLET.sub(r"\1- ", ln)
        if (_CV_LISTITEM.match(ln) and out and out[-1].strip()
                and not _CV_LISTITEM.match(out[-1])):
            out.append("")
        out.append(ln)
    return "\n".join(out)


def _candidates_doc_body(cands: list[dict], basis: str) -> str:
    """Render matched candidates as a Workspace-document body (Markdown, without
    the leading title — the caller prepends `# Candidates`)."""
    if not cands:
        return (f"_No matching candidates were found in our pool for {basis}._\n\n"
                "Try broadening the role or the key skills.")
    parts = [f"_Top {len(cands)} candidates from our internal pool of 210,000 CVs, "
             f"ranked against {basis}._", ""]
    for i, c in enumerate(cands, 1):
        title = c.get("position") or "(no title)"
        score = int(round((c.get("score") or 0.0) * 100))
        # Each candidate is one `### {i}. …` section — the Workspace splits on this
        # heading to render a sub-tab per candidate within the Candidates document.
        parts.append(f"### {i}. {title} — match {score}%")
        bits = []
        if c.get("primary_keyword"):
            bits.append(f"**Focus:** {c['primary_keyword']}")
        if c.get("experience_years") is not None:
            bits.append(f"**Experience:** {c['experience_years']} yrs")
        if c.get("english_level"):
            bits.append(f"**English:** {c['english_level']}")
        if bits:
            parts.append("  ·  ".join(bits))
        cv = _normalize_cv_md((c.get("cv") or c.get("snippet") or "").strip())
        if cv:
            parts.append("")
            parts.append("**CV**")
            parts.append("")
            parts.append(cv)
        parts.append("")
    return "\n".join(parts).strip()

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

# Editable in the Agents tab as the preset job2cool_router (seeded in main.py).
ROUTER_SYSTEM = (
    "You are the intent router of Diana, an HR hiring assistant. Read the user's "
    "LATEST message in context and output ONLY one of these labels:\n"
    "- GENERATE: asks to create / draft / produce a hiring document or the full "
    "package (job offer, technical interviews, onboarding plan, cultural & team "
    "fit), or confirms a prior offer to do so.\n"
    "- IMPROVE: asks to change, refine, shorten, expand, or fix an EXISTING "
    "document already in the workspace.\n"
    "- WEB_SEARCH: asks to look something up on the web or find current external "
    "information about a topic, company, salary, or technology.\n"
    "- CANDIDATES: asks to find, match, rank, or show candidates from the internal "
    "CV database for a role.\n"
    "- CHAT: anything else (greetings, questions, discussion, or just describing a "
    "role without asking for one of the actions above).\n"
    "Having an active project does NOT by itself mean GENERATE. Reply with ONLY "
    "the single label.")

# Editable in the Agents tab as the preset job2cool_converse (seeded in main.py).
CONVERSE_SYSTEM = (
    "You are Diana, a warm, knowledgeable HR Assistant having a normal "
    "conversation with a recruiter. Converse naturally: greet back, answer "
    "questions, discuss roles and hiring, give practical advice, and ask "
    "clarifying questions. If asked who you are, say \"I'm Diana, your HR "
    "Assistant\".\n\n"
    "This turn you are ONLY conversing. Do NOT write a job offer, technical "
    "interviews, an onboarding plan, a cultural-fit assessment, or any deliverable "
    "document, and do not output document sections. When it helps, briefly remind "
    "the recruiter you can prepare those documents, search the web, or find "
    "matching candidates when they ask.\n\n"
    "First reason privately inside ONE <think>...</think> block (two to four short "
    "headed phases), then write a brief, plain-prose reply (one to four "
    "sentences). Do not use em-dashes. No <voice> tag in your reply.")


async def _requested_sections(client: httpx.AsyncClient, need: str) -> list[str]:
    """Which deliverables the request wants — classified by the LLM so phrasing
    like 'job description' maps to just the offer, while a generic hiring need or
    an explicit 'full package' maps to all four. Robust to substrings that broke
    the old keyword heuristic (e.g. 'full-stack'). Falls back to all on error."""
    keys = [s["key"] for s in SECTIONS]
    full = keys + ["candidates"]
    try:
        out = await services.llm_complete(
            client, await services.active_model(client),
            [{"role": "system", "content":
              "You classify a hiring request by which deliverables it asks for."},
             {"role": "user", "content":
              "Deliverables and their keywords:\n"
              "- offer: a job offer / job description / job posting\n"
              "- interview: technical interview questions or plan\n"
              "- onboarding: an onboarding plan (30-60-90)\n"
              "- culture: a cultural & team-fit assessment\n"
              "- candidates: best-fit candidates matched from the CV database\n\n"
              "Which deliverable(s) does the request below ask for? If it asks "
              "for a full/complete hiring package, OR is a general hiring need "
              "that does not name a specific deliverable, answer exactly: all\n"
              "Otherwise answer ONLY the matching keyword(s), comma-separated "
              "(e.g. 'offer' or 'offer, candidates'). No other words.\n\n"
              f"Request: {need}\n\nAnswer:"}],
            max_tokens=24, temperature=0.0, think=False, timeout=30)
        out = (out or "").strip().lower()
        if "all" in out:
            return full
        hit = [k for k in keys if k in out]
        if "candidate" in out:
            hit.append("candidates")
        return hit or full
    except Exception:
        return full


# Labels that name NO concrete position — placeholders or generic fillers the
# composer would otherwise turn into a "[Role name]" stub. Treated as no role so
# Diana asks which position to hire for instead of generating a hollow offer.
_NON_ROLE = {
    "none", "n a", "na", "unknown", "tbd", "tba", "role", "the role", "a role",
    "new role", "open role", "this role", "that role", "some role", "any role",
    "position", "the position", "a position", "open position", "new position",
    "job", "the job", "a job", "role title", "job title", "title", "role name",
    "position name", "candidate", "new hire", "hire", "new employee", "employee",
    "someone", "somebody", "person", "various", "multiple", "general", "any",
}


def _is_placeholder_role(lbl: str) -> bool:
    """True when the label is empty, a bracketed placeholder (e.g. "[Role name]",
    "{role}", "<position>"), or a generic non-role filler — none of which is a
    concrete position to hire for."""
    s = (lbl or "").strip()
    if not s:
        return True
    if any(ch in s for ch in "[]{}<>"):
        return True
    norm = re.sub(r"[^a-z ]+", " ", s.lower()).strip()
    norm = re.sub(r"\s+", " ", norm)
    return norm in _NON_ROLE


async def _role_label(client: httpx.AsyncClient, need: str) -> str:
    """Return the job role title, or "" when the request (with conversation
    context already folded in) names NO concrete position — so the caller asks
    which role instead of inventing one."""
    try:
        lbl = await services.llm_complete(
            client, await services.active_model(client),
            [{"role": "user", "content":
              "Identify the job position in this hiring request. If a concrete "
              "role is named, reply with ONLY its title (2-5 words). If the "
              "request does NOT name a specific job position, reply with exactly: "
              f"NONE\n\nRequest: {need}"}],
            max_tokens=16, temperature=0.0, timeout=30, think=False)
        lbl = (lbl or "").strip().strip('"').splitlines()[0].strip()
        if _is_placeholder_role(lbl):
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
                        message: str, project_name: str = "") -> str:
    """Make the latest message self-contained using the conversation, so a
    follow-up like 'also find interview questions' inherits the role and skills
    from earlier turns. Falls back to the raw message.

    The project name is deliberately NOT asserted as "the target role" here: that
    primed a GENERIC project name (e.g. the default "New project") to be extracted
    as a concrete role, so Diana would generate a hollow "[Role name]" offer. The
    project name is instead judged directly by `_role_label(project_name)` in
    run_chat, which accepts it only when it is genuinely a job title."""
    turns = [h for h in (history or []) if isinstance(h, dict) and h.get("content")]
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
            client, await services.active_model(client),
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


def _empty_meta(message: str, prefix: str = "chat") -> str:
    """Meta event for a non-generating turn (no deliverables)."""
    return _sse({"meta": {
        "turn_id": hashlib.sha1((f"{prefix}:" + (message or "")).encode()).hexdigest()[:12],
        "buffers": [], "deliverables": [], "role": "", "domain": "",
        "retrieved_chunks": 0, "retrieved_entities": 0, "retrieved_edges": 0,
        "avg_similarity": 0.0}})


async def _route(client: httpx.AsyncClient, history: list[dict], message: str,
                 project_name: str = "") -> str:
    """Multi-intent router (the job2cool_router preset). Returns one of:
    generate | improve | web_search | match_candidates | converse. Fails soft to
    converse, so a classification error never auto-generates."""
    turns = [h for h in (history or []) if isinstance(h, dict) and h.get("content")]
    convo = "\n".join(
        f"{'User' if m.get('role') == 'user' else 'Diana'}: {_strip_blocks(m.get('content'))[:300]}"
        for m in turns[-6:] if _strip_blocks(m.get("content")))
    parts: list[str] = []
    if project_name:
        parts.append(f"(Active project / likely role: {project_name})")
    if convo:
        parts.append("Conversation so far:\n" + convo)
    parts.append("Latest user message: " + (message or ""))
    try:
        sys = await services.get_agent_prompt(client, "job2cool_router", ROUTER_SYSTEM)
        out = await services.llm_complete(
            client, await services.active_model(client),
            [{"role": "system", "content": sys},
             {"role": "user", "content": "\n\n".join(parts)}],
            max_tokens=4, temperature=0.0, think=False, timeout=30)
        lbl = (out or "").strip().upper()
    except Exception:
        return "converse"
    if lbl.startswith("GEN"):
        return "generate"
    if lbl.startswith("IMP"):
        return "improve"
    if lbl.startswith("WEB"):
        return "web_search"
    if lbl.startswith("CAND"):
        return "match_candidates"
    return "converse"


async def _converse(client: httpx.AsyncClient, message: str, history: list[dict],
                    project_name: str = "", user_name: str = "") -> AsyncIterator[str]:
    """Stream a conversational Diana reply (the job2cool_converse preset) — answers,
    discusses, asks clarifying questions — with NO document generation. Used when
    the turn is not a generation request."""
    turns = [h for h in (history or []) if isinstance(h, dict) and h.get("content")]
    convo_msgs: list[dict] = []
    for m in turns[-8:]:
        role = "user" if m.get("role") == "user" else "assistant"
        txt = _strip_blocks(m.get("content"))
        if txt:
            convo_msgs.append({"role": role, "content": txt[:600]})
    ctx: list[str] = []
    if user_name:
        ctx.append(f"You are talking with {user_name}.")
    if project_name:
        ctx.append(f"The active project is about hiring a {project_name}; keep it in "
                   f"mind, but only build a document if explicitly asked.")
    base = await services.get_agent_prompt(client, "job2cool_converse", CONVERSE_SYSTEM)
    sys = base + (("\n\n" + " ".join(ctx)) if ctx else "")
    msgs = [{"role": "system", "content": sys}] + convo_msgs + [{"role": "user", "content": message}]
    parts: list[str] = []
    try:
        async for delta in services.llm_stream(client, await services.active_model(client), msgs,
                                                max_tokens=CONVERSE_MAX, temperature=0.6):
            parts.append(delta)
            yield _sse({"delta": delta})
    except Exception:
        pass
    reply = _strip_blocks("".join(parts))
    if not reply:
        reply = "I'm here to help with your hiring. What would you like to talk through?"
        yield _sse({"delta": reply})
    voice = re.split(r"(?<=[.!?])\s", reply.strip())[0][:180] if reply.strip() else "I'm here to help."
    yield _sse({"delta": f"\n\n<voice>{voice}</voice>"})
    yield _empty_meta(message)


async def _improve(client: httpx.AsyncClient, message: str, history: list[dict],
                   project_name: str = "", user_name: str = "") -> AsyncIterator[str]:
    """Refine an EXISTING workspace document per the user's instruction, writing the
    revision back to its buffer (so the workspace updates live)."""
    docs = [(ev.get("doc") or {}) for ev in buffers.snapshot()]
    docs = [d for d in docs if d.get("name") and d.get("content")]
    # The "(MA2)" buffer is a behind-the-scenes A/B draft, not a primary document to
    # edit — hide it from improve unless the user explicitly names MA2, so "the job
    # offer" targets "Job Offer", not "Job Offer (MA2)".
    if "ma2" not in (message or "").lower():
        primary = [d for d in docs if "(ma2)" not in d["name"].lower()]
        if primary:
            docs = primary
    if not docs:
        msg = ("There isn't a document open to improve yet. Ask me to create a job "
               "offer, technical interviews, an onboarding plan, or a culture-fit "
               "assessment first, then I can refine it.")
        yield _sse({"delta": msg})
        yield _sse({"delta": f"\n\n<voice>{msg}</voice>"})
        yield _empty_meta(message, "improve")
        return
    if len(docs) == 1:
        target = docs[0]
    else:
        names = [d["name"] for d in docs]
        try:
            pick = await services.llm_complete(
                client, await services.active_model(client),
                [{"role": "user", "content":
                  f"Open documents: {', '.join(names)}.\nUser request: {message}\n"
                  f"Which ONE document should be edited? Reply with ONLY its exact "
                  f"name from the list."}],
                max_tokens=16, temperature=0.0, think=False, timeout=30)
            pick = (pick or "").strip().strip('"')
        except Exception:
            pick = ""
        target = next((d for d in docs if d["name"].lower() == pick.lower()), docs[0])
    sysp = await services.get_agent_prompt(client, "job2cool_composer", SECTION_SYSTEM)
    parts: list[str] = []
    try:
        async for delta in services.llm_stream(
                client, await services.active_model(client),
                [{"role": "system", "content": sysp},
                 {"role": "user", "content":
                  f"Revise the following {target['name']} exactly as the instruction "
                  f"asks. Keep the existing Markdown structure and any citation tags; "
                  f"change only what the instruction requires. Output ONLY the revised "
                  f"document.\n\nINSTRUCTION: {message}\n\nCURRENT {target['name']}:\n"
                  f"{target['content']}"}],
                max_tokens=SECTION_MAX, temperature=0.4, timeout=300):
            parts.append(delta)
    except Exception:
        pass
    revised = services._strip_think("".join(parts)).strip()
    if revised:
        buffers.replace(target["buffer_id"], revised)
        note = f"Done — I've updated the **{target['name']}** in your workspace."
    else:
        note = (f"I wasn't able to revise the {target['name']} just now. Could you "
                f"rephrase what you'd like changed?")
    yield _sse({"delta": note})
    yield _sse({"delta": f"\n\n<voice>I've updated the {target['name'].lower()} for you.</voice>"})
    yield _sse({"meta": {
        "turn_id": hashlib.sha1(("improve:" + (message or "")).encode()).hexdigest()[:12],
        "buffers": [], "deliverables": [target["name"]] if revised else [],
        "role": "", "domain": "", "retrieved_chunks": 0, "retrieved_entities": 0,
        "retrieved_edges": 0, "avg_similarity": 0.0}})


async def _web_search(client: httpx.AsyncClient, message: str, history: list[dict],
                      project_name: str = "", user_name: str = "") -> AsyncIterator[str]:
    """Answer using the shared web_search tool (mcp-service -> websearch_server)."""
    results = await services.web_search(client, (message or "").strip(), max_results=5)
    if not results:
        msg = ("I couldn't reach web search just now. Want me to try again, or help "
               "another way?")
        yield _sse({"delta": msg})
        yield _sse({"delta": f"\n\n<voice>{msg}</voice>"})
        yield _empty_meta(message, "web")
        return
    src = "\n".join(
        f"- {r.get('title', '')}: {r.get('snippet', '')} ({r.get('url', '')})"
        for r in results[:5])
    base = await services.get_agent_prompt(client, "job2cool_converse", CONVERSE_SYSTEM)
    sysp = (base + "\n\nAnswer the user's question using the web results below. Be "
            "concise and mention the key sources by name. Do not output a document.")
    parts: list[str] = []
    try:
        async for delta in services.llm_stream(
                client, await services.active_model(client),
                [{"role": "system", "content": sysp},
                 {"role": "user", "content": f"Question: {message}\n\nWeb results:\n{src}"}],
                max_tokens=CONVERSE_MAX, temperature=0.4):
            parts.append(delta)
            yield _sse({"delta": delta})
    except Exception:
        pass
    if not _strip_blocks("".join(parts)):
        yield _sse({"delta": "Here's what I found:\n" + src})
    yield _sse({"delta": "\n\n<voice>Here's what I found on the web.</voice>"})
    yield _empty_meta(message, "web")


async def _match_candidates(client: httpx.AsyncClient, message: str, history: list[dict],
                            project_name: str = "", user_name: str = "") -> AsyncIterator[str]:
    """Match best-fit internal candidates (vector + rerank over the 210k-CV corpus)
    and write them as a **Candidates** document in the workspace — one fresh tab, like
    the composed deliverables. Ranks against the open Job Offer (the job description, the
    richest signal) when one exists, else the role title + the request."""
    docs = _docs_map(buffers.snapshot())
    jd = (docs.get("Job Offer") or docs.get("Job Offer (MA2)") or "").strip()
    # Like the generate path: don't search with no basis. Rank against the open
    # Job Offer when present, else a CONCRETE role (from the message, the project
    # name, or the conversation). With neither, ask instead of returning whatever
    # the vector store loosely matches for a roleless request.
    role = ""
    if not jd:
        role = await _role_label(client, message)
        if not role and project_name:
            role = await _role_label(client, project_name)
        if not role and history:
            role = await _role_label(
                client, await _resolve_need(client, history, message, project_name))
        if not role:
            ask = ("Sure. Which role should I find candidates for? Tell me the job "
                   "title and a few key skills, or generate a Job Offer first and "
                   "I'll match candidates against it.")
            yield _sse({"delta": ask})
            yield _sse({"delta": "\n\n<voice>Which role should I find candidates "
                                 "for? Tell me the job title and a few key "
                                 "skills.</voice>"})
            yield _empty_meta(message, "cand")
            return
    if jd:
        query, basis = jd, "the open Job Offer"
    else:
        query = message.strip()
        if role.lower() not in query.lower():
            query = f"{role}. {query}".strip()
        basis = f"the {role} role"
    # Show the same chat-side "Generation Progress" card as document generation, so
    # matching candidates feels like a first-class deliverable.
    yield _sse({"progress": {"steps": [{"title": CANDIDATES_TITLE, "state": "active"}]}})
    cands = await services.search_candidates(client, query, top_k=3)
    body = f"# {CANDIDATES_TITLE}\n\n{_candidates_doc_body(cands, basis)}"
    # Always create a fresh buffer (= a new tab that opens and focuses), exactly
    # like the composed deliverables — documents accumulate, and this avoids a
    # silent no-op when an orphaned same-named buffer lingers in the global store.
    bid = buffers.create(name=CANDIDATES_TITLE, initial_content=body).buffer_id
    yield _sse({"progress": {"steps": [{"title": CANDIDATES_TITLE, "state": "done"}]}})
    if cands:
        note = (f"Done — I've put the top {len(cands)} **{CANDIDATES_TITLE}** "
                f"(ranked against {basis}) in your workspace.")
        voice = "I've added the top candidates to your workspace."
    else:
        note = (f"I matched against {basis} but found no strong candidates in our "
                "pool. Tell me the role and a few key skills and I'll search again.")
        voice = "I couldn't find strong candidates just now."
    yield _sse({"delta": note})
    yield _sse({"delta": f"\n\n<voice>{voice}</voice>"})
    yield _sse({"meta": {
        "turn_id": hashlib.sha1(("cand:" + (message or "")).encode()).hexdigest()[:12],
        "buffers": [bid], "deliverables": [CANDIDATES_TITLE] if cands else [],
        "role": "", "domain": "", "retrieved_chunks": 0, "retrieved_entities": 0,
        "retrieved_edges": 0, "avg_similarity": 0.0}})


async def run_chat(message: str, history: list[dict],
                   config: dict | None = None) -> AsyncIterator[str]:
    """Yield cv-contract SSE for one HR-pack turn."""
    config = config or {}
    offer_sources = set(config.get("offer_sources") or ["ma2", "gemma", "rag"])
    use_ma2 = "ma2" in offer_sources
    use_gemma_offer = "gemma" in offer_sources
    use_rag_offer = "rag" in offer_sources
    # The active project's name (often the role being hired for, e.g. "Test
    # Automation Engineer") and the logged-in user's name, forwarded by the
    # widget in `config`. Used as a role hint and to greet the user by name.
    project_name = (config.get("project_name") or "").strip()
    user_name = (config.get("user_name") or "").strip()
    need = (message or "").strip()
    if not need:
        yield _sse({"delta": "Tell me the hiring need and I'll build the pack."})
        yield "data: [DONE]\n\n"
        return

    async with httpx.AsyncClient() as client:
        # 0) Intent router: Diana converses by default and only acts when asked —
        #    generate a doc, improve an open doc, search the web, or match
        #    candidates. Everything else is a normal conversation.
        intent = await _route(client, history, message, project_name)
        if intent != "generate":
            handler = {"improve": _improve, "web_search": _web_search,
                       "match_candidates": _match_candidates}.get(intent, _converse)
            async for ev in handler(client, message, history, project_name, user_name):
                yield ev
            yield "data: [DONE]\n\n"
            return

        # 1) Resolve the message against the conversation (memory/context) ---
        need = await _resolve_need(client, history, need, project_name)

        # 1) Role + domain + requested deliverables --------------------------
        role = await _role_label(client, need)
        if not role and project_name:
            # The project name itself often names the role (e.g. "Test
            # Automation Engineer") — use it before asking the user.
            role = await _role_label(client, project_name)
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
        # Deliverable SCOPE comes from the user's literal message, NOT the resolved
        # need: `_resolve_need` rewrites the turn to carry the role+skills forward,
        # which can drift into generic "full hiring package" framing and make a
        # narrow request ("the onboarding plan and tech interview") regenerate
        # everything. The literal words are the ground truth for what to produce.
        requested = await _requested_sections(client, message)
        want_candidates = "candidates" in requested
        doc_keys = [k for k in requested if k in _SECTION_BY_KEY]
        secs = [_SECTION_BY_KEY[k] for k in doc_keys]
        deliv_titles = ([s["title"] for s in secs]
                        + ([CANDIDATES_TITLE] if want_candidates else []))
        names = ", ".join(deliv_titles)
        offer_both = ("offer" in doc_keys) and use_ma2 and use_gemma_offer

        # Buffers (= tabs) are created lazily, one per requested deliverable,
        # right before that deliverable generates — so tabs appear and focus
        # one-by-one as each answer is written.
        section_bufs: dict[str, Any] = {}

        # 2) Conversational intro (streamed; carries <think>) ----------------
        intro_parts: list[str] = []
        try:
            async for delta in services.llm_stream(
                    client, await services.active_model(client),
                    [{"role": "system", "content": await services.get_agent_prompt(
                        client, "job2cool_orchestrator", INTRO_SYSTEM)},
                     {"role": "user", "content":
                      f"{need}\n\n(You are generating ONLY these deliverables: "
                      f"{names}. Confirm exactly these in your reply — do not "
                      f"promise a full package unless all four are listed.)\n\n"
                      f"Do BOTH, in order: first reason inside a "
                      f"<think>...</think> block using 2-5 headed phases, then "
                      f"write your 2-3 sentence confirmation."}],
                    max_tokens=INTRO_MAX, temperature=0.5):
                intro_parts.append(delta)
        except Exception:
            pass
        # Surface ONLY Diana's reasoning (the Thinking panel). The intro's visible
        # reply is intentionally NOT streamed: (a) it duplicated the spoken voice
        # line, and (b) the model sometimes drafted the whole deliverable into it,
        # leaking a second, different job offer into the chat. The spoken voice +
        # progress lines + closing note are the user-facing message.
        intro_raw = "".join(intro_parts)
        intro_thinking = _extract_think(intro_raw)
        if intro_thinking:
            yield _sse({"delta": f"<think>{intro_thinking}</think>"})

        # Brief spoken summary — the avatar speaks the <voice> only, not the
        # whole answer (cv pattern). Stripped from the visible text by cv-chat.
        if len(deliv_titles) == 1:
            voice = (f"Sure. I'm preparing the {deliv_titles[0].lower()} for a "
                     f"{role} now. I'll write it into the document for you.")
        else:
            voice = (f"Sure. I'm preparing the {role} hiring package now: {names}. "
                     f"I'll write it into the document for you.")
        yield _sse({"delta": f"\n\n<voice>{voice}</voice>"})

        yield _sse({"delta": f"\n\n_Role: **{role}** · grounding in `{domain}`._\n"})

        # Live "Generation Progress" checklist in the chat (mirrors the workspace
        # stepper). We stream a structured snapshot instead of inline ▸/✓ text so
        # the widget can render a real checklist that updates per deliverable.
        # Candidates is the trailing step when requested (matched, not composed).
        prog = [{"title": s["title"], "state": "pending"} for s in secs]
        if want_candidates:
            prog.append({"title": CANDIDATES_TITLE, "state": "pending"})
        yield _sse({"progress": {"steps": prog}})

        # 3) Generate requested deliverables ---------------------------------
        total_chunks = 0
        total_excerpts = 0   # graph chunk-excerpts are citable passages too (cv parity)
        cited: list[dict] = []
        cited_excerpts: list[dict] = []
        agg_entities: dict[str, dict] = {}
        agg_edges: dict[tuple, dict] = {}
        evidence_all: list[str] = []
        doc_bodies: list[str] = []   # what Diana wrote to the workspace (for the judge)
        ma2_draft = ""               # the specialist MA2 offer (ground truth for the judge)
        for i, sec in enumerate(secs, start=1):
            # Create this deliverable's tab now (opens + focuses in the UI).
            buf = buffers.create(name=sec["title"],
                                 initial_content=f"# {sec['title']}\n\n_Generating…_")
            section_bufs[sec["key"]] = buf
            prog[i - 1]["state"] = "active"
            yield _sse({"progress": {"steps": prog}})
            query = sec["query"].format(need=need)
            ev = await services.graph_and_vector_search(
                client, query, domains, top_k=6)
            total_chunks += len(ev.get("chunks") or [])
            total_excerpts += len(ev.get("excerpts") or [])
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
            prose = _grounding_prose(ev)   # lean grounding stored for the judge
            if prose:
                evidence_all.append(prose)

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
            if is_offer and draft:
                ma2_draft = draft   # ground truth the judge scores Gemma's offer against
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
                        "AUTHORITATIVE DRAFT — the specialist offer model's Job "
                        "Offer; this is your basis to reproduce and refine:\n"
                        + draft)
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
                    client, await services.active_model(client),
                    [{"role": "system", "content": await services.get_agent_prompt(
                        client, "job2cool_composer", SECTION_SYSTEM)},
                     {"role": "user", "content": "\n\n".join(user_parts)}],
                    max_tokens=SECTION_MAX, temperature=0.4, timeout=300)

            body = f"# {sec['title']}\n\n{section_md.strip()}{_cited_sources(ev)}"
            buffers.replace(buf.buffer_id, body)
            doc_bodies.append(body)
            prog[i - 1]["state"] = "done"
            yield _sse({"progress": {"steps": prog}})

        # 3b) Candidates — matched from the CV pool as its own Workspace document,
        #     ranked against the Job Offer we just wrote (richest signal) else the
        #     resolved need. The trailing step of the package when requested.
        cand_buf_id = None
        if want_candidates:
            ci = len(prog) - 1
            prog[ci]["state"] = "active"
            cbuf = buffers.create(
                name=CANDIDATES_TITLE,
                initial_content=f"# {CANDIDATES_TITLE}\n\n_Generating…_")
            yield _sse({"progress": {"steps": prog}})
            cq, cbasis = _candidate_query(_docs_map(buffers.snapshot()),
                                          project_name, need)
            cands = await services.search_candidates(client, cq, top_k=3)
            cbody = f"# {CANDIDATES_TITLE}\n\n{_candidates_doc_body(cands, cbasis)}"
            buffers.replace(cbuf.buffer_id, cbody)
            cand_buf_id = cbuf.buffer_id
            doc_bodies.append(cbody)
            prog[ci]["state"] = "done"
            yield _sse({"progress": {"steps": prog}})

        # 4) Closing chat note (grounding + gaps + nudge) + turn cache --------
        turn_id = hashlib.sha1((need + str(total_chunks)).encode()).hexdigest()[:12]
        remaining = [s["title"] for s in SECTIONS if s["key"] not in set(requested)]
        note = _closing_note(role, names, domain, remaining, user_name)
        yield _sse({"delta": "\n\n" + note})

        cache.put_turn(turn_id, question=need,
                       evidence="\n\n".join(evidence_all),
                       thinking=intro_thinking,
                       documents="\n\n---\n\n".join(doc_bodies),
                       ma2_offer=ma2_draft,
                       answer=note,
                       entities=list(agg_entities.values()),
                       edges=list(agg_edges.values()),
                       domains=domains)

        # Citations live in the DOCUMENT, not the chat — so the widget's
        # bubble-scan would report 0. Report what Diana actually cited in the
        # documents (deduped by tag) so the Score card reflects reality.
        _docs = "\n".join(doc_bodies)
        cited_chunks = len(set(re.findall(r"\[markdown_chunk:([0-9a-f]+)\]", _docs)))
        cited_entities = len(set(re.findall(r"\[E:([^\]]+)\]", _docs)))
        cited_edges = len(set(re.findall(r"\[R:([^\]]+)\]", _docs)))

        yield _sse({"meta": {"turn_id": turn_id,
                             "buffers": ([b.buffer_id for b in section_bufs.values()]
                                         + ([cand_buf_id] if cand_buf_id else [])),
                             "deliverables": deliv_titles,
                             "offer_ma2": bool(offer_both),
                             "role": role, "domain": domain,
                             # citable chunk pool = dense vector chunks + graph
                             # excerpts (both carry [markdown_chunk] tags), cv-style.
                             "retrieved_chunks": total_chunks + total_excerpts,
                             "retrieved_entities": len(agg_entities),
                             "retrieved_edges": len(agg_edges),
                             "cited_chunks": cited_chunks,
                             "cited_entities": cited_entities,
                             "cited_edges": cited_edges,
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


def _closing_note(role: str, deliverables: str, domain: str,
                  remaining: list[str], user_name: str = "") -> str:
    """Diana's brief chat note AFTER the document(s) are written. It deliberately
    does NOT recap the document content (that lives in the mid pane) and makes NO
    evidence claims (so it cannot hallucinate): it confirms what landed in the
    workspace and nudges the next deliverable. The substance — and its grounded,
    clickable citations — lives in the document itself."""
    are = "are" if "," in deliverables else "is"
    first = user_name.strip().split()[0] if user_name.strip() else ""
    hi = f"{first}, the" if first else "Done — the"
    lead = (f"{hi} **{deliverables}** for a {role} {are} in your workspace"
            + (f", grounded in `{domain}`" if domain else "") + ".")
    nudge = ""
    human = _humanize_list([r.lower() for r in remaining])
    if human:
        nudge = f"Want me to prepare the {human} next?"
    return " ".join(p for p in (lead, nudge) if p)
