"""The rules for which learning facts become classroom events, and who may claim them.

The principle: **the server derives the fact; the client never supplies a metric.** A learner token says WHO (anonymously); it never says WHAT
HAPPENED.

* ``concept_check_submitted`` / ``concept_check_corrected``: written by the grading endpoint itself, from the verdict the server computed.
* ``challenge_solved`` / ``challenge_failed``: written by the challenge endpoint from the evaluation it just ran, with the ids of the checks that
  failed.
* ``experiment_shared``: written by the share endpoint.
* ``concept_check_synced``: written by ``sync_progress``, which GRADES the selections a browser says it saved (so a learner who studied before
  joining is counted honestly, but a selection cannot claim to be right: the server decides).
* ``lesson_started`` / ``challenge_started``: the only client-claimed events; they carry an id the server checks against its own catalog and no
  other data, and they are idempotent (a replay is a no-op).
* ``lesson_completed``: claimed by the client, but ACCEPTED only when the server's own record shows a correct answer to every graded concept check
  of that lesson from this learner. Completion cannot be asserted into existence.

A learner in no class produces no events at all: nothing is recorded until someone chooses to join.
"""

from __future__ import annotations

from dataclasses import dataclass

from qentor.challenges import get_challenge
from qentor.lessons import ConceptCheckSection, get_lesson
from qentor.lessons.grading import GradeError, grade_concept_check

from .store import DUPLICATE, LIMIT, RECORDED, ClassroomStore, Membership

CLIENT_CLAIMABLE = ("lesson_started", "lesson_completed", "challenge_started")
MAX_CHECK_EVENTS_PER_SUBJECT = 50
MAX_FAILED_CHECKS = 12
MAX_SYNC_ANSWERS = 200

UNKNOWN_SUBJECT = "UNKNOWN_SUBJECT"
LESSON_NOT_COMPLETE = "LESSON_NOT_COMPLETE_ON_SERVER"
NOT_IN_A_CLASS = "NOT_IN_A_CLASS"
EVENT_NOT_ALLOWED = "EVENT_NOT_ALLOWED"
EVENT_LIMIT = "EVENT_LIMIT"


class ClassroomError(Exception):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class SyncOutcome:
    recorded: int
    duplicates: int
    unknown: int


def _graded_checks(lesson_id: str) -> list[ConceptCheckSection]:
    lesson = get_lesson(lesson_id)
    if lesson is None:
        return []
    return [s for s in lesson.sections if isinstance(s, ConceptCheckSection) and s.question is not None]


class ClassroomService:
    def __init__(self, store: ClassroomStore) -> None:
        self.store = store

    # ------------------------------------------------------------------------------------------------------ server-derived

    def concept_check(self, learner_token: str | None, lesson_id: str, check_id: str, selected_option_id: str, correct: bool) -> None:
        member = self._member(learner_token)
        if member is None:
            return
        subject = f"{lesson_id}/{check_id}"
        previous = self.store.events_for_learner(member.cls.class_id, member.learner_id, ("concept_check_submitted", "concept_check_synced"))
        before = [e for e in previous if e.subject_id == subject]
        if len([e for e in before if e.kind == "concept_check_submitted"]) >= MAX_CHECK_EVENTS_PER_SUBJECT:
            return
        concept = self._concept(lesson_id, check_id)
        detail = {"concept": concept, "option": selected_option_id}
        outcome = "correct" if correct else "incorrect"
        self.store.add_event(member.cls.class_id, member.learner_id, "concept_check_submitted", subject, outcome, detail)
        if correct and any(e.outcome == "incorrect" for e in before) and not any(e.outcome == "correct" for e in before):
            self.store.add_event(member.cls.class_id, member.learner_id, "concept_check_corrected", subject, "correct", {"concept": concept})

    def challenge_attempt(self, learner_token: str | None, challenge_id: str, passed: bool, failed_check_ids: list[str]) -> None:
        member = self._member(learner_token)
        if member is None:
            return
        if passed:
            self.store.add_event(member.cls.class_id, member.learner_id, "challenge_solved", challenge_id, "correct", {})
        else:
            ids = [c[:60] for c in failed_check_ids[:MAX_FAILED_CHECKS]]
            self.store.add_event(member.cls.class_id, member.learner_id, "challenge_failed", challenge_id, "incorrect", {"failed_checks": ids})

    def experiment_shared(self, learner_token: str | None, experiment_id: str) -> None:
        member = self._member(learner_token)
        if member is None:
            return
        self.store.add_event(member.cls.class_id, member.learner_id, "experiment_shared", experiment_id, None, {})

    # -------------------------------------------------------------------------------------------------------- claimed

    def claim(self, learner_token: str, kind: str, subject_id: str) -> str:
        """A client-claimed event: ``RECORDED`` or ``DUPLICATE``, or a ``ClassroomError`` for anything the server will not take."""
        if kind not in CLIENT_CLAIMABLE:
            raise ClassroomError(EVENT_NOT_ALLOWED, f"{kind!r} is not an event a browser can report", 422)
        member = self._require_member(learner_token)
        if kind in ("lesson_started", "lesson_completed"):
            if get_lesson(subject_id) is None:
                raise ClassroomError(UNKNOWN_SUBJECT, f"no lesson {subject_id!r}", 404)
        elif get_challenge(subject_id) is None:
            raise ClassroomError(UNKNOWN_SUBJECT, f"no challenge {subject_id!r}", 404)
        if kind == "lesson_completed" and not self._lesson_complete_on_server(member, subject_id):
            raise ClassroomError(LESSON_NOT_COMPLETE, "the server has no correct answer on record for every concept check of this lesson yet", 409)
        status = self.store.add_event(member.cls.class_id, member.learner_id, kind, subject_id, None, {}, dedupe_key=f"{kind}:{subject_id}")
        if status == LIMIT:
            raise ClassroomError(EVENT_LIMIT, "this learner has reached the event limit for a class", 429)
        return status

    def sync_progress(self, learner_token: str, answers: list[tuple[str, str, str]]) -> SyncOutcome:
        """Grade the selections a browser saved and record each as ``concept_check_synced`` (idempotent)."""
        member = self._require_member(learner_token)
        recorded = duplicates = unknown = 0
        for lesson_id, check_id, option_id in answers[:MAX_SYNC_ANSWERS]:
            try:
                graded = grade_concept_check(lesson_id, check_id, option_id)
            except GradeError:
                unknown += 1
                continue
            subject = f"{lesson_id}/{check_id}"
            status = self.store.add_event(
                member.cls.class_id,
                member.learner_id,
                "concept_check_synced",
                subject,
                "correct" if graded.correct else "incorrect",
                {"concept": self._concept(lesson_id, check_id), "option": option_id},
                dedupe_key=f"synced:{subject}:{option_id}",
            )
            if status == RECORDED:
                recorded += 1
            elif status == DUPLICATE:
                duplicates += 1
        return SyncOutcome(recorded, duplicates, unknown)

    # ------------------------------------------------------------------------------------------------------------ helpers

    def _member(self, learner_token: str | None) -> Membership | None:
        if not learner_token:
            return None
        return self.store.membership_for_token(learner_token)

    def _require_member(self, learner_token: str) -> Membership:
        member = self.store.membership_for_token(learner_token)
        if member is None:
            raise ClassroomError(NOT_IN_A_CLASS, "this learner token is not in a class", 403)
        return member

    @staticmethod
    def _concept(lesson_id: str, check_id: str) -> str:
        for section in _graded_checks(lesson_id):
            if section.id == check_id:
                return (section.concept or lesson_id)[:80]
        return lesson_id[:80]

    def _lesson_complete_on_server(self, member: Membership, lesson_id: str) -> bool:
        checks = _graded_checks(lesson_id)
        events = self.store.events_for_learner(member.cls.class_id, member.learner_id, ("concept_check_submitted", "concept_check_synced"))
        correct = {e.subject_id for e in events if e.outcome == "correct"}
        return bool(checks) and all(f"{lesson_id}/{c.id}" in correct for c in checks)
