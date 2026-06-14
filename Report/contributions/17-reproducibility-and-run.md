# 17. Reproducibility & Running the System

This section grounds the **Code deliverable**: how to run job2cool end-to-end, how it
connects to the A1/A2 artifacts, and what can and cannot be reproduced exactly.

## 17.1 Entry points

The system has two clear entry points:

1. **Web UI** — the recruiter-facing app (chat → live cited documents). After deploy,
   `https://logus2k.com/job2cool` (full features incl. audio) or
   `http://localhost:4920` (no audio routing). Diana, the Workspace, the KB,
   Candidates, Projects, and the live health map are all reachable from the left nav.
2. **CLI ingestion** — `scripts/ingest_candidates.py`, the reproducible candidate-corpus
   loader with live progress, idempotent resume, and a test/report step (§09.3).

## 17.2 Running job2cool

```
cd ~/env/assets/job2cool
docker compose up -d --build job2cool-backend      # backend + baked frontend
```

The container joins the external `noted-network` + `logus2k_network` and expects the
shared services (agent_server, kb-service / noted-rag / noted-graph, llama-vision,
mcp-service) to be up. A frontend or backend change is redeployed with the same
command (the frontend is baked, §12). Health and dependency status are visible live
in the Help & Support view.

## 17.3 Running the candidate ingestion

```
cd ~/env/assets/job2cool
python3 -m venv scripts/.venv-ingest
scripts/.venv-ingest/bin/pip install -r scripts/requirements-ingest.txt   # pyarrow, requests
scripts/.venv-ingest/bin/python scripts/ingest_candidates.py              # full 210k, resumable
#   --limit N        ingest at most N rows (smoke test)
#   --no-create-domain  skip domain creation on resume
```

It reads `data/candidates/train-00000-of-00001.parquet`, talks to noted-rag (`:8201`)
and noted-graph (`:5523`) over HTTP, prints per-batch progress + ETA + a read-back
`ack` count, and resumes for free if interrupted. **Prerequisite (one-time):** the
embedder must be slot-capped (`"parallel": 1` in `agent_server/data/agent_config.json`,
§13) so a concurrent-load run cannot OOM the host.

## 17.4 How it connects to the A1/A2 artifacts

The A1/A2 work lives at `~/env/iscte/atlm_pro`:

- **A1** continued-pretrained SmolLM2-360M on Djinni job postings → merged LoRA
  checkpoint at `outputs/mp1-360m/merged/` (seed 42; `requirements.lock.txt` pins
  versions).
- **A2** ran SFT then DPO on that base → the deliverable **`outputs/ma2-360m-dpo-b01/`**
  (LoRA over `ma2-360m-sft-merged`).
- **job2cool consumes the A2 model as a served model**, `ma2-360m-dpo-b01`, co-resident
  with gemma-4 on `agent_server` (a quantized GGUF export of the aligned checkpoint),
  selectable by model id. The backend references it via `JOB2COOL_DPO_MODEL`
  (default `ma2-360m-dpo-b01`). So the chain raw SmolLM2-360M → A1 merge → A2 DPO →
  served model → drafter inside job2cool is explicit and traceable.

## 17.5 Determinism & seeds

- A1/A2 training used **seed 42** throughout (corpus shuffle, training, sampling);
  GPU training is not bit-for-bit deterministic (<1% perplexity variance observed).
- The A2 model's **inference discipline matters** (an A2 finding carried into A3):
  `repetition_penalty=1.3` is required to avoid small-model repetition collapse; the
  serving config preserves this when the drafter is called.
- The ingestion's record ids are **deterministic** (`cand-{uuid}`), making re-runs
  idempotent (skip_existing) and the corpus reproducible.

## 17.6 Reproducibility note (what cannot be replicated exactly)

- **The judge is an LLM** (gemma-4 with a JSON rubric). Judge scores are not bit-exact
  across runs; and gemma judging its own output is a known bias (§15). This is bounded:
  the judge is an *auxiliary* evaluation signal, not in the generation path.
- **GPU/router state.** Model residency and quantized inference are not bit-for-bit
  reproducible; the slot-cap fix bounds *memory* deterministically but inference
  numerics may vary slightly.
- **The candidate corpus** is a fixed public Parquet (MIT, lang-uk/Djinni); the 202
  dropped sub-50-char rows and the 210,048 final count are reproducible from the same
  file + the documented `--min-chars` rule.

## 17.7 Repository shape (for the README)

```
job2cool/
  backend/        FastAPI orchestrator (main, orchestrator, services, buffers, cache,
                  health_monitor, socketio_relay) + Dockerfile + requirements.txt
  frontend/       index.html + js2c/* view modules + widget/ (Diana) + vendor
  scripts/        ingest_candidates.py + requirements-ingest.txt (+ isolated venv)
  documents/      design docs + the TalentForge mockup + architecture preview
  Report/         the MA3 report + contributions/ (this set)
  docker-compose.yml   (joins external noted-network + logus2k_network)
```

The README should state: setup (compose up), how to run (web UI + CLI), expected
outputs (a generated cited package; an ingested 210k candidate collection), the A1/A2
artifact links above, seeds, and this reproducibility note.
