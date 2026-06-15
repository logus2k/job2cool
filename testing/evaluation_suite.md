# Evaluation Suite — MA3 Baseline Comparison & System Metrics

> Grounds report §5 (Evaluation). Produces: the mandated **(a)/(b)/(c) baseline comparison**,
> the **system-only capability** metrics, the **qualitative worked examples** (§5.3), and the
> **MA2-vs-Gemma wash-out** A/B (§7). All result tables live in `results/` as placeholders.

## 1. The three configurations (mandated baselines)

| Config | What | How it is run | Isolates |
|---|---|---|---|
| **(a)** | **base SmolLM2-360M**, no fine-tuning | `transformers` from HF cache (`HuggingFaceTB/SmolLM2-360M`), greedy/`rep_penalty=1.3` | the floor before any adaptation |
| **(b)** | **`ma2-360m-dpo-b01`** alone (no RAG, no orchestration) | `agent_server` `/v1/chat/completions`, the A2 offer prompt template only | the A1+A2 contribution in isolation |
| **(c)** | **full job2cool** (A2 draft + gemma compose + hybrid RAG + citations) | `job2cool-backend` `POST /api/chat` (SSE) | the A3 final-stage contribution |

(a) and (b) produce a **Job Offer only** (it is the one deliverable all three can attempt).
(c) produces the full requested pack and the system-only behaviours (routing, grounding,
refusal, memory) that (a)/(b) structurally cannot do — that asymmetry *is* the A3 contribution.

## 2. The fixed prompt set (12 cases)

> Stable ids; categories mirror report §5.3. "Configs" = which configs the case is scored on.
> For role prompts, (a)/(b) are scored on the Job Offer; (c) on the full behaviour.

| ID | Category | Prompt | Expected (c) behaviour | Configs |
|---|---|---|---|---|
| **T01** | Full pack · backend | "I need to hire a backend developer who knows Python and AWS and is comfortable in an Agile team." | 4 docs; domain `jobs_onboard_backend` | a,b,c |
| **T02** | Full pack · devops | "We're looking for a DevOps engineer with Kubernetes and CI/CD experience." | 4 docs; `jobs_onboard_devops` | a,b,c |
| **T03** | Full pack · ml_ai | "Hire a machine-learning engineer experienced with PyTorch and MLOps." | 4 docs; `jobs_onboard_ml_ai` | a,b,c |
| **T04** | Single-section · frontend | "Write a job description for a senior frontend engineer who knows React and TypeScript." | offer only; `jobs_onboard_frontend` | a,b,c |
| **T05** | Single-section · qa | "Draft a job posting for a QA automation engineer (Selenium, Python)." | offer only; `jobs_onboard_qa` | a,b,c |
| **T06** | Single-section · security | "Create a job offer for a security engineer with pentesting and SIEM experience." | offer only; `jobs_onboard_security` | a,b,c |
| **T07** | Domain routing · data | "I need a data engineer skilled in Spark and Airflow." | 4 docs; `jobs_onboard_data` | a,b,c |
| **T08** | Domain routing · mobile | "Looking for an iOS developer (Swift)." | 4 docs; `jobs_onboard_mobile` | a,b,c |
| **T09** | Domain routing · architect | "Hire a software architect for a microservices platform." | 4 docs; `jobs_onboard_architect` | a,b,c |
| **T10** | Fallback · embedded (domain absent) | "I need an embedded firmware engineer (C, RTOS)." | fallback → `jobs_onboard_general` (no `embedded` domain) | a,b,c |
| **T11** | Refusal · ambiguous | "I need to hire someone." | **ask-back, generate nothing** | c only |
| **T12** | Memory · follow-up (2-turn) | t1: "I need a DevOps engineer." · t2: "Now make the onboarding plan remote-friendly." | t2 folds in prior role; updates Onboarding only | c only |

## 3. Metrics

### 3.1 Job-Offer quality — the (a)/(b)/(c) isolation (Table 1)
Scored on every offer-producing case (T01–T10, T12-t1) for **all three configs**, by the
**gemma-4 quality judge** (§5, rubric below). Mirrors the A2 RLAIF rubric for arc continuity.

- **Structural completeness** — are the four sections present (Summary / Required Skills /
  Responsibilities / Requirements)? Deterministic 0–4 → %; *also* judged 1–5.
- **Faithfulness-to-request** (1–5) — does the offer match the requested role/skills?
- **Language quality** (1–5).
- **Repetition-free** (1–5) — penalises the small-model repetition collapse.

### 3.2 System-only capabilities — config (c) (Table 2)
- **Section-segregation accuracy** — did (c) produce exactly the requested deliverables? (n/N)
- **Domain-resolution accuracy** — correct `jobs_onboard_*` or correct fallback? (n/N)
- **Resolvable-citation rate** — cited chunks that resolve to a valid PDF page (and bbox where
  graph-grounded) / total citations.
- **RAGAS faithfulness** + **answer-relevance** (mean) — from the live judge `/api/score_answer`
  over the cached turn (grounding metric; (a)/(b) have no evidence so this is (c)-only).
- **Refusal correctness** — T11: did it ask back and generate nothing? (0/1)
- **Memory correctness** — T12: did t2 fold in the prior role and update only Onboarding? (0/1)
- **Latency** — wall-clock per turn (s).

### 3.3 Wash-out A/B (Table 3 · report §7)
For each offer case, the **raw MA2 draft** vs the **gemma-composed offer** (both produced by (c)
with `offer_sources=["ma2","gemma","rag"]`), judged side-by-side by gemma-4: *MA2-better / Tie /
Gemma-better* + one-line note on whether A2's structure/alignment survived.

### 3.4 Carried A1/A2 baselines (context, from MA1/MA2 reports — already in report Table 3)
base PPL 16.37 (Djinni) / 11.66 (val) → SFT 4.54 → DPO-b01 6.01 (β=0.10); DPO-b01 vs SFT win-rate
8–0; A1 LoRA merge 11.38 in-domain. *(Carried, not re-run here.)*

## 4. The gemma-4 quality judge (rubric, reproducible)

Called on `agent_server` `/v1/chat/completions`, `model=gemma-4`, `think=False`
(`chat_template_kwargs={"enable_thinking": false}`), `temperature=0`, JSON-only output.

```
SYSTEM: You are a strict hiring-content evaluator. Score a Job Offer against the recruiter
request on four axes, integers 1–5 (5 best). Output ONLY JSON:
{"structural_completeness":n,"faithfulness_to_request":n,"language_quality":n,
 "repetition_free":n,"rationale":"<=40 words"}.
Sections expected: Summary, Required Skills, Responsibilities, Requirements.

USER: REQUEST:\n{prompt}\n\nJOB OFFER:\n{offer_text}
```

For the wash-out A/B (§3.3), a pairwise variant outputs
`{"winner":"A|tie|B","rationale":"<=40 words"}` with A=MA2 draft, B=Gemma offer, **order-swapped**
across two calls (strict agreement only, per the A2 protocol). RAGAS faithfulness/answer-relevance
for (c) come from the system's own `/api/score_answer`, not this judge.

## 5. Procedure (what `run_eval.py` does, per case)

1. **(a)** — load base SmolLM2-360M (transformers, cache), prompt with the offer instruction
   (`OFFER_PROMPT`, §6), `max_new_tokens=512`, `repetition_penalty=1.3`; capture text + latency.
2. **(b)** — `POST agent_server/v1/chat/completions` `{model:"ma2-360m-dpo-b01", messages:[{role:"user",
   content: OFFER_PROMPT(prompt)}], temperature:0.4, repetition_penalty:1.3, max_tokens:1200}`;
   capture text + latency.
3. **(c)** — `POST job2cool-backend/api/chat` `{message, history, config:{offer_sources:["ma2","gemma","rag"]}}`,
   consume the SSE stream; capture per-deliverable buffers, the resolved domain, citation tags,
   the `turn_id` from the final `meta`, and latency. Then `POST /api/score_answer {turn_id}` for
   RAGAS faithfulness/answer-relevance, and resolve each citation via `/api/citation/{tag}` to
   compute the resolvable-rate.
4. **judge** — score the (a)/(b)/(c) offer texts with the §4 rubric; run the §3.3 A/B.
5. **write** — raw JSON to `results/raw/{ID}.json`; `--write-md` fills the `results/*.md` tables.

T11 (refusal) and T12 (memory) run **(c) only** and are scored on behaviour, not offer quality.

## 6. Setup & config

- **OFFER_PROMPT** (shared by (a)/(b) so the comparison is fair): the A2 SFT instruction template
  — *"Write a job offer for the following hiring need. Include the sections: Summary, Required
  Skills, Responsibilities, Requirements.\n\nHiring need: {prompt}"* (exact template pinned in
  `run_eval.py`; mirror of the A2 template in `atlm_pro`).
- **(a) runtime** (one-time): `python3 -m venv testing/.venv-eval && testing/.venv-eval/bin/pip
  install -r testing/requirements-eval.txt` (torch CPU + transformers). 360M on CPU is sufficient.
- **Endpoints:** `agent_server` `http://localhost:7701`, `job2cool-backend` `http://localhost:4920`.
- **Seeds:** transformers `set_seed(42)`; judge `temperature=0`; deterministic where the stack allows
  (LLM judge + GPU router are not bit-exact — reproducibility note, report §5 / deliverable).

## 7. Authorization note

Executing drives the **live shared services** (`agent_server` gemma-4 + ma2, the full job2cool
stack, the engines). It is read-only w.r.t. persisted data except that (c) turns are cached
in-process and may create transient Projects/buffers. Run only on owner's go.
