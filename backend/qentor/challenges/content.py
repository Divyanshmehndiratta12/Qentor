"""The nine challenges. Data only: every verdict is computed by ``qentor.challenges.evaluate`` from backend statevectors.

Hints are written to be deterministic and safe to show: they name gates and ideas, never a quantum result the learner has
not produced (no probabilities or amplitudes appear here).

The two oracle challenges use ONE fixed oracle each, chosen here. Nothing generates or synthesises an oracle.

* Deutsch-Jozsa (fixed): 2 input qubits q[0], q[1] and an ancilla q[2]; the oracle is ``cx q0→q2; cx q1→q2``
  (f(x) = x0 ⊕ x1, balanced).
* Bernstein-Vazirani (fixed): 3 input qubits and an ancilla q[3]; the oracle is ``cx q1→q3; cx q2→q3`` (hidden string
  q[2]q[1]q[0] = 110).

Every challenge builds its circuit by appending gates (the Lab canvas appends), so the fixed oracle is something the
learner places, exactly as given, and the evaluator checks it is there once, unchanged and in order.
"""

from __future__ import annotations

from qentor.circuit.model import Circuit, GateName, GateOp

from .models import (
    Challenge,
    Constraints,
    EndsInBasisState,
    PassesThroughSuperposition,
    Point,
    ProbabilitiesMatch,
    StateDiffers,
    StateMatches,
)

ONE_QUBIT = [GateName.H, GateName.X, GateName.Y, GateName.Z, GateName.S, GateName.SDG, GateName.T, GateName.TDG]


def g(gate: str, target: int, control: int | None = None) -> GateOp:
    return GateOp(gate=GateName(gate), targets=[target], controls=[] if control is None else [control], params=[], clbits=[])


def m(qubit: int, clbit: int) -> GateOp:
    return GateOp(gate=GateName.MEASURE, targets=[qubit], controls=[], params=[], clbits=[clbit])


def circ(num_qubits: int, ops: list[GateOp], num_clbits: int = 0) -> Circuit:
    return Circuit(num_qubits=num_qubits, num_clbits=num_clbits, ops=ops)


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
]
