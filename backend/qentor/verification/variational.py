"""A one-parameter variational (VQE-style) demonstration: every expectation value comes from a backend statevector.

This is an EDUCATIONAL example and says so. It is not a chemistry calculation and not a scalable VQE, it uses no hardware, and it makes no
claim about any real molecule or any speed-up. The pieces are the ones the idea is made of, each small enough to see:

* a **parameterised circuit** (the ansatz): one qubit, ``RY(theta)`` applied to ``|0>``. It prepares a trial state for each ``theta``;
* a **cost**: the expectation value ``<Z>`` of the Pauli Z observable in that trial state, read from the statevector the backend produced
  (``qentor.execution.expectation``), never computed from ``theta``;
* a **classical optimisation loop**: gradient descent on that cost. The gradient comes from the parameter-shift rule, which needs only two
  more backend runs of the same circuit with ``theta`` moved by plus and minus a quarter turn: for a single rotation gate and a Pauli
  observable, ``d<Z>/d(theta) = (<Z>(theta + pi/2) - <Z>(theta - pi/2)) / 2``. That identity is textbook; here it is only a recipe for
  combining three numbers the backend produced.

Every run is an ordinary statevector-mode execution handed to the injected ``record_execution`` callback (the API layer's job, exactly like
the trace), so each ``<Z>`` in a response names the provenance record of the run it was read from. Nothing here imports the provenance store
or the tutor, and nothing here knows what ``<Z>`` "should" be: the closed form of this particular circuit appears in no function of this module.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import ExecutionAdapter, ExecutionResult
from qentor.execution.bloch import bloch_coordinates
from qentor.execution.expectation import EXPECTATION_METHOD, z_expectation
from qentor.execution.trace import require_usable_state

METHOD = "qentor.variational/1"
ANSATZ = "RY(theta) on one qubit, started in |0>"
OBSERVABLE = "Pauli Z on q[0]"
LABEL = (
    "Educational one-parameter demonstration: a classical gradient-descent loop around a statevector simulator on the server. "
    "It is not a chemistry calculation, not a scalable VQE, and it uses no quantum hardware."
)

MIN_POINTS = 3
MAX_POINTS = 64
MAX_STEPS = 25
THETA_LIMIT = 4 * math.pi
MIN_LEARNING_RATE = 0.01
MAX_LEARNING_RATE = 1.5
# The parameter-shift rule for one rotation gate: move the angle by a quarter turn either way.
SHIFT = math.pi / 2
# A gradient this small is "flat enough": the loop has stopped moving the state in a way a person could see.
GRADIENT_TOLERANCE = 1e-3

RecordExecution = Callable[[ExecutionResult, str], str]


class VariationalError(ValueError):
    """A request outside what the demonstration runs, or a backend state it cannot honestly use. ``code`` is stable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class EvaluatedPoint:
    """One run of the ansatz at one angle: its state's ``<Z>`` and Bloch vector, and the identity of the run they were read from."""

    theta: float
    expectation_z: float
    bloch: tuple[float, float, float]
    probabilities: dict[str, float]
    result_id: str
    execution_id: str
    circuit_hash: str
    backend: str
    backend_version: str


@dataclass(frozen=True)
class OptimizationStep:
    step: int
    point: EvaluatedPoint
    gradient: float
    plus: EvaluatedPoint
    minus: EvaluatedPoint


@dataclass
class SweepReport:
    points: list[EvaluatedPoint]
    minimum_index: int
    maximum_index: int


@dataclass
class OptimizationReport:
    steps: list[OptimizationStep]
    lowest_index: int
    converged: bool
    learning_rate: float
    shift: float = SHIFT
    notes: list[str] = field(default_factory=list)


def ansatz(theta: float) -> Circuit:
    """The one-qubit circuit ``RY(theta)``. Built from the canonical model, so it is validated like any other circuit."""
    if not math.isfinite(theta):
        raise VariationalError("VARIATIONAL_THETA_INVALID", "the angle must be a finite number of radians")
    return Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate=GateName.RY, targets=[0], params=[float(theta)])])


def evaluate(theta: float, adapter: ExecutionAdapter, record_execution: RecordExecution) -> EvaluatedPoint:
    """Run the ansatz at ``theta`` on the backend and read ``<Z>`` from the state it returned. Raises the adapter's own errors, and
    ``TraceBackendFault`` for an unusable state; nothing is substituted."""
    circuit = ansatz(theta)
    chash = circuit_hash(circuit)
    result = adapter.run(circuit, "statevector")
    require_usable_state(result, 1, chash)
    state = result.statevector
    expectation = z_expectation(state, 0, 1)
    bloch = bloch_coordinates(state)
    if expectation is None or bloch is None:  # pragma: no cover - require_usable_state already refused an unusable state
        raise VariationalError("VARIATIONAL_STATE_UNUSABLE", "the backend's state has no expectation value, so nothing is shown")
    result_id = record_execution(result, chash)
    probabilities = {"0": state[0][0] ** 2 + state[0][1] ** 2, "1": state[1][0] ** 2 + state[1][1] ** 2}
    return EvaluatedPoint(
        theta=float(theta),
        expectation_z=expectation,
        bloch=bloch,
        probabilities=probabilities,
        result_id=result_id,
        execution_id=result.execution_id,
        circuit_hash=chash,
        backend=result.backend_name,
        backend_version=result.backend_version,
    )


def check_theta(theta: float, name: str = "theta") -> float:
    if not math.isfinite(theta) or abs(theta) > THETA_LIMIT:
        raise VariationalError("VARIATIONAL_THETA_INVALID", f"{name} must be a finite angle within ±4π radians")
    return float(theta)


def sweep_grid(theta_min: float, theta_max: float, points: int) -> list[float]:
    """The angles of a sweep: ``points`` evenly spaced values from ``theta_min`` to ``theta_max`` inclusive. Angles are inputs, not results."""
    check_theta(theta_min, "theta_min")
    check_theta(theta_max, "theta_max")
    if not theta_min < theta_max:
        raise VariationalError("VARIATIONAL_RANGE_INVALID", "theta_min must be below theta_max")
    if not MIN_POINTS <= points <= MAX_POINTS:
        raise VariationalError("VARIATIONAL_POINTS_INVALID", f"a sweep takes {MIN_POINTS} to {MAX_POINTS} points; {points} were asked for")
    step = (theta_max - theta_min) / (points - 1)
    return [theta_min + i * step for i in range(points - 1)] + [theta_max]


def run_sweep(theta_min: float, theta_max: float, points: int, adapter: ExecutionAdapter, record_execution: RecordExecution) -> SweepReport:
    """The cost at each grid angle. The lowest and highest are found by COMPARING the backend's values (an ordering, not a computation)."""
    evaluated = [evaluate(theta, adapter, record_execution) for theta in sweep_grid(theta_min, theta_max, points)]
    values = [p.expectation_z for p in evaluated]
    return SweepReport(points=evaluated, minimum_index=values.index(min(values)), maximum_index=values.index(max(values)))


def run_optimization(
    theta_start: float,
    steps: int,
    learning_rate: float,
    adapter: ExecutionAdapter,
    record_execution: RecordExecution,
) -> OptimizationReport:
    """Gradient descent on ``<Z>``: at each of ``steps`` + 1 angles, three backend runs (the angle and the two shifted ones) give the
    cost and its gradient; the angle then moves downhill by ``learning_rate`` times the gradient. The loop is fixed-length and
    deterministic. A start where the gradient is exactly zero stays where it is: that is what the algorithm does, and the report says so."""
    check_theta(theta_start, "theta_start")
    if not 1 <= steps <= MAX_STEPS:
        raise VariationalError("VARIATIONAL_STEPS_INVALID", f"the loop takes 1 to {MAX_STEPS} steps; {steps} were asked for")
    if not (math.isfinite(learning_rate) and MIN_LEARNING_RATE <= learning_rate <= MAX_LEARNING_RATE):
        raise VariationalError("VARIATIONAL_LEARNING_RATE_INVALID", f"the learning rate must be between {MIN_LEARNING_RATE} and {MAX_LEARNING_RATE}")

    trajectory: list[OptimizationStep] = []
    theta = float(theta_start)
    for step in range(steps + 1):
        here = evaluate(theta, adapter, record_execution)
        plus = evaluate(theta + SHIFT, adapter, record_execution)
        minus = evaluate(theta - SHIFT, adapter, record_execution)
        gradient = 0.5 * (plus.expectation_z - minus.expectation_z)
        trajectory.append(OptimizationStep(step=step, point=here, gradient=gradient, plus=plus, minus=minus))
        theta = theta - learning_rate * gradient

    costs = [s.point.expectation_z for s in trajectory]
    notes: list[str] = []
    if all(abs(s.gradient) <= GRADIENT_TOLERANCE for s in trajectory[:1]):
        notes.append("the starting angle has a gradient of zero, so the loop cannot tell which way is downhill and does not move")
    return OptimizationReport(
        steps=trajectory,
        lowest_index=costs.index(min(costs)),
        converged=abs(trajectory[-1].gradient) <= GRADIENT_TOLERANCE,
        learning_rate=learning_rate,
        notes=notes,
    )


__all__ = [
    "EXPECTATION_METHOD",
    "GRADIENT_TOLERANCE",
    "LABEL",
    "MAX_POINTS",
    "MAX_STEPS",
    "METHOD",
    "OBSERVABLE",
    "ANSATZ",
    "SHIFT",
    "EvaluatedPoint",
    "OptimizationReport",
    "OptimizationStep",
    "SweepReport",
    "VariationalError",
    "ansatz",
    "check_theta",
    "evaluate",
    "run_optimization",
    "run_sweep",
    "sweep_grid",
]
