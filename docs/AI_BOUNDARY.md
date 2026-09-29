# AI Boundary

The LLM is a narrator and a proposer. It is never the quantum computer, the grader or the
hardware. This document lists exactly what it may do, what it may not do, and what must pass
through a backend before a learner sees it.

## 1. What the AI is allowed to do

| Allowed | Condition |
|---|---|
| Explain a concept (superposition, phase kickback, why DJ needs one query) | Conceptual text only. Any number in it must be a fact reference. |
| Explain the learner's circuit | Uses the fact sheet: gate list, qubit count, backend results by id |
| Explain a verified result (probabilities, a counterexample, a noise gap) | Numbers appear only as references to facts the server supplied |
| Explain a misconception tag | The tag comes from deterministic rules. The AI explains it. |
| Give a hint | Conceptual hints freely. A hint that contains a circuit is a candidate (below). |
| Propose a candidate circuit (fix or optimisation) | Returned as the canonical JSON model. Shown only with its verification status. |
| Propose candidate code | Only as OpenQASM 3, parsed into the model. Python is never executed. |
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
- Only the current section is included, not the whole lesson. A quiz's correct option and answer
  rationale are never included, so a hint cannot give the answer away.
- With no key, a small router answers `explain` / `simpler` / `hint` from the lesson facts, in English,
  Hindi or Kannada. Only the wrapper text is localised; lesson prose, gate names, ids and numbers are
  interpolated verbatim. A circuit or result question with no result attached says there is nothing to
  explain yet.
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
