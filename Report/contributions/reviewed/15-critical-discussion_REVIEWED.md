# 15. Critical Discussion

Honest reporting of failures and limitations is explicitly rewarded by the brief, so
this section is deliberately candid.

## 15.1 What worked

- **End-to-end pipeline.** Plain-language request → conversational memory → role +
  section + domain resolution → A2 draft + gemma composition + hybrid RAG → live cited
  tabs, verified working.
- **Grounding with provenance.** Citations resolve to a PDF page + bounding box for
  graph-grounded chunks, in chat and in documents.
- **Agentic routing.** LLM-decided section selection, the ask-back guard for
  under-specified requests, and a grounded closing note that surfaces coverage gaps
  instead of hiding them.
- **The candidate foundation.** 210,048 CVs vector-indexed and **read-back verified**,
  with a working Candidates browser and a strong retrieval substrate.
- **Platform.** Shared services extracted (kb-service, mcp-service, websearch_server);
  Projects with private/shared access + full-fidelity replay; a live, self-documenting
  infrastructure health map; event-driven (no-polling) updates throughout.
- **A real performance win.** The shared-embedder OOM root-caused and fixed, stress-
  verified flat under the exact concurrency that crashed it four times.
- **The mandated baseline comparison, executed.** The (a)/(b)/(c) run (§14.3) shows the
  expected arc — base mean 1.85, alignment jump to 4.28, full system 4.62 with its value
  in routing/grounding/refusal rather than a higher offer score.

## 15.2 What didn't work / honest limitations

- **`match_candidates` and conditional composition are not wired.** The headline §08
  design — the tool, the threshold-gated branch, the 7th "Candidate Matches" bundle
  section, candidate-aware downstream — is **deferred**. What exists is the retrieval
  substrate + a human-facing browser. This is the single biggest gap between
  as-designed and as-built (§09.6).
- **Per-section KB domains are not differentiated.** All four sections currently
  ground on the *single* resolved onboarding domain; dedicated interview-bank /
  culture / benefits corpora are not yet provided, so e.g. Cultural & Team Fit grounds
  on onboarding material — an approximation, not the final design.
- **One onboarding family is still missing** (`embedded`); ten of eleven exist. (This
  is far better than the older docs' "2 of 11," but not complete.)
- **Routing is good but not perfect (9/10).** In the executed run, "data engineer"
  resolved to `jobs_onboard_general` instead of `jobs_onboard_data`, and one full-pack
  request was classified Job-Offer-only (segregation 9/10). Both are LLM-classifier
  judgment calls on borderline phrasings, not crashes (§14.3).
- **The served A2 model occasionally truncates.** On one offer case it returned in
  0.31 s with incomplete structure (the documented MA2 early-EOS under
  `repetition_penalty`) — the small specialist's inference is sensitive.
- **gemma judges its own output.** No cross-judge isolation — a known compromise,
  doubly relevant given MA2's documented judge-discrimination ceiling; the (c) judge
  scores in §14.3 carry this self-judging bias.
- **Two wrong diagnoses before the embedder fix.** Token-budget and Cyrillic theories
  were announced as fixes and did not hold; only controlled reproduction found the
  slot cause (§13). Reported, not hidden.
- **Buffer-save is a stub.** `/api/buffers/{id}/save` acknowledges but does not persist
  (work survives via Projects replay, but the per-buffer save is incomplete).
- **Audio is proxy-only.** STT/TTS/avatar route via `logus2k.com/job2cool`, not
  `localhost:4920` (explicit decision not to modify nginx for local audio).
- **Company Profile** nav item is a placeholder.
- **Browser visual-verification pass pending** (split-PDF render, voice on the proxy,
  project replay verified at the data layer but not yet eyeballed end-to-end).

## 15.3 Trade-offs

- **`think=False` on utility calls** — necessary (gemma otherwise returns empty after
  spending its budget in `<think>`), but it denies those classification/summarisation
  steps any chain-of-thought, possibly capping their quality. A genuine
  capability-vs-works trade-off (§06.9).
- **LLM-decided pipeline vs predictability** — flexible for ambiguous/iterative
  requests, but harder to test deterministically and occasionally mis-routes (the 9/10
  routing and segregation above).
- **Shared-service reuse vs autonomy** — the B1/copy-only strategy saved enormous
  build effort but created an infrastructure dependency and forced *additive-only*
  changes (new endpoints rather than edits, e.g. §9.4), and already required one
  authorised exception. It also means a shared embedder whose concurrency behaviour
  bit the bulk job (§13).
- **Slot cap: memory vs parallelism** — capping bge-m3 to one slot bounds memory under
  any load but serializes concurrent embeds (latency under simultaneous use). For this
  workload the right call; on a write-heavy multi-tenant embedder it might not be.
- **Two co-resident models vs one** — keeping the 360M specialist *and* gemma costs a
  little GPU residency but preserves the arc (the A2 model stays a live component)
  rather than dissolving it into a bigger model.

## 15.4 What we'd do differently / next

1. **Wire `match_candidates` + conditional composition** — the largest value step;
   the substrate is ready.
2. **Differentiate KB domains per section** (interview banks, culture, benefits) and
   add the missing `embedded` onboarding domain.
3. **Harden the role classifier** on the borderline cases the run surfaced
   (data-engineer routing, full-pack segregation).
4. **A dedicated judge** on a separate slot to restore cross-judge isolation and remove
   the self-judging bias.
5. **Persist buffers** (remove the save stub) and complete the browser-verification
   pass.
6. **Activate the Company Profile** page; finish the placeholder surfaces.
7. **Consider a unified post-merge rerank** across vector+graph evidence (§7.1).
