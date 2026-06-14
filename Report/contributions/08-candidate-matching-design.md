# 8. Candidate Matching — Design (Architecture A vs B)

## 8.1 The HR-workflow sequence (why this exists)

From the recruiter's perspective, generating a hiring package is only the first half
of the job. Once Diana has produced the Job Offer for a role, the natural next
question is **"who do we already have who fits this?"** Candidate matching closes
that loop and **graduates job2cool from a *Hiring-Package generator* into a
*recruiter-workflow assistant*.** The intended end-to-end sequence is:

```
recruiter brief
   → parse the role spec                         (role family, seniority, skills, English)
   → draft the Job Offer                          (A2 specialist + gemma)
   → match_candidates(role_spec, top_k, filters)  (search the internal CV pool)  ← NEW
   → IF a strong internal candidate exists:
        tailor Interview / Onboarding / Welcome-Kit to that candidate's gaps & seniority
     ELSE:
        produce role-generic downstream sections
   → assemble the bundle (+ a Candidate Matches section)
```

The conditional is the point: after retrieving candidates, the orchestrator
*examines their match quality and decides* whether downstream sections are composed
candidate-aware or role-generic. That decision — reasoned about and verbalised in the
orchestrator's scratchpad — is what turns a deterministic pipeline into a
**state-dependent agent**, and it is the form of advanced reasoning + multi-step
planning the assignment names.

> This section documents the **as-designed** architecture (from
> `documents/candidates_technical_architecture.md`). What is **built today** —
> vector-only ingestion + a Candidates browser, with `match_candidates` deferred —
> and how the design was deliberately corrected against the real data, is in §09.

## 8.2 The candidate corpus

The internal CV pool is simulated by the English subset of
**`lang-uk/recruitment-dataset-candidate-profiles-english`** (HuggingFace, MIT,
Djinni, 2020–2023): **210,250 anonymised candidate profiles**, ~237 MB Parquet. It is
the **candidate-side sibling** of the Djinni *jobs* corpus that A1/A2 trained on —
same publisher, same platform, same era — so all three assignments consume subsets of
one release: jobs for model training, candidates for retrieval-side matching.

**Schema** (selected): `Position`, `Moreinfo`, `Looking For`, `Highlights`,
`Primary Keyword` (role family), `English Level` (`no_english`..`fluent`),
`Experience Years` (numeric), `CV` (full body), `id`.

**Schema alignment — the load-bearing property.** Three fields share *identical
vocabularies* with the jobs corpus: role family (`Primary Keyword`), English level,
and experience. So a posting that requires `Primary Keyword == Backend`,
`English ≥ upper`, `Experience ≥ 3y` filters **directly** into a candidate query on
the same fields, with no schema translation. This is exactly why the structured
fields are stored as queryable metadata (§09).

## 8.3 The `match_candidates` tool (designed)

A tool taking a `role_spec` (role family, seniority, required/nice-to-have skills,
`english_level_min`, location/remote) plus `top_k` and a `score_threshold`, returning
ranked `CandidateMatch` objects (structured fields + synthesised summary + match
score + explicit matching/missing skills). Its retrieval is the **three-stage hybrid
form**:

1. **Structured pre-filter.** A ChromaDB `where` clause —
   `Primary Keyword == role_family ∧ English ≥ min ∧ Experience ≥ seniority→years` —
   narrows 210k candidates to a qualified subset *before any vector math*. Exact,
   fast, decoupled from the embedding model.
2. **Vector search.** Within the filtered subset, top-N by cosine similarity between
   the role description and CV embeddings (bge-m3).
3. **Rerank.** The top-N `(role, candidate)` pairs through bge-reranker-v2-m3; keep
   `top_k`. The reranker's normalised score is the **match score**; the
   `score_threshold` (default 0.65) is the single knob controlling how often the
   conditional branch fires.

A lightweight skill-overlap pass (glossary regex over the CV body) produces the
`matching_skills` / `missing_skills` lists for presentation — *not* for ranking.

## 8.4 Conditional bundle composition (designed)

After `match_candidates` returns, the orchestrator branches:

- **With a candidate** (best ≥ threshold): the top candidate is passed as context to
  the downstream retrieval — Interview focuses on `missing_skills`, Onboarding
  calibrates to seniority + prior stack, Welcome-Kit to location/remote — and the
  routing decision is verbalised into the bundle's Sources section for transparency.
- **Without a candidate**: downstream sections are role-generic, and the Candidate
  Matches section explains that no internal candidate cleared the threshold and
  recommends external sourcing.

The bundle grows from six to **seven** top-level sections, adding **Candidate
Matches**.

## 8.5 Architecture A vs B (the academic frame)

The candidate-matching layer is exclusive to **Architecture B** (full RAG +
infrastructure). **Architecture A** is the edge-deployment floor — self-contained,
no infrastructure — and *by constraint* cannot host the candidate corpus, the
retrieval stack, or the tool registry; its bundle stops at deterministic-template
downstream sections with no Candidate Matches at all. The comparison is honest and
deployment-driven: where infrastructure exists, B's output is strictly richer (the
extra section + candidate-tailored downstream); where it does not, A produces a
viable but generic bundle. The gap *quantifies the value of the infrastructure* for
this workflow — which is precisely the integration story this final assignment asks
for.

## 8.6 Component impact (within the brief)

The candidate layer does not add a new course bucket; it **deepens** the ones already
claimed: RAG goes from "vector + rerank, single search" to **full hybrid (structured
pre-filter + vector + rerank)**; tool-use goes from a fixed sequence to
**state-dependent branching / genuine multi-step planning**; reasoning goes from
"think step by step" to **conditional reasoning over retrieval results with the
routing decision verbalised**; and LLM-as-judge extends from pairwise bundle scoring
to **per-section scoring** (bundles now vary in shape). This is the depth that lifts
three of the integrated components from present to *strong*.
