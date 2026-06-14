# 16. Reflection on the Three-Assignment Arc

This reflection is part of the grade: which stage contributed most, and were earlier
stages washed out by later ones?

## 16.1 The A1/A2 work is directly visible, not diluted

`ma2-360m-dpo-b01` is **literally the Job-Offer drafter inside the running system**,
not a discarded checkpoint. The arc is honest: A1 made a 360M model fluent in
job-posting language (in-domain perplexity 16.37 → 11.38); A2 taught it to follow
recruiter instructions and aligned its output to a quality rubric (SFT val perplexity
4.54; DPO-b01 the β=0.10 deliverable, 8-0 win-rate vs SFT); A3 placed that specialist
inside a system that can finally *use* it on a real task.

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
side-by-side** (the §06.6 toggle, the §14 (b)-vs-(c) comparison). Two outcomes are
possible and both are informative:

- If gemma **lightly refines** the A2 draft, the alignment shows through and A2's
  contribution is preserved in the final output.
- If gemma **heavily rewrites** it, the visible Job Offer is mostly gemma's, and A2's
  alignment is **partially masked** in the end product — even though A2 still seeded
  the draft and shaped the structure.

The honest expectation, given a 4B composer refining a 360M draft, is *some* masking:
the final prose will lean gemma. The value of A2 in that case is as a **fast,
structurally-correct, aligned seed** that anchors the composition — not as the source
of the final wording. The §14 A/B run is what will quantify this; reporting that
masking openly (rather than claiming the 360M model dominates the output) is the
honest reading.

## 16.4 Which stage contributed most to the *final system*?

For the **final system's usefulness**, **A3 (this stage) contributed most** — it is
the orchestration, retrieval, grounding, and platform that turned an aligned drafter
into something a recruiter can actually use. For the **specific quality of the Job
Offer deliverable**, **A1+A2** contributed most. These are not in competition: the
project's whole thesis is that the final stage's value is in **making the aligned
model usable**, not in replacing it. An aligned model with no system is a good
drafter no one can operate; a system with no aligned model has no specialist at its
core. The arc is additive end to end.

## 16.5 Honest closing assessment

job2cool is, above all, an **orchestration + grounding + platform layer** on top of
the MA1/MA2 model. Its contribution is breadth (a usable, grounded, monitored,
multi-document system) rather than a further leap in the 360M model's intrinsic
quality. The most defensible single sentence: *the final stage did not make the
earlier stages redundant; it gave them somewhere to be useful* — with the one caveat,
stated plainly, that gemma's composition likely masks some of A2's stylistic
fingerprint in the final Job-Offer prose, which §14 measures rather than assumes.
