# 10. Frontend & User Experience

## 10.1 Layout

`frontend/index.html` is a full-viewport flex app: a **left nav rail** + a **main
area** (a top bar, a tab bar, and a split document/PDF pane). The visual language is
a calm light theme with a **gold accent (`#ffe19b`)** — the owner's brand choice; the
TalentForge AI mockup (`documents/homepage_mockup.png`) is the **layout** reference,
not the colour spec (the mockup is indigo/violet).

The UI is modular: each left-nav view is a small IIFE module under `frontend/js2c/`
(`kb.js`, `agents.js`, `mcp.js` for Skills/Tools, `chats.js` for Projects,
`candidates.js`, `help.js`, `pdfcite.js`, `sidepanel.js`, `architecture.js`), and the
Diana assistant is the patched `widget/cv-chat.js`.

## 10.2 Left navigation (current, verified)

The rail is: **Workspace · Projects · Candidates · Agents · Skills · Tools ·
Knowledge Base · Company Profile (soon)**, with **Help & Support · Settings** at the
bottom and the authenticated-user profile (name/photo from oauth2-proxy). *This
supersedes the older docs' "Home / AI Assistant / My Workspace / Templates /
Documents / Candidates / Company Profile" aspirational list and the claim that
Candidates is a "soon" stub — Candidates is built (§09); Projects (formerly "Chats")
is built; only Company Profile remains a placeholder.*

Only one right-edge side-panel is ever open at a time (the Assistant chat, or an
Agents/Skills/Tools/Candidates detail panel); opening one closes the others.

## 10.3 The Diana widget

`cv-chat.js` is the evolved cv assistant, **patched in ~5 places** to live in
job2cool: (a) the `/chat` POST carries `window.JOB2COOL_CONFIG`; (b) a new-turn
signal resets tabs on send; (c) a citation with a `source_path` opens the **PDF
split pane** (`JOB2COOL_OPEN_PDF`) instead of cv's in-page highlight; (d) all asset
paths are **base-relative** (`document.baseURI`) so the app works under the
`/job2cool/` sub-path; (e) the persona is **Diana / "HR Assistant"** with `diana.png`
and short greetings. It retains the full cv stack — **Thinking / Graph / Score**
panels, citations, and **STT / TTS / avatar** — talking to `/api/chat | citation |
graph_trace | score_answer` and to `/stt /tts /avatar` Socket.IO on the proxy origin.

## 10.4 Workspace

The Workspace is the document surface: a top bar (package title + Download/Export
controls), a **tab bar with one tab per generated deliverable** (created lazily as
each section completes), and a split pane — `#doccol` (rendered Markdown with
clickable citation badges) **|** `#pdfcol` (the PDF split pane, hidden until a
citation opens it). Per-tab actions: Copy Markdown and PDF export (print-in-place).
The Job Offer tab shows a **Gemma / MA2 segmented toggle** when both versions exist
(the §06.6 A/B view). An "All Documents" overview presents the deliverables as a
**cards grid** with a **Generation Progress** checklist that updates live as sections
land — the mockup's stepper, wired to the real pipeline.

## 10.5 Projects (was "Chats")

Conversations are organised into **Projects** (`chats.js` + backend
`/api/job2cool/chats/*`): a New/Edit Project dialog with name + optional description +
**private/shared visibility (shared by default)**. Access control is real
(authenticated users): private projects live per-user; shared projects live in a
shared store, are listed for everyone, and are **owner-only for edit/delete**.
Reopening a project performs **full-fidelity replay** — it restores the conversation,
the workspace documents, the role, *and* the live **Thinking / Graph / Score** panels
of each past turn (panel snapshots are persisted with the project and re-rendered
through the same widget code path). This is also what compensates for the buffer-save
stub (§07.4): work persists in the project even though per-buffer save is deferred.

## 10.6 Candidates view

Covered in §09.5: a paginated browse over 210k CVs, Enter-to-search semantic
retrieval with a match-% chip, and a per-CV detail side-panel. It is the
human-facing half of the candidate-matching capability.

## 10.7 Knowledge Base, Agents, Skills, Tools

- **Knowledge Base** (`kb.js`): the domain manager + monitor — list domains, upload
  documents, rebuild graphs — with **live build progress streamed over Socket.IO**
  (the graph engine emits `kb:progress` per domain; the backend relays it; the
  Database tab updates with no polling — the project's banned-`setInterval`,
  event-driven rule, §12).
- **Agents** (`agents.js`): CRUD over the `job2cool_*` agent presets
  (`job2cool_orchestrator`, `_composer`, `_judge`) that drive Diana — editable
  system-prompt templates in a side-panel, with the inline defaults as fallback.
- **Skills / Tools** (`mcp.js`): the tools/skills host admin, served through
  `mcp-service` (§11).

## 10.8 Honest UI limitations

- **Company Profile** is a placeholder (toast only).
- **Audio** (STT/TTS/avatar) works only on the deployed proxy origin
  (`logus2k.com/job2cool`), not `localhost:4920` — an explicit decision not to modify
  nginx for local audio routing.
- The frontend is **baked into the image** (not bind-mounted, correcting the older
  docs), so a frontend change needs `docker compose up -d --build job2cool-backend`
  then a hard refresh.
- A browser visual-verification pass (split-PDF render, voice on the proxy origin,
  project replay) is the standing manual QA item (§15).
