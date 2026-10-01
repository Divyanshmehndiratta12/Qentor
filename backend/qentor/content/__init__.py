"""Cross-catalog content checks (``validation.py``).

Sits above ``qentor.lessons`` and ``qentor.challenges`` (the two catalogs it checks against each other), and below
``qentor.api``: nothing at runtime imports it; tests and ``backend/scripts/validate_content.py`` do.
"""

from __future__ import annotations

from .validation import ContentReport, Problem, validate_content

__all__ = ["ContentReport", "Problem", "validate_content"]
