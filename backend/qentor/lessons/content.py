"""Raw lesson content for the Learn catalog.

The seven foundation lessons (Qubits & Measurement through Bell State) live in
``qentor.lessons.content_foundations``; the three advanced lessons (Phase Kickback,
Deutsch–Jozsa, Bernstein–Vazirani) live in ``qentor.lessons.content_advanced``. All
ten are full mini-lessons; lessons 11-13 (Superdense Coding, Quantum Teleportation, Grover's Search) live in
``qentor.lessons.content_batch1``; lessons 14-16 (the Quantum Fourier Transform, Quantum Phase Estimation and Quantum Error
Correction) live in ``qentor.lessons.content_algorithms``; lesson 17 (a one-parameter variational, VQE-style demonstration) lives in
``qentor.lessons.content_variational``; lesson 18 (Shor's algorithm, order-finding intuition, one fixed instance) lives in
``qentor.lessons.content_shor``. Every ``linked_circuit`` is a single, fixed, hand-written
circuit (plain data through the existing canonical ``Circuit``/``GateOp`` model),
never a new algorithm or oracle-family generator.

This package is intentionally the only place lesson prose/circuits live: it has
no knowledge of FastAPI, the provenance store, or any UI. See
``qentor.lessons.registry`` for loading/validation and ``qentor.api.app`` for
the read-only route that serves this content.
"""

from __future__ import annotations

from .content_advanced import ADVANCED_LESSONS
from .content_algorithms import ALGORITHM_LESSONS
from .content_batch1 import BATCH1_LESSONS
from .content_foundations import FOUNDATION_LESSONS
from .content_shor import SHOR_LESSONS
from .content_variational import VARIATIONAL_LESSONS
from .models import Lesson

# Declaration order is the catalog order the API serves.
RAW_LESSONS: list[Lesson] = [*FOUNDATION_LESSONS, *ADVANCED_LESSONS, *BATCH1_LESSONS, *ALGORITHM_LESSONS, *VARIATIONAL_LESSONS, *SHOR_LESSONS]
