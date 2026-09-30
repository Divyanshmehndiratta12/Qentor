"""The validated challenge catalog, built once at import (a content bug fails at startup, like the lesson registry)."""

from __future__ import annotations

from qentor.lessons import LESSONS

from .content import RAW_CHALLENGES
from .models import Challenge


class ChallengeRegistryError(Exception):
    """The challenge catalog itself is inconsistent - a content bug."""


def build_registry(challenges: list[Challenge] | None = None, lesson_ids: set[str] | None = None) -> list[Challenge]:
    catalog = list(challenges if challenges is not None else RAW_CHALLENGES)
    known_lessons = lesson_ids if lesson_ids is not None else {lesson.id for lesson in LESSONS}

    ids = [c.id for c in catalog]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise ChallengeRegistryError(f"duplicate challenge id(s): {duplicates}")
    for challenge in catalog:
        if challenge.lesson_id not in known_lessons:
            raise ChallengeRegistryError(f"challenge '{challenge.id}' names unknown lesson '{challenge.lesson_id}'")
    return catalog


CHALLENGES: list[Challenge] = build_registry()
CHALLENGE_BY_ID: dict[str, Challenge] = {c.id: c for c in CHALLENGES}


def get_challenge(challenge_id: str) -> Challenge | None:
    return CHALLENGE_BY_ID.get(challenge_id)
