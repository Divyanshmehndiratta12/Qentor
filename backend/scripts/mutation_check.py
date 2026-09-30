"""Mutation check for the trust-sensitive logic.

Each mutant makes ONE small change that would break a trust rule (a check that always passes, a verdict that can be flipped, a
number shown without provenance, an id not verified ...), runs the tests that are supposed to guard it, and requires them to FAIL.
A mutant that the tests do not catch ("survived") means a trust rule is not actually protected, and the script exits non-zero.

Every mutated file is restored from the text read before the change, in a ``finally``, whatever happens. Run from the repo root:

    backend/.venv/bin/python backend/scripts/mutation_check.py            # everything
    backend/.venv/bin/python backend/scripts/mutation_check.py backend    # only the backend mutants
    backend/.venv/bin/python backend/scripts/mutation_check.py web        # only the frontend mutants (needs node 22 on PATH)
    backend/.venv/bin/python backend/scripts/mutation_check.py all cp     # only mutants whose name contains "cp"
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PY = str(ROOT / "backend" / ".venv" / "bin" / "python")


@dataclass
class Mutant:
    name: str
    file: str
    old: str
    new: str
    tests: list[str]  # backend: test module file names; web: test file paths relative to web/


BACKEND = [
    Mutant("challenge: a state check always passes", "backend/qentor/challenges/evaluate.py",
           "ok = 1.0 - f <= TOLERANCE", "ok = True", ["test_challenges.py"]),
    Mutant("challenge: a 'state differs' check always passes", "backend/qentor/challenges/evaluate.py",
           "ok = 1.0 - f > MIN_DIFFERENCE", "ok = True", ["test_challenges.py"]),
    Mutant("challenge: passed = any check instead of all", "backend/qentor/challenges/evaluate.py",
           "passed=all(c.passed for c in checks),\n        checks=checks,\n        backend=trace.backend",
           "passed=any(c.passed for c in checks),\n        checks=checks,\n        backend=trace.backend", ["test_challenges.py"]),
    Mutant("challenge: structure failures no longer stop evaluation", "backend/qentor/challenges/evaluate.py",
           "if not structure_ok:", "if False:", ["test_challenges.py"]),
    Mutant("challenge: the fixed oracle need not be present", "backend/qentor/challenges/evaluate.py",
           "len(starts) == 1,\n            \"The fixed oracle is present once", "True,\n            \"The fixed oracle is present once", ["test_challenges.py"]),
    Mutant("challenge: fidelity ignores the imaginary part", "backend/qentor/challenges/evaluate.py",
           "    return re * re + im * im\n\n\ndef probabilities", "    return re * re\n\n\ndef probabilities", ["test_challenges.py"]),
    Mutant("challenge: marginal keys are not highest-qubit-first", "backend/qentor/challenges/evaluate.py",
           "chosen = sorted(range(num_qubits) if qubits is None else qubits, reverse=True)",
           "chosen = sorted(range(num_qubits) if qubits is None else qubits)", ["test_challenges.py"]),
    Mutant("api: the submit response always says passed", "backend/qentor/api/app.py",
           "        passed=evaluation.passed,\n        verifier=evaluation.verifier,", "        passed=True,\n        verifier=evaluation.verifier,", ["test_challenges.py"]),
    Mutant("api: a failed attempt is logged as passed", "backend/qentor/api/app.py",
           "        passed=evaluation.passed,\n        final_result_id=evaluation.final_result_id,", "        passed=True,\n        final_result_id=evaluation.final_result_id,", ["test_challenges.py"]),
    Mutant("api: the submit request accepts extra fields", "backend/qentor/api/schemas.py",
           "class ChallengeSubmitRequest(BaseModel):\n    \"\"\"The learner's canonical circuit and nothing else. There is no field for a verdict, a state or a number: the server\n    judges the circuit itself.\"\"\"\n\n    model_config = ConfigDict(extra=\"forbid\")",
           "class ChallengeSubmitRequest(BaseModel):\n    \"\"\"The learner's canonical circuit and nothing else. There is no field for a verdict, a state or a number: the server\n    judges the circuit itself.\"\"\"\n\n    model_config = ConfigDict(extra=\"allow\")", ["test_challenges.py"]),
    Mutant("challenge: a check may point at a hint that does not exist", "backend/qentor/challenges/models.py",
           "if check.hint_index >= len(self.hints):", "if False:", ["test_challenges.py"]),
    Mutant("debugger: a verdict contradicting the server is accepted", "backend/qentor/tutor/debugger.py",
           "if attempt_passed is False and _SAYS_SOLVED.search(text):", "if False and _SAYS_SOLVED.search(text):", ["test_debugger.py"]),
    Mutant("debugger: the claim guard is skipped on LLM prose", "backend/qentor/tutor/debugger.py",
           "        if violations:\n            raise DebugGuardRejection(f\"draft field", "        if False:\n            raise DebugGuardRejection(f\"draft field", ["test_debugger.py"]),
    Mutant("debugger: unknown cited fact ids are accepted", "backend/qentor/tutor/debugger.py",
           "any(fid not in known for fid in draft.cited_fact_ids)", "False", ["test_debugger.py"]),
    Mutant("debugger: the hint may come from the model", "backend/qentor/tutor/debugger.py",
           "            \"next_experiment\": DebugSection(text=draft.next_experiment.strip(), fact_ids=cited),\n",
           "            \"next_experiment\": DebugSection(text=draft.next_experiment.strip(), fact_ids=cited),\n            \"hint\": DebugSection(text=draft.observed.strip(), fact_ids=cited),\n", ["test_debugger.py"]),
    Mutant("api: debug accepts an attempt made for another circuit", "backend/qentor/api/app.py",
           "if attempt_record.challenge_id != challenge.id or attempt_record.circuit_hash != circuit_hash_:", "if False:", ["test_debugger.py"]),
    Mutant("api: debug accepts a result of another circuit", "backend/qentor/api/app.py",
           "        if record.circuit_hash != circuit_hash_:\n            raise HTTPException(\n                status_code=422,\n                detail=(\n                    f\"circuit does not match provenance record '{request.result_id}': \"\n                    f\"got circuit hash '{circuit_hash_}'",
           "        if False:\n            raise HTTPException(\n                status_code=422,\n                detail=(\n                    f\"circuit does not match provenance record '{request.result_id}': \"\n                    f\"got circuit hash '{circuit_hash_}'", ["test_debugger.py"]),
    Mutant("compare: total variation distance is not halved", "backend/qentor/verification/experiment_compare.py",
           "total_variation_distance=0.5 * sum(diffs)", "total_variation_distance=sum(diffs)", ["test_experiment_compare.py"]),
    Mutant("compare: the difference loses its absolute value", "backend/qentor/verification/experiment_compare.py",
           "difference=abs(a[key] - b[key]) if key in a and key in b else None", "difference=(a[key] - b[key]) if key in a and key in b else None", ["test_experiment_compare.py"]),
    Mutant("compare: an absent outcome is treated as zero", "backend/qentor/verification/experiment_compare.py",
           "a=a.get(key),\n            b=b.get(key),", "a=a.get(key, 0.0),\n            b=b.get(key, 0.0),", ["test_experiment_compare.py"]),
    Mutant("compare: a sampled and a theoretical run are not labelled", "backend/qentor/verification/experiment_compare.py",
           "    if kind_a != kind_b:\n        note =", "    if False:\n        note =", ["test_experiment_compare.py"]),
    Mutant("compare: a hardware run is compared as a simulation", "backend/qentor/api/app.py",
           "    if record.provenance_class != ProvenanceClass.SIMULATION:\n        raise HTTPException(\n            status_code=422,\n            detail={\"code\": \"COMPARISON_CLASS_UNSUPPORTED\"",
           "    if False:\n        raise HTTPException(\n            status_code=422,\n            detail={\"code\": \"COMPARISON_CLASS_UNSUPPORTED\"", ["test_experiment_compare.py"]),
    Mutant("compare: a run of another circuit is accepted", "backend/qentor/api/app.py",
           "    got = circuit_hash(circuit)\n    if got != record.circuit_hash:", "    got = circuit_hash(circuit)\n    if False:", ["test_experiment_compare.py"]),
    Mutant("compare: a failed run is compared", "backend/qentor/api/app.py",
           "    if record.verification_status != ExecutionStatus.STATE_CHECKED:\n        raise HTTPException(\n            status_code=422,\n            detail={\"code\": \"COMPARISON_RESULT_UNUSABLE\"",
           "    if False:\n        raise HTTPException(\n            status_code=422,\n            detail={\"code\": \"COMPARISON_RESULT_UNUSABLE\"", ["test_experiment_compare.py"]),
    Mutant("tutor: comparison facts do not carry the comparison record id", "backend/qentor/tutor/comparison.py",
           "result_id=record.result_id))", "result_id=None))", ["test_experiment_compare.py"]),
    Mutant("export: a run of another circuit is attached", "backend/qentor/api/app.py",
           "        if record.circuit_hash != chash:\n            raise HTTPException(\n                status_code=422,\n                detail=f\"circuit does not match provenance record '{request.result_id}': got circuit hash '{chash}'",
           "        if False:\n            raise HTTPException(\n                status_code=422,\n                detail=f\"circuit does not match provenance record '{request.result_id}': got circuit hash '{chash}'", ["test_export.py"]),
    Mutant("export: the request accepts extra fields (a smuggled result)", "backend/qentor/api/schemas.py",
           "    circuit: Circuit\n    result_id: str | None = Field(default=None, min_length=1)\n\n\nclass ExportResponse",
           "    circuit: Circuit\n    result_id: str | None = Field(default=None, min_length=1)\n    model_config = ConfigDict(extra=\"allow\")\n\n\nclass ExportResponse", ["test_export.py"]),
    Mutant("architecture: the tutor may import the attempt writer", "backend/qentor/tutor/debugger.py",
           "from qentor.provenance.models import ExecutionStatus, ProvenanceRecord",
           "from qentor.provenance.models import ExecutionStatus, ProvenanceRecord\nfrom qentor.provenance.attempts import AttemptStore  # mutant", ["test_debugger.py", "test_architecture_rule.py"]),
    Mutant("packaging: the health check is registered twice", "backend/qentor/api/app.py",
           '@app.get("/api/lessons", response_model=LessonCatalogResponse)',
           '@app.get("/api/health")\ndef _health_again() -> dict[str, str]:\n    return {}\n\n\n@app.get("/api/lessons", response_model=LessonCatalogResponse)', ["test_deployment.py"]),
    # --- cp gate ---
    Mutant("cp: the Cirq adapter negates the angle", "backend/qentor/execution/cirq_adapter.py",
           "cirq.cphase(op.params[0])", "cirq.cphase(-op.params[0])", ["test_cp_gate.py"]),
    Mutant("cp: the PennyLane adapter reads the control as the angle's wire twice", "backend/qentor/execution/pennylane_adapter.py",
           "qml.ControlledPhaseShift(op.params[0], wires=[wire_of(op.controls[0]), wire_of(op.targets[0])])",
           "qml.ControlledPhaseShift(op.params[0], wires=[wire_of(op.controls[0]), wire_of(op.controls[0])])", ["test_cp_gate.py"]),
    Mutant("cp: the QASM text drops the angle", "backend/qentor/circuit/qasm.py",
           'lines.append(f"cp({_format_angle(op.params[0])}) q[{op.controls[0]}], q[{op.targets[0]}];")',
           'lines.append(f"cp(0.0) q[{op.controls[0]}], q[{op.targets[0]}];")', ["test_cp_gate.py", "test_golden_fixtures.py"]),
    Mutant("cp: the model accepts a cp with no angle", "backend/qentor/circuit/model.py",
           'raise ValueError(f"cp takes exactly 1 parameter (a phase in radians), got {len(self.params)}")', "pass", ["test_cp_gate.py"]),
    Mutant("cp: the tutor describes a cp without its angle", "backend/qentor/tutor/facts.py",
           "if op.controls and op.params:", "if False:", ["test_cp_gate.py"]),
    Mutant("cp: generated Qiskit code swaps control and target", "backend/qentor/circuit/codegen.py",
           'return f"qc.cp({_format_angle(op.params[0])}, {op.controls[0]}, {op.targets[0]})"',
           'return f"qc.cp({_format_angle(op.params[0])}, {op.targets[0]}, {op.controls[0]})"', ["test_cp_gate.py", "test_codegen.py"]),
    # --- per-qubit reduced state and the amplitude view ---
    Mutant("reduced state: the Bloch y component has the wrong sign", "backend/qentor/execution/reduced_state.py",
           "y = -2.0 * rho01.imag", "y = 2.0 * rho01.imag", ["test_reduced_state.py"]),
    Mutant("reduced state: a qubit counts as entangled only when it is maximally mixed", "backend/qentor/execution/reduced_state.py",
           "entangled_with_rest=purity < 1.0 - ENTANGLEMENT_TOLERANCE", "entangled_with_rest=purity < 0.5", ["test_reduced_state.py"]),
    Mutant("reduced state: an impossible qubit state is shown instead of marked unusable", "backend/qentor/execution/reduced_state.py",
           "if not (0.5 - VALIDITY_TOLERANCE <= purity <= 1.0 + VALIDITY_TOLERANCE):", "if False:", ["test_reduced_state.py"]),
    Mutant("reduced state: an over-long Bloch vector is shown instead of marked unusable", "backend/qentor/execution/reduced_state.py",
           "if not length <= 1.0 + VALIDITY_TOLERANCE:", "if False:", ["test_reduced_state.py"]),
    Mutant("reduced state: an unnormalised state is reduced anyway", "backend/qentor/execution/reduced_state.py",
           "if not abs(norm - 1.0) <= NORM_TOLERANCE:", "if False:", ["test_reduced_state.py"]),
    Mutant("reduced state: the qubit index reads the wrong bit", "backend/qentor/execution/reduced_state.py",
           "mask = 1 << qubit\n    rho00", "mask = 1 << (qubit ^ 1)\n    rho00", ["test_reduced_state.py"]),
    Mutant("trace: a qubit state points at another step's provenance", "backend/qentor/execution/trace.py",
           "source = BlochSource(\n            step_index=step_index,", "source = BlochSource(\n            step_index=0,", ["test_reduced_state.py"]),
    Mutant("api: the trace response drops the per-qubit states", "backend/qentor/api/app.py",
           "qubit_states=step.qubit_states,", "qubit_states=[],", ["test_reduced_state.py"]),
    Mutant("amplitude view: a zero amplitude is given a phase", "backend/qentor/execution/amplitude_view.py",
           "phase=math.atan2(im, re) if probability > PHASE_DEFINED_ABOVE else None,", "phase=math.atan2(im, re),", ["test_reduced_state.py"]),
    Mutant("amplitude view: the phase sign is flipped", "backend/qentor/execution/amplitude_view.py",
           "math.atan2(im, re) if", "math.atan2(-im, re) if", ["test_reduced_state.py"]),
]

WEB = [
    Mutant("web: a challenge is solved whatever the server said", "web/src/features/challenges/store.ts",
           "solved: before.solved || result.passed,", "solved: true,", ["src/features/challenges/store.test.ts"]),
    Mutant("web: a failed attempt counts as learning activity", "web/src/features/challenges/store.ts",
           "if (result.passed) recordChallengeActivity()", "recordChallengeActivity()", ["src/features/challenges/store.test.ts"]),
    Mutant("web: an answer for another challenge is shown", "web/src/features/challenges/store.ts",
           "if (get().selectedId !== challenge.id) return set({ isSubmitting: false })\n      set({ submission:", "if (false) return set({ isSubmitting: false })\n      set({ submission:", ["src/features/challenges/store.test.ts"]),
    Mutant("web: numbers are accepted without a provenance record", "web/src/api/realClient.ts",
           "if (c.evidence.length > 0 && !record) {", "if (false) {", ["src/api/realClient.challenges.test.ts"]),
    Mutant("web: the submit body carries more than the circuit", "web/src/api/realClient.ts",
           "{ circuit: CircuitSchema.parse(circuit) },\n      ChallengeSubmitResponseSchema,", "{ circuit: CircuitSchema.parse(circuit), passed: true },\n      ChallengeSubmitResponseSchema,", ["src/api/realClient.challenges.test.ts"]),
    Mutant("web: comparison numbers lose their provenance class", "web/src/api/realClient.ts",
           "const q = (v: number | null) => (v === null ? null : toQuantumValue(v, prov))", "const q = (v: number | null) => (v === null ? null : toQuantumValue(v, provenanceFromTraceStep(response.a.provenance)))", ["src/api/realClient.compare.test.ts"]),
    Mutant("web: an absent outcome is shown as zero", "web/src/api/realClient.ts",
           "const q = (v: number | null) => (v === null ? null : toQuantumValue(v, prov))", "const q = (v: number | null) => toQuantumValue(v ?? 0, prov)", ["src/api/realClient.compare.test.ts"]),
    Mutant("web: the debug goal is sent untrimmed", "web/src/api/realClient.ts",
           "const goal = input.goal?.trim()", "const goal = input.goal", ["src/api/realClient.debug.test.ts"]),
    Mutant("web: a challenge id is sent without an attempt id", "web/src/api/realClient.ts",
           "if (input.challengeId && input.attemptId) {", "if (input.challengeId || input.attemptId) {", ["src/api/realClient.debug.test.ts"]),
    Mutant("web: the recommendation ignores lesson completion", "web/src/features/learn/recommendation.ts",
           "const open = known.filter((c) => completed(c.lessonId) && !records[c.id]?.solved)", "const open = known.filter((c) => !records[c.id]?.solved)", ["src/features/learn/recommendation.test.ts"]),
    Mutant("web: the struggle rule fires too early", "web/src/features/learn/recommendation.ts",
           "r.attempts >= STRUGGLE_ATTEMPTS &&", "r.attempts >= 0 &&", ["src/features/learn/recommendation.test.ts"]),
    Mutant("web: a solved challenge is recommended again", "web/src/features/learn/recommendation.ts",
           "const open = known.filter((c) => completed(c.lessonId) && !records[c.id]?.solved)", "const open = known.filter((c) => completed(c.lessonId))", ["src/features/learn/recommendation.test.ts"]),
    Mutant("web: a share link with extra fields is accepted", "web/src/features/share/shareLink.ts",
           "CircuitSchema.strict().safeParse(json)", "CircuitSchema.safeParse(json)", ["src/features/share/share.test.tsx"]),
    Mutant("web: an oversized share link is accepted", "web/src/features/share/shareLink.ts",
           "if (encoded.length > MAX_ENCODED_LENGTH) return", "if (false) return", ["src/features/share/share.test.tsx"]),
    Mutant("web: the verdict says Solved whatever the server said", "web/src/features/challenges/SubmissionPanel.tsx",
           "{submission.passed ? 'Solved' : 'Not solved yet'}", "Solved", ["src/features/challenges/ChallengesScreen.test.tsx"]),
    Mutant("web: a stale verdict is not marked stale", "web/src/features/challenges/ChallengesScreen.tsx",
           "submission.circuit === circuit", "true", ["src/features/challenges/ChallengesScreen.test.tsx"]),
    Mutant("web: disallowed gates are usable", "web/src/features/build/GatePalette.tsx",
           "disabled={!allowed}", "disabled={false}", ["src/features/challenges/ChallengesScreen.test.tsx"]),
    Mutant("web: status shows Solved for an attempted challenge", "web/src/features/challenges/ChallengeList.tsx",
           "if (record?.solved) return 'solved'", "if (record && record.attempts > 0) return 'solved'", ["src/features/challenges/ChallengesScreen.test.tsx"]),
    Mutant("web: stored 'solved' with no attempts is trusted", "web/src/features/challenges/challengeStorage.ts",
           "if (value.solved && attempts < 1) return null", "", ["src/features/challenges/challengeStorage.test.ts"]),
    Mutant("web: unreadable stored data is silently destroyed", "web/src/features/challenges/challengeStorage.ts",
           "storage.setItem(CHALLENGE_UNREADABLE_KEY, raw)", "void raw", ["src/features/challenges/challengeStorage.test.ts"]),
    Mutant("web: the debug report is not marked stale", "web/src/features/debug/DebugPanel.tsx",
           "const stale = !!report && !!input && entry.circuit !== input.circuit", "const stale = false", ["src/features/debug/DebugPanel.test.tsx"]),
    Mutant("web: the debugger reports AI when none was used", "web/src/features/debug/DebugPanel.tsx",
           "{report.usedFallbackTemplate\n              ?", "{!report.usedFallbackTemplate\n              ?", ["src/features/debug/DebugPanel.test.tsx"]),
    Mutant("web: pinned run can be compared with itself", "web/src/features/compare/ComparePanel.tsx",
           "const isPinnedRun = !!pinned && !!result && pinned.result.provenance.resultId === result.provenance.resultId", "const isPinnedRun = false", ["src/features/compare/ComparePanel.test.tsx"]),
    Mutant("web: sampled and theoretical are not distinguished", "web/src/features/build/ResultsPanel.tsx",
           "{sampled ? `Sampled${shots !== undefined ? ` · ${shots} shots` : ''}` : 'Theoretical · ideal'}", "{'Theoretical · ideal'}", ["src/features/build/resultsProbabilities.test.tsx"]),
    # --- cp gate ---
    Mutant("web: the emitter prints cp with the target first", "web/src/circuit/qasmEmitter.ts",
           "return `cp(${formatAngle(op.params[0])}) q[${op.controls[0]}], q[${op.targets[0]}];`",
           "return `cp(${formatAngle(op.params[0])}) q[${op.targets[0]}], q[${op.controls[0]}];`", ["src/circuit/qasmEmitter.test.ts"]),
    Mutant("web: a placed cp forgets its angle", "web/src/circuit/gateSpec.ts",
           "params: gateTakesAngle(gate) && angle !== undefined ? [angle] : [],", "params: [],", ["src/features/build/gatePlacement.test.tsx"]),
    Mutant("web: the parser accepts a cp with an unreadable angle", "web/src/circuit/qasmParser.ts",
           "if (!Number.isFinite(angle)) {\n        throw new QasmParseError(`unparsable angle \"${phaseMatch[1]}\"`, lineNo, line)",
           "if (false) {\n        throw new QasmParseError(`unparsable angle \"${phaseMatch[1]}\"`, lineNo, line)", ["src/circuit/qasmEmitter.test.ts"]),
    Mutant("web: the arity check lets a cp have a control equal to its target", "web/src/circuit/types.ts",
           "if (controls[0] === targets[0]) return 'cp control and target must differ'", "", ["src/circuit/qasmEmitter.test.ts"]),
    # --- per-qubit spheres and the amplitude chart: the browser must only render what the server computed ---
    Mutant("web: the per-qubit length is worked out from x, y, z", "web/src/features/build/QubitSpheres.tsx",
           "<VerifiedValueInline quantum={blochLength} render={formatComponent} />",
           "<VerifiedValueInline quantum={toQuantumValue(Math.sqrt(x * x + y * y + z * z), bloch.provenance)} render={formatComponent} />",
           ["src/features/build/QubitSpheres.test.tsx", "src/features/build/reducedStateTrust.test.ts"]),
    Mutant("web: entanglement is decided from the length instead of the server's flag", "web/src/features/build/QubitSpheres.tsx",
           "{describeEntanglement(state.entangledWithRest)}", "{describeEntanglement(blochLength.value < 0.5)}",
           ["src/features/build/QubitSpheres.test.tsx", "src/features/build/reducedStateTrust.test.ts"]),
    Mutant("web: the reason an unusable qubit is unusable is hidden", "web/src/features/build/QubitSpheres.tsx",
           "{state.reason ?? 'The backend gave no reason.'}", "{'The backend gave no reason.'}", ["src/features/build/QubitSpheres.test.tsx"]),
    Mutant("web: a qubit state derived from another step is accepted", "web/src/provenance/schema.ts",
           "const mismatches = sourceMismatches(qubitState.derived_from)", "const mismatches: unknown[] = []", ["src/features/build/QubitSpheres.test.tsx"]),
    Mutant("web: per-qubit purity loses its own step's provenance", "web/src/api/realClient.ts",
           "toQuantumValue(q.purity, provenance)", "toQuantumValue(q.purity, provenanceFromTraceStep(response.steps[0]!.provenance))", ["src/features/build/QubitSpheres.test.tsx"]),
    Mutant("web: a phase arrow turns the wrong way", "web/src/features/build/AmplitudeChart.tsx",
           "{ '--phase': row.phase } as CSSProperties", "{ '--phase': -row.phase } as CSSProperties", ["src/features/build/AmplitudeChart.test.tsx", "src/features/build/reducedStateTrust.test.ts"]),
    Mutant("web: a bar is sized by the outcome weight instead of the amplitude", "web/src/features/build/AmplitudeChart.tsx",
           "{ '--amp': row.magnitude } as CSSProperties", "{ '--amp': row.probability } as CSSProperties", ["src/features/build/AmplitudeChart.test.tsx", "src/features/build/reducedStateTrust.test.ts"]),
    Mutant("web: an amplitude with no phase is drawn with an arrow anyway", "web/src/features/build/AmplitudeChart.tsx",
           "{row.phase === null ? (\n                        <span className=\"text-[10px] text-void-300\">none</span>", "{false ? (\n                        <span className=\"text-[10px] text-void-300\">none</span>", ["src/features/build/AmplitudeChart.test.tsx"]),
    Mutant("web: the outcome weight is computed as the square of the size", "web/src/features/build/AmplitudeChart.tsx",
           "toQuantumValue(row.probability, view.provenance)", "toQuantumValue(row.magnitude * row.magnitude, view.provenance)", ["src/features/build/AmplitudeChart.test.tsx", "src/features/build/reducedStateTrust.test.ts"]),
]


def run(cmd: list[str], cwd: Path) -> int:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True).returncode


def try_mutant(m: Mutant, kind: str) -> str:
    path = ROOT / m.file
    original = path.read_text(encoding="utf-8")
    if m.old not in original:
        return "STALE"  # the mutant no longer matches the source: the script needs updating
    try:
        path.write_text(original.replace(m.old, m.new, 1), encoding="utf-8")
        if kind == "backend":
            code = max(run([PY, "-m", "unittest", "discover", "-s", "backend/tests", "-t", "backend", "-p", t], ROOT) for t in m.tests)
        else:
            code = run(["bash", "-lc", f"source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && cd web && npx vitest run {' '.join(m.tests)}"], ROOT)
        return "killed" if code != 0 else "SURVIVED"
    finally:
        path.write_text(original, encoding="utf-8")


def main() -> int:
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    only = sys.argv[2].lower() if len(sys.argv) > 2 else ""  # optional: only mutants whose name contains this text
    groups = [("backend", BACKEND)] if which == "backend" else [("web", WEB)] if which == "web" else [("backend", BACKEND), ("web", WEB)]
    bad = 0
    for kind, mutants in groups:
        mutants = [m for m in mutants if only in m.name.lower()]
        killed = 0
        for m in mutants:
            outcome = try_mutant(m, kind)
            killed += outcome == "killed"
            bad += outcome != "killed"
            print(f"[{kind}] {outcome:9} {m.name}", flush=True)
        print(f"[{kind}] {killed}/{len(mutants)} killed", flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
