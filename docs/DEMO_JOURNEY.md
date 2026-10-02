# The canonical demo journey

One path through the product that shows what Qentor is, from the first screen to a shared experiment, and that can be re-run end to end against the
production build. It needs **no hardware** (nothing here is, or is labelled as, a hardware result) and **no LLM key** (the journey asserts that code
generation says it is unavailable and offers no request form). Every number it checks is read from the JSON the page itself received from the server.

Run it (`scripts/demo_journey.mjs`; Node 22+, Chrome, `npm ci` done in `web/`):

```
(cd web && npm run build)
QENTOR_DB_PATH=/tmp/demo.db backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --port 8011   # the production process
node scripts/demo_journey.mjs /tmp/demo-out http://127.0.0.1:8011      # JSON on stdout; screenshots in /tmp/demo-out; CHROME_PATH overrides the browser
```

Last run on the final build: **67 checks, all passed**; axe-core (WCAG 2.2 AA and best practice) on **35 screens at 1440, 390 and 320 px: 0 violations**;
no console error or warning; no failed API response; the production process (default AnyIO settings) stayed up and shut down cleanly.

## The steps (check ids in the output)

| # | Step | What is asserted |
|---|---|---|
| 1 | **Welcome** (J01) | The first visit shows Start learning / Try a challenge / Not now and says every number comes from a simulator on the server and the tutor never decides |
| 2 | **Learn** → Qubits & Measurement → **concept check** (J02) | The catalog has 18 lessons and no answer key; a wrong answer is "Not quite", a right one "Correct.", the explanation shown is the server's; the lab step offers **Open in Lab** |
| 3 | **Open in Lab** (J02d) | The canvas holds exactly the server's circuit for the lesson |
| 4 | **Build / edit** and **Run** (J03) | The learner clicks H, CX, M, M; Run sends the canonical circuit and the mode only; the answer carries a result id, circuit hash, backend, version and SIMULATION; every outcome and count on screen is the server's, labelled sampled, bit order stated |
| 5 | **Trace** and **select a step** (J04) | One server record per operation plus the start; terminal measurements listed, not run; the selected step shows per-qubit Bloch cards with their provenance |
| 6 | **Tutor "What changed?"** (J04c) | The answer is grounded in the server's trace step (facts, no number from the browser) |
| 7 | **Switch backend** and **Compare** (J05) | The same circuit runs on Cirq and says so; Compare backends is the server's agreement verdict over three simulators (threshold 1e-6) |
| 8 | **Optimize** (J06) | Original 3 → candidate 1 → equivalence check **Equivalent** → decision **Accepted**, all from the server's `VERIFIED_SHORTER`; the candidate has its own stored record; nothing changes until **Apply**; Apply is one undo step; the "no rule" example gives `NO_OPTIMIZATION_FOUND` with no candidate and no Apply |
| 9 | **Challenge** (J07) | Submitting sends only the circuit; the verdict (passed, checks, result id) is the server's and the page agrees |
| 10 | **Debug** (J08) | The report is the server's, from backend runs, with no model |
| 11 | **Progress** (J09) | The learner's own record: one check answered, one challenge of 19 solved |
| 12 | **Instructor / classroom** (J10) | A class is created (code and a one-time key shown once), the learner joins with an anonymous alias, answers a check and a challenge, and the dashboard shows the sample with captioned tables and no name or e-mail |
| 13 | **Share an experiment** (J11) | The request is the circuit and a run id only; the stored share has no owner, class, token, key or path |
| 14 | **Open the shared experiment** (J11) | A read-only page from stored data with its provenance and nothing to edit |
| 15 | **Fork into Lab** (J11d) | The Lab holds a copy; nothing is created or changed on the server |
| 16 | **Multilingual Tutor** (J12a) | A Hindi question is answered in a Hindi wrapper around the backend's facts (`language: hi` sent) |
| 17 | **AI generation unavailable** (J12b) | With no key the server says so and the Generate tab shows the unavailable state with no request form |
| 18 | **Probability reasoning** (J12c) | A structured request (no number from the browser); the card shows the server's outcomes with provenance and the bit order |
| 19 | **What-if reasoning** (J12d, J12e) | The server's counterfactual circuit is shown before anything runs; running it compares two recorded runs |
| 20 | **Guide** (J13) | Opens as a named panel, closes with Escape |
| 21 | **A long circuit** (J14) | Shor's lesson (one fixed 7-qubit instance) is walked to its lab step and its 29-operation circuit opens in the Lab without widening the page; phone widths (J15) and the audit (J16) follow |

## What it does not prove

It runs on one machine and one Chrome version. It uses the stand-in "unavailable" state for AI generation: the real model path has never run (no key was
available). It does not exercise hardware (none is built). It is a script, not a load test: `backend/scripts/stability_smoke.py` and
`backend/scripts/resource_smoke.py` measure the process under churn and load (see `BUILD_STATE.md` "Process stability" and "Resource limits").
