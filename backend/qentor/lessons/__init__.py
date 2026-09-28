"""Lesson/Learn domain package.

Public surface for callers outside this package (currently only
``qentor.api.app``): the ``Lesson``/section models and the already-validated
``LESSONS`` catalog. Lesson content (``.content``) and the API route
(``qentor.api.app``) are deliberately not imported from here in the other
direction — this package never imports FastAPI or anything UI-related.
"""

from __future__ import annotations

from .models import (
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    Lesson,
    LessonSection,
    ReflectionSection,
)
from .registry import LESSONS, LessonRegistryError, get_lesson

__all__ = [
    "ConceptCheckSection",
    "ExplanationSection",
    "InteractiveLabSection",
    "Lesson",
    "LessonSection",
    "LessonRegistryError",
    "ReflectionSection",
    "LESSONS",
    "get_lesson",
]
