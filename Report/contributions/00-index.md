# job2cool / Diana — Report Contributions (Master Index)

> **Purpose.** This folder holds the revised, current, section-by-section source
> material that grounds the MA3 final report (`Report/ma3_report_structure.md` /
> `ma3_repor_v1.md`). Each file is a self-contained section. Together they update
> and expand the earlier draft to reflect the system **as actually built and
> verified** as of 2026-06-15.

---

## Provenance & staleness note

The earlier planning documents (`documents/project_plan.md`,
`documents/project_plan_v2.md`, `documents/candidates_technical_architecture.md`)
and the report skeleton (`Report/ma3_report_structure.md`, `ma3_repor_v1.md`) are
**partly stale** and in places contradict each other and the running system. These
contributions are grounded in the **verified current state** (live containers,
ChromaDB collections, backend/frontend code, and the project memory), not in the
older docs. Where the older docs are superseded, that is called out explicitly.

Notable corrections carried into this set:

- The frontend is **baked into the image** (not bind-mounted, as project_plan_v2 §4
  still claims). Frontend changes require `docker compose up -d --build`.
- **Ten of eleven** `jobs_onboard_*` KB domains now exist (architect, backend, data,
  devops, frontend, general, ml_ai, mobile, qa, security) — not "only 2," as the
  v1 draft and project_plan say.
- The candidate-matching design in `candidates_technical_architecture.md` is
  **as-designed and superseded in part**: we built a **vector-only, single-chunk**
  ingestion (not section-chunked + graph) under the slug **`jobs_candidates`** (not
  `jobs_candidates_pool`), and a **Candidates browser UI** rather than the
  `match_candidates` tool (which is deferred). See §08–§09.
- The system integrates **four** course components, not two (RAG + agentic +
  LLM-as-judge + performance optimization). See §04.

---

## Section files & mapping to the 15-page report

| File | Section | Grounds report § |
|---|---|---|
| `01-introduction-and-objectives.md` | Problem, product, scope, trilogy context | §1 Introduction |
| `02-three-assignment-arc.md` | A1→A2→final pipeline, diagram, model-choice justification | §2 Pipeline Overview |
| `03-architecture-overview.md` | α-adapter, topology, networks, decisions | §3.1 System Design |
| `04-integrated-components.md` | The four integrated course components + justification | §3 System Design |
| `05-models-and-knowledge-base.md` | Models + KB domains | §3.4 / §3.2 |
| `06-orchestration-and-hiring-flow.md` | The agentic hiring-package pipeline | §3.3 |
| `07-rag-citations-live-docs.md` | Hybrid RAG, citations→PDF+bbox, live buffers | §3.2 / §4.1 |
| `08-candidate-matching-design.md` | Candidate matching as-designed (Arch A/B) | §3 (MA3 extension) |
| `09-candidate-ingestion-and-browser-asbuilt.md` | As-built ingestion + Candidates UI; design-vs-realized | §3 / §4 |
| `10-frontend-and-ux.md` | UI, nav, Diana widget, Workspace, Projects, Candidates | §4.2 |
| `11-shared-services.md` | kb-service, mcp-service, websearch_server | §4 (platform) |
| `12-infrastructure-and-monitoring.md` | Containers/networks, deployment, live health map | §4 |
| `13-performance-optimization-embedder-rca.md` | The embedder OOM RCA + slot-cap fix (perf-opt component) | §3 / §6 |
| `14-evaluation.md` | Mandated baselines, metrics, qualitative, A/B | §5 |
| `15-critical-discussion.md` | What worked/failed, trade-offs | §6 |
| `16-arc-reflection.md` | Which stage mattered; wash-out analysis | §7 |
| `17-reproducibility-and-run.md` | Repo, requirements, seeds, run, A1/A2 links | Deliverable / §8 |
| `18-appendix-reference.md` | Endpoint map, config, glossary, inventory | Appendices |

---

## How the assignment maps onto this set

The MA3 brief requires a system built on the A1/A2 model that **integrates at least
two additional course techniques**, with a report covering the pipeline arc, system
design, implementation, evaluation against mandated baselines, critical discussion,
and a three-assignment reflection. This set covers all of that:

- **Arc** (`02`, `16`); **the integrated components** (`04`, deepened in `06`, `07`,
  `13`, `14`); **implementation** (`03`, `05`–`13`); **evaluation** (`14`);
  **critical discussion** (`15`); **reflection** (`16`); **reproducibility** (`17`).
- The two-component minimum is exceeded: **RAG**, **agentic tool-use**,
  **LLM-as-judge**, and **performance optimization** are all present and justified.
