"""The shared golden fixtures (``fixtures/circuits/``), checked from the server side.

Each fixture pins a circuit's canonical form, its OpenQASM 3 text and its hash. The TypeScript
suite checks the SAME files against the web emitter and parser, so the two implementations agree
with one reviewed file and therefore with each other (CLAUDE.md: "the web emitter must match
[the server's] on the fixtures").

Beyond byte equality the server side also proves the fixtures MEAN what they say:

* the emitted text is re-parsed by Qiskit's own OpenQASM 3 importer — an independent parser — and
  its unitary is compared with the one built from the canonical model, for every gate;
* every simulator (Aer, Cirq, PennyLane) reaches the same state for every fixture, and that state
  is the one the equivalence checker's unitary predicts;
* the equivalence pairs get the verdicts they are labelled with;
* the invalid circuits are all refused by the model.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

from pydantic import ValidationError

from qentor.circuit.hashing import circuit_hash, short_circuit_id
from qentor.circuit.model import Circuit, GateName
from qentor.circuit.qasm import to_qasm3
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.verification.equivalence import EquivalenceStatus, _to_qiskit_circuit_without_measurement, check_equivalence

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = ROOT / "fixtures" / "circuits"


def _load(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


FIXTURE_NAMES = sorted(p.name for p in FIXTURE_DIR.glob("*.json") if not p.name.startswith("_"))
FIXTURES = {name: _load(name) for name in FIXTURE_NAMES}


def _without_measurements(circuit: Circuit) -> Circuit:
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=0, ops=[op for op in circuit.ops if op.gate is not GateName.MEASURE])


class TestFixtureFilesAreWellFormed(unittest.TestCase):
    def test_there_are_fixtures_and_the_special_files_exist(self) -> None:
        self.assertGreaterEqual(len(FIXTURE_NAMES), 14)
        for special in ("_equivalence.json", "_invalid.json"):
            self.assertTrue((FIXTURE_DIR / special).exists(), special)

    def test_every_fixture_has_the_agreed_fields(self) -> None:
        for name, data in FIXTURES.items():
            self.assertEqual(list(data), ["name", "description", "circuit", "qasm", "hash", "code"], name)
            self.assertEqual(data["name"] + ".json", name)
            self.assertTrue(data["description"].strip(), name)

    def test_the_files_are_exactly_what_the_generator_writes(self) -> None:
        """A hand edit, or a change of emitter behaviour, shows up here and must be reviewed."""
        spec = importlib.util.spec_from_file_location("regen_fixtures", ROOT / "backend" / "scripts" / "regen_fixtures.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        expected = module.fixture_files()
        on_disk = {p.name: p.read_text(encoding="utf-8") for p in FIXTURE_DIR.glob("*.json")}
        self.assertEqual(set(on_disk), set(expected), "files added or removed without regenerating")
        for filename, text in expected.items():
            self.assertEqual(on_disk[filename], text, f"{filename} differs from the server emitter; review and run --write")

    def test_the_files_use_unix_line_endings(self) -> None:
        for path in FIXTURE_DIR.glob("*.json"):
            self.assertNotIn(b"\r", path.read_bytes(), path.name)

    def test_every_gate_in_the_model_appears_in_some_fixture(self) -> None:
        used = {op["gate"] for data in FIXTURES.values() for op in data["circuit"]["ops"]}
        self.assertEqual(used, {g.value for g in GateName})


class TestServerEmitterAndHash(unittest.TestCase):
    def test_canonical_form_qasm_and_hash_match_the_golden_for_every_fixture(self) -> None:
        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                circuit = Circuit.model_validate(data["circuit"])
                self.assertEqual(circuit.canonical_dict(), data["circuit"])
                self.assertEqual(to_qasm3(circuit), data["qasm"])
                self.assertEqual(circuit_hash(circuit), data["hash"])

    def test_the_hash_is_the_sha256_of_the_qasm_text(self) -> None:
        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                self.assertEqual(hashlib.sha256(data["qasm"].encode("utf-8")).hexdigest(), data["hash"])
                circuit = Circuit.model_validate(data["circuit"])
                self.assertEqual(short_circuit_id(circuit), "qc_" + data["hash"][:12])

    def test_emission_is_deterministic_and_the_json_round_trips(self) -> None:
        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                circuit = Circuit.model_validate(data["circuit"])
                self.assertEqual(to_qasm3(circuit), to_qasm3(circuit))
                again = Circuit.from_canonical_json(circuit.canonical_json())
                self.assertEqual(again.canonical_dict(), data["circuit"])
                self.assertEqual(circuit_hash(again), data["hash"])

    def test_distinct_fixtures_have_distinct_hashes(self) -> None:
        hashes = [data["hash"] for data in FIXTURES.values()]
        self.assertEqual(len(hashes), len(set(hashes)))

    def test_the_operand_order_is_part_of_the_circuit_and_therefore_of_the_hash(self) -> None:
        a = Circuit.model_validate({"num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "swap", "targets": [0, 1]}]})
        b = Circuit.model_validate({"num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "swap", "targets": [1, 0]}]})
        self.assertNotEqual(circuit_hash(a), circuit_hash(b))
        self.assertEqual(check_equivalence(a, b).status, EquivalenceStatus.EQUIVALENT)  # same operator, different text


class _Backends(unittest.TestCase):
    def setUp(self) -> None:
        self.aer = AerAdapter()
        try:
            self.aer.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        except Exception:
            pass


class TestAnIndependentParserAgrees(_Backends):
    """Qiskit's own OpenQASM 3 importer reads the emitted text; its unitary must be the model's."""

    def test_every_fixture_means_what_its_circuit_says(self) -> None:
        from qiskit import qasm3
        from qiskit.quantum_info import Operator

        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                circuit = Circuit.model_validate(data["circuit"])
                imported = qasm3.loads(data["qasm"]).remove_final_measurements(inplace=False)
                model_side = _to_qiskit_circuit_without_measurement(circuit)
                self.assertTrue(
                    Operator(imported).equiv(Operator(model_side), atol=1e-9),
                    f"{name}: Qiskit's importer disagrees with the emitter's meaning",
                )

    def test_the_new_gates_are_read_as_the_gates_they_are_named(self) -> None:
        import numpy as np
        from qiskit import qasm3
        from qiskit.quantum_info import Operator

        s = Operator(qasm3.loads('OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\ns q[0];\n')).data
        sdg = Operator(qasm3.loads('OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nsdg q[0];\n')).data
        self.assertTrue(np.allclose(sdg, s.conj().T))
        circuit = Circuit.model_validate({"num_qubits": 1, "num_clbits": 0, "ops": [{"gate": "sdg", "targets": [0]}]})
        self.assertTrue(np.allclose(Operator(_to_qiskit_circuit_without_measurement(circuit)).data, s.conj().T))


class TestEverySimulatorReachesTheSameState(_Backends):
    ADAPTERS = (AerAdapter(), CirqAdapter(), PennyLaneAdapter())

    @staticmethod
    def _amplitudes(result) -> list[complex]:
        return [complex(re, im) for re, im in result.statevector]

    def test_all_three_simulators_agree_on_every_fixture_and_match_the_verifiers_unitary(self) -> None:
        from qiskit.quantum_info import Statevector

        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                circuit = _without_measurements(Circuit.model_validate(data["circuit"]))
                states = {a.name: self._amplitudes(a.run(circuit, "statevector")) for a in self.ADAPTERS}
                reference = states["qiskit-aer"]
                for backend, state in states.items():
                    worst = max(abs(x - y) for x, y in zip(state, reference))
                    self.assertLess(worst, 1e-6, f"{name}: {backend} differs from qiskit-aer by {worst}")
                predicted = Statevector(_to_qiskit_circuit_without_measurement(circuit)).data
                overlap = abs(sum(p.conjugate() * r for p, r in zip(predicted, reference)))
                self.assertAlmostEqual(overlap, 1.0, places=9, msg=f"{name}: the simulator disagrees with the verifier's unitary")


class TestEquivalencePairs(_Backends):
    def test_each_pair_gets_its_labelled_verdict_and_its_qasm_matches_the_emitter(self) -> None:
        pairs = _load("_equivalence.json")["pairs"]
        self.assertGreaterEqual(len(pairs), 20)
        self.assertEqual({p["expected"] for p in pairs}, {"EQUIVALENT", "NOT_EQUIVALENT"})
        for pair in pairs:
            with self.subTest(pair=pair["name"]):
                a = Circuit.model_validate(pair["a"]["circuit"])
                b = Circuit.model_validate(pair["b"]["circuit"])
                self.assertEqual(to_qasm3(a), pair["a"]["qasm"])
                self.assertEqual(to_qasm3(b), pair["b"]["qasm"])
                self.assertEqual(check_equivalence(a, b).status.value, pair["expected"], pair["note"])

    def test_the_pairs_cover_the_new_gates(self) -> None:
        text = json.dumps(_load("_equivalence.json"))
        for gate in ("sdg", "tdg", "cz", "cp", "swap", "ccx"):
            self.assertIn(f'"gate": "{gate}"', text)


class TestInvalidCircuitsAreRefused(unittest.TestCase):
    def test_every_invalid_case_is_rejected_with_its_reason(self) -> None:
        cases = _load("_invalid.json")["cases"]
        self.assertGreaterEqual(len(cases), 14)
        for case in cases:
            with self.subTest(case=case["name"]):
                with self.assertRaises(ValidationError) as raised:
                    Circuit.model_validate(case["circuit"])
                self.assertIn(case["reason"], str(raised.exception))


if __name__ == "__main__":
    unittest.main()
