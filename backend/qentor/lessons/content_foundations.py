"""The seven foundation lessons: Qubits & Measurement, Bloch Sphere,
Superposition, Phase, Interference, Entanglement and Bell State.

Each is a short mini-lesson built from the existing section types, in the same
shape:

    s1-s4  explanation     intuition, core ideas, a worked textbook example
    s5     concept_check   predict / explain — one unambiguous answer
    s6     interactive_lab points at ``Lesson.linked_circuit`` (the existing Lab)
    s7     concept_check   a second, different misconception
    s8     explanation     how the ideas connect, and what comes next
    s9     reflection      an open prompt

Rules this content follows (and ``tests/test_lesson_content.py`` enforces):

- No quantum RESULT appears in prose. Where an amplitude or state is written,
  it is a textbook identity (for example H|0⟩ = (|0⟩ + |1⟩)/√2), never something
  presented as the output of a run; anything a learner should *observe* is sent
  to the Lab or the Trace, which show numbers the backend produced. No lesson
  text contains a decimal or a percentage.
- Two-qubit kets are written the way Qentor prints them: highest-numbered qubit
  on the left (``q[n-1] … q[0]``).
- A concept check's distractors are plausible misconceptions; the question never
  contains the answer; the correct option id varies across the catalog.
- Prerequisites and ids are unchanged from the original catalog, so Learn
  progression is unaffected.

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


FOUNDATION_LESSONS: list[Lesson] = [
    # ------------------------------------------------------------------ 1
    Lesson(
        id="qubits-measurement",
        title="Qubits & Measurement",
        short_description="What a qubit is, and what happens when you measure one.",
        concept="qubits-measurement",
        difficulty="beginner",
        estimated_minutes=16,
        learning_objectives=[
            "Contrast a classical bit with a qubit's state, written as two amplitudes.",
            "Name the computational basis states |0⟩ and |1⟩ and say what they mean.",
            "Use the Born rule to relate amplitudes to measurement probabilities.",
            "Explain why a measurement returns a classical bit and leaves the qubit in that outcome's state.",
        ],
        linked_circuit=Circuit(
            num_qubits=1,
            num_clbits=1,
            ops=[GateOp(gate="x", targets=[0]), GateOp(gate="measure", targets=[0], clbits=[0])],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="A bit, and a qubit",
                body=(
                    "A classical bit is always exactly 0 or 1. A qubit is a physical system with two "
                    "distinguishable states, written |0⟩ and |1⟩, but its state can be a blend of both. "
                    "Think of the state as a recipe saying how much of |0⟩ and how much of |1⟩ is present, "
                    "rather than a hidden 0 or 1 that you just have not looked at yet."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="State vectors and amplitudes",
                body=(
                    "A qubit's state is written α|0⟩ + β|1⟩. The numbers α and β are called amplitudes: they "
                    "can be negative or even complex, and together they must satisfy |α|² + |β|² = 1. The "
                    "states |0⟩ and |1⟩ form the computational basis: the two outcomes a standard measurement "
                    "can report. Amplitudes describe the state, but you can never read them off directly."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Measurement and the Born rule",
                body=(
                    "Measuring a qubit in the computational basis gives a classical bit. The Born rule says "
                    "you get 0 with probability |α|² and 1 with probability |β|². Afterwards the qubit is "
                    "left in the basis state you saw, so measuring it again straight away repeats the same "
                    "answer. Only these outcomes ever leave the quantum system, which is why one run reveals "
                    "so little about the amplitudes."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Example: X, then measure",
                body=(
                    "Start from |0⟩ and apply the X gate, which swaps |0⟩ and |1⟩. In textbook terms the "
                    "state becomes |1⟩, so α = 0 and β = 1, and the Born rule says the outcome is 1 every "
                    "time. That is the special case where one amplitude has full size: a definite outcome, "
                    "with nothing left to be random."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: predicting outcomes",
                prompt="Predict what repeated measurements of a state with unequal amplitudes will show.",
                question=(
                    "A qubit is prepared in the same state α|0⟩ + β|1⟩ again and again, where |α|² = 3/4 and "
                    "|β|² = 1/4, and measured each time. What should you expect to see?"
                ),
                options=_opts(
                    a="Always 0, because the amplitude for 0 is the larger one and so it wins every time",
                    b="Three 0s followed by one 1, in a repeating pattern that never varies",
                    c="0 in roughly three quarters of the runs and 1 in roughly one quarter, each single run giving a definite bit",
                    d="A fractional value between 0 and 1 on every run, weighted by the two amplitudes",
                ),
                correct_option_id="c",
                explanation=(
                    "The Born rule gives probabilities |α|² and |β|². Each individual run still returns a "
                    "definite 0 or 1; the three-to-one split only appears in the long-run frequencies. "
                    "Measurement never returns a fractional value, and the outcomes do not follow a fixed "
                    "repeating pattern."
                ),
                concept="qubits-measurement",
            ),
            InteractiveLabSection(
                id="s6",
                title="Try it: X, then measure",
                instructions=(
                    "Open the lab circuit — X on qubit 0, then a measurement — and run it in the Lab. The "
                    "outcome you see comes from a real backend execution, not from this text; compare it "
                    "with what the Born rule predicts for the state described above. Then open the trace to "
                    "see the qubit's state after the X gate."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: measuring twice",
                prompt="Predict what a second measurement gives after a first one.",
                question=(
                    "You measure a qubit and read 1. Without applying any gate, you immediately measure the "
                    "same qubit again. What do you expect?"
                ),
                options=_opts(
                    a="1 again, because the measurement left the qubit in the state |1⟩",
                    b="0 or 1 with the original probabilities, as if the first measurement had never happened",
                    c="0, because the outcome 1 has been used up",
                    d="No result at all, because measuring destroys the qubit",
                ),
                correct_option_id="a",
                explanation=(
                    "A measurement leaves the qubit in the basis state it reported, so measuring |1⟩ again "
                    "gives 1 with certainty. The original probabilities describe the state before the first "
                    "measurement, not after it, and the qubit is not destroyed."
                ),
                concept="qubits-measurement",
            ),
            ExplanationSection(
                id="s8",
                title="Where this leads",
                body=(
                    "You now have the core vocabulary: state, amplitude, basis state, measurement. What is "
                    "missing is a picture. Next, the Bloch sphere places every one-qubit state on a single "
                    "sphere, so you can see where |0⟩, |1⟩ and all the blends between them live, and how "
                    "gates move a state around."
                ),
            ),
            ReflectionSection(
                id="s9",
                title="Reflect",
                prompt=(
                    "A qubit's state before measurement holds two amplitudes, but a measurement returns a "
                    "single classical bit. What does one measurement tell you about the state, what is "
                    "lost, and how could you learn more about the amplitudes?"
                ),
            ),
        ],
        prerequisite_lesson_ids=[],
    ),
    # ------------------------------------------------------------------ 2
    Lesson(
        id="bloch-sphere",
        title="Bloch Sphere",
        short_description="A geometric picture of a single qubit's state.",
        concept="bloch-sphere",
        difficulty="beginner",
        estimated_minutes=16,
        learning_objectives=[
            "Locate |0⟩, |1⟩, |+⟩, |−⟩, |+i⟩ and |−i⟩ on the Bloch sphere.",
            "Read measurement probabilities from a point's height and phase from its angle around the equator.",
            "Describe common gates as rotations of the sphere.",
            "Distinguish global phase, which does not move the point, from relative phase, which does.",
            "Explain why the Bloch sphere describes one qubit at a time.",
        ],
        linked_circuit=Circuit(
            num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="s", targets=[0])]
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="A map for one qubit",
                body=(
                    "A qubit's state has two complex amplitudes, but once you ignore normalisation and an "
                    "overall phase only two real numbers are left. Two numbers are exactly what you need to "
                    "name a point on a sphere, so every state of a single qubit can be drawn as a point on "
                    "the Bloch sphere. It is a map of the state, not a physical ball."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Poles, equator and named states",
                body=(
                    "The state |0⟩ sits at the north pole and |1⟩ at the south pole, so height tells you the "
                    "measurement probabilities. States on the equator are equal blends of |0⟩ and |1⟩ that "
                    "differ only in phase: |+⟩ = (|0⟩ + |1⟩)/√2 and |−⟩ = (|0⟩ − |1⟩)/√2 lie on opposite "
                    "sides along the x-axis, while |+i⟩ = (|0⟩ + i|1⟩)/√2 and |−i⟩ = (|0⟩ − i|1⟩)/√2 lie "
                    "along the y-axis."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Gates as rotations",
                body=(
                    "Every single-qubit gate rotates the sphere. X turns it half a turn about the x-axis, "
                    "swapping north and south. Z turns it half a turn about the z-axis, leaving the poles "
                    "fixed and changing only phase. H swaps the z-axis and the x-axis. For example, from |0⟩ "
                    "at the north pole, H lands on |+⟩ on the equator, and S then slides it a quarter of the "
                    "way around the equator to |+i⟩. That is textbook geometry; the lab below runs it for "
                    "real, and the trace shows coordinates computed by the backend."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Global phase and relative phase",
                body=(
                    "Multiplying the whole state by a phase such as −1 or i changes nothing you can measure, "
                    "and it does not move the point on the sphere. A phase between the |0⟩ part and the |1⟩ "
                    "part does move the point, around the equator. That is why |+⟩ and |−⟩ are different "
                    "states even though a computational-basis measurement treats them alike."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: following a gate",
                prompt="Follow a state through a gate on the Bloch sphere.",
                question="A qubit sits at the north pole of the Bloch sphere and you apply an X gate. Where does it end up?",
                options=_opts(
                    a="On the equator at |+⟩, halfway between the two poles",
                    b="At the south pole, in the state |1⟩",
                    c="Still at the north pole, with only its phase changed",
                    d="At the centre of the sphere, where the state is undetermined",
                ),
                correct_option_id="b",
                explanation=(
                    "X is a half turn about the x-axis, which swaps the poles, so |0⟩ becomes |1⟩. Moving to "
                    "the equator is what H does, a change of phase without a change of position is the kind "
                    "of thing Z does, and a pure single-qubit state is never at the centre."
                ),
                concept="bloch-sphere",
            ),
            InteractiveLabSection(
                id="s6",
                title="Trace H, then S",
                instructions=(
                    "Open the lab circuit (H then S on one qubit), run it, and open the trace. Step through "
                    "it and watch the Bloch vector: the north pole at the start, the equator after H, and a "
                    "further quarter turn around the equator after S. Every coordinate shown is computed by "
                    "the backend from the real state, not drawn from this text."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: two points, one measurement",
                prompt="Explain why two states with the same measurement statistics can be different points.",
                question=(
                    "The states |+⟩ and |−⟩ both give an even split between 0 and 1 when measured in the "
                    "computational basis. Why are they different points on the Bloch sphere?"
                ),
                options=_opts(
                    a="They have different probabilities of giving 1",
                    b="One is a superposition and the other is not",
                    c="They differ only by a global phase, which the sphere still shows",
                    d="They have a different relative phase, which puts them at opposite points on the equator",
                ),
                correct_option_id="d",
                explanation=(
                    "Both states are equal blends of |0⟩ and |1⟩, so their measurement probabilities match. "
                    "What differs is the sign between the two parts — a relative phase — and relative phase "
                    "is the angle around the equator. A global phase, by contrast, would not move the point "
                    "at all."
                ),
                concept="bloch-sphere",
            ),
            ExplanationSection(
                id="s8",
                title="Limits of the picture",
                body=(
                    "The Bloch sphere describes one qubit at a time. Two qubits need far more numbers than "
                    "two spheres can hold, and entangled qubits, which you will meet soon, cannot each be "
                    "given a point of their own. That is why Qentor offers a Bloch sphere only for one-qubit "
                    "traces. Next comes superposition: the equator of this sphere, and the H gate that takes "
                    "you there."
                ),
            ),
            ReflectionSection(
                id="s9",
                title="Reflect",
                prompt=(
                    "Height on the Bloch sphere sets the measurement probabilities, and the angle around it "
                    "sets the phase. Why can two different states look identical to a computational-basis "
                    "measurement, and where would you look to see the difference?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["qubits-measurement"],
        no_challenge_reason=(
            "This lesson is about reading where a single qubit's state sits on the sphere, which the Trace shows; "
            "it has no one circuit to build, and the single-qubit goals that can be checked already have challenges "
            "under Superposition and Phase."
        ),
    ),
    # ------------------------------------------------------------------ 3
    Lesson(
        id="superposition",
        title="Superposition",
        short_description="A qubit can be in more than one basis state at once.",
        concept="superposition",
        difficulty="beginner",
        estimated_minutes=15,
        learning_objectives=[
            "Describe what the Hadamard gate does to |0⟩ and |1⟩.",
            "Tell amplitudes apart from probabilities, and get one from the other.",
            "Explain why a superposed qubit is not a classical bit with hidden randomness.",
            "Use repeated measurement to estimate probabilities.",
        ],
        linked_circuit=Circuit(
            num_qubits=1,
            num_clbits=1,
            ops=[GateOp(gate="h", targets=[0]), GateOp(gate="measure", targets=[0], clbits=[0])],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="More than a coin toss",
                body=(
                    "A classical bit can be uncertain: a coin you have not looked at is either heads or "
                    "tails, you just do not know which. A qubit in superposition is different. Its state is a "
                    "definite combination of |0⟩ and |1⟩, and that combination has physical consequences. "
                    "The Hadamard gate, H, is the standard tool for creating one."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="The Hadamard gate",
                body=(
                    "H takes |0⟩ to (|0⟩ + |1⟩)/√2, called |+⟩, and takes |1⟩ to (|0⟩ − |1⟩)/√2, called |−⟩. "
                    "Each basis state comes out with an amplitude of size 1/√2. The gate is reversible: "
                    "applying H twice returns every state to where it started."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Amplitudes versus probabilities",
                body=(
                    "Squaring an amplitude's size gives a probability. For |+⟩ each amplitude has size 1/√2, "
                    "so each outcome has probability 1/2: an even split. Amplitudes can be negative or "
                    "complex and can cancel one another, while probabilities are never negative and always "
                    "add up to 1. Keeping the two apart is the key to reading quantum circuits."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Example: two Hadamards in a row",
                body=(
                    "Apply H to |0⟩ and you get an even split of outcomes. Apply H a second time and, by "
                    "textbook algebra, you are back at |0⟩ with certainty. A coin that was randomised twice "
                    "would still be random, so a superposition cannot be just hidden randomness. The two "
                    "routes to each outcome carry amplitudes that add or cancel, the idea the Interference "
                    "lesson develops."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: from amplitude to probability",
                prompt="Turn an amplitude into a measurement probability.",
                question=(
                    "After H is applied to |0⟩, each basis state has an amplitude of size 1/√2. If you "
                    "measure the qubit, what is the probability of reading 1?"
                ),
                options=_opts(
                    a="1/√2, the size of the amplitude",
                    b="1/2, the square of the size of the amplitude",
                    c="1, because both outcomes are present in the state",
                    d="It cannot be said, because superposition makes the outcome unpredictable even in principle",
                ),
                correct_option_id="b",
                explanation=(
                    "The Born rule turns an amplitude into a probability by squaring its size: (1/√2)² = 1/2. "
                    "The amplitude 1/√2 is not itself a probability, and both outcomes being present in the "
                    "state does not make each one certain — the probabilities must add up to 1. The rule "
                    "gives a definite probability even though each single run is random."
                ),
                concept="superposition",
            ),
            InteractiveLabSection(
                id="s6",
                title="Experiment: repeat H and measure",
                instructions=(
                    "Open the lab circuit (H, then a measurement) and run it in shots mode. The counts you "
                    "see come from a real backend run, so they will usually be close to an even split but "
                    "not exactly equal: that spread is real sampling, not something written here. Run it a "
                    "few times, then open the trace to see the qubit's amplitudes right after H, before the "
                    "measurement collapses them."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: superposition versus a coin",
                prompt="Say what separates a superposition from classical randomness.",
                question=(
                    "A fair coin is randomised, and then randomised again by the same process. A qubit "
                    "starts in |0⟩ and gets H and then H again. What is the key difference between the two?"
                ),
                options=_opts(
                    a="There is no difference: both end up with an even split of outcomes",
                    b="The qubit ends in |1⟩ with certainty",
                    c="The qubit returns to |0⟩ with certainty, while the coin stays random",
                    d="The qubit's second H has no effect, because the state is already a mixture",
                ),
                correct_option_id="c",
                explanation=(
                    "Two Hadamards return |0⟩ to |0⟩ because the amplitudes for outcome 1 cancel. A "
                    "randomised coin has no amplitudes to cancel, so randomising it again cannot restore a "
                    "definite outcome. That difference is why superposition is more than classical "
                    "uncertainty."
                ),
                concept="superposition",
            ),
            ExplanationSection(
                id="s8",
                title="Where this leads",
                body=(
                    "H creates equal amplitudes, but so far every amplitude has been positive. The "
                    "amplitudes of a state also carry a sign or, more generally, a phase. Next you will see "
                    "how a phase changes the state without changing a single measurement probability, and "
                    "how a later gate can turn it into something you can measure."
                ),
            ),
            ReflectionSection(
                id="s9",
                title="Reflect",
                prompt=(
                    "A colleague says a qubit in superposition is really just 0 or 1 and we do not know "
                    "which. Using what H followed by H does, how would you show them why that description "
                    "falls short?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["qubits-measurement"],
    ),
    # ------------------------------------------------------------------ 4
    Lesson(
        id="phase",
        title="Phase",
        short_description="The part of a qubit's state that measurement alone can't see.",
        concept="phase",
        difficulty="beginner",
        estimated_minutes=15,
        learning_objectives=[
            "Distinguish global phase from relative phase.",
            "Describe what the Z and S gates do to |1⟩.",
            "Explain why a phase change leaves computational-basis probabilities alone.",
            "Explain why phase becomes observable only through interference.",
        ],
        linked_circuit=Circuit(
            num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="z", targets=[0])]
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="The part measurement can't see",
                body=(
                    "Every amplitude has a size and a phase. Picture each amplitude as an arrow: its length "
                    "sets the probability and its direction is the phase. A computational-basis measurement "
                    "looks only at lengths. Two states can have the same lengths and different directions, "
                    "so they behave identically when measured right away, but not necessarily afterwards."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Global and relative phase",
                body=(
                    "Turning both arrows together, by multiplying the whole state by a phase like −1 or i, "
                    "is a global phase. It changes nothing observable, and the two states are treated as the "
                    "same. Turning only one arrow relative to the other is a relative phase, and it does "
                    "change the state: (|0⟩ + |1⟩)/√2 and (|0⟩ − |1⟩)/√2 are different states even though "
                    "their measurement probabilities match."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="The Z and S gates",
                body=(
                    "Z leaves |0⟩ alone and multiplies |1⟩ by −1, a half turn of its arrow. S multiplies |1⟩ "
                    "by i, a quarter turn, and T an eighth of a turn. These gates change only relative "
                    "phase, so they never alter the probabilities of a computational-basis measurement; they "
                    "only move the arrow that later gates will use."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Example: H, then Z",
                body=(
                    "H turns |0⟩ into (|0⟩ + |1⟩)/√2. Z then flips the sign of the |1⟩ part, giving "
                    "(|0⟩ − |1⟩)/√2. Measured now, the two outcomes are still equally likely, exactly as "
                    "they were before Z: the state changed but its measurement statistics did not. The lab "
                    "below runs this circuit so you can see the amplitudes the backend reports."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: what Z changes",
                prompt="Say how a Z gate affects immediate measurement probabilities.",
                question=(
                    "Z is applied to the state (|0⟩ + |1⟩)/√2, and the qubit is measured straight away in the "
                    "computational basis. How do the outcome probabilities compare with measuring before Z?"
                ),
                options=_opts(
                    a="They are unchanged, because Z only changes the phase of the |1⟩ part",
                    b="0 becomes certain, because Z acts like a reset",
                    c="1 becomes certain, because Z flips the sign of the |1⟩ part",
                    d="The two probabilities swap, because Z flips the qubit",
                ),
                correct_option_id="a",
                explanation=(
                    "Z multiplies the |1⟩ amplitude by −1. Probabilities come from the squared size of each "
                    "amplitude, and the size does not change when the sign does. Z is not a bit flip (that "
                    "is X) and it does not reset the qubit."
                ),
                concept="phase",
            ),
            InteractiveLabSection(
                id="s6",
                title="Run H, then Z",
                instructions=(
                    "Open the lab circuit (H then Z) and run it in statevector mode. Compare its amplitudes "
                    "with those of H on its own: the backend's numbers show which amplitude differs, and "
                    "the probabilities are unchanged. Then open the trace to follow the state one gate at a "
                    "time."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: detectable or not",
                prompt="Tell a global phase change from a relative one.",
                question=(
                    "A qubit is in the state α|0⟩ + β|1⟩. Which of these changes could no experiment ever "
                    "detect?"
                ),
                options=_opts(
                    a="Swapping α and β",
                    b="Multiplying only β by −1",
                    c="Multiplying only α by i",
                    d="Multiplying both α and β by −1",
                ),
                correct_option_id="d",
                explanation=(
                    "Multiplying both amplitudes by the same phase is a global phase and has no observable "
                    "effect. Swapping α and β is an X gate, and multiplying just one amplitude changes the "
                    "relative phase, which later gates can turn into different measurement results."
                ),
                concept="phase",
            ),
            ExplanationSection(
                id="s8",
                title="Phase shows up through interference",
                body=(
                    "A relative phase cannot be seen by measuring right away, but a later gate can turn it "
                    "into a difference in outcomes. Send (|0⟩ + |1⟩)/√2 and (|0⟩ − |1⟩)/√2 through H and the "
                    "first becomes |0⟩ while the second becomes |1⟩. That is the trick behind many quantum "
                    "algorithms, and the subject of the next lesson: interference."
                ),
            ),
            ReflectionSection(
                id="s9",
                title="Reflect",
                prompt=(
                    "Global phase cannot be detected, but relative phase can. Beyond measuring right away, "
                    "what would you have to do to a qubit to find out whether its relative phase is a plus "
                    "or a minus?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["superposition"],
    ),
    # ------------------------------------------------------------------ 5
    Lesson(
        id="interference",
        title="Interference",
        short_description="How phase differences combine to change measurement outcomes.",
        concept="interference",
        difficulty="intermediate",
        estimated_minutes=18,
        learning_objectives=[
            "Explain interference as amplitudes adding or cancelling before probabilities are formed.",
            "Trace H, Z, H by hand and find where the cancellation happens.",
            "Tell constructive from destructive interference.",
            "Describe how a phase change redistributes probability between outcomes.",
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
                id="s1",
                title="Waves add, and so do amplitudes",
                body=(
                    "Two ripples on water can reinforce each other or cancel out, and quantum amplitudes "
                    "behave the same way. When a state can reach an outcome in more than one way, you add "
                    "the amplitudes for those routes first, and only then square the result to get a "
                    "probability. Routes with opposite signs can cancel."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Constructive and destructive",
                body=(
                    "If the routes to an outcome have the same sign, their amplitudes reinforce and the "
                    "outcome becomes more likely: constructive interference. If they have opposite signs "
                    "they cancel and the outcome becomes less likely, possibly impossible: destructive "
                    "interference. Probabilities themselves never subtract; it is amplitudes that add and "
                    "then get squared."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Walkthrough: H, Z, H",
                body=(
                    "Start with |0⟩. H gives (|0⟩ + |1⟩)/√2. Z flips the sign of the |1⟩ part, giving "
                    "(|0⟩ − |1⟩)/√2. The second H sends each part to both outcomes. For outcome 0 the two "
                    "routes arrive with opposite signs and cancel; for outcome 1 they arrive with the same "
                    "sign and reinforce, leaving |1⟩ with certainty. That is textbook algebra; the lab runs "
                    "the circuit on the backend."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Probability is redistributed",
                body=(
                    "Interference does not create or destroy probability; the total always stays 1. It moves "
                    "probability between outcomes. Take out the Z, so it is just H and then H, and the same "
                    "cancellation happens at outcome 1, so 0 becomes certain instead. The phase you insert "
                    "between the two Hadamards decides where the probability goes."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: where the cancellation is",
                prompt="Explain why one outcome never occurs in H, Z, H.",
                question=(
                    "A qubit starts in |0⟩, goes through H, then Z, then H, and is measured. Why is the "
                    "outcome 0 never observed?"
                ),
                options=_opts(
                    a="Z is a bit flip, so it turns the qubit into |1⟩ and nothing afterwards can change that",
                    b="Z measures the qubit, and the measurement leaves it in |1⟩",
                    c="The two routes to outcome 0 arrive with opposite signs and cancel",
                    d="The probabilities of the two routes to outcome 0 subtract to zero",
                ),
                correct_option_id="c",
                explanation=(
                    "Interference happens between amplitudes, not probabilities. The two routes to outcome 0 "
                    "carry opposite signs after Z, so their amplitudes add to zero. Z is a phase gate, not a "
                    "bit flip or a measurement, and probabilities are never subtracted from one another."
                ),
                concept="interference",
            ),
            InteractiveLabSection(
                id="s6",
                title="Run H, Z, H — then remove the Z",
                instructions=(
                    "Open the lab circuit (H, Z, H, then a measurement) and run it; the result comes from a "
                    "real backend execution. Then delete the Z gate from the circuit in the Lab and run it "
                    "again to see what the same two Hadamards do without it. Open the trace to follow the "
                    "state after each gate."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: H then H",
                prompt="Predict the outcome of two Hadamards with nothing between them.",
                question=(
                    "The circuit H then H is applied to |0⟩ with no gate between them, and the qubit is "
                    "measured. Which outcome is certain, and why?"
                ),
                options=_opts(
                    a="Outcome 1, because two gates always flip a qubit",
                    b="Outcome 0, because the routes to outcome 1 cancel and the routes to outcome 0 reinforce",
                    c="Neither: two Hadamards randomise the qubit twice, so each outcome stays equally likely",
                    d="Outcome 0, because H does nothing to |0⟩",
                ),
                correct_option_id="b",
                explanation=(
                    "The first H creates an even superposition. In the second H the two routes to outcome 1 "
                    "have opposite signs and cancel, while the routes to outcome 0 reinforce. H does change "
                    "|0⟩, and randomising twice is exactly what does not happen here."
                ),
                concept="interference",
            ),
            ExplanationSection(
                id="s8",
                title="Where this leads",
                body=(
                    "So far a single qubit's amplitudes have interfered with themselves. Next you will meet "
                    "two qubits at once, where a joint state can link the qubits so tightly that neither has "
                    "a state of its own: entanglement. Interference will still be at work there, and you "
                    "will see it again in the algorithms that come later."
                ),
            ),
            ReflectionSection(
                id="s9",
                title="Reflect",
                prompt=(
                    "In H, Z, H the probability of outcome 0 seems to vanish. Where has it gone, and what "
                    "single change to the circuit would bring it back? What does that tell you about the "
                    "difference between adding probabilities and adding amplitudes?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["phase"],
    ),
    # ------------------------------------------------------------------ 6
    Lesson(
        id="entanglement",
        title="Entanglement",
        short_description="A joint state of two qubits that can't be described separately.",
        concept="entanglement",
        difficulty="intermediate",
        estimated_minutes=18,
        learning_objectives=[
            "Read a two-qubit state and say what its four amplitudes mean.",
            "Distinguish a separable (product) state from an entangled one.",
            "Build an entangled pair with H followed by CX.",
            "Contrast an entangled pair's correlations with two independent coin flips.",
            "Explain why one Bloch sphere cannot show one qubit of an entangled pair.",
        ],
        linked_circuit=Circuit(
            num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])]
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="One state for two qubits",
                body=(
                    "Two qubits have four basis states, 00, 01, 10 and 11, and a two-qubit state gives an "
                    "amplitude to each. Qentor writes these bitstrings with the highest-numbered qubit on "
                    "the left, so 01 means qubit 1 is 0 and qubit 0 is 1. Sometimes the joint state is just "
                    "two separate one-qubit states side by side. Sometimes it is not."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Separable or entangled",
                body=(
                    "A state is separable if it can be factored into one state for each qubit. For example, "
                    "qubit 0 in (|0⟩ + |1⟩)/√2 with qubit 1 in |0⟩ is (|00⟩ + |01⟩)/√2, which factors. An "
                    "entangled state cannot be factored: no choice of one state per qubit reproduces it. "
                    "The information is in the pair, not in the parts."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Making an entangled pair",
                body=(
                    "Apply H to qubit 0, giving (|00⟩ + |01⟩)/√2, then a CX gate with qubit 0 as the control "
                    "and qubit 1 as the target. CX flips the target only when the control is 1, so |01⟩ "
                    "becomes |11⟩ and |00⟩ stays put. The result is (|00⟩ + |11⟩)/√2, a state that cannot be "
                    "factored."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Correlation, not two coins",
                body=(
                    "Measure this pair and you see 00 or 11, each about equally often, and never 01 or 10. "
                    "Two independent qubits, each given its own H, would show all four results about "
                    "equally often. Two coins glued together can also give matching results, but "
                    "entanglement's correlations survive in other measurement bases in ways no fixed "
                    "classical recipe can copy, a fact known as Bell's theorem that goes beyond this lesson."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: spotting entanglement",
                prompt="Pick out the state that cannot be factored into one state per qubit.",
                question="Which of these two-qubit states is entangled?",
                options=_opts(
                    a="(|00⟩ + |01⟩)/√2",
                    b="|01⟩",
                    c="(|00⟩ + |01⟩ + |10⟩ + |11⟩)/2",
                    d="(|00⟩ + |11⟩)/√2",
                ),
                correct_option_id="d",
                explanation=(
                    "(|00⟩ + |11⟩)/√2 cannot be written as one state for qubit 1 times one state for "
                    "qubit 0. The others can: |01⟩ is a definite state for each qubit, (|00⟩ + |01⟩)/√2 is "
                    "|0⟩ on qubit 1 times an equal blend on qubit 0, and the four-term state is an equal "
                    "blend on each qubit."
                ),
                concept="entanglement",
            ),
            InteractiveLabSection(
                id="s6",
                title="Run H, then CX",
                instructions=(
                    "Open the lab circuit (H on qubit 0, then CX from qubit 0 to qubit 1) and run it in "
                    "statevector mode. The backend's amplitudes show which basis states are present. Open "
                    "the trace to step through the two gates, and notice that the trace lists the joint "
                    "amplitudes and offers no Bloch sphere for two qubits."
                ),
                capability="execute",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: entangled versus independent",
                prompt="Compare the outcome patterns of an entangled pair and two independent qubits.",
                question=(
                    "Circuit A gives each of two qubits its own H gate. Circuit B applies H to one qubit and "
                    "then CX. Both circuits are measured many times. What distinguishes the outcome "
                    "patterns?"
                ),
                options=_opts(
                    a="A shows all four outcomes about equally often, while B shows only 00 and 11",
                    b="Both show only 00 and 11, but B shows them more often",
                    c="A shows only 00 and 11, while B shows all four outcomes",
                    d="The counts are the same for both; only the amplitudes differ",
                ),
                correct_option_id="a",
                explanation=(
                    "Independent Hadamards give each qubit its own fair coin, so all four outcomes occur. "
                    "In circuit B the CX ties the second qubit to the first, so only the matching outcomes "
                    "00 and 11 occur. The difference is visible directly in the counts."
                ),
                concept="entanglement",
            ),
            ExplanationSection(
                id="s8",
                title="Why one sphere cannot show it",
                body=(
                    "Look at just one qubit of the pair. On its own it gives 0 and 1 with equal probability, "
                    "like a fair coin, whichever basis you choose. On a Bloch sphere it would have to sit at "
                    "the very centre of the ball, which is not a point on the sphere. The pair has structure "
                    "that neither qubit has alone, so no single sphere can show it, and Qentor draws no Bloch "
                    "sphere for two-qubit traces. Next, the Bell state lesson takes this exact circuit and "
                    "asks how to check that it worked."
                ),
            ),
            ReflectionSection(
                id="s9",
                title="Reflect",
                prompt=(
                    "Describe an experiment that could tell an entangled pair from two independent qubits "
                    "that merely happen to give matching results in one basis. What would you measure, and "
                    "what would each case predict?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["superposition"],
        no_challenge_reason=(
            "Its lab builds the same two-qubit entangling circuit that the Bell State lesson's challenge checks, "
            "so a challenge here would repeat that one."
        ),
    ),
    # ------------------------------------------------------------------ 7
    Lesson(
        id="bell-state",
        title="Bell State",
        short_description="The simplest maximally entangled two-qubit state, and how it's verified.",
        concept="bell-state",
        difficulty="intermediate",
        estimated_minutes=18,
        learning_objectives=[
            "Build the Bell state (|00⟩ + |11⟩)/√2 with H and CX.",
            "Predict the measurement outcomes of a Bell pair, including what one result says about the other.",
            "Describe exactly what Qentor's Bell verifier checks, and what it does not.",
            "Relate the Bell state to entanglement.",
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
                id="s1",
                title="The simplest entangled pair",
                body=(
                    "The Bell states are four two-qubit states that are as entangled as two qubits can be. "
                    "Qentor builds the one usually written |Φ⁺⟩ = (|00⟩ + |11⟩)/√2. It is the standard "
                    "test case for an entanglement circuit because both what it should do and how a run can "
                    "go wrong are easy to state."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="Construction",
                body=(
                    "Put qubit 0 through H, then apply CX with qubit 0 as the control and qubit 1 as the "
                    "target. Written with qubit 1 on the left, the state goes |00⟩ → (|00⟩ + |01⟩)/√2 → "
                    "(|00⟩ + |11⟩)/√2. The order matters: CX before H would leave the two qubits "
                    "unentangled."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="What to expect when measured",
                body=(
                    "Measure both qubits in the computational basis and, in an ideal run, only 00 and 11 "
                    "appear, each about equally often. Whenever one qubit reads 1 the other does too, so one "
                    "result tells you the other, yet each qubit on its own looks like a fair coin. Real "
                    "hardware adds noise, so an unwanted 01 or 10 can occasionally show up there; Qentor's "
                    "simulator runs are ideal."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="What the Bell verifier checks",
                body=(
                    "Qentor's verifier runs nothing itself: it takes a real, already-executed result and "
                    "checks it against the circuit. It confirms that the circuit is exactly H then CX on two "
                    "qubits, that the result belongs to this circuit and ran successfully, that only 00 and "
                    "11 were observed, and that both were seen. A circuit outside that pattern is reported "
                    "as unverifiable, not as wrong."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: reading one qubit",
                prompt="Say what one qubit's result tells you about the other in a Bell pair.",
                question=(
                    "You measure both qubits of the Bell state (|00⟩ + |11⟩)/√2 and the first qubit reads 1. "
                    "What can you say about the second qubit's result?"
                ),
                options=_opts(
                    a="It is 0 or 1 with equal probability, because the qubits are independent",
                    b="It reads 1, because the outcomes 01 and 10 never occur",
                    c="It reads 0, because the two qubits always disagree",
                    d="Nothing, until it is measured in a different basis",
                ),
                correct_option_id="b",
                explanation=(
                    "In this state only 00 and 11 have any amplitude, so the two results always match. The "
                    "qubits are not independent, they do not disagree, and no change of basis is needed to "
                    "predict the second result from the first."
                ),
                concept="bell-state",
            ),
            InteractiveLabSection(
                id="s6",
                title="Run it, then verify it",
                instructions=(
                    "Open the lab circuit (H, CX, then a measurement of each qubit), run it in shots mode, "
                    "and then run the Bell verifier on that result. The counts and the verifier's checks "
                    "come from the backend; read each check to see exactly what passed. Then change the "
                    "circuit, for instance by moving the H, and verify again to see what the verifier "
                    "reports."
                ),
                capability="verify_bell_state",
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: what VERIFIED means",
                prompt="Say what a passed Bell verification does and does not establish.",
                question=(
                    "The Bell verifier reports VERIFIED for a shots run in which only 00 and 11 appeared. "
                    "What does that establish, and what does it leave open?"
                ),
                options=_opts(
                    a="It proves the qubits were entangled, so nothing further about the circuit needs checking",
                    b="It proves the amplitude on |11⟩ has a positive sign",
                    c="The outcomes match the Bell pattern; the check looks only at which outcomes occurred, not at phases or other bases",
                    d="It proves the two outcome counts were exactly equal",
                ),
                correct_option_id="c",
                explanation=(
                    "The verifier compares the set of observed outcomes with the set a Bell circuit allows. "
                    "That is a solid necessary condition, but it does not look at phases, exact counts or "
                    "measurements in other bases, so it is not a proof of entanglement on its own."
                ),
                concept="bell-state",
            ),
            ExplanationSection(
                id="s8",
                title="The Bell state and entanglement",
                body=(
                    "The Bell state is entangled: no state for qubit 0 times a state for qubit 1 reproduces "
                    "it, which is why its outcomes are so tightly linked. A verifier that checks which "
                    "outcomes occur gives a solid necessary condition, not a full proof; for that you would "
                    "compare amplitudes or measure in more than one basis. From here, superposition, phase "
                    "and entanglement are the ingredients of the algorithms that come next."
                ),
            ),
            ReflectionSection(
                id="s9",
                title="Reflect",
                prompt=(
                    "Suppose the verifier reported FAILED because 01 appeared. List two things that could "
                    "explain it, one about the circuit and one about the run, and say how you would tell "
                    "them apart."
                ),
            ),
        ],
        prerequisite_lesson_ids=["entanglement"],
    ),
]
