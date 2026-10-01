# Build State

What is built and verified right now, what is not, and how to run it. Numbers below were measured at the last full
verification (see "Verification" for the commands). If this file and the code disagree, the code wins: fix this file.

## What exists

| Area | State |
|---|---|
| Canonical circuit model, OpenQASM 3 emitter, SHA-256 hash | Built. Gates: h x y z s sdg t tdg rx ry rz cx cz cp swap ccx measure (`cp` is the controlled phase; the optimizer has no rule for it, so it leaves `cp` alone). Golden fixtures in `fixtures/circuits/` are shared by backend and web tests. |
| Execution | Qiskit Aer, Cirq, PennyLane; statevector and shots; per-step trace; single-qubit Bloch vectors; per-qubit reduced states (Bloch vector, purity, entangled-with-the-rest) and a polar amplitude/phase view for every trace step, computed on the server; size/gate limits; state sanity check before a result is stored |
| Verification | Equivalence (operator, up to global phase), cross-backend agreement (threshold 1e-6), Bell-state verifier, multi-input basis sweep, optimiser (each proposal equivalence-checked), experiment comparison |
| Challenges | Fourteen backend-owned challenges, deterministic server verdicts, authored hints and coaching, attempt log. DJ, BV and Grover use one fixed oracle each; superdense coding locks its decoder (and keeps Alice's gates on her qubit), teleportation locks its deferred corrections. Check kinds: whole state, probabilities, one qubit's own state (Bloch vector from the reduced density matrix), plus a re-run with the locked part swapped (Grover). |
| Tutor and debugger | Result-, lesson-, trace-step-, comparison-grounded answers; "Debug my circuit"; one claim guard; LLM off unless configured |
| Learn | 13 lessons (10 sections each from lesson 8 on) with 26 concept checks; progress, mastery and misconception signals; browser-local persistence (versioned, recoverable). Concept checks are graded by the server: the lesson catalog carries no answer key and no explanation, `POST /api/lessons/{id}/concept-checks/{id}/grade` returns correctness and the explanation, and after a reload `POST /api/assessments/regrade` rebuilds every saved verdict from the server (saved verdicts are only provisional until it answers) |
| Content validation | `qentor/content/validation.py` (run with `backend/scripts/validate_content.py`, and by `tests/test_content_validation.py`): prerequisites (unknown, self, repeated, cyclic), unique section ids, every concept check graded with a key that is an option and an explanation, every linked circuit made of known gates every backend supports and actually run on Aer, every lab capability declared and routed, every challenge naming a real lesson, every lesson with a challenge or a `no_challenge_reason`, registry consistency. Findings name the lesson and section |
| Frontend | Lab, Learn, Challenges, Progress; URL routing with deep links; sampled vs theoretical labelling; Compare experiments; Share and export; welcome entry; keyboard/ARIA/focus work from the shell pass |
| Serving | One FastAPI process serves `/api/*` and `web/dist` with SPA fallback; `GET /api/health` |
| Packaging | `Dockerfile`, `.dockerignore`, `render.yaml`, `backend/scripts/serve_production.sh` |

## What is NOT built

- **Hardware.** No recorded or live hardware adapter, no `record_hardware.py` run, no `server/data/hardware_runs/`. The UI shows Recorded and Live QPU as unavailable. Nothing in this build is, or is labelled as, a hardware result.
- The Aer noise model, qBraid, stabilizer simulation, QFT/QPE/QEC/VQE lessons, retrieval over docs. Grover is one fixed 2-qubit, 4-item example with one iteration: no scalable search.
- The 72-oracle Deutsch-Jozsa family sweep (`CLAUDE.md` lists "DJ family size is exactly 72" as a required test; it does not exist). The two oracle challenges use one fixed oracle each.
- Accounts and any server-side learner data. Progress is browser-local; the learner report is one learner's record, with no cohort data.
- A public deployment. The production process was verified locally; the Docker image has not been built (no Docker on the build machine) and nothing has been hosted.

## Verification (last full run)

| Check | Result |
|---|---|
| Backend `unittest` | 1325 tests, all passed |
| Frontend `vitest` | 1629 tests in 69 files, all passed |
| `tsc -b` | clean |
| `npm run build` | succeeds (one chunk over 500 kB; Plotly and Three.js) |
| Mutation check (`backend/scripts/mutation_check.py`) | 86 backend and 55 frontend trust-breaking mutants, all killed (Sprint 2 added 21 and 7). One backend mutant survived on the first run (a gate-qubit rule that ignores controls; the shipped rules only restrict X and Z, which have none); a test with a restricted CX was added and the mutant is now killed |
| Real HTTP smoke, Sprint 2 (production process, a throwaway stdlib script with its own independent pure-Python statevector simulator, not committed) | 71 checks, all passed: 13 lessons and 14 challenges served with no key, explanation, reference or target; each new lab circuit run on Aer and equal to the independent simulator up to global phase (before its terminal measurement); the teleportation trace's reduced states before and after the corrections equal to the independent calculation; each of the five references passes; wrong, cheating (hard-coded Grover, direct RY, SWAP, X on Bob's qubit, missing or reordered locked part) and substituted circuits fail; the CZ written the other way round is accepted; no client-supplied verdict; the six new checks graded and re-graded; the tutor from every section of the three lessons (explain, simpler, hint, Hindi, Kannada) and from a selected trace step; Debug my circuit on a failed teleportation attempt |
| Real HTTP smoke, Sprint 1 against the production process (FastAPI serving `web/dist` on a temp database; a throwaway stdlib script, not committed) | 30 checks, all passed: `cp` on all three backends with the right phase, cross-backend agreement and code views for `cp`; per-qubit states and the amplitude view for a Bell trace with provenance; the lesson catalog with no key and no explanation; grading right, wrong, invalid, malformed and unknown; batch re-grade; the tutor not returning the explanation. The real browser client and its schemas were also run against that server (3 checks) |
| Real Chrome journey, Sprint 1 features (FastAPI serving `web/dist`, no Vite) | 53 checks, all passed: `cp` in the palette with its angle input, placed on the canvas and in the OpenQASM editor; the run's `|011>` amplitude equal to the backend's; Qiskit, Cirq and PennyLane code showing `cp` and its angle; three-backend agreement; the per-qubit spheres, lengths, purities, entanglement text and provenance of every step of a `cp` trace and of a Bell trace equal to the backend's own JSON; every amplitude row (size, angle, outcome weight, bar, arrow) equal to the backend's; the server-graded quiz (wrong, then right, with the explanation, only the option id sent), a reload that re-grades, a doctored saved verdict corrected by the server; phone-width layouts; no console errors, no failed API requests. It found three layout defects in the new views, now fixed (see Known limitations) |
| Real Chrome journey, Sprint 2 (FastAPI serving `web/dist`, no Vite; headless Chrome driven over CDP, a throwaway script) | 85 checks, all passed: Learn -> Superdense Coding (every section's text, a wrong then right answer with the server's explanation, the tutor from the lab section with a request of ids only) -> Open in Lab (the canvas holds exactly the lesson's 7 operations) -> run -> trace (6 steps; every per-qubit sphere, length, purity, entanglement text, provenance id and amplitude row equal to the backend's JSON) -> tutor on the selected step; Learn -> Teleportation (the deferred-corrections statements on screen) -> Lab (8 operations, 8-step trace, q2 length 0.000 purity 0.500 before the corrections and a pure state after, equal to the backend's) with a phone-width check; Learn -> Grover -> Lab (16 operations, the marked item's phase arrow turning at the oracle and its weight growing at the diffusion) -> Practice this lesson -> the challenge; all five new challenges built through the UI, with a wrong then a right circuit for Grover, superdense (Z, then X on Bob's qubit, then X on Alice's), teleportation (RY onto Bob's qubit, then the protocol), Bloch (-x, then +x) and entanglement (two superpositions, then H and CX); Progress "5 of 14 solved" and surviving a reload; phone layouts; no console errors, no failed API requests. Prerequisite lessons were seeded as finished in the app's own saved-progress format (the server re-graded every saved answer on load); the three new lessons were walked through the UI |
| Real Chrome journey, earlier full journey (same setup) | 45 checks, all passed on the Sprint 1 build: direct `/learn`, `/progress`, `/challenges/<id>`; Learn -> concept check -> Open in Lab -> run -> trace -> select step -> tutor; Hindi answer; Aer vs Cirq comparison and tutor about it; Debug my circuit; share link round trip; a wrong then a right challenge; the fixed Deutsch-Jozsa example built through the UI and solved by the backend; Progress and reload persistence; phone-width layout of four screens; no console errors, no failed API responses |

The browser journey is a throwaway CDP script (Windows Chrome, headless), not committed. Web fonts are requested from Google Fonts;
that is the only third-party request the journey observed.

## Known limitations

- **A statevector run of a circuit that ends in a measurement is one collapsed branch** (existing, pinned behaviour: `test_visualization_backend.py`, and the Lab warns "one collapsed post-measurement state… use shots mode"). It matters most for the teleportation lab, which measures only q[2]: its statevector Results panel shows a collapsed state, so the lesson tells the learner to read the measurement in shots mode and the states in the trace. Sprint 2 did not change this.

- **A pre-existing crash in the simulator stack can kill the server.** Qiskit's Rust extension (qiskit 2.5.2, `_accelerate`) segfaults inside `QuantumCircuit.__init__` (reached from `AerAdapter.run`) when a request lands on a newly created worker thread, always at the same instruction (a null read). AnyIO retires idle worker threads after 10 s, so a server with human-paced traffic loses a worker thread's worth of luck on every pause: it died minutes into 2 of 4 browser sessions. Reproduced identically on the pre-Sprint-1 checkpoint (`9774104`, 3 of 3 runs) and recorded in the kernel log in earlier sessions, so it is not a Sprint 1 regression, and it is not fixed. Under constant traffic (workers never idle) 16,500 mixed requests in 90 s did not crash. The browser journeys above were run against the same app with worker threads that never retire (`anyio` `WorkerThread.MAX_IDLE_TIME` raised in a launcher; no product code changed). A production deployment needs a fix or mitigation first (a supervisor that restarts the process, never-retiring workers, a different Qiskit build, or building the circuit off the request thread).
- The browser journeys ran on one machine and one Chrome version; Firefox and Safari were not tried. The Lab's top bar on a phone lets the Run button cover part of the "Progress" tab (not touched by Sprint 1).
- Layout defects in the new views, found by measuring in Chrome and fixed: the amplitude bars had no size (the track was an inline `<span>`), the per-qubit cards were two to a row in the Lab's ~340 px results panel and clipped their contents, and the amplitude table's last column was cut off. Component tests cannot see these (jsdom does no layout); only the Chrome run does.
- A quiz answer needs the server: with it unreachable the answer is not graded and nothing is recorded (the quiz says so). After a reload, saved verdicts are re-checked with the server; if it cannot be reached they are shown as last saved and Learn says they were not re-checked.
- Teleportation is the deferred-correction form only: the circuit model has no mid-circuit measurement and no classical control, so Alice's two results are never measured and sent. The lesson, its lab, its second check and the challenge all say so; nothing claims the full dynamic protocol.
- The teleportation challenge locks the corrections and judges the state BEFORE them (the message, the pair and Alice's gates, and that Bob's qubit alone shows nothing) and the state AFTER (q[2] holds the message). A direct RY onto q[2] would pass the last check by itself; the checks before the corrections are what catch it.
- The Grover challenge's generalisation check re-runs the learner's circuit with an oracle marking the item 10 instead; that run is recorded as its own provenance step and its circuit hash is that of the swapped circuit, not the submitted one.
- The entanglement challenge's title is "Create a Bell state and show it is entangled": "Create a Bell state" is already the Bell State lesson's challenge, so the new one adds the per-qubit (reduced state) checks.
- Every lesson now has a challenge, so no lesson carries a `no_challenge_reason`.
- The optimizer has no rewrite rule for `cp`, so it never shortens a circuit by merging or cancelling controlled phases.
- The debugger's template text is English only. Tutor answer wrappers support English, Hindi and Kannada.
- Starting a challenge replaces the Lab's circuit with its starter (they share one workspace); the screen says so.
- Sampled frequencies from shots are compared with theoretical probabilities only with a label; no significance test is offered.
- The provenance database is one SQLite file with no retention policy; a hosted deployment should mount a volume (`QENTOR_DB_PATH`).

## Environment

Development is inside WSL2 (Ubuntu) with a dedicated Python 3.12 venv, because Windows Smart App Control blocked
qiskit's unsigned native extension on the original host (a reputation policy, not a dependency problem; turning Smart App
Control off is irreversible, so it was not touched). Node 22 via nvm in WSL.

## Commands (from the repo root, inside WSL)

```
py -3.12 -m venv backend/.venv                       # once; on Linux: python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python backend/scripts/check_versions.py

backend/.venv/bin/python -m unittest discover -s backend/tests -t backend        # backend tests
(cd web && npm ci && npx vitest run && npx tsc -b && npm run build)             # frontend tests, typecheck, build
backend/.venv/bin/python backend/scripts/mutation_check.py                       # trust mutation check (backend + web)
backend/.venv/bin/python backend/scripts/validate_content.py                     # lesson and challenge content validator (--no-run skips running circuits)

backend/scripts/serve_production.sh 8000           # build web, serve it and the API from one process
```

A single backend test module needs `-p test_x.py`, not a dotted name.
