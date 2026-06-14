#!/usr/bin/env python3
"""Vector-ingest the Djinni candidate-CV corpus into the `jobs_candidates`
Domain so Diana's later `match_candidates` step can retrieve best-fit internal
candidates by vector similarity + a structured ChromaDB `where` pre-filter.

DESIGN (decided 2026-06-14, see memory `candidate-matching-ingestion`):
  * VECTOR-ONLY. No graph extraction — full LLM entity extraction on 210k CVs
    is ~2.3 days and `match_candidates` never reads the graph.
  * ONE chunk per whole CV (real CVs median ~110 words; section-chunking would
    shred them).
  * Structured fields (Primary Keyword, English Level, Experience Years,
    Position, id) are stored as ChromaDB METADATA so the matcher can `where`-
    pre-filter (e.g. role family + min experience + English level).

The embedding model (bge-m3) lives inside noted-rag, so we push text there over
HTTP via the bulk /upsert_records endpoint (batched embed + arbitrary flat
metadata + skip_existing for cheap resume). We never embed locally.

Runs on the HOST against the published ports (noted-rag :8201, noted-graph
:5523). Idempotent: re-running skips already-ingested CVs, so a Ctrl-C'd or
crashed run resumes for free — just run it again.

  scripts/.venv-ingest/bin/python scripts/ingest_candidates.py            # full run
  scripts/.venv-ingest/bin/python scripts/ingest_candidates.py --limit 200 # smoke test
"""
from __future__ import annotations

import argparse
import sys
import time

import pyarrow.parquet as pq
import requests

# Columns as they appear in train-00000-of-00001.parquet (verified on real data).
COL_CV = "CV"
COL_ID = "id"
COL_POSITION = "Position"
COL_PRIMARY_KEYWORD = "Primary Keyword"
COL_ENGLISH = "English Level"
COL_EXPERIENCE = "Experience Years"


def _fmt_eta(seconds: float) -> str:
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def ensure_domain(graph_url: str, domain_id: str, name: str, description: str) -> None:
    """Create the Domain in noted-graph if it doesn't exist yet (manifest +
    lazily-created collections). Idempotent — a pre-existing Domain is fine."""
    r = requests.get(f"{graph_url}/domains", timeout=15)
    r.raise_for_status()
    existing = {d.get("domain_id") for d in r.json().get("domains", [])}
    if domain_id in existing:
        print(f"[domain] {domain_id!r} already exists — reusing.")
        return
    print(f"[domain] creating {domain_id!r} ...")
    cr = requests.post(
        f"{graph_url}/domains",
        json={"domain_id": domain_id, "name": name, "description": description},
        timeout=60,
    )
    if cr.status_code not in (200, 201):
        raise SystemExit(f"failed to create domain: HTTP {cr.status_code} {cr.text[:300]}")
    print(f"[domain] created {domain_id!r}.")


def build_record(row: dict, min_chars: int) -> dict | None:
    """Map one parquet row to an /upsert_records record, or None if the CV is
    too short to be worth embedding (junk tail: some rows are a handful of
    chars)."""
    cv = (row.get(COL_CV) or "").strip()
    if len(cv) < min_chars:
        return None
    cand_id = row.get(COL_ID) or ""
    rec_id = f"cand-{cand_id}" if cand_id else None
    if rec_id is None:
        return None  # no stable id -> skip (can't dedupe/resume safely)

    exp = row.get(COL_EXPERIENCE)
    meta = {
        "id": cand_id,
        "source_path": f"cand/{cand_id}",
        "primary_keyword": (row.get(COL_PRIMARY_KEYWORD) or "").strip(),
        "english_level": (row.get(COL_ENGLISH) or "").strip(),
        "position": (row.get(COL_POSITION) or "").strip()[:300],
        "cv_chars": len(cv),
    }
    if exp is not None:
        try:
            meta["experience_years"] = int(round(float(exp)))
        except (TypeError, ValueError):
            pass
    # _clean_meta on the server drops empty strings/None, so blanks are safe.
    return {"id": rec_id, "text": cv, "metadata": meta}


def post_batch(rag_url: str, collection: str, records: list[dict],
               embed_batch: int, retries: int = 4) -> dict:
    """POST one batch to /upsert_records with simple backoff retry (embedding
    can transiently time out under GPU contention)."""
    payload = {"collection": collection, "records": records,
               "embed_batch": embed_batch, "skip_existing": True}
    delay = 2.0
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.post(f"{rag_url}/upsert_records", json=payload, timeout=300)
            if r.status_code == 200:
                body = r.json()
                # Only accept a batch whose writes were read-back confirmed.
                # A 'partial' (verified < indexed) means some rows didn't
                # persist; retry — skip_existing will re-do only the missing.
                if body.get("verified", body.get("indexed", 0)) >= body.get("indexed", 0):
                    return body
                last = (f"unverified write: indexed={body.get('indexed')} "
                        f"verified={body.get('verified')}")
            else:
                last = f"HTTP {r.status_code}: {r.text[:200]}"
        except requests.RequestException as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
        if attempt < retries:
            print(f"\n[retry {attempt}/{retries - 1}] batch failed ({last}); "
                  f"waiting {delay:.0f}s ...", file=sys.stderr)
            time.sleep(delay)
            delay *= 2
    raise SystemExit(f"batch permanently failed after {retries} attempts: {last}")


def report(rag_url: str, collection: str, sample_query: str) -> None:
    """Test + report (step 6): final collection count + a live sample query."""
    print("\n" + "=" * 60)
    print("REPORT")
    print("=" * 60)
    try:
        c = requests.get(f"{rag_url}/collections", timeout=30).json()
        match = next((x for x in c.get("collections", []) if x["name"] == collection), None)
        print(f"collection {collection!r}: "
              f"{match['count'] if match else 'NOT FOUND'} vectors")
    except requests.RequestException as e:  # noqa: BLE001
        print(f"collection count unavailable: {e}")

    print(f"\nsample query: {sample_query!r}  (nearest neighbours; rerank floor "
          f"disabled so this is a pure retrieval sanity-check)")
    try:
        r = requests.post(f"{rag_url}/search",
                          json={"collection": collection, "query": sample_query,
                                "top_k": 5, "rerank_min_score": 0.0},
                          timeout=120)
        # /search returns matches under `chunks` (cf. /cache/search -> `hits`).
        hits = r.json().get("chunks", []) if r.status_code == 200 else []
        if not hits:
            print(f"  (no hits — HTTP {r.status_code})")
        for h in hits:
            snippet = (h.get("text") or "").replace("\n", " ")[:90]
            print(f"  {h.get('score', 0):.3f}  {h.get('id', '')}  {snippet}")
    except requests.RequestException as e:  # noqa: BLE001
        print(f"  sample query failed: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parquet", default="data/candidates/train-00000-of-00001.parquet")
    ap.add_argument("--rag-url", default="http://localhost:8201")
    ap.add_argument("--graph-url", default="http://localhost:5523")
    ap.add_argument("--domain", default="jobs_candidates")
    ap.add_argument("--batch", type=int, default=128,
                    help="CVs per /upsert_records request (also the embed batch)")
    ap.add_argument("--min-chars", type=int, default=50,
                    help="drop CVs shorter than this (junk tail)")
    ap.add_argument("--limit", type=int, default=0, help="ingest at most N rows (0 = all)")
    ap.add_argument("--offset", type=int, default=0, help="skip the first N rows")
    ap.add_argument("--no-create-domain", action="store_true")
    ap.add_argument("--sample-query", default="senior python backend engineer with fastapi")
    args = ap.parse_args()

    collection = f"{args.domain}__corpus"

    print(f"parquet     : {args.parquet}")
    print(f"domain      : {args.domain}  ->  collection {collection!r}")
    print(f"noted-rag   : {args.rag_url}")
    print(f"noted-graph : {args.graph_url}")
    print(f"batch       : {args.batch}   min-chars: {args.min_chars}"
          f"   limit: {args.limit or 'all'}   offset: {args.offset}")
    print("-" * 60)

    if not args.no_create_domain:
        ensure_domain(args.graph_url, args.domain, "Candidate CVs",
                      "Internal candidate corpus for Diana's candidate matching (vector-only).")

    pf = pq.ParquetFile(args.parquet)
    total_rows = pf.metadata.num_rows
    target = total_rows - args.offset
    if args.limit:
        target = min(target, args.limit)
    print(f"[parquet] {total_rows} rows total; processing ~{target} "
          f"(offset {args.offset}{', limit ' + str(args.limit) if args.limit else ''}).")

    t0 = time.time()
    seen = 0          # rows visited within the window
    processed = 0     # rows actually sent (built records)
    short = 0         # rows dropped for being too short / id-less
    indexed = 0       # server-confirmed newly embedded
    verified = 0      # read-back confirmed present in ChromaDB
    skipped = 0       # server-confirmed already present (resume)
    row_idx = -1
    buf: list[dict] = []

    def flush() -> None:
        nonlocal indexed, verified, skipped
        if not buf:
            return
        res = post_batch(args.rag_url, collection, buf, args.batch)
        indexed += res.get("indexed", 0)
        verified += res.get("verified", res.get("indexed", 0))
        skipped += res.get("skipped_existing", 0)
        buf.clear()
        elapsed = time.time() - t0
        rate = processed / elapsed if elapsed > 0 else 0
        remaining = max(0, target - seen)
        eta = remaining / rate if rate > 0 else 0
        pct = (seen / target * 100) if target else 100
        sys.stdout.write(
            f"\r[{pct:5.1f}%] seen {seen}/{target}  built {processed}  "
            f"indexed {indexed} (ack {verified})  resumed {skipped}  short {short}  "
            f"{rate:5.1f} CV/s  ETA {_fmt_eta(eta)}   "
        )
        sys.stdout.flush()

    try:
        for rb in pf.iter_batches(batch_size=2048):
            rows = rb.to_pylist()
            for row in rows:
                row_idx += 1
                if row_idx < args.offset:
                    continue
                if args.limit and seen >= args.limit:
                    raise StopIteration
                seen += 1
                rec = build_record(row, args.min_chars)
                if rec is None:
                    short += 1
                    continue
                buf.append(rec)
                processed += 1
                if len(buf) >= args.batch:
                    flush()
    except (StopIteration, KeyboardInterrupt) as e:
        if isinstance(e, KeyboardInterrupt):
            print("\n[interrupted] flushing current batch; re-run to resume.",
                  file=sys.stderr)
    flush()

    elapsed = time.time() - t0
    print(f"\n\n[done] visited {seen} rows in {_fmt_eta(elapsed)} "
          f"({(processed/elapsed if elapsed else 0):.1f} CV/s built).")
    print(f"       built {processed} | newly indexed {indexed} "
          f"(read-back ack {verified}) | resumed/already-present {skipped} | "
          f"dropped-short {short}")
    if verified != indexed:
        print(f"       WARNING: {indexed - verified} indexed rows were NOT "
              f"read-back confirmed — re-run to repair.")

    report(args.rag_url, collection, args.sample_query)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
