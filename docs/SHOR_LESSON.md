# Shor's algorithm, order-finding intuition — lesson 18

`shors-algorithm` (prerequisite `quantum-phase-estimation`; ten sections; two server-graded concept checks; reflection). Content:
`backend/qentor/lessons/content_shor.py`. Tests: `backend/tests/test_shor_lesson.py`, `web/src/features/learn/shorCurriculum.test.tsx`.

## What it is

ONE fixed educational instance: the **order of 2 modulo 15**, found with phase estimation. Nothing else is implemented.

| Part | What it does |
|---|---|
| Qubits | q0–q2 counting register; q3–q6 work register (q3 least significant) |
| Start | X on q3 (work register = the number one); H on q0–q2 |
| Controlled multiplication by 2 | Multiplying by 2 modulo 15 rotates the four work bits up one place: 3 swaps, each controlled by q0 and built as `cx`, `ccx`, `cx` (9 operations) |
| Controlled multiplication by 4 | A rotation by two places: 2 swaps controlled by q1 (6 operations). Multiplying by 16 is the identity, so q2 needs no gate |
| Readout | the inverse QFT of the QPE lesson, then three measurements of q0–q2 (7 + 3 operations) |
| Size | 7 qubits, 3 classical bits, 29 operations: inside the Aer, Cirq and PennyLane limits and the trace limits (8 qubits) |

## What the backend shows (checked on Aer in the tests; the lesson text claims no run result)

- The counting register reads one of four strings, `q2 q1 q0` = `000`, `010`, `100`, `110` (the multiples of two, i.e. phases that are whole numbers of quarter turns), each with probability one quarter. Shots only ever return those four.
- The work register holds the cycle of the powers of 2 modulo 15: `0001`, `0010`, `0100`, `1000`, each with probability one quarter.
- Each controlled multiplication is swept over every work value 0–15 and both control values on the backend (the value 15 stays 15; the control 0 leaves the register alone).
- Aer, Cirq and PennyLane agree on the state (threshold 1e-6). Breaking the circuit (a wrong control wire, a missing multiplication) changes what the backend returns.

The cycle (2, 4, 8, 1), the order 4, the denominators of the allowed phases, and the finish gcd(3, 15) = 3 and gcd(5, 15) = 5 are plain integer arithmetic in the tests, labelled "textbook" in the lesson.

## What it is not (the lesson says all of this)

- Not a general factoring implementation and not a scalable Shor's algorithm. The controlled modular multiplications are compiled by hand only because 15 and 2 make multiplication a bit rotation; that is the part that does not carry over to larger numbers.
- The classical finishing steps (continued fractions, gcd, repeating a run) are **not** simulated as a production factoring system. The gcd finish is shown as textbook arithmetic; the backend never computes it and nothing labels it verified.
- No hardware, no recorded run, no performance claim, no statement about encryption.

## Why there is no challenge

A server-checkable task on this circuit would only rebuild the controlled multiplications or the inverse QFT, which the QFT and QPE challenges already ask for. The new ideas (the order of a number, the classical finish) need no circuit and are covered by the two graded checks and the Lab. The lesson carries a `no_challenge_reason`, which `qentor.content.validation` requires and checks; the public catalog does not carry it.
