"""Raw lesson content for the initial Learn catalog.

Per the current milestone's scope, this is concise structured metadata and
section *skeletons* only — enough to validate the architecture end to end,
not the finished educational copy. Every ``linked_circuit`` here is a single,
fixed, hand-written circuit (plain data through the existing canonical
``Circuit``/``GateOp`` model), never a new algorithm or oracle-family
generator — that stays out of scope for this milestone.

This module is intentionally the only place lesson prose/circuits live: it
has no knowledge of FastAPI, the provenance store, or any UI. See
``qentor.lessons.registry`` for loading/validation and ``qentor.api.app`` for
the read-only route that serves this content.
"""

from __future__ import annotations

from qentor.circuit.model import Circuit, GateOp

from .models import (
    ConceptCheckOption,
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    Lesson,
    ReflectionSection,
)

RAW_LESSONS: list[Lesson] = [
    Lesson(
        id="qubits-measurement",
        title="Qubits & Measurement",
        short_description="What a qubit is, and what happens when you measure one.",
        concept="qubits-measurement",
        difficulty="beginner",
        estimated_minutes=10,
        learning_objectives=[
            "Describe a qubit's state as a vector, not a classical bit.",
            "Explain that measurement collapses a qubit to a classical outcome.",
        ],
        linked_circuit=Circuit(
            num_qubits=1,
            num_clbits=1,
            ops=[GateOp(gate="x", targets=[0]), GateOp(gate="measure", targets=[0], clbits=[0])],
        ),
        sections=[
            ExplanationSection(id="s1", title="What is a qubit?", body="A qubit is a two-level quantum system."),
            ConceptCheckSection(
                id="s2",
                title="Check your understanding",
                prompt="What happens to a qubit's state when it is measured?",
                question="What happens to a qubit's superposition when you measure it?",
                options=[
                    ConceptCheckOption(id="a", text="It stays in superposition"),
                    ConceptCheckOption(id="b", text="It collapses to a single classical outcome"),
                    ConceptCheckOption(id="c", text="It doubles in amplitude"),
                    ConceptCheckOption(id="d", text="It becomes entangled with itself"),
                ],
                correct_option_id="b",
                explanation=(
                    "Measurement forces the qubit into one of its basis states with a probability "
                    "given by the Born rule; the superposition does not survive the measurement."
                ),
                concept="qubits-measurement",
            ),
            InteractiveLabSection(
                id="s3",
                title="Run it",
                instructions="Execute an X gate then measure. Compare the reported outcome to the |0> case.",
                capability="execute",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="Why is a measured outcome always classical?"),
        ],
        prerequisite_lesson_ids=[],
    ),
    Lesson(
        id="bloch-sphere",
        title="Bloch Sphere",
        short_description="A geometric picture of a single qubit's state.",
        concept="bloch-sphere",
        difficulty="beginner",
        estimated_minutes=12,
        learning_objectives=[
            "Locate |0> and |1> on the Bloch sphere.",
            "Relate a rotation gate to a rotation of the Bloch vector.",
        ],
        sections=[
            ExplanationSection(
                id="s1", title="The Bloch sphere", body="Any single-qubit pure state is a point on a unit sphere."
            ),
            ConceptCheckSection(
                id="s2",
                title="Check your understanding",
                prompt="Where on the sphere do |0> and |1> sit?",
                question="Where does the state |1> sit on the Bloch sphere?",
                options=[
                    ConceptCheckOption(id="a", text="At the north pole"),
                    ConceptCheckOption(id="b", text="At the south pole"),
                    ConceptCheckOption(id="c", text="On the equator"),
                    ConceptCheckOption(id="d", text="At the center"),
                ],
                correct_option_id="b",
                explanation="By convention |0> is the north pole and |1> is the south pole of the Bloch sphere.",
                concept="bloch-sphere",
            ),
            ReflectionSection(id="s3", title="Reflect", prompt="Why can't two qubits be pictured on one sphere?"),
        ],
        prerequisite_lesson_ids=["qubits-measurement"],
    ),
    Lesson(
        id="superposition",
        title="Superposition",
        short_description="A qubit can be in more than one basis state at once.",
        concept="superposition",
        difficulty="beginner",
        estimated_minutes=12,
        learning_objectives=[
            "Explain what the Hadamard gate does to |0>.",
            "Predict the measurement distribution of a superposed qubit.",
        ],
        linked_circuit=Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0])]),
        sections=[
            ExplanationSection(
                id="s1", title="Superposition", body="The Hadamard gate puts a qubit into an equal superposition."
            ),
            ConceptCheckSection(
                id="s2",
                title="Check your understanding",
                prompt="What outcomes are possible after measuring H|0>?",
                question="What does applying a Hadamard gate to |0> produce?",
                options=[
                    ConceptCheckOption(id="a", text="|0>, unchanged"),
                    ConceptCheckOption(id="b", text="|1>, unchanged"),
                    ConceptCheckOption(id="c", text="An equal superposition of |0> and |1>"),
                    ConceptCheckOption(id="d", text="A mixed classical state"),
                ],
                correct_option_id="c",
                explanation="H|0> = (|0> + |1>)/√2: measuring it gives 0 or 1 with equal probability.",
                concept="superposition",
            ),
            InteractiveLabSection(
                id="s3",
                title="Run it",
                instructions="Execute H on a single qubit in statevector mode and inspect the amplitudes.",
                capability="execute",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="Is superposition the same as classical uncertainty?"),
        ],
        prerequisite_lesson_ids=["qubits-measurement"],
    ),
    Lesson(
        id="phase",
        title="Phase",
        short_description="The part of a qubit's state that measurement alone can't see.",
        concept="phase",
        difficulty="beginner",
        estimated_minutes=12,
        learning_objectives=[
            "Distinguish a relative phase from a global phase.",
            "Identify that a Z gate changes phase without changing measurement probabilities.",
        ],
        linked_circuit=Circuit(
            num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="z", targets=[0])]
        ),
        sections=[
            ExplanationSection(id="s1", title="Phase", body="A Z gate flips the sign of the |1> amplitude."),
            ConceptCheckSection(
                id="s2",
                title="Check your understanding",
                prompt="Does Z change the measurement probabilities of H|0>?",
                question="Does applying a Z gate to H|0> change the measurement probabilities?",
                options=[
                    ConceptCheckOption(id="a", text="Yes, it flips the probabilities"),
                    ConceptCheckOption(id="b", text="No, only the relative phase changes"),
                    ConceptCheckOption(id="c", text="Yes, it collapses the state"),
                    ConceptCheckOption(id="d", text="No, Z does nothing to any state"),
                ],
                correct_option_id="b",
                explanation=(
                    "Z flips the sign of the |1> amplitude, but the probabilities (|amplitude|²) "
                    "are unchanged — the effect is invisible to a direct measurement in this basis."
                ),
                concept="phase",
            ),
            InteractiveLabSection(
                id="s3",
                title="Run it",
                instructions="Execute H then Z in statevector mode and compare the amplitudes to plain H.",
                capability="execute",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="Why is phase still physically meaningful?"),
        ],
        prerequisite_lesson_ids=["superposition"],
    ),
    Lesson(
        id="interference",
        title="Interference",
        short_description="How phase differences combine to change measurement outcomes.",
        concept="interference",
        difficulty="intermediate",
        estimated_minutes=15,
        learning_objectives=[
            "Predict the result of H, Z, H applied in sequence.",
            "Explain interference as amplitudes adding constructively or destructively.",
        ],
        linked_circuit=Circuit(
            num_qubits=1,
            num_clbits=1,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="z", targets=[0]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1", title="Interference", body="Recombining a superposition can concentrate probability onto one outcome."
            ),
            ConceptCheckSection(
                id="s2",
                title="Check your understanding",
                prompt="What outcome should H, Z, H produce, and why?",
                question="What is the measured outcome of H, Z, H applied to |0>, and why?",
                options=[
                    ConceptCheckOption(id="a", text="Always 0, from constructive interference"),
                    ConceptCheckOption(id="b", text="Always 1, from destructive interference on outcome 0"),
                    ConceptCheckOption(id="c", text="50/50 — no interference occurs"),
                    ConceptCheckOption(id="d", text="Always 0 — Z has no effect here"),
                ],
                correct_option_id="b",
                explanation=(
                    "H, Z, H equals the X gate up to global phase, which maps |0> to |1> "
                    "deterministically — the amplitude for outcome 0 cancels out."
                ),
                concept="interference",
            ),
            InteractiveLabSection(
                id="s3",
                title="Run it",
                instructions="Execute H, Z, H with measurement and check the outcome is deterministic.",
                capability="execute",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="Where did the 'other' outcome go?"),
        ],
        prerequisite_lesson_ids=["phase"],
    ),
    Lesson(
        id="entanglement",
        title="Entanglement",
        short_description="A joint state of two qubits that can't be described separately.",
        concept="entanglement",
        difficulty="intermediate",
        estimated_minutes=15,
        learning_objectives=[
            "Explain why an entangled pair's qubits can't each be assigned their own state.",
            "Identify H followed by CX as a standard way to create entanglement.",
        ],
        linked_circuit=Circuit(
            num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])]
        ),
        sections=[
            ExplanationSection(
                id="s1", title="Entanglement", body="H then CX correlates two qubits into a single joint state."
            ),
            ConceptCheckSection(
                id="s2",
                title="Check your understanding",
                prompt="Can either qubit's state be described alone here?",
                question="After H then CX on two qubits starting at |00>, can qubit 0's state be described on its own?",
                options=[
                    ConceptCheckOption(id="a", text="Yes, it's still in superposition alone"),
                    ConceptCheckOption(id="b", text="No, the two qubits share one joint state"),
                    ConceptCheckOption(id="c", text="Yes, it collapses to |0>"),
                    ConceptCheckOption(id="d", text="No, because CX destroys qubit 0"),
                ],
                correct_option_id="b",
                explanation=(
                    "The resulting Bell state (|00> + |11>)/√2 cannot be factored into a state for "
                    "qubit 0 times a state for qubit 1 — that is what makes it entangled."
                ),
                concept="entanglement",
            ),
            InteractiveLabSection(
                id="s3",
                title="Run it",
                instructions="Execute H then CX in statevector mode and inspect the resulting amplitudes.",
                capability="execute",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="How is this different from two independent coin flips?"),
        ],
        prerequisite_lesson_ids=["superposition"],
    ),
    Lesson(
        id="bell-state",
        title="Bell State",
        short_description="The simplest maximally entangled two-qubit state, and how it's verified.",
        concept="bell-state",
        difficulty="intermediate",
        estimated_minutes=15,
        learning_objectives=[
            "Build the standard Bell-state circuit (H, CX).",
            "Describe what a Bell-state verifier actually checks.",
        ],
        linked_circuit=Circuit(
            num_qubits=2,
            num_clbits=2,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="measure", targets=[1], clbits=[1]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1", title="The Bell state", body="H then CX on two qubits produces a Bell state: only 00 and 11 occur."
            ),
            ConceptCheckSection(
                id="s2",
                title="Check your understanding",
                prompt="Which two outcomes should a Bell-state measurement ever show?",
                question="Which two outcomes should a correctly prepared Bell-state measurement show?",
                options=[
                    ConceptCheckOption(id="a", text="00 and 01"),
                    ConceptCheckOption(id="b", text="00 and 11"),
                    ConceptCheckOption(id="c", text="01 and 10"),
                    ConceptCheckOption(id="d", text="Any of the four, with equal probability"),
                ],
                correct_option_id="b",
                explanation=(
                    "The Bell state (|00> + |11>)/√2 only has support on 00 and 11 — "
                    "01 and 10 should never be observed."
                ),
                concept="bell-state",
            ),
            InteractiveLabSection(
                id="s3",
                title="Verify it",
                instructions="Execute the circuit, then verify the result against the Bell-state pattern.",
                capability="verify_bell_state",
            ),
            ReflectionSection(id="s4", title="Reflect", prompt="What would a verifier report if 01 appeared?"),
        ],
        prerequisite_lesson_ids=["entanglement"],
    ),
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
