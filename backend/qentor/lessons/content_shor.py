"""Lesson 18: Shor's Algorithm — Order Finding Intuition (final sprint).

ONE fixed educational instance, said so in the text and enforced by tests: the number 15, the base 2, seven qubits. Three counting
qubits q0..q2 and a four-qubit work register q3..q6 (q3 least significant) that starts at the number one. Multiplying by 2 modulo 15
only rotates the four bits up by one place, so the controlled multiplication by 2 is three controlled swaps (each a ``cx``, a ``ccx`` and
a ``cx``), controlled by q0; multiplying by 4 is a rotation by two places, two controlled swaps, controlled by q1; multiplying by 16 is the
identity, so q2 needs none. The inverse QFT is the one from the QPE lesson. The order of 2 modulo 15 is 4, so the counting register
reads one of 000, 010, 100, 110 (written ``q2 q1 q0``) and the work register ends holding a power of two from the cycle one, two, four,
eight. The numbers in this file's docstring are a description of the construction; every number a learner sees comes from the Lab and
the trace, and ``tests/test_shor_lesson.py`` checks every statement on the real Aer backend.

What this is NOT, and the text says so: not a general factoring implementation, not a scalable Shor's algorithm (the controlled modular
multiplications are compiled by hand only because 15 and 2 make multiplication a bit rotation), not a simulation of the classical
continued-fraction and gcd steps as a production factoring system, and not hardware. The gcd finish is shown as textbook arithmetic and is
never computed or labelled verified by the backend. The lesson has no challenge: ``no_challenge_reason`` says why.

Prose rules (tests enforce them): no decimal or percentage, no quantum number from a run, no multi-qubit ket (bit strings are written in
words), and any worked reasoning is labelled textbook.
"""

from __future__ import annotations

from qentor.circuit.model import Circuit, GateOp

from .content_algorithms import INVERSE_QFT3_OPS, _ccx, _g, _measure, _opts
from .models import (
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    Lesson,
    ReflectionSection,
)


def _cswap(control: int, a: int, b: int) -> list[GateOp]:
    """Swap a and b when ``control`` is 1, from the gates the model has: cx(b->a), ccx(control, a -> b), cx(b->a)."""
    return [_g("cx", a, b), _ccx(control, a, b), _g("cx", a, b)]


# Work register q3 (least significant) .. q6. Multiplication by 2 modulo 15 rotates the four bits up by one place (q3->q4->q5->q6->q3),
# multiplication by 4 rotates them by two, multiplication by 16 changes nothing.
SHOR_PREPARE = [_g("x", 3), _g("h", 0), _g("h", 1), _g("h", 2)]
SHOR_CONTROLLED_TIMES_2 = [*_cswap(0, 5, 6), *_cswap(0, 4, 5), *_cswap(0, 3, 4)]
SHOR_CONTROLLED_TIMES_4 = [*_cswap(1, 3, 5), *_cswap(1, 4, 6)]
SHOR_CONTROLLED_POWERS = [*SHOR_CONTROLLED_TIMES_2, *SHOR_CONTROLLED_TIMES_4]
SHOR_READOUT = [*INVERSE_QFT3_OPS, _measure(0, 0), _measure(1, 1), _measure(2, 2)]

SHOR_LESSON_ID = "shors-algorithm"

SHOR_LESSONS: list[Lesson] = [
    Lesson(
        id=SHOR_LESSON_ID,
        title="Shor's Algorithm — Order Finding Intuition",
        short_description=(
            "Finding the cycle length of the powers of 2 modulo 15 with phase estimation, in one fixed 7-qubit educational instance; "
            "not a factoring implementation."
        ),
        concept="shors-algorithm",
        difficulty="advanced",
        estimated_minutes=28,
        learning_objectives=[
            "Say what the order of a number modulo N is, using the powers of 2 modulo 15.",
            "Explain how a cycle length shows up as a phase that phase estimation can read.",
            "Say which step of the finish is classical arithmetic and which is the quantum part.",
            "Tell this one fixed instance from a general factoring implementation.",
            "Read the fixed 7-qubit lab circuit through its counting register and its work register.",
        ],
        linked_circuit=Circuit(
            num_qubits=7,
            num_clbits=3,
            ops=[*SHOR_PREPARE, *SHOR_CONTROLLED_POWERS, *SHOR_READOUT],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Finding a hidden period",
                body=(
                    "Shor's algorithm factors a number by finding the order of another number: how many times you multiply before "
                    "the powers come back to one. This lesson is ONE fixed small educational instance, not a general factoring "
                    "implementation: the number is 15, the base is 2, and the circuit is compiled by hand for exactly that case. It "
                    "is not a scalable Shor's algorithm, it factors nothing by itself, and it needs no hardware."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="The order of 2 modulo 15",
                body=(
                    "Take powers of 2 and keep only the remainder after dividing by 15: two, four, eight, and then sixteen leaves "
                    "one. The values cycle one, two, four, eight and back to one, so the order of 2 modulo 15 is four. This is "
                    "textbook arithmetic, not a run. Finding the length of such a cycle is the whole quantum job; for a large "
                    "number, walking along the cycle one step at a time is not a realistic way to find it."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Multiplication as a gate on four qubits",
                body=(
                    "Multiplying by 2 modulo 15 only moves values around, so it can be a gate on four work qubits: written as four "
                    "bits, every bit moves up one place and the top bit wraps round to the bottom. In this fixed example that is "
                    "three swaps, and the controlled version is a swap guarded by a counting qubit. This is textbook reasoning about "
                    "this one case. Compiling the multiplication by hand works only because 15 and 2 are so convenient: it is the "
                    "part that does not carry over to larger numbers."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="The period becomes a phase",
                body=(
                    "The multiplication gate has special states that it changes only by a phase. With the work register started at "
                    "one, the register is a mixture of those states, and each carries a phase that is a whole number of quarter "
                    "turns: none, a quarter, a half or three quarters. Phase estimation, from the earlier lesson, reads one of "
                    "those phases out as a bit string. This is textbook reasoning: the denominator of the fraction is the order."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: what the counting register reveals",
                prompt="Think about what one run of phase estimation can return when the work register starts at one.",
                question="What does one measurement of the counting register give in this example?",
                options=_opts(
                    a="The order, written directly as a number in bits",
                    b="One phase, a whole number of quarter turns chosen at random, whose fraction reveals the order",
                    c="The factors of fifteen, read straight from the bit string",
                    d="The remainder of two to the power of the counting number, divided by fifteen",
                ),
                correct_option_id="b",
                explanation=(
                    "Each run returns one of the allowed phases, chosen at random: none, a quarter, a half or three quarters. The "
                    "bit string is a fraction of a turn, not the order itself and not a factor. The order is read from the "
                    "fraction's denominator, and a fraction that reduces, such as a half, can show only part of it, so a run may "
                    "have to be repeated."
                ),
                concept="order-finding",
            ),
            InteractiveLabSection(
                id="s6",
                title="Lab: run the order-finding circuit",
                instructions=(
                    "Open the lab circuit: X puts the work register q3 to q6 at one, H puts the three counting qubits in "
                    "superposition, controlled multiplications by 2 and by 4 act on the work qubits (multiplying by 16 changes "
                    "nothing, so q2 needs none), the inverse QFT converts the pattern, and the counting qubits are measured. Run "
                    "it on the backend in shots mode and read the counting register as q2 q1 q0: the textbook expectation is a "
                    "few evenly spaced strings, and the Lab shows what the backend actually returns. Then open the trace and "
                    "watch the work register q3 to q6. Nothing here is hardware and nothing here is a factoring result."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: the classical finish",
                prompt="Think about which parts of the whole procedure need a quantum computer at all.",
                question=(
                    "Once the order four is known, the finish compares four minus one and four plus one with fifteen. Which "
                    "statement about this finish is right?"
                ),
                options=_opts(
                    a="It is quantum: the counting register is measured a second time to read off the common divisor",
                    b="It is classical: the greatest common divisors with fifteen are ordinary arithmetic, with no quantum computer",
                    c="It is skipped, because the measured bit string already contains the factors of fifteen",
                    d="It is simulated by the backend and shown in the Lab as a verified result of the run",
                ),
                correct_option_id="b",
                explanation=(
                    "Once the order is known, the finish is ordinary arithmetic on a classical computer: the greatest common "
                    "divisor of fifteen with the number one below two to half the order, and with the number one above it. The "
                    "bit string holds a phase, not factors, and the Lab does not compute or verify this step. It is textbook "
                    "arithmetic shown in the lesson, not a result from the backend."
                ),
                concept="order-finding",
            ),
            ExplanationSection(
                id="s8",
                title="Why a run can need repeating",
                body=(
                    "A single run gives one fraction chosen at random from the allowed ones. A fraction that reduces, such as two "
                    "quarters being one half, shows only part of the order, and a result of none shows nothing at all. So the full "
                    "procedure repeats the run and combines what it sees. This is textbook reasoning about this example. The "
                    "lesson shows the structure of one run and does not carry out a repeated procedure."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="This fixed instance versus factoring in general",
                body=(
                    "This lesson is ONE fixed instance: the number 15, the base 2, seven qubits and multiplications compiled by "
                    "hand. It is not a general factoring implementation and not a scalable Shor's algorithm. The expensive parts at "
                    "scale, building controlled modular multiplications and running the classical finishing steps, are not "
                    "simulated here as a production factoring system. It runs on a statevector simulator with no hardware, and it "
                    "makes no performance claim and says nothing about breaking any encryption."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "The circuit never computed a factor of fifteen. Which part of the whole procedure found the cycle length, and "
                    "which part turned it into factors? What would stop this exact circuit from being reused for a different number?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["quantum-phase-estimation"],
        no_challenge_reason=(
            "A server-checkable task on this circuit would only rebuild the controlled multiplications or the inverse QFT, which the "
            "quantum Fourier transform and phase estimation challenges already ask for; the new ideas here, the order of a number and the "
            "classical finish, need no circuit and are covered by the two graded checks and the Lab."
        ),
    ),
]
