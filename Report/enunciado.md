Objective
Develop a complete, working system that builds on the model you produced in Mini-Assignments 1 and 2, and integrates at least two additional techniques from the course to turn that model into a usable application.

This is the capstone of the trilogy: Assignment 1 gave you a domain-adapted model, Assignment 2 gave you an aligned version of it, and now you'll wrap that model in a real system — with reasoning strategies, robust evaluation, retrieval, tool use, or whatever combination your project demands.

Description
Starting point
Use your aligned model from Mini-Assignment 2 as the LLM at the core of your system. If that model is unsuitable for your project goals (e.g., your chosen application requires a much larger model, or your Assignment 1/2 domain doesn't fit), you may either:

Switch to a different open-source model and justify the change clearly, or
Run a short additional adaptation pass (continued pretraining, SFT, or alignment) tailored to the project. The pipeline you've already built in Assignments 1 and 2 should make this straightforward.
The expectation is that your final system reflects a coherent arc across the three assignments. Reviewers will read your final report alongside the previous two.

Integrate at least two additional components
Beyond the fine-tuning and alignment work already done, your system must integrate at least two of the following:

Advanced reasoning strategies — Chain-of-Thought, self-consistency, ReAct, Tree-of-Thoughts, program-aided reasoning
Retrieval-Augmented Generation (RAG) — vector store, hybrid retrieval, re-ranking
Tool use / agentic behavior — function calling, multi-step planning, external API integration
Iterative self-improvement — self-reflection, self-critique, verifier loops
LLM-as-a-judge evaluation — for either the system itself or as a core component
Performance optimization — quantization (GPTQ, AWQ, bitsandbytes), inference engines (vLLM, llama.cpp, TGI), batching strategies, KV-cache optimization, speculative decoding
Further alignment or post-training — additional DPO rounds with project-specific preferences, Constitutional AI, rejection sampling fine-tuning
The fine-tuning (Assignment 1) and alignment (Assignment 2) you've already done count toward the integration story but do not count as the two new components — you must add at least two on top.

Example project arcs
These illustrate how the three assignments might compose:

Domain QA system: legal/medical/scientific domain adaptation (A1) → DPO with helpfulness preferences (A2) → RAG over a domain corpus + LLM-as-judge evaluation (final).
Controllable creative writing assistant: author-style continued pretraining (A1) → DPO for style preferences (A2) → self-reflection loop + quantized inference for speed (final).
Code assistant: language-specific continued pretraining (A1) → DPO on code preferences (A2) → tool use (running tests) + iterative repair loop (final).
Educational tutor: subject-domain adaptation (A1) → alignment for pedagogical tone (A2) → CoT reasoning + verifier-based self-correction (final).
Auto-evaluator: domain adaptation (A1) → preference tuning for judgment calibration (A2) → LLM-as-a-judge system with structured rubrics + RAG for grounding (final).
You're not restricted to these — propose your own as long as the integration logic is clear.

Requirements
Functional system, not a concept — a working pipeline someone else can run end-to-end with a clear entry point (CLI, notebook, API, or simple UI).
Open-source models throughout — closed APIs are allowed only as auxiliary components (e.g., GPT-4 as a judge for evaluation), and their role must be clearly bounded.
Rigorous evaluation — quantitative metrics, qualitative analysis, and explicit comparison against sensible baselines. At a minimum, compare against (a) the base pretrained model with no fine-tuning, and (b) your Assignment 2 aligned model with no additional system components — this isolates the contribution of the final-stage integration.
Coherence across assignments — your final report must situate the project in the arc of the three assignments and explain how each stage contributed (or, where applicable, why a stage didn't help and was bypassed).
Justify your choices
System architecture — why these two components and not others? What problem does each solve?
Model choice — does the Assignment 2 model still make sense at this scale, or did you need to swap?
Evaluation design — what does "the system works" actually mean for your application, and how are you measuring it?
Trade-offs — latency vs. quality, capability vs. safety, complexity vs. maintainability.
Deliverables
1. Code
A reproducible repository with:

The full system, runnable end-to-end
requirements.txt or environment file with exact versions
A README.md covering setup, how to run, expected outputs, and how the code connects to your Assignment 1 and 2 artifacts (checkpoints, datasets, or LoRA adapters)
Random seeds set where appropriate
A short reproducibility note if any component (e.g., a hosted judge model) can't be exactly replicated
2. Technical report (max. 15 pages)
Include:

Pipeline overview: a diagram showing the full arc from raw pretrained model → A1 domain adaptation → A2 alignment → final system. Make it clear what each stage contributes.
System design: the two-or-more components you integrated, why they were chosen, and how they connect.
Implementation details: architecture, key design decisions, libraries used.
Evaluation: results against the baselines specified above. Include both automatic metrics and qualitative analysis with concrete examples.
Critical discussion: what worked, what didn't, where the system fails, what you'd build differently with more time. As in the previous assignments, honest reporting of failures and limitations is essential and explicitly rewarded.
Reflection on the three-assignment arc: which stage contributed most to the final system's performance? Were there stages whose effect was washed out by later ones (e.g., did RAG make your domain adaptation redundant)? This reflection is part of the grade.
3. Oral presentation
A demo and discussion of the system. Be prepared to:

Show the system running live (or via recorded demo if infrastructure is fragile)
Walk through the pipeline from Assignment 1 to the final product
Answer questions on design choices, failure modes, and trade-offs
Evaluation criteria
Criterion	Weight
Technical quality of the solution (working system, sound engineering, sensible choices)	40%
Integration of course concepts (coherent use of fine-tuning, alignment, and the additional components; clear arc across the three assignments)	30%
Evaluation and analysis (rigor of metrics, baseline comparisons, critical discussion)	20%
Presentation (clarity, demo quality, handling of questions)	10%