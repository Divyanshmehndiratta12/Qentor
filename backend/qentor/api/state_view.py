"""The per-qubit view of a stored run's final state — one place, used by every response that carries a stored result.

``/api/execute`` and the read-only shared page both hand the browser an ``ExecuteResponse``. The browser draws one Bloch
sphere per qubit from ``qubit_states``, so those values are derived here, by the server, from the statevector in the STORED
record (``qentor.execution.reduced_state``) and tagged with that record's identity. Nothing comes from a request, from the
browser or from a language model; a run with no statevector (shots) has no state view.
"""

from __future__ import annotations

from qentor.circuit.model import Circuit
from qentor.execution.bloch import BlochSource
from qentor.execution.reduced_state import QubitReducedState, derive_qubit_states
from qentor.provenance.models import ProvenanceRecord


def final_state_qubit_states(record: ProvenanceRecord, circuit: Circuit) -> list[QubitReducedState]:
    """Every qubit's reduced state in ``record``'s statevector, ``q[0]`` first; ``[]`` for a record with no statevector.

    ``derived_from.step_index`` is the number of operations of ``circuit`` (the whole circuit was applied), and
    ``derived_from.result_id`` is ``record.result_id``, so a value can always be traced back to the record that holds the
    state it was computed from.
    """
    if record.execution_mode != "statevector":
        return []
    statevector = record.payload.get("statevector")
    if statevector is None:
        return []
    return derive_qubit_states(
        statevector,
        circuit.num_qubits,
        source=BlochSource(
            step_index=len(circuit.ops),
            result_id=record.result_id,
            execution_id=str(record.payload.get("execution_id", "")),
            circuit_hash=record.circuit_hash,
            backend=record.backend,
            backend_version=record.backend_version,
        ),
    )
