"""The fifteen challenges. Data only: every verdict is computed by ``qentor.challenges.evaluate`` from backend statevectors.

Hints are written to be deterministic and safe to show: they name gates and ideas, never a quantum result the learner has
not produced (no probabilities or amplitudes appear here).

The two oracle challenges use ONE fixed oracle each, chosen here. Nothing generates or synthesises an oracle.

* Deutsch-Jozsa (fixed): 2 input qubits q[0], q[1] and an ancilla q[2]; the oracle is ``cx q0→q2; cx q1→q2``
  (f(x) = x0 ⊕ x1, balanced).
* Bernstein-Vazirani (fixed): 3 input qubits and an ancilla q[3]; the oracle is ``cx q1→q3; cx q2→q3`` (hidden string
  q[2]q[1]q[0] = 110).

Three more challenges lock a fixed part the same way (``Constraints.anchor``, named by ``anchor_name``):

* Superdense coding: the decoder ``cx q0→q1; h q0``, and Alice's X/Z may touch only her qubit q[0].
* Teleportation (deferred corrections, because the circuit model has no mid-circuit measurement or classical control): the
  corrections ``cx q1→q2; cz q0→q2``. The message state is ``ry(1.0)`` on q[0]; the learner builds everything before them.
* Grover (2 qubits, one marked item |01⟩): the oracle ``x q1; cz q0,q1; x q1``. It also checks the learner's circuit again with an
  oracle that marks |10⟩ instead (``replace_anchor``), so a circuit that hard-codes |01⟩ does not pass.

One more challenge is about shortening, not about a state: ``optimize-redundant`` starts from a circuit with redundant gates and asks
for one of at most three operations that does the same thing. "The same thing" is the platform's operator-equivalence check
(``EquivalentTo``), so deleting a gate that was doing something does not pass, and the verdict is the backend's.

Every challenge builds its circuit by appending gates (the Lab canvas appends), so the fixed oracle is something the
learner places, exactly as given, and the evaluator checks it is there once, unchanged and in order.
"""

from __future__ import annotations

from qentor.circuit.model import Circuit, GateName, GateOp

from .models import (
    Challenge,
    Constraints,
    EndsInBasisState,
    EquivalentTo,
    PassesThroughSuperposition,
    Point,
    ProbabilitiesMatch,
    QubitStateMatches,
    StateDiffers,
    StateMatches,
)

ONE_QUBIT = [GateName.H, GateName.X, GateName.Y, GateName.Z, GateName.S, GateName.SDG, GateName.T, GateName.TDG]


def g(gate: str, target: int, control: int | None = None, angle: float | None = None) -> GateOp:
    return GateOp(
        gate=GateName(gate),
        targets=[target],
        controls=[] if control is None else [control],
        params=[] if angle is None else [angle],
        clbits=[],
    )


def m(qubit: int, clbit: int) -> GateOp:
    return GateOp(gate=GateName.MEASURE, targets=[qubit], controls=[], params=[], clbits=[clbit])


def circ(num_qubits: int, ops: list[GateOp], num_clbits: int = 0) -> Circuit:
    return Circuit(num_qubits=num_qubits, num_clbits=num_clbits, ops=ops)


# Teleportation sends the state ry(1.0)|0⟩: a fixed message, so every check below is about one known state.
_MESSAGE_ANGLE = 1.0

_BELL = [g("h", 0), g("cx", 1, 0)]
_SD_DECODER = [g("cx", 1, 0), g("h", 0)]
_TP_PREPARE = [g("ry", 0, angle=_MESSAGE_ANGLE), g("h", 1), g("cx", 2, 1), g("cx", 1, 0), g("h", 0)]
_TP_CORRECTIONS = [g("cx", 2, 1), g("cz", 2, 0)]
_GROVER_ORACLE_01 = [g("x", 1), g("cz", 1, 0), g("x", 1)]
_GROVER_ORACLE_10 = [g("x", 0), g("cz", 1, 0), g("x", 0)]
_GROVER_DIFFUSION = [
    g("h", 0), g("h", 1), g("x", 0), g("x", 1), g("cz", 1, 0), g("x", 0), g("x", 1), g("h", 0), g("h", 1),
]
# The redundant circuit of the optimisation challenge: three H on q0 (one H), an X pair and an S/S-dagger pair on q1 (nothing), two RZ
# rotations on q1 (one RZ with the summed angle: both angles are exact in binary, so their sum is exact too).
_OPT_STARTER = [
    g("h", 0), g("h", 0), g("h", 0),
    g("x", 1), g("x", 1),
    g("cx", 1, 0),
    g("s", 1), g("sdg", 1),
    g("rz", 1, angle=0.5), g("rz", 1, angle=0.25),
]
_DJ_ORACLE = [g("cx", 2, 0), g("cx", 2, 1)]
_BV_ORACLE = [g("cx", 3, 1), g("cx", 3, 2)]

RAW_CHALLENGES: list[Challenge] = [
    Challenge(
        id="create-one",
        lesson_id="qubits-measurement",
        title="Create |1⟩",
        goal="Start from a qubit in |0⟩ and put it in the state |1⟩.",
        difficulty="beginner",
        success_condition="The qubit's final state is |1⟩.",
        constraints=Constraints(num_qubits=1, allowed_gates=ONE_QUBIT, max_ops=6),
        starter_circuit=circ(1, []),
        checks=[StateMatches(id="state.is_one", label="The final state is |1⟩", hint_index=1, misconception='The qubit starts in |0⟩ and a gate has to move it; a gate that only adds a phase, or that creates a superposition, does not leave it in |1⟩.', experiment='Add your circuit, open the trace and look at the state after each gate: which gate makes |1⟩ the only outcome?', target=circ(1, [g("x", 0)]))],
        hints=[
            "Every qubit starts in |0⟩. You need a gate that swaps the roles of |0⟩ and |1⟩.",
            "The X gate flips |0⟩ to |1⟩ and |1⟩ to |0⟩.",
            "Place a single X on the qubit, then run the circuit and look at the trace.",
        ],
        success_message="X flips |0⟩ to |1⟩ - the quantum NOT.",
        reference_solution=circ(1, [g("x", 0)]),
    ),
    Challenge(
        id="create-plus",
        lesson_id="superposition",
        title="Create |+⟩",
        goal="Put a qubit that starts in |0⟩ into the equal superposition |+⟩ = (|0⟩ + |1⟩)/√2.",
        difficulty="beginner",
        success_condition="The qubit's final state is |+⟩.",
        constraints=Constraints(num_qubits=1, allowed_gates=ONE_QUBIT, max_ops=6),
        starter_circuit=circ(1, []),
        checks=[StateMatches(id="state.is_plus", label="The final state is |+⟩", hint_index=1, misconception='|+⟩ is an equal superposition with both parts positive. A gate that flips the qubit (X) gives a definite state, and one that changes only the sign gives |−⟩.', experiment='Run the trace after your first gate and compare the two outcomes: are they equally likely, and do they have the same sign?', target=circ(1, [g("h", 0)]))],
        hints=[
            "You need a gate that turns a definite state into an equal mix of |0⟩ and |1⟩.",
            "The Hadamard gate (H) does that from |0⟩.",
            "Place one H on the qubit and run it: the trace shows the state after the gate.",
        ],
        success_message="H turns |0⟩ into |+⟩, an equal superposition.",
        reference_solution=circ(1, [g("h", 0)]),
    ),
    Challenge(
        id="create-minus",
        lesson_id="phase",
        title="Create |−⟩",
        goal="Prepare the state |−⟩ = (|0⟩ − |1⟩)/√2 from |0⟩. It looks like |+⟩ when measured, but its phase differs.",
        difficulty="beginner",
        success_condition="The qubit's final state is |−⟩.",
        constraints=Constraints(num_qubits=1, allowed_gates=ONE_QUBIT, max_ops=6),
        starter_circuit=circ(1, []),
        checks=[StateMatches(id="state.is_minus", label="The final state is |−⟩", hint_index=1, misconception='|−⟩ has the same measurement odds as |+⟩ but the |1⟩ part has the opposite sign, so the difference is in the phase, which a measurement alone cannot show.', experiment='Build |+⟩ first, then find the one extra gate that changes only the sign, and compare both states in the trace.', target=circ(1, [g("x", 0), g("h", 0)]))],
        hints=[
            "|−⟩ is like |+⟩ but with a minus sign between the two parts. Which gate changes a sign?",
            "H makes the superposition; something must flip the sign of the |1⟩ part. Try flipping to |1⟩ first.",
            "X then H: H applied to |1⟩ gives |−⟩. (H then Z reaches it too.)",
        ],
        success_message="H on |1⟩ gives |−⟩ - the same measurement odds as |+⟩ with the opposite phase.",
        reference_solution=circ(1, [g("x", 0), g("h", 0)]),
    ),
    Challenge(
        id="create-bell",
        lesson_id="bell-state",
        title="Create a Bell state",
        goal="Entangle two qubits into the Bell state (|00⟩ + |11⟩)/√2.",
        difficulty="intermediate",
        success_condition="The two-qubit final state is the Bell state (|00⟩ + |11⟩)/√2.",
        constraints=Constraints(num_qubits=2, allowed_gates=[*ONE_QUBIT, GateName.CX], max_ops=8),
        starter_circuit=circ(2, []),
        checks=[
            StateMatches(
                id="state.is_bell",
                label="The final state is (|00⟩ + |11⟩)/√2",
                hint_index=1, misconception='A Bell state needs entanglement: a superposition on one qubit, then a two-qubit gate that ties the other qubit to it. Two independent superpositions are not entangled.', experiment='Run the trace and check the state after each gate: after the first, is q[1] still in |0⟩? After the CX, are only the correlated outcomes left?',
                target=circ(2, [g("h", 0), g("cx", 1, 0)]),
            )
        ],
        hints=[
            "Entanglement needs a superposition first, then a gate that ties the second qubit to the first.",
            "Put q[0] in superposition with H, then use it as the control of a CX whose target is q[1].",
            "H on q[0], then CX with control q[0] and target q[1].",
        ],
        success_message="H then CX is the standard recipe for a Bell state.",
        reference_solution=circ(2, [g("h", 0), g("cx", 1, 0)]),
    ),
    Challenge(
        id="phase-change",
        lesson_id="phase",
        title="Change the phase",
        goal=(
            "Make a qubit whose measurement odds are exactly those of |+⟩, yet whose state is not |+⟩: "
            "a change measurement alone cannot see."
        ),
        difficulty="beginner",
        success_condition="Measuring gives the same outcomes as |+⟩, but the state is a different state.",
        constraints=Constraints(num_qubits=1, allowed_gates=ONE_QUBIT, max_ops=6),
        starter_circuit=circ(1, []),
        checks=[
            ProbabilitiesMatch(
                id="odds.match_plus",
                label="Measurement odds match |+⟩",
                hint_index=1, misconception='The measurement odds must be those of |+⟩, so the qubit must first be put into an equal superposition; a phase gate on |0⟩ changes nothing.', experiment='Apply H first, then check in the Results panel that both outcomes are equally likely.',
                target=circ(1, [g("h", 0)]),
            ),
            StateDiffers(id="state.not_plus", label="But the state is not |+⟩", hint_index=2, misconception='A phase change is invisible to measurement: the odds stay equal but the state must differ from |+⟩. If the state is still |+⟩, no phase was added.', experiment='After H, add one gate that changes the sign or phase of the |1⟩ part, then compare the state in the trace with |+⟩.', other=circ(1, [g("h", 0)])),
        ],
        hints=[
            "Start by making the equal superposition, so both outcomes are equally likely.",
            "After H the odds match |+⟩. Now change something that measurement does not see.",
            "A Z (or S, or T) after H changes the relative phase without changing the odds.",
        ],
        success_message="A phase change is invisible to a direct measurement but changes the state - and later interference.",
        reference_solution=circ(1, [g("h", 0), g("z", 0)]),
    ),
    Challenge(
        id="interference",
        lesson_id="interference",
        title="Interfere to a certain outcome",
        goal=(
            "Put a qubit into a superposition, then bring it back so a measurement gives one outcome for certain: "
            "the two paths interfere."
        ),
        difficulty="intermediate",
        success_condition="The circuit passes through a superposition and ends in one definite basis state, using at least two H gates.",
        constraints=Constraints(num_qubits=1, allowed_gates=ONE_QUBIT, max_ops=6, min_gate_counts={GateName.H: 2}),
        starter_circuit=circ(1, []),
        checks=[
            PassesThroughSuperposition(id="mid.superposition", label="Passes through a superposition", hint_index=1, misconception='Interference needs a real superposition first. If the qubit is in a definite state after every step, there is nothing to interfere.', experiment='Open the trace and look at the state after each gate: at which step are both outcomes possible?'),
            EndsInBasisState(id="end.definite", label="Ends in one definite outcome", hint_index=2, misconception='The paths must recombine so that they cancel for one outcome. A second H does that only if nothing in between changed the phase in a way that leaves the qubit in a superposition.', experiment='Add a second H and look at the last trace step: is one outcome now certain? Try putting Z between the two H gates and compare.'),
        ],
        hints=[
            "Interference needs two steps that can cancel or reinforce each other.",
            "The first H creates a superposition; a second H makes the two parts recombine.",
            "H, H returns to |0⟩. Put a Z between them (H, Z, H) and see which outcome you get instead.",
        ],
        success_message="Amplitudes add: the second H makes the paths cancel for one outcome and reinforce the other.",
        reference_solution=circ(1, [g("h", 0), g("h", 0)]),
    ),
    Challenge(
        id="phase-kickback",
        lesson_id="phase-kickback",
        title="Phase kickback",
        goal=(
            "Use kickback to flip the control qubit: prepare q[0] in |+⟩ and q[1] in |−⟩, apply CX (control q[0], target q[1]), "
            "then rotate q[0] back so it ends in |1⟩ while q[1] stays in |−⟩."
        ),
        difficulty="advanced",
        success_condition="Just before the CX, q[0] is |+⟩ and q[1] is |−⟩; at the end, q[0] is |1⟩ and q[1] is |−⟩.",
        constraints=Constraints(
            num_qubits=2,
            allowed_gates=[GateName.H, GateName.X, GateName.Z, GateName.CX],
            max_ops=8,
            anchor=[g("cx", 1, 0)],
        ),
        starter_circuit=circ(2, []),
        checks=[
            StateMatches(
                id="before.eigenstate",
                label="Before the CX: q[0] is |+⟩ and q[1] is |−⟩",
                at=Point.BEFORE_ANCHOR,
                hint_index=1, misconception='Kickback needs q[1] in |−⟩ (an eigenstate of X) and q[0] in a superposition |+⟩ before the CX. If either is missing, the CX has nothing to kick back.', experiment='Run the trace and check the state just before the CX: prepare q[0] with H, and q[1] with X then H.',
                target=circ(2, [g("h", 0), g("x", 1), g("h", 1)]),
            ),
            StateMatches(
                id="final.kicked_back",
                label="At the end: q[0] is |1⟩ and q[1] is |−⟩",
                hint_index=2, misconception='After the CX the phase is on q[0], but a phase cannot be read directly: one more H on q[0] turns it into a definite outcome.', experiment='Add H on q[0] after the CX and check the last trace step: is q[0] now definite?',
                target=circ(2, [g("h", 0), g("x", 1), g("h", 1), g("cx", 1, 0), g("h", 0)]),
            ),
        ],
        hints=[
            "Kickback needs the target in an eigenstate of X: |−⟩. The control must be in superposition.",
            "Put q[0] in |+⟩ with H, and q[1] in |−⟩ with X then H, before the CX.",
            "After the CX, q[0] has picked up a phase. An H on q[0] turns that phase into a definite |1⟩.",
        ],
        success_message="The target's eigenvalue was kicked back onto the control as a phase - visible after one more H.",
        reference_solution=circ(2, [g("h", 0), g("x", 1), g("h", 1), g("cx", 1, 0), g("h", 0)]),
    ),
    Challenge(
        id="deutsch-jozsa-fixed",
        lesson_id="deutsch-jozsa",
        title="Deutsch–Jozsa (fixed example)",
        goal=(
            "One fixed oracle: f(x) = x₀ ⊕ x₁ on inputs q[0], q[1], with ancilla q[2]. The oracle is exactly these two gates, in "
            "this order, back to back: CX q[0]→q[2], then CX q[1]→q[2]. Build the whole algorithm around it and measure the "
            "input qubits: the result must not be 00, because f is balanced."
        ),
        difficulty="advanced",
        fixed_oracle=True,
        success_condition="The fixed oracle is present once; before it the inputs are in |+⟩ and the ancilla in |−⟩; measuring the inputs gives the balanced answer.",
        constraints=Constraints(
            num_qubits=3,
            num_clbits=3,
            allowed_gates=[GateName.H, GateName.X, GateName.Z, GateName.CX, GateName.MEASURE],
            max_ops=16,
            anchor=_DJ_ORACLE,
            must_measure=[0, 1],
        ),
        starter_circuit=circ(3, [], 3),
        checks=[
            StateMatches(
                id="before.superposed_inputs",
                label="Before the oracle: inputs in |+⟩, ancilla in |−⟩",
                at=Point.BEFORE_ANCHOR,
                hint_index=1, misconception="The algorithm needs every input qubit in |+⟩ and the ancilla in |−⟩ before the oracle is called; otherwise the oracle's phase kickback cannot happen.", experiment='Run the trace and look at the state just before the oracle: which qubits are not yet in superposition, and is the ancilla in |−⟩ (X then H)?',
                target=circ(3, [g("h", 0), g("h", 1), g("x", 2), g("h", 2)], 3),
            ),
            ProbabilitiesMatch(
                id="final.balanced_answer",
                label="Measuring the inputs gives the balanced-oracle answer",
                hint_index=2, misconception='After the oracle the answer is stored in the phases of the input qubits. It only becomes visible after a second layer of H gates on the input qubits.', experiment='Add H on each input qubit after the oracle and compare the last trace step: which inputs now have a definite outcome?',
                qubits=[0, 1],
                target=circ(
                    3,
                    [g("x", 2), g("h", 0), g("h", 1), g("h", 2), *_DJ_ORACLE, g("h", 0), g("h", 1)],
                    3,
                ),
            ),
        ],
        hints=[
            "The algorithm is: prepare, ask the oracle once, undo the preparation on the inputs, measure the inputs.",
            "Before the oracle: H on both inputs, and put the ancilla q[2] in |−⟩ (X then H).",
            "After the oracle, apply H to each input qubit again, then measure q[0] and q[1] at the end.",
        ],
        success_message="One oracle call decided constant-vs-balanced: any answer other than 00 means balanced.",
        reference_solution=circ(
            3,
            [
                g("x", 2), g("h", 0), g("h", 1), g("h", 2),
                *_DJ_ORACLE,
                g("h", 0), g("h", 1),
                m(0, 0), m(1, 1),
            ],
            3,
        ),
    ),
    Challenge(
        id="bernstein-vazirani-fixed",
        lesson_id="bernstein-vazirani",
        title="Bernstein–Vazirani (fixed example)",
        goal=(
            "One fixed oracle hides a string. It is exactly these two gates, in this order, back to back: CX q[1]→q[3], then "
            "CX q[2]→q[3] (inputs q[0], q[1], q[2]; ancilla q[3]). Build the algorithm around it and measure the inputs: "
            "one oracle call reveals the hidden string."
        ),
        difficulty="advanced",
        fixed_oracle=True,
        success_condition="The fixed oracle is present once; before it the inputs are in |+⟩ and the ancilla in |−⟩; measuring the inputs reads out the hidden string.",
        constraints=Constraints(
            num_qubits=4,
            num_clbits=4,
            allowed_gates=[GateName.H, GateName.X, GateName.Z, GateName.CX, GateName.MEASURE],
            max_ops=20,
            anchor=_BV_ORACLE,
            must_measure=[0, 1, 2],
        ),
        starter_circuit=circ(4, [], 4),
        checks=[
            StateMatches(
                id="before.superposed_inputs",
                label="Before the oracle: inputs in |+⟩, ancilla in |−⟩",
                at=Point.BEFORE_ANCHOR,
                hint_index=1, misconception="The algorithm needs every input qubit in |+⟩ and the ancilla in |−⟩ before the oracle is called; otherwise the oracle's phase kickback cannot happen.", experiment='Run the trace and look at the state just before the oracle: which qubits are not yet in superposition, and is the ancilla in |−⟩ (X then H)?',
                target=circ(4, [g("h", 0), g("h", 1), g("h", 2), g("x", 3), g("h", 3)], 4),
            ),
            ProbabilitiesMatch(
                id="final.hidden_string",
                label="Measuring the inputs reads out the hidden string",
                hint_index=2, misconception='The hidden string is stored in the phases of the input qubits after the oracle call. It appears as measurement outcomes only after H is applied to every input qubit again.', experiment="Add H on every input qubit after the oracle, measure them, and compare the outcomes with the oracle's CX gates: which inputs does it touch?",
                qubits=[0, 1, 2],
                target=circ(
                    4,
                    [g("x", 3), g("h", 0), g("h", 1), g("h", 2), g("h", 3), *_BV_ORACLE, g("h", 0), g("h", 1), g("h", 2)],
                    4,
                ),
            ),
        ],
        hints=[
            "Same shape as Deutsch-Jozsa: prepare, one oracle call, undo the preparation on the inputs, measure the inputs.",
            "Before the oracle: H on all three inputs, and put the ancilla q[3] in |−⟩ (X then H).",
            "After the oracle, apply H to q[0], q[1] and q[2], then measure those three qubits at the end.",
        ],
        success_message="Phase kickback from the oracle encodes the hidden string in the inputs; the final H layer reads it out.",
        reference_solution=circ(
            4,
            [
                g("x", 3), g("h", 0), g("h", 1), g("h", 2), g("h", 3),
                *_BV_ORACLE,
                g("h", 0), g("h", 1), g("h", 2),
                m(0, 0), m(1, 1), m(2, 2),
            ],
            4,
        ),
    ),

    Challenge(
        id="bloch-plus-direction",
        lesson_id="bloch-sphere",
        title="Create |+⟩ and verify its Bloch direction",
        goal=(
            "A qubit starts at the north pole of the Bloch sphere, |0⟩. Move it so that its Bloch vector points along +x: the state "
            "|+⟩. Then open the trace and read the vector the backend computed, to confirm the direction."
        ),
        difficulty="beginner",
        success_condition="The qubit's Bloch vector, computed by the backend from the final state, points along +x (the state |+⟩).",
        constraints=Constraints(num_qubits=1, allowed_gates=ONE_QUBIT, max_ops=6),
        starter_circuit=circ(1, []),
        checks=[
            ProbabilitiesMatch(
                id="odds.equator",
                label="Measuring gives |0⟩ and |1⟩ equally often (the vector lies on the equator)",
                hint_index=1,
                misconception="A vector on the equator is an equal superposition. A vector at a pole is a definite state, and a gate that only turns the vector around the vertical axis cannot leave a pole.",
                experiment="Open the trace after your gate and look at the arrow: is it still at a pole, or has it left it?",
                target=circ(1, [g("h", 0)]),
            ),
            QubitStateMatches(
                id="bloch.points_plus_x",
                label="The Bloch vector points along +x",
                hint_index=2,
                misconception="The equator has many directions. +x is the one |+⟩ points to; the opposite direction is |−⟩ and the two directions at right angles are the Y states.",
                experiment="Compare the arrow in the trace with the x axis. If it points along -x or ±y, a phase gate was applied: find which gate turned it.",
                qubit=0,
                target=circ(1, [g("h", 0)]),
            ),
        ],
        hints=[
            "On the Bloch sphere |0⟩ is the north pole and |1⟩ the south pole. |+⟩ lies on the equator.",
            "You need a gate that moves the arrow from the pole to the equator.",
            "H takes |0⟩ to the +x direction. Place it, run the circuit, and read the arrow in the trace.",
        ],
        success_message="H turns the vector from the north pole to +x: |+⟩, an equal superposition with both parts positive.",
        reference_solution=circ(1, [g("h", 0)]),
    ),
    Challenge(
        id="entangle-bell-pair",
        lesson_id="entanglement",
        title="Create a Bell state and show it is entangled",
        goal=(
            "Entangle two qubits into the Bell state (|00⟩ + |11⟩)/√2. Then check, in the trace, what entanglement looks like from "
            "each qubit's own point of view: neither qubit alone has a definite state."
        ),
        difficulty="intermediate",
        success_condition="The final state is (|00⟩ + |11⟩)/√2, and each qubit on its own is in a maximally mixed state: entangled with the other.",
        constraints=Constraints(num_qubits=2, allowed_gates=[*ONE_QUBIT, GateName.CX], max_ops=8),
        starter_circuit=circ(2, []),
        checks=[
            ProbabilitiesMatch(
                id="odds.correlated",
                label="Measuring both qubits gives only 00 or 11, equally often",
                hint_index=1,
                misconception="Entangled qubits give correlated results. Two qubits that were each put into superposition separately give all four combinations.",
                experiment="Run the trace and compare the outcomes after your last gate: which combinations of the two qubits can occur?",
                target=circ(2, _BELL),
            ),
            QubitStateMatches(
                id="q0.mixed",
                label="q[0] on its own has no definite state (entangled with q[1])",
                hint_index=1,
                misconception="An entangled qubit has no pure state of its own. If q[0] still has a definite Bloch direction, it is not entangled with the other qubit.",
                experiment="Open the per-qubit spheres at the last step: a qubit entangled with the rest has a vector of length zero.",
                qubit=0,
                target=circ(2, _BELL),
            ),
            QubitStateMatches(
                id="q1.mixed",
                label="q[1] on its own has no definite state (entangled with q[0])",
                hint_index=1,
                misconception="Entanglement is shared: if q[0] is tied to q[1], q[1] is just as undetermined. A CX with q[1] as its target ties the two together.",
                experiment="Check the per-qubit sphere of q[1] after the CX: is it still pointing at a pole?",
                qubit=1,
                target=circ(2, _BELL),
            ),
            StateMatches(
                id="state.is_bell",
                label="The final state is (|00⟩ + |11⟩)/√2",
                hint_index=2,
                misconception="Several states give correlated outcomes; this one has both parts with the same sign. Changing a sign gives a different Bell state with the same measurement odds.",
                experiment="Look at the phase arrows in the amplitude view: the |00⟩ and |11⟩ rows should point the same way.",
                target=circ(2, _BELL),
            ),
        ],
        hints=[
            "Entanglement needs a superposition first, then a gate that ties the second qubit to the first.",
            "Put q[0] in superposition with H, then use it as the control of a CX whose target is q[1].",
            "H on q[0], then CX with control q[0] and target q[1]. Then open the per-qubit spheres at the last step.",
        ],
        success_message="Each qubit alone is undetermined, yet together they are in one definite state: that is entanglement.",
        reference_solution=circ(2, _BELL),
    ),
    Challenge(
        id="superdense-encode-10",
        lesson_id="superdense-coding",
        title="Encode message 10",
        goal=(
            "Alice holds q[0] and Bob holds q[1] of a shared Bell pair. Alice sends the two-bit message 10 by acting on her qubit "
            "q[0] only; Bob then decodes with exactly the gates given below and measures both qubits. The message is read "
            "as q[1] q[0]: build the pair, choose Alice's encoding, add the decoder and measure."
        ),
        difficulty="intermediate",
        success_condition="Before decoding, the pair carries message 10 (Alice acted only on q[0]); after the fixed decoder, measuring q[1] q[0] gives 10 every time.",
        constraints=Constraints(
            num_qubits=2,
            num_clbits=2,
            allowed_gates=[GateName.H, GateName.X, GateName.Z, GateName.CX, GateName.MEASURE],
            max_ops=10,
            min_gate_counts={GateName.H: 2, GateName.CX: 2},
            anchor=_SD_DECODER,
            anchor_name="decoder",
            must_measure=[0, 1],
            gate_qubits={GateName.X: [0], GateName.Z: [0]},
        ),
        starter_circuit=circ(2, [], 2),
        checks=[
            StateMatches(
                id="before.encoded_pair",
                label="Before decoding, the shared pair carries message 10",
                at=Point.BEFORE_ANCHOR,
                hint_index=1,
                misconception="Decoding only works if the pair was first entangled and Alice then applied the one gate that stands for this message. Without the Bell pair there is nothing for her single gate to change.",
                experiment="Run the trace and look at the state just before the decoder: is it an entangled pair, and which of Alice's gates (X or Z) changed it from the unencoded pair?",
                target=circ(2, [*_BELL, g("x", 0)]),
            ),
            ProbabilitiesMatch(
                id="final.decoded",
                label="Decoding gives the message 10 with certainty",
                hint_index=2,
                misconception="After the decoder the two qubits are in a definite state that spells the message. If the result is another message, Alice used the other gate (or none).",
                experiment="Measure both qubits at the end and read q[1] q[0]: change Alice's gate and watch which bit changes.",
                qubits=[0, 1],
                target=circ(2, [*_BELL, g("x", 0), *_SD_DECODER]),
            ),
        ],
        hints=[
            "Three stages: share a Bell pair, Alice encodes on her qubit q[0], Bob decodes with the fixed gates.",
            "Create the pair with H on q[0], then CX from q[0] to q[1]. Alice's X gate and Z gate each stand for one bit of the message: try each on q[0] and read the decoded result.",
            "After the decoder, measure q[0] and q[1] at the end. The result is written q[1] q[0].",
        ],
        success_message="One qubit travelled, yet two classical bits were recovered: the shared entanglement carried the rest.",
        reference_solution=circ(2, [*_BELL, g("x", 0), *_SD_DECODER, m(0, 0), m(1, 1)], 2),
    ),
    Challenge(
        id="teleport-ry-fixed",
        lesson_id="quantum-teleportation",
        title="Teleport the fixed ry(1.0) state",
        goal=(
            "Teleport the state ry(1.0)|0⟩ from q[0] (Alice's message qubit) to q[2] (Bob's qubit), using q[1] and q[2] as the "
            "shared pair. The circuit model has no mid-circuit measurement or classical control, so the corrections are "
            "deferred: controlled gates stand in for measure-then-correct. They are given below; you build everything "
            "before them, put the corrections after, and measure q[2]."
        ),
        difficulty="advanced",
        success_condition="Before the corrections Bob's qubit alone shows nothing of the message; after the fixed corrections q[2] holds the state ry(1.0)|0⟩.",
        constraints=Constraints(
            num_qubits=3,
            num_clbits=1,
            allowed_gates=[GateName.H, GateName.RY, GateName.CX, GateName.CZ, GateName.MEASURE],
            max_ops=14,
            anchor=_TP_CORRECTIONS,
            anchor_name="corrections",
            must_measure=[2],
        ),
        starter_circuit=circ(3, [], 1),
        checks=[
            StateMatches(
                id="before.protocol_state",
                label="Before the corrections, the message, the pair and Alice's gates have produced the protocol's state",
                at=Point.BEFORE_ANCHOR,
                hint_index=1,
                misconception="Teleportation needs the message state on q[0], an entangled pair on q[1] and q[2], and then Alice's CX (q[0] controls q[1]) and H on q[0]. A missing or reordered step leaves the corrections with nothing to correct.",
                experiment="Run the trace and compare the state before the corrections with each step of the recipe: which step is missing or in the wrong order?",
                target=circ(3, _TP_PREPARE),
            ),
            QubitStateMatches(
                id="before.bob_blind",
                label="Before the corrections, Bob's qubit q[2] alone has no definite state",
                at=Point.BEFORE_ANCHOR,
                hint_index=2,
                misconception="Until Alice's results are used, Bob's qubit is only half of an entangled pair: it holds no trace of the message. If it already shows a definite state, the message was moved by a direct interaction, not teleported.",
                experiment="Open the per-qubit spheres just before the corrections and look at q[2]: a qubit that is entangled with the others has a vector of length zero.",
                qubit=2,
                target=circ(3, [g("h", 1), g("cx", 2, 1)]),
            ),
            QubitStateMatches(
                id="final.delivered",
                label="After the corrections, q[2] holds the message state",
                hint_index=2,
                misconception="Bob's qubit becomes the message only after both corrections are applied, and only if the Bell-basis step on Alice's side was done.",
                experiment="Compare the Bloch vector of q[2] at the last step with the vector you get by applying the message rotation to a fresh qubit.",
                qubit=2,
                target=circ(3, [g("ry", 2, angle=_MESSAGE_ANGLE)]),
            ),
        ],
        hints=[
            "The recipe: prepare the message on q[0]; make a Bell pair on q[1] and q[2]; Alice entangles q[0] with q[1] (CX) and applies H to q[0]; then the corrections; then Bob's qubit is the message.",
            "Prepare the message with RY on q[0] with the angle 1 (radians). The pair is H on q[1], then CX with control q[1] and target q[2].",
            "Alice's step is CX with control q[0] and target q[1], then H on q[0]. Place the given corrections after it, and measure q[2] at the end.",
        ],
        success_message="The state moved from q[0] to q[2] without q[2] ever being touched directly: the shared pair and the corrections did the transfer.",
        reference_solution=circ(3, [*_TP_PREPARE, *_TP_CORRECTIONS, m(2, 0)], 1),
    ),
    Challenge(
        id="grover-find-01",
        lesson_id="grovers-search",
        title="Find |01⟩",
        goal=(
            "A search over four items, written as two qubits. One fixed oracle marks the item |01⟩ (q[1] = 0, q[0] = 1). It is "
            "exactly these three gates, in this order, back to back: X q[1], CZ q[0],q[1], X q[1]. Build one Grover iteration "
            "around it (prepare, oracle, diffusion) and measure both qubits: |01⟩ must come out every time."
        ),
        difficulty="advanced",
        fixed_oracle=True,
        success_condition="The fixed oracle is present once; before it both qubits are in |+⟩; the circuit ends in |01⟩; and with an oracle marking |10⟩ the same circuit would end in |10⟩.",
        constraints=Constraints(
            num_qubits=2,
            num_clbits=2,
            allowed_gates=[GateName.H, GateName.X, GateName.Z, GateName.CX, GateName.CZ, GateName.MEASURE],
            max_ops=24,
            anchor=_GROVER_ORACLE_01,
            must_measure=[0, 1],
        ),
        starter_circuit=circ(2, [], 2),
        checks=[
            StateMatches(
                id="before.uniform",
                label="Before the oracle: both qubits in |+⟩ (every item equally likely)",
                at=Point.BEFORE_ANCHOR,
                hint_index=1,
                misconception="Grover's search starts with every item equally likely, so that the oracle's phase flip and the diffusion have something to amplify.",
                experiment="Run the trace and look at the state just before the oracle: is any item more likely than another?",
                target=circ(2, [g("h", 0), g("h", 1)]),
            ),
            StateMatches(
                id="final.finds_01",
                label="The circuit ends in |01⟩",
                hint_index=2,
                misconception="After the oracle the marked item only differs by a sign, which a measurement cannot see. The diffusion step turns that sign difference into a larger amplitude for the marked item.",
                experiment="Compare the amplitudes after the oracle and after your last gate: which row's size changed, and which phase arrows turned?",
                target=circ(2, [g("x", 0)]),
            ),
            StateMatches(
                id="final.is_general",
                label="With an oracle marking |10⟩ instead, the same circuit would end in |10⟩",
                hint_index=2,
                misconception="Diffusion must not know which item is marked: it reflects every amplitude about their average. A circuit that only ever produces |01⟩ is a hard-coded answer, not a search.",
                experiment="Build the diffusion from H, X, CZ, X, H on both qubits with no gate that depends on which item is marked.",
                target=circ(2, [g("x", 1)]),
                replace_anchor=_GROVER_ORACLE_10,
            ),
        ],
        hints=[
            "Grover's search has three parts: spread the amplitude evenly, mark the target with the oracle, then reflect all amplitudes about their average (diffusion).",
            "Before the oracle: H on both qubits.",
            "After the oracle, diffusion is H on both, X on both, CZ, X on both, H on both. Then measure both qubits at the end.",
        ],
        success_message="One oracle call and one diffusion found the marked item among four: the sign flip became a larger amplitude.",
        reference_solution=circ(2, [g("h", 0), g("h", 1), *_GROVER_ORACLE_01, *_GROVER_DIFFUSION, m(0, 0), m(1, 1)], 2),
    ),
    Challenge(
        id="optimize-redundant",
        lesson_id="interference",
        title="Shorten it without changing it",
        goal=(
            "This circuit has gates that cancel or can be merged. Make it shorter - at most 3 operations - without changing what it does. "
            "The backend checks that your circuit is equivalent to the starting one (the same operation, up to a global phase), so "
            "removing a gate that was doing something will not pass."
        ),
        difficulty="intermediate",
        success_condition="Your circuit is equivalent to the starting circuit (the backend's operator-equivalence check says so) and has at most 3 operations.",
        constraints=Constraints(
            num_qubits=2,
            allowed_gates=[*ONE_QUBIT, GateName.CX, GateName.CZ, GateName.RX, GateName.RY, GateName.RZ],
            max_ops=3,
        ),
        starter_circuit=circ(2, _OPT_STARTER),
        checks=[
            EquivalentTo(
                id="equivalent.to_start",
                label="Does exactly what the starting circuit does",
                hint_index=1,
                misconception="A shorter circuit is only a better one if it is still the same circuit. Taking out a gate that was doing something, or merging two that do not combine, changes what the circuit does.",
                experiment="Before you change anything, pin the starting circuit as the reference (Equivalence, in the results panel). Then build your shorter circuit and use Check equivalence: which gate did you remove that mattered?",
                target=circ(2, _OPT_STARTER),
            )
        ],
        hints=[
            "Look for gates that undo each other: apply one and then the other, and the qubit is exactly where it started.",
            "H twice in a row does nothing, and so does X twice, and so does S followed by S-dagger. Two rotations about the same axis on the same qubit can be one rotation whose angle is their sum.",
            "Three H gates on q[0] act like one H. Remove the X pair and the S, S-dagger pair on q[1]. Replace the two RZ gates with one RZ whose angle is the sum of theirs (set it in the palette before placing).",
        ],
        success_message="Same circuit, fewer gates: gates that cancel or merge never needed to be there.",
        reference_solution=circ(2, [g("h", 0), g("cx", 1, 0), g("rz", 1, angle=0.75)]),
    ),
]
