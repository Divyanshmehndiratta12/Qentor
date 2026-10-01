"""The anonymous classroom layer: classes, anonymous learners and the learning events the server derives.

Sits beside ``qentor.provenance`` (it is a writer used only by ``qentor.api``) and reads the lesson and challenge catalogs. It never imports the
tutor, execution or verification code, and the tutor never imports it (``tests/test_classroom_architecture.py``). See ``docs/ARCHITECTURE.md``
for the capability model and its limits.
"""

from __future__ import annotations

from .codes import alias_for, format_code, normalise_code
from .dashboard import ClassDashboard, build_dashboard
from .ratelimit import RateLimiter
from .service import ClassroomError, ClassroomService
from .store import ClassroomStore

__all__ = [
    "ClassDashboard",
    "ClassroomError",
    "ClassroomService",
    "ClassroomStore",
    "RateLimiter",
    "alias_for",
    "build_dashboard",
    "format_code",
    "normalise_code",
]
