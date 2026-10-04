"""Noisy simulation on Qiskit Aer: a closed set of named noise models, bounded parameters, and a run that is the SIMULATOR's own.

What this module is. The Noise Lab compares an ideal run of a circuit with a run of the SAME circuit under a named, parameterised
noise model. The noisy run is produced by ``qiskit_aer.AerSimulator`` with a ``qiskit_aer.noise.NoiseModel`` built here from
``(model name, strength)``; every count in the result comes from Aer's own ``Result``. Nothing in this module (or anywhere else in
Qentor) perturbs, resamples or "adds noise to" counts: a noisy result that did not come out of the simulator does not exist.

What it is not. It is a simulation of a textbook error model, not a model of any device: there is no calibration data, no crosstalk and
no relation to a real QPU. Every record it produces says ``noisy_shots`` and carries the model, the strength and the seed, and is a
SIMULATION. It is available on Aer only; Cirq and PennyLane have no noisy mode here and are not asked to fake one.

The models (each applies the same one-qubit error independently to every qubit a gate touches, right after the gate; readout error is
applied when a qubit is measured):

| name              | where        | meaning of ``strength``                                              |
|-------------------|--------------|----------------------------------------------------------------------|
| depolarizing      | after gates  | Aer ``depolarizing_error(p, 1)``: with probability p the qubit's state is replaced by the maximally mixed state |
| bit_flip          | after gates  | an X error with probability p                                        |
| phase_flip        | after gates  | a Z error with probability p                                         |
| amplitude_damping | after gates  | Aer ``amplitude_damping_error(gamma)``: |1> decays to |0> with probability gamma |
| readout_error     | at readout   | each measured bit is reported flipped with probability p             |

The method is fixed to ``density_matrix`` (exact noise, memory 4**n), not Aer's ``automatic``: the automatic choice on a noisy 16-qubit
circuit asked for 64 GB and failed, so a noisy run is limited to ``NOISE_MAX_QUBITS`` qubits, where a run of 500 operations measures well under
a second, and ``NOISE_MAX_SHOTS`` shots.
"""

from __future__ import annotations

import math
import secrets
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any

from qentor.circuit.model import Circuit, GateName

from .adapter import AdapterExecutionError, AdapterUnavailable, ExecutionResult
from .aer import build_qiskit_circuit

NOISY_SHOTS_MODE = "noisy_shots"
NOISE_SIMULATION_METHOD = "density_matrix"
NOISE_MAX_QUBITS = 8
NOISE_MAX_SHOTS = 20_000
SEED_MAX = 2**31 - 1


class NoiseModelName(str, Enum):
    NONE = "none"
    DEPOLARIZING = "depolarizing"
    BIT_FLIP = "bit_flip"
    PHASE_FLIP = "phase_flip"
    AMPLITUDE_DAMPING = "amplitude_damping"
    READOUT_ERROR = "readout_error"


@dataclass(frozen=True)
class NoiseModelSpec:
    """Everything the platform says about one model, in one place: the server's catalog (``GET /api/noise/models``) is built from it, so a
    range or a sentence shown in the browser is never a second copy that can drift."""

    name: NoiseModelName
    label: str
    applies_to: str  # "none" | "gates" | "measurement"
    parameter: str
    parameter_description: str
    min_strength: float
    max_strength: float
    default_strength: float
    step: float
    summary: str
    how_applied: str
    expect: tuple[str, ...]


NOISE_MODEL_SPECS: dict[NoiseModelName, NoiseModelSpec] = {
    NoiseModelName.NONE: NoiseModelSpec(
        name=NoiseModelName.NONE,
        label="None (ideal only)",
        applies_to="none",
        parameter="none",
        parameter_description="no noise parameter",
        min_strength=0.0,
        max_strength=0.0,
        default_strength=0.0,
        step=0.0,
        summary="Run only the ideal simulation of the circuit.",
        how_applied="No noise model is used; the circuit runs on the ideal simulator.",
        expect=(
            "Even an ideal simulation of a measured circuit gives a spread of counts, because each shot is one random sample of the circuit's outcome distribution; a second run with more or fewer shots changes the counts a little.",
        ),
    ),
    NoiseModelName.DEPOLARIZING: NoiseModelSpec(
        name=NoiseModelName.DEPOLARIZING,
        label="Depolarizing gate noise",
        applies_to="gates",
        parameter="error probability p",
        parameter_description="the probability that a qubit's state is replaced by the maximally mixed state right after a gate acts on it",
        min_strength=0.0,
        max_strength=0.3,
        default_strength=0.05,
        step=0.005,
        summary="After every gate, each qubit the gate touched is, with probability p, replaced by a completely random state.",
        how_applied="After every gate, the same one-qubit depolarizing error is applied independently to each qubit that gate touched (Aer depolarizing_error(p, 1)). Measurements themselves are not affected.",
        expect=(
            "A larger p makes the noisy distribution differ more from the ideal one: probability moves onto outcomes the ideal circuit never produces.",
            "Every gate is a chance for the error, so a circuit with more gates collects more of it: a deeper circuit is, on average, affected more than a shallow one at the same p.",
            "Depolarizing noise pushes the output towards a uniform spread over all outcomes, so the effect is easiest to see on a circuit whose ideal output is concentrated on a few outcomes.",
        ),
    ),
    NoiseModelName.BIT_FLIP: NoiseModelSpec(
        name=NoiseModelName.BIT_FLIP,
        label="Bit-flip gate noise",
        applies_to="gates",
        parameter="flip probability p",
        parameter_description="the probability of an X (bit-flip) error on a qubit right after a gate acts on it",
        min_strength=0.0,
        max_strength=0.5,
        default_strength=0.05,
        step=0.005,
        summary="After every gate, each qubit the gate touched is flipped (|0> and |1> swapped) with probability p.",
        how_applied="After every gate, an X error with probability p is applied independently to each qubit that gate touched (a Pauli error channel). Measurements themselves are not affected.",
        expect=(
            "A bit flip swaps 0 and 1 on that qubit, so it changes measured outcomes directly.",
            "A flip early in a circuit can be carried through later gates (a flip before a CX spreads to the target), so it is not always a single wrong bit at the end.",
        ),
    ),
    NoiseModelName.PHASE_FLIP: NoiseModelSpec(
        name=NoiseModelName.PHASE_FLIP,
        label="Phase-flip gate noise",
        applies_to="gates",
        parameter="flip probability p",
        parameter_description="the probability of a Z (phase-flip) error on a qubit right after a gate acts on it",
        min_strength=0.0,
        max_strength=0.5,
        default_strength=0.05,
        step=0.005,
        summary="After every gate, each qubit the gate touched gets a phase flip (Z) with probability p.",
        how_applied="After every gate, a Z error with probability p is applied independently to each qubit that gate touched (a Pauli error channel). Measurements themselves are not affected.",
        expect=(
            "A phase flip changes the relative sign between |0> and |1>, which a measurement in the 0/1 basis cannot see directly: on a circuit that measures right after preparing basis states the counts may not change at all.",
            "Its effect shows when later gates turn phase into amplitude, for example a Hadamard after the error, as in interference.",
        ),
    ),
    NoiseModelName.AMPLITUDE_DAMPING: NoiseModelSpec(
        name=NoiseModelName.AMPLITUDE_DAMPING,
        label="Amplitude-damping gate noise",
        applies_to="gates",
        parameter="decay probability gamma",
        parameter_description="the probability that |1> decays to |0> on a qubit right after a gate acts on it",
        min_strength=0.0,
        max_strength=0.5,
        default_strength=0.1,
        step=0.005,
        summary="After every gate, each qubit the gate touched relaxes from |1> towards |0> with probability gamma.",
        how_applied="After every gate, an amplitude-damping channel (Aer amplitude_damping_error(gamma)) is applied independently to each qubit that gate touched. Measurements themselves are not affected.",
        expect=(
            "Unlike the Pauli errors, this noise has a direction: it moves probability from outcomes with 1s towards outcomes with 0s, so the noisy counts of the all-ones outcome fall while the all-zeros outcome gains.",
            "Because it only moves |1> towards |0>, a circuit whose ideal output has no 1s is not changed by it.",
        ),
    ),
    NoiseModelName.READOUT_ERROR: NoiseModelSpec(
        name=NoiseModelName.READOUT_ERROR,
        label="Readout error",
        applies_to="measurement",
        parameter="flip probability p",
        parameter_description="the probability that a measured bit is reported as the opposite value",
        min_strength=0.0,
        max_strength=0.5,
        default_strength=0.05,
        step=0.005,
        summary="When a qubit is measured, the reported bit is flipped with probability p. The quantum state itself is not disturbed.",
        how_applied="Each measured bit is reported flipped with probability p, the same for 0 and 1 (Aer ReadoutError). Gates are not affected: only what is read out is.",
        expect=(
            "Readout error acts only on measurement: it is the one model here that cannot make a circuit's quantum state worse, only the reading of it.",
            "With several measured bits each one can flip, so the more bits a circuit measures, the more outcomes can differ from the ideal one.",
            "At p = 0.5 each reported bit is a fair coin, whatever the circuit did.",
        ),
    ),
}


class NoiseError(ValueError):
    """A noise request outside what the platform runs. Refused before any simulator is created, never clamped."""

    def __init__(self, code: str, message: str, *, limit: float | int | None = None, requested: float | int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.limit = limit
        self.requested = requested

    def detail(self) -> dict[str, Any]:
        detail: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.limit is not None:
            detail["limit"] = self.limit
        if self.requested is not None:
            detail["requested"] = self.requested
        return detail


@dataclass(frozen=True)
class NoiseConfig:
    """A validated noise request: a known model, a strength inside that model's range, and the seed the sampler will use."""

    model: NoiseModelName
    strength: float
    seed: int

    @property
    def spec(self) -> NoiseModelSpec:
        return NOISE_MODEL_SPECS[self.model]

    @property
    def is_noisy(self) -> bool:
        return self.model is not NoiseModelName.NONE

    def describe(self) -> dict[str, Any]:
        """The noise block stored in a record's payload and shown beside every noisy number."""
        spec = self.spec
        return {
            "model": self.model.value,
            "label": spec.label,
            "strength": self.strength,
            "parameter": spec.parameter,
            "applies_to": spec.applies_to,
            "how_applied": spec.how_applied,
            "simulation_method": NOISE_SIMULATION_METHOD,
            "seed": self.seed,
        }


def make_noise_config(model: str, strength: float | None, seed: int | None) -> NoiseConfig:
    """Validate ``(model, strength, seed)`` and fix the seed. ``strength=None`` means the model's default (and 0 for ``none``).

    The sampler's seed is drawn from the operating system when the client gives none, and is then recorded, so any run can be reproduced."""
    try:
        name = NoiseModelName(model)
    except ValueError:
        known = ", ".join(m.value for m in NoiseModelName)
        raise NoiseError("NOISE_MODEL_UNKNOWN", f"{model!r} is not a noise model this platform runs; the models are: {known}") from None
    spec = NOISE_MODEL_SPECS[name]
    value = spec.default_strength if strength is None else strength
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise NoiseError("NOISE_STRENGTH_INVALID", "the noise strength must be a finite number")
    value = float(value)
    if name is NoiseModelName.NONE:
        if value != 0.0:
            raise NoiseError("NOISE_STRENGTH_NOT_ALLOWED", "the 'none' model has no strength; leave it out or use 0", limit=0, requested=value)
    elif not spec.min_strength <= value <= spec.max_strength:
        raise NoiseError(
            "NOISE_STRENGTH_OUT_OF_RANGE",
            f"a {spec.label.lower()} strength must be between {spec.min_strength} and {spec.max_strength}; got {value}",
            limit=spec.max_strength,
            requested=value,
        )
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= SEED_MAX):
        raise NoiseError("NOISE_SEED_INVALID", f"the seed must be an integer from 0 to {SEED_MAX}", limit=SEED_MAX, requested=seed if isinstance(seed, int) else None)
    return NoiseConfig(model=name, strength=value, seed=secrets.randbelow(SEED_MAX + 1) if seed is None else seed)


def check_noise_limits(circuit: Circuit, shots: int) -> None:
    """Refuse a noisy run over the Noise Lab's own limits (tighter than an ordinary run: noise is simulated with a density matrix)."""
    if circuit.num_qubits > NOISE_MAX_QUBITS:
        raise NoiseError(
            "NOISE_TOO_MANY_QUBITS",
            f"a noisy simulation is limited to {NOISE_MAX_QUBITS} qubits (it keeps a 2**n x 2**n density matrix); this circuit has {circuit.num_qubits}",
            limit=NOISE_MAX_QUBITS,
            requested=circuit.num_qubits,
        )
    if not 1 <= shots <= NOISE_MAX_SHOTS:
        raise NoiseError("NOISE_SHOTS_OUT_OF_RANGE", f"shots must be between 1 and {NOISE_MAX_SHOTS} for a noisy simulation; got {shots}", limit=NOISE_MAX_SHOTS, requested=shots)
    if not any(op.gate is GateName.MEASURE for op in circuit.ops):
        raise NoiseError("NOISE_NEEDS_MEASUREMENT", "the Noise Lab compares measured outcomes, so the circuit needs at least one measurement")


class NoisyExecutionResult(ExecutionResult):
    """An ``ExecutionResult`` of a noisy shots run: counts as usual, plus the noise that produced them (stored in the record's payload)."""

    def __init__(self, *, noise: dict[str, Any], requested_shots: int | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.noise = noise
        # The shots that were asked for, so the state check (counts add up to the shots) compares against the request and not against the counts.
        self.requested_shots = requested_shots

    def to_payload(self) -> dict[str, Any]:
        payload = super().to_payload()
        payload["noise"] = self.noise
        return payload


# Aer instruction names a noise model can attach a one-qubit error to, by how many qubits the gate touches.
_GATES_BY_QUBIT_COUNT: dict[int, tuple[str, ...]] = {
    1: ("h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz"),
    2: ("cx", "cz", "cp", "swap"),
    3: ("ccx",),
}


def build_noise_model(config: NoiseConfig):
    """The Aer ``NoiseModel`` for ``config``. Qiskit is imported here, not at module import."""
    from qiskit_aer.noise import NoiseModel, ReadoutError, amplitude_damping_error, depolarizing_error, pauli_error

    p = config.strength
    model = NoiseModel()
    if config.model is NoiseModelName.NONE:
        return model
    if config.model is NoiseModelName.READOUT_ERROR:
        model.add_all_qubit_readout_error(ReadoutError([[1 - p, p], [p, 1 - p]]))
        return model
    if config.model is NoiseModelName.DEPOLARIZING:
        one = depolarizing_error(p, 1)
    elif config.model is NoiseModelName.BIT_FLIP:
        one = pauli_error([("X", p), ("I", 1 - p)])
    elif config.model is NoiseModelName.PHASE_FLIP:
        one = pauli_error([("Z", p), ("I", 1 - p)])
    else:
        one = amplitude_damping_error(p)
    error = one
    for width in (1, 2, 3):
        if width > 1:
            error = error.tensor(one)  # the same independent one-qubit error on every qubit the gate touches
        model.add_all_qubit_quantum_error(error, list(_GATES_BY_QUBIT_COUNT[width]))
    return model


def run_noisy_shots(circuit: Circuit, shots: int, config: NoiseConfig) -> NoisyExecutionResult:
    """Run ``circuit`` for ``shots`` shots under ``config`` on Aer's density-matrix simulator and return what Aer returned.

    Raises ``NoiseError`` for a request over a limit, ``AdapterUnavailable`` when Qiskit/Aer cannot be imported, and ``AdapterExecutionError`` when
    the simulator itself fails. It never returns a substitute result."""
    if not config.is_noisy:
        raise NoiseError("NOISE_MODEL_NONE", "there is no noisy run for the 'none' model; run the ideal simulation instead")
    check_noise_limits(circuit, shots)
    try:
        from qiskit import QuantumCircuit
        from qiskit_aer import AerSimulator
        import qiskit_aer
    except Exception as exc:  # noqa: BLE001 - report the real import failure
        raise AdapterUnavailable(f"qiskit-aer could not be imported: {type(exc).__name__}: {exc}") from exc

    qc = build_qiskit_circuit(circuit, QuantumCircuit)
    try:
        sim = AerSimulator(method=NOISE_SIMULATION_METHOD, noise_model=build_noise_model(config), seed_simulator=config.seed)
        result = sim.run(qc, shots=shots).result()
        if not result.success:
            raise AdapterExecutionError(f"Aer noisy run did not succeed: {result.status}")
        counts = {bitstring: int(count) for bitstring, count in result.get_counts(qc).items()}
    except (AdapterExecutionError, AdapterUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001 - surface the real Aer error
        raise AdapterExecutionError(f"Aer noisy execution failed: {type(exc).__name__}: {exc}") from exc

    return NoisyExecutionResult(
        backend_name="qiskit-aer",
        backend_version=qiskit_aer.__version__,
        execution_mode="noisy_shots",
        execution_id=f"aer-noisy-{uuid.uuid4().hex[:12]}",
        counts=counts,
        probabilities={bitstring: count / shots for bitstring, count in counts.items()},
        noise=config.describe(),
        requested_shots=shots,
    )
