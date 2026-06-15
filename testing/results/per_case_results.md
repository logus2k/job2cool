# Results — Per Case

> **Status: PLACEHOLDER — not yet executed.** Fill from `results/raw/{ID}.json` on run.
> Scores: structural completeness `SC` (0–4), faithfulness `F`, language `L`, repetition-free `R`
> (each 1–5). (c) adds: domain resolved, deliverables, citation count/resolvable, RAGAS
> faithfulness/answer-relevance, latency.

---

## T01 — Full pack · backend
**Prompt:** "I need to hire a backend developer who knows Python and AWS and is comfortable in an Agile team."
**Expected (c):** 4 docs; domain `jobs_onboard_backend`.

- **(a) base** — latency `—s` · SC `—` F `—` L `—` R `—`
  > ```
  > TODO: offer text excerpt
  > ```
- **(b) ma2-dpo-b01** — latency `—s` · SC `—` F `—` L `—` R `—`
  > ```
  > TODO: offer text excerpt
  > ```
- **(c) full** — latency `—s` · domain `—` · deliverables `—` · citations `—` (resolvable `—`) · RAGAS faith `—` / ans-rel `—` · offer SC `—` F `—` L `—` R `—`
  > ```
  > TODO: composed offer excerpt + Sources line
  > ```

## T02 — Full pack · devops
**Prompt:** "We're looking for a DevOps engineer with Kubernetes and CI/CD experience."
**Expected (c):** 4 docs; `jobs_onboard_devops`.

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain `—` · deliverables `—` · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T03 — Full pack · ml_ai
**Prompt:** "Hire a machine-learning engineer experienced with PyTorch and MLOps."
**Expected (c):** 4 docs; `jobs_onboard_ml_ai`.

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain `—` · deliverables `—` · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T04 — Single-section · frontend
**Prompt:** "Write a job description for a senior frontend engineer who knows React and TypeScript."
**Expected (c):** offer only; `jobs_onboard_frontend`.

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain `—` · deliverables `—` (expect offer only) · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T05 — Single-section · qa
**Prompt:** "Draft a job posting for a QA automation engineer (Selenium, Python)."
**Expected (c):** offer only; `jobs_onboard_qa`.

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain `—` · deliverables `—` · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T06 — Single-section · security
**Prompt:** "Create a job offer for a security engineer with pentesting and SIEM experience."
**Expected (c):** offer only; `jobs_onboard_security`.

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain `—` · deliverables `—` · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T07 — Domain routing · data
**Prompt:** "I need a data engineer skilled in Spark and Airflow."
**Expected (c):** 4 docs; `jobs_onboard_data`.

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain `—` · deliverables `—` · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T08 — Domain routing · mobile
**Prompt:** "Looking for an iOS developer (Swift)."
**Expected (c):** 4 docs; `jobs_onboard_mobile`.

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain `—` · deliverables `—` · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T09 — Domain routing · architect
**Prompt:** "Hire a software architect for a microservices platform."
**Expected (c):** 4 docs; `jobs_onboard_architect`.

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain `—` · deliverables `—` · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T10 — Fallback · embedded (domain absent)
**Prompt:** "I need an embedded firmware engineer (C, RTOS)."
**Expected (c):** fallback → `jobs_onboard_general` (no `embedded` domain).

- **(a) base** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(b) ma2-dpo-b01** — `—s` · SC `—` F `—` L `—` R `—` · `TODO`
- **(c) full** — `—s` · domain resolved `—` (expect fallback) · deliverables `—` · citations `—` (resolvable `—`) · RAGAS `—`/`—` · offer SC/F/L/R `—` · `TODO`

## T11 — Refusal · ambiguous  *(config (c) only)*
**Prompt:** "I need to hire someone."
**Expected:** ask-back, generate nothing.

- **(c) full** — refusal correct? `—` (0/1) · latency `—s`
  > ```
  > TODO: Diana's ask-back text; confirm no deliverables generated
  > ```

## T12 — Memory · follow-up  *(config (c) only)*
**Turn 1:** "I need a DevOps engineer." **Turn 2:** "Now make the onboarding plan remote-friendly."
**Expected:** t2 folds in prior role; updates Onboarding only.

- **(c) t1** — domain `—` · deliverables `—` · latency `—s` · `TODO`
- **(c) t2** — memory correct? `—` (0/1) · deliverables updated `—` (expect Onboarding only) · latency `—s`
  > ```
  > TODO: t2 resolved-need rewrite + which buffer(s) changed
  > ```
