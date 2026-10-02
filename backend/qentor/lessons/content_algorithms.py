"""Lessons 14–16: the Quantum Fourier Transform, Quantum Phase Estimation and Quantum Error Correction (Sprint 4).

Same architecture and rules as every other lesson (``models.py`` types, ten sections, concept checks graded by the server from
``grading.py``, content checked by ``qentor.content.validation``). Each is ONE small fixed example, said so in its text, and none
claims a scalable or fast algorithm:

* QFT: three qubits, the input is the number one (``x`` on q0), then the standard ladder of ``h`` and controlled phases (``cp``) and
  a final swap of q0 and q2. The output of a basis-state input is not entangled: equal sizes, phases that step around a circle.
* QPE: four qubits. Three counting qubits q0..q2, one target q3 prepared in the eigenstate one of the ``s`` gate, whose phase is a
  quarter of a turn (two eighths), so the exact answer is representable and the counting register reads the bit string 010
  (written ``q2 q1 q0``). Only two controlled phases are needed because ``s`` four times is the identity. The text separates this
  exact fixed example from the general algorithm (a phase that is not a whole number of eighths gives a spread, the eigenstate must
  be supplied, controlled powers can be costly).
* QEC: the three-qubit bit-flip code on five qubits (three data, two ancillas). The error is a FIXED injected ``x`` on q1, NOT a
  noise model, and the text says so. The circuit model has no mid-circuit measurement and no classical control, so the correction is
  DEFERRED (ancilla-controlled gates), exactly as in the teleportation lesson, and the text says that too.

Prose rules (tests enforce them): no decimal or percentage, no quantum number from a run, no multi-qubit ket (bit strings are written
``q2 q1 q0`` in words), and any worked reasoning is labelled textbook. The numbers a learner sees come from the Lab and the trace.
"""

from __future__ import annotations

import math

from qentor.circuit.model import Circuit, GateOp

from .models import (
    ConceptCheckOption,
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    Lesson,
    ReflectionSection,
)


def _opts(**options: str) -> list[ConceptCheckOption]:
    return [ConceptCheckOption(id=option_id, text=text) for option_id, text in options.items()]


def _g(gate: str, target: int, control: int | None = None, angle: float | None = None) -> GateOp:
    return GateOp(
        gate=gate,  # type: ignore[arg-type]
        targets=[target],
        controls=[] if control is None else [control],
        params=[] if angle is None else [angle],
    )


def _swap(a: int, b: int) -> GateOp:
    return GateOp(gate="swap", targets=[a, b])


def _ccx(c1: int, c2: int, target: int) -> GateOp:
    return GateOp(gate="ccx", controls=[c1, c2], targets=[target])


def _measure(qubit: int, clbit: int) -> GateOp:
    return GateOp(gate="measure", targets=[qubit], clbits=[clbit])


PI = math.pi

# ---- the fixed circuits, as plain data. The challenges (qentor.challenges.content) import the same building blocks so a lesson's lab
# and its challenge can never drift apart. cp(angle) is ``_g("cp", target, control, angle)``.
QFT3_OPS = [
    _g("h", 2),
    _g("cp", 2, 1, PI / 2),
    _g("cp", 2, 0, PI / 4),
    _g("h", 1),
    _g("cp", 1, 0, PI / 2),
    _g("h", 0),
    _swap(0, 2),
]
INVERSE_QFT3_OPS = [
    _swap(0, 2),
    _g("h", 0),
    _g("cp", 1, 0, -PI / 2),
    _g("h", 1),
    _g("cp", 2, 0, -PI / 4),
    _g("cp", 2, 1, -PI / 2),
    _g("h", 2),
]
QFT2_OPS = [_g("h", 1), _g("cp", 1, 0, PI / 2), _g("h", 0), _swap(0, 1)]

# QPE: counting qubits q0 q1 q2, target q3. The S gate's controlled powers: S (a quarter turn) from q0, S twice (a half turn, a controlled-Z
# in phase terms) from q1, and S four times is the identity, so q2 needs none.
QPE_S_CONTROLLED = [_g("cp", 3, 0, PI / 2), _g("cp", 3, 1, PI)]
QPE_PREPARE = [_g("x", 3), _g("h", 0), _g("h", 1), _g("h", 2)]

# QEC: data q0 q1 q2, ancillas q3 q4. The logical state is ry(1) on q0 (a fixed example, as in the teleportation lesson).
QEC_ANGLE = 1.0
QEC_ENCODE = [_g("ry", 0, angle=QEC_ANGLE), _g("cx", 1, 0), _g("cx", 2, 0)]
QEC_ERROR = [_g("x", 1)]
QEC_SYNDROME = [_g("cx", 3, 0), _g("cx", 3, 1), _g("cx", 4, 1), _g("cx", 4, 2)]
QEC_CORRECTION_Q1 = [_ccx(3, 4, 1)]
QEC_CORRECTION_Q0 = [_g("x", 4), _ccx(3, 4, 0), _g("x", 4)]
QEC_CORRECTION_Q2 = [_g("x", 3), _ccx(3, 4, 2), _g("x", 3)]
QEC_DECODER = [*QEC_CORRECTION_Q1, *QEC_CORRECTION_Q0, *QEC_CORRECTION_Q2]


ALGORITHM_LESSONS: list[Lesson] = [
    # ------------------------------------------------------------------ 14
    Lesson(
        id="quantum-fourier-transform",
        title="Quantum Fourier Transform",
        short_description="A change of basis that stores a number in relative phases, in one fixed 3-qubit example with a basis-state input.",
        concept="quantum-fourier-transform",
        difficulty="advanced",
        estimated_minutes=22,
        learning_objectives=[
            "Say what the QFT does to a basis-state input: equal sizes and phases that step around a circle.",
            "Explain why the controlled-phase gates make the phases depend on the whole input.",
            "Explain what the basis change means: the information moves from which state to relative phases.",
            "Say why the circuit ends with a swap.",
            "Read the fixed 3-qubit example through the trace, the per-qubit spheres and the amplitude view.",
        ],
        linked_circuit=Circuit(
            num_qubits=3,
            num_clbits=3,
            ops=[_g("x", 0), *QFT3_OPS, _measure(0, 0), _measure(1, 1), _measure(2, 2)],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="A basis change that stores a number in phases",
                body=(
                    "The quantum Fourier transform (QFT) is a change of basis. Fed a basis state, which stands for one whole "
                    "number, it returns every basis state at the same size, with the number written into how the phases differ. "
                    "This lesson is ONE fixed 3-qubit example: the input is the number one, made by X on q0. It is a small "
                    "educational example. It does not claim that the QFT is fast or useful by itself: its main use is as a part of "
                    "other algorithms. The same ladder extends to more qubits, but this lesson runs only the 3-qubit case and says "
                    "nothing about how a larger QFT scales."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="What comes out",
                body=(
                    "Qentor writes bit strings with the highest-numbered qubit on the left, so the input here is q2 q1 q0 = 001. "
                    "After the QFT all eight outcomes have the same size, so measuring says nothing about the input. What differs "
                    "is the phase. This is textbook reasoning, not a run: for an input number x, outcome number y gets a phase of "
                    "x times y eighths of a full turn, so for the input one the phase grows by one eighth of a turn from each "
                    "outcome to the next."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Why controlled phases matter",
                body=(
                    "An H gate makes an equal superposition, but on its own it cannot make a phase depend on the other qubits. The "
                    "controlled-phase gates (cp) can: each adds a smaller turn, a quarter or an eighth of a full turn, only when its "
                    "control qubit is 1. The control qubits hold the digits of the input number, so the phases that come out depend "
                    "on the whole number. This is textbook reasoning. Without the controlled phases the circuit would treat every "
                    "qubit separately and could not build this pattern."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="What the basis change means",
                body=(
                    "A basis change writes the same information with a different set of states. Before the QFT the number is which "
                    "basis state the qubits are in. After it, the number is carried by relative phases and every size is equal. A "
                    "measurement in the original basis only reads the sizes, so it cannot see the number. This is textbook "
                    "reasoning. Run backwards, the inverse QFT turns the phase pattern into a basis state again, which is how phase "
                    "estimation reads a phase out."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: what a measurement shows after the QFT",
                prompt="Think about where the information about the input number is stored after the QFT.",
                question="A basis-state input goes through the QFT and all three qubits are then measured, many times. What does the measurement show?",
                options=_opts(
                    a="The input number every time, because the QFT only relabels the basis states and keeps every size as it was",
                    b="All eight outcomes about equally often, because the number is now stored in the phases",
                    c="Only the outcomes that are multiples of the input number",
                    d="Two outcomes only: the input number and its mirror image",
                ),
                correct_option_id="b",
                explanation=(
                    "After the QFT every outcome has the same size, so the measurement odds are even whatever the input was. The "
                    "input is not lost: it sits in how the phases differ between outcomes, which a measurement in this basis cannot "
                    "read. The QFT is reversible, so the inverse QFT recovers the input. Reading the input number straight off the "
                    "measurements is exactly what the QFT does not allow."
                ),
                concept="quantum-fourier-transform",
            ),
            InteractiveLabSection(
                id="s6",
                title="Lab: the QFT of the input one",
                instructions=(
                    "Open the lab circuit: X on q0 makes the input one, then H and controlled-phase gates build the QFT, a final "
                    "swap puts the qubits in order, and all three qubits are measured. Run it on the backend in shots mode: the "
                    "eight outcomes come out about equally often, which hides the phases. Then open the trace and step through it, "
                    "reading the phase column of the amplitude view and each qubit's own sphere. The QFT of a basis state is not "
                    "entangled, so each qubit alone has an arrow of full length on the equator of its sphere."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: why the circuit ends with a swap",
                prompt="Think about the order in which the main steps handle the qubits.",
                question="The H and controlled-phase steps of this QFT are followed by a swap of q0 and q2. Why?",
                options=_opts(
                    a="The swap measures q0 and q2 so that the phases become visible",
                    b="The swap cancels the phases that the controlled-phase gates added",
                    c="The main steps leave the output in reverse qubit order, and the swap puts it in order",
                    d="Every circuit that computes a transform has to end with a swap, whatever the transform does or how many qubits it uses",
                ),
                correct_option_id="c",
                explanation=(
                    "The H and controlled-phase ladder starts from q2 and works down to q0, so it leaves the finished phases on the "
                    "mirrored qubits: the result is right but in reverse qubit order. Swapping q0 and q2 puts every part in its "
                    "place, and the middle qubit is its own mirror. Without the swap the circuit is still a QFT up to that "
                    "reordering, which some algorithms simply account for."
                ),
                concept="quantum-fourier-transform",
            ),
            ExplanationSection(
                id="s8",
                title="Why the final swaps are required",
                body=(
                    "The ladder of H and controlled-phase gates handles q2 first and q0 last, and it leaves the phase that belongs "
                    "to q0 on q2 and the other way round. The final swap of q0 and q2 corrects that. In this three-qubit example "
                    "one swap is enough, because the middle qubit q1 is its own mirror. With more qubits the swaps pair up the "
                    "qubits from the two ends. The result then matches the textbook definition of the QFT outcome by outcome."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="Reading the trace honestly",
                body=(
                    "The QFT of a basis state is not entangled: each qubit alone is in a state of its own, so each per-qubit sphere "
                    "shows an arrow of full length. Those arrows lie on the equator and point different ways, and the amplitude "
                    "view shows eight rows of equal size with phases that step around. In the steps before the swap the same phases "
                    "sit on the mirrored qubits. Every number you see comes from the backend's trace, not from this text."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "After the QFT all outcomes are equally likely, yet the input number is still in the state. Where is it, and "
                    "what would you do to the circuit to read it back as a basis state?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["phase", "interference"],
    ),
    # ------------------------------------------------------------------ 15
    Lesson(
        id="quantum-phase-estimation",
        title="Quantum Phase Estimation",
        short_description="Reading a phase out as a bit string, in one exact fixed 4-qubit example with the S gate; not the general algorithm.",
        concept="quantum-phase-estimation",
        difficulty="advanced",
        estimated_minutes=24,
        learning_objectives=[
            "Say what an eigenstate is and what the phase of a gate on it means.",
            "Explain how phase kickback writes that phase into the counting qubits.",
            "Explain what the inverse QFT does to the counting register.",
            "Say why the measured result is a bit string, and how to read the phase from it.",
            "Tell this exact fixed example from the general algorithm.",
        ],
        linked_circuit=Circuit(
            num_qubits=4,
            num_clbits=3,
            ops=[
                *QPE_PREPARE,
                *QPE_S_CONTROLLED,
                *INVERSE_QFT3_OPS,
                _measure(0, 0),
                _measure(1, 1),
                _measure(2, 2),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Estimating a phase",
                body=(
                    "Many gates have special states, called eigenstates, that they only multiply by a phase. Phase estimation reads "
                    "that phase out as a string of bits, using a counting register, controlled gates and the inverse QFT. This "
                    "lesson is ONE exact fixed example, not the general algorithm: three counting qubits q0 to q2, one target q3, "
                    "the S gate as the unitary, and the target prepared in its eigenstate, the state one. It is a small "
                    "educational example."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Eigenstates and the phase of a gate",
                body=(
                    "An eigenstate comes out of its gate unchanged except for a phase. The S gate leaves the state one as it is and "
                    "multiplies it by a quarter of a full turn. Written as a fraction of a full turn, that phase is one quarter, "
                    "which is two eighths. This is textbook reasoning, not a run. The target qubit q3 is prepared in that "
                    "eigenstate with an X gate, and it stays there for the whole circuit."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Phase kickback writes the phase into the counting qubits",
                body=(
                    "When a controlled gate acts on an eigenstate, the phase does not stay on the target: it kicks back onto the "
                    "control qubit. Counting qubit q0 controls S once and gains a quarter turn. Counting qubit q1 controls S twice, "
                    "which is a half turn. Counting qubit q2 would control S four times, a full turn, which does nothing, so q2 "
                    "needs no controlled gate. This is textbook reasoning, and it is why the circuit has only two controlled-phase "
                    "gates."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="The inverse QFT reads the phase out",
                body=(
                    "After the kickbacks the counting register holds the pattern that the QFT would make from the number two, "
                    "because the phase is two eighths of a turn. The inverse QFT undoes that: it turns the phase pattern into the "
                    "basis state for the number two. This is textbook reasoning. The inverse QFT is the QFT of the previous lesson "
                    "run backwards: its gates in reverse order, each phase turned the other way."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: what the inverse QFT does here",
                prompt="Think about what the counting qubits hold just before the inverse QFT.",
                question="Why is the inverse QFT applied to the counting qubits?",
                options=_opts(
                    a="It undoes the phase kickback so that the target returns to its starting state",
                    b="It entangles the counting qubits with the target so that the phase can be read off by measuring them",
                    c="It turns the phase pattern into a basis state whose bit string gives the phase",
                    d="It makes each counting qubit equally likely to read zero or one",
                ),
                correct_option_id="c",
                explanation=(
                    "Before the inverse QFT the counting qubits hold the phase as a pattern of relative phases, which a measurement "
                    "cannot read. The inverse QFT converts that pattern into one basis state, and the bit string of that state is "
                    "the phase estimate. It does not touch the target and it adds no entanglement: the target stays in its "
                    "eigenstate throughout."
                ),
                concept="quantum-phase-estimation",
            ),
            InteractiveLabSection(
                id="s6",
                title="Lab: estimate the phase of S",
                instructions=(
                    "Open the lab circuit: X prepares the target q3 in the eigenstate, H puts the three counting qubits in "
                    "superposition, two controlled-phase gates kick the phase of S back onto q0 and q1, the inverse QFT converts "
                    "the pattern, and the counting qubits are measured. Run it on the backend in shots mode and read the counting "
                    "register as q2 q1 q0. Then open the trace: after the controlled-phase gates look at each counting qubit's own "
                    "sphere, and look again after the inverse QFT. The target q3 does not change."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: this example and the general algorithm",
                prompt="Think about what three counting qubits can and cannot name.",
                question=(
                    "In this lesson's example the counting register reads the same bit string every time. What would change if the "
                    "gate's phase were not a whole number of eighths of a turn?"
                ),
                options=_opts(
                    a="The register would still read one bit string every time, but a wrong one that no longer matches the phase",
                    b="Phase estimation would fail to run on the circuit at all",
                    c="The target qubit would be measured instead of the counting qubits",
                    d="The register would read a spread of strings, most likely near the true phase",
                ),
                correct_option_id="d",
                explanation=(
                    "Three counting qubits can name only eight phases, one eighth of a turn apart. A phase between two of them "
                    "gives a spread of outcomes, with the nearest ones most likely, and every added counting qubit halves the "
                    "spacing. Here the phase is exactly two eighths, which is why the result is certain: that is a property of this "
                    "fixed example, not of phase estimation in general."
                ),
                concept="quantum-phase-estimation",
            ),
            ExplanationSection(
                id="s8",
                title="Why the result becomes a bit string",
                body=(
                    "The counting register ends in one basis state, and measuring it gives bits. Read as a number y with three "
                    "bits, the phase estimate is y eighths of a full turn. For this example the textbook answer, written q2 q1 "
                    "q0, is zero one zero: the number two, so two eighths, one quarter, which is the phase of S on its eigenstate. "
                    "The Lab shows what the backend actually returns. This is how a phase becomes something a classical computer "
                    "can store."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="This exact example versus the general algorithm",
                body=(
                    "Here the phase is exactly two eighths, the target is a known eigenstate and the controlled gates are given, so "
                    "the answer is certain. In general the phase need not be a whole number of eighths, the eigenstate has to be "
                    "supplied, and the controlled powers of a gate can be costly to build. This lesson shows the structure of "
                    "phase estimation on four qubits. It does not show a speed-up and is not a general tool."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "The phase was never measured directly. Which parts of the circuit moved it from the target to the counting "
                    "qubits, and which part turned it into bits?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["quantum-fourier-transform", "phase-kickback"],
    ),
    # ------------------------------------------------------------------ 16
    Lesson(
        id="quantum-error-correction",
        title="Quantum Error Correction",
        short_description="Spreading a state over three qubits, finding a bit flip with a syndrome and undoing it, in one fixed example with an injected error.",
        concept="quantum-error-correction",
        difficulty="advanced",
        estimated_minutes=26,
        learning_objectives=[
            "Explain why the encoding spreads a state by entanglement instead of copying it.",
            "Say what the syndrome shows and what it does not reveal.",
            "Follow the fixed circuit: encode, injected X error, syndrome, deferred correction.",
            "Say plainly that the injected error is a fixed gate and not a physical noise model.",
            "Say what this code cannot correct.",
        ],
        linked_circuit=Circuit(
            num_qubits=5,
            num_clbits=5,
            ops=[
                *QEC_ENCODE,
                *QEC_ERROR,
                *QEC_SYNDROME,
                *QEC_DECODER,
                _measure(0, 0),
                _measure(1, 1),
                _measure(2, 2),
                _measure(3, 3),
                _measure(4, 4),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Redundancy against a flip",
                body=(
                    "A classical memory can survive a flipped bit by keeping three copies and taking a majority. A qubit cannot be "
                    "copied, but its state can be spread over three qubits by entanglement. This lesson is ONE fixed 5-qubit "
                    "example: three data qubits q0, q1 and q2 and two ancilla qubits q3 and q4. It uses a fixed injected error, an "
                    "X gate on q1, and NOT a realistic noise model. It is a small educational example of the three-qubit bit-flip "
                    "code."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Encoding is not copying",
                body=(
                    "Encoding applies CX from q0 to q1 and again to q2. A state of q0 that mixes zero and one becomes a state in "
                    "which all three data qubits agree, either all zero or all one, with the same mixture. That is not three copies "
                    "of the original state: the three qubits are entangled, and each alone has a shorter arrow on its sphere than a "
                    "qubit in a state of its own. This is textbook reasoning."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Injected error versus physical noise",
                body=(
                    "The error in this lesson is a fixed X gate on q1, chosen by us and applied every time, so that we can follow "
                    "what the code does. Physical noise is nothing like that: it is random, it comes from the environment, it can "
                    "strike any qubit at any moment, and it is not always a clean flip. This lesson does not model physical noise "
                    "and shows no error rate. It does not claim to show how real devices fail or how often."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="What the syndrome represents",
                body=(
                    "Ancilla q3 is made to collect whether q0 and q1 agree, and ancilla q4 whether q1 and q2 agree, with two CX "
                    "gates each. The pair of ancillas is the syndrome. It says where a disagreement is, not what the encoded state "
                    "is. This is textbook reasoning: a flip on q0 is seen only by q3, a flip on q2 only by q4, and a flip on q1 by "
                    "both. With no error neither sees anything."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: what the syndrome tells the decoder",
                prompt="Think about what the two ancilla qubits compare.",
                question="After the syndrome is extracted, what do the two ancilla qubits tell the decoder?",
                options=_opts(
                    a="Which data qubit disagrees with the others, without revealing the encoded state",
                    b="The encoded state itself, so that the decoder can make a copy of it before the error spreads",
                    c="How likely it is that an error happens again",
                    d="Whether the data qubits are entangled with one another",
                ),
                correct_option_id="a",
                explanation=(
                    "Each ancilla records whether a pair of data qubits agree, so together they point at the one qubit that "
                    "disagrees. They record nothing about whether the encoded value is zero or one, since a pair of agreeing "
                    "qubits looks the same either way. That is what lets the decoder fix a flip without ever learning, or "
                    "disturbing, the encoded state."
                ),
                concept="quantum-error-correction",
            ),
            InteractiveLabSection(
                id="s6",
                title="Lab: inject, detect, correct",
                instructions=(
                    "Open the lab circuit: it encodes q0 over three data qubits, injects the X error on q1, extracts the syndrome "
                    "onto q3 and q4, applies the deferred correction, and measures all five qubits. Run it on the backend in shots "
                    "mode: read the ancillas as q4 q3 and the data qubits as q2 q1 q0. Then open the trace and watch q1's own "
                    "sphere: the injected X turns its arrow around and the correction turns it back. Finally remove the CCX "
                    "whose target is q1 and run again to see the uncorrected result."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: what this code cannot correct",
                prompt="Think about which errors the syndrome of this code can and cannot see.",
                question="Which of these errors is NOT fixed by this three-qubit bit-flip code?",
                options=_opts(
                    a="A single bit flip on q0, on a state that mixes zero and one",
                    b="A single bit flip on q1, on a state that mixes zero and one",
                    c="A phase flip on a data qubit, or two bit flips at once",
                    d="A single bit flip on q2, on a state that mixes zero and one",
                ),
                correct_option_id="c",
                explanation=(
                    "The syndrome compares bit values, so it sees a bit flip on one qubit and the decoder can undo it. A phase "
                    "flip changes a sign, which neither comparison notices, so nothing is corrected. Two bit flips look like a "
                    "flip on the third qubit, so the decoder flips the wrong qubit and the encoded state ends up flipped. A code "
                    "that protects against more needs more qubits."
                ),
                concept="quantum-error-correction",
            ),
            ExplanationSection(
                id="s8",
                title="Deferred correction",
                body=(
                    "The decoder is a set of gates controlled by the ancillas, applied before any measurement: a CCX from q3 and "
                    "q4 flips q1, and X gates around a CCX select the other two patterns. This is a deferred correction, the same "
                    "trick as in the teleportation lesson. Qentor's circuit model has NO mid-circuit measurement and NO classical "
                    "control, so this is not the full protocol in which the syndrome is measured and a classical computer chooses "
                    "the correction."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="The restored state, read honestly",
                body=(
                    "After the correction the data qubits are back in the encoded state they were in before the error, and the "
                    "ancillas still hold the syndrome, because nothing resets them. The encoded state was never measured. Each "
                    "data qubit alone still looks undetermined, and the sphere of q1 is the one that turned and came back. This is "
                    "a fixed example with one injected error, not a claim about fault tolerance or about any real device."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "The syndrome points at the flipped qubit but says nothing about the encoded state. Why is that exactly what "
                    "makes the correction possible? And what would the decoder do wrongly if two qubits were flipped?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["entanglement"],
    ),
]
