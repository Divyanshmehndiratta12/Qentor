"""Final quality sprint: the words a learner reads when a challenge check fails or passes.

Every message is composed from a rule and a number, so grammar slips ("Uses at most 1 operations", "The fixed corrections is exactly
these gates") only show up for particular challenges. This runs every challenge's own starter circuit on the real Aer adapter and
reads what the evaluator says. A verdict is never touched here; only its explanation is checked.
"""

from __future__ import annotations

import re
import unittest

from qentor.challenges import CHALLENGE_BY_ID, CHALLENGES, evaluate_challenge
from qentor.challenges.content import circ, g
from qentor.circuit.model import Circuit
from qentor.execution.aer import AerAdapter

AER = AerAdapter()


def judge(challenge_id: str, circuit: Circuit):
    return evaluate_challenge(CHALLENGE_BY_ID[challenge_id], circuit, AER, max_qubits=8, max_operations=64)


class TestEveryStarterIsExplainedInPlainGrammar(unittest.TestCase):
    def test_no_count_of_one_is_pluralised_and_no_plural_name_takes_a_singular_verb(self) -> None:
        for challenge in CHALLENGES:
            evaluation = judge(challenge.id, challenge.starter_circuit)
            for check in evaluation.checks:
                for text in (check.label, check.detail):
                    with self.subTest(challenge=challenge.id, check=check.id):
                        self.assertNotRegex(text, r"\b1 operations\b")
                        self.assertNotRegex(text, r"\b1 times\b")
                        self.assertNotRegex(text, r"\b1 \w+ gates\b")
                        self.assertNotRegex(text, r"\bis exactly these gates\b")
                        self.assertNotRegex(text, r"\bis present once\b")

    def test_every_failed_check_says_why_in_a_full_sentence(self) -> None:
        for challenge in CHALLENGES:
            evaluation = judge(challenge.id, challenge.starter_circuit)
            self.assertFalse(evaluation.passed, challenge.id)  # a starter is never the answer
            for check in evaluation.checks:
                if not check.passed:
                    with self.subTest(challenge=challenge.id, check=check.id):
                        self.assertTrue(check.detail.strip(), "a failed check with no explanation")
                        self.assertRegex(check.detail.strip(), r"[.!?)]$")


class TestSpecificSentences(unittest.TestCase):
    def test_a_one_operation_limit_reads_in_the_singular(self) -> None:
        # vqe-find-theta allows exactly one operation
        ok = judge("vqe-find-theta", circ(1, [g("ry", 0, angle=3.141592653589793)]))
        size = next(c for c in ok.checks if c.id == "structure.size")
        self.assertEqual(size.label, "Uses at most 1 operation")
        over = judge("vqe-find-theta", circ(1, [g("ry", 0, angle=1.0), g("ry", 0, angle=1.0)]))
        size = next(c for c in over.checks if c.id == "structure.size")
        self.assertFalse(size.passed)
        self.assertEqual(size.detail, "The circuit has 2 operations; this challenge allows at most 1.")

    def test_the_fixed_part_is_named_without_a_verb_that_must_agree_with_it(self) -> None:
        for challenge_id, name in (("teleport-ry-fixed", "corrections"), ("qpe-estimate-t", "controlled powers of T"), ("grover-find-01", "oracle")):
            starter = CHALLENGE_BY_ID[challenge_id].starter_circuit
            check = next(c for c in judge(challenge_id, starter).checks if c.id == "structure.oracle")
            self.assertFalse(check.passed)
            self.assertEqual(check.label, f"Keeps the fixed {name} exactly as given")
            self.assertTrue(check.detail.startswith(f"Keep the fixed {name} as given: exactly these gates"), check.detail)
            self.assertIsNone(re.search(r"\bis exactly\b", check.detail))

    def test_a_passing_reference_still_passes(self) -> None:
        for challenge in CHALLENGES:
            if challenge.reference_solution is None:
                continue
            with self.subTest(challenge=challenge.id):
                self.assertTrue(judge(challenge.id, challenge.reference_solution).passed)


if __name__ == "__main__":
    unittest.main()
