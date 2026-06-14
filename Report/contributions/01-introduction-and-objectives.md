# 1. Introduction & Objectives

## 1.1 What the system is

**job2cool** is the final system of a three-assignment arc. Its user-facing
persona is **Diana**, an HR assistant that turns a hiring need, expressed in plain
language, into a coherent pack of HR documents — a **Job Offer**, **Technical
Interviews**, an **Onboarding Plan**, and a **Cultural & Team Fit** assessment —
generated conversationally, grounded in a company knowledge base, written **live**
into editable documents, and **cited** with click-through links to the exact source
PDF page and bounding box.

The recruiter describes their need (e.g. *"I need a backend developer who knows
Python and AWS and is comfortable in an Agile team"*); Diana resolves the need
against the conversation so far, identifies the role, selects which documents the
request actually asks for, retrieves company evidence, drafts and composes each
section, and streams the result into a tabbed workspace while narrating its
reasoning. Every grounded claim carries a citation that opens the source document.

A second capability, added in this final stage, is **candidate matching**: a
210,000-CV internal candidate corpus is vector-indexed and browsable, the
foundation for retrieving best-fit internal candidates for a role (the corpus and
its browser are built; the conditional candidate-aware composition is designed and
partially realized — see §08–§09).

## 1.2 The trilogy context

This is the capstone of a course trilogy in which each stage builds on the last:

- **Mini-Assignment 1 (A1) — domain adaptation.** Continued pretraining of a small
  open-source model (SmolLM2-360M) on IT job postings, shifting its language
  distribution toward recruitment text.
- **Mini-Assignment 2 (A2) — alignment.** Supervised fine-tuning then DPO
  preference alignment, yielding **`ma2-360m-dpo-b01`**, a specialist that takes a
  plain hiring need and drafts a structured Markdown Job Offer.
- **Mini-Assignment 3 (A3, this work) — the system.** Wrap that aligned model in a
  working application, adding *at least two* further course techniques. job2cool
  adds **four**: retrieval-augmented generation, agentic tool-use/orchestration,
  LLM-as-a-judge evaluation, and performance optimization of the serving stack.

The aligned A2 model is **not replaced**; it remains an active component (the Job
Offer drafter) inside the larger system. How its contribution survives integration
is one of the questions this report evaluates (§14, §16).

## 1.3 Objectives

1. **A usable system, not a concept.** A working, runnable pipeline with a clear
   entry point (a web UI plus a CLI ingestion tool), reproducible end-to-end.
2. **Make the aligned model useful in the real task.** Give the A2 drafter the
   things an isolated aligned model lacks: knowledge of company material (RAG),
   memory and routing across a multi-document conversation (agentic orchestration),
   and verifiable grounding (citations).
3. **Integrate ≥2 course components coherently** and justify each against the
   problem it solves.
4. **Evaluate rigorously** against the mandated baselines — the base pretrained
   model and the A2 model with no system around it — to isolate what the final
   stage actually contributes.
5. **Report honestly**, including the failures and the limits of the current build.

## 1.4 Scope and non-goals

job2cool is built and evaluated on **IT recruitment**, but the architecture does
not depend on that domain: the domain-organised KB, the domain-resolution step, and
the orchestration pipeline are content-agnostic, so the same system could be
retargeted by swapping the knowledge base and the specialist drafting model.

**Non-goals / explicit boundaries.** This is a single-company recruiter-assistant
demonstration, not a production HR product. The candidate corpus is a public,
anonymised dataset standing in for a company's internal pool. Closed APIs are not
used anywhere in the serving path; all models in the request path are open-source
(see §05). Some surfaces are deliberately deferred (the `match_candidates` tool, a
handful of placeholder nav pages, on-disk buffer persistence) and are documented as
such rather than hidden (§15).

## 1.5 Status at a glance

- **Hiring-package generation:** functional end-to-end (chat → A2 draft + gemma
  composition + hybrid RAG → live cited tabs).
- **Knowledge base:** 10 of 11 role onboarding domains populated, plus thematic
  domains; multi-domain retrieval.
- **Candidate corpus:** **210,048 CVs** vector-indexed and read-back verified;
  Candidates browser (list + semantic search + detail) live.
- **Platform:** shared KB/tool services extracted (`kb-service`, `mcp-service`,
  `websearch_server`); live infrastructure health map; identity via oauth2-proxy.
- **Known gaps:** the `match_candidates` conditional-composition tool is designed
  but not yet wired; some nav pages are stubs; audio (STT/TTS/avatar) routes only
  via the production proxy origin, not `localhost`. Full list in §15.
