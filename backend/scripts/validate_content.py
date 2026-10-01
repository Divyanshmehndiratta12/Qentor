"""Validate the shipped lesson and challenge content and print every problem found.

    backend/.venv/bin/python backend/scripts/validate_content.py            # runs every linked circuit on Qiskit Aer
    backend/.venv/bin/python backend/scripts/validate_content.py --no-run   # skip running circuits

Exit status 0 when there are no problems, 1 otherwise. A check that could not run (the simulator is unavailable) is listed under
"skipped" and does not by itself fail the run. See ``qentor/content/validation.py`` for what is checked.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qentor.api.app import app  # noqa: E402
from qentor.content import validate_content  # noqa: E402


def registered_routes() -> set[tuple[str, str]]:
    return {(method, route.path) for route in app.routes for method in getattr(route, "methods", None) or ()}


def main(argv: list[str]) -> int:
    report = validate_content(known_routes=registered_routes(), execute="--no-run" not in argv)
    print(report)
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
