"""``fixtures/catalog/public_catalog.json`` is exactly what the API serves, and it holds no answer.

The web suite loads this file to test the browser against the real catalog's wire format. If the content changes and the file does
not, the browser tests would be checking a catalog that no longer exists: so drift fails here, with the command to fix it.
"""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "backend" / "scripts" / "regen_catalog_fixture.py"


def load_script():
    spec = importlib.util.spec_from_file_location("regen_catalog_fixture", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestPublicCatalogFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.script = load_script()
        self.text = self.script.FIXTURE.read_text(encoding="utf-8")
        self.fixture = json.loads(self.text)

    def test_it_matches_what_the_api_serves_right_now(self) -> None:
        self.assertEqual(
            self.text,
            self.script.render(self.script.live_catalog()),
            "fixtures/catalog/public_catalog.json is stale: run backend/scripts/regen_catalog_fixture.py --write and review the diff",
        )

    def test_it_has_the_whole_catalog(self) -> None:
        self.assertEqual(len(self.fixture["lessons"]["lessons"]), 18)
        self.assertEqual(len(self.fixture["challenges"]["challenges"]), 19)

    def test_it_holds_no_answer_key_explanation_reference_or_target(self) -> None:
        for forbidden in (
            "correct_option_id",
            "reference_solution",
            "replace_anchor",
            "misconception",
            '"experiment"',
            '"target"',
            '"explanation":',  # a section's "type": "explanation" is a tag, not a field
        ):
            self.assertNotIn(forbidden, self.text, forbidden)

    def test_it_is_the_catalog_of_the_content_modules(self) -> None:
        from qentor.challenges import CHALLENGES
        from qentor.lessons import LESSONS

        self.assertEqual([l["id"] for l in self.fixture["lessons"]["lessons"]], [l.id for l in LESSONS])
        self.assertEqual([c["id"] for c in self.fixture["challenges"]["challenges"]], [c.id for c in CHALLENGES])


if __name__ == "__main__":
    unittest.main()
