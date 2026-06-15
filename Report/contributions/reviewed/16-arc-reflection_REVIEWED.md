# 16. Reflection on the Three-Assignment Arc

This reflection is part of the grade: which stage contributed most, and were earlier
stages washed out by later ones?

## 16.1 The A1/A2 work is directly visible, not diluted

`ma2-360m-dpo-b01` is **literally the Job-Offer drafter inside the running system**,
not a discarded checkpoint. The arc is honest: A1 made a 360M model fluent in
job-posting language (in-domain perplexity 16.37 → 11.38); A2 taught it to follow
recruiter instructions and aligned its output to a quality rubric (SFT val perplexity
4.54; DPO-b01 the β=0.10 deliverable, 8-0 win-rate vs SFT); A3 placed that specialist
inside a system that can finally *use* it on a real task. The executed baseline run
(§14.3) quantifies this directly: the aligned model lifts mean Job-Offer quality from
**1.85** (base) to **4.28** on the gemma-4 rubric — the single largest jump in the arc.

## 16.2 Did RAG make domain adaptation redundant?

**No — they operate on different axes, and that is the key insight.** A1/A2 improved
the *writing quality and structure of one output* (the Job Offer) in isolation. RAG
addresses what no amount of fine-tuning a 360M model can supply: knowledge of the
**company's actual material** (onboarding, interviews, culture), and **verifiable
provenance** (a claim traced to a PDF page + bbox). A fine-tuned model can write a
fluent onboarding plan; it cannot write *this company's* onboarding plan, nor prove
where a requirement came from. RAG and the aligned model are therefore
**complementary, not substitutes** — RAG did not moot the domain adaptation, it
covered a different need.

There is a subtler wash-out candidate, though: domain adaptation (A1) overlaps with
RAG *for the Job-Offer section specifically*, because the retrieved company material
could in principle teach gemma the posting style that A1 baked into the 360M model.
The honest position is that A1's contribution is most clearly *non-redundant* for the
**A2 instruction-following + alignment** it enabled, and least clearly so for raw
posting fluency once a 4B model with RAG is in the loop — a tension worth stating
rather than papering over.

## 16.3 Was the A2 alignment washed out by gemma's composition?

This is the sharpest question, and the system is built to answer it: when both are
selected, the **raw A2 draft and the gemma-composed Job Offer are produced
side-by-side** (the §06.6 toggle, the §14 (b)-vs-(c) comparison). **The executed run
measures it.** Mean offer quality barely moves from (b) to (c) (4.28 → 4.62), and an
order-swapped pairwise judge over the ten offer cases returns **Gemma-better 5, Tie 4,
MA2-better 1**.

The reading the data supports is **partial masking**. gemma's composition refines the
prose and grafts in retrieved evidence and citations — and wins outright in half the
cases — but the A2 draft survives as a tie or better in the other half, and its
*structure* (the four required Markdown sections, aligned to recruiter preferences)
persists as the seed the composer builds on in **every** case. The value of A2 in this
architecture is a fast (~0.7 s), structurally-correct, aligned seed that anchors the
composition, not the source of the final wording. Reporting that partial masking openly
— rather than claiming the 360M model dominates the output — is the honest reading.

## 16.4 Which stage contributed most to the *final system*?

For the **final system's usefulness**, **A3 (this stage) contributed most** — it is
the orchestration, retrieval, grounding, and platform that turned an aligned drafter
into something a recruiter can actually use, and the executed run shows where that
value lives: in the **system-only capabilities** (routing 9/10, 100% resolvable
citations, faithfulness 0.97) rather than in a higher offer score. For the **specific
quality of the Job Offer deliverable**, **A1+A2** contributed most (the 1.85 → 4.28
jump). These are not in competition: the project's whole thesis is that the final
stage's value is in **making the aligned model usable**, not in replacing it. An
aligned model with no system is a good drafter no one can operate; a system with no
aligned model has no specialist at its core. The arc is additive end to end.

## 16.5 Honest closing assessment

job2cool is, above all, an **orchestration + grounding + platform layer** on top of
the MA1/MA2 model. Its contribution is breadth (a usable, grounded, monitored,
multi-document system) rather than a further leap in the 360M model's intrinsic
quality. The most defensible single sentence: *the final stage did not make the
earlier stages redundant; it gave them somewhere to be useful* — with the one caveat,
now **measured** rather than assumed (§14.3): gemma's composition partially masks A2's
stylistic fingerprint in the final Job-Offer prose (Gemma 5 / Tie 4 / MA2 1), while the
A2 structure survives as the seed in every case.
