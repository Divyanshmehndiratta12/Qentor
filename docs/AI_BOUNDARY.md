# AI Boundary

The LLM is a narrator and a proposer. It is never the quantum computer, the grader or the
hardware. This document lists exactly what it may do, what it may not do, and what must pass
through a backend before a learner sees it.

> **As built (read this first).** The rules below are enforced by code, but the pipeline is simpler than §4 describes: the LLM returns
> a plain answer plus the ids of the facts it used (not typed claims or candidate circuits), and `tutor/guard.py` + `tutor/claims.py`
> reject any draft with a number, ket, bitstring, qualitative probability or verdict that the supplied facts do not support, or that cites
> a fact id that does not exist; the guard does not re-simulate. The LLM is off by default (`QENTOR_TUTOR_LLM_ENABLED` plus a key, both
> server-side only). §8 covers the debugger and comparison answers added later.

## 1. What the AI is allowed to do

| Allowed | Condition |
|---|---|
| Explain a concept (superposition, phase kickback, why DJ needs one query) | Conceptual text only. Any number in it must be a fact reference. |
| Explain the learner's circuit | Uses the fact sheet: gate list, qubit count, backend results by id |
| Explain a verified result (probabilities, a counterexample, a noise gap) | Numbers appear only as references to facts the server supplied |
| Explain a misconception tag | The tag comes from deterministic rules. The AI explains it. |
| Give a hint | Conceptual hints freely. A hint that contains a circuit is a candidate (below). |
| Propose a candidate circuit (fix or optimisation) | Returned as the canonical JSON model. Shown only with its verification status. |
| Propose candidate code | Only as OpenQASM 3, parsed into the model by the server's own parser. Python is never executed. Built: see §9 |
| Propose a candidate optimisation | Goes through the equivalence checker like any other proposal |
| Make a typed claim ("P(00)=0.5 for this circuit") | The claim is re-simulated. It is shown only if it matches, and then the backend value is shown. |
| Answer in the learner's selected language (P1) | Numbers still come from facts |
| Say it does not know | Always allowed and preferred to guessing |

## 2. What the AI is forbidden to do

The AI must never be the source of any of these, in any form, in any language:

- statevectors or amplitudes
- measurement probabilities or counts
- expectation values
- fidelity values or distances
- equivalence claims
- circuit correctness claims
- challenge pass/fail or test counts ("71 of 72 pass")
- counterexamples
- hardware results, device names or job ids
- optimisation verification results (gate counts after rewrite, "verified equivalent")
- mastery or progress scores

It is also forbidden to:
- write to the provenance log, the hardware library or learner progress (no code path exists)
- trigger a hardware job
- receive or reveal the API key or other secrets
- override a verifier verdict

## 3. What requires backend verification

| AI output | Verifier | Shown as |
|---|---|---|
| Candidate fix circuit | Challenge test spec on Aer (all inputs) | VERIFIED FIX if all pass; otherwise "AI suggestion rejected: fails on input …" with the backend counterexample |
| Candidate optimised circuit | Equivalence checker | VERIFIED EQUIVALENT with gate/depth delta; otherwise rejected with the distinguishing input |
| Typed numeric claim | Re-execution on Aer | The backend value with provenance; mismatches dropped and counted |
| Claim that a circuit produces a state | State-prep fidelity check | Verified or rejected |
| Claim of equivalence between two circuits | Equivalence checker | The checker's verdict, never the AI's |
| Claim about hardware behaviour | Recorded run lookup | Only recorded data with its badge; otherwise "no recorded run" |

## 4. The tutor pipeline

```
learner question + result_ids + language
   │
   ▼
1. Fact sheet builder (server)
   loads each result_id from the provenance log → facts with ids:
   F1 {kind: probability, basis: "000", value: 1.0, result: res_…}
   F2 {kind: test_summary, passed: 70, total: 72, result: res_…}
   F3 {kind: counterexample, oracle: 37, expected: "balanced", measured_zero_prob: 1.0, result: res_…}
   plus circuit gate list, qubit count, challenge goal, misconception tags, mastery (non-quantum)
   │
   ▼
2. LLM call (structured output, JSON schema)
   { "segments": [ {"type":"text","text":"…"}, {"type":"fact","id":"F2"} ],
     "claims":   [ {"type":"probability","circuit":"current","basis":"000","value":0.0} ],
     "candidate_circuit": { …canonical model… } | null,
     "candidate_purpose": "fix" | "optimise" | null }
   │
   ▼
3. Guard
   a. schema validation (reject → retry once → template)
   b. text segments: reject decimals, percentages, fractions, √ expressions, amplitudes,
      bitstring-probability pairs, counts, and verdict words without a matching report
      (allowed: qubit indices and gate names that appear in the circuit)
   c. fact refs must exist in the fact sheet
   │
   ▼
4. Re-simulation
   claims → Aer → keep matching claims as new facts; drop and count mismatches
   candidate_circuit → verification layer (test spec or equivalence)
   │
   ▼
5. Render
   text + <VerifiedValue> for every fact + verification card for any candidate
   footer: "AI explanation of verified results · N claims checked · M rejected"
```

**The guard as built (`qentor/tutor/guard.py`, `claims.py`).** The draft is parsed into typed *claims*
and the facts are parsed with the same parser; every claim must be supported by value, in any equivalent
notation. Claims are: integers and counts ("512 out of 1024"), decimals, percentages, fractions ("1/2"),
ratios ("3:1"), square-root expressions ("1/√2", also "/√2" after a ket), scientific notation, signed numbers
(a dropped minus sign is a different claim; a "magnitude" phrase licenses the unsigned value), the imaginary
part of an amplitude, bitstrings and kets that the facts do not mention, versions, number words of 3 or more
and fraction words ("half") next to a quantity noun, qualitative probability words ("always", "impossible",
"equally likely", which need a probability-1 outcome or equal probabilities in the facts), and verdicts
("verified", "equivalent", "passes", and "correct" about this circuit). A verdict can be licensed only by a
backend *result* fact that contains the word, and the execution-status fact deliberately does not, so a model
cannot call a state-checked circuit verified or correct. Lesson material may be restated (its own numbers,
"never", "verified" in a textbook sentence) but never turned into a claim about "this circuit" or "your
result". Deliberate limits: the qualitative-word checks are coarse, "one" and "two" as words are ordinary
prose, and a claim that merely restates a lesson number is allowed. Measured false-positive rate: 0 of 837
deterministic lesson answers (every lesson, section, question and language), 0 of every step answer over
one- and two-qubit traces, and 0 of the result answers, read back as if they were model drafts.

**Fallback.** With no API key, a timeout of 8 seconds, or two guard failures, the server builds a
template explanation from the same facts, for example: "Your circuit returned outcome 000 with
probability {F1} for oracle 37, which is balanced." It is labelled "Explanation generated without AI".
The demo never depends on the LLM being reachable.

**Lesson context (as built).** `POST /api/tutor` also accepts optional `lesson_id` and `section_id`.
They are identifiers only: the browser never sends lesson text, and the server resolves both against
its own lesson registry (`qentor.lessons`). An unknown lesson, an unknown section, or a section that
belongs to another lesson is a structured error (`TUTOR_LESSON_NOT_FOUND`, `TUTOR_SECTION_NOT_FOUND`,
`TUTOR_SECTION_MISMATCH`), never silently ignored. `result_id` and `circuit` become optional as a
pair, so a lesson question needs no executed result.

Two sources, two authorities, kept apart by id:

| Source | Fact ids | Authoritative for | Carries provenance |
|---|---|---|---|
| Lesson registry (`qentor.tutor.lesson_context`) | `L1…` | Lesson explanation: overview, objectives, the current section | No. It is course material, not a quantum result. Its `result_id` is `null`. |
| Provenance log (`qentor.tutor.facts`) | `F1…` | Every quantum number, outcome and verdict | Yes: result id, hash, backend, mode, class, status |

- The LLM receives `LESSON CONTEXT`, `QUANTUM RESULT FACTS`, the question and the language as separate
  blocks. Its system prompt adds: quantum numbers come only from the result facts, never compute a new
  result, say so if the facts are not enough. The guard validates a draft against both lists together,
  so a number that appears in neither is still rejected.
- Only the current section is included, not the whole lesson. For a quiz, lab or reflection that is
  the section itself plus the (up to two) explanation sections closest before it, in lesson order
  (the first explanation if none precede it); a foundation lesson has nine sections and every later lesson ten, and a prompt
  never carries all of them. A quiz's correct option and answer rationale are never included, so a
  hint cannot give the answer away. "Simpler" and "hint" quote the nearest of those explanations. The
  answer key and the explanation are kept out of `GET /api/lessons` too: a client sends its selection to
  the grading endpoint (`qentor.lessons.grading`) and gets correctness and the explanation back. Grading
  is a plain comparison with the authored key; no model is involved, and nothing is taken from the client
  but the ids and the option it picked.
- Lesson prose lives only in `qentor.lessons` and is authored in English. No lesson text contains a
  decimal or percentage (so it cannot be mistaken for a result), and worked examples are labelled as
  textbook algebra with the numbers left to the Lab and Trace. `tests/test_lesson_content.py` checks
  each lab circuit and each computable answer key against the real backend.
- With no key, a small router answers `explain` / `simpler` / `hint` from the lesson facts, in English,
  Hindi or Kannada. Only the wrapper text is localised; lesson prose, gate names, ids and numbers are
  interpolated verbatim. A circuit or result question with no result attached says there is nothing to
  explain yet.
- Lessons 11 to 13 (`qentor.lessons.content_batch1`: Superdense Coding, Quantum Teleportation, Grover's Search) use the same section types and the
  same prose rules. Each is ONE small fixed example and says so. The teleportation lesson says plainly (section s2, repeated in its lab
  and second check) that the circuit model has no mid-circuit measurement or classical control, so its corrections are DEFERRED controlled
  gates, and that this is not the full dynamic protocol. No multi-qubit ket appears in their prose (bit strings are written q1 q0 in words).
  `tests/test_batch1_lessons.py` runs every linked circuit, every variant a lesson asks the learner to build, and every answer key on Aer.
- Lessons 14 to 16 (`qentor.lessons.content_algorithms`: Quantum Fourier Transform, Quantum Phase Estimation, Quantum Error Correction) follow
  the same rules, and three statements are tested wherever they matter: the QFT lesson claims no speed; the QPE lesson separates its exact
  fixed example from the general algorithm; the QEC lesson says the injected error is a fixed gate, NOT a noise model, and that its correction is
  deferred. Their three challenges (`qft-2qubit`, `qpe-estimate-t`, `qec-correct-flip-q1`) are judged only by the backend: operator equivalence for
  the QFT, state and per-qubit checks on Aer for the other two (with a substituted re-run for QPE). The Tutor reads the lessons' prose and, with a
  run, the backend's facts; no lesson prose contains a quantum result and `test_algorithm_lessons.py` checks every statement a lesson makes
  about the physics on Aer.
- The three advanced lessons (`qentor.lessons.content_advanced`) use the same section types and the same
  rules. Each is about ONE fixed example and says so; nothing generates an oracle. The Phase Kickback
  lab circuit prepares its target in |−⟩ (X then H on q1), so it is a clean kickback; the lesson has the learner delete the H on q1 and rerun as the contrast case (target |1⟩, not an eigenstate). The Bernstein–Vazirani example's secret
  has a 1 on q0 and a 0 on q1, which Qentor prints as 01. `tests/test_advanced_lessons.py` runs every
  linked circuit, every variant a lesson asks the learner to build, and every concept check's answer key
  on Aer.
- Free-text questions with a lesson open: the keyword router runs first, then one data-driven rule. A
  question is "about this lesson" if it shares a content word (6-letter stem, generic words excluded)
  with that lesson's own prose (title, description, objectives, current section and its supporting
  material). Such a question is answered from the lesson; one that asks for "the result" or "the
  circuit" with none attached gets the honest no-result message; anything else says it has no
  deterministic answer. Each question is independent: the backend has no conversation history, and
  "explain that more simply" is a simpler request about the same lesson and section, not a reference
  to the previous answer.
- The browser keeps one conversation per lesson for the session (in memory only), separate from the
  Lab's, and never shows one context's messages in another.
- A lesson-only answer has no provenance badge and is never labelled as a verified quantum result. When
  a result is attached, its provenance is unchanged and the lesson adds context only.
- A request without lesson context behaves exactly as before, including the LLM call shape.

**Trace-step context (as built).** `POST /api/tutor` also accepts an optional `trace_step`: the
selected step of an execution trace, as an IDENTITY only (`step_index`, `operation_index`, the
`operation`, `result_id`, `execution_id`, `circuit_hash`, `backend`, `backend_version`,
`previous_result_id`). There is no field for an amplitude, probability or Bloch coordinate, and the
schema forbids extra fields, so the browser cannot send one. It needs the `circuit` the trace was
made from and may accompany a `result_id` (a Lab result), a lesson, or neither.

- Each trace step is an ordinary provenance record whose circuit hash is the hash of the circuit
  prefix up to that step (terminal measurements stripped). The API layer fetches the step's record
  and the previous step's, and `qentor.tutor.trace_context` VERIFIES the claimed identity: the
  prefix hash recomputed from the circuit, the result id, execution id, backend, backend version,
  operation and mode. An unknown result id is `TUTOR_TRACE_RESULT_NOT_FOUND` (404); a step that does
  not add up is `TUTOR_TRACE_STEP_MISMATCH` (422). Neither is silently ignored or "explained anyway".
- Facts carry the id `S1…` (kind `trace_step`, `trace_operation`, `trace_gate_note`, `trace_status`,
  `trace_amplitude`, `trace_bloch`, `trace_note`) and the record's provenance. They are read from the
  stored statevector and from the Bloch vector the backend derives from it
  (`qentor.execution.bloch`); the tutor layer adds no quantum arithmetic beyond filtering
  near-zero amplitudes. A Bloch vector exists only for one-qubit steps; for larger states the facts
  say so instead. A step whose record has no usable state says "unavailable" and gives no numbers.
  The gate notes are a fixed glossary keyed by the gate the learner placed, not derived results.
- Deterministic path (`qentor.tutor.step_answers`): three small intents — what changed from the
  previous step, what the selected gate did, and why the Bloch vector moved — answered in English,
  Hindi or Kannada by quoting the S-facts. Any other question keeps its existing behaviour, and
  a step question the facts cannot answer says so.
- LLM path: a `TRACE STEP CONTEXT` block joins `LESSON CONTEXT`, `QUANTUM RESULT FACTS`, the question
  and the language. The system prompt adds: quantum values only from the supplied facts, never
  calculate or invent amplitudes, probabilities or Bloch coordinates, say so if they are not enough.
  The guard validates a draft against F, L and S facts together.
- The response echoes the step (`trace_step`: one-based step number, total steps, the record's result
  id, circuit hash, provenance class and verification status) so the UI can say which step an answer
  is about. A step-only answer reports the step's record as its provenance; with a Lab result the
  top-level provenance stays the result's.
- Browser: the Trace viewer's selected step lives in the Build store as a step index — changing it
  changes nothing else. The Lab guide offers one contextual starter, "What changed in this step?",
  only while a trace is loaded; Learn questions never carry a step.

## 5. Prompting rules (secondary to the code above)

The system prompt tells the model the same rules, but correctness does not depend on the model
obeying them. The model is told:
- use fact references for every number;
- put numeric statements it wants to make in `claims`, not in text;
- return circuits only as the canonical JSON model;
- say "I can't verify that" instead of guessing.

## 6. Model and provider

- Provider-agnostic adapter interface: `generate(fact_sheet, question, language) -> TutorDraft`.
- Default adapter: Anthropic API, model `claude-opus-5`, structured outputs through `output_config.format` with the tutor JSON schema, low effort for latency. Configurable by environment variable.
- The API key is read from the server environment. It never reaches the browser bundle.
- A fake adapter used in tests returns scripted lies: invented probabilities, a false "all tests pass", a wrong fix circuit, a wrong equivalence claim. The guard must reject every one.

## 7. What the UI tells the learner

- Every tutor message shows who wrote it: "AI explanation of verified results" or "Explanation generated without AI".
- Every number in a tutor message is a `VerifiedValue` with its badge.
- Rejected AI claims are counted visibly. This is a deliberate demo moment: the judge sees the verifier catch the AI.
- A candidate circuit is never auto-applied. The learner applies it only after it shows VERIFIED.

## 8. Debugger, comparison and challenge verdicts

Three features touch verdicts and explanations. The boundary is the same; this is how it applies.

**Challenge pass/fail is never AI.** `challenges/evaluate.py` decides it from backend statevectors and structural rules. The
challenges package cannot import the tutor or any LLM code (import-graph test), the submit request has no field for a verdict or a
number, and a test runs the endpoint with an LLM adapter that raises if called. The tutor and the debugger only ever explain a verdict
that already exists. This includes the optimisation challenge: whether a shorter circuit is the same circuit is
`check_equivalence`'s answer (`EquivalentTo`), and the optimiser's own diff and rule sentences are server-computed structure, not a result.

**"Debug my circuit"** (`POST /api/debug`, `tutor/debugger.py`) is built from facts the server holds: `F#` (a Lab run's record), `S#` (a
verified trace step), `C#` (the challenge's goal and authored coaching) and `E#` (the per-check outcomes of an attempt the server
judged, with the numbers behind them). The report is deterministic:

- the **evidence** bullets quote facts verbatim;
- the **likely mismatch** and **next experiment** for a failed check are authored per check in the challenge definition;
- the **hint** is the authored hint for the failing check;
- the learner's **goal text** is untrusted: cleaned, capped at 400 characters, echoed (quoted) only where there is no challenge, never acted on.

An LLM, if configured, may rewrite only the three prose fields (observed, mismatch, next experiment). Its draft must pass the claim guard
**and** must agree with the attempt's own verdict (a draft that calls a failed attempt solved, or the reverse, is rejected), cite only
real fact ids, and otherwise the template is used and labelled "Explanation generated without AI". It can never supply evidence or the
hint. Ids are verified before anything is built: an unknown record is 404, and a result or attempt made for a different circuit is 422.

**Comparing experiments** (`POST /api/compare/experiments`) is computed entirely by `verification/experiment_compare.py` and stored as its
own provenance record. **"Ask Tutor about this difference"** (`POST /api/tutor/comparison`) sends only the comparison id; the tutor reads
`X#` facts from that record and answers through the same guard. Runs that failed their state check, or that are not simulations, are
refused rather than compared.

Tests that pin this: `test_debugger.py` (fake LLMs that invent numbers, verdicts, kets and citations), `test_experiment_compare.py`,
`test_challenges.py`, and `backend/scripts/mutation_check.py` (each rule above has a mutant that must be caught).

## 9. AI code generation

A learner can describe a circuit in words and a language model can PROPOSE OpenQASM 3 for it (`POST /api/generate/circuit`,
`qentor/tutor/proposal.py`). The model proposes; every decision about the proposal is made by the backend.

1. **Context.** The model sees the learner's words (untrusted text, capped at 600 characters), optionally the lesson they are in
   (the registry's `L#` facts: no answer key, no explanation), a challenge's PUBLIC brief (goal, gates, size: never a reference
   solution or a check target) and the learner's current circuit as the server's own canonical text. None of it is a result.
2. **The model's reply** is JSON: OpenQASM 3 text and one or two sentences of explanation. Both are untrusted.
3. **The text is read by the server's own parser** (`qentor/circuit/qasm_parse.py`): a fixed subset (one qubit register, the model's
   gates, `c[i] = measure q[j];`, angles with `pi` and `+ - * /`), never executed, never Python, no block constructs, no second
   register. Anything else is refused with its line and a reason; nothing is guessed or dropped. A parsed proposal is then checked
   against the proposal limits (8 qubits, 60 operations) and the platform's run limits and gate support.
4. **What the learner may insert is the canonical OpenQASM emitted from the parsed circuit**, not the model's own text (comments,
   spelling and surprises are gone). The model's text is shown only behind a disclosure.
5. **The explanation** goes through the existing claim guard against the one fact the backend has about the proposal: its structure
   (qubits, operations, in order). A probability, amplitude, count, outcome or verdict in it is a claim no backend produced, so the
   whole explanation is replaced by a template written from the parsed circuit, and the response says so (`explanation_source` is `AI`
   or `TEMPLATE`, with a note).
6. **A proposal is never "correct" because the model wrote it.** The response carries `verification_status = UNVERIFIED_AGAINST_INTENT`
   and the label "AI proposal — not yet verified against your intent", which the UI shows verbatim (the browser defines no label of its
   own). What a proposal does is learned only by running it: Insert replaces the learner's circuit as one undo step, Run is the
   ordinary Run (the backend's numbers with provenance), Explain is the ordinary result-grounded tutor question, and for a challenge
   the verdict comes only from submitting the circuit to the server's evaluator. The proposal response has no field for a result.

**No key, no feature, no substitute.** `GET /api/generate/status` says whether a language model is configured in the server's own
environment (`QENTOR_TUTOR_LLM_ENABLED` and an API key). If not, the UI says so and offers no form, `POST` is a 503
`AI_GENERATION_UNAVAILABLE`, and there is no deterministic generator behind it: a canned circuit would pass for an AI one. A provider
failure is a 502 `AI_GENERATION_FAILED` the client may retry. Nothing else in Qentor needs a key.

Tests (`test_qasm_parse.py`, `test_ai_generation.py`, the web `generate.test.tsx` and `realClient.generate.test.ts`) use a stand-in
model, including one that returns Python, invented probabilities, verdicts and prompt injection; the Anthropic adapter's request and
every failure mode are tested with the HTTP transport mocked. The real provider path has not been run in this build (no key).
