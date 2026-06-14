# 9. Candidate Matching — As-Built (Ingestion & Browser)

This section is the honest counterpart to §08: what is **actually built and verified**
as of 2026-06-15, and where it deliberately departs from the design.

## 9.1 What exists today

- **The full candidate corpus is vector-indexed.** `jobs_candidates__corpus` holds
  **210,048** CV embeddings (210,250 rows minus 202 sub-50-character junk profiles),
  each with queryable structured metadata. Read-back verified (§9.4).
- **A Candidates browser UI** (left-nav, below Projects): a paginated list with
  **semantic search** and a per-CV **detail side-panel** (§9.5).
- **A reusable CLI ingestion tool** with live progress, idempotent resume, and a
  test/report step (§9.3).

The `match_candidates` tool and the conditional bundle composition of §08 are
**designed but not yet wired** — see §9.6.

## 9.2 Two design corrections forced by the real data

The §08 design was adjusted after inspecting the actual corpus:

1. **Single-chunk per CV, not section-chunked.** The design (and the academic doc)
   assumed 500–2000-word CVs and recommended section-chunking. The real CVs are
   **tiny** — median ~110 words / ~750 chars, max ~7.4k chars — so section-chunking
   would shred them. We embed **one vector per whole CV**; the atomic retrieval unit
   is "this candidate," and a whole CV fits easily in bge-m3's 8192-token window.
2. **Vector-only, no graph feed.** The design called for graph ingestion "like any
   other domain." Benchmarked, full LLM entity-extraction over 210k CVs is **~2.3
   days** of GPU time — and the matcher (vector + structured pre-filter + rerank)
   never reads the graph. Decision: **skip the graph; vector-only.** The
   `jobs_candidates` domain has the ChromaDB collection but no populated ArcadeDB
   graph.

Both corrections are documented and were the owner's explicit calls; they make the
as-built simpler and faster than the as-designed without losing matcher capability.

## 9.3 The ingestion tool

`scripts/ingest_candidates.py` (run on the host in an isolated venv; talks to the
engines over HTTP):

- creates the `jobs_candidates` domain if absent;
- streams the Parquet, building **one record per CV** (`id = cand-{uuid}` — stable,
  so re-runs are idempotent), dropping CVs < 50 chars;
- stores the structured fields as **ChromaDB metadata** (`primary_keyword`,
  `english_level`, `experience_years` (int), `position`, `id`, `source_path`,
  `cv_chars`) — the substrate for the §08 `where` pre-filter;
- pushes in batches to a new noted-rag endpoint (§9.4) with **live progress + ETA**
  printed to stdout, graceful Ctrl-C, and **free resume** (already-stored ids are
  skipped);
- ends with a test/report: collection count + a sample query.

## 9.4 Two additive engine endpoints (copy-only respected)

The bulk ingest needed capabilities noted-rag's per-document `/upsert_chunks`
(single-source, fixed metadata schema) did not have. Honouring the copy-only
guardrail, these were added **additively** to noted-rag, not by forking:

- **`POST /upsert_records`** — bulk embed + upsert of `[{id, text, metadata}]` with
  the caller's **own flat metadata** stamped verbatim (so the structured fields
  survive into Chroma for `where`-filtering); **token-budgeted embedding
  sub-batching** (a performance-optimization measure, §13); `skip_existing` for
  idempotent resume; and a **read-back verification** — after each upsert it
  `get(ids=…)` from ChromaDB and returns a `verified` count, so a `200` means the
  rows are *confirmed present*, not merely "request accepted." The ingest treats any
  `verified < indexed` batch as a retry.
- **`POST /list_records`** — paginated browse (limit/offset + optional `where`) and
  by-id lookup, powering the Candidates browser.

The final run reported **`indexed 43008 (read-back ack 43008)`** for the last
segment — every written row DB-confirmed.

## 9.5 The Candidates browser

`backend/main.py` exposes `/api/job2cool/candidates` (list/search) and
`/api/job2cool/candidates/{id}` (detail); `frontend/js2c/candidates.js` renders:

- **Browse** — paginated cards (position, primary keyword, English level,
  experience) over all 210k via `/list_records`.
- **Search** — type a query, press Enter → semantic search over the CV text
  (bge-m3 + reranker, via noted-rag `/search`), each result carrying a **match %**
  (the reranker score). *Bug found and fixed during build:* the list page size (30)
  exceeded noted-rag's `top_k ≤ 20` cap, so every search 422'd into empty results
  until the backend clamped `top_k`; the live-search debounce (a banned `setTimeout`)
  was replaced with explicit Enter-to-search.
- **Detail** — a right side-panel with the full CV and structured fields; the English
  level renders as a readable label (e.g. `upper → Upper-Intermediate`) — a
  **display-only** mapping (the raw value stays in the DB for the `where` filter).

Search quality is good on multi-word role phrases ("senior python backend engineer"
→ 0.99-scoring Python backend engineers) and honestly weaker on bare tokens or
terms absent from a 2020–2023 corpus ("genai" → near-zero, since the corpus predates
the LLM-engineering boom — §14, §15).

## 9.6 Design-vs-realized reconciliation

| §08 design | As-built (§09) | Status |
|---|---|---|
| Domain slug `jobs_candidates_pool` | `jobs_candidates` | **changed** |
| Section-chunked CVs | **Single chunk per CV** | corrected (real CVs are tiny) |
| Graph + vector ingestion | **Vector-only** (graph skipped: ~2.3 days, unused) | corrected |
| Structured fields as Chroma metadata | **Done** (`primary_keyword`/`english`/`experience`/…) | realized |
| `match_candidates` tool (pre-filter+vector+rerank) | retrieval primitives all present (`/search`, `where`, rerank); a **Candidates browser** built; the *tool* + conditional branching **not yet wired** | **deferred** |
| Conditional candidate-aware downstream | not yet wired | **deferred** |
| 7th "Candidate Matches" bundle section | not yet wired | **deferred** |

The honest summary: the **data layer and retrieval substrate for candidate matching
are complete and verified**, and a human-facing Candidates browser is live; the
*automated* `match_candidates` tool and the conditional composition remain the
headline next step (§15). What was hard about this layer was not the matcher logic —
it was getting 210k vectors ingested at all, which repeatedly OOM-killed the shared
embedder and produced the performance-optimization contribution in §13.
