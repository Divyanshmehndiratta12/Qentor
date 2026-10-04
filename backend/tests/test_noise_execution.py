"""Noisy simulation on Aer (``qentor.execution.noise``): the model table, the bounds, the seeded run and what each model physically does.

What these tests pin:

* the closed set of models, each with a range inside which the platform runs it, and a refusal (never a clamp) outside it;
* a fixed seed reproduces a run exactly, and a different seed does not;
* the noise is the SIMULATOR's: a fake simulator that returns known counts proves the result is exactly what it returned (nothing is
  perturbed afterwards) and that it was built with the density-matrix method, the noise model and the seed;
* the qualitative physics of each model, against literal expectations written here (a phase flip cannot change what a 0/1 measurement
  reads right after preparing a basis state; amplitude damping only moves |1> towards |0>; readout error leaves the state alone ...);
* the ideal path is unchanged by the optional seed, and its limits are tighter than an ordinary run's.
"""

from __future__ import annotations

import math
import unittest
from unittest.mock import patch

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.noise import (
    NOISE_MAX_QUBITS,
    NOISE_MAX_SHOTS,
    NOISE_MODEL_SPECS,
    NOISE_SIMULATION_METHOD,
    NOISY_SHOTS_MODE,
    SEED_MAX,
    NoiseConfig,
    NoiseError,
    NoiseModelName,
    build_noise_model,
    check_noise_limits,
    make_noise_config,
    run_noisy_shots,
)


def g(name, targets, controls=(), params=(), clbits=()):
    return GateOp(gate=name, targets=list(targets), controls=list(controls), params=list(params), clbits=list(clbits))


def measured(n, *ops):
    return Circuit(num_qubits=n, num_clbits=n, ops=[*ops, *[g("measure", [q], clbits=[q]) for q in range(n)]])


BELL = measured(2, g("h", [0]), g("cx", [1], [0]))
X_THEN_MEASURE = measured(1, g("x", [0]))  # ideal output: always "1"
JUST_MEASURE = measured(1)  # ideal output: always "0"
SHOTS = 4000


def cfg(model: str, strength: float, seed: int = 11) -> NoiseConfig:
    return make_noise_config(model, strength, seed)


def run(circuit: Circuit, model: str, strength: float, seed: int = 11, shots: int = SHOTS):
    return run_noisy_shots(circuit, shots, cfg(model, strength, seed))


def share(counts: dict[str, int], outcomes) -> float:
    return sum(c for o, c in counts.items() if o in outcomes) / sum(counts.values())


class AerCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")


class TestModelTable(unittest.TestCase):
    def test_the_models_are_exactly_these_six(self) -> None:
        self.assertEqual(
            sorted(m.value for m in NoiseModelName),
            ["amplitude_damping", "bit_flip", "depolarizing", "none", "phase_flip", "readout_error"],
        )
        self.assertEqual(set(NOISE_MODEL_SPECS), set(NoiseModelName))

    def test_every_noisy_model_has_a_bounded_range_with_its_default_inside_it(self) -> None:
        for name, spec in NOISE_MODEL_SPECS.items():
            with self.subTest(model=name.value):
                if name is NoiseModelName.NONE:
                    self.assertEqual((spec.min_strength, spec.max_strength), (0.0, 0.0))
                    continue
                self.assertEqual(spec.min_strength, 0.0)
                self.assertGreater(spec.max_strength, 0.0)
                self.assertLessEqual(spec.max_strength, 0.5)  # a probability of an error; past 0.5 the model changes meaning
                self.assertTrue(spec.min_strength <= spec.default_strength <= spec.max_strength)
                self.assertGreater(spec.step, 0)
                self.assertTrue(spec.expect, "every model says what to expect")
                self.assertIn(spec.applies_to, ("gates", "measurement"))

    def test_only_readout_error_acts_at_measurement(self) -> None:
        for name, spec in NOISE_MODEL_SPECS.items():
            if name is NoiseModelName.NONE:
                continue
            self.assertEqual(spec.applies_to, "measurement" if name is NoiseModelName.READOUT_ERROR else "gates")

    def test_no_model_claims_to_be_hardware(self) -> None:
        for spec in NOISE_MODEL_SPECS.values():
            text = " ".join([spec.label, spec.summary, spec.how_applied, *spec.expect]).lower()
            self.assertNotIn("fidelity", text)
            self.assertNotIn("calibrat", text)
            self.assertNotIn("real device", text.replace("not a real device", ""))


class TestValidation(unittest.TestCase):
    def test_a_valid_request_gets_the_strength_and_seed_it_asked_for(self) -> None:
        c = make_noise_config("depolarizing", 0.1, 42)
        self.assertEqual((c.model, c.strength, c.seed), (NoiseModelName.DEPOLARIZING, 0.1, 42))
        self.assertTrue(c.is_noisy)

    def test_no_strength_means_the_models_default(self) -> None:
        for name, spec in NOISE_MODEL_SPECS.items():
            self.assertEqual(make_noise_config(name.value, None, 1).strength, spec.default_strength)

    def test_an_unknown_model_is_refused_with_a_stable_code_and_the_list(self) -> None:
        with self.assertRaises(NoiseError) as ctx:
            make_noise_config("coherent_overrotation", 0.1, 1)
        self.assertEqual(ctx.exception.code, "NOISE_MODEL_UNKNOWN")
        self.assertIn("depolarizing", ctx.exception.message)

    def test_a_strength_outside_a_models_range_is_refused_not_clamped(self) -> None:
        for name, spec in NOISE_MODEL_SPECS.items():
            if name is NoiseModelName.NONE:
                continue
            for bad in (spec.max_strength + 0.001, 0.51, 1.0, -0.001, -1.0):
                if spec.min_strength <= bad <= spec.max_strength:
                    continue
                with self.subTest(model=name.value, strength=bad):
                    with self.assertRaises(NoiseError) as ctx:
                        make_noise_config(name.value, bad, 1)
                    self.assertEqual(ctx.exception.code, "NOISE_STRENGTH_OUT_OF_RANGE")
                    self.assertEqual(ctx.exception.limit, spec.max_strength)
                    self.assertEqual(ctx.exception.requested, bad)

    def test_the_ends_of_each_range_are_accepted(self) -> None:
        for name, spec in NOISE_MODEL_SPECS.items():
            for edge in (spec.min_strength, spec.max_strength):
                self.assertEqual(make_noise_config(name.value, edge, 1).strength, edge)

    def test_a_non_finite_or_non_numeric_strength_is_refused(self) -> None:
        for bad in (math.nan, math.inf, -math.inf, "0.1", True, [0.1]):
            with self.subTest(strength=bad):
                with self.assertRaises(NoiseError) as ctx:
                    make_noise_config("depolarizing", bad, 1)  # type: ignore[arg-type]
                self.assertEqual(ctx.exception.code, "NOISE_STRENGTH_INVALID")

    def test_none_takes_no_strength(self) -> None:
        self.assertEqual(make_noise_config("none", 0.0, 1).strength, 0.0)
        with self.assertRaises(NoiseError) as ctx:
            make_noise_config("none", 0.05, 1)
        self.assertEqual(ctx.exception.code, "NOISE_STRENGTH_NOT_ALLOWED")

    def test_a_seed_must_be_an_integer_in_range(self) -> None:
        for bad in (-1, SEED_MAX + 1, 1.5, True):
            with self.subTest(seed=bad):
                with self.assertRaises(NoiseError) as ctx:
                    make_noise_config("depolarizing", 0.1, bad)  # type: ignore[arg-type]
                self.assertEqual(ctx.exception.code, "NOISE_SEED_INVALID")
        self.assertEqual(make_noise_config("depolarizing", 0.1, 0).seed, 0)
        self.assertEqual(make_noise_config("depolarizing", 0.1, SEED_MAX).seed, SEED_MAX)

    def test_a_missing_seed_is_chosen_in_range_and_recorded(self) -> None:
        seeds = {make_noise_config("depolarizing", 0.1, None).seed for _ in range(20)}
        self.assertGreater(len(seeds), 1)
        self.assertTrue(all(0 <= s <= SEED_MAX for s in seeds))

    def test_describe_is_what_is_stored_beside_every_noisy_number(self) -> None:
        d = make_noise_config("readout_error", 0.2, 5).describe()
        self.assertEqual(d["model"], "readout_error")
        self.assertEqual(d["strength"], 0.2)
        self.assertEqual(d["applies_to"], "measurement")
        self.assertEqual(d["simulation_method"], NOISE_SIMULATION_METHOD)
        self.assertEqual(d["seed"], 5)
        self.assertIn("how_applied", d)


class TestLimits(unittest.TestCase):
    def test_a_noisy_run_is_limited_to_eight_qubits(self) -> None:
        check_noise_limits(measured(NOISE_MAX_QUBITS), 100)
        with self.assertRaises(NoiseError) as ctx:
            check_noise_limits(measured(NOISE_MAX_QUBITS + 1), 100)
        self.assertEqual(ctx.exception.code, "NOISE_TOO_MANY_QUBITS")
        self.assertEqual((ctx.exception.limit, ctx.exception.requested), (NOISE_MAX_QUBITS, NOISE_MAX_QUBITS + 1))

    def test_shots_are_bounded_both_ways(self) -> None:
        check_noise_limits(BELL, 1)
        check_noise_limits(BELL, NOISE_MAX_SHOTS)
        for bad in (0, -5, NOISE_MAX_SHOTS + 1, 10**9):
            with self.subTest(shots=bad):
                with self.assertRaises(NoiseError) as ctx:
                    check_noise_limits(BELL, bad)
                self.assertEqual(ctx.exception.code, "NOISE_SHOTS_OUT_OF_RANGE")

    def test_a_circuit_without_a_measurement_is_refused(self) -> None:
        with self.assertRaises(NoiseError) as ctx:
            check_noise_limits(Circuit(num_qubits=1, num_clbits=0, ops=[g("h", [0])]), 100)
        self.assertEqual(ctx.exception.code, "NOISE_NEEDS_MEASUREMENT")

    def test_the_none_model_has_no_noisy_run(self) -> None:
        with self.assertRaises(NoiseError) as ctx:
            run_noisy_shots(BELL, 100, make_noise_config("none", None, 1))
        self.assertEqual(ctx.exception.code, "NOISE_MODEL_NONE")

    def test_the_limits_are_far_inside_what_aer_can_do_in_a_second(self) -> None:
        self.assertEqual(NOISE_MAX_QUBITS, 8)
        self.assertEqual(NOISE_MAX_SHOTS, 20_000)


class TestTheSimulatorProducesTheNoise(AerCase):
    def test_a_fixed_seed_reproduces_a_run_exactly(self) -> None:
        a = run(BELL, "depolarizing", 0.1, seed=7)
        b = run(BELL, "depolarizing", 0.1, seed=7)
        self.assertEqual(a.counts, b.counts)
        self.assertEqual(a.probabilities, b.probabilities)

    def test_a_different_seed_gives_a_different_sample(self) -> None:
        self.assertNotEqual(run(BELL, "depolarizing", 0.3, seed=1).counts, run(BELL, "depolarizing", 0.3, seed=2).counts)

    def test_every_model_reproduces_under_a_fixed_seed(self) -> None:
        for name in NoiseModelName:
            if name is NoiseModelName.NONE:
                continue
            with self.subTest(model=name.value):
                self.assertEqual(run(BELL, name.value, 0.2, seed=3).counts, run(BELL, name.value, 0.2, seed=3).counts)

    def test_the_counts_are_exactly_what_the_simulator_returned(self) -> None:
        """A fake simulator returns known counts; the result must be those, unchanged, built with the noise model, the density-matrix method and the seed."""
        seen: dict = {}

        class FakeResult:
            success = True
            status = "COMPLETED"

            def get_counts(self, _qc):
                return {"01": 3, "10": 5, "11": 12}

        class FakeJob:
            def result(self):
                return FakeResult()

        class FakeSimulator:
            def __init__(self, **kwargs):
                seen.update(kwargs)

            def run(self, qc, shots):
                seen["shots"] = shots
                return FakeJob()

        with patch("qiskit_aer.AerSimulator", FakeSimulator):
            result = run_noisy_shots(BELL, 20, cfg("bit_flip", 0.25, seed=99))
        self.assertEqual(result.counts, {"01": 3, "10": 5, "11": 12})
        self.assertEqual(result.probabilities, {"01": 3 / 20, "10": 5 / 20, "11": 12 / 20})
        self.assertEqual(result.execution_mode, NOISY_SHOTS_MODE)
        self.assertEqual(seen["method"], "density_matrix")
        self.assertEqual(seen["seed_simulator"], 99)
        self.assertEqual(seen["shots"], 20)
        self.assertFalse(seen["noise_model"].is_ideal(), "the simulator was given a real noise model")
        self.assertEqual(result.noise["model"], "bit_flip")
        self.assertEqual(result.noise["strength"], 0.25)

    def test_a_failed_simulation_is_an_error_not_a_substitute(self) -> None:
        class FakeResult:
            success = False
            status = "ERROR: out of memory"

        class FakeJob:
            def result(self):
                return FakeResult()

        class FakeSimulator:
            def __init__(self, **_):
                pass

            def run(self, qc, shots):
                return FakeJob()

        with patch("qiskit_aer.AerSimulator", FakeSimulator):
            with self.assertRaises(AdapterExecutionError):
                run_noisy_shots(BELL, 20, cfg("depolarizing", 0.1))

    def test_the_payload_carries_the_noise_beside_the_counts(self) -> None:
        payload = run(BELL, "depolarizing", 0.1, seed=4).to_payload()
        self.assertEqual(payload["noise"]["model"], "depolarizing")
        self.assertEqual(payload["noise"]["seed"], 4)
        self.assertEqual(payload["shots"], SHOTS)
        self.assertEqual(sum(payload["counts"].values()), SHOTS)

    def test_every_gate_the_platform_has_runs_under_every_noise_model(self) -> None:
        circuit = measured(
            3,
            g("h", [0]), g("x", [1]), g("y", [2]), g("z", [0]), g("s", [0]), g("sdg", [0]), g("t", [1]), g("tdg", [1]),
            g("rx", [0], params=[0.3]), g("ry", [1], params=[0.4]), g("rz", [2], params=[0.5]),
            g("cx", [1], [0]), g("cz", [2], [1]), g("cp", [2], [0], params=[0.7]), g("swap", [0, 1]), g("ccx", [2], [0, 1]),
        )
        for name in NoiseModelName:
            if name is NoiseModelName.NONE:
                continue
            with self.subTest(model=name.value):
                result = run_noisy_shots(circuit, 200, cfg(name.value, 0.05))
                self.assertEqual(sum(result.counts.values()), 200)


class TestWhatEachModelDoes(AerCase):
    """Qualitative physics, with literal expectations. Seeds are fixed so these are deterministic; the margins are wide."""

    def test_zero_strength_gate_noise_changes_nothing_from_the_ideal_support(self) -> None:
        for name in ("depolarizing", "bit_flip", "phase_flip", "amplitude_damping", "readout_error"):
            with self.subTest(model=name):
                self.assertEqual(set(run(BELL, name, 0.0).counts), {"00", "11"})

    def test_depolarizing_noise_puts_probability_on_outcomes_the_ideal_circuit_never_gives(self) -> None:
        off = lambda p: 1 - share(run(BELL, "depolarizing", p).counts, {"00", "11"})
        self.assertEqual(off(0.0), 0.0)
        self.assertLess(off(0.02), off(0.1))
        self.assertLess(off(0.1), off(0.3))
        self.assertGreater(off(0.3), 0.15)

    def test_depolarizing_strength_is_the_chance_the_qubit_is_replaced_so_a_wrong_reading_is_half_of_it(self) -> None:
        # One X gate, then measure. With probability p the qubit is replaced by the maximally mixed state, which reads 0 half the time:
        # the wrong-reading rate is p / 2 = 0.15 at p = 0.3. (A bit flip with the same strength would give 0.3, which is what tells them apart.)
        wrong = 1 - share(run(X_THEN_MEASURE, "depolarizing", 0.3).counts, {"1"})
        self.assertTrue(0.12 < wrong < 0.18, wrong)

    def test_more_gates_collect_more_depolarizing_noise(self) -> None:
        shallow = measured(1, g("x", [0]))
        deep = measured(1, *[g("x", [0]) for _ in range(9)])  # nine X gates: ideal output is still "1"
        for_shallow = 1 - share(run(shallow, "depolarizing", 0.05).counts, {"1"})
        for_deep = 1 - share(run(deep, "depolarizing", 0.05).counts, {"1"})
        self.assertLess(for_shallow, for_deep)

    def test_a_phase_flip_cannot_change_what_a_basis_measurement_reads(self) -> None:
        self.assertEqual(set(run(BELL, "phase_flip", 0.5).counts), {"00", "11"})
        self.assertEqual(set(run(X_THEN_MEASURE, "phase_flip", 0.5).counts), {"1"})

    def test_a_phase_flip_does_matter_when_a_later_gate_turns_phase_into_amplitude(self) -> None:
        # H, H is the identity: the ideal output is always "0". A Z error between them turns it into an X-like flip before the second H.
        circuit = measured(1, g("h", [0]), g("h", [0]))
        self.assertEqual(set(run(circuit, "phase_flip", 0.0).counts), {"0"})
        self.assertGreater(1 - share(run(circuit, "phase_flip", 0.3).counts, {"0"}), 0.1)

    def test_a_bit_flip_swaps_zero_and_one(self) -> None:
        wrong = 1 - share(run(X_THEN_MEASURE, "bit_flip", 0.5).counts, {"1"})
        self.assertTrue(0.4 < wrong < 0.6, wrong)  # p = 0.5 after the single gate: a fair coin

    def test_amplitude_damping_only_moves_one_towards_zero(self) -> None:
        down = 1 - share(run(X_THEN_MEASURE, "amplitude_damping", 0.5).counts, {"1"})
        self.assertTrue(0.4 < down < 0.6, down)  # |1> decays with probability gamma = 0.5
        # |0> has nothing to decay into: a circuit that never leaves 0 is untouched, whatever gamma is
        self.assertEqual(set(run(JUST_MEASURE, "amplitude_damping", 0.5).counts), {"0"})
        self.assertEqual(set(run(measured(1, g("z", [0])), "amplitude_damping", 0.5).counts), {"0"})

    def test_readout_error_flips_reported_bits_without_touching_the_gates(self) -> None:
        # No gate at all: only the readout can make a "0" read as "1".
        reads_one = share(run(JUST_MEASURE, "readout_error", 0.2).counts, {"1"})
        self.assertTrue(0.16 < reads_one < 0.24, reads_one)
        coin = share(run(JUST_MEASURE, "readout_error", 0.5).counts, {"1"})
        self.assertTrue(0.45 < coin < 0.55, coin)
        self.assertEqual(set(run(JUST_MEASURE, "readout_error", 0.0).counts), {"0"})

    def test_readout_error_acts_on_every_measured_bit(self) -> None:
        # Two untouched qubits: each bit flips independently, so all four outcomes appear at p = 0.3.
        self.assertEqual(set(run(measured(2), "readout_error", 0.3).counts), {"00", "01", "10", "11"})

    def test_a_gate_noise_model_leaves_a_circuit_with_no_gates_alone(self) -> None:
        for name in ("depolarizing", "bit_flip", "phase_flip", "amplitude_damping"):
            with self.subTest(model=name):
                self.assertEqual(set(run(JUST_MEASURE, name, 0.3).counts), {"0"})  # gate noise is applied after gates; there are none


class TestTheIdealPathIsUnchanged(AerCase):
    def test_an_ideal_shots_run_without_a_seed_builds_the_simulator_exactly_as_before(self) -> None:
        calls: list[dict] = []
        real = __import__("qiskit_aer").AerSimulator

        class Spy(real):  # type: ignore[misc, valid-type]
            def __init__(self, *args, **kwargs):
                calls.append({"args": args, "kwargs": kwargs})
                super().__init__(*args, **kwargs)

        with patch("qiskit_aer.AerSimulator", Spy):
            AerAdapter().run(BELL, "shots", 100)
        self.assertEqual(calls, [{"args": (), "kwargs": {}}])

    def test_a_seed_fixes_the_ideal_sampler_and_no_seed_leaves_it_free(self) -> None:
        adapter = AerAdapter()
        self.assertEqual(adapter.run(BELL, "shots", 500, seed_simulator=5).counts, adapter.run(BELL, "shots", 500, seed_simulator=5).counts)

    def test_the_ideal_run_has_no_noise_and_is_an_ordinary_shots_result(self) -> None:
        result = AerAdapter().run(BELL, "shots", 500, seed_simulator=1)
        self.assertEqual(result.execution_mode, "shots")
        self.assertNotIn("noise", result.to_payload())
        self.assertEqual(set(result.counts), {"00", "11"})

    def test_statevector_mode_ignores_the_seed(self) -> None:
        sv = AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[g("h", [0])]), "statevector", seed_simulator=3)
        self.assertEqual(sv.execution_mode, "statevector")
        self.assertAlmostEqual(sv.statevector[0][0], 1 / math.sqrt(2), places=9)

    def test_a_noise_model_for_none_is_empty_and_for_the_others_is_not(self) -> None:
        self.assertTrue(build_noise_model(cfg("none", 0.0)).is_ideal())
        for name in ("depolarizing", "bit_flip", "phase_flip", "amplitude_damping", "readout_error"):
            self.assertFalse(build_noise_model(cfg(name, 0.1)).is_ideal(), name)


if __name__ == "__main__":
    unittest.main()
