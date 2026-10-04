# PPT sources

The product contract is derived from these files. Page references in other docs use the
labels below.

| Label | File | Status |
|---|---|---|
| **Deck p1–p6** | The submitted idea deck (a PDF kept outside this repository; the text below is its content) | **Final submitted deck. Primary authority.** |
| **Draft-Idea** | `~/Downloads/Qentor_Slide2_Idea_Title.pptx` | Draft of Deck p2. Same text. |
| **Draft-Layered** | `~/Downloads/Qentor_Slide3_LayeredFlow.pptx` | Draft slide, not in final deck. Secondary. |
| **Draft-Tech** | `~/Downloads/Qentor_Slide3_Technical_Approach.pptx` | Draft slide, not in final deck. Secondary. |

Rule: a promise that appears only in a draft is **secondary**. It may shape design but it is
not a demo commitment unless the final deck repeats it.

## Deck p1 — Title
SIH26140 · AI-Based Interactive Quantum Algorithm Learning Platform · Smart Education · Software · Team Qentor.

## Deck p2 — Idea
Title: "Qentor: Learn Quantum Algorithms by Testing, Optimizing and Verifying Circuits".

Problem: "A wrong quantum circuit still runs, and still returns an answer. You can't inspect a
qubit mid-run, so a plausible histogram hides the bug. AI tutors make it worse by confidently
stating wrong circuits and numbers."

Proposed solution:
1. "AI you can trust. The tutor explains and debugs, but every circuit or number it states is re-simulated before you see it."
2. "Build and run anywhere. Visual or code circuits, synced, on Qiskit Aer, Cirq, PennyLane and real hardware."
3·4. "Test, then optimize. Your circuit is tested on every valid input and failures return a counterexample. Shorter circuits are suggested, verified equivalent."
5. "Compare with reality. Simulation sits beside recorded real-device runs, so you see what noise does."

Workflow diagram "Verify-first loop. Every step is checked before you trust it.":
1 Learn (guided lesson) → concept → 2 Build (canvas + code) → OpenQASM 3 → 3 Test (counterexample)
→ all inputs pass → 4 Optimize (shorter, verified) → equivalent → 5 Reality-check (sim vs hardware)
→ noise gap → 6 Reflect (mastery update) → next challenge → 1.
Centre graphic: "Oracle #37 fails · 71 of 72 pass · *Illustrative*".
Legend: teal = learn, build, execute; amber = "Verification engine (our novelty)"; navy = adaptive path.

## Deck p3 — Technical approach
Tech stack: React (frontend UI), TypeScript, Three.js (3D visualisation), Plotly (charts & graphs).
Quantum backends: Qiskit Aer, Cirq, PennyLane, qBraid / IBM (real hardware), OpenQASM 3 (circuit description).

Six steps joined by "OpenQASM 3" arrows:
1. Learn — "Understand the concept with interactive visuals, short explainers and guided examples."
2. Build — "Create circuits visually or in code (synced) and run them on Qiskit Aer, Cirq, PennyLane and real hardware via qBraid/IBM." (shows canvas + `qc.h(0) qc.cx(0,1) qc.measure_all()`)
3. Test — "Your circuit is tested on many inputs. Failures return a counterexample." (mock: "Input 101 ✗ Expected: 0 | Got: 1", expected vs actual bars)
4. Optimize — "The optimizer suggests shorter circuits, verified equivalent." (mock: Original 12 gates → Optimized 7 gates)
5. Reality-check — "Simulation vs recorded hardware shows the effect of noise." (Simulator vs Real Device histograms)
6. Reflect — "Track progress, find misconceptions and get a personalized path." (Mastery 6/8)

Verification layer sidebar: Learn (concepts + visuals), Build (visual / code + multi-backend),
Test (multi-input validation + counterexample), Optimize (shorter circuits + equivalence),
Reality-check (simulation vs hardware), Reflect (progress + personalized path).
"Concept mockup" test-results table with example numbers — **mockup, not data**.

## Deck p4 — Feasibility & viability
Can we build it: Software-first ("Runs in the browser with React, TypeScript and WebGL/Three.js");
Simulation ("Qiskit Aer handles lesson-scale circuits without cloud dependency"); Multi-SDK
("OpenQASM 3 keeps visual and code circuits portable across Qiskit, Cirq and PennyLane");
Hardware ready ("qBraid / IBM integration enables recorded real-device comparison");
Verification engine ("Multi-input grading, counterexamples and equivalence checks validate every result").
Is it worth it: learn with confidence; lower compute cost ("Lesson-scale statevectors stay small;
larger Clifford circuits can use stabilizer simulation"); SDK-agnostic; real-world awareness
("Side-by-side simulation and hardware runs expose noise and device effects"); scalable product
("Start with a focused algorithm library, then expand challenges, optimizers and backends").
Pipeline: Browser (React + TS + Three.js) → Simulator (Qiskit Aer / Cirq / PennyLane) →
Verifier (OpenQASM 3 + tests) → Hardware (qBraid / IBM).
Key takeaway: "Browser-first · verification-first · hardware-ready → feasible now, extensible later."

## Deck p5 — Impact & benefits
Social / economic / scientific / government benefits; SDG 4, 9, 10.
Existing solutions: textbooks & courses, coding platforms, AI tutors ("Often confident, can be wrong"), cloud providers.
Our differentiation: AI Assistant ("Explains, debugs and re-simulates every claim"), Verification-first
("Checks every circuit, test and optimization step"), Adaptive Learning ("Personalized path based on
performance and misconceptions"), Real Hardware ("Simulation + real-device comparison for true understanding").

## Deck p6 — Research & references
Placeholders only: Datasets ("Quantum circuits, results and real-device runs used for evaluation and testing"),
Research papers, Demo link ("60 second demo / live link"), GitHub repository, Additional resources, Tools & libraries.

## Draft-Layered (not in final deck)
"Architecture: One Verified Path, Five Layers … connected end-to-end by OpenQASM 3."
AI tutor layer; Interface layer (React · TS · Three.js · Plotly); Verification layer; Execution layer
(Qiskit Aer · Cirq · PennyLane; "Simulation sits beside recorded real-hardware runs");
Insight layer ("Instructors see misconception dashboards; learners get a personal mastery trail").
"72 DJ oracles — Exhaustive test runs instantly across all of them."

## Draft-Tech (not in final deck)
Backend: "Python FastAPI, WebSockets, background queue for hardware jobs".
Hardware: "IBM Quantum / qBraid on free tiers, plus a stored run library".
AI: "LLM via API (model-agnostic) with retrieval over SDK docs and course notes".
Verification: "NumPy/SciPy, Qiskit operator-equivalence check, custom rewrite rules, property-based tests".
Data & deployment: "PostgreSQL, Docker, installable low-bandwidth web app".
Steps: "Test. Every oracle is checked; a failure returns a counterexample plus a misconception tag."
"Optimize. A shorter circuit is proposed, checked for equivalence, and each rewrite is explained."
"Reality-check. The result is compared with a recorded hardware run of the same circuit."
"Reflect. The mastery model updates and picks the next challenge."
