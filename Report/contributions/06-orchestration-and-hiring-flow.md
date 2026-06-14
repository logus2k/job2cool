# 6. Orchestration & the Hiring-Package Flow

The agentic component lives in `backend/orchestrator.py`. `run_chat(message,
history, config)` is an **LLM-decided** pipeline — every routing decision is a model
call with a tight contract, not a rule or a regex. The steps below run per turn and
stream their progress to the Diana chat over SSE.

## 6.1 Resolve the need (conversational memory)

`_resolve_need` rewrites the recruiter's message into a self-contained sentence using
the last several turns — folding role and skills mentioned earlier into the current
ask (so "now make it remote-friendly" becomes a complete request). Falls back to the
raw message if rewriting fails. **This is the memory component**: an isolated aligned
model has none.

## 6.2 Extract the role (ask-back guard)

`_role_label` extracts the job title with gemma (`think=False`, `max_tokens` tiny).
If no concrete position is found, **Diana asks which role and returns early,
generating nothing** — the system refuses to fabricate a package for an unspecified
role.

## 6.3 Resolve the KB domain

`resolve_onboard_domain` LLM-classifies the role into one of the eleven
`ONBOARD_FAMILIES`, then checks `available_corpus_domains` (a lazy,
process-lifetime cache of the live `*__corpus` collections) to confirm the matching
`jobs_onboard_<family>` actually exists, with a fallback chain `→ jobs_onboard_general
→ any existing jobs_onboard_* → default`. Routing is grounded in what the KB *really*
contains, not in an assumption.

## 6.4 Select the deliverables

`_requested_sections` LLM-classifies which of {offer, interview, onboarding, culture}
the request asks for (`think=False`). "Write a job description" → `offer` only; a
generic hiring need → all four. This **replaced an earlier keyword heuristic** that
mis-fired on substrings (e.g. "full-stack" falsely matching a "full package"
trigger) — a concrete case of moving a brittle rule to an LLM decision.

## 6.5 Stream the reasoning intro

gemma streams a short conversational intro (`llm_stream`, `INTRO_SYSTEM`,
`temperature≈0.5`) confirming the role and the deliverables. The **raw** stream
(including `<think>…</think>`) is forwarded to cv-chat, where `ThinkingParser`
renders the reasoning live in the Thinking panel; a `<voice>…</voice>` tag is
appended so the avatar speaks a brief summary rather than the whole answer. This is
the one place thinking is intentionally streamed.

## 6.6 Compose each requested section

For each requested deliverable, in order:

1. **Lazy tab.** A live buffer (= a Workspace tab) is created immediately before the
   section generates, so tabs appear and focus one-by-one as sections complete.
2. **Retrieve.** `graph_and_vector_search` runs **concurrent** vector + graph
   retrieval over the resolved domain (§07).
3. **A2 draft (Job Offer only).** If the section is `offer` and `ma2 ∈
   offer_sources`, the A1/A2 specialist drafts the offer via `llm_complete`
   (`DPO_MAX≈1200`). If both MA2 and gemma are selected, the **raw A2 draft is
   written to a separate "Job Offer (MA2)" buffer** so the UI can toggle between the
   specialist draft and the gemma-composed version — a built-in A/B view that §14
   uses to ask whether composition preserves or degrades the aligned draft.
4. **Compose.** gemma composes the section (`SECTION_SYSTEM`, `SECTION_MAX=8192`,
   `temperature≈0.4`); when an A2 draft exists it is included as a "refine this
   DRAFT" prompt rather than discarded.
5. **Write + cite.** `buffers.replace` writes the finished section to the live
   buffer; `_cited_sources` appends a clickable Sources line using
   `[markdown_chunk:hex]` tags from the graph excerpts (falling back to plain
   filenames when no resolvable excerpt exists).

## 6.7 Close with a grounded coverage note

`_closing_note` emits a three-part message: (1) a **deterministic** confirmation of
what landed in the Workspace and which KB domain was used; (2) **one LLM sentence**
(`think=False`) grounded in the actual retrieved evidence, flagging where KB coverage
was thin; (3) a nudge toward the not-yet-requested deliverables. This makes coverage
gaps visible to the recruiter instead of hiding them behind confident prose.

## 6.8 Record the turn (judge + graph)

`cache.put_turn` records the full turn — question, evidence, thinking, documents,
answer, entities, edges, domains — keyed by `turn_id`. This backs `/api/graph_trace`
(the 3D graph of the turn) and `/api/score_answer` (the RAGAS judge, §4.3) **without
re-querying** the engines.

## 6.9 The `think=False` discipline (an implementation-vs-model trade-off)

Every non-streaming utility call sets `think=False`. The reason is concrete:
gemma-4, left to reason, spends its whole output budget inside `<think>` and returns
empty visible content — so role/section classification, query rewriting, domain
resolution, the closing note, and the judge would all silently produce nothing. The
cost is that those steps cannot use chain-of-thought, which may cap classification
quality; the benefit is that they work at all. This is exactly the kind of
"latency/quality vs capability" trade-off the rubric asks to be surfaced, and it
recurs in §15.

## 6.10 Why dynamic (not a fixed pipeline)

HR requests are ambiguous and variable. A fixed pipeline would force all four
documents on every request, could not honour "just the job offer," and could not
support follow-ups that depend on earlier context. The LLM-decided design buys
flexibility at the cost of determinism (harder to unit-test) — the trade-off
recorded in §15. It is also the concrete realisation of the "multi-step planning"
the assignment's tool-use/agentic bucket names, and the foundation the
candidate-matching design (§08) extends into state-dependent branching.
