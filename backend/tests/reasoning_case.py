"""Shared set-up for the reasoning-engine tests: a temp provenance store swapped into the app, the real Aer adapter (skipped, never
faked, when it is unavailable), and helpers that call the endpoint functions the way the existing API tests do."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import TypeAdapter

from qentor.api import app as app_module
from qentor.api import reasoning as reasoning_api
from qentor.api.schemas import ExecuteRequest, TraceRequest
from qentor.challenges.content import circ, g
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.store import ProvenanceStore

_ANALYZE = TypeAdapter(reasoning_api.AnalyzeRequest)

BELL = circ(2, [g("h", 0), g("cx", 1, control=0)])
BELL_MEASURED = circ(
    2,
    [g("h", 0), g("cx", 1, control=0), *[GateOp(gate=GateName.MEASURE, targets=[q], clbits=[q]) for q in (0, 1)]],
    num_clbits=2,
)
REDUNDANT = circ(1, [g("h", 0), g("h", 0), g("x", 0)])
SUPERPOSITION = circ(1, [g("h", 0)])


def cj(circuit: Circuit) -> dict:
    return json.loads(circuit.model_dump_json(by_alias=True))


class ReasoningCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        except Exception:
            pass  # any other error means Aer IS importable
        self._tmp = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmp.name) / "qentor.db")
        self._patch = patch.object(app_module, "_store", self.store)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    # -- helpers ---------------------------------------------------------------------------------------------
    def run_circuit(self, circuit: Circuit, mode: str = "statevector", shots: int | None = None):
        return app_module.execute(ExecuteRequest(circuit=circuit, mode=mode, shots=shots))  # type: ignore[arg-type]

    def trace(self, circuit: Circuit):
        return app_module.execute_trace(TraceRequest(circuit=circuit))

    def step_ref(self, trace, index: int) -> dict:
        step = trace.steps[index]
        ref = {
            "step_index": index,
            "result_id": step.provenance.result_id,
            "execution_id": step.execution_id,
            "circuit_hash": step.provenance.circuit_hash,
            "backend": step.provenance.backend,
            "backend_version": step.provenance.backend_version,
        }
        if index > 0:
            ref["operation_index"] = index - 1
            ref["operation"] = json.loads(step.operation.model_dump_json())
            ref["previous_result_id"] = trace.steps[index - 1].provenance.result_id
        return ref

    def analyze(self, body: dict):
        """The endpoint function, given the request as JSON (so the real request validation applies)."""
        return reasoning_api.analyze_endpoint(_ANALYZE.validate_python(body))

    def refused(self, body: dict) -> HTTPException:
        with self.assertRaises(HTTPException) as caught:
            self.analyze(body)
        return caught.exception

    @staticmethod
    def code_of(exc: HTTPException) -> str:
        assert isinstance(exc.detail, dict), exc.detail
        return exc.detail["code"]

    def probability(self, circuit: Circuit, record_id: str, target: dict, **extra):
        return self.analyze({"intent": "PROBABILITY", "circuit": cj(circuit), "result_id": record_id, "target": target, **extra})
