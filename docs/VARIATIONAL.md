# Variational (VQE-style) demonstration — lesson 17

An **educational, one-parameter** demonstration of the shape of a variational algorithm. It is not a chemistry calculation, not a
scalable VQE, and it needs no hardware. Every screen, every API response and the lesson text say so.

## The example

| Piece | In this demonstration |
|---|---|
| Parameterised circuit (ansatz) | one qubit, `RY(θ)` applied to `|0⟩` |
| Cost | the expectation value `⟨Z⟩` of the Pauli Z observable in the state the circuit prepares |
| Classical loop | gradient descent on `⟨Z⟩`; the gradient is built from backend cost values by the parameter-shift rule |
| Quantum side | a statevector run on the server (Aer by default; Cirq and PennyLane also work and agree to 1e-6) |

## Where every number comes from

`⟨Z⟩` is read by `qentor.execution.expectation.z_expectation` from the **statevector the backend returned** (a signed sum of
`|amplitude|²`; it equals the Z component of that qubit's Bloch vector and a test pins the identity). It is never computed from `θ`: the closed
form of this circuit appears in no shipped function, and a test reads the source to prove it. A state that is not a well-formed normalised
vector has no expectation value (`None`), is refused with a 502 and is never repaired.

`qentor.verification.variational` runs the three pieces:

* `evaluate(θ)` — one statevector run, recorded as an ordinary provenance record, returning `⟨Z⟩`, the Bloch vector, the two probabilities and
  the run's identity;
* `run_sweep(θ_min, θ_max, points)` — evenly spaced angles (3 to 64 points, within ±4π); the lowest and highest points are found by
  *comparing* the backend's values;
* `run_optimization(θ_start, steps, learning_rate)` — a fixed-length loop (1 to 25 steps, rate 0.01 to 1.5); each step is three backend runs
  (θ and θ ± π/2); the slope is `(⟨Z⟩(θ+π/2) − ⟨Z⟩(θ−π/2)) / 2`; θ then moves downhill. A start where the slope is exactly zero (the top
  or the bottom of the curve) does not move, and the response says so.

## API (`backend/qentor/api/variational.py`)

| Route | Takes | Returns |
|---|---|---|
| `POST /api/variational/sweep` | `theta_min`, `theta_max`, `points`, `backend` | every point: θ, `⟨Z⟩`, Bloch vector, `P(0)`, `P(1)`, the run's `result_id`, `execution_id`, circuit hash and provenance; the index of the lowest and highest point; one summary provenance record (`backend = variational-demo`) naming every run |
| `POST /api/variational/optimize` | `theta_start`, `steps`, `learning_rate`, `backend` | every step with its three runs, the slope, the lowest step, `converged` (the last slope is flat), the learner's rate echoed, notes |

Requests forbid extra fields and have none that could carry a cost, a gradient, a curve or an "expected" minimum. Errors are structured
(`422` for an out-of-range input, `502` for a malformed backend state, `503` when the backend is unavailable).

## Lesson 17 and its challenge

`variational-vqe` (prerequisites `bloch-sphere`, `superposition`; ten sections; two server-graded concept checks; reflection). Its lab
capability is `variational_sweep`, routed to `POST /api/variational/sweep`; the Lab circuit it opens is one `RY` gate. The lab shows the parameter
sweep, the cost curve, the Bloch sphere of a chosen angle (the same component the trace uses), the optimiser's path and the server's label.

Challenge `vqe-find-theta`, "Find θ where ⟨Z⟩ = -1": one `RY` gate on one qubit (an `X` gate alone would also reach −1, so only `RY` is
allowed). The check `expectation_matches` (`challenges/models.py::ExpectationMatches`) reads `⟨Z⟩` from the backend's state for the learner's
circuit and passes within 1e-6. It judges the state, not the typed angle: `π`, `3π`, `-π` and `3.14159` pass; `3.14` does not.

## Not built

No hardware run of any kind. No multi-parameter ansatz, no Hamiltonian, no molecule, no noise model, no shot noise in the cost (the demonstration
uses exact statevectors, and says so). No claim of speed-up or scalability anywhere in the lesson (a test searches its text).
