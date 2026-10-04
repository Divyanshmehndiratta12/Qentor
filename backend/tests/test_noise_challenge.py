"""The noise challenge ``noise-shorten-circuit``: a check judged on the server's own seeded NOISY simulation.

The challenge starts from a circuit that prepares 11 correctly but with far more gates than it needs, and asks for one that still gives 11 on nine
in ten shots when the server runs it under fixed depolarizing noise. What these tests pin:

* the verdict is the simulator's: with the noisy runner replaced by a fake that returns known counts, the verdict follows exactly those counts, and the
  configuration the check asked for (model, strength, seed, shots) is what reached the simulator;
* it separates circuits an ideal simulation cannot tell apart: the reference passes; the redundant starter, a CX shortcut and a padded circuit all give 11
  ideally and all fail the noisy check; a wrong circuit fails both;
* a verdict is deterministic (a fixed seed), recorded as a ``noisy_shots`` provenance record, and named by its check;
* the model rejects a nonsensical noisy check, and nothing the learner sees names the seed, the strength or the threshold as an answer.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ChallengeSubmitRequest
from qentor.challenges import CHALLENGE_BY_ID, evaluate_challenge
from qentor.challenges import evaluate as evaluate_module
from qentor.challenges.content import circ, g, m
from qentor.challenges.models import Challenge, Constraints, NoisyOutcomeShare, ProbabilitiesMatch, public_view
from qentor.circuit.model import GateName
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.noise import NoisyExecutionResult
from qentor.provenance.attempts import AttemptStore
from qentor.provenance.store import ProvenanceStore

ID = "noise-shorten-circuit"
CHALLENGE = CHALLENGE_BY_ID[ID]
NOISY_CHECK = next(c for c in CHALLENGE.checks if isinstance(c, NoisyOutcomeShare))
AER = AerAdapter()


def two_x(*extra, before=()):
    return circ(2, [*before, g("x", 0), g("x", 1), *extra, m(0, 0), m(1, 1)], 2)


def judge(circuit, **kw):
    return evaluate_challenge(CHALLENGE, circuit, AER, max_qubits=8, max_operations=64, **kw)


def check(evaluation, check_id):
    return next(c for c in evaluation.checks if c.id == check_id)


def share(evaluation) -> float:
    return next(e.value for e in check(evaluation, "noisy.share").evidence if e.name == "noisy_share_of_required_outcome")


class AerCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AER.run(circ(1, []), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")


class TestDefinition(unittest.TestCase):
    def test_it_is_linked_to_the_noise_lesson(self) -> None:
        self.assertEqual(CHALLENGE.lesson_id, "quantum-noise")

    def test_it_has_an_ideal_check_and_a_noisy_check(self) -> None:
        self.assertEqual([c.id for c in CHALLENGE.checks], ["ideal.outcome", "noisy.share"])
        self.assertIsInstance(CHALLENGE.checks[0], ProbabilitiesMatch)
        self.assertEqual(NOISY_CHECK.kind, "noisy_outcome_share")

    def test_the_noisy_check_is_a_fixed_seeded_depolarizing_configuration(self) -> None:
        self.assertEqual(
            (NOISY_CHECK.outcome, NOISY_CHECK.noise_model, NOISY_CHECK.noise_strength, NOISY_CHECK.shots, NOISY_CHECK.seed, NOISY_CHECK.min_share),
            ("11", "depolarizing", 0.08, 8000, 7, 0.9),
        )

    def test_the_starter_is_correct_in_an_ideal_run_but_much_too_long(self) -> None:
        starter = CHALLENGE.starter_circuit
        self.assertEqual([op.gate for op in starter.ops].count(GateName.X), 6)
        self.assertEqual([op.gate for op in starter.ops][-2:], [GateName.MEASURE, GateName.MEASURE])

    def test_every_check_has_authored_coaching_and_a_valid_hint(self) -> None:
        for c in CHALLENGE.checks:
            self.assertTrue(c.misconception.strip() and c.experiment.strip())
            self.assertLess(c.hint_index, len(CHALLENGE.hints))
        self.assertGreaterEqual(len(CHALLENGE.hints), 3)

    def test_it_says_in_its_own_words_that_the_noise_is_simulated_and_names_no_device(self) -> None:
        text = " ".join([CHALLENGE.goal, CHALLENGE.success_condition, CHALLENGE.success_message]).lower()
        self.assertIn("simulat", text)
        self.assertIn("not a real device", text)
        for word in ("fidelity", "ibm", "advantage", "speedup", "qpu"):
            self.assertNotIn(word, text)

    def test_a_learner_is_never_shown_the_seed_the_strength_or_the_threshold_as_data(self) -> None:
        public = public_view(CHALLENGE).model_dump_json()
        for secret in ("min_share", "noise_strength", "noise_model", '"seed"', "noisy_outcome_share", '"target":', "reference"):
            self.assertNotIn(secret, public)
        self.assertEqual([c.id for c in public_view(CHALLENGE).checks], ["ideal.outcome", "noisy.share"])


class TestTheVerdictIsTheSimulators(AerCase):
    def fake_runner(self, counts: dict[str, int], seen: list):
        def run(circuit, shots, config):
            seen.append((shots, config))
            return NoisyExecutionResult(
                backend_name="qiskit-aer", backend_version="x", execution_mode="noisy_shots", execution_id="fake", counts=counts,
                probabilities={k: v / shots for k, v in counts.items()}, noise=config.describe(), requested_shots=shots,
            )

        return run

    def test_the_verdict_follows_exactly_the_counts_the_simulator_returned(self) -> None:
        seen: list = []
        with patch.object(evaluate_module, "run_noisy_shots", self.fake_runner({"11": 8000}, seen)):
            ok = judge(two_x())
        self.assertTrue(check(ok, "noisy.share").passed)
        self.assertEqual(share(ok), 1.0)
        with patch.object(evaluate_module, "run_noisy_shots", self.fake_runner({"11": 7199, "00": 801}, seen)):
            bad = judge(two_x())
        self.assertFalse(check(bad, "noisy.share").passed)
        self.assertEqual(share(bad), 7199 / 8000)
        with patch.object(evaluate_module, "run_noisy_shots", self.fake_runner({"11": 7200, "00": 800}, seen)):
            edge = judge(two_x())
        self.assertTrue(check(edge, "noisy.share").passed, "exactly nine in ten passes")

    def test_the_checks_own_configuration_is_what_reaches_the_simulator(self) -> None:
        seen: list = []
        with patch.object(evaluate_module, "run_noisy_shots", self.fake_runner({"11": 8000}, seen)):
            judge(two_x())
        (shots, config), = seen
        self.assertEqual(shots, 8000)
        self.assertEqual((config.model.value, config.strength, config.seed), ("depolarizing", 0.08, 7))

    def test_an_outcome_the_simulator_never_returned_is_zero_not_a_default(self) -> None:
        with patch.object(evaluate_module, "run_noisy_shots", self.fake_runner({"00": 8000}, [])):
            r = judge(two_x())
        self.assertEqual(share(r), 0.0)
        self.assertFalse(check(r, "noisy.share").passed)

    def test_a_run_the_simulator_cannot_make_is_a_failed_check_with_a_reason_not_a_crash(self) -> None:
        from qentor.execution.noise import NoiseError

        def refuse(circuit, shots, config):
            raise NoiseError("NOISE_TOO_MANY_QUBITS", "too many qubits for a noisy run")

        with patch.object(evaluate_module, "run_noisy_shots", refuse):
            r = judge(two_x())
        outcome = check(r, "noisy.share")
        self.assertFalse(outcome.passed)
        self.assertIn("too many qubits", outcome.detail)
        self.assertFalse(r.passed)


class TestWhatItSeparates(AerCase):
    def test_the_reference_passes_both_checks(self) -> None:
        r = judge(CHALLENGE.reference_solution)
        self.assertTrue(r.passed)
        self.assertTrue(check(r, "ideal.outcome").passed and check(r, "noisy.share").passed)
        self.assertGreaterEqual(share(r), 0.9)

    def test_the_redundant_starter_is_right_when_ideal_and_fails_under_noise(self) -> None:
        r = judge(CHALLENGE.starter_circuit)
        self.assertTrue(check(r, "ideal.outcome").passed, "ideally it prepares 11")
        self.assertFalse(check(r, "noisy.share").passed)
        self.assertFalse(r.passed)
        self.assertLess(share(r), 0.85)

    def test_a_cx_shortcut_is_right_when_ideal_and_fails_under_noise(self) -> None:
        # X on q0, then CX q0 -> q1: the same ideal result in two gates, but the CX gives noise two qubits to act on
        r = judge(circ(2, [g("x", 0), g("cx", 1, 0), m(0, 0), m(1, 1)], 2))
        self.assertTrue(check(r, "ideal.outcome").passed)
        self.assertFalse(check(r, "noisy.share").passed)

    def test_padding_with_gates_that_cancel_fails_under_noise_though_it_is_ideal_identical(self) -> None:
        padded = circ(2, [g("x", 0), g("x", 0), g("x", 0), g("x", 1), m(0, 0), m(1, 1)], 2)
        r = judge(padded)
        self.assertTrue(check(r, "ideal.outcome").passed)
        self.assertFalse(check(r, "noisy.share").passed)

    def test_every_extra_pair_of_gates_lowers_the_share(self) -> None:
        shares = []
        for pairs in (0, 1, 2):
            extra = [g("x", 0), g("x", 0)] * pairs
            shares.append(share(judge(two_x(before=extra))))
        self.assertGreater(shares[0], shares[1])
        self.assertGreater(shares[1], shares[2])

    def test_a_wrong_circuit_fails_the_ideal_check_and_the_noisy_one(self) -> None:
        r = judge(circ(2, [g("x", 0), m(0, 0), m(1, 1)], 2))
        self.assertFalse(check(r, "ideal.outcome").passed)
        self.assertFalse(check(r, "noisy.share").passed)
        self.assertFalse(r.passed)

    def test_a_circuit_that_is_not_measured_is_a_structure_failure_and_runs_no_noisy_simulation(self) -> None:
        with patch.object(evaluate_module, "run_noisy_shots") as noisy:
            r = judge(circ(2, [g("x", 0), g("x", 1)], 2))
        noisy.assert_not_called()
        self.assertFalse(r.passed)
        self.assertFalse(check(r, "noisy.share").evaluated)
        self.assertIsNone(r.final_result_id)

    def test_too_long_a_circuit_is_refused_by_structure_before_any_noisy_run(self) -> None:
        with patch.object(evaluate_module, "run_noisy_shots") as noisy:
            r = judge(two_x(before=[g("x", 0), g("x", 0)] * 6))
        noisy.assert_not_called()
        self.assertFalse(r.passed)

    def test_the_verdict_is_deterministic_for_a_fixed_seed(self) -> None:
        first, second = judge(CHALLENGE.starter_circuit), judge(CHALLENGE.starter_circuit)
        self.assertEqual(share(first), share(second))
        self.assertEqual(first.passed, second.passed)


class TestRecords(AerCase):
    def setUp(self) -> None:
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        db = Path(self._tmp.name) / "noise-challenge.db"
        self.store = ProvenanceStore(db)
        self.attempts = AttemptStore(db)
        self._patches = [patch.object(app_module, "_store", self.store), patch.object(app_module, "_attempts", self.attempts)]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self.store.close()
        self.attempts.close()
        self._tmp.cleanup()

    def submit(self, circuit):
        return app_module.submit_challenge(ID, ChallengeSubmitRequest(circuit=circuit))

    def test_the_noisy_check_names_a_stored_noisy_record_with_its_noise(self) -> None:
        r = self.submit(CHALLENGE.reference_solution)
        self.assertTrue(r.passed)
        noisy = next(c for c in r.checks if c.id == "noisy.share")
        self.assertIsNotNone(noisy.result_id)
        record = self.store.get(noisy.result_id)
        self.assertEqual(record.execution_mode, "noisy_shots")
        self.assertEqual(record.provenance_class.value, "SIMULATION")
        self.assertEqual(record.verification_status.value, "STATE_CHECKED")
        self.assertEqual(record.payload["noise"]["model"], "depolarizing")
        self.assertEqual((record.payload["noise"]["strength"], record.payload["noise"]["seed"]), (0.08, 7))
        self.assertEqual(sum(record.payload["counts"].values()), 8000)
        self.assertEqual(record.circuit_hash, r.circuit_hash)

    def test_the_provenance_block_of_the_response_says_it_is_simulated_noise(self) -> None:
        r = self.submit(CHALLENGE.starter_circuit)
        noisy = next(c for c in r.checks if c.id == "noisy.share")
        self.assertEqual(r.provenance[noisy.result_id].execution_mode, "noisy_shots")
        self.assertEqual(r.provenance[noisy.result_id].provenance_class, "SIMULATION")

    def test_the_evidence_is_the_share_of_the_stored_counts(self) -> None:
        r = self.submit(CHALLENGE.starter_circuit)
        noisy = next(c for c in r.checks if c.id == "noisy.share")
        record = self.store.get(noisy.result_id)
        stored = record.payload["counts"].get("11", 0) / 8000
        self.assertEqual(next(e.value for e in noisy.evidence if e.name == "noisy_share_of_required_outcome"), stored)

    def test_a_failing_attempt_gets_the_noise_hint_and_is_logged(self) -> None:
        r = self.submit(CHALLENGE.starter_circuit)
        self.assertFalse(r.passed)
        self.assertEqual(r.next_hint_index, 2)
        self.assertIn("Noise acts after every gate", r.next_hint)
        self.assertFalse(self.attempts.get(r.attempt_id).passed)

    def test_the_request_still_has_no_field_for_a_verdict_a_count_or_a_seed(self) -> None:
        circuit = CHALLENGE.reference_solution.model_dump(by_alias=True)
        for field in ("passed", "counts", "probabilities", "seed", "noise_model", "noise_strength", "min_share", "noisy_share"):
            with self.assertRaises(ValidationError):
                ChallengeSubmitRequest.model_validate({"circuit": circuit, field: 1})


class TestTheCheckModelIsStrict(unittest.TestCase):
    BASE = dict(id="n", label="l", hint_index=0, misconception="m", experiment="e", outcome="11", noise_model="depolarizing", noise_strength=0.08, shots=8000, seed=7, min_share=0.9)

    def test_a_valid_check(self) -> None:
        NoisyOutcomeShare(**self.BASE)

    def test_nonsense_is_refused(self) -> None:
        for patch_ in (
            {"outcome": "12"}, {"outcome": ""}, {"outcome": "111111111"}, {"noise_model": "none"}, {"noise_model": "laser"},
            {"noise_strength": 0}, {"noise_strength": 0.6}, {"noise_strength": -0.1}, {"shots": 99}, {"shots": 20_001}, {"seed": -1},
            {"seed": 2**31}, {"min_share": 0}, {"min_share": 1}, {"min_share": 1.2}, {"extra": 1},
        ):
            with self.subTest(**patch_):
                with self.assertRaises(ValidationError):
                    NoisyOutcomeShare(**{**self.BASE, **patch_})

    def challenge(self, **check_changes):
        return Challenge(
            id="c", lesson_id="quantum-noise", title="t", goal="g", difficulty="beginner", success_condition="s", success_message="ok",
            constraints=Constraints(num_qubits=2, num_clbits=2, allowed_gates=[GateName.X, GateName.MEASURE], max_ops=8, must_measure=check_changes.pop("must_measure", [0, 1])),
            starter_circuit=circ(2, [], 2), reference_solution=circ(2, [g("x", 0), g("x", 1), m(0, 0), m(1, 1)], 2), hints=["h"],
            checks=[NoisyOutcomeShare(**{**self.BASE, **check_changes})],
        )

    def test_the_outcome_must_have_one_bit_per_classical_bit(self) -> None:
        self.challenge()
        with self.assertRaisesRegex(ValueError, "classical bits"):
            self.challenge(outcome="111")

    def test_every_qubit_must_be_measured(self) -> None:
        with self.assertRaisesRegex(ValueError, "must_measure"):
            self.challenge(must_measure=[0])

    def test_a_strength_outside_the_models_range_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "strength outside"):
            self.challenge(noise_model="depolarizing", noise_strength=0.4)


if __name__ == "__main__":
    unittest.main()
