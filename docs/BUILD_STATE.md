# Build State

Last updated: 2026-09-28, Milestone 1 ("canonical circuit → QASM → Qiskit parser → Qiskit Aer →
structured result → provenance record → FastAPI response → end-to-end test").

## Status: RESOLVED. Milestone 1 spine is built, executing on real Aer, and fully tested.

## Environment

| Item | Value |
|---|---|
| Development environment | WSL2 (Ubuntu), per remediation option 2 below |
| Dedicated venv | `backend/.venv`, Python 3.12.14 |
| Executable | `backend/.venv/bin/python` |
| Git repository | Initialized in this session; see "Not committed" below for the first commit. |

Python 3.12 was installed via `~/.local/bin/python3.12` inside WSL2. The venv at `backend/.venv`
was built from that interpreter with `backend/requirements.txt` installed unmodified.

## Resolved: the Windows Smart App Control blocker

This section is kept for history. It no longer describes the current environment.

`qiskit/_accelerate.pyd` — a Rust-compiled native extension inside the `qiskit` package
itself (not `qiskit-aer`) — failed to import on the Windows host used earlier in this milestone:

```
ImportError: DLL load failed while importing _accelerate: An Application Control policy has blocked this file.
```

Root cause, confirmed by direct inspection at the time:

- `Get-AuthenticodeSignature` on the `.pyd` reported **`NotSigned`**.
- The registry key `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` had
  `VerifiedAndReputablePolicyState = 1` and `SAC_PreviousState = 2`, which is **Windows Smart App
  Control**, enabled and enforcing.
- The file carried **no** mark-of-the-web / zone-identifier stream (`Get-Item -Stream *` showed
  only `:$DATA`), so this was not a "downloaded file" block that `Unblock-File` could clear —
  confirmed by running `Unblock-File` and re-testing the import, which still failed identically.
- This was a **reputation-based** block: Smart App Control only allows binaries it or Microsoft's
  cloud recognises as reputable. `numpy`, `scipy` and `pydantic_core` — also compiled native
  extensions, installed in the same `pip install` — imported successfully, so the policy was not
  blocking native code categorically. It specifically declined `qiskit`'s freshly-downloaded,
  unsigned `.pyd`.

**Blast radius at the time:** `qiskit`, `qiskit-aer`, and `qiskit-qasm3-import` all failed (the
latter two import `qiskit` internally). `cirq-core`, `pennylane`, `fastapi`, `pydantic`, `uvicorn`,
`numpy` were unaffected.

### What was deliberately not done about it

Turning Smart App Control off is a one-way, machine-wide security change — Microsoft documents
that once turned off it cannot be turned back on without reinstalling Windows. No security policy,
registry key, or Defender setting was changed to work around this. The only mitigation attempted
was `Unblock-File` (reversible, unrelated to Smart App Control, and confirmed not to be the cause).

### How it was resolved

**Remediation option 2 was taken: development moved inside WSL2 (Ubuntu).** Smart App Control is a
Windows executable-loading policy; it does not apply inside the Linux subsystem.
`pip install -r backend/requirements.txt` there worked unmodified, and `qiskit`/`qiskit-aer` import
and execute correctly. This was reversible and did not change Windows' security posture at all.

The other options considered and not taken:

1. Turn off Smart App Control system-wide — irreversible without a Windows reinstall, not needed.
3. Use a different machine or cloud dev environment for the backend — not needed once WSL2 worked.
4. Wait for Smart App Control's reputation system to learn the file — not reliable on a hackathon
   timeline, not needed.

## What is built and verified

Everything in `backend/qentor/` is implemented and covered by passing tests, run in the WSL2
environment, today:

| Module | What it does | Test evidence |
|---|---|---|
| `qentor/circuit/model.py` | Canonical circuit model (Pydantic): qubit/clbit counts, gate ops with arity/index/parameter validation for h, x, y, z, s, t, rx, ry, rz, cx, measure. Deterministic canonical JSON. | 20/20 tests pass — valid circuits, every malformed/invalid case listed in the milestone spec, round-trip serialisation |
| `qentor/circuit/qasm.py` | Deterministic OpenQASM 3 emitter, no code execution, fixed statement templates only | 5/5 golden-fixture and determinism tests pass (`|0⟩`, X, H, Bell), plus independent re-parse via `qiskit_qasm3_import` |
| `qentor/circuit/hashing.py` | SHA-256 of the canonical QASM text; `qc_`-prefixed short id | 5/5 tests pass |
| `qentor/provenance/` | Pydantic `ProvenanceRecord` + SQLite `ProvenanceStore` (insert, get, list-by-hash, persistence across reopen) | 5/5 tests pass |
| `qentor/api/app.py`, `schemas.py` | `POST /api/execute`; request schema built on the canonical `Circuit` model with `extra="forbid"`, so a client cannot submit a probability, count, statevector or pass/fail field — there is no field for one | App imports and registers the route correctly; schema-rejection tests pass; Bell-circuit end-to-end acceptance tests pass in both statevector and shots mode |
| `qentor/execution/adapter.py`, `aer.py` | Real `AerAdapter` built against the actual `qiskit`/`qiskit-aer` API (statevector mode via `save_statevector()`, shots mode via `AerSimulator().run(..., shots=...)`, real error paths, no hand-computed probabilities) | Executes for real: Bell-state statevector and shots tests pass against live Aer output |
| Architecture rule | `execution/` and `verification/` contain no import of any `tutor` module, checked by static AST scan of every file in those packages, and re-checked on every future addition to them | 2/2 tests pass |

**Full suite: 44 tests, 44 passed, 0 skipped, 0 failed, 0 errored.**

```
backend/.venv/bin/python -m unittest discover -s backend/tests -t backend -v
```

## What changed since the previous update

- The Aer adapter has now actually run a circuit. `AerAdapter.run()` produces real statevectors and
  counts from a live Aer process; the 9 tests that were previously skipped (task 5's independent
  parser check, task 7's Aer execution, task 10's Bell acceptance test, task 12's Aer failure-mode
  behaviour) all pass now, with no code changes needed beyond a fix for a `qiskit-aer`
  `DeprecationWarning` (statevector results must be cast with `np.asarray` before use as an array;
  fixed in `qentor/execution/aer.py`).
- The emitted QASM's `bit[n] c;` / `c[i] = measure q[i];` syntax was confirmed to round-trip
  through `qiskit_qasm3_import` without modification.
- Aer's statevector amplitude ordering was confirmed to match the `q[n-1]…q[0]` convention this
  codebase assumes (the Bell-state acceptance tests would have failed otherwise).

Nothing above was worked around with mock data, a hand-rolled probability calculation, or a stub
that returns a plausible-looking result.

## Not committed (as of the previous update — see current git state for what followed)

No commit had been made as of the last update; there was no git repository at the project root.
That was because the milestone's stop condition (an actual end-to-end Aer run) was not yet met.
With the Aer blocker resolved and the full suite green, this is no longer the case.

## Next milestone

With Milestone 1's exit check met (Bell circuit through `/api/execute` returns provenance-carrying
probabilities), the next step per `docs/48_HOUR_PLAN.md` is the hour 6–12 Build screen, run in
parallel with starting the hour 6–8 hardware recording script (IBM queues are unpredictable and
this is the item most sensitive to elapsed time).
