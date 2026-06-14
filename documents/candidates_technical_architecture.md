# Technical architecture: candidate matching via RAG

## 1. Purpose and scope

This document specifies the candidate-matching extension to the MA3 recruiter workflow architecture described in [ma3_architecture.md](ma3_architecture.md) and [rag_implementation.md](../rag_implementation.md). It covers the candidate corpus, the noted Domain that hosts it, the hybrid retrieval tool that queries it, the conditional bundle composition workflow that consumes its results, and the bundle output extension that surfaces those results to the recruiter.

The headline change is that Architecture B graduates from a Hiring Package generator into a recruiter workflow assistant. After producing the Job Posting from the recruiter brief, the system optionally retrieves the most promising candidates from the company's internal CV pool. When at least one candidate clears a configurable match threshold, the downstream sections (Interview Process, Onboarding Plan, Welcome Kit) are composed candidate-aware rather than role-generic.

The architecture itself, the b01 specialist on Architecture A, and the broader six-section bundle contract are unchanged. This document specifies only the new capability and the orchestrator routing changes it requires.

## 2. The candidate corpus

### 2.1 Source

The corpus is the English subset of `lang-uk/recruitment-dataset-candidate-profiles-english` on HuggingFace. Published May 2024 at the Third Ukrainian NLP Workshop, UNLP @ LREC-COLING 2024. MIT license. Sourced from the Djinni IT job platform, covering anonymised candidate profiles posted on the platform between 2020 and 2023.

This is the candidate-side sibling of the `djinni2024` jobs release used in MA1 (continued pretraining on raw job descriptions) and MA2 (SFT and DPO over the same corpus). Same publisher, same platform, same era. All three assignments therefore consume subsets of one publisher's release: jobs for model training in MA1 and MA2, candidates for retrieval-side matching in MA3.

### 2.2 Scale

210,250 candidate profiles, approximately 237 MB on disk as a single Parquet split. Larger than the 141,897-row jobs corpus, which is expected since one job posting attracts many applicants on the platform.

### 2.3 Schema

| Column | Type | Semantics |
|---|---|---|
| `Position` | string | Candidate's self-declared current or target title |
| `Moreinfo` | string | Free-text profile expansion |
| `Looking For` | string | Candidate's preferences regarding role, work style, salary range |
| `Highlights` | string | Self-reported notable achievements |
| `Primary Keyword` | string | Role family (Backend, Frontend, QA, etc.), same vocabulary as the jobs corpus |
| `English Level` | enum | One of `no_english`, `pre`, `basic`, `intermediate`, `upper`, `fluent` |
| `Experience Years` | numeric | Years of experience claimed by the candidate |
| `CV` | string | Full CV body text |
| `CV_lang` | string | Language code; filtered to `en` for this subset |
| `id` | string | Unique candidate identifier |

### 2.4 Schema alignment with the jobs corpus

Three columns are common to both datasets, with identical vocabularies:

| Field | Jobs schema | CVs schema |
|---|---|---|
| Role family | `Primary Keyword` | `Primary Keyword` |
| English level | `English Level` | `English Level` |
| Experience | `Exp Years` (categorical: `no_exp`, `1y`, `2y`, `3y`, `5y`) | `Experience Years` (numeric) |

This alignment is the load-bearing property for hybrid retrieval. A job posting that requires `Primary Keyword == Backend`, `English Level >= upper`, `Experience >= 3 years` filters directly into a candidates query on the same fields, with no schema translation needed. The categorical-to-numeric mapping on the experience field is a one-line transform.

## 3. Role in the recruiter workflow

The candidate-matching layer sits between the Job Posting composition step and the downstream tailored sections. The full workflow in Architecture B becomes:

```
recruiter_request
  → parse_request(recruiter_request)               : role_spec
  → get_salary_band(role_spec)                     : compensation
  → graphrag_search(role_spec, content_domains)    : job_posting

  → match_candidates(role_spec, top_k=5, filters)  : candidates

  if candidates and best.score >= MATCH_THRESHOLD:
      → graphrag_search(interview, focus=best.skill_gaps)
      → graphrag_search(onboarding, calibrate_to=best.seniority)
      → graphrag_search(welcome_kit, calibrate_to=best.location)
  else:
      → graphrag_search(interview)
      → graphrag_search(onboarding)
      → graphrag_search(welcome_kit)

  → compose_bundle(...)                            : final_bundle
```

The conditional is the key step. It turns the workflow from a deterministic pipeline into a state-dependent agent: the orchestrator examines the retrieved candidates, decides whether their match quality warrants candidate-aware downstream composition, and proceeds accordingly. This is the form of Chain-of-Thought reasoning the MA3 brief calls advanced reasoning; it is also the form of agentic behaviour the brief calls multi-step planning.

The orchestrator's reasoning is verbalised explicitly in its system prompt. Before each downstream call it states, in its scratchpad, whether a candidate is in scope and how that candidate shapes the downstream retrieval query. This verbalisation is what earns the Chain-of-Thought component classification; the orchestrator is not just sequencing tool calls, it is reasoning about state and explaining its routing decisions.

## 4. RAG integration

### 4.1 New noted Domain

A single new Domain is created in the noted Domain Manager:

- Slug: `jobs_candidates_pool`
- Source: the 210,250-row Parquet, downloaded into `data/jobs/djinni_candidates/`
- Ingestion stack: same as the existing 19 thematic Domains (noted-graph PDF/text ingestion plus noted-rag ChromaDB indexing, bge-m3 embeddings, bge-reranker-v2-m3 reranker)

The Domain co-exists with the 19 existing content Domains. The orchestrator routes by Domain slug: the candidates Domain is consulted only by the `match_candidates` tool, never by `graphrag_search`. Keeping the routing this way prevents accidental retrieval of CV chunks when the orchestrator is composing the Job Posting or any other section grounded in reference content.

### 4.2 Chunking strategy

CV documents are structurally different from the reference documents in the other 19 Domains. A typical CV is a 500 to 2000-word self-contained narrative with a clear internal structure (Position, Highlights, Looking For, free-text CV body). Three chunking options were considered:

1. Single chunk per CV. Treat the entire concatenated profile as one document. Embedding loses fidelity for long CVs but every retrieved chunk is a self-contained candidate, with no reassembly needed at query time.
2. Section-chunked. Split the profile into Position / Highlights / Experience / Looking For chunks, all tagged with the same `candidate_id`. Retrieval can fire on a Highlights match while still surfacing the full candidate at query time by grouping on `candidate_id`.
3. Sliding window over the CV body. Standard for long technical documents but inappropriate here, since the atomic retrieval unit is "this candidate", not "this paragraph from this candidate".

The recommended strategy is section-chunked. The bge-m3 context window (8192 tokens) easily accommodates an entire CV, but section-chunked retrieval gives sharper signal per chunk and lets the reranker score on the most relevant section rather than the diluted whole-CV embedding. Group-by-`candidate_id` at query time yields the full candidate's profile for downstream composition.

### 4.3 Structured field indexing

The structured fields (`Primary Keyword`, `English Level`, `Experience Years`, `Position`) are indexed as ChromaDB metadata alongside the vector embeddings. This is what makes the pre-filter step in hybrid retrieval cheap: the candidates Domain can be filtered to "Backend role family, English at least upper, experience at least 3 years" before any vector similarity computation, reducing the vector search to a small qualified subset rather than the full 210k corpus.

## 5. The match_candidates tool

### 5.1 Tool schema

```json
{
  "name": "match_candidates",
  "description": "Retrieve the top-K candidates from the internal CV pool that best fit the role spec.",
  "input": {
    "role_spec": {
      "role_family": "string (mapped from Primary Keyword)",
      "seniority": "enum (junior, mid, senior, lead)",
      "required_skills": "List[string]",
      "nice_to_have": "List[string]",
      "english_level_min": "enum (no_english..fluent)",
      "location": "Optional[string]",
      "remote_ok": "bool"
    },
    "top_k": "int = 5",
    "score_threshold": "float = 0.65"
  },
  "output": {
    "candidates": "List[CandidateMatch]",
    "pool_size_after_filter": "int",
    "best_score": "float"
  }
}
```

`CandidateMatch` carries the structured fields, a one-paragraph synthesised summary of the candidate, the match score, and explicit `matching_skills` and `missing_skills` lists relative to the role spec.

### 5.2 Hybrid retrieval pipeline

The tool implements the three-stage hybrid retrieval the brief lists as the depth-marker for the RAG component bullet ("vector store, hybrid retrieval, re-ranking"):

#### 5.2.1 Stage 1: structured pre-filter

ChromaDB `where` clause on the candidates Domain:

```
Primary Keyword  == role_spec.role_family
English Level    >= role_spec.english_level_min
Experience Years >= seniority_to_years(role_spec.seniority)
```

This narrows 210k candidates to a few hundred or a few thousand depending on the role and seniority. The filter is exact, fast, and decoupled from the embedding model.

#### 5.2.2 Stage 2: vector search

Within the filtered subset, retrieve the top-N (N=50 by default) by cosine similarity between the role description embedding and the CV section embeddings (bge-m3, already in the noted-rag stack). Aggregate by `candidate_id`: each candidate's best-scoring section becomes their initial match score.

#### 5.2.3 Stage 3: rerank

Pass the top-N `(role_description, candidate_profile)` tuples through bge-reranker-v2-m3 (already in the noted-rag stack). The reranker is a cross-encoder; its scores are more reliable than the bi-encoder vector similarities for top-of-list ordering. Keep the top-`top_k` results.

Each stage uses infrastructure already standing up in noted-rag; no new components are required in the serving stack.

### 5.3 Match score and threshold

The reranker output is normalised to [0, 1] and exposed as the match score. The `score_threshold` defaults to 0.65 and is configurable per call. Candidates below the threshold are discarded; if no candidate clears it, the tool returns an empty list and the orchestrator falls back to the generic downstream path.

The threshold is the single knob controlling how often the conditional branch fires. In the MA3 benchmark we calibrate it against the candidate pool such that approximately half the prompts trigger candidate-tailored composition and half fall back to generic, giving the LLM-as-judge meaningful coverage of both branches.

### 5.4 Skill matching detail

The reranker scores semantic fit but does not return explicit skill overlap. For the `matching_skills` and `missing_skills` fields in each `CandidateMatch`, the tool runs a lightweight overlap check after the rerank stage: extract the candidate's mentioned skills from the CV body (regex over a small skill glossary seeded from the jobs corpus's most-frequent skill mentions, supplemented with a manually curated stack list), intersect with `required_skills` and `nice_to_have`. This is for downstream presentation in the bundle ("matches on Django, Postgres, AWS; gap on Kubernetes"), not for ranking; ranking remains the reranker's job.

Out-of-glossary skills will not be surfaced in the match detail but do not affect the reranker's match score, since the reranker operates on full text rather than on the glossary.

## 6. Conditional bundle composition

### 6.1 The branching decision

After `match_candidates` returns, the orchestrator inspects the result:

- If `candidates` is empty (no candidate cleared the threshold), the downstream sections are composed via role-family generic templates over the corresponding content Domains.
- If `candidates` is non-empty, the highest-scoring candidate (`best`) is passed as additional context to each downstream tool call.

The orchestrator's reasoning prompt is structured to make this branch explicit. It is asked to verbalise either "we have candidate X with profile Y; the downstream sections will be tailored to their experience and gaps" or "no candidate cleared the threshold; downstream sections will be role-generic". This verbalisation enters the audit trail and is rendered into the Sources section of the bundle for transparency.

### 6.2 With-candidate downstream

Interview Process retrieval is enriched with `focus_on_gaps = best.missing_skills`. The orchestrator asks the retrieval to surface interview-process content that probes the topics the candidate's CV claims thinly or does not claim. Generic interview templates for the role family are ranked lower in this branch.

Onboarding Plan retrieval is enriched with `calibrate_to_seniority = best.seniority` and `prior_stack = best.matching_skills`. A senior candidate with adjacent stack experience skips the foundational stages; a junior with different background needs more bridging. The 30 / 60 / 90 sub-sections are composed from Domain content with explicit ramp-speed annotations grounded in the candidate's profile.

Welcome Kit retrieval is enriched with `location = best.location` and `remote_ok = best.remote_ok`. Day 1 logistics (equipment shipping, time zone, in-office checklist, IT account provisioning timing) depend on these.

### 6.3 Without-candidate downstream

When no candidate clears the threshold, the downstream sections are role-generic: the orchestrator queries the same Domains but without candidate context. The output bundle still has all the standard sections; they are simply not personalised. The Candidate Matches section in this branch contains a one-paragraph note explaining that no internal candidate met the threshold and recommending external sourcing.

## 7. Bundle output extension

The bundle structure expands from the original six-section design (see [rag_implementation.md](../rag_implementation.md) §4) to seven top-level sections:

```
# {role_title}

## Role Summary

## Job Posting
   Required Skills / Responsibilities / Requirements

## Compensation
   Salary band + narrative

## Candidate Matches                           [NEW]
   Top-K candidates from the internal pool with match details,
   or fallback note when none cleared the threshold

## Interview Process
   Tailored to candidate gaps when present, generic otherwise

## Onboarding Plan (30 / 60 / 90)
   Calibrated to candidate seniority when present, generic otherwise

## Welcome Kit
   Calibrated to candidate location when present, generic otherwise

## Sources
   Inline citation list with retrieved Domains and the verbalised
   orchestrator routing decision
```

The Candidate Matches section, when populated, contains for each candidate:

- Candidate handle (the dataset's `id` field surfaced as a stable identifier)
- Match score
- Position, Experience Years, English Level, Primary Keyword
- One-sentence Looking For summary
- Matching skills relative to the role
- Missing skills relative to the role
- One short paragraph synthesising fit (composed by the orchestrator)

When the section is empty (no candidate above threshold), it contains a one-paragraph explanation and a recommendation to extend external sourcing.

## 8. Architecture A versus Architecture B

The candidate-matching layer is exclusive to Architecture B. Architecture A's design constraint, self-contained edge deployment with no infrastructure, directly forbids it: no candidate corpus on the edge, no retrieval stack, no tool registry. Architecture A's bundle stops at the deterministic-template downstream sections; it does not produce a Candidate Matches section at all.

This asymmetry is honest and frames the comparison cleanly:

- Architecture A is the floor. What can be done at the edge with no infrastructure: generate a job posting via the b01 specialist, look up a salary against a static table, render generic templates for the rest of the bundle.
- Architecture B is the ceiling. What can be done with full RAG, hybrid retrieval, structured tools, and a 4B orchestrator: produce the same bundle structurally, plus an additional Candidate Matches section, plus content-tailoring on Interview, Onboarding, and Welcome Kit when candidate context is available.

The gap quantifies the value of the infrastructure for this workflow. It is not a tuning question; it is a deployment-constraint question. Where infrastructure is available, Architecture B's output is strictly richer. Where it is not, Architecture A produces a viable but generic bundle.

## 9. Component impact within the MA3 brief

The candidate-matching layer does not add a new bucket from the brief's seven-component list, but it deepens the buckets Architecture B already claims:

| Component | Without this layer | With this layer |
|---|---|---|
| RAG | Vector + rerank, single search per call | Vector + structured pre-filter + rerank (full hybrid-retrieval form named in the brief) |
| Tool use / agentic | Three tools in fixed sequence | Four tools with state-dependent branching, genuine multi-step planning |
| Advanced reasoning (CoT) | Orchestrator prompt has "think step by step" | Conditional reasoning over retrieval results, with the routing decision verbalised |
| LLM-as-judge | Pairwise bundle scoring | Pairwise plus per-section scoring (bundles now vary in shape) |

The total component count earned across architectures remains six; the depth of three of the six moves up materially.

## 10. Implementation phasing

Inside the broader implementation phasing in [ma3_architecture.md](ma3_architecture.md) §11, the candidate-matching layer adds these tasks. The baseline implementation (no matching, no conditional) remains a workable MA3 milestone; the matching layer ships as the headline upgrade.

| Day | Task |
|---|---|
| +1 | Download the Parquet, schema sanity-check; decide subset versus full corpus (recommended: full 210,250 rows since runtime retrieval scales sublinearly and ingestion is a one-time cost) |
| +2 | Create the `jobs_candidates_pool` Domain via the noted Domain Manager; run noted-graph ingestion to section-chunk, embed, and index the CVs |
| +3 | `match_candidates` Python module wired against noted-rag's `/search` and rerank endpoints with the ChromaDB `where` filter on structured metadata |
| +4 | Update `atlm_ma3_orchestrator` system prompt to declare the new tool and the conditional branching rule; extend the bundle renderer for the Candidate Matches section |
| +5 | With-candidate versus without-candidate prompt variants for Interview, Onboarding, and Welcome Kit retrieval; state plumbing for `best` to flow into downstream tool calls |

Approximately five days on top of the baseline implementation phasing. Cumulative MA3 timeline becomes approximately ten days of focused work post-Domain-ingestion.

## 11. Limitations and caveats

Temporal scope. The corpus covers 2020 to 2023. Some tech stacks and roles will appear thinner than 2026 norms; specifically, modern generative-AI engineering and recent MLOps practices are underrepresented. The benchmark prompts are scoped to respect this temporal coverage.

Geographic and market bias. Djinni is primarily Ukraine-focused. Candidates' locations, expected salaries, and work-style preferences will skew accordingly. For a single-company recruiter assistant this is irrelevant to the architecture; for any generalisable claim about candidate distributions it is not.

Anonymisation as published. The dataset is anonymised by the publisher. The MA3 system uses the corpus as-is, without secondary redaction. The corpus serves as a simulation of a company's internal candidate pool for the purpose of demonstrating the architecture; it is not a production deployment over real candidate records.

Match-score calibration. The 0.65 default threshold is initial. Calibration against the actual benchmark pool may move it. The MA3 report documents the calibration as part of the per-architecture configuration.

Skill glossary scope. The regex-based skill extraction used for `matching_skills` and `missing_skills` is bounded by whatever skill terms are glossarised. Out-of-glossary skills will not appear in the match detail but do not affect the reranker's match score, since the reranker operates on the full CV body.

Single highest-scoring candidate drives tailoring. The current design tailors downstream sections to `best` (the top-1 candidate). An alternative is to tailor to the top-K as a group ("any of these candidates would suit; the Onboarding Plan should accommodate the seniority spread"). The top-1 design was chosen for clarity in the bundle and tractability in the prompt; revisiting this is on the open-items list.

## 12. Cross-references

- [ma3_architecture.md](ma3_architecture.md): dual-architecture rationale and broader MA3 design that this layer extends.
- [rag_implementation.md](../rag_implementation.md): orchestrator system prompt, existing three tools, bundle structure and original six-section design that this layer expands.
- [ma3_prompt_test.md](ma3_prompt_test.md): variant A/B/C reproducibility artefact that established the b01 template-lock and forced all RAG context into Architecture B.
