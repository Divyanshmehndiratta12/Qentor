# Noise Lab

The Noise Lab lets a learner run one circuit twice on the server's simulator, once ideally and once under a simple,
named, bounded noise model, and compare the two. It is an educational view of what noise does to measured outcomes.
It is **not** a model of any real device: no hardware, no calibration data, no IBM Quantum credentials are involved.

The invariant of `CLAUDE.md` holds here without exception: **the simulator is the quantum computer.** Every count,
frequency and distance on the screen is produced by Qiskit Aer or is arithmetic on Aer's counts, inside
`backend/qentor/execution/` or `backend/qentor/verification/`. The browser draws; it never calculates, perturbs,
randomises or invents a noisy result. No language model writes any sentence in this feature.

## What the learner sees

- A top-bar item **Noise Lab** (route `/noise`), enabled from a fresh start. No lesson has to be completed first.
- The line "Explore how noise affects quantum circuits.", a scope line (simulated noise, Qiskit Aer only, not real
  hardware) and four example circuits (Bell pair, one flipped qubit, three-qubit GHZ state, no gates just measure).
- The **Lab's own circuit editor and gate palette** (one circuit representation: the same store as the Lab, so an edit
  here is an edit there). Placing gates and measuring qubits works exactly as in the Lab.
- Controls: noise model, noise strength (slider and number box, range taken from the server), shots, optional seed.
- A conceptual strip "Gates → Measurement → Counts" marking where the chosen model acts. It is labelled a conceptual
  picture, not a model of any device.
- **Run ideal vs noisy** (or **Run ideal simulation** when the model is None). Results: an Ideal card and a Noisy
  card with their provenance, a grouped bar chart, a table (outcome, ideal count and frequency, noisy count and
  frequency, change), a Difference block, and "What the backend result shows", the server's sentences.
- A "What should I expect?" section with textbook statements for the chosen model (served by the server).

## Noise models

Every model is a simple textbook channel built from Aer's `NoiseModel`. Ranges are enforced by the server.

| Model | Acts | Meaning of the strength `p` | Range (default) |
|---|---|---|---|
| `none` | nothing | no strength (only the ideal run is made) | n/a |
| `depolarizing` | after each gate, on each qubit it touched | probability the qubit's state is replaced by the maximally mixed state | 0 to 0.3 (0.05) |
| `bit_flip` | after each gate, on each qubit it touched | probability of an X error | 0 to 0.5 (0.05) |
| `phase_flip` | after each gate, on each qubit it touched | probability of a Z error | 0 to 0.5 (0.05) |
| `amplitude_damping` | after each gate, on each qubit it touched | probability of decay from 1 towards 0 | 0 to 0.5 (0.1) |
| `readout_error` | at measurement | symmetric probability of reading the wrong bit | 0 to 0.5 (0.05) |

Gate noise is the same one-qubit error applied to each qubit a gate touches (so a two-qubit gate gives each of its two
qubits a chance of the error). Measurements themselves are not changed by gate noise. The authoritative text for each
model, including its "What should I expect?" notes, is `NOISE_MODEL_SPECS` in `backend/qentor/execution/noise.py`,
served at `GET /api/noise/models`.

Some noise cannot be seen by a 0/1 measurement: a phase flip on a Bell pair leaves the counts on 00 and 11. The page
shows the honest result (no difference) and says so in the expect notes.

## Architecture

```
web/src/features/noise/*  ──POST /api/noise/compare──▶  api/noise.py
                                                          │  validate (pydantic, extra="forbid") and noise limits
                                                          ▼
                              execution/aer.py  build_qiskit_circuit()  ← one circuit builder for ideal and noisy
                              execution/noise.py  make_noise_config / build_noise_model / run_noisy_shots
                              verification/noise_compare.py  compare_noise()  (counts → metrics and sentences)
                                                          │
                              provenance store: three records (ideal, noisy, comparison)
```

- **Backend only, Aer only.** Cirq and PennyLane are unchanged and have no noisy mode here. Asking for another
  backend is refused with `NOISE_BACKEND_UNSUPPORTED`; nothing is run or substituted.
- **Method fixed to `density_matrix`.** Aer's automatic method ran out of memory at 16 qubits, so noisy runs keep an
  exact 2^n by 2^n density matrix and sample shots from it. This is why the limits below exist.
- **Limits:** 8 qubits, 20,000 shots, 500 operations (the ordinary request limit). At least one measurement is needed.
- **Determinism:** `seed_simulator` is passed to Aer. When the learner gives no seed the server draws one and returns
  and records it, so any run can be reproduced. The ideal and noisy runs use the same seed. The same seed gives the
  same counts; a different seed gives a different sample.
- **Dependency direction** is unchanged: `api → tutor → verification → execution → circuit`. `execution/noise.py` and
  `verification/noise_compare.py` do not import `tutor`. The tutor does not see noise results.
- **Versions** of Qiskit and Aer are pinned and were not changed.

### API

| Route | Purpose |
|---|---|
| `GET /api/noise/models` | The models, their parameter meaning, ranges, defaults, "what to expect" notes, limits, the simulator method and the "not a real device" label |
| `POST /api/noise/compare` | Run ideal and (if a model is chosen) noisy; return both, with a comparison |

The request body is `{ circuit, noise_model, noise_strength?, shots, seed?, backend }` and nothing else (unknown
fields are rejected). It cannot carry a result, a count, a probability or a verdict. Errors are structured
`{ "code", "message", "limit"?, "requested"? }` with these codes: `NOISE_MODEL_UNKNOWN`, `NOISE_STRENGTH_INVALID`,
`NOISE_STRENGTH_NOT_ALLOWED`, `NOISE_STRENGTH_OUT_OF_RANGE`, `NOISE_SEED_INVALID`, `NOISE_TOO_MANY_QUBITS`,
`NOISE_SHOTS_OUT_OF_RANGE`, `NOISE_NEEDS_MEASUREMENT`, `NOISE_BACKEND_UNSUPPORTED` (all 422);
`NOISE_IDEAL_RUN_FAILED` and `NOISE_NOISY_RUN_FAILED` (400); `NOISE_BACKEND_UNAVAILABLE` (503);
`NOISE_COMPARISON_INCONSISTENT` (502). The route is on the heavy-request gate, like the other simulator routes.

## Provenance

A comparison stores three records, each with its own result id:

1. the **ideal** run: SIMULATION, backend `qiskit-aer`, mode `shots`, the circuit hash, shots, seed;
2. the **noisy** run: SIMULATION, backend `qiskit-aer`, mode **`noisy_shots`**, with `payload.noise` holding the
   model, label, parameter, strength, applies-to, simulator method, shots and seed;
3. the **comparison**: SIMULATION, backend label `noise-comparison`, method `noise-comparison/1`, referring to the
   other two ids and holding the metrics.

The screen shows the identity of each run (backend and version, execution mode, noise model, parameter, simulator,
shots, seed, result id) and every number goes through `VerifiedValue` with the provenance of the run that produced it:
ideal cells carry the ideal run's id, noisy cells the noisy run's id, the change and the metrics the comparison's.
The badge reads **Simulated noise**; a noisy result is never labelled hardware and nothing here uses the hardware
classes.

A noisy record has mode `noisy_shots`, which no existing consumer recognises, so it cannot be mistaken for an
ordinary run: the places that re-read a stored run by id (the Bell-state verifier, the tutor, experiment comparison,
the debugger, export and sharing) refuse it explicitly with `_refuse_noise_record` in `api/app.py` rather than
relying on a mode check alone.

## Metrics and wording

Only quantities that are mathematically defined on two sampled distributions are shown:

- **total variation distance** ½ Σ |p − q| over the union of outcomes (0 identical, 1 nothing in common);
- the **share of noisy shots on outcomes the ideal run produced**, and the number of noisy shots on outcomes it did not;
- the **distinct outcomes** in each run, the outcomes only the noisy run produced, and the top outcome (ties reported).

There is no "fidelity" and no "success rate": a sampled distribution does not define them. The explanation is a fixed
set of server templates filled from these numbers; each sentence states what the numbers show, and the closing note
says that both runs are finite samples, so small differences can come from sampling alone. Bitstrings are written
`q[n-1] … q[0]` and the page says so beside the chart.

## Lesson and challenge

- Lesson 19, **Understanding Quantum Noise** (`quantum-noise`, ten sections, two server-graded concept checks, builds
  on `bell-state`). Its lab step has an **Open in Noise Lab** button (a `LabCapability` with a route, like the other
  labs) that loads the lesson's Bell circuit into the Noise Lab. The lesson is open like every other lesson.
- Challenge `noise-shorten-circuit` ("Shorten it so noise cannot spoil it"): the starter is six X gates and two
  measurements (right ideally, but too long); the learner removes gates until the circuit still gives 11. Two checks:
  an ideal check (the outcome is 11) and a new check kind, `NoisyOutcomeShare`, which the server evaluates by running
  the learner's circuit on Aer under its own fixed configuration (depolarizing 0.08, 8,000 shots, seed 7) and
  requiring at least 0.9 of the shots on 11. The configuration is not in the public catalog and the browser sends only
  the circuit. The noisy run is recorded as its own `noisy_shots` record.

## Tests and checks

- Backend: `test_noise_execution.py`, `test_noise_compare.py`, `test_api_noise.py`, `test_noise_challenge.py`,
  `test_noise_lesson.py`, plus the existing suites whose pinned catalog counts changed (19 lessons, 20 challenges,
  38 checks, 19 lab circuits). They cover valid and invalid models and bounds, seeded determinism, the ideal run
  unchanged by noise code, counts that really come from the simulator, provenance, ideal/noisy separation, malformed
  requests, refusal of noisy records by the other consumers, and the challenge's starter-fails/reference-passes pair.
- Frontend: `NoiseLab.test.tsx` (controls, comparison, loading and error states, provenance), `noiseTrust.test.tsx`
  (a source scan that the feature uses no random numbers, no rounding or powers, no arithmetic on a quantum value and
  never builds the noisy table from the ideal one; render tests that every table cell and metric is a number in the
  response, that a different response gives a different column, and that only a response can put a result on screen), `noiseNavigation.test.tsx`, `realClient.noise.test.ts`.
- Mutation check: 37 `noise:` mutants in `backend/scripts/mutation_check.py` (the noise model, limits, seed,
  provenance mode, comparison arithmetic, record refusal, the challenge check), all killed.
- Real browser: `scripts/noise_journey.mjs` drives real Chrome against the production process (see its header for how
  to run it). It reads every expected number from the JSON the page itself received. Its sections: entry and Back,
  ideal-only run, ideal vs noisy with cell-by-cell comparison, provenance per number, strength change and seeds,
  keyboard operation, readout error and the other models, an 8-qubit run, loading state, the server's refusal for a
  circuit with no measurement, an unreachable server, values the form refuses, the shared canvas, 900/390/320 px, axe,
  the lesson bridge and the challenge (starter fails the noisy check, shortened circuit passes).

## Known limitations

- Noise here is textbook and simple: Pauli, amplitude-damping and symmetric readout channels. No coherent errors,
  crosstalk, gate-time or T1/T2 dependence, non-symmetric readout or per-qubit/per-gate rates, and no device
  calibration. It says nothing about how any particular machine behaves.
- Eight qubits at most, because the noisy method keeps a density matrix. The Lab's editor also stops at eight qubits, so
  the `NOISE_TOO_MANY_QUBITS` refusal cannot be provoked from the page; it is tested at the API, and the page warns
  about it only for circuits that arrive some other way.
- A comparison is two finite samples. Differences smaller than sampling error are not evidence of noise, and the page
  says so; no significance test is offered.
- Only Aer. There is no noisy mode for Cirq or PennyLane, and no real-QPU path.
- The ideal run is sampled shots, not a statevector, so that it is comparable with the noisy run.
- On a wide screen the editor column ends before a long result does, leaving blank space beside the results.
- Adding the fifth top-bar destination needed room in the Lab's top bar: below 1536 px it no longer shows the "lab / Nq circuit · N ops" summary, and below 1280 px it no longer shows the Simulator/Recorded/Live chips (the other screens' bars are unchanged).
