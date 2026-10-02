"""Deterministic routing of a typed question to a reasoning-engine intent, in English, Hindi and Kannada.

This is NOT multilingual understanding. It is a small, fixed table of phrases per intent and per language, matched against the
question as typed (whatever the answer language is set to). A question that matches no phrase gets ``None`` and the tutor behaves
exactly as it did before this module existed. Nothing here calls a model, reads a result or computes a number: it only decides WHICH
analysis to ask the server's engine for, and (for a probability question) extracts the outcome the learner named, as typed.

Precedence, when a question matches several intents: WHAT_IF, DEBUG, a sampled-versus-theoretical PROBABILITY question, OPTIMIZE,
COMPARE, TRACE_CHANGE, then every other PROBABILITY question. An English "what changed" question is deliberately NOT a TRACE_CHANGE
phrase: the step tutor already answers it (``qentor.tutor.step_answers``) and keeps doing so.

Adding a phrase is a one-line change to a table below; every phrase is covered by a test in ``tests/test_reasoning_intents.py``.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from qentor.reasoning import (
    BasisStateTarget,
    EachQubitValueTarget,
    Intent,
    MostLikelyTarget,
    ProbabilityTarget,
    QubitValueTarget,
    SampledVsTheoreticalTarget,
)

# Zero-width joiners appear inside Kannada and Hindi conjuncts and are typed inconsistently: they are removed from both the phrases
# and the question before matching.
_INVISIBLE = dict.fromkeys(map(ord, "​‌‍⁠﻿"))


def normalise(text: str) -> str:
    text = unicodedata.normalize("NFC", text).translate(_INVISIBLE).casefold()
    return re.sub(r"\s+", " ", text).strip()


# English: regular expressions on word boundaries. Hindi and Kannada: plain phrases (their scripts have no \b), already normalised.
_EN = {
    Intent.WHAT_IF: [
        r"\bwhat if\b",
        r"\bwhat would happen if\b",
        r"\bwhat happens if\b",
        r"\bsuppose i\b",
        r"\bif i (?:remove|delete|replace|change|add|insert|swap)\b",
    ],
    Intent.DEBUG: [
        r"\bdebug\w*",
        r"\bwhat(?:'s| is) wrong\b",
        r"\bnot working\b",
        r"\bwhy (?:isn't|isn’t|is not|doesn't|doesn’t|does not) (?:it|my circuit|this)(?: work)?\b",
        r"\bfix my circuit\b",
    ],
    Intent.OPTIMIZE: [
        r"\boptimi[sz]\w*",
        r"\bsimplif\w*",
        r"\bshorten\w*",
        r"\bfewer gates\b",
        r"\breduce (?:the )?(?:number of )?gates\b",
        r"\bredundan\w*",
        r"\bminimi[sz]e\b",
    ],
    Intent.COMPARE: [r"\bcompar\w+", r"\bdifference between\b", r"\bhow do (?:the two|they|these) differ\b"],
    Intent.TRACE_CHANGE: [
        r"\bwhy did (?:it|this|that|the state|the step|the bloch vector|the probabilit\w+) (?:change|move)\w*",
        r"\bwhy (?:has )?(?:it |the state )?changed\b",
        r"\bwhy (?:the )?(?:state|bloch vector|probabilit\w+) (?:change|move)\w*",
        r"\bexplain (?:the |this |that )?(?:change|changes|difference)\b",
    ],
    Intent.PROBABILITY: [r"\bprobabilit(?:y|ies)\b", r"\bchance\b", r"\blikel(?:y|ihood)\b", r"\bhow often\b"],
}
_HI = {
    Intent.WHAT_IF: ["क्या होगा", "अगर मैं", "यदि मैं", "मान लो", "मान लीजिए"],
    Intent.DEBUG: ["डिबग", "डीबग", "क्या गलत", "क्या ग़लत", "काम नहीं कर रहा", "गलती", "ग़लती", "त्रुटि"],
    Intent.OPTIMIZE: ["ऑप्टिमाइज़", "ऑप्टिमाइज", "ऑप्टिमाईज", "अनुकूलित", "अनुकूलन", "कम गेट", "गेट कम", "सरल बना", "छोटा कर"],
    Intent.COMPARE: ["तुलना", "फ़र्क", "फर्क", "दोनों के बीच अंतर", "दोनों में अंतर"],
    Intent.TRACE_CHANGE: ["क्यों बदला", "क्यों बदल", "क्या बदला", "बदलाव समझ", "परिवर्तन समझ", "क्या परिवर्तन"],
    Intent.PROBABILITY: ["संभावना", "सम्भावना", "प्रायिकता", "प्रोबेबिलिटी", "कितनी बार", "सबसे संभावित"],
}
_KN = {
    Intent.WHAT_IF: ["ಏನಾಗುತ್ತದೆ", "ಏನಾಗುವುದು", "ಒಂದು ವೇಳೆ", "ಹಾಗಾದರೆ ಏನು"],
    Intent.DEBUG: ["ಡೀಬಗ್", "ಡಿಬಗ್", "ಏನು ತಪ್ಪು", "ತಪ್ಪಿದೆ", "ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ", "ದೋಷ"],
    Intent.OPTIMIZE: ["ಆಪ್ಟಿಮೈಸ್", "ಆಪ್ಟಿಮೈಜ್", "ಆಪ್ಟಿಮೈಸೇಶನ್", "ಆಪ್ಟಿಮೈಜೇಶನ್", "ಕಡಿಮೆ ಗೇಟ್", "ಗೇಟ್‌ಗಳನ್ನು ಕಡಿಮೆ", "ಗೇಟ್ ಕಡಿಮೆ", "ಸರಳಗೊಳಿಸ"],
    Intent.COMPARE: ["ಹೋಲಿಕೆ", "ಹೋಲಿಸಿ", "ವ್ಯತ್ಯಾಸ"],
    Intent.TRACE_CHANGE: ["ಏಕೆ ಬದಲಾಯಿತು", "ಯಾಕೆ ಬದಲಾಯಿತು", "ಏನು ಬದಲಾಯಿತು", "ಬದಲಾವಣೆಯನ್ನು ವಿವರಿಸಿ", "ಬದಲಾವಣೆ ವಿವರಿಸಿ", "ಬದಲಾವಣೆ ಏನು"],
    Intent.PROBABILITY: ["ಸಾಧ್ಯತೆ", "ಸಂಭವನೀಯತೆ", "ಸಂಭಾವ್ಯತೆ", "ಪ್ರಾಬಬಿಲಿಟಿ", "ಅತ್ಯಂತ ಸಾಧ್ಯ"],
}

_EN_RE = {intent: [re.compile(p) for p in patterns] for intent, patterns in _EN.items()}
_HI_N = {intent: [normalise(p) for p in phrases] for intent, phrases in _HI.items()}
_KN_N = {intent: [normalise(p) for p in phrases] for intent, phrases in _KN.items()}

# What a probability question may name.
_MOST_LIKELY_EN = re.compile(r"\bmost (?:likely|probable)\b|\bhighest probability\b|\bmost often\b")
_MOST_LIKELY_N = [normalise(p) for p in ("सबसे संभावित", "सबसे अधिक संभावना", "सबसे ज्यादा संभावना", "सबसे ज़्यादा संभावना", "ಅತ್ಯಂತ ಸಾಧ್ಯತೆ", "ಅತಿ ಹೆಚ್ಚು ಸಾಧ್ಯತೆ", "ಹೆಚ್ಚು ಸಾಧ್ಯತೆ", "ಹೆಚ್ಚಾಗಿ ಬರುವ")]
_SAMPLED_EN = re.compile(r"\b(?:sampled|empirical|observed|measured frequenc\w*|shots?)\b")
_THEORETICAL_EN = re.compile(r"\b(?:theoretical|theory|ideal|exact|expected)\b")
_SAMPLED_N = [normalise(p) for p in ("नमूना", "शॉट", "आवृत्ति", "मापी गई", "ಮಾದರಿ", "ಶಾಟ್", "ಆವರ್ತನ", "ಅಳೆದ")]
_THEORETICAL_N = [normalise(p) for p in ("सैद्धांतिक", "आदर्श", "ಸೈದ್ಧಾಂತಿಕ", "ಆದರ್ಶ")]
_QUBIT = re.compile(r"(?:\bqubit|\bq|क्यूबिट|क्विबिट|ಕ್ಯೂಬಿಟ್)\s*\[?\s*(\d{1,2})\s*\]?")
_BITS = re.compile(r"(?<![\w.\[])([01]{1,16})(?![\w.\]])")


@dataclass(frozen=True)
class RoutedQuestion:
    intent: Intent
    # Only a PROBABILITY question carries a target (what the learner named, as typed); every other intent is just the intent.
    target: ProbabilityTarget | None = None


def _matches(intent: Intent, q: str) -> bool:
    return any(p.search(q) for p in _EN_RE.get(intent, ())) or any(p in q for p in _HI_N.get(intent, ())) or any(p in q for p in _KN_N.get(intent, ()))


def _has(words: list[str], q: str) -> bool:
    return any(w in q for w in words)


def probability_target(q: str, num_qubits: int | None) -> ProbabilityTarget | None:
    """The outcome a normalised probability question names, or ``None`` when it names none (then the tutor's existing result summary
    answers it). ``num_qubits`` is read from the circuit the request carries, only to tell "the probability of 1" on one qubit (a
    basis state) from the same words on a register (each qubit's own probability)."""
    sampled = bool(_SAMPLED_EN.search(q)) or _has(_SAMPLED_N, q)
    theoretical = bool(_THEORETICAL_EN.search(q)) or _has(_THEORETICAL_N, q)

    qubit_match = _QUBIT.search(q)
    rest = q[: qubit_match.start()] + " " + q[qubit_match.end() :] if qubit_match else q
    bits = _BITS.findall(rest)

    if sampled and theoretical:
        # one named outcome, as long as it is a whole outcome of this circuit
        named = next((b for b in bits if num_qubits is None or len(b) == num_qubits), None)
        return SampledVsTheoreticalTarget(bits=named)
    if _MOST_LIKELY_EN.search(q) or _has(_MOST_LIKELY_N, q):
        return MostLikelyTarget()
    if qubit_match and bits and len(bits[0]) == 1:
        return QubitValueTarget(qubit=int(qubit_match.group(1)), value=int(bits[0]))  # type: ignore[arg-type]
    if bits:
        first = bits[0]
        if len(first) == 1 and num_qubits is not None and num_qubits > 1:
            return EachQubitValueTarget(value=int(first))  # type: ignore[arg-type]
        return BasisStateTarget(bits=first)
    return None


def route_question(question: str, num_qubits: int | None = None) -> RoutedQuestion | None:
    """Which reasoning intent a typed question is, or ``None`` (the tutor then answers exactly as before)."""
    q = normalise(question)
    if not q:
        return None
    for intent in (Intent.WHAT_IF, Intent.DEBUG):
        if _matches(intent, q):
            return RoutedQuestion(intent)
    if _matches(Intent.PROBABILITY, q) or _MOST_LIKELY_EN.search(q) or _has(_MOST_LIKELY_N, q):
        target = probability_target(q, num_qubits)
        if isinstance(target, SampledVsTheoreticalTarget):
            return RoutedQuestion(Intent.PROBABILITY, target)
    else:
        target = None
    for intent in (Intent.OPTIMIZE, Intent.COMPARE, Intent.TRACE_CHANGE):
        if _matches(intent, q):
            return RoutedQuestion(intent)
    if target is not None:
        return RoutedQuestion(Intent.PROBABILITY, target)
    return None
