"""The three advanced lessons: Phase Kickback, Deutsch-Jozsa and Bernstein-Vazirani.

Each is built from the existing section types only, ten sections long:

    explanation x4-5   intuition, core concept, target / oracle, worked or circuit example
    concept_check      a reasoning question, before the lab
    interactive_lab    points at ``Lesson.linked_circuit`` (the existing Lab)
    concept_check      a second, different question, after the lab
    explanation x1-2   what the result means, its limits, and the next idea
    reflection         an open prompt

(Phase Kickback and Deutsch-Jozsa put the first check after four explanations;
Bernstein-Vazirani, whose fixed example needs a fifth, after five.)

The linked circuits, ids and prerequisites are the original catalog's. Nothing here
generates an oracle: each lesson is about ONE fixed example and says so.

Rules this content follows (and ``tests/test_advanced_lessons.py`` enforces):

- No quantum RESULT appears in prose. States are textbook identities, never the
  output of a run; anything a learner should *observe* is sent to the Lab or the
  Trace. No lesson text contains a decimal or a percentage.
- Two-qubit and three-qubit statements name the qubit ("q0 reads 1") or use
  Qentor's order, highest-numbered qubit on the left (``q[n-1] … q[0]``).
- The Phase Kickback lab circuit prepares its target in |−⟩ (X then H on q1), an
  eigenstate of X, so it is a clean kickback. The lesson then asks the learner to
  delete the H on q1 and rerun, as the contrast case (the target is |1⟩, not an
  eigenstate).
- The Bernstein-Vazirani example's secret has a 1 on q0 and a 0 on q1. Qentor
  writes that 01 (q1 on the left); the lesson says which reading it means.

Lesson prose is authored in English. The tutor localises only its own wrapper
text (see ``qentor.tutor.lesson_answers``); it does not translate this prose.
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


ADVANCED_LESSONS: list[Lesson] = [
    # ------------------------------------------------------------------ 8
    Lesson(
        id="phase-kickback",
        title="Phase Kickback",
        short_description="How a target qubit's phase can act back on a control qubit.",
        concept="phase-kickback",
        difficulty="advanced",
        estimated_minutes=22,
        learning_objectives=[
            "Explain what an eigenstate is and why its gate leaves it unchanged apart from a phase.",
            "Say why the target of a CX must start in |−⟩ for a clean phase kickback.",
            "Follow a CX acting on |+⟩ and |−⟩ and say where the −1 ends up.",
            "Explain why a phase on the control needs a Hadamard before it can be measured.",
            "Connect phase kickback to how oracle algorithms read out a function.",
        ],
        linked_circuit=Circuit(
            num_qubits=2,
            num_clbits=0,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="x", targets=[1]),
                GateOp(gate="h", targets=[1]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="h", targets=[0]),
            ],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="An eigenstate is left alone",
                body=(
                    "Some states pass through a gate unchanged except for a phase. Such a state is an "
                    "eigenstate of that gate, and the phase is its eigenvalue. The X gate leaves "
                    "|+⟩ = (|0⟩ + |1⟩)/√2 exactly as it is, and turns |−⟩ = (|0⟩ − |1⟩)/√2 into −|−⟩: the "
                    "same state, multiplied by −1. A global phase cannot be seen, so the eigenstate itself "
                    "appears not to change at all."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Preparing the target",
                body=(
                    "For the trick below, the target qubit must start in an eigenstate of X. From |0⟩, an X "
                    "gate gives |1⟩ and an H gate then gives |−⟩, so X followed by H prepares |−⟩. Note that "
                    "|1⟩ on its own is not an eigenstate of X, because X turns it into |0⟩, a different "
                    "state. Written in the X eigenstates, |1⟩ is an equal mix of |+⟩ and |−⟩, and that mix "
                    "is why leaving out the H behaves differently."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Example: CX on |+⟩ and |−⟩",
                body=(
                    "Textbook algebra, with q0 as the control and q1 as the target. Put q0 in |+⟩ and q1 in "
                    "|−⟩. CX flips the target only when the control is 1. When q0 is 0, q1 is untouched; "
                    "when q0 is 1, q1 receives an X, and for |−⟩ an X is just a factor of −1. So the |1⟩ "
                    "part of q0 gains a −1 and q1 is unchanged: the pair ends as |−⟩ on q0 and |−⟩ on q1. "
                    "The phase has been kicked back onto the control."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="The lab circuit, and a contrast case",
                body=(
                    "The lab circuit is H on q0, X then H on q1, CX from q0 to q1, then H on q0. The X and H "
                    "on q1 prepare |−⟩, an eigenstate of X, so this is the clean kickback. Run it first. Then "
                    "build the contrast case: delete the H on q1, so the target is |1⟩ and not an eigenstate, "
                    "and compare what the backend reports for q0 in the two runs. The trace shows each "
                    "gate's effect one step at a time."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: where the phase goes",
                prompt="Say where the phase ends up when the target is an eigenstate.",
                question=(
                    "A CX has its control in |+⟩ and its target in |−⟩. Which statement describes the pair "
                    "immediately afterwards?"
                ),
                options=_opts(
                    a="The target has been flipped to |+⟩, and the control still has the state it started in",
                    b="The two qubits are now entangled with each other",
                    c="The target is unchanged, and the sign of the control's |1⟩ part has flipped",
                    d="The control has been flipped to |1⟩ straight away, and the target keeps the state it had",
                ),
                correct_option_id="c",
                explanation=(
                    "|−⟩ is an eigenstate of X with eigenvalue −1, so when the control is 1 the X on the "
                    "target only multiplies the state by −1. That −1 belongs to the |1⟩ part of the control, "
                    "so the control turns from |+⟩ into |−⟩ while the target stays |−⟩ and the two stay "
                    "unentangled. The control is not yet in |1⟩: a later H is needed to turn that sign into a "
                    "bit."
                ),
                concept="phase-kickback",
            ),
            InteractiveLabSection(
                id="s6",
                title="Run the clean kickback, then the contrast case",
                instructions=(
                    "Open the lab circuit (H on q0, X then H on q1, CX, H on q0) and run it in statevector "
                    "mode; the backend's amplitudes are non-zero only where q0 is 1. Open the trace to follow "
                    "it gate by gate and see the sign appear after the CX. Now build the contrast case "
                    "yourself: delete the H on q1, so q1 is |1⟩, and run it again. The backend now reports "
                    "amplitudes for both values of q0, so q0 does not come out definite."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: why the target matters",
                prompt="Explain what changes when the target is prepared in |1⟩.",
                question=(
                    "Suppose the H on q1 is left out of the lab circuit, so the target q1 is prepared in |1⟩ "
                    "instead of |−⟩. Why does q0 not end up in a single definite state?"
                ),
                options=_opts(
                    a="A CX acting on a target that is in |1⟩ has no effect on the control at all, so nothing can kick back",
                    b="|1⟩ is an equal mix of two X eigenstates, and each one sends the control to a different state",
                    c="The X gate on q1 also changes q0",
                    d="Phase kickback only occurs on real hardware, never in a simulation",
                ),
                correct_option_id="b",
                explanation=(
                    "|1⟩ = (|+⟩ − |−⟩)/√2. The |+⟩ part leaves the control alone and the |−⟩ part kicks a "
                    "−1 onto it, so each part of the target comes with a different state of the control and "
                    "the two qubits end up entangled. CX does act on |1⟩, and the X gate on q1 never touches "
                    "q0."
                ),
                concept="phase-kickback",
            ),
            ExplanationSection(
                id="s8",
                title="Turning a sign into a bit",
                body=(
                    "A −1 on the |1⟩ part of the control is a relative phase, so measuring the control "
                    "straight away shows nothing. A final H on the control maps |−⟩ to |1⟩ and |+⟩ to |0⟩, "
                    "so the kicked-back sign becomes a bit you can measure. This is interference at work, "
                    "the idea from the phase lesson: a phase you cannot see directly is turned into an "
                    "outcome you can."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="Why oracle algorithms use it",
                body=(
                    "An oracle usually flips a target qubit according to a function of its inputs. With the "
                    "target in |−⟩, that flip becomes a sign, minus one to the power of the function's value, "
                    "written onto the input qubits while the target stays as it was. The function's answer "
                    "arrives as a phase on the inputs. Deutsch–Jozsa is next: one query, and interference on "
                    "the inputs reads that phase."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "Why does it matter that the target starts in |−⟩ and not |1⟩? And what would you "
                    "expect the control to do if the target started in |+⟩ instead?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["bell-state", "phase"],
    ),
    # ------------------------------------------------------------------ 9
    Lesson(
        id="deutsch-jozsa",
        title="Deutsch–Jozsa",
        short_description="Deciding constant vs. balanced with a single query, on one example oracle.",
        concept="oracle-algorithms",
        difficulty="advanced",
        estimated_minutes=24,
        learning_objectives=[
            "State the promise: the hidden function is either constant or balanced, and nothing else.",
            "Explain why the ancilla is prepared in |−⟩ and how the oracle then writes a phase on the input.",
            "Follow one balanced-oracle example through superposition, oracle and interference.",
            "Read a measured outcome as constant or balanced.",
            "Say what this single example does and does not show.",
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
                title="Constant or balanced?",
                body=(
                    "A function f takes a bit string and returns 0 or 1. You are promised that f is either "
                    "constant, giving the same answer for every input, or balanced, giving 0 for exactly "
                    "half of the inputs and 1 for the other half. The task is to say which. Asked classically, "
                    "f must be evaluated one input at a time, and in the worst case more than half of the "
                    "inputs are needed. Deutsch–Jozsa decides it with a single query to a quantum oracle."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="The ancilla in |−⟩",
                body=(
                    "Besides the input qubits there is one ancilla, the oracle's target. It starts in |0⟩, "
                    "and X then H prepare |−⟩. The oracle flips the ancilla whenever f of the input is 1, and "
                    "|−⟩ is an eigenstate of X with eigenvalue −1. As in the phase kickback lesson, the flip "
                    "becomes a sign: the input |x⟩ is multiplied by minus one to the power f(x), and the "
                    "ancilla is left as it was."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="The oracle in this example",
                body=(
                    "Here there is one input qubit, q0, and the ancilla is q1. The oracle is a single CX from "
                    "q0 to q1, which computes f(x) = x: it returns 0 for input 0 and 1 for input 1, so this f "
                    "is balanced. This is ONE fixed example, chosen so the whole circuit stays small. The "
                    "lesson does not generate oracles, and a realistic oracle has more input qubits and many "
                    "more gates."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Example: interference on the input",
                body=(
                    "Textbook algebra for this example. H on q0 gives (|0⟩ + |1⟩)/√2. The oracle multiplies "
                    "each term by minus one to the power f(x): |0⟩ keeps its sign and |1⟩ gains a −1, giving "
                    "(|0⟩ − |1⟩)/√2, which is |−⟩. The final H maps |−⟩ to |1⟩. A constant oracle would leave "
                    "(|0⟩ + |1⟩)/√2 up to a global sign, and the final H would map that to |0⟩. The two "
                    "endings differ, so one query decides."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: why |−⟩",
                prompt="Explain what preparing the ancilla in |−⟩ achieves.",
                question="Why is the oracle's target qubit prepared in |−⟩ before the oracle runs?",
                options=_opts(
                    a="So the oracle's flip turns into a sign on the input qubits, leaving the target as it was",
                    b="So the target's measured value equals f of the input",
                    c="So the input qubits become entangled with each other and share a single joint phase",
                    d="Because a CX gate only works when its target starts in |−⟩",
                ),
                correct_option_id="a",
                explanation=(
                    "|−⟩ is an eigenstate of X, so flipping it only multiplies it by −1. Where the oracle "
                    "would flip the target, the state instead picks up a sign that belongs to the input "
                    "value that caused it. The answer is therefore written on the inputs as a phase, ready "
                    "for interference, and the target is not what gets measured."
                ),
                concept="oracle-algorithms",
            ),
            InteractiveLabSection(
                id="s6",
                title="Run the balanced example",
                instructions=(
                    "Open the lab circuit and run it in shots mode: it measures q0, the input qubit, and the "
                    "backend reports the counts. Then open the trace to follow the state one gate at a time "
                    "and see the sign appear after the CX. For a constant oracle, remove the CX (an oracle "
                    "that always returns 0 is constant) and run again: the backend's result for q0 changes."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: reading the result",
                prompt="Decide what a measured outcome tells you.",
                question=(
                    "In a Deutsch–Jozsa run, every input qubit is measured as 0. Given the promise, what "
                    "can you conclude?"
                ),
                options=_opts(
                    a="The oracle is balanced",
                    b="The oracle is constant, and it always returns the value 0 whichever input it is given",
                    c="The oracle is neither constant nor balanced",
                    d="The oracle is constant, but the run cannot say which constant value it returns",
                ),
                correct_option_id="d",
                explanation=(
                    "All zeros means the inputs interfered back to |0⟩, which is what a constant oracle "
                    "does. A constant oracle that always returns 0 and one that always returns 1 differ only "
                    "by a global sign, so the run cannot tell them apart. The promise rules out an oracle "
                    "that is neither constant nor balanced."
                ),
                concept="oracle-algorithms",
            ),
            ExplanationSection(
                id="s8",
                title="Reading the measurement",
                body=(
                    "Measure the input register and ignore the ancilla. If every input qubit reads 0, f is "
                    "constant; if any input qubit reads 1, f is balanced. This example has a single input "
                    "qubit, so a 1 on q0 means balanced. For an oracle that keeps the promise, a noiseless "
                    "simulator gives the same verdict on every run, because the interference is complete."
                ),
            ),
            ExplanationSection(
                id="s9",
                title="What this example does not show",
                body=(
                    "One input qubit is too small to show a speed-up: a classical program decides this f "
                    "with two evaluations. The advantage appears with many input qubits, and only against "
                    "deterministic classical algorithms; randomised ones need just a few queries to be very "
                    "likely right. The promise is essential, since an oracle that is neither constant nor "
                    "balanced gives an answer that means nothing. Bernstein–Vazirani, next, recovers a hidden "
                    "string with the same circuit shape."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "The promise is doing real work. What would a reading of 0 on every input qubit mean if "
                    "you did not know the oracle was constant or balanced? Why is the algorithm a "
                    "demonstration of interference rather than a practical tool?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["phase-kickback"],
    ),
    # ------------------------------------------------------------------ 10
    Lesson(
        id="bernstein-vazirani",
        title="Bernstein–Vazirani",
        short_description="Recovering a hidden bitstring with a single query, on one example oracle.",
        concept="oracle-algorithms",
        difficulty="advanced",
        estimated_minutes=24,
        learning_objectives=[
            "Describe the hidden-string problem: f(x) is the parity of the bits of x that the secret selects.",
            "Explain how the oracle stores the secret as CX gates onto the ancilla.",
            "Explain how phase kickback turns those CX gates into signs on the input qubits.",
            "Follow the one fixed example and read its measured bits as the secret.",
            "State what a single query gains over asking classically, one bit at a time.",
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
                title="A hidden bit string",
                body=(
                    "A secret bit string s defines a function: f(x) is the parity of the bits of x in the "
                    "positions where s has a 1, that is, whether that count of ones is odd or even. You may "
                    "ask an oracle for f(x) on any x you like, and you want s. Classically each answer "
                    "reveals one bit of s at best, so n bits cost n questions. Bernstein–Vazirani recovers "
                    "all of s with one query."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="The secret is stored in the gates",
                body=(
                    "The oracle is built from CX gates. For every position where s has a 1 there is one CX "
                    "from that input qubit to the ancilla, and where s has a 0 there is none. The ancilla is "
                    "flipped once for each of those input qubits that is 1, so it ends up flipped by f(x), "
                    "the parity. The secret lives in the pattern of gates, not in any qubit."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Kickback does the reading",
                body=(
                    "The ancilla starts in |−⟩, exactly as in Deutsch–Jozsa, so each CX kicks a −1 back onto "
                    "its own control whenever that control is 1. The input register therefore picks up minus "
                    "one to the power f(x). Starting from an equal superposition of every input, that "
                    "pattern of signs is exactly what a layer of H gates turns into the single basis state "
                    "for s: interference points at the secret."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="The one fixed example",
                body=(
                    "This lesson runs ONE fixed example, not an oracle generator: two input qubits q0 and q1 "
                    "and an ancilla q2, with a CX from q0 to q2 and none from q1. The secret has a 1 on q0 "
                    "and a 0 on q1. Qentor prints bitstrings with the highest-numbered qubit on the left, so "
                    "the measured bits read 01: q1's bit, then q0's. The circuit is X and H on q2, H on q0 "
                    "and q1, the CX, then H on q0 and q1 and a measurement of both."
                ),
            ),
            ExplanationSection(
                id="s5",
                title="Example: reading the secret",
                body=(
                    "Textbook algebra for this example. After the first layer of H gates, q0 and q1 are each "
                    "(|0⟩ + |1⟩)/√2. The only oracle gate is the CX from q0, and it kicks a −1 onto q0 when "
                    "q0 is 1, so q0 becomes |−⟩ while q1, untouched, stays |+⟩. The second layer of H gates "
                    "maps |−⟩ to |1⟩ and |+⟩ to |0⟩. So q0 reads 1 and q1 reads 0, which is exactly the "
                    "secret the oracle's gates encode."
                ),
            ),
            ConceptCheckSection(
                id="s6",
                title="Check: predict the readout",
                prompt="Predict the measured bits from the oracle's gates.",
                question=(
                    "The oracle has a CX from q0 to the ancilla and no gate from q1. Which measured bits "
                    "should the algorithm show?"
                ),
                options=_opts(
                    a="q0 reads 0 and q1 reads 1",
                    b="q0 reads 1 and q1 reads 0",
                    c="Both q0 and q1 read 1, since both begin in the same state",
                    d="All four combinations are equally likely",
                ),
                correct_option_id="b",
                explanation=(
                    "A CX from a qubit kicks a −1 onto that qubit, and the closing H turns it into a 1. So "
                    "the qubit with a CX in the oracle reads 1, and the qubit with none stays in |+⟩ and the "
                    "closing H returns it to 0. The readout is the secret, not a random guess, because the "
                    "interference is complete."
                ),
                concept="oracle-algorithms",
            ),
            InteractiveLabSection(
                id="s7",
                title="Run the fixed example",
                instructions=(
                    "Open the lab circuit and run it in shots mode: the backend measures both input qubits. "
                    "Read the bits by qubit, where c0 holds q0 and c1 holds q1, and compare them with the CX "
                    "gates in the oracle. Then open the trace to see the signs appear after the CX and the "
                    "second layer of H gates turn them into bits."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s8",
                title="Check: change the oracle",
                prompt="Predict what a second CX in the oracle does.",
                question=(
                    "You add a CX from q1 to the ancilla, so the oracle now has one from q0 and one from q1. "
                    "What does one run of the algorithm read?"
                ),
                options=_opts(
                    a="Nothing changes: the new gate acts only on the ancilla, so q0 still reads 1 and q1 still reads 0",
                    b="The two bits swap, so q0 now reads 0 and q1 reads 1",
                    c="Both input qubits read 1, one for each CX in the oracle",
                    d="The bits are random, because the two CX gates interfere with each other",
                ),
                correct_option_id="c",
                explanation=(
                    "Each CX kicks its sign back onto its own control, whatever the other CX does. Now both "
                    "q0 and q1 become |−⟩, and the closing H gates turn both into 1. The new gate changes "
                    "the secret, and the readout follows it: the secret has a 1 on each input qubit. The gates "
                    "do not interfere with each other, because each kick lands on a different qubit."
                ),
                concept="oracle-algorithms",
            ),
            ExplanationSection(
                id="s9",
                title="Why one query is enough, and its limits",
                body=(
                    "Classically each query returns a single bit, so learning n secret bits takes n queries. "
                    "The quantum oracle is called once, but on a superposition of every input, and the "
                    "kicked-back signs record the whole secret at once. That single call is real; building "
                    "the oracle out of gates is not free, and Bernstein–Vazirani has no practical use of "
                    "its own. It shows what kickback and interference can do. To go on, build your own "
                    "oracle by hand in the Lab."
                ),
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "Suppose the secret had three 1-bits and you had never seen the oracle's gates. In your "
                    "own words, how would the same circuit still return the secret in one call, and what "
                    "would a classical program need to do instead?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["deutsch-jozsa"],
    ),
]
