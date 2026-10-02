"""Lesson 17: a variational, VQE-style demonstration (Sprint 6).

Same architecture and rules as every other lesson (``models.py`` types, ten sections, concept checks graded by the server from ``grading.py``,
content checked by ``qentor.content.validation``). It is ONE small fixed educational example and says so:

* one qubit, one parameter: ``RY(theta)`` prepares a trial state from |0>; the cost is the expectation value of the Pauli Z observable in that
  state. The server reads that value from the statevector the backend produced (``qentor.execution.expectation``) for every angle it shows;
* the classical half is a gradient-descent loop whose gradient is built from backend cost values by the parameter-shift rule
  (``qentor.verification.variational``);
* it is VQE-STYLE in shape only. The lesson says plainly that it is not a chemistry calculation, not a scalable VQE and not run on hardware.

Prose rules (tests enforce them): no decimal or percentage, no quantum number from a run, no multi-qubit ket, every worked piece of reasoning
labelled textbook. The numbers a learner sees come from the Lab, the trace and the parameter sweep, all computed by the server.
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


VARIATIONAL_LESSONS: list[Lesson] = [
    Lesson(
        id="variational-vqe",
        title="Variational Circuits: a VQE-Style Demonstration",
        short_description="One rotation angle, a cost read from the state it prepares, and a classical loop that searches for the lowest cost: a small educational example, not chemistry.",
        concept="variational-algorithms",
        difficulty="advanced",
        estimated_minutes=22,
        learning_objectives=[
            "Say what a parameterised circuit is and why its angle acts as a knob.",
            "Read the expectation value of Z as how far the qubit's arrow points up or down.",
            "Explain how a classical loop lowers a cost using only values the quantum side returns.",
            "Describe the cost curve and what the optimisation path does on it.",
            "Say plainly what this one-parameter demonstration is not.",
        ],
        linked_circuit=Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="ry", targets=[0], params=[math.pi / 2])]),
        sections=[
            ExplanationSection(
                id="s1",
                title="A circuit with a knob",
                body=(
                    "A variational algorithm has two halves. A quantum circuit with an adjustable angle prepares a trial state, and a "
                    "classical computer adjusts that angle to make a chosen cost as low as it can. This lesson is ONE fixed one-parameter "
                    "example: a single RY gate on one qubit, with the Z observable as the cost. It is a small educational example, "
                    "VQE-style in shape only. It is not a chemistry calculation, it is not a scalable VQE, and it needs no hardware."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="The trial state moves with the angle",
                body=(
                    "RY turns the qubit's arrow about the y axis of the Bloch sphere, starting from the north pole, the state zero. A "
                    "small angle leaves the arrow near the north pole; a larger angle swings it through the equator towards the south "
                    "pole, the state one. Every angle prepares a different trial state. This is textbook reasoning about the gate; the "
                    "trace shows the arrow the backend actually produced."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="The cost is an expectation value",
                body=(
                    "The cost is the expectation value of the Z observable, written ⟨Z⟩. It is the average result of many measurements, "
                    "counting a zero as plus one and a one as minus one, so it is highest when the arrow points up, in the middle on the "
                    "equator and lowest when the arrow points down. This is textbook reasoning. In Qentor the server reads the number "
                    "from the state the backend produced; it is never worked out from the angle."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="A classical loop searches for the lowest cost",
                body=(
                    "The classical half is an ordinary loop. It asks the quantum side for the cost at the current angle, estimates which "
                    "way is downhill and nudges the angle that way. One way to estimate the slope needs only more cost values: run the "
                    "same circuit with the angle shifted a little each way and compare the two. This is textbook reasoning, the "
                    "parameter-shift rule for a gate like this one. The loop never sees the state, only cost values."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: what the classical loop changes",
                prompt="Think about what the loop is allowed to touch, and what it is told.",
                question="In this variational example, what does the classical loop change from one step to the next?",
                options=_opts(
                    a="The measurement outcomes, until the cost looks the way the loop wants it to",
                    b="The angle of the rotation gate, guided by cost values that the quantum side returned",
                    c="The state of the qubit itself, set directly without going through the circuit",
                    d="The observable that defines the cost, until the cost reaches the target value",
                ),
                correct_option_id="b",
                explanation=(
                    "The circuit has one adjustable angle, and that angle is all the classical loop changes. It chooses its next angle "
                    "from cost values the quantum side returned. It cannot edit measurement outcomes, set the state directly, or change "
                    "what the cost means: the observable is fixed in advance, which is what makes the cost a fair thing to lower."
                ),
                concept="variational-algorithms",
            ),
            InteractiveLabSection(
                id="s6",
                title="Lab: sweep the angle and run the loop",
                instructions=(
                    "Open the lab circuit: one RY gate on one qubit. Run it on the backend, then open the trace and look at the qubit's own "
                    "sphere. Then use the parameter sweep: the server runs the circuit at many angles and reads the expectation value of Z "
                    "from each state, which draws the cost curve. Pick a point on the curve to see the arrow for that angle, then run the "
                    "small optimisation. Every value on the curve and on the path is computed by the server from a backend run."
                ),
                capability="variational_sweep",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: reading the cost curve",
                prompt="Think about what the horizontal and the vertical axes show.",
                question="On the cost curve, what does the lowest point stand for?",
                options=_opts(
                    a="The angle at which the circuit stops being a valid quantum circuit and cannot be run",
                    b="The angle at which a measurement of the qubit is certain to read zero",
                    c="The angle whose trial state has the lowest cost, which is the angle the loop is searching for",
                    d="The angle at which the quantum side has done more work than at any other angle",
                ),
                correct_option_id="c",
                explanation=(
                    "The curve plots the cost for each angle, so its lowest point is the angle with the lowest cost. For this circuit "
                    "that is where the arrow points straight down and a measurement is certain to read one. A measurement certain to "
                    "read zero belongs to the highest point of the curve, and every angle is a valid circuit that does the same amount "
                    "of work."
                ),
                concept="variational-algorithms",
            ),
            ExplanationSection(
                id="s8",
                title="A downhill search can stall",
                body=(
                    "A downhill search only moves if it can tell which way is downhill. At the very top and the very bottom of this "
                    "curve the slope is flat, so the loop stays where it is. Start exactly at the top and the search never leaves it; "
                    "start anywhere else and it slides towards the bottom. This is textbook reasoning about this one curve, and a small "
                    "taste of why variational searches can get stuck."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="What this demonstration is and is not",
                body=(
                    "This example shows the shape of a variational algorithm: a parameterised circuit, a cost read from its state and a "
                    "classical loop. It is not a chemistry simulation, because no molecule is involved. It is not a scalable VQE: real "
                    "ones tune many angles on many qubits and face noise and a hard search. And it does not use hardware: every cost "
                    "here comes from a statevector simulator on the server."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "The loop changed only an angle and saw only cost values. Why is that enough to steer the qubit to the state it "
                    "wants? And what would you expect to be harder if the circuit had many angles instead of one?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["bloch-sphere", "superposition"],
    ),
]
