"""Write (or check) ``fixtures/catalog/public_catalog.json``: what ``GET /api/lessons`` and ``GET /api/challenges`` serve.

The web suite parses this file through the real client and its schemas, so the browser is tested against the exact wire format
of the real catalog (16 lessons, 18 challenges) rather than a hand-made imitation. It holds ONLY the public view: no answer key,
no explanation, no reference solution, no check target. ``backend/tests/test_public_catalog_fixture.py`` fails if it drifts.

Usage (from the repository root):

    backend/.venv/bin/python backend/scripts/regen_catalog_fixture.py --check
    backend/.venv/bin/python backend/scripts/regen_catalog_fixture.py --write   # after a REVIEWED content change
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.encoders import jsonable_encoder  # noqa: E402

from qentor.api import app as app_module  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "catalog" / "public_catalog.json"


def live_catalog() -> dict:
    """The catalog exactly as the API serializes it (aliases included)."""
    return {
        "lessons": jsonable_encoder(app_module.list_lessons(), by_alias=True),
        "challenges": jsonable_encoder(app_module.list_challenges(), by_alias=True),
    }


def render(catalog: dict) -> str:
    return json.dumps(catalog, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "--check"
    text = render(live_catalog())
    if mode == "--write":
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        print(f"wrote {FIXTURE}")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        print("public catalog fixture is missing or has drifted; review, then run with --write")
        return 1
    print("catalog fixture OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
