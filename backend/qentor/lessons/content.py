"""Raw lesson content for the Learn catalog.

The seven foundation lessons (Qubits & Measurement through Bell State) live in
``qentor.lessons.content_foundations``; the three advanced lessons (Phase Kickback,
Deutsch–Jozsa, Bernstein–Vazirani) live in ``qentor.lessons.content_advanced``. All
ten are full mini-lessons. Every ``linked_circuit`` is a single, fixed, hand-written
circuit (plain data through the existing canonical ``Circuit``/``GateOp`` model),
never a new algorithm or oracle-family generator.

This package is intentionally the only place lesson prose/circuits live: it has
no knowledge of FastAPI, the provenance store, or any UI. See
``qentor.lessons.registry`` for loading/validation and ``qentor.api.app`` for
the read-only route that serves this content.
"""

from __future__ import annotations

from .content_advanced import ADVANCED_LESSONS
from .content_foundations import FOUNDATION_LESSONS
from .models import Lesson

# Declaration order is the catalog order the API serves.
RAW_LESSONS: list[Lesson] = [*FOUNDATION_LESSONS, *ADVANCED_LESSONS]
