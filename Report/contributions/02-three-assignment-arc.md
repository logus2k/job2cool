# 2. Pipeline Overview — the A1 → A2 → A3 Arc

This project is a single pipeline in three stages, from a generic pretrained model
to the deployed system documented here. Each stage adds a capability without
discarding the previous one.

```
 raw SmolLM2-360M
      │  A1: continued pretraining on ~12k IT job postings (Djinni)
      ▼
 domain-adapted 360M  (job-posting fluent; PPL 16.37 → 11.38 in-domain)
      │  A2: SFT (≈7.5k instruction pairs) → DPO (RLAIF, β=0.10)
      ▼
 ma2-360m-dpo-b01  (instruction-following Job-Offer specialist)
      │  A3: wrap in a system — RAG + agentic orchestration +
      │      LLM-as-judge + performance optimization
      ▼
 job2cool / Diana   (multi-model orchestration, hybrid RAG over a company KB,
                     candidate corpus, cited live documents, web UI)
```

> **Reviewer note.** The "A3 / job2cool" box at the bottom is not a black box: it
> expands into the **live dependency graph** documented and continuously
> health-monitored by the system itself (see §12 and the running *Help & Support*
> service map). That map is a concrete, always-current rendering of exactly what
> "wrap the aligned model in a real system" came to mean — the A2 model
> (`ma2-360m-dpo-b01`) is one node, co-resident on `agent_server` with the gemma-4
> orchestrator, surrounded by the retrieval engines, KB gateway, tool host, identity
> proxy, and voice stack the final stage added.

## 2.1 A1 — domain adaptation

Mini-Assignment 1 continued the pretraining of **SmolLM2-360M** on roughly **12,000
IT job postings** from the Djinni dataset, moving the model's language distribution
toward the vocabulary and structure of job postings. Under identical conditions,
**LoRA** beat full fine-tuning on in-domain perplexity (**11.38 vs 13.12**, against
a base of **16.37**) while training only **~2.3%** of parameters in roughly a third
of the time. Out-of-domain perplexity (LinkedIn postings) was essentially unchanged
for both, confirming the adaptation was IT-specific rather than general drift. The
merged LoRA checkpoint became the A2 starting point.

*(A1 specifics are owned by the MA1 report; the numbers above are carried for arc
continuity and should be cross-checked against that report.)*

## 2.2 A2 — alignment

Mini-Assignment 2 turned that domain-fluent-but-instruction-blind checkpoint into a
recruiter-instructable drafter. **SFT** on ~**7,500** request→posting pairs (an
Alpaca-style template, teacher-distilled) drove validation perplexity to **~4.46**
and made the model reliably emit the four Job-Offer sections (Summary / Required
Skills / Responsibilities / Requirements) in Markdown. **DPO** via RLAIF then ranked
sampled candidates against a rubric (faithfulness, structural completeness, language
quality, no repetition); a sweep over four β values peaked at **β = 0.10**, yielding
**`ma2-360m-dpo-b01`** — better than the base in most comparisons and a consistent
improvement over the SFT model without loss of fluency.

Two A2 findings carry directly into A3:

1. **Template- and inference-sensitivity.** The aligned model's behaviour depends
   strongly on the prompt template and on inference parameters — notably the
   **repetition penalty**, whose absence caused repetition collapses. A3 must keep
   the same inference rigour when calling the model through a new orchestration
   layer (we surface this as the `offer_sources`/draft path in §06).
2. **Judge discrimination ceiling.** A smaller judge model distinguished broad
   comparisons (base vs aligned) well but was unreliable on close comparisons
   between similar checkpoints. This motivates A3's evaluation design not relying on
   a single judge (§14) and frames the honest limitation that gemma currently judges
   its own outputs (§15).

## 2.3 A3 — the system

Mini-Assignment 3 uses `ma2-360m-dpo-b01` **exactly as delivered**, assigning it a
specific role: it drafts Job Offers. Everything else — interpreting the
conversation, resolving the KB domain, deciding which documents to produce,
retrieving evidence, composing each section (including refining the A2 draft), and
attaching citations — is handled by the orchestration layer and the **gemma-4**
general model. Retrieval and orchestration operate on a *different axis* from A1/A2:
A1/A2 improved the quality of one output (the Job Offer) in isolation; A3 addresses
what an isolated aligned model cannot, regardless of its quality — knowledge of the
company's actual material, determining what a request asks for, holding context
across a conversation, and proving via citation that a claim has an identifiable
source.

## 2.4 Model-choice justification (why a second model)

The assignment permits switching to a different open-source model "and justifying
the change clearly," or running a further adaptation pass. job2cool does **neither
as a replacement**: it **retains** the A2 model and **adds** gemma-4 alongside it.
The justification is capability-vs-task fit:

- **The A2 model is a 360M-parameter specialist.** It is excellent and fast at the
  one task it was aligned for (NL need → Markdown Job Offer, ~430 tok/s, ~0.7 s),
  but it cannot orchestrate: it has no tool-use, no long-context reasoning over a
  multi-step plan, and no general composition ability for onboarding/interview/
  culture content. Asking a 360M model to drive the whole pipeline would fail.
- **gemma-4 is the open-source orchestrator** (4B-class, 128K context, vision +
  reasoning), already proven on this stack. It runs the agentic plan, composes the
  RAG-grounded sections, and refines the A2 draft.
- Both are **co-resident on `agent_server`**, selectable per request by model id —
  so the specialist and the orchestrator coexist rather than one superseding the
  other. This is the honest reading of the arc: the final system is an
  **orchestration + grounding layer** that makes the aligned model *usable*, not a
  larger model that makes it redundant. §16 tests whether gemma's composition step
  masks the A2 alignment in the final output.

This choice is what `02` hands to §14 (the three-way baseline: base SmolLM-360M vs
`ma2-360m-dpo-b01` alone vs the full system) and to §16 (the wash-out question).
