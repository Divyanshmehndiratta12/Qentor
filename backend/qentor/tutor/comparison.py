"""Tutor support for "Ask Tutor about this difference" (Phase D).

The comparison itself is computed by ``qentor.verification.experiment_compare`` and stored by the API layer as its own provenance
record. This module turns that record's payload into citable ``X#`` facts and answers questions from them: deterministically, or
through the LLM with the tutor's claim guard in front of it, exactly like every other tutor answer. The tutor is handed the
comparison record (already fetched), never numbers from the client, and never writes anything.
"""

from __future__ import annotations

from qentor.provenance.models import ProvenanceRecord

from .guard import GuardRejection, validate_llm_draft
from .llm import LLMAdapter, LLMUnavailable
from .models import TutorFact

DEFAULT_LANGUAGE = "en"


def pick(templates: dict[str, str], language: str) -> str:
    """The wrapper text for ``language``; an unrecognised code falls back to English (the schema rejects unsupported codes)."""
    return templates.get(language, templates[DEFAULT_LANGUAGE])


_NO_FACTS = {
    "en": "This comparison recorded nothing to report.",
    "hi": "इस तुलना ने रिपोर्ट करने के लिए कुछ भी दर्ज नहीं किया।",
    "kn": "ಈ ಹೋಲಿಕೆ ವರದಿ ಮಾಡಲು ಯಾವುದನ್ನೂ ದಾಖಲಿಸಿಲ್ಲ.",
}
_SUMMARY = {
    "en": "For this comparison: {citations}.",
    "hi": "इस तुलना के लिए: {citations}।",
    "kn": "ಈ ಹೋಲಿಕೆಗಾಗಿ: {citations}.",
}

_KIND_WORDS = {
    "sampled_frequency": "sampled frequency",
    "theoretical_probability": "theoretical probability",
}


def _run_line(label: str, run: dict) -> str:
    return (
        f"run {label}: result {run['result_id']} on {run['backend']} {run['backend_version']} "
        f"({run['provenance_class']}, {run['execution_mode']} mode), circuit hash {run['circuit_hash']}, "
        f"{run['verification_status']}"
    )


def build_comparison_facts(record: ProvenanceRecord) -> list[TutorFact]:
    """``X#`` facts read from a comparison record's payload. Every fact carries the comparison record's id."""
    return comparison_facts_from_payload(record.payload, record.result_id, "X")


def comparison_facts_from_payload(p: dict, result_id: str, prefix: str) -> list[TutorFact]:
    """The comparison facts of a comparison payload (``a``, ``b``, ``circuit``, ``measurement``, ``state``), ids ``{prefix}1``…; each
    carries ``result_id`` (the record the payload was read from). Shared by the comparison tutor and the reasoning engine's COMPARE."""
    facts: list[TutorFact] = []

    def add(kind, description: str) -> None:
        facts.append(TutorFact(id=f"{prefix}{len(facts) + 1}", kind=kind, description=description, result_id=result_id))

    add("comparison_identity", _run_line("A", p["a"]))
    add("comparison_identity", _run_line("B", p["b"]))
    if p["a"]["backend"] != p["b"]["backend"]:
        add("comparison_identity", f"the two runs used different backends: {p['a']['backend']} and {p['b']['backend']}")

    circuit = p["circuit"]
    if circuit["same_circuit"]:
        add("comparison_circuit", "the two circuits are identical")
    else:
        add(
            "comparison_circuit",
            f"the circuits differ: run A has {circuit['num_ops_a']} operations on {circuit['num_qubits_a']} qubits, "
            f"run B has {circuit['num_ops_b']} operations on {circuit['num_qubits_b']} qubits",
        )
        for change in circuit["changes"]:
            a_ops, b_ops = ", ".join(change["a_ops"]), ", ".join(change["b_ops"])
            if change["tag"] == "replace":
                add("comparison_circuit", f"run A applies {a_ops} where run B applies {b_ops}")
            elif change["tag"] == "delete":
                add("comparison_circuit", f"run A applies {a_ops}, which run B does not")
            elif change["tag"] == "insert":
                add("comparison_circuit", f"run B applies {b_ops}, which run A does not")
    status = circuit["equivalence_status"]
    if status == "EQUIVALENT":
        add("comparison_circuit", "operator equivalence check: the two circuits are equivalent up to a global phase")
    elif status == "NOT_EQUIVALENT":
        add("comparison_circuit", "operator equivalence check: the two circuits are not equivalent, even up to a global phase")
    else:
        add("comparison_circuit", f"operator equivalence check: could not be decided ({circuit['equivalence_reason']})")

    m = p["measurement"]
    if not m["comparable"]:
        add("comparison_measurement", f"the outcomes cannot be compared: {m['reason']}")
    else:
        for row in m["rows"]:
            a = "not reported" if row["a"] is None else f"{row['a']:.6f}"
            b = "not reported" if row["b"] is None else f"{row['b']:.6f}"
            text = (
                f"outcome {row['outcome']}: run A {_KIND_WORDS[m['kind_a']]} {a}, run B {_KIND_WORDS[m['kind_b']]} {b}"
            )
            if row["difference"] is not None:
                text += f", difference {row['difference']:.6f}"
            add("comparison_measurement", text)
        add(
            "comparison_measurement",
            f"total variation distance between the two outcome distributions {m['total_variation_distance']:.6f}; "
            f"largest single-outcome difference {m['max_difference']:.6f}",
        )
        if m["note"]:
            add("comparison_measurement", m["note"])

    s = p["state"]
    if not s["comparable"]:
        add("comparison_state", f"the states cannot be compared: {s['reason']}")
    else:
        add(
            "comparison_state",
            f"state fidelity between the two runs {s['fidelity']:.6f}; largest probability difference "
            f"{s['max_probability_difference']:.6f}; largest amplitude difference {s['max_amplitude_difference']:.6f}",
        )
        if s["note"]:
            add("comparison_state", s["note"])
    return facts


_INTENTS = (
    ("comparison_identity", ("backend", "simulator", "aer", "cirq", "pennylane", "which run", "provenance", "who", "identity", "hash")),
    ("comparison_circuit", ("circuit", "gate", "operation", "add", "remov", "chang", "equivalent", "same circuit", "differ in")),
    ("comparison_state", ("state", "fidelity", "amplitude", "phase", "overlap")),
    ("comparison_measurement", ("outcome", "measure", "probab", "frequen", "shot", "result", "distribution", "count")),
)


def answer_comparison_question(question: str, facts: list[TutorFact], language: str = DEFAULT_LANGUAGE) -> str:
    """A deterministic answer: the facts that match what was asked, quoted; the headline facts for a general question."""
    q = question.lower()
    wanted = [kind for kind, words in _INTENTS if any(w in q for w in words)]
    chosen = [f for f in facts if f.kind in wanted] if wanted else []
    if not chosen:  # "what is different?", "why?", anything else: the headline of every part
        headline = ("comparison_circuit", "comparison_measurement", "comparison_state")
        chosen = [f for f in facts if f.kind in headline and (f.id == _first_of_kind(facts, f.kind) or _is_headline(f))]
    if not chosen:
        return pick(_NO_FACTS, language)
    citations = "; ".join(f"{f.description} ({f.id})" for f in chosen)
    return pick(_SUMMARY, language).format(citations=citations)


def _first_of_kind(facts: list[TutorFact], kind: str) -> str | None:
    return next((f.id for f in facts if f.kind == kind), None)


def _is_headline(fact: TutorFact) -> bool:
    d = fact.description
    return d.startswith(("operator equivalence", "total variation", "state fidelity", "the circuits", "the outcomes", "the states"))


def answer_comparison(
    question: str,
    facts: list[TutorFact],
    llm: LLMAdapter | None,
    language: str = DEFAULT_LANGUAGE,
) -> tuple[str, bool]:
    """``(answer, used_fallback_template)``. The LLM (if any) sees the same ``X#`` facts and its draft passes the claim guard;
    anything else is the deterministic answer."""
    if llm is not None:
        try:
            draft = llm.generate(question, facts, language)
            return validate_llm_draft(draft, facts), False
        except (LLMUnavailable, GuardRejection):
            pass
    return answer_comparison_question(question, facts, language), True
