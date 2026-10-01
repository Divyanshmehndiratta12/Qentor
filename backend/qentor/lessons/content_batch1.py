"""Lessons 11–13: Superdense Coding, Quantum Teleportation and Grover's Search (Sprint 2, curriculum batch 1).

Same architecture and same rules as every other lesson (``models.py`` types, ten sections, concept checks graded by the server
from ``grading.py``, content checked by ``qentor.content.validation``). Each is ONE small fixed example, said so in its text:

* Superdense coding: Bell pair, Alice's gate on q0 only, decoder ``cx q0→q1; h q0``, measure. Message 10 is X alone.
* Teleportation: a fixed 3-qubit example whose message state is ``ry`` with an angle of 1 radian on q0. The circuit model has no
  mid-circuit measurement and no classical control, so the corrections are DEFERRED (controlled gates). Section s2 says so
  plainly, and no section claims the full dynamic protocol.
* Grover: two qubits, four items, ONE fixed oracle marking the item 01 (q1 = 0, q0 = 1), ONE iteration. Not a scalable search.

Prose rules (tests enforce them): no decimal or percentage, no quantum number from a run, no multi-qubit ket (bit strings are
written ``q1 q0`` in words), and any worked algebra is labelled textbook. Numbers a learner sees come from the Lab and the trace.
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


def _opts(**options: str) -> list[ConceptCheckOption]:
    return [ConceptCheckOption(id=option_id, text=text) for option_id, text in options.items()]


BATCH1_LESSONS: list[Lesson] = [
    # ------------------------------------------------------------------ 11
    Lesson(
        id="superdense-coding",
        title="Superdense Coding",
        short_description="Sending two classical bits by moving one qubit of a shared Bell pair, in one small fixed circuit.",
        concept="superdense-coding",
        difficulty="intermediate",
        estimated_minutes=18,
        learning_objectives=[
            "Say what Alice and Bob must share before superdense coding can start.",
            "Explain why X and Z, acting on one qubit of a Bell pair, reach different states.",
            "Follow the fixed circuit: Bell pair, Alice's gate on q0, Bob's decoder, measurement.",
            "Say what is actually transmitted: one qubit, and why two bits are recovered.",
        ],
        linked_circuit=Circuit(
            num_qubits=2,
            num_clbits=2,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="x", targets=[0]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="measure", targets=[1], clbits=[1]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Two bits with one qubit",
                body=(
                    "Alice wants to send Bob two classical bits. Sent directly that takes two bits, or two qubits. Superdense "
                    "coding sends only ONE qubit, as long as Alice and Bob already share an entangled pair. This lesson is ONE "
                    "small fixed circuit with two qubits: Alice owns q0 and Bob owns q1. It is a fixed protocol to study, not a "
                    "general tool for sending data."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Why a shared entangled pair",
                body=(
                    "Before any message exists, Alice and Bob make a Bell pair: H on q0, then CX with q0 as control and q1 as "
                    "target. Measured, the two qubits always agree, yet each alone is undetermined. A single qubit sent alone can "
                    "deliver one bit at most. A shared pair has four joint states that can be told apart, and Alice can reach "
                    "any of them by acting on her own half only."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Alice's four encodings",
                body=(
                    "Alice applies one of four gate choices to q0 only: nothing, X, Z, or Z followed by X. Each leaves the pair in "
                    "a different state, one for each two-bit message. Qentor prints bits as q1 q0, the highest-numbered qubit on "
                    "the left. In this lesson X sets the left bit and Z sets the right bit, so message 10 is X alone, message 01 "
                    "is Z alone and message 11 uses both."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Why X and Z reach different Bell states",
                body=(
                    "This is textbook reasoning, not a run. X on one qubit of the pair turns results that always agree into "
                    "results that always disagree, because it flips that qubit's outcome. Z leaves the measurement odds alone and "
                    "flips the sign between the two parts of the state, which is a phase. X changes the odds and Z changes the "
                    "phase, so together they reach four states that can be told apart."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: what X does to the pair",
                prompt="Think about what the X gate does to one qubit's outcome.",
                question="Alice applies the X gate to her qubit q0 of the shared pair. What changes about the pair's results?",
                options=_opts(
                    a="The two results stop being related at all, so the pair is no longer entangled",
                    b="Results that always agreed now always disagree, since X flips one qubit's outcome",
                    c="The odds stay the same but the sign between the two parts of the state flips",
                    d="The pair splits into two independent qubits, one definite and one random",
                ),
                correct_option_id="b",
                explanation=(
                    "X flips the outcome of the qubit it acts on. Since the two results of the pair always agreed, flipping one "
                    "of them makes them always disagree. The pair is still entangled, because X on one qubit is a reversible "
                    "operation and cannot undo the link. Changing a sign without changing the odds is what Z does, not X."
                ),
                concept="superdense-coding",
            ),
            InteractiveLabSection(
                id="s6",
                title="Lab: encode message 10",
                instructions=(
                    "Open the lab circuit: it makes the pair, encodes message 10 with X on q0, decodes, and measures both qubits. "
                    "Run it on the backend and read the measurement result as q1 q0. Then use the trace: select the step after "
                    "Alice's gate and look at each qubit's own sphere and at the amplitude view. Finally swap the X for a Z, or "
                    "remove it, and run again on the backend to see which message each choice sends."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: what Bob needs",
                prompt="Think about where the second bit of the message travelled.",
                question="Alice sends her qubit q0 to Bob. What must Bob have in order to recover both bits of the message?",
                options=_opts(
                    a="Nothing more, because the single qubit already carries both bits by itself",
                    b="A second qubit sent by Alice that carries the remaining bit of the message",
                    c="The classical result of a measurement Alice made, sent by an ordinary channel",
                    d="His own half of the shared pair, so the two qubits can be decoded together",
                ),
                correct_option_id="d",
                explanation=(
                    "The message is not stored in Alice's qubit alone: it sits in how her qubit and Bob's qubit relate, and "
                    "Bob's decoder needs both. That is why the qubit by itself carries no readable message. Nothing else has to "
                    "be sent: no second qubit and no classical bits, only the entanglement that was shared beforehand."
                ),
                concept="superdense-coding",
            ),
            ExplanationSection(
                id="s8",
                title="Bob decodes",
                body=(
                    "Bob holds q0 after receiving it, and q1 from the start. He applies CX with q0 as control and q1 as target, "
                    "then H on q0. This undoes the Bell-pair preparation and turns each of the four states into one definite "
                    "two-bit reading. Measuring both qubits gives the message, written q1 q0. The decoder is the same for every "
                    "message; only Alice's gate differs."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="What is actually transmitted",
                body=(
                    "One qubit crosses from Alice to Bob, and two classical bits are recovered, because the other half of the "
                    "pair was already with Bob. It is not free: making and sharing the pair came first, and the qubit alone, "
                    "without Bob's half, gives no message. This is one small educational example. The numbers you see come from "
                    "the backend's run in the Lab, not from this text."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "Alice sends only one qubit, yet Bob reads two bits. Where did the second bit travel? And why would the "
                    "message be unreadable if Bob only had the qubit Alice sent?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["bell-state"],
    ),
    # ------------------------------------------------------------------ 12
    Lesson(
        id="quantum-teleportation",
        title="Quantum Teleportation",
        short_description="Moving a qubit's state with a shared pair and corrections, in one fixed 3-qubit example with deferred corrections.",
        concept="teleportation",
        difficulty="advanced",
        estimated_minutes=24,
        learning_objectives=[
            "Say what teleportation moves, and what it does not.",
            "Explain the role of the shared entangled pair.",
            "Explain why this lesson's corrections are deferred, and how that differs from the full protocol.",
            "Say why teleportation cannot signal faster than light.",
            "Read a multi-qubit trace through each qubit's own reduced state.",
        ],
        linked_circuit=Circuit(
            num_qubits=3,
            num_clbits=1,
            ops=[
                GateOp(gate="ry", targets=[0], params=[1.0]),
                GateOp(gate="h", targets=[1]),
                GateOp(gate="cx", controls=[1], targets=[2]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="cx", controls=[1], targets=[2]),
                GateOp(gate="cz", controls=[0], targets=[2]),
                GateOp(gate="measure", targets=[2], clbits=[0]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Moving a state, not a qubit",
                body=(
                    "Alice has a qubit in a state she does not want to measure, and Bob holds the other half of a shared Bell "
                    "pair. Teleportation moves that STATE onto Bob's qubit, while no qubit travels between them. This lesson is "
                    "ONE fixed 3-qubit example: q0 is Alice's message, prepared by a fixed RY rotation of 1 radian; q1 is Alice's "
                    "half of the pair; q2 is Bob's half."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Deferred corrections: what this circuit does differently",
                body=(
                    "The full protocol measures q0 and q1 in the middle of the circuit, sends the two results to Bob as classical "
                    "bits, and Bob applies X and Z corrections accordingly. Qentor's circuit model has NO mid-circuit measurement "
                    "and NO classical control. So this lesson uses the standard equivalent form with DEFERRED corrections: "
                    "controlled gates, CX from q1 and CZ from q0, applied before any measurement. It is not the full dynamic "
                    "protocol with classical communication, and does not claim to be."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="The circuit, step by step",
                body=(
                    "Textbook steps for the fixed example. Prepare the message on q0 with RY. Make a Bell pair on q1 and q2: H "
                    "on q1, then CX from q1 to q2. Alice entangles her message with her half: CX from q0 to q1, then H on q0. "
                    "Then the deferred corrections: CX from q1 to q2, then CZ from q0 to q2. Afterwards q2 holds the message "
                    "state, and q2 is the only qubit measured."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="The roles of entanglement and corrections",
                body=(
                    "The shared pair is the channel: it ties Bob's qubit to Alice's, so what Alice does to her side reaches his "
                    "without anything travelling. Alice's steps leave Bob's qubit holding the message in one of four disguised "
                    "forms. The corrections undo whichever disguise applies: CX removes a bit flip and CZ removes a sign flip. "
                    "Without the pair there is nothing to carry the state; without the corrections Bob's qubit is the wrong state."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: Bob's qubit before the corrections",
                prompt="Think about what an entangled qubit looks like when you examine it alone.",
                question="In the fixed example, before the corrections are applied, what does Bob's qubit q2 show on its own?",
                options=_opts(
                    a="A complete copy of the message state that only needs a sign fix",
                    b="The state it started in, because nothing has acted on it yet",
                    c="No definite state of its own, because it is half of an entangled pair",
                    d="The message state turned by a fixed angle that Bob can undo by himself",
                ),
                correct_option_id="c",
                explanation=(
                    "The pair gate acted on q2, so it is entangled with the other qubits and has no definite state of its own: "
                    "its Bloch arrow has length zero in the trace. That is why no message has reached Bob yet. The state he "
                    "needs only appears once the corrections, which depend on Alice's qubits, are applied."
                ),
                concept="teleportation",
            ),
            InteractiveLabSection(
                id="s6",
                title="Lab: teleport the fixed state",
                instructions=(
                    "Open the lab circuit and run it on the backend in shots mode: the measurement result is for q2 only, one "
                    "bit. A statevector run of a circuit that ends in a measurement shows one collapsed state, so read the "
                    "states in the trace instead: step to just before the corrections and look at the per-qubit spheres, then "
                    "step past the corrections and look again, and compare q2 with the state RY gave q0. Remember the "
                    "corrections here are deferred controlled gates, not measure-then-correct."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: deferred corrections",
                prompt="Think about what the circuit model does and does not support.",
                question="What do 'deferred corrections' mean in this lesson's circuit?",
                options=_opts(
                    a="Controlled gates applied before any measurement, since the model has no classical control",
                    b="Alice measures q0 and q1 in the middle of the circuit and sends the results as classical bits to Bob",
                    c="The corrections are left out, so Bob's qubit holds the message only some of the time",
                    d="Bob applies the corrections after measuring his own qubit at the end of the circuit",
                ),
                correct_option_id="a",
                explanation=(
                    "Qentor's circuit model cannot measure in the middle of a circuit or use a measurement result to decide a "
                    "gate. The standard workaround replaces measure-then-correct with controlled gates applied first and any "
                    "measurement last. It gives the same state on q2, but it is not the dynamic protocol with classical "
                    "communication, and this lesson does not claim it is."
                ),
                concept="teleportation",
            ),
            ExplanationSection(
                id="s8",
                title="No faster-than-light signalling",
                body=(
                    "Before the corrections, Bob's qubit is half of an entangled pair whatever Alice's message is, so looked at "
                    "alone it carries no information. Only after the corrections does it hold the message, and in the full "
                    "protocol those need Alice's two classical results, sent by ordinary means. So teleportation cannot signal "
                    "faster than light. It also does not copy the state: Alice's qubits end up in a different state."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="Reading the trace of a multi-qubit run",
                body=(
                    "In the trace each qubit has its own Bloch sphere, computed by the backend from that qubit's reduced state. "
                    "While qubits are entangled a sphere's arrow has length zero: that qubit alone has no definite state, which "
                    "is not an error. Before the corrections q2 looks like that. After them q2's sphere shows the message state, "
                    "and q0 and q1 are left in states of their own."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "In the full protocol Alice's two measurement results must reach Bob before he can fix his qubit. What would "
                    "Bob's qubit look like to him if those results never arrived, and what does that say about signalling?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["bell-state", "phase"],
    ),
    # ------------------------------------------------------------------ 13
    Lesson(
        id="grovers-search",
        title="Grover's Search",
        short_description="Finding one marked item among four with one oracle and one diffusion step; a small educational example, not a scalable search.",
        concept="grover-search",
        difficulty="advanced",
        estimated_minutes=22,
        learning_objectives=[
            "Say what the oracle changes about the marked item, and why a measurement cannot see it.",
            "Explain how diffusion turns that change into a larger amplitude.",
            "Say why one iteration is enough for four items and one marked item.",
            "Describe the fixed two-qubit circuit and read its measurement as q1 q0.",
        ],
        linked_circuit=Circuit(
            num_qubits=2,
            num_clbits=2,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="h", targets=[1]),
                GateOp(gate="x", targets=[1]),
                GateOp(gate="cz", controls=[0], targets=[1]),
                GateOp(gate="x", targets=[1]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="h", targets=[1]),
                GateOp(gate="x", targets=[0]),
                GateOp(gate="x", targets=[1]),
                GateOp(gate="cz", controls=[0], targets=[1]),
                GateOp(gate="x", targets=[0]),
                GateOp(gate="x", targets=[1]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="h", targets=[1]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="measure", targets=[1], clbits=[1]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="A search over four items",
                body=(
                    "Finding the one item that passes a test, among four, normally takes several tries. Grover's search uses "
                    "interference to raise the marked item's amplitude instead. This lesson is ONE small educational example: "
                    "two qubits give four items, one fixed item is marked, and exactly one Grover iteration is used. It does "
                    "not show a scalable speed-up and it is not a general search tool."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="An even start",
                body=(
                    "H on both qubits puts all four items in an equal superposition, so each has the same amplitude and nothing "
                    "is marked yet. Qentor writes bit strings as q1 q0, the highest-numbered qubit on the left, so the four "
                    "items are 00, 01, 10 and 11. The marked item in this lesson is 01: q1 is 0 and q0 is 1."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="The oracle changes a phase",
                body=(
                    "Textbook view: the oracle flips the sign of the marked item's amplitude and leaves the other three alone. "
                    "A CZ flips the sign of the item where both qubits are 1. To mark 01, X on q1 comes before it and again "
                    "after, which moves 01 into that position and back. A sign is a phase, so a measurement made right after "
                    "the oracle could not tell anything had changed."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Diffusion turns a sign into a bigger amplitude",
                body=(
                    "Diffusion reflects every amplitude about their average: H on both, X on both, CZ, X on both, H on both. The "
                    "marked item's flipped sign puts it below the average, so the reflection throws it far above, while the "
                    "other three shrink. Interference does the work: the contributions add for the marked item and cancel "
                    "for the rest. The diffusion never needs to know which item is marked."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: why the sign flip matters",
                prompt="Think about what diffusion compares each amplitude with.",
                question="Right after the oracle a measurement looks unchanged. Why does the sign flip still matter?",
                options=_opts(
                    a="It makes the marked item more likely to be measured straight away",
                    b="It moves the marked item onto a different qubit that diffusion then reads",
                    c="It does not, because diffusion would find the item without the oracle",
                    d="Diffusion compares amplitudes with their average, so the flipped sign makes the marked one stand out",
                ),
                correct_option_id="d",
                explanation=(
                    "A sign is invisible to a direct measurement, but the diffusion step reflects amplitudes about their "
                    "average, and a flipped sign puts the marked item on the opposite side of that average from the others. "
                    "Without the oracle every amplitude is equal and the reflection changes nothing, so the oracle is what "
                    "gives diffusion something to amplify."
                ),
                concept="grover-search",
            ),
            InteractiveLabSection(
                id="s6",
                title="Lab: one Grover iteration",
                instructions=(
                    "Open the lab circuit and run it on the backend; read the measurement as q1 q0. In the trace, step through "
                    "the circuit and watch the amplitude and phase view: after the oracle, compare the marked item's phase "
                    "arrow and size with the others, then compare again after the diffusion. Then change which qubit gets the X "
                    "gates around the oracle's CZ and run it again on the backend to mark a different item."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: why one iteration is enough",
                prompt="Think about the size of this search.",
                question="With four items and one marked item, why does a single Grover iteration suffice here?",
                options=_opts(
                    a="Because the oracle alone already makes the marked item certain",
                    b="Because one reflection about the average moves all the amplitude onto the marked item at this size",
                    c="Because Grover's search never needs more than one iteration for any number of items",
                    d="Because two qubits cannot hold the state that a second iteration would need",
                ),
                correct_option_id="b",
                explanation=(
                    "For one marked item among four, the flip and the reflection together move all of the amplitude onto the "
                    "marked item, so a second iteration would overshoot it. With more items the same step moves the amplitude "
                    "only part of the way, and more iterations are needed. That is why this lesson shows the mechanism at the "
                    "smallest size and claims no scalable advantage."
                ),
                concept="grover-search",
            ),
            ExplanationSection(
                id="s8",
                title="Why one iteration is enough here",
                body=(
                    "Textbook algebra for four items and one marked item: after one oracle call and one diffusion, all of the "
                    "amplitude sits on the marked item. With more items the first iteration moves the marked item's amplitude "
                    "only part of the way, and further iterations are needed. This lesson stops at four items on purpose: it "
                    "shows the mechanism, not a scalable advantage."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="Reading the Lab",
                body=(
                    "In the Lab trace, the amplitude and phase view shows the effect step by step: after the oracle the marked "
                    "item's phase arrow turns while its size matches the others, and after diffusion its size has grown. The "
                    "measurement result is read as q1 q0. Every number comes from the backend's run, not from this text, so "
                    "check what you read against the trace."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "Which part of the circuit knows which item is marked, and which part does not? What would you expect if "
                    "the oracle marked a different item and you kept the same diffusion?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["interference"],
    ),
]
