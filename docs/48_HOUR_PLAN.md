# 48-Hour Plan

Principle: build the verified path end to end first, thin but real, then deepen. A feature that
cannot show provenance is not finished.

Owner actions (the product owner or a teammate with accounts) are marked **[OWNER]**. They are
on the critical path because recorded hardware runs need a real IBM Quantum account.

## Milestones

| Hour range | Milestone | Deliverable | Dependencies | Success criteria | Cut condition |
|---|---|---|---|---|---|
| 0–2 | Environment proven | Python 3.12 venv with qiskit, qiskit-aer, qiskit-qasm3-import, cirq-core, pennylane, fastapi, anthropic. Vite React-TS app. FastAPI serves the built app. One test command for each side. | Python 3.12 available (install via `uv` or python.org if missing) | A script prints versions of all SDKs and runs a Bell circuit on each | If PennyLane will not install by hour 2, move it to P1 and continue |
| 0–4 | **[OWNER]** IBM Quantum account ready | IBM Quantum token stored in a local `.env` (never committed). Confirm an available device and current free-plan quota. | Internet, account signup | `scripts/record_hardware.py --dry-run` lists a device | If no account by hour 8, Reality-check shows "no recorded runs" honestly and the pitch changes. Never simulate instead. |
| 2–6 | Canonical circuit + Aer | Circuit model (pydantic + zod), server QASM emitter, hash, Aer adapter (statevector, shots, steps), provenance log in SQLite, `/api/execute` | Hour 0–2 | Golden fixtures pass. Bell circuit returns probabilities with a full provenance record. | None. This is the spine. |
| 6–8 | Hardware recording script | `scripts/record_hardware.py` runs library circuits on IBM and writes JSON + manifest | Canonical model, emitter, hash | **[OWNER]** runs it. Jobs for Bell, GHZ-3, DJ (one constant, two balanced oracles), BV s=101 are submitted by hour 8. | If queues are long, submit and move on. Results are collected later. |
| 6–12 | Build screen | Canvas (click to place), CodeMirror QASM editor with two-way sync, results panel (Plotly histogram, probability table), provenance badge, step slider, Bloch sphere | Execute API | Editing canvas updates code and results. Editing code updates canvas. Every number has a badge. | Bloch sphere drops to P1 if not done by hour 12 |
| 12–18 | Verification engine | Test harness (basis-sweep, oracle-slot, state-prep, unitary-match), DJ 72-oracle family, BV family, equivalence checker with distinguishing input, misconception rules, `/api/verify/*` | Aer adapter | Reference solutions pass all specs. Known-buggy DJ circuits fail with the expected counterexample. 72 oracles run in under 2 seconds. | unitary-match for oracles drops to P1 if behind at hour 18 |
| 18–22 | Test and Optimize screens | Test report UI (pass count, counterexample card, expected vs actual), counterexample trace, optimiser rules with verified proposals and per-rewrite explanations | Verification engine, Build screen | Hero path steps 4–8 of `PRODUCT_CONTRACT.md` §7 work | Commute-past rule drops if behind |
| 22–24 | Integration checkpoint and rest | Run the hero path end to end without the tutor. Fix blockers. | All above | Steps 1–8 work on the laptop | — |
| 24–30 | Grounded AI tutor | Fact sheet builder, Anthropic adapter with structured output, guard, claim re-simulation, candidate verification, template fallback, tutor panel UI with rejected-claim counter, fake-LLM adversarial tests | Verification engine, provenance log | Adversarial tests pass. The tutor explains the DJ counterexample with only fact-referenced numbers. Works with the key removed. | Typed-claim re-simulation narrows to probability claims only if behind |
| 30–34 | Multi-backend and Reality-check | Cirq and PennyLane adapters, cross-backend agreement panel, recorded-hardware loader with manifest check, Reality-check screen with TVD, Hellinger fidelity and forbidden-outcome mass | Canonical model; recorded runs from hour 6–8 | All three simulators agree on fixtures within 1e-6. A recorded IBM run appears beside the ideal result with job id and date. | PennyLane stays P1 if it failed in hour 0–2 |
| 34–38 | Learn and Reflect | Lessons (Bell primer, phase kickback, DJ, BV) as JSON, lesson renderer with executed examples, challenges, mastery, next-challenge recommender, content CI test | Harness, execute API | A new learner can go Learn → Reflect for DJ. Mastery changes only on verified events. | Phase kickback lesson merges into DJ if behind |
| 38–42 | P1 window | In order: Hindi i18n for UI and tutor; Grover-2 challenge; Aer noise-model view labelled SIMULATION; Dockerfile and hosted demo link; live IBM submit | P0 complete and demo-stable | Each P1 item ships only with provenance and tests | Stop P1 work at hour 42 regardless |
| 42–46 | Demo hardening | Demo script, seeded learner state, network-off rehearsal, error states, loading states, first-load performance, screen-capture backup video | Everything | Three clean rehearsals of the hero path in a row, one with the network off | Any P1 feature causing instability is switched off |
| 46–48 | Freeze | README with run and test commands, final docs update, dataset export of recorded runs (Deck p6), tag the build | — | A fresh clone runs with the documented commands | No new features after hour 46 |

## Critical path

Environment → canonical model + Aer → verification engine → Test/Optimize UI → tutor → hardening.
The hardware recording runs in parallel from hour 6 and must start early because IBM queues are
unpredictable.

## First implementation milestone (hours 0–6)

"A circuit goes in, a verified, provenance-carrying result comes out."

1. Python 3.12 environment with all SDKs importable, versions printed.
2. Canonical circuit model with schema validation on both sides.
3. Server OpenQASM 3 emitter plus golden fixtures; Qiskit `qasm3` import check.
4. Circuit hash.
5. Aer adapter: statevector, shots, steps.
6. SQLite provenance log and `POST /api/execute`.
7. Tests: fixtures round-trip, Bell and GHZ probabilities, provenance record complete.

Exit check: `curl` a Bell circuit to `/api/execute` and receive probabilities 0.5/0.5 with backend
name, version, circuit hash, result id and SIMULATION class, all written to the log.
