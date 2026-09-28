"""Loads and cross-validates the lesson content (``qentor.lessons.content``)
into the catalog the API serves.

Per-lesson shape is already enforced by ``Lesson``'s own pydantic validators
(unique section ids, an interactive lab requires a linked circuit, no
self-prerequisite). What's left here is validation that spans *multiple*
lessons — a single ``Lesson`` object has no way to know whether its own id is
unique across the catalog, or whether the prerequisite ids it lists actually
exist — so this module builds the full list once and checks those invariants
before anything downstream (the API route) can see a broken catalog.
"""

from __future__ import annotations

from .content import RAW_LESSONS
from .models import Lesson


class LessonRegistryError(Exception):
    """The lesson catalog itself is inconsistent — a content bug, not a
    per-lesson validation error (which pydantic already raises as its own
    ``ValidationError`` during ``Lesson`` construction)."""


def build_registry(lessons: list[Lesson] | None = None) -> list[Lesson]:
    """Validate and return the lesson catalog, in a stable, deterministic
    order (declaration order in ``qentor.lessons.content.RAW_LESSONS``).

    Accepts an explicit ``lessons`` list so tests can exercise the
    cross-lesson checks below against deliberately broken catalogs without
    touching the real content module.
    """
    catalog = list(lessons if lessons is not None else RAW_LESSONS)

    ids = [lesson.id for lesson in catalog]
    seen: set[str] = set()
    duplicates: set[str] = set()
    for lesson_id in ids:
        if lesson_id in seen:
            duplicates.add(lesson_id)
        seen.add(lesson_id)
    if duplicates:
        raise LessonRegistryError(f"duplicate lesson id(s): {sorted(duplicates)}")

    known_ids = set(ids)
    for lesson in catalog:
        unknown = [p for p in lesson.prerequisite_lesson_ids if p not in known_ids]
        if unknown:
            raise LessonRegistryError(
                f"lesson '{lesson.id}' lists unknown prerequisite id(s): {unknown}"
            )

    return catalog


# Built once at import time, like every other module-level singleton in this
# backend (qentor.api.app's _store/_adapters/_llm_adapter) — a content bug
# fails fast at process startup, not on the first request.
LESSONS: list[Lesson] = build_registry()
LESSON_BY_ID: dict[str, Lesson] = {lesson.id: lesson for lesson in LESSONS}


def get_lesson(lesson_id: str) -> Lesson | None:
    return LESSON_BY_ID.get(lesson_id)
