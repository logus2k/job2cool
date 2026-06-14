# 7. Hybrid RAG, Citations & Live Documents

## 7.1 Hybrid retrieval

The RAG component (`backend/services.py`) combines two retrievers and merges them:

**Vector search.** Dense retrieval over the resolved domain's ChromaDB collection
(`<domain>__corpus`) via noted-rag — bge-m3 cosine HNSW search followed by
**bge-reranker-v2-m3** cross-encoder re-ranking. The vector query is **LLM-rewritten
first** (`formulate_query`, reusing the `cv_query_rewriter` preset) because a
cleaned, keyword-focused query retrieves better than a conversational sentence.

**Graph search.** noted-graph retrieval over the same domain — entities,
relationships, and graph-grounded chunk excerpts that carry **page number and
bounding-box regions**. The graph query uses the **raw** question (entity-name search
handles conversational phrasing better than a rewritten phrase).

**Aggregation.** `graph_and_vector_search` runs both **concurrently** (`asyncio`
fan-out: embed once, search vector + graph in parallel) and joins them into one
evidence block. Citation tags distinguish the sources: `[markdown_chunk:hex]` for
chunks (dense and graph-grounded), `[E:id]` for entities, `[R:src>type>tgt]` for
edges. **Design note / honest limitation:** the merged set is **not** cross-reranked
after the join — vector and graph results are concatenated, not globally re-scored
together. A future improvement is a unified post-merge rerank.

This is the assignment's "vector store + hybrid retrieval + re-ranking" depth marker,
realised; the candidate-matching layer (§08) adds a second hybrid form (structured
metadata pre-filter + vector + rerank).

## 7.2 Why RAG (and graph) instead of more fine-tuning

- **Updatability.** The onboarding/interview/culture knowledge is broad and still
  growing; RAG lets it change without retraining the model.
- **Grounding + provenance.** The graph half provides **per-chunk citations to a PDF
  page + bbox** — verifiable provenance that fine-tuning fundamentally cannot give.
- **Separation of concerns.** A1/A2 improved *Job-Offer writing quality*; RAG
  supplies *company-specific knowledge and proof of source*. Different axes — the
  basis of the §16 "RAG did not make domain adaptation redundant" argument.

## 7.3 Citations → PDF + bounding box

The citation chain turns a tag into a highlighted source page:

1. A `[markdown_chunk:hex]` badge (in chat or in a document section) is clicked.
2. `/api/citation/{tag}` resolves it: the backend looks up the cached chunk, then
   asks noted-graph `/chunk/{tag}` for `source_path`, `page_no`, and `regions`
   (bbox list).
3. The frontend (`js2c/pdfcite.js`, `JOB2COOL_RENDER_PDF`) opens a **PDF split pane**
   beside the document, renders the cited page(s) with pdf.js, and paints the bbox
   overlay (`viewport.convertToViewportRectangle`, handling the PDF
   bottom-left→top-left flip). A `ResizeObserver` re-renders on width change so the
   box stays aligned.

**Documented limitation:** bbox highlighting is available only for **graph-grounded
excerpts**; dense-search-only chunks resolve to the source PDF but open it **without
a box** (they carry no region metadata). This is a property of the retrieval source,
not a rendering bug.

## 7.4 Live documents (the buffer layer)

Each deliverable is a **live in-memory `DocBuffer`** (`backend/buffers.py`):
`{buffer_id, name, content}`, one per section. As the orchestrator composes, it
writes into the buffer and an `asyncio` pub/sub broadcasts the change over **SSE**
(`/api/buffers/events/stream`); the Workspace re-renders the document live, tab by
tab. Token caps are set generously to avoid mid-generation truncation
(`SECTION_MAX=8192`, `INTRO_MAX=4096`, `DPO_MAX≈1200`, `SUMMARY_MAX≈320`) — these are
conservative output bounds, not context limits (gemma's context is 131072).

**Honest limitation:** `/api/buffers/{buffer_id}/save` currently **acknowledges but
does not persist** to disk or the KB (a stub marked `TODO` in code). Workspace
documents do round-trip through the **Projects** store, however (§10) — a project
saves its conversation, its panels, and its workspace docs and replays them on
reopen, so work is not lost across sessions even though the per-buffer save is a stub.

## 7.5 Caching (so the judge and graph are cheap)

`backend/cache.py` keeps two FIFO caches: a **chunk cache** keyed by
`sha1(chunk_id)[:12]` (max ~2048) so citation resolution doesn't re-query, and a
**turn cache** keyed by `turn_id` (max ~256) holding the full turn (question,
evidence, thinking, documents, answer, entities, edges, domains). The turn cache is
what lets `/api/score_answer` (judge) and `/api/graph_trace` (3D graph) operate on a
finished turn without re-running retrieval or composition.
