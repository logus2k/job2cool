#!/usr/bin/env python3
"""Aggregate results/raw/{ID}.json (written by run_eval.py) into one consolidated
report: results/testing_results.md. Read-only on the raw files — safe to run while
the suite is still going (produces a partial report from whatever has completed).

  /home/logus/env/iscte/atlm_pro/.venv_atlm_pro/bin/python testing/aggregate_results.py
"""
from __future__ import annotations

import json
from pathlib import Path

RAW = Path(__file__).parent / "results" / "raw"
OUT = Path(__file__).parent / "results" / "testing_results.md"

# Expected routing per case (suite §2) — for domain/segregation correctness.
EXPECT = {
    "T01": ("jobs_onboard_backend", 4), "T02": ("jobs_onboard_devops", 4),
    "T03": ("jobs_onboard_ml_ai", 4),   "T04": ("jobs_onboard_frontend", 1),
    "T05": ("jobs_onboard_qa", 1),      "T06": ("jobs_onboard_security", 1),
    "T07": ("jobs_onboard_data", 4),    "T08": ("jobs_onboard_mobile", 4),
    "T09": ("jobs_onboard_architect", 4), "T10": ("jobs_onboard_general", 4),
}
AXES = ["structural_completeness", "faithfulness_to_request", "language_quality", "repetition_free"]


def _load() -> dict:
    out = {}
    for f in sorted(RAW.glob("*.json")):
        try:
            out[f.stem] = json.loads(f.read_text())
        except Exception:  # noqa: BLE001
            pass
    return out


def _mean(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(sum(vals) / len(vals), 2) if vals else None


def main() -> int:
    data = _load()
    offer_ids = [k for k in data if k in EXPECT]            # T01–T10
    L = []
    L.append("# Evaluation Results — job2cool MA3 baseline comparison")
    L.append("")
    L.append(f"> Auto-generated from `results/raw/*.json` · cases present: **{len(data)}** "
             f"({', '.join(sorted(data))}) · device: GPU (a base via PyTorch; b/c/judge served).")
    L.append("> (a) base SmolLM2-360M · (b) ma2-360m-dpo-b01 · (c) full job2cool. "
             "Judge = gemma-4 rubric (1–5). See `evaluation_suite.md`.")
    L.append("")

    # ---- Table 1: offer quality by config -----------------------------------
    L.append("## Table 1 — Job-Offer quality by config (the (a)/(b)/(c) isolation)")
    L.append("")
    L.append("| Config | Structural (1–5) | Faithfulness | Language | Repetition-free | Mean |")
    L.append("|---|---|---|---|---|---|")
    for cfg, key in [("(a) base SmolLM2-360M", "a"),
                     ("(b) ma2-360m-dpo-b01", "b"),
                     ("(c) full job2cool (offer)", "c")]:
        per = {ax: [] for ax in AXES}
        for cid in offer_ids:
            j = (data[cid].get(key) or {}).get("judge") or {}
            for ax in AXES:
                if isinstance(j.get(ax), (int, float)):
                    per[ax].append(j[ax])
        means = [_mean(per[ax]) for ax in AXES]
        allv = [v for ax in AXES for v in per[ax]]
        L.append(f"| {cfg} | {means[0]} | {means[1]} | {means[2]} | {means[3]} | **{_mean(allv)}** |")
    L.append("")
    L.append(f"_n = {len(offer_ids)} offer cases._ Expected story: (a) floor → (b) aligned jump → "
             "(c) comparable offer + the system capabilities below that (a)/(b) cannot do.")
    L.append("")

    # ---- Table 2: system-only metrics (config c) ----------------------------
    L.append("## Table 2 — System-only capabilities (config (c))")
    L.append("")
    dom_ok = seg_ok = 0; dom_n = 0
    cits = res = 0
    faiths, rels, lats = [], [], []
    for cid in offer_ids:
        c = data[cid].get("c") or {}
        m = c.get("meta") or {}
        exp_dom, exp_n = EXPECT[cid]
        if m.get("domain"):
            dom_n += 1
            dom_ok += int(m.get("domain") == exp_dom)
            seg_ok += int(len(m.get("deliverables") or []) == exp_n)
        cs = c.get("citation_stats") or {}
        cits += cs.get("citations", 0); res += cs.get("resolvable", 0)
        sa = c.get("score_answer") or {}
        if isinstance(sa.get("faithfulness"), (int, float)): faiths.append(sa["faithfulness"])
        if isinstance(sa.get("answer_relevance"), (int, float)): rels.append(sa["answer_relevance"])
        if isinstance(c.get("latency_s"), (int, float)): lats.append(c["latency_s"])
    refusal = data.get("T11", {}).get("c", {})
    refused = bool(refusal) and not (refusal.get("buffers"))   # ask-back ⇒ no deliverables
    t12 = data.get("T12", {})
    L.append("| Metric | Value |")
    L.append("|---|---|")
    L.append(f"| Domain-resolution accuracy | {dom_ok}/{dom_n} |")
    L.append(f"| Section-segregation accuracy | {seg_ok}/{dom_n} |")
    L.append(f"| Resolvable-citation rate | {res}/{cits} ({round(100*res/cits) if cits else 0}%) |")
    L.append(f"| RAGAS faithfulness (mean) | {_mean(faiths)} |")
    L.append(f"| RAGAS answer-relevance (mean) | {_mean(rels)} |")
    L.append(f"| Refusal correct (T11) | {'yes' if refused else 'NO — check'} |")
    L.append(f"| Memory case present (T12) | {'yes' if t12 else 'no'} |")
    L.append(f"| Mean (c) latency | {_mean(lats)} s |")
    L.append("")

    # ---- Wash-out -----------------------------------------------------------
    L.append("## Table 3 — Wash-out (MA2 draft A vs Gemma offer B)")
    L.append("")
    tally = {"A": 0, "tie": 0, "B": 0}
    L.append("| Case | Verdict (A=MA2 / B=Gemma) | strict-agree |")
    L.append("|---|---|---|")
    for cid in offer_ids:
        w = data[cid].get("wash_out") or {}
        v = w.get("winner_A_is_MA2")
        if v in tally: tally[v] += 1
        L.append(f"| {cid} | {v} | {w.get('strict_agree')} |")
    L.append("")
    L.append(f"**Tally:** MA2-better {tally['A']} · Tie {tally['tie']} · Gemma-better {tally['B']}")
    L.append("")

    # ---- Per-case detail ----------------------------------------------------
    L.append("## Per-case detail")
    L.append("")
    L.append("| Case | a struct | b struct | c struct | (c) domain | (c) deliv | cites (res) | RAGAS f/r | lat a/b/c |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for cid in sorted(data):
        d = data[cid]
        if cid in ("T11", "T12"):
            continue
        a, b, c = d.get("a") or {}, d.get("b") or {}, d.get("c") or {}
        m = c.get("meta") or {}; cs = c.get("citation_stats") or {}; sa = c.get("score_answer") or {}
        def st(x): return (x.get("judge") or {}).get("structural_completeness")
        L.append(f"| {cid} | {st(a)} | {st(b)} | {st(c)} | {m.get('domain','—')} | "
                 f"{len(m.get('deliverables') or [])} | {cs.get('citations',0)}({cs.get('resolvable',0)}) | "
                 f"{sa.get('faithfulness','—')}/{sa.get('answer_relevance','—')} | "
                 f"{a.get('latency_s','—')}/{b.get('latency_s','—')}/{c.get('latency_s','—')} |")
    L.append("")
    L.append("> Full text outputs (offers, MA2 drafts, deliverables) are in `results/raw/{ID}.json`.")
    L.append("")

    OUT.write_text("\n".join(L))
    print(f"wrote {OUT} ({len(data)} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
