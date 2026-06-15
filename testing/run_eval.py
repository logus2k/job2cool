#!/usr/bin/env python3
"""MA3 baseline-comparison eval harness (see evaluation_suite.md).

Runs the 12-case suite across configs (a) base SmolLM2-360M, (b) ma2-360m-dpo-b01
alone, (c) full job2cool, plus the gemma-4 quality judge and the MA2-vs-Gemma A/B,
and writes raw JSON to results/raw/{ID}.json. The results/*.md placeholder tables
are then filled from that JSON.

  testing/.venv-eval/bin/python testing/run_eval.py            # full suite
  testing/.venv-eval/bin/python testing/run_eval.py --case T01 # one case
  testing/.venv-eval/bin/python testing/run_eval.py --skip-a   # (b)/(c)/judge only

NOTE: NOT YET RUN. The (c) SSE/buffers parsing is validated on first live run.
Executing drives the live shared services (agent_server, job2cool stack).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path

import requests

AGENT = os.getenv("EVAL_AGENT_URL", "http://localhost:7701")
J2C = os.getenv("EVAL_J2C_URL", "http://localhost:4920")
OUT = Path(__file__).parent / "results" / "raw"

# Model artifacts for (a)/(b). MA2 evaluated from the checkpoints via transformers
# (the served endpoint is chat-only — /v1/completions is 405 — and would wrap the
# plain-Alpaca model in a chat template), so we reproduce that exactly.
ATLM = os.getenv("EVAL_ATLM", "/home/logus/env/iscte/atlm_pro")
BASE_MODEL = os.getenv("EVAL_BASE_MODEL", "HuggingFaceTB/SmolLM2-360M")
SFT_MERGED = os.getenv("EVAL_SFT_MERGED", f"{ATLM}/outputs/ma2-360m-sft-merged")
DPO_ADAPTER = os.getenv("EVAL_DPO_ADAPTER", f"{ATLM}/outputs/ma2-360m-dpo-b01")
DEVICE = os.getenv("EVAL_DEVICE", "cpu")   # "cuda" is faster but shares the serving GPU

# THE EXACT MA2 prompt template + decode config (src/ma2/atlm_ma2_v1.ipynb,
# delivery/src/generate_mp1.py): inference is everything up to "### Posting\n".
OFFER_PROMPT = (
    "You are a recruitment assistant. Given a brief recruiter request, write a "
    "complete structured job posting in Markdown.\n\n### Request\n{query}\n\n### Posting\n"
)
GEN_KWARGS = dict(max_new_tokens=800, do_sample=False, repetition_penalty=1.3)

CASES = [
    ("T01", "full",     "I need to hire a backend developer who knows Python and AWS and is comfortable in an Agile team."),
    ("T02", "full",     "We're looking for a DevOps engineer with Kubernetes and CI/CD experience."),
    ("T03", "full",     "Hire a machine-learning engineer experienced with PyTorch and MLOps."),
    ("T04", "offer",    "Write a job description for a senior frontend engineer who knows React and TypeScript."),
    ("T05", "offer",    "Draft a job posting for a QA automation engineer (Selenium, Python)."),
    ("T06", "offer",    "Create a job offer for a security engineer with pentesting and SIEM experience."),
    ("T07", "full",     "I need a data engineer skilled in Spark and Airflow."),
    ("T08", "full",     "Looking for an iOS developer (Swift)."),
    ("T09", "full",     "Hire a software architect for a microservices platform."),
    ("T10", "fallback", "I need an embedded firmware engineer (C, RTOS)."),
    ("T11", "refusal",  "I need to hire someone."),
    ("T12", "memory",   None),  # special 2-turn case (see run_case)
]
T12_TURNS = ["I need a DevOps engineer.", "Now make the onboarding plan remote-friendly."]

# ---- configs (a)/(b): generated from the checkpoints via transformers --------
# Exactly as MA2 did: same Alpaca template, greedy, repetition_penalty=1.3. (b) is
# the SFT-merged base + the DPO LoRA adapter — the b01 deliverable.
_models = {}
def _load(kind: str):
    if kind in _models:
        return _models[kind]
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed
    set_seed(42)
    dtype = torch.bfloat16 if DEVICE.startswith("cuda") else torch.float32
    if kind == "base":
        tok = AutoTokenizer.from_pretrained(BASE_MODEL)
        model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, torch_dtype=dtype)
    else:  # "dpo"
        from peft import PeftModel
        tok = AutoTokenizer.from_pretrained(SFT_MERGED)
        base = AutoModelForCausalLM.from_pretrained(SFT_MERGED, torch_dtype=dtype)
        model = PeftModel.from_pretrained(base, DPO_ADAPTER)
    _models[kind] = (tok, model.to(DEVICE).eval(), torch)
    return _models[kind]

def _generate(kind: str, prompt: str) -> dict:
    tok, model, torch = _load(kind)
    enc = tok(OFFER_PROMPT.format(query=prompt), return_tensors="pt").to(DEVICE)
    t0 = time.time()
    with torch.no_grad():
        out = model.generate(**enc, pad_token_id=tok.eos_token_id, **GEN_KWARGS)
    gen = tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
    return {"text": gen, "latency_s": round(time.time() - t0, 2)}

def run_base(prompt: str) -> dict: return _generate("base", prompt)   # config (a)
def run_dpo(prompt: str) -> dict: return _generate("dpo", prompt)     # config (b)

# ---- config (c): full job2cool via /api/chat SSE -----------------------------
def run_full(message: str, history: list, config: dict) -> dict:
    t0 = time.time()
    deltas, meta, progress = [], {}, []
    with requests.post(f"{J2C}/api/chat", stream=True, timeout=600,
                       json={"message": message, "history": history, "config": config}) as r:
        r.raise_for_status()
        for line in r.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                ev = json.loads(payload)
            except Exception:
                continue
            if "delta" in ev:
                deltas.append(ev["delta"])
            elif "meta" in ev:
                meta = ev["meta"]
            elif "progress" in ev:
                progress.append(ev["progress"])
    buffers = read_buffers()
    return {"chat_text": "".join(deltas), "meta": meta, "buffers": buffers,
            "latency_s": round(time.time() - t0, 2)}

def clear_buffers() -> None:
    """Reset server-side live-doc buffers so deliverables don't leak across cases."""
    try:
        requests.post(f"{J2C}/api/buffers/clear", timeout=15)
    except Exception:  # noqa: BLE001
        pass

def read_buffers() -> dict:
    """Snapshot the server-side live-doc buffers (deliverable name -> content)."""
    out = {}
    try:
        with requests.get(f"{J2C}/api/buffers/events/stream", stream=True, timeout=8) as r:
            for line in r.iter_lines(decode_unicode=True):
                if line and line.startswith("data:"):
                    try:
                        ev = json.loads(line[5:].strip())
                    except Exception:
                        continue
                    name = ev.get("name")
                    if name and "content" in ev:
                        out[name] = ev["content"]
                # snapshot is finite; stop once we've drained the replayed set
                elif line == "" and out:
                    break
    except requests.exceptions.Timeout:
        pass
    return out

def score_answer(turn_id: str) -> dict:
    if not turn_id:
        return {}
    try:
        r = requests.post(f"{J2C}/api/score_answer", json={"turn_id": turn_id}, timeout=120)
        return r.json() if r.status_code == 200 else {"error": r.status_code}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}

CITE_RE = re.compile(r"\[markdown_chunk:([0-9a-f]+)\]")
def citation_stats(text: str) -> dict:
    tags = CITE_RE.findall(text or "")
    resolvable = 0
    for hx in tags:
        try:
            d = requests.get(f"{J2C}/api/citation/markdown_chunk:{hx}", timeout=30).json()
            if d.get("source_path") or d.get("regions"):
                resolvable += 1
        except Exception:  # noqa: BLE001
            pass
    return {"citations": len(tags), "resolvable": resolvable}

# ---- gemma-4 quality judge ---------------------------------------------------
def _gemma_json(system: str, user: str) -> dict:
    r = requests.post(f"{AGENT}/v1/chat/completions", timeout=120, json={
        "model": "gemma-4", "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
    r.raise_for_status()
    txt = r.json()["choices"][0]["message"]["content"]
    m = re.search(r"\{.*\}", txt, re.S)
    return json.loads(m.group(0)) if m else {"raw": txt}

JUDGE_SYS = (
    "You are a strict hiring-content evaluator. Score a Job Offer against the recruiter "
    "request on four axes, integers 1-5 (5 best). Output ONLY JSON: "
    '{"structural_completeness":n,"faithfulness_to_request":n,"language_quality":n,'
    '"repetition_free":n,"rationale":"<=40 words"}. '
    "Sections expected: Summary, Required Skills, Responsibilities, Requirements.")
def judge_offer(prompt: str, offer: str) -> dict:
    if not (offer or "").strip():
        return {"structural_completeness": 0, "faithfulness_to_request": 0,
                "language_quality": 0, "repetition_free": 0, "rationale": "empty output"}
    return _gemma_json(JUDGE_SYS, f"REQUEST:\n{prompt}\n\nJOB OFFER:\n{offer}")

AB_SYS = ('Compare two Job Offers for the same request. Output ONLY JSON: '
          '{"winner":"A|tie|B","rationale":"<=40 words"}.')
def judge_ab(prompt: str, a: str, b: str) -> dict:
    """Order-swapped pairwise; strict agreement => verdict, else 'tie'."""
    v1 = _gemma_json(AB_SYS, f"REQUEST:\n{prompt}\n\nOFFER A:\n{a}\n\nOFFER B:\n{b}").get("winner")
    v2 = _gemma_json(AB_SYS, f"REQUEST:\n{prompt}\n\nOFFER A:\n{b}\n\nOFFER B:\n{a}").get("winner")
    swap = {"A": "B", "B": "A", "tie": "tie"}
    agree = v1 == swap.get(v2, v2)
    return {"winner_A_is_MA2": v1 if agree else "tie", "raw": [v1, v2], "strict_agree": agree}

# ---- per-case driver ---------------------------------------------------------
def run_case(cid: str, kind: str, prompt: str, skip_a: bool) -> dict:
    res = {"id": cid, "kind": kind, "prompt": prompt}
    clear_buffers()   # fresh workspace per case (memory case keeps t1→t2 accumulation)
    if kind == "memory":
        t1 = run_full(T12_TURNS[0], [], {"offer_sources": ["ma2", "gemma", "rag"]})
        hist = [{"role": "user", "content": T12_TURNS[0]},
                {"role": "assistant", "content": t1["chat_text"]}]
        t2 = run_full(T12_TURNS[1], hist, {"offer_sources": ["ma2", "gemma", "rag"]})
        res["c_turn1"], res["c_turn2"] = t1, t2
        return res
    if kind == "refusal":
        res["c"] = run_full(prompt, [], {"offer_sources": ["ma2", "gemma", "rag"]})
        return res
    # offer-producing cases: a, b, c
    if not skip_a:
        res["a"] = run_base(prompt)
        res["a"]["judge"] = judge_offer(prompt, res["a"]["text"])
    res["b"] = run_dpo(prompt)
    res["b"]["judge"] = judge_offer(prompt, res["b"]["text"])
    c = run_full(prompt, [], {"offer_sources": ["ma2", "gemma", "rag"]})
    offer = c["buffers"].get("Job Offer", "")
    ma2_draft = c["buffers"].get("Job Offer (MA2)", "")
    c["judge"] = judge_offer(prompt, offer)
    c["score_answer"] = score_answer((c.get("meta") or {}).get("turn_id", ""))
    c["citation_stats"] = citation_stats(offer)
    res["c"] = c
    if offer and ma2_draft:
        res["wash_out"] = judge_ab(prompt, ma2_draft, offer)
    return res

def preflight() -> int:
    """~15s fail-fast check of every HTTP path before the long run. No torch."""
    ok = True
    def chk(name, fn):
        nonlocal ok
        try:
            v = fn(); print(f"  PASS  {name}: {v}")
        except Exception as e:  # noqa: BLE001
            ok = False; print(f"  FAIL  {name}: {type(e).__name__}: {e}")
    # judge returns parseable JSON
    chk("judge gemma-4 JSON", lambda: judge_offer(
        "backend dev", "## Summary\nx\n## Required Skills\nx\n## Responsibilities\nx\n## Requirements\nx"))
    # (c) SSE + meta parse (refusal path is fast: yields meta, no generation)
    chk("(c) /api/chat SSE+meta (refusal)", lambda: {
        "turn_id": run_full("I need to hire someone.", [], {}).get("meta", {}).get("turn_id", "?")})
    # score_answer is callable (graceful on a bogus id)
    chk("/api/score_answer reachable", lambda: type(score_answer("deadbeef00")).__name__)
    print("PREFLIGHT", "OK" if ok else "FAILED")
    return 0 if ok else 1

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", help="run a single case id, e.g. T01")
    ap.add_argument("--skip-a", action="store_true", help="skip base-model config (a)")
    ap.add_argument("--preflight", action="store_true", help="~15s HTTP-path check, then exit")
    args = ap.parse_args()
    if args.preflight:
        return preflight()
    OUT.mkdir(parents=True, exist_ok=True)
    cases = [c for c in CASES if (not args.case or c[0] == args.case)]
    for cid, kind, prompt in cases:
        print(f"[{cid}] {kind} ...", flush=True)
        try:
            res = run_case(cid, kind, prompt, args.skip_a)
        except Exception as e:  # noqa: BLE001
            res = {"id": cid, "kind": kind, "error": f"{type(e).__name__}: {e}"}
            print(f"  ERROR: {res['error']}", flush=True)
        (OUT / f"{cid}.json").write_text(json.dumps(res, indent=2, ensure_ascii=False))
        print(f"  wrote results/raw/{cid}.json", flush=True)
    print("done.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
