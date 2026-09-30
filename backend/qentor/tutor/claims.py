"""Structured claim extraction and validation for LLM tutor drafts.

The guard's job (docs/AI_BOUNDARY.md §4 step 3) is to stop a language model
from introducing a quantum-derived claim the backend never produced. Matching
decimals as text is not enough: the same claim can be written as an integer
count ("512 out of 1024"), a fraction ("1/2"), a square-root expression
("1/√2"), a ratio ("3:1"), a percentage, scientific notation, a signed number,
a ket ("|11⟩"), or as a verdict ("this circuit is verified correct").

So this module does not look for a blacklist of phrases. It

1. PARSES the draft into typed claims: numeric expressions with a value (and
   the precision they were written at), bitstrings and kets, and — for the two
   claim kinds that carry no number — qualitative probability statements and
   verdicts;
2. PARSES THE AUTHORITATIVE FACTS with the very same parser, into the values,
   integers, bitstrings and version strings the backend actually supplied;
3. checks each claim against what the facts support, by VALUE, not by spelling:
   "1/2" is supported by a fact that says 0.500000, "-0.707107" is not
   supported by a fact that says 0.707107 (a sign flip is a different claim).

Anything the facts do not support is a violation. The module computes no
quantum quantity: it only re-reads numbers that are already written in the facts,
and compares them with numbers written in the draft.

Deliberate limits, stated so nobody assumes more than is true:

- Number WORDS are only examined when they are 3 or more, or a fraction word
  ("half", "a third"), and only in a sentence about outcomes or quantities;
  "one" and "two" are ordinary prose.
- Qualitative probability words ("always", "equally likely") are checked
  coarsely: they need the facts to contain a certain (0 or 1) or a repeated
  probability respectively. They are not proofs that the sentence is right.
- Verdict words ("verified", "equivalent", "passes", …) can be licensed only by
  a backend result fact that itself contains the word. The execution-status
  fact deliberately does not (an execution that succeeded proves nothing about
  the circuit), so an LLM cannot say a circuit is verified correct.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Iterable

from .models import TutorFact

# --------------------------------------------------------------------------- #
# Tokenising numeric expressions                                              #
# --------------------------------------------------------------------------- #

_SIGN = r"[-+−]?"
# A sign only counts when it is not glued to the previous word or number
# ("2-qubit" has no minus sign; "amplitude: -0.5" does).
_NO_GLUE = r"(?<![\w.)\]])"
_SQRT = r"(?:√\s*\d+|sqrt\s*\(\s*\d+\s*\))"

_TOKEN = re.compile(
    "|".join(
        [
            # identifiers (q0, F3, res_ab12, aer-local-1f) contain digits but are not numbers
            r"(?P<id>[A-Za-z_][A-Za-z_\-]*\d[\w\-]*)",
            r"(?P<ket>\|[^|\s⟩>]*[⟩>]|[⟨<][^|\s⟩>]*\|)",
            r"(?P<version>(?<![\w.])\d+\.\d+\.\d+(?:\.\d+)*)",
            r"(?P<outof>(?<![\w.])\d[\d,]*\s+out\s+of\s+\d[\d,]*)",
            rf"(?P<sci>{_NO_GLUE}{_SIGN}\d+(?:\.\d+)?[eE][-+−]?\d+)",
            rf"(?P<sqrtfrac>{_NO_GLUE}{_SIGN}\d+\s*/\s*{_SQRT})",
            rf"(?P<divsqrt>/\s*{_SQRT})",
            rf"(?P<sqrt>{_NO_GLUE}{_SIGN}\d*\s*{_SQRT})",
            rf"(?P<frac>{_NO_GLUE}{_SIGN}\d+\s*/\s*\d+(?![\w]|\.\d))",
            r"(?P<ratio>(?<![\w.])\d+\s*:\s*\d+(?![\w]|\.\d))",
            rf"(?P<pct>{_NO_GLUE}{_SIGN}\d+(?:\.\d+)?\s*%)",
            rf"(?P<dec>{_NO_GLUE}{_SIGN}\d*\.\d+(?:i(?!\w))?(?![\w]|\.\d))",
            rf"(?P<int>{_NO_GLUE}{_SIGN}\d[\d,]*(?:i(?!\w))?(?![\w]|\.\d))",
        ]
    ),
    re.IGNORECASE,
)

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(|⟨\-])|\n+")

# Number words: only 3+ and fractions, only next to a quantity noun (see module doc).
_WORD_VALUES = {
    "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80,
    "ninety": 90, "hundred": 100, "thousand": 1000,
}
# "third", "fifth" and "tenth" are left out: they are far more often ordinals ("the third step").
_FRACTION_WORDS = {"half": 0.5, "halves": 0.5, "quarter": 0.25}
_QUANTITY_CONTEXT = re.compile(
    r"\b(probabilit\w*|chance|likel\w*|percent\w*|times|shots?|counts?|outcomes?|amplitudes?|"
    r"fraction|proportion|frequen\w*|of the (?:time|runs|shots|measurements))\b",
    re.IGNORECASE,
)
_WORD_NUMBER = re.compile(r"\b(" + "|".join(sorted({*_WORD_VALUES, *_FRACTION_WORDS}, key=len, reverse=True)) + r")\b", re.IGNORECASE)

# Qualitative probability statements (no number in them).
_CERTAIN = re.compile(
    r"\b(always|never|certain(?:ly|ty)?|definitely|guaranteed|deterministic(?:ally)?|surely|invariably|impossible)\b",
    re.IGNORECASE,
)
_EVEN = re.compile(
    r"\b(equally\s+likely|equal(?:ly)?\s+(?:probab\w+|likel\w+|chance)|fifty[- ]fifty|50[- ]50|"
    r"even\s+(?:chance|split|odds)|same\s+(?:probability|chance))\b",
    re.IGNORECASE,
)
_MEASUREMENT_CONTEXT = re.compile(
    r"\b(measur\w*|outcomes?|reads?|readout|results?|probabilit\w*|likel\w*|shots?|collapses?|observed?|yields?)\b",
    re.IGNORECASE,
)

# Verdicts about a circuit or result. "Strong" ones are claims wherever they appear;
# "soft" ones (ordinary English) count only when the sentence is about this artifact.
_STRONG_VERDICT = re.compile(
    r"\b(verified|verifies|verify|equivalent|proven|proves|prove|passes|passed|pass|fails|failed|fail|"
    r"optimal|guaranteed)\b",
    re.IGNORECASE,
)
_SOFT_VERDICT = re.compile(r"\b(correct(?:ly)?|valid|right|works?|working)\b", re.IGNORECASE)
_ARTIFACT = re.compile(
    r"\b(this|your|the|my|our)\s+(?:\w+\s+){0,2}(circuit|result|run|execution|output|optimi[sz]ation|program|"
    r"candidate|state|simulation|experiment|trace|step)\b",
    re.IGNORECASE,
)

# "this circuit", "your result", "our run": the sentence is about the learner's own work,
# so it can only be licensed by a backend result fact, never by lesson prose.
_OWN_WORK = re.compile(
    r"\b(this|your|my|our)\s+(?:\w+\s+){0,2}(circuit|result|run|execution|output|optimi[sz]ation|program|"
    r"candidate|state|simulation|experiment|trace|step|measurement|shots?)\b",
    re.IGNORECASE,
)

_TOLERANCE_FRACTION = 1e-6  # facts carry 6 decimals; 1/√2 vs 0.707107 differ by 2e-7


@dataclass(frozen=True)
class NumericClaim:
    """One number-bearing expression found in text, with the value it denotes."""

    text: str
    kind: str  # int | dec | sci | pct | frac | ratio | sqrt | divsqrt | outof | version | ket | bits | word
    value: float | None = None
    decimals: int | None = None  # precision the number was written at
    parts: tuple[int, ...] = ()  # the integers of "N out of M" / "a:b"
    signed_negative: bool = False


@dataclass(frozen=True)
class Violation:
    claim: str
    kind: str
    reason: str

    def __str__(self) -> str:
        return f"{self.claim!r} ({self.kind}): {self.reason}"


@dataclass
class Support:
    """What a set of facts supports, read with the same parser as the draft."""

    text: str = ""
    ints: set[int] = field(default_factory=set)
    values: list[float] = field(default_factory=list)
    bitstrings: set[str] = field(default_factory=set)
    versions: set[str] = field(default_factory=set)
    verdict_lemmas: set[str] = field(default_factory=set)
    # Probabilities the backend stated (facts of kind "probability"), and the
    # magnitudes of the amplitude components it stated: what a qualitative claim
    # ("always", "equally likely") has to be checked against. Bitstring digits and
    # the zero imaginary parts of real amplitudes are deliberately not in here.
    probabilities: list[float] = field(default_factory=list)
    amplitude_magnitudes: list[float] = field(default_factory=list)
    # Course material (facts with no result id), lower-cased. A textbook sentence may be
    # restated ("a measurement is never repeatable" if the lesson says so); it is not
    # evidence about the learner's own circuit.
    lesson_text: str = ""
    lesson_words: set[str] = field(default_factory=set)


# --------------------------------------------------------------------------- #
# Parsing                                                                     #
# --------------------------------------------------------------------------- #


def _to_float(raw: str) -> float:
    return float(raw.replace("−", "-").replace(",", "").replace(" ", ""))


def _decimals(raw: str) -> int:
    body = raw.replace("%", "").strip()
    return len(body.split(".")[1]) if "." in body else 0


def _sqrt_value(raw: str) -> float:
    digits = re.search(r"\d+", raw[raw.index("√") if "√" in raw else raw.lower().index("sqrt") :])
    assert digits is not None
    return math.sqrt(float(digits.group(0)))


def extract_claims(sentence: str) -> list[NumericClaim]:
    """Every number-bearing expression in one sentence, in order."""
    claims: list[NumericClaim] = []
    for match in _TOKEN.finditer(sentence):
        kind = match.lastgroup
        raw = match.group(0).strip()
        if kind == "id":
            continue
        if kind == "ket":
            claims.append(NumericClaim(text=raw, kind="ket"))
            continue
        if kind == "version":
            claims.append(NumericClaim(text=raw, kind="version"))
            continue
        if kind == "outof":
            numbers = tuple(int(n.replace(",", "")) for n in re.findall(r"\d[\d,]*", raw))
            claims.append(NumericClaim(text=raw, kind="outof", parts=numbers, value=numbers[0] / numbers[1] if numbers[1] else None))
            continue
        negative = raw.startswith(("-", "−"))
        if kind == "sci":
            claims.append(NumericClaim(text=raw, kind="sci", value=_to_float(raw), signed_negative=negative))
        elif kind == "sqrtfrac":
            numerator = _to_float(raw.split("/")[0])
            claims.append(NumericClaim(text=raw, kind="sqrt", value=numerator / _sqrt_value(raw), signed_negative=negative))
        elif kind == "divsqrt":
            claims.append(NumericClaim(text=raw, kind="divsqrt", value=1 / _sqrt_value(raw)))
        elif kind == "sqrt":
            lead = re.match(r"[-+−]?\s*(\d+)\s*(?=√|sqrt)", raw, re.IGNORECASE)
            factor = float(lead.group(1)) if lead else 1.0
            claims.append(NumericClaim(text=raw, kind="sqrt", value=factor * _sqrt_value(raw), signed_negative=negative))
        elif kind == "frac":
            a, b = (int(n) for n in re.findall(r"\d+", raw))
            claims.append(NumericClaim(text=raw, kind="frac", value=(a / b if b else None), parts=(a, b), signed_negative=negative))
        elif kind == "ratio":
            a, b = (int(n) for n in re.findall(r"\d+", raw))
            claims.append(NumericClaim(text=raw, kind="ratio", value=(a / b if b else None), parts=(a, b)))
        elif kind == "pct":
            claims.append(NumericClaim(text=raw, kind="pct", value=_to_float(raw.replace("%", "")) / 100, decimals=_decimals(raw), signed_negative=negative))
        elif kind == "dec":
            number = raw[:-1] if raw.endswith(("i", "I")) else raw  # a trailing i is the imaginary unit
            claims.append(NumericClaim(text=raw, kind="dec", value=_to_float(number), decimals=_decimals(number), signed_negative=negative))
        elif kind == "int":
            raw = raw[:-1] if raw.endswith(("i", "I")) else raw
            digits = raw.lstrip("-+−")
            if len(digits) >= 2 and set(digits) <= {"0", "1"} and not negative:
                claims.append(NumericClaim(text=raw, kind="bits"))  # 00, 11, 101 … also read as an integer below
            claims.append(NumericClaim(text=raw, kind="int", value=_to_float(raw), signed_negative=negative))
    return claims


def _word_claims(sentence: str) -> list[NumericClaim]:
    if not _QUANTITY_CONTEXT.search(sentence):
        return []
    claims = []
    for match in _WORD_NUMBER.finditer(sentence):
        word = match.group(1).lower()
        value = _FRACTION_WORDS[word] if word in _FRACTION_WORDS else float(_WORD_VALUES[word])
        claims.append(NumericClaim(text=match.group(0), kind="word", value=value))
    return claims


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT.split(text) if s and s.strip()]


def read_support(facts: Iterable[TutorFact]) -> Support:
    """Read the values a fact list supports, with the same parser as the draft."""
    support = Support()
    descriptions = []
    facts_list = list(facts)
    for fact in facts_list:
        descriptions.append(fact.description)
        for sentence in split_sentences(fact.description) or [fact.description]:
            claims = extract_claims(sentence)
            bit_tokens = {c.text for c in claims if c.kind == "bits"}
            for claim in claims:
                if claim.kind == "int" and claim.text in bit_tokens:
                    # "00" is an outcome label; it does not make 0 a stated number
                    support.ints.add(int(claim.value))  # type: ignore[arg-type]
                    continue
                if claim.kind == "version":
                    support.versions.add(claim.text)
                elif claim.kind == "ket":
                    inner = claim.text.strip("|⟨⟩<>")
                    if inner:
                        support.bitstrings.add(inner)
                elif claim.kind == "bits":
                    support.bitstrings.add(claim.text)
                elif claim.kind == "outof":
                    support.ints.update(claim.parts)
                elif claim.kind == "ratio":
                    support.ints.update(claim.parts)
                elif claim.kind == "int" and claim.value is not None:
                    support.ints.add(int(claim.value))
                    support.values.append(claim.value)
                elif claim.value is not None:
                    support.values.append(claim.value)
                    if claim.kind == "frac":
                        support.ints.update(claim.parts)
        if fact.kind == "probability":
            support.probabilities.extend(
                c.value for c in extract_claims(fact.description) if c.kind == "dec" and c.value is not None
            )
        elif fact.kind in ("amplitude", "trace_amplitude"):
            # the real part is the first decimal; an amplitude fact is "|b⟩ amplitude: re + imi"
            decimals = [c.value for c in extract_claims(fact.description) if c.kind == "dec" and c.value is not None]
            if decimals:
                support.amplitude_magnitudes.append(abs(decimals[0]))
        if fact.result_id is not None:
            support.verdict_lemmas.update(m.group(1).lower() for m in _STRONG_VERDICT.finditer(fact.description))
            support.verdict_lemmas.update(m.group(1).lower() for m in _SOFT_VERDICT.finditer(fact.description))
    support.text = " ".join(descriptions)
    support.lesson_text = " ".join(f.description for f in facts_list if f.result_id is None).lower()
    support.lesson_words = set(re.findall(r"[a-z]+", support.lesson_text))
    return support


# --------------------------------------------------------------------------- #
# Validation                                                                  #
# --------------------------------------------------------------------------- #


def _close(value: float, other: float, decimals: int | None) -> bool:
    if decimals is None:
        return abs(value - other) <= _TOLERANCE_FRACTION
    return abs(value - other) <= 0.5 * 10 ** (-decimals) + 1e-12


def _ratio_values(values: list[float]) -> list[float]:
    distinct = sorted({round(v, 9) for v in values if v})
    return [a / b for a in distinct for b in distinct if b and a != b]


def _supports_value(claim: NumericClaim, support: Support, *, magnitude_ok: bool) -> bool:
    assert claim.value is not None
    candidates = support.values
    if claim.kind == "pct":
        precision = (claim.decimals or 0) + 2
        return any(_close(claim.value, f, precision) for f in candidates) or (
            magnitude_ok and claim.value > 0 and any(_close(claim.value, -f, precision) for f in candidates if f < 0)
        )
    if claim.kind in ("dec", "sci"):
        if claim.kind == "sci":
            tol = max(1e-12, abs(claim.value) * _TOLERANCE_FRACTION)
            hit = lambda f: abs(claim.value - f) <= tol  # noqa: E731
        else:
            hit = lambda f: _close(claim.value, f, claim.decimals)  # noqa: E731
        return any(hit(f) for f in candidates) or (
            magnitude_ok and claim.value > 0 and any(hit(-f) for f in candidates if f < 0)
        )
    if claim.kind in ("frac", "sqrt", "divsqrt"):
        options = [claim.value]
        if claim.kind in ("sqrt", "divsqrt") and claim.value:
            options.append(1 / claim.value)  # "/√2" and "1/√2" state the same normalisation
        return any(_close(v, f, None) for v in options for f in candidates) or (
            magnitude_ok and claim.value > 0 and any(_close(v, -f, None) for v in options for f in candidates if f < 0)
        )
    return False


def find_violations(text: str, facts: list[TutorFact]) -> list[Violation]:
    """Every claim in ``text`` that ``facts`` do not support (empty = grounded)."""
    support = read_support(facts)
    violations: list[Violation] = []

    for sentence in split_sentences(text):
        magnitude_ok = bool(re.search(r"\b(magnitude|absolute value|size|modulus)\b", sentence, re.IGNORECASE))
        for claim in [*extract_claims(sentence), *_word_claims(sentence)]:
            problem = _check_claim(claim, support, magnitude_ok)
            if problem:
                violations.append(Violation(claim.text, claim.kind, problem))
        violations.extend(_qualitative_violations(sentence, support))
        violations.extend(_verdict_violations(sentence, support))
    return violations


def _check_claim(claim: NumericClaim, support: Support, magnitude_ok: bool) -> str | None:
    kind = claim.kind
    if kind == "version":
        return None if claim.text in support.versions or claim.text in support.text else "a version the facts do not state"
    if kind == "ket":
        inner = claim.text.strip("|⟨⟩<>")
        if not inner or not set(inner) <= {"0", "1"} or len(inner) < 2:
            return None  # |0⟩, |1⟩, |+⟩, |−⟩, |ψ⟩: notation, not a claim about a result
        return None if inner in support.bitstrings else "a basis state the facts do not mention"
    if kind == "bits":
        return None  # judged with its integer reading below
    if kind == "word" and claim.text.lower() in support.lesson_words:
        return None  # the lesson material itself says "four outcomes"; restating it adds nothing
    if kind == "int" or (kind == "word" and claim.value is not None and float(claim.value).is_integer()):
        assert claim.value is not None
        if claim.signed_negative and claim.kind == "int" and not magnitude_ok:
            if int(claim.value) in support.ints or any(abs(claim.value - f) < 1e-12 for f in support.values):
                return None
            return "a negative integer the facts do not state"
        as_int = int(abs(claim.value))
        text_bits = claim.text.lstrip("-+−")
        if claim.kind == "int" and len(text_bits) >= 2 and set(text_bits) <= {"0", "1"} and text_bits in support.bitstrings:
            return None  # a bitstring such as 00 / 11 the facts do mention
        if as_int in support.ints or any(abs(abs(claim.value) - f) < 1e-12 or abs(claim.value - f) < 1e-12 for f in support.values):
            return None
        return "an integer (a count or quantity) the facts do not state"
    if kind == "outof":
        a, b = claim.parts
        return None if a in support.ints and b in support.ints else "a count the facts do not state"
    if kind == "ratio":
        a, b = claim.parts
        if a in support.ints and b in support.ints:
            return None
        if claim.value is not None and any(_close(claim.value, r, None) for r in _ratio_values(support.values)):
            return None
        return "a ratio the facts do not support"
    if claim.value is None:
        return "an expression with no value"
    if kind == "word":  # fraction words
        return None if any(abs(claim.value - f) <= 1e-3 for f in support.values) else "a fraction the facts do not support"
    if _supports_value(claim, support, magnitude_ok=magnitude_ok):
        return None
    what = {"dec": "a decimal", "sci": "a number in scientific notation", "pct": "a percentage", "frac": "a fraction",
            "sqrt": "a square-root expression", "divsqrt": "a square-root normalisation"}.get(kind, "a number")
    return f"{what} the facts do not state"


def _textbook(sentence: str, phrase: str, support: Support) -> bool:
    """The sentence restates something the lesson material itself says, and is not about
    the learner's own circuit or result."""
    return phrase.lower() in support.lesson_text and not _OWN_WORK.search(sentence)


def _qualitative_violations(sentence: str, support: Support) -> list[Violation]:
    if not _MEASUREMENT_CONTEXT.search(sentence):
        return []
    found: list[Violation] = []
    certain = _CERTAIN.search(sentence)
    if certain and not _textbook(sentence, certain.group(0), support):
        # One outcome with probability 1 (or a basis-state amplitude of magnitude 1) is what
        # makes "always" / "never" / "impossible" true of the others.
        has_certain_outcome = any(abs(p - 1.0) < 1e-9 for p in support.probabilities) or any(
            abs(a - 1.0) < 1e-9 for a in support.amplitude_magnitudes
        )
        if not has_certain_outcome:
            found.append(Violation(certain.group(0), "certainty", "no backend fact shows an outcome with probability 1"))
    even = _EVEN.search(sentence)
    if even and not _textbook(sentence, even.group(0), support):
        pools = ([round(p, 6) for p in support.probabilities], [round(a, 6) for a in support.amplitude_magnitudes])
        equal_pair = any(
            any(a == b and 0 < a < 1 for a, b in zip(sorted(pool), sorted(pool)[1:])) for pool in pools
        )
        if not equal_pair:
            found.append(Violation(even.group(0), "even split", "no two backend probabilities (or amplitude sizes) are equal"))
    return found


def _verdict_violations(sentence: str, support: Support) -> list[Violation]:
    found: list[Violation] = []
    for match in _STRONG_VERDICT.finditer(sentence):
        lemma = match.group(1).lower()
        if lemma not in support.verdict_lemmas and not _textbook(sentence, lemma, support):
            found.append(Violation(match.group(0), "verdict", "no backend result fact makes this verdict"))
    if _ARTIFACT.search(sentence):
        for match in _SOFT_VERDICT.finditer(sentence):
            lemma = match.group(1).lower()
            if lemma not in support.verdict_lemmas and not _textbook(sentence, lemma, support):
                found.append(Violation(match.group(0), "verdict", "no backend result fact makes this verdict"))
    return found
