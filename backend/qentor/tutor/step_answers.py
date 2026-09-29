"""Deterministic (no-LLM) answers about a selected trace step.

Three intents, one small router (not a keyword matrix):

    change  "what changed in this step?" / "why did the state change here?"
    gate    "what did this gate do?"
    bloch   "why did the Bloch vector move?"

An answer is assembled ONLY by quoting the step's verified ``S#`` facts
(``qentor.tutor.trace_context``) — the operation, the backend's state before
and after, and (one qubit) its Bloch vector before and after — inside localised
wrapper labels. It states no number of its own, computes no difference and does
not infer a result from a gate's name; the one line of general knowledge it adds
is the gate's own textbook note (also a fact, also number-free). If the step's
record is unusable the answer says so instead of explaining anything.

Anything the router does not recognise is not answered here: the caller falls
back to the tutor's existing behaviour.
"""

from __future__ import annotations

import re
from typing import Literal

from .deterministic import _DEFAULT_LANGUAGE
from .models import TutorFact
from .trace_context import TraceStepContext

StepIntent = Literal["change", "gate", "bloch"]

_BLOCH = re.compile(r"\b(bloch|vector|sphere)\b")
# ("each gate" is deliberately absent: "what does each gate in this circuit do?" is about
# the whole circuit, not the selected step.)
_GATE = re.compile(r"\b(this|the|that) (gate|operation)\b|\bwhat did (it|this|that) do\b|\bwhat does (it|this|that) do\b")
_CHANGE = re.compile(
    r"\b(chang\w*|differ\w*|move\w*|moving|happen\w*|previous|before|earlier)\b|\bthis step\b|\bhere\b"
)


def step_intent(question: str) -> StepIntent | None:
    """Which step question this is, or ``None`` if it is not one. Bloch first
    (the most specific), then a gate question, then a change question."""
    q = question.lower()
    if _BLOCH.search(q):
        return "bloch"
    if _GATE.search(q):
        return "gate"
    if _CHANGE.search(q):
        return "change"
    return None


_LABELS = {
    "en": {
        "initial": "This is the initial state, before any operation is applied.",
        "before": "Before this step:",
        "after": "After this step:",
        "gate": "What this gate does in general:",
        "bloch_before": "Bloch vector before this step:",
        "bloch_after": "Bloch vector after this step:",
        "no_before": "The previous step's state was not available, so there is nothing to compare with.",
        "insufficient": "I don't have enough verified backend facts for this step to explain it.",
        "not_step": 'I can explain the selected trace step. Try asking "What changed in this step?" or "What did this gate do?".',
    },
    "hi": {
        "initial": "यह प्रारंभिक अवस्था है, किसी भी संक्रिया के लागू होने से पहले।",
        "before": "इस चरण से पहले:",
        "after": "इस चरण के बाद:",
        "gate": "यह गेट सामान्य रूप से क्या करता है:",
        "bloch_before": "इस चरण से पहले ब्लॉख सदिश:",
        "bloch_after": "इस चरण के बाद ब्लॉख सदिश:",
        "no_before": "पिछले चरण की अवस्था उपलब्ध नहीं थी, इसलिए तुलना करने के लिए कुछ नहीं है।",
        "insufficient": "इस चरण को समझाने के लिए मेरे पास पर्याप्त सत्यापित बैकएंड तथ्य नहीं हैं।",
        "not_step": 'मैं चुने गए ट्रेस चरण को समझा सकता हूँ। पूछें "इस चरण में क्या बदला?" या "इस गेट ने क्या किया?"।',
    },
    "kn": {
        "initial": "ಇದು ಆರಂಭಿಕ ಸ್ಥಿತಿ, ಯಾವುದೇ ಕ್ರಿಯೆ ಅನ್ವಯಿಸುವ ಮೊದಲು.",
        "before": "ಈ ಹಂತದ ಮೊದಲು:",
        "after": "ಈ ಹಂತದ ನಂತರ:",
        "gate": "ಈ ಗೇಟ್ ಸಾಮಾನ್ಯವಾಗಿ ಏನು ಮಾಡುತ್ತದೆ:",
        "bloch_before": "ಈ ಹಂತದ ಮೊದಲು ಬ್ಲೋಚ್ ವೆಕ್ಟರ್:",
        "bloch_after": "ಈ ಹಂತದ ನಂತರ ಬ್ಲೋಚ್ ವೆಕ್ಟರ್:",
        "no_before": "ಹಿಂದಿನ ಹಂತದ ಸ್ಥಿತಿ ಲಭ್ಯವಿರಲಿಲ್ಲ, ಆದ್ದರಿಂದ ಹೋಲಿಸಲು ಏನೂ ಇಲ್ಲ.",
        "insufficient": "ಈ ಹಂತವನ್ನು ವಿವರಿಸಲು ನನ್ನ ಬಳಿ ಸಾಕಷ್ಟು ಪರಿಶೀಲಿತ ಬ್ಯಾಕೆಂಡ್ ಸಂಗತಿಗಳಿಲ್ಲ.",
        "not_step": 'ನಾನು ಆಯ್ದ ಟ್ರೇಸ್ ಹಂತವನ್ನು ವಿವರಿಸಬಲ್ಲೆ. "ಈ ಹಂತದಲ್ಲಿ ಏನು ಬದಲಾಯಿತು?" ಅಥವಾ "ಈ ಗೇಟ್ ಏನು ಮಾಡಿತು?" ಎಂದು ಕೇಳಿ.',
    },
}

_WHEN_PREFIX = re.compile(r"^(before|after) this step[,:] ")


def _labels(language: str) -> dict[str, str]:
    return _LABELS.get(language, _LABELS[_DEFAULT_LANGUAGE])


def step_not_recognised_answer(language: str = _DEFAULT_LANGUAGE) -> str:
    """For a request that carries a trace step and nothing else to answer from,
    when the question is not a step question."""
    return _labels(language)["not_step"]


def _cite(facts: list[TutorFact]) -> str:
    # The fact says "after this step, ..." itself (so an LLM can tell before from
    # after); the wrapper label already says it, so it is not repeated here.
    return "; ".join(f"{_WHEN_PREFIX.sub('', f.description)} ({f.id})" for f in facts)


def answer_step_question(intent: StepIntent, step: TraceStepContext, language: str = _DEFAULT_LANGUAGE) -> str:
    L = _labels(language)
    if not step.usable:
        return f"{L['insufficient']} {_cite(step.group('status') + step.group('notes'))}."

    head = _cite(step.group("step"))
    after, before = step.group("after"), step.group("before")
    # A group holds either the Bloch vector or the note saying why there is none.
    bloch_after, bloch_before = step.group("bloch_after"), step.group("bloch_before")
    has_bloch = bool(bloch_after) and all(f.kind == "trace_bloch" for f in bloch_after + bloch_before)

    parts: list[str] = []
    if step.step_index == 0:
        parts.append(f"{L['initial']} {head}.")
        parts.append(f"{L['after']} {_cite(after)}.")
        if intent in ("bloch", "change") and has_bloch:
            parts.append(f"{L['bloch_after']} {_cite(bloch_after)}.")
        return "\n\n".join(parts)

    parts.append(f"{head}.")
    if intent == "gate" and step.group("gate"):
        parts.append(f"{L['gate']} {_cite(step.group('gate'))}.")

    if intent == "bloch":
        if has_bloch and bloch_before:
            parts.append(f"{L['bloch_before']} {_cite(bloch_before)}.")
            parts.append(f"{L['bloch_after']} {_cite(bloch_after)}.")
        else:
            # no Bloch vector (several qubits): say why, and still show the state
            parts.append(_cite(bloch_after[:1]) + ".")
            parts.append(f"{L['after']} {_cite(after)}.")
        return "\n\n".join(parts)

    if before:
        parts.append(f"{L['before']} {_cite(before)}.")
    else:
        parts.append(L["no_before"])
    parts.append(f"{L['after']} {_cite(after)}.")
    if intent == "change":
        if has_bloch and bloch_before:
            parts.append(f"{L['bloch_before']} {_cite(bloch_before)}.")
            parts.append(f"{L['bloch_after']} {_cite(bloch_after)}.")
    return "\n\n".join(parts)
