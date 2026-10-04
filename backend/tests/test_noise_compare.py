"""The ideal-versus-noisy comparison (``qentor.verification.noise_compare``), on literal count tables with hand-computed answers.

The expected numbers are written here as arithmetic on the tables, never read back from the function under test. These tests also pin what the
module refuses to do: it does not call anything "fidelity" or "success", it does not repair tables that disagree about the shots, and every
number in an explanation sentence is one of the metrics.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from qentor.execution.noise import make_noise_config
from qentor.verification import noise_compare
from qentor.verification.noise_compare import NoiseComparisonError, compare_noise

CONFIG = make_noise_config("depolarizing", 0.05, 7)

# 100 shots each. Ideal Bell pair: 00 and 11 only. Noisy: some weight leaked to 01 and 10.
IDEAL = {"00": 52, "11": 48}
NOISY = {"00": 41, "11": 39, "01": 11, "10": 9}


class TestNumbers(unittest.TestCase):
    def setUp(self) -> None:
        self.c = compare_noise(IDEAL, NOISY, 100, CONFIG)

    def test_the_table_has_one_row_per_outcome_in_either_run_sorted_by_bitstring(self) -> None:
        self.assertEqual([r.outcome for r in self.c.rows], ["00", "01", "10", "11"])

    def test_each_row_is_a_count_and_its_frequency(self) -> None:
        rows = {r.outcome: r for r in self.c.rows}
        self.assertEqual((rows["00"].ideal_count, rows["00"].noisy_count), (52, 41))
        self.assertEqual((rows["01"].ideal_count, rows["01"].noisy_count), (0, 11))
        self.assertAlmostEqual(rows["00"].ideal_probability, 0.52, places=12)
        self.assertAlmostEqual(rows["00"].noisy_probability, 0.41, places=12)
        self.assertAlmostEqual(rows["00"].delta, 0.41 - 0.52, places=12)
        self.assertAlmostEqual(rows["01"].delta, 0.11, places=12)

    def test_total_variation_distance_is_half_the_sum_of_absolute_differences(self) -> None:
        # |0.52-0.41| + |0-0.11| + |0-0.09| + |0.48-0.39| = 0.11 + 0.11 + 0.09 + 0.09 = 0.40, halved = 0.20
        self.assertAlmostEqual(self.c.metrics.total_variation_distance, 0.20, places=12)

    def test_it_is_zero_for_identical_tables_and_one_for_disjoint_ones(self) -> None:
        self.assertEqual(compare_noise(IDEAL, dict(IDEAL), 100, CONFIG).metrics.total_variation_distance, 0.0)
        self.assertAlmostEqual(compare_noise({"00": 100}, {"11": 100}, 100, CONFIG).metrics.total_variation_distance, 1.0, places=12)

    def test_the_share_of_noisy_shots_on_outcomes_the_ideal_run_produced(self) -> None:
        self.assertAlmostEqual(self.c.metrics.noisy_share_on_ideal_outcomes, (41 + 39) / 100, places=12)

    def test_new_outcomes_are_those_only_the_noisy_run_produced(self) -> None:
        self.assertEqual(self.c.metrics.ideal_outcomes, ["00", "11"])
        self.assertEqual(self.c.metrics.new_outcomes, ["01", "10"])
        self.assertEqual(self.c.metrics.new_outcome_shots, 20)

    def test_distinct_outcome_counts(self) -> None:
        self.assertEqual((self.c.metrics.ideal_distinct_outcomes, self.c.metrics.noisy_distinct_outcomes), (2, 4))

    def test_the_ideal_runs_most_frequent_outcome_is_reported_with_both_frequencies(self) -> None:
        (top,) = self.c.metrics.ideal_top_outcomes
        self.assertEqual(top.outcome, "00")
        self.assertAlmostEqual(top.ideal_probability, 0.52, places=12)
        self.assertAlmostEqual(top.noisy_probability, 0.41, places=12)

    def test_ties_are_all_reported(self) -> None:
        c = compare_noise({"00": 50, "11": 50}, {"00": 45, "11": 55}, 100, CONFIG)
        self.assertEqual([t.outcome for t in c.metrics.ideal_top_outcomes], ["00", "11"])

    def test_two_noiseless_tables_with_the_same_outcomes_have_no_new_outcomes(self) -> None:
        c = compare_noise({"00": 60, "11": 40}, {"00": 58, "11": 42}, 100, CONFIG)
        self.assertEqual(c.metrics.new_outcomes, [])
        self.assertEqual(c.metrics.new_outcome_shots, 0)
        self.assertAlmostEqual(c.metrics.noisy_share_on_ideal_outcomes, 1.0, places=12)
        self.assertAlmostEqual(c.metrics.total_variation_distance, 0.02, places=12)


class TestRefusals(unittest.TestCase):
    def test_tables_that_do_not_add_up_to_the_shots_are_refused_not_repaired(self) -> None:
        with self.assertRaises(NoiseComparisonError):
            compare_noise({"00": 50, "11": 49}, NOISY, 100, CONFIG)
        with self.assertRaises(NoiseComparisonError):
            compare_noise(IDEAL, {"00": 41, "11": 39, "01": 11}, 100, CONFIG)

    def test_shots_must_be_positive(self) -> None:
        with self.assertRaises(NoiseComparisonError):
            compare_noise({}, {}, 0, CONFIG)

    def test_the_module_does_not_import_a_backend_or_a_model(self) -> None:
        source = Path(noise_compare.__file__).read_text(encoding="utf-8")
        for forbidden in ("qiskit", "qentor.tutor", "qentor.execution.aer", "random", "numpy"):
            self.assertNotIn(f"import {forbidden}", source)
            self.assertNotIn(f"from {forbidden}", source)


class TestExplanation(unittest.TestCase):
    def setUp(self) -> None:
        self.c = compare_noise(IDEAL, NOISY, 100, CONFIG)
        self.text = " ".join(line.text for line in self.c.explanation)

    def test_lines_are_numbered_and_each_says_something(self) -> None:
        self.assertEqual([line.id for line in self.c.explanation], [f"N{i}" for i in range(1, len(self.c.explanation) + 1)])
        self.assertTrue(all(len(line.text) > 20 for line in self.c.explanation))

    def test_it_names_the_model_its_strength_and_the_seed(self) -> None:
        self.assertIn("Depolarizing gate noise", self.text)
        self.assertIn("Strength: 0.05", self.text)
        self.assertIn("seed 7", self.text)

    def test_the_numbers_in_it_are_the_metrics(self) -> None:
        self.assertIn("20 of 100 noisy shots (20.0%)", self.text)
        self.assertIn("01, 10", self.text)
        self.assertIn("0.2000", self.text)  # the total variation distance
        self.assertIn("0.5200", self.text)
        self.assertIn("0.4100", self.text)

    def test_every_decimal_in_it_is_one_of_the_computed_numbers(self) -> None:
        allowed = {"0.05", "0.2000", "0.5200", "0.4100", "20.0"}
        for number in re.findall(r"\d+\.\d+", self.text):
            self.assertIn(number, allowed, f"a number appears in the explanation that is not a computed one: {number}")

    def test_it_says_when_every_noisy_shot_was_an_ideal_outcome(self) -> None:
        c = compare_noise({"00": 60, "11": 40}, {"00": 58, "11": 42}, 100, CONFIG)
        self.assertIn("Every noisy shot landed on an outcome the ideal run also produced.", " ".join(line.text for line in c.explanation))

    def test_it_warns_that_a_run_is_a_finite_sample(self) -> None:
        self.assertIn("finite sample", self.text)
        self.assertIn("finite sample", noise_compare.NOTE)

    def test_it_never_uses_the_words_fidelity_or_success_or_hardware(self) -> None:
        lowered = (self.text + noise_compare.NOTE).lower()
        for word in ("fidelity", "success", "correct", "hardware calibrat"):
            self.assertNotIn(word, lowered)

    def test_each_model_is_described_in_its_own_words(self) -> None:
        for name, phrase in (("readout_error", "reported flipped"), ("amplitude_damping", "amplitude-damping"), ("bit_flip", "X error"), ("phase_flip", "Z error")):
            config = make_noise_config(name, None, 1)
            lines = " ".join(line.text for line in compare_noise(IDEAL, NOISY, 100, config).explanation)
            self.assertIn(phrase, lines, name)


if __name__ == "__main__":
    unittest.main()
