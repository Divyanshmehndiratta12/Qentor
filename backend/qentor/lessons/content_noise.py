"""Lesson 19: Understanding Quantum Noise (the Noise Lab sprint).

Same architecture and rules as every other lesson (``models.py`` types, ten sections, concept checks graded by the server from ``grading.py``,
content checked by ``qentor.content.validation``). It is a small educational lesson about ONE comparison: the same circuit run ideally and under a
named, SIMULATED noise model on Qiskit Aer, compared by the server (``docs/NOISE_LAB.md``).

* it teaches ideal versus noisy execution, why repeated shots give a distribution, gate noise, readout error, and why a circuit with more gates is,
  on average, disturbed more by gate noise;
* it says plainly that the noise is a simulation of simple textbook models and not a model of any real device, and that no hardware is used.

Prose rules (tests enforce them): no decimal or percentage, no number a run produced, no multi-qubit ket, every worked piece of reasoning labelled
textbook, no claim of hardware, advantage or speedup. The numbers a learner sees come from the Noise Lab, computed by the server.
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


def _op(gate: str, targets: list[int], controls: list[int] | None = None, clbits: list[int] | None = None) -> GateOp:
    return GateOp(gate=gate, targets=targets, controls=controls or [], params=[], clbits=clbits or [])


NOISE_LESSONS: list[Lesson] = [
    Lesson(
        id="quantum-noise",
        title="Understanding Quantum Noise",
        short_description="Run one circuit ideally and under simulated noise, and see what changes: a small educational comparison on a simulator, not a real device.",
        concept="quantum-noise",
        difficulty="intermediate",
        estimated_minutes=20,
        learning_objectives=[
            "Say what is different between an ideal run and a noisy run of the same circuit.",
            "Explain why repeated shots give a distribution of outcomes, even for an ideal circuit.",
            "Describe gate noise and readout error, and say where each one acts.",
            "Explain why a circuit with more gates is generally disturbed more by gate noise.",
            "Read an ideal-versus-noisy comparison carefully, and say plainly that the noise here is simulated.",
        ],
        linked_circuit=Circuit(
            num_qubits=2,
            num_clbits=2,
            ops=[_op("h", [0]), _op("cx", [1], [0]), _op("measure", [0], clbits=[0]), _op("measure", [1], clbits=[1])],
        ),
        sections=[
            ExplanationSection(
                id="s1",
                title="Ideal and noisy runs",
                body=(
                    "An ideal simulation applies every gate perfectly. A noisy simulation applies the same gates but lets small random errors "
                    "creep in, the way real devices are disturbed by their surroundings. This lesson compares the two runs of one circuit. The "
                    "noise here is simulated: the server runs the circuit twice on a simulator, once ideally and once under a named noise model, "
                    "and compares the results. It is a simulation of simple textbook error models, not a model of any real device, and no "
                    "hardware is used."
                ),
            ),
            ExplanationSection(
                id="s2",
                title="A run is a sample",
                body=(
                    "Measuring a circuit once gives one outcome. Running it many times, each run called a shot, gives a spread of outcomes, "
                    "and the counts are a sample of the circuit's outcome distribution. Even an ideal circuit gives a spread: a circuit that puts "
                    "a qubit in an equal superposition gives zeros and ones in roughly equal numbers, and two runs of it differ a little. That is "
                    "why a small difference between two runs is not by itself evidence of noise. This is textbook reasoning; the Noise Lab "
                    "shows the counts the server's simulator actually returned."
                ),
            ),
            ExplanationSection(
                id="s3",
                title="Gate noise",
                body=(
                    "Gate noise is an error that can happen right after a gate. In the depolarizing model, each qubit the gate touched is, with "
                    "some probability, replaced by a completely random state. A bit-flip model swaps zero and one with some probability, a "
                    "phase-flip model flips a sign that a plain zero-or-one measurement cannot see directly, and an amplitude-damping model lets a "
                    "one decay towards zero. In every case the error acts on the qubits a gate touched, so a gate on two qubits gives noise two "
                    "places to act. This is textbook reasoning about the models as the server implements them."
                ),
            ),
            ExplanationSection(
                id="s4",
                title="Readout error",
                body=(
                    "Readout error is different: it does not change the quantum state, only what is reported when a qubit is measured. With some "
                    "probability a measured zero is reported as a one, or the other way round. A circuit with no gates gives gate noise nothing to "
                    "act on, but readout error can still change what you read. This is textbook reasoning about the readout model."
                ),
            ),
            ConceptCheckSection(
                id="s5",
                title="Check: where noise acts",
                prompt="Think about which noise changes the quantum state and which only changes the report.",
                question="Which kind of noise can change what is reported without disturbing the quantum state before the measurement?",
                options=_opts(
                    a="Depolarizing noise after a gate",
                    b="Readout error at measurement",
                    c="Amplitude damping after a gate",
                    d="A bit flip after a gate",
                ),
                correct_option_id="b",
                explanation=(
                    "Readout error acts only when a qubit is measured: it changes the bit that is reported, not the state the qubit was in. "
                    "Depolarizing noise, amplitude damping and a bit flip all act after a gate, on the quantum state itself, before any "
                    "measurement is made."
                ),
                concept="quantum-noise",
            ),
            ExplanationSection(
                id="s6",
                title="Why deeper circuits are more sensitive",
                body=(
                    "Gate noise acts after every gate, so a circuit with more gates gives it more chances to act. Two circuits can give the same "
                    "answer in an ideal simulation and different answers under noise: the one with fewer gates, and with gates that touch fewer "
                    "qubits, is on average disturbed less. This is textbook reasoning for the models used here, and it is the reason shorter "
                    "circuits are valued when noise is present. It describes a tendency over many shots, not a promise about any single shot."
                ),
            ),
            ConceptCheckSection(
                id="s7",
                title="Check: gates that cancel",
                prompt="Think about what each gate gives noise a chance to do, even if its effect cancels in an ideal run.",
                question=(
                    "Two circuits give the same outcome in an ideal simulation. One has many gates that cancel each other out and the other has "
                    "none. Under gate noise that acts after every gate, which is generally disturbed more?"
                ),
                options=_opts(
                    a="The longer one, because each extra gate is another chance for noise to act, even if it cancels in an ideal run",
                    b="The shorter one, because with fewer gates it has more time to recover from any error that happens",
                    c="Neither, because a gate that cancels another in an ideal run also cancels the noise that follows it",
                    d="Both equally, because gate noise depends only on how the qubits are measured at the end of the run",
                ),
                correct_option_id="a",
                explanation=(
                    "In an ideal run the cancelling gates leave no trace. Under gate noise each of them is followed by a chance of an error, "
                    "and an error does not undo itself when the gates around it cancel. So the longer circuit collects more noise on "
                    "average. The shorter one does not correct itself, noise does not cancel along with the gates, and gate noise does not "
                    "depend only on the measurement."
                ),
                concept="quantum-noise",
            ),
            ExplanationSection(
                id="s8",
                title="Reading a comparison carefully",
                body=(
                    "The Noise Lab shows the ideal counts and the noisy counts side by side, with a few numbers the server computes from them, "
                    "such as how far apart the two sampled distributions are and which outcomes only the noisy run produced. The browser does "
                    "not calculate them. Treat a difference with care: both runs are finite samples, so compare a difference with the number "
                    "of shots before blaming noise. And remember that some noise cannot show up in some measurements: a phase flip, for example, "
                    "may leave the counts of a plain zero-or-one measurement unchanged."
                ),
            ),
            InteractiveLabSection(
                id="s9",
                title="Lab: ideal versus noisy",
                instructions=(
                    "Open the Noise Lab with the lab circuit, a Bell pair that is measured. Run it with no noise first. Then choose depolarizing "
                    "noise and run it again, and look at which outcomes appear that the ideal run never gave. Change the strength and run "
                    "again. Then try readout error, and a bit flip or a phase flip, and see which models change the counts and which do not "
                    "for this circuit. Every count and every difference is produced by the server's simulator, and the noise is simulated."
                ),
                capability="noise_compare",
            ),
            ReflectionSection(
                id="s10",
                title="Reflect",
                prompt=(
                    "Pick a noise model and a circuit. Before you run it, say what you expect to change and why. After you run it, compare: "
                    "where did your expectation hold, and where did the circuit or the model surprise you?"
                ),
            ),
        ],
        prerequisite_lesson_ids=["bell-state"],
        # Its challenge (``noise-shorten-circuit``) is judged on the server's own noisy simulation.
    ),
]
