"""``R#`` facts and deterministic answers for the reasoning engine's analyses (``qentor.reasoning``).

The engine computes; the API layer stores each analysis as one provenance record; THIS module only reads that record's payload
back and turns it into citable facts and a short answer. It never runs anything, never receives a number from a client and never
writes to the log (like every module in this package, it takes an already-fetched ``ProvenanceRecord``). Every number in a fact
is the engine's, formatted to six decimals exactly as the other fact sheets do; a model, if one is configured, may only restate
facts (``answer_reasoning`` runs it through the same claim guard as every other answer).

Only the wrapper text around the facts is localised (English, Hindi, Kannada). A fact's description (gate names, outcomes, hashes,
numbers) is quoted verbatim and never translated.
"""

from __future__ import annotations

from qentor.provenance.models import ProvenanceRecord

from .comparison import comparison_facts_from_payload, pick
from .fallback_log import log_llm_fallback
from .guard import GuardRejection, validate_llm_draft
from .llm import LLMAdapter, LLMUnavailable
from .models import TutorFact

# A fact sheet lists at most this many rows of one table; it says when it stopped (nothing is silently dropped).
MAX_ROWS = 16
_DEFAULT_LANGUAGE = "en"


def _f(x: float | None) -> str:
    return "not reported" if x is None else f"{x:.6f}"


class _Facts:
    def __init__(self, record: ProvenanceRecord) -> None:
        self.record = record
        self.items: list[TutorFact] = []

    def add(self, kind, description: str) -> None:
        self.items.append(TutorFact(id=f"R{len(self.items) + 1}", kind=kind, description=description, result_id=self.record.result_id))


def _source_line(source: dict) -> str:
    return (
        f"{source['role']} run: result {source['result_id']} (execution {source['execution_id']}) on {source['backend']} "
        f"{source['backend_version']} ({source['provenance_class']}, {source['execution_mode']} mode), circuit hash "
        f"{source['circuit_hash']}, {source['verification_status']}"
    )


def build_reasoning_facts(record: ProvenanceRecord) -> list[TutorFact]:
    """``R#`` facts from an analysis record's payload, in reading order. Every fact carries the analysis record's id."""
    payload = record.payload
    intent = payload["intent"]
    data = payload["data"]
    facts = _Facts(record)

    facts.add(
        "reasoning_status",
        f"analysis {record.result_id} ({intent}) by {record.backend} {record.backend_version} ({record.provenance_class.value}, "
        f"{record.execution_mode} mode): {payload['status']}; every number in it was computed by the backend, none by a model or the browser",
    )
    for source in payload["sources"]:
        facts.add("reasoning_status", _source_line(source))
    if payload.get("reason"):
        facts.add("reasoning_status", f"{payload['reason']}")

    if intent == "PROBABILITY":
        _probability(facts, data)
    elif intent == "OPTIMIZE":
        _optimization(facts, data, payload)
    elif intent == "WHAT_IF":
        _what_if(facts, data)
    elif intent == "TRACE_CHANGE":
        _trace_change(facts, data, payload)
    elif intent == "COMPARE":
        compared = comparison_facts_from_payload(data, record.result_id, "R")
        for fact in compared:
            facts.add(fact.kind, fact.description)
    elif intent == "DEBUG":
        _debug(facts, data)
    return facts.items


# ----------------------------------------------------------------------------------------------- per intent


def _probability(facts: _Facts, data: dict) -> None:
    facts.add("reasoning_note", data["bit_order"])
    for item in data["items"]:
        facts.add("probability", f"{item['label']}: theoretical probability {_f(item['theoretical_probability'])}")
        if item["sampled_frequency"] is not None:
            facts.add(
                "reasoning_sampled",
                f"{item['label']}: sampled frequency {_f(item['sampled_frequency'])} ({item['sampled_count']} of {item['shots']} shots)",
            )
            facts.add(
                "reasoning_sampled",
                f"{item['label']}: the sampled frequency differs from the theoretical probability by {_f(item['difference'])}",
            )
    for note in data["notes"]:
        facts.add("reasoning_note", note)


def _optimization(facts: _Facts, data: dict, payload: dict) -> None:
    if payload["status"] != "OK":
        facts.add(
            "reasoning_optimization",
            f"no safe improvement: the circuit ({data['original_circuit_hash']}) has {data['original_op_count']} operations and no "
            "equivalence-verified shorter circuit exists for it",
        )
        eq = data.get("equivalence")
        if eq is not None:
            facts.add("reasoning_optimization", f"equivalence check ({eq['method']}): {eq['status']}")
        return
    facts.add(
        "reasoning_optimization",
        f"optimized circuit: {data['original_op_count']} operations before, {data['candidate_op_count']} after "
        f"({data['operations_removed']} removed); candidate circuit hash {data['candidate_circuit_hash']}",
    )
    for note in data["rewrites"]:
        text = f"rewrite applied: {note['rule']}"
        if note["explanation"]:
            text += f". {note['explanation']}"
        facts.add("reasoning_optimization", text)
    for change in data["changes"]:
        if change["kind"] != "kept":
            facts.add("reasoning_optimization", f"{change['kind']}: {change['description']}")
    eq = data["equivalence"]
    phase = "" if eq["global_phase"] is None else f" (global phase {eq['global_phase']:.6f} radians)"
    facts.add(
        "reasoning_optimization",
        f"equivalence check ({eq['method']}): the candidate is equivalent to the original up to a global phase{phase}; status {eq['status']}",
    )
    if data["candidate_result_id"]:
        facts.add("reasoning_optimization", f"the candidate was run once as supporting evidence: result {data['candidate_result_id']}")


def _what_if(facts: _Facts, data: dict) -> None:
    facts.add("reasoning_whatif", f"what-if change: {data['description']}")
    facts.add(
        "reasoning_whatif",
        f"original circuit {data['original_circuit_hash']} has {data['original_op_count']} operations; the counterfactual built by the "
        f"server from it and this one change, {data['counterfactual_circuit_hash']}, has {data['counterfactual_op_count']}",
    )
    comparison = data["comparison"]
    circuit, measurement, state = comparison["circuit"], comparison["measurement"], comparison["state"]
    status = circuit["equivalence_status"]
    if status == "EQUIVALENT":
        facts.add("reasoning_whatif", "operator equivalence check: the counterfactual is equivalent to the original up to a global phase, so the change has no effect on what the circuit does")
    elif status == "NOT_EQUIVALENT":
        facts.add("reasoning_whatif", "operator equivalence check: the counterfactual is not equivalent to the original, even up to a global phase")
    else:
        facts.add("reasoning_whatif", f"operator equivalence check: could not be decided ({circuit['equivalence_reason']})")
    if not measurement["comparable"]:
        facts.add("reasoning_whatif", f"the outcomes cannot be compared: {measurement['reason']}")
    else:
        rows = measurement["rows"]
        for row in rows[:MAX_ROWS]:
            # Both runs are statevector runs, whose theoretical probabilities list only outcomes above 1e-12: an outcome missing from one
            # run has probability zero there (not "unknown"), so it is written as zero and the difference is taken against it.
            a = row["a"] if row["a"] is not None else 0.0
            b = row["b"] if row["b"] is not None else 0.0
            facts.add(
                "reasoning_whatif",
                f"outcome {row['outcome']}: original theoretical probability {_f(a)}, counterfactual theoretical probability "
                f"{_f(b)}, difference {_f(abs(a - b))}",
            )
        if len(rows) > MAX_ROWS:
            facts.add("reasoning_whatif", f"{len(rows) - MAX_ROWS} further outcomes are not listed")
        facts.add(
            "reasoning_whatif",
            f"total variation distance between the two outcome distributions {_f(measurement['total_variation_distance'])}; "
            f"largest single-outcome difference {_f(measurement['max_difference'])}",
        )
    if not state["comparable"]:
        facts.add("reasoning_whatif", f"the states cannot be compared: {state['reason']}")
    else:
        facts.add(
            "reasoning_whatif",
            f"state fidelity between the original and the counterfactual {_f(state['fidelity'])}; largest probability difference "
            f"{_f(state['max_probability_difference'])}; largest amplitude difference {_f(state['max_amplitude_difference'])}",
        )


def _qubit_text(row: dict, when: str) -> str:
    if row["status"] != "OK":
        return f"qubit {row['qubit']} {when}: no reduced state ({row['reason']})"
    b = row["bloch"]
    rest = "entangled with the rest of the register" if row["entangled_with_rest"] else "in a pure state of its own"
    return (
        f"qubit {row['qubit']} {when}: Bloch vector x = {_f(b['x'])}, y = {_f(b['y'])}, z = {_f(b['z'])}; purity {_f(row['purity'])}; {rest}"
    )


def _trace_change(facts: _Facts, data: dict, payload: dict) -> None:
    n = data["num_qubits"]
    if data["operation"] is None:
        facts.add("reasoning_trace", f"trace step {data['step_number']} of {data['total_steps']}: the initial state, before any operation")
    else:
        facts.add(
            "reasoning_trace",
            f"trace step {data['step_number']} of {data['total_steps']}: applies {data['operation']['description']} (operation {data['operation']['index']} of your circuit)",
        )
    facts.add("reasoning_note", data["bit_order"])
    if data["operation"] is not None:
        facts.add("reasoning_trace", f"what this step changed: {data['change_summary']}")
        moved = data["probability_changes"]
        if not moved:
            facts.add("reasoning_trace", "no outcome probability changed at this step")
        for row in moved[:MAX_ROWS]:
            facts.add(
                "probability",
                f"outcome {row['outcome']}: theoretical probability {_f(row['before'])} before this step, {_f(row['after'])} after it (change {row['difference']:+.6f})",
            )
        if len(moved) > MAX_ROWS:
            facts.add("reasoning_trace", f"{len(moved) - MAX_ROWS} further outcome probabilities changed and are not listed")
        for before, after in zip(data["before_qubits"], data["after_qubits"]):
            facts.add("reasoning_trace", _qubit_text(before, "before this step"))
            facts.add("reasoning_trace", _qubit_text(after, "after this step"))
    else:
        for outcome, p in sorted(data["after_probabilities"].items()):
            facts.add("probability", f"outcome {outcome}: theoretical probability {_f(p)} in the initial state")
        for row in data["after_qubits"]:
            facts.add("reasoning_trace", _qubit_text(row, "in the initial state"))
    if n > 1:
        facts.add("reasoning_trace", "a qubit that is entangled with the rest has no state of its own: its Bloch vector is shorter than 1")


def _debug(facts: _Facts, data: dict) -> None:
    most = data["most_likely"]
    facts.add("reasoning_note", most["bit_order"])
    for item in most["items"]:
        facts.add("probability", f"{item['label']}: theoretical probability {_f(item['theoretical_probability'])}")
    for note in most["notes"]:
        facts.add("reasoning_note", note)
    opt = data["optimization"]
    if opt["status"] == "OK":
        facts.add(
            "reasoning_debug",
            f"a shorter circuit with the same effect exists: {opt['original_op_count']} operations reduced to {opt['candidate_op_count']} "
            "and confirmed equivalent by the backend's equivalence check, so some operations are redundant",
        )
    else:
        facts.add("reasoning_debug", f"no equivalence-verified shorter circuit exists: {opt['reason']}")
    structure = data["structure"]
    for q in structure["idle_qubits"]:
        facts.add("reasoning_debug", f"qubit {q} is not used by any operation in the circuit")
    if not structure["has_measurement"]:
        facts.add("reasoning_debug", "the circuit has no measurement, so it cannot be run in shots mode")


# ------------------------------------------------------------------------------------------------- answers

_LEAD = {
    "PROBABILITY": {
        "en": "From the backend's own run:",
        "hi": "बैकएंड के अपने रन से:",
        "kn": "ಬ್ಯಾಕೆಂಡ್‌ನ ಸ್ವಂತ ರನ್‌ನಿಂದ:",
    },
    "OPTIMIZE": {
        "en": "Optimization result (the equivalence was decided by the backend's checker, not by the tutor):",
        "hi": "ऑप्टिमाइज़ेशन का परिणाम (समतुल्यता बैकएंड की जाँच ने तय की, ट्यूटर ने नहीं):",
        "kn": "ಆಪ್ಟಿಮೈಸೇಶನ್ ಫಲಿತಾಂಶ (ಸಮಾನತೆಯನ್ನು ಬ್ಯಾಕೆಂಡ್ ಪರಿಶೀಲನೆ ನಿರ್ಧರಿಸಿದೆ, ಟ್ಯೂಟರ್ ಅಲ್ಲ):",
    },
    "WHAT_IF": {
        "en": "If that one change were made (two backend runs compared):",
        "hi": "यदि वह एक बदलाव किया जाए (बैकएंड के दो रन की तुलना):",
        "kn": "ಆ ಒಂದು ಬದಲಾವಣೆ ಮಾಡಿದರೆ (ಬ್ಯಾಕೆಂಡ್‌ನ ಎರಡು ರನ್‌ಗಳ ಹೋಲಿಕೆ):",
    },
    "TRACE_CHANGE": {
        "en": "What this step changed, from the backend's states before and after it:",
        "hi": "इस चरण ने क्या बदला, उसके पहले और बाद की बैकएंड अवस्थाओं से:",
        "kn": "ಈ ಹಂತ ಏನು ಬದಲಾಯಿಸಿತು, ಅದರ ಮೊದಲು ಮತ್ತು ನಂತರದ ಬ್ಯಾಕೆಂಡ್ ಸ್ಥಿತಿಗಳಿಂದ:",
    },
    "COMPARE": {
        "en": "Comparing the two runs:",
        "hi": "दोनों रन की तुलना:",
        "kn": "ಎರಡು ರನ್‌ಗಳ ಹೋಲಿಕೆ:",
    },
    "DEBUG": {
        "en": "Evidence about your circuit from the backend:",
        "hi": "आपके सर्किट के बारे में बैकएंड से साक्ष्य:",
        "kn": "ನಿಮ್ಮ ಸರ್ಕ್ಯೂಟ್ ಬಗ್ಗೆ ಬ್ಯಾಕೆಂಡ್‌ನಿಂದ ಸಾಕ್ಷ್ಯ:",
    },
}
_NOTHING = {
    "en": "The backend has nothing to report for this request.",
    "hi": "इस अनुरोध के लिए बैकएंड के पास रिपोर्ट करने को कुछ नहीं है।",
    "kn": "ಈ ವಿನಂತಿಗೆ ವರದಿ ಮಾಡಲು ಬ್ಯಾಕೆಂಡ್‌ನ ಬಳಿ ಏನೂ ಇಲ್ಲ.",
}


def answer_reasoning_deterministic(record: ProvenanceRecord, facts: list[TutorFact], language: str = _DEFAULT_LANGUAGE) -> str:
    intent = record.payload["intent"]
    reason = record.payload.get("reason")
    body = [f for f in facts if f.kind != "reasoning_status"]
    # an honest "nothing to report" keeps its reason fact (a status line) in the answer
    notes = [f for f in facts if f.kind == "reasoning_status" and reason and f.description == reason]
    chosen = [*notes, *body]
    if not chosen:
        return pick(_NOTHING, language)
    citations = "; ".join(f"{f.description} ({f.id})" for f in chosen)
    return f"{pick(_LEAD[intent], language)} {citations}."


def answer_reasoning(
    question: str,
    record: ProvenanceRecord,
    facts: list[TutorFact],
    llm: LLMAdapter | None,
    language: str = _DEFAULT_LANGUAGE,
) -> tuple[str, bool]:
    """``(answer, used_fallback_template)``. A configured model sees exactly these ``R#`` facts and its draft passes the claim guard
    (every number and verdict word must already be in a fact); anything else is the deterministic answer, which quotes the facts."""
    if llm is not None:
        try:
            draft = llm.generate(question, facts, language)
            return validate_llm_draft(draft, facts), False
        except (LLMUnavailable, GuardRejection) as exc:
            log_llm_fallback("answer_reasoning", exc)
    return answer_reasoning_deterministic(record, facts, language), True


def answer_reasoning_lead(intent: str, language: str = _DEFAULT_LANGUAGE) -> str:
    """The localised sentence that introduces an analysis (also used to introduce the debugger's report)."""
    return pick(_LEAD[intent], language)


# A typed WHAT_IF or COMPARE question names no structured input (which change? which two runs?), so the tutor cannot run the engine
# from the words alone; it points at the controls that collect that input. Nothing is computed and no number is stated.
GUIDANCE = {
    "WHAT_IF": {
        "en": (
            "A what-if question needs one explicit change. Use the “What if…” controls in the Tutor: remove a gate, replace a gate, "
            "change an angle or add a gate. The server builds the new circuit and shows it to you before anything runs, then runs both "
            "circuits and compares them."
        ),
        "hi": (
            "‘क्या होगा अगर…’ वाले प्रश्न के लिए एक स्पष्ट बदलाव चाहिए। Tutor के “What if…” नियंत्रणों का उपयोग करें: गेट हटाएँ, गेट बदलें, "
            "कोण बदलें या गेट जोड़ें। सर्वर नया सर्किट बनाकर कुछ भी चलाने से पहले आपको दिखाता है, फिर दोनों सर्किट चलाकर उनकी तुलना करता है।"
        ),
        "kn": (
            "‘ಹಾಗಾದರೆ ಏನು’ ಪ್ರಶ್ನೆಗೆ ಒಂದು ಸ್ಪಷ್ಟ ಬದಲಾವಣೆ ಬೇಕು. Tutor ನ “What if…” ನಿಯಂತ್ರಣಗಳನ್ನು ಬಳಸಿ: ಗೇಟ್ ತೆಗೆಯಿರಿ, ಗೇಟ್ ಬದಲಿಸಿ, "
            "ಕೋನ ಬದಲಿಸಿ ಅಥವಾ ಗೇಟ್ ಸೇರಿಸಿ. ಸರ್ವರ್ ಯಾವುದನ್ನೂ ಚಲಾಯಿಸುವ ಮೊದಲು ಹೊಸ ಸರ್ಕ್ಯೂಟ್ ಅನ್ನು ನಿಮಗೆ ತೋರಿಸುತ್ತದೆ, ನಂತರ ಎರಡೂ ಸರ್ಕ್ಯೂಟ್‌ಗಳನ್ನು ಚಲಾಯಿಸಿ ಹೋಲಿಸುತ್ತದೆ."
        ),
    },
    "COMPARE": {
        "en": (
            "To compare two runs, open “Compare experiments” in the Lab results, choose the two runs and compare them: the server "
            "computes the difference. You can then ask me about it."
        ),
        "hi": (
            "दो रन की तुलना के लिए Lab परिणामों में “Compare experiments” खोलें, दो रन चुनें और तुलना करें: अंतर सर्वर गणना करता है। "
            "उसके बाद आप मुझसे उसके बारे में पूछ सकते हैं।"
        ),
        "kn": (
            "ಎರಡು ರನ್‌ಗಳನ್ನು ಹೋಲಿಸಲು Lab ಫಲಿತಾಂಶಗಳಲ್ಲಿ “Compare experiments” ತೆರೆಯಿರಿ, ಎರಡು ರನ್‌ಗಳನ್ನು ಆರಿಸಿ ಹೋಲಿಸಿ: ವ್ಯತ್ಯಾಸವನ್ನು ಸರ್ವರ್ ಲೆಕ್ಕಿಸುತ್ತದೆ. "
            "ನಂತರ ಅದರ ಬಗ್ಗೆ ನನ್ನನ್ನು ಕೇಳಬಹುದು."
        ),
    },
}

REFUSAL = {
    "en": "I could not analyse that: {message}",
    "hi": "मैं इसका विश्लेषण नहीं कर सका: {message}",
    "kn": "ಇದನ್ನು ವಿಶ್ಲೇಷಿಸಲು ನನಗೆ ಸಾಧ್ಯವಾಗಲಿಲ್ಲ: {message}",
}
