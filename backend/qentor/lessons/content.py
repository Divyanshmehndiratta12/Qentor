"""Raw lesson content for the Learn catalog.

The seven foundation lessons (Qubits & Measurement through Bell State) are full
mini-lessons and live in ``qentor.lessons.content_foundations``. The three
advanced lessons below are still concise metadata and section *skeletons*: they
validate the architecture end to end but are not yet finished educational copy.
Every ``linked_circuit`` is a single, fixed, hand-written circuit (plain data
through the existing canonical ``Circuit``/``GateOp`` model), never a new
algorithm or oracle-family generator.

This package is intentionally the only place lesson prose/circuits live: it has
no knowledge of FastAPI, the provenance store, or any UI. See
``qentor.lessons.registry`` for loading/validation and ``qentor.api.app`` for
the read-only route that serves this content.
"""

from __future__ import annotations

from qentor.circuit.model import Circuit, GateOp

from .content_foundations import FOUNDATION_LESSONS
from .models import (
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    Lesson,
    ReflectionSection,
)

_ADVANCED_LESSONS: list[Lesson] = [
    Lesson(
        id="phase-kickback",
        title="Phase Kickback",
        short_description="How a target qubit's phase can act back on a control qubit.",
        concept="phase-kickback",
        difficulty="advanced",
        estimated_minutes=18,
        learning_objectives=[
            "Trace how a CX gate can imprint a phase onto its control qubit.",
            "Explain why phase kickback underlies many oracle-based algorithms.",
        ],
        linked_circuit=Circuit(
            num_qubits=2,
            num_clbits=0,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="x", targets=[1]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="h", targets=[0]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Phase kickback",
                body="Preparing the target in an eigenstate of X lets CX kick a phase back onto the control.",
            ),
            ConceptCheckSection(
                id="s2", title="Check your understanding", prompt="Which qubit's amplitudes change: the control or the target?"
            ),
            InteractiveLabSection(
                id="s3",
                title="Run it",
                instructions="Execute the circuit in statevector mode and inspect the control qubit's amplitude.",
                capability="execute",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="Where else might this trick be useful?"),
        ],
        prerequisite_lesson_ids=["bell-state", "phase"],
    ),
    Lesson(
        id="deutsch-jozsa",
        title="Deutsch–Jozsa",
        short_description="Deciding constant vs. balanced with a single query, on one example oracle.",
        concept="oracle-algorithms",
        difficulty="advanced",
        estimated_minutes=20,
        learning_objectives=[
            "Describe the constant-vs-balanced promise the algorithm decides.",
            "Trace one balanced-oracle example through superposition, oracle and interference.",
        ],
        linked_circuit=Circuit(
            num_qubits=2,
            num_clbits=1,
            ops=[
                GateOp(gate="x", targets=[1]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="h", targets=[1]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Deutsch–Jozsa",
                body="One query distinguishes a constant function from a balanced one, using an ancilla and interference.",
            ),
            ConceptCheckSection(
                id="s2", title="Check your understanding", prompt="What measured outcome indicates a balanced oracle here?"
            ),
            InteractiveLabSection(
                id="s3",
                title="Run it",
                instructions="Execute this balanced-oracle example and check the input register's measured outcome.",
                capability="execute",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="How would a constant oracle change this circuit?"),
        ],
        prerequisite_lesson_ids=["phase-kickback"],
    ),
    Lesson(
        id="bernstein-vazirani",
        title="Bernstein–Vazirani",
        short_description="Recovering a hidden bitstring with a single query, on one example oracle.",
        concept="oracle-algorithms",
        difficulty="advanced",
        estimated_minutes=20,
        learning_objectives=[
            "Describe what the hidden bitstring oracle computes.",
            "Trace one example (secret string 10) through the algorithm.",
        ],
        linked_circuit=Circuit(
            num_qubits=3,
            num_clbits=2,
            ops=[
                GateOp(gate="x", targets=[2]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="h", targets=[1]),
                GateOp(gate="h", targets=[2]),
                GateOp(gate="cx", controls=[0], targets=[2]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="h", targets=[1]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="measure", targets=[1], clbits=[1]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Bernstein–Vazirani",
                body="A single query recovers a hidden bitstring encoded as CX gates from each '1' bit to the ancilla.",
            ),
            ConceptCheckSection(
                id="s2", title="Check your understanding", prompt="What measured bitstring should this example produce?"
            ),
            InteractiveLabSection(
                id="s3",
                title="Run it",
                instructions="Execute this secret-string-10 example and compare the measured bits to the encoded oracle.",
                capability="execute",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="How does the oracle's gate pattern encode the secret string?"),
        ],
        prerequisite_lesson_ids=["deutsch-jozsa"],
    ),
]

# Declaration order is the catalog order the API serves.
RAW_LESSONS: list[Lesson] = [*FOUNDATION_LESSONS, *_ADVANCED_LESSONS]
