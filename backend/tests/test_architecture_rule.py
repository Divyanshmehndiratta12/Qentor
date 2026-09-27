"""Architecture rule (Milestone 1 §11):

    execution -> tutor   MUST NOT exist
    verification -> tutor MUST NOT exist

``tutor`` does not exist yet, so this can't be proven by trying to import it and
watching it fail — that would pass trivially. Instead this statically parses every
``.py`` file under ``qentor/execution`` and ``qentor/verification`` and asserts no
``import`` or ``from ... import`` statement names a ``tutor`` module. This keeps
protecting the rule once ``tutor`` is added in a later milestone: the day someone
writes ``from qentor.tutor import ...`` inside ``execution/`` or
``verification/``, this test fails immediately.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
GUARDED_PACKAGES = ["qentor/execution", "qentor/verification"]


def _imported_module_names(py_file: Path) -> set[str]:
    tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


class TestNoTutorImportFromExecutionOrVerification(unittest.TestCase):
    def test_guarded_packages_never_import_tutor(self) -> None:
        checked_any_file = False
        for pkg in GUARDED_PACKAGES:
            pkg_dir = BACKEND_ROOT / pkg
            self.assertTrue(pkg_dir.is_dir(), f"expected package directory {pkg_dir} to exist")
            for py_file in pkg_dir.rglob("*.py"):
                checked_any_file = True
                imported = _imported_module_names(py_file)
                offending = {m for m in imported if m == "tutor" or m.startswith("tutor.") or m.startswith("qentor.tutor")}
                with self.subTest(file=str(py_file.relative_to(BACKEND_ROOT))):
                    self.assertFalse(
                        offending,
                        f"{py_file} imports tutor module(s) {offending}, which violates "
                        "the execution/verification -> tutor prohibition",
                    )
        self.assertTrue(checked_any_file, "no .py files were found to check — test would pass vacuously")

    def test_provenance_writer_is_not_reachable_by_name_from_tutor_free_zone(self) -> None:
        """Extra guard: the only module that may call ProvenanceStore.insert is
        qentor.api (and, transitively, the execution layer that returns results to
        it). qentor.execution.aer itself never imports qentor.provenance.store —
        it returns a plain ExecutionResult and lets the API layer decide whether to
        persist it. This keeps the write path in one place."""
        aer_file = BACKEND_ROOT / "qentor" / "execution" / "aer.py"
        imported = _imported_module_names(aer_file)
        self.assertNotIn("qentor.provenance.store", imported)


if __name__ == "__main__":
    unittest.main()
