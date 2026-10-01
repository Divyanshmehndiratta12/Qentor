"""The instructor's aggregate view of one class, computed ONLY from the events the server itself recorded.

Nothing here is invented, estimated or padded: with no learners the lists say so by being empty, every number is a count of real events or
real learners, and every group carries the size of the sample it was computed from. A learner appears only as an alias (``Learner 4F2A``): no
learner id, token, class capability or other identifying value is ever part of the result. Learners who left the class are not in it.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict

from qentor.challenges import CHALLENGES
from qentor.lessons import LESSONS, ConceptCheckSection

from .codes import alias_for, format_code
from .store import ClassRecord, ClassroomStore, EventRow

DATA_NOTE = (
    "Anonymous classroom data. Learners are random tokens shown as aliases such as Learner 4F2A: there are no names, no accounts and no personal "
    "data. Every figure counts real events from learners who joined this class, and every group shows how many learners it is based on."
)
ACTIVE_WINDOW_DAYS = 7
MAX_MISCONCEPTIONS = 25
MAX_RECENT = 25
_CHECK_KINDS = ("concept_check_submitted", "concept_check_synced")


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ClassInfo(_Model):
    class_code: str
    title: str
    created_at: str


class SampleInfo(_Model):
    learners_in_class: int
    learners_left: int
    active_learners: int
    active_window_days: int
    events_total: int


class CheckRow(_Model):
    check_id: str
    concept: str
    answered: int
    correct: int


class LessonRow(_Model):
    lesson_id: str
    title: str
    started: int
    completed: int
    developing: int
    assessment_answered: int
    assessment_correct: int
    checks: list[CheckRow]


class FailurePattern(_Model):
    check_id: str
    label: str
    count: int
    learners: int


class ChallengeRow(_Model):
    challenge_id: str
    title: str
    lesson_id: str
    started: int
    attempting_learners: int
    attempts: int
    solved_learners: int
    failed_attempts: int
    failure_patterns: list[FailurePattern]


class MisconceptionRow(_Model):
    kind: str  # "concept" or "challenge_check"
    category: str
    lesson_id: str
    challenge_id: str | None
    learners_affected: int
    still_incorrect: int | None
    sample_size: int
    explanation: str | None


class RecentRow(_Model):
    alias: str
    kind: str
    subject_id: str
    subject_label: str
    outcome: str | None
    created_at: str


class ClassDashboard(_Model):
    class_info: ClassInfo
    sample: SampleInfo
    empty: bool
    data_note: str
    lessons: list[LessonRow]
    challenges: list[ChallengeRow]
    misconceptions: list[MisconceptionRow]
    recent: list[RecentRow]


def _check_label(challenge, check_id: str) -> str:  # noqa: ANN001
    for check in challenge.checks:
        if check.id == check_id:
            return check.label
    if check_id.startswith("structure."):
        return f"Structure rule: {check_id.split('.', 1)[1]}"
    return check_id


def build_dashboard(store: ClassroomStore, cls: ClassRecord, now: datetime) -> ClassDashboard:
    events = store.member_events(cls.class_id)
    in_class, left = store.member_counts(cls.class_id)
    window_start = (now - timedelta(days=ACTIVE_WINDOW_DAYS)).isoformat()
    active = {e.learner_id for e in events if e.created_at >= window_start}

    by_learner: dict[str, list[EventRow]] = defaultdict(list)
    for e in events:
        by_learner[e.learner_id].append(e)

    lesson_by_id = {lesson.id: lesson for lesson in LESSONS}
    challenge_by_id = {c.id: c for c in CHALLENGES}

    # ---- lessons
    lesson_rows: list[LessonRow] = []
    concept_stats: dict[tuple[str, str], dict] = {}
    for lesson in LESSONS:
        checks = [s for s in lesson.sections if isinstance(s, ConceptCheckSection) and s.question is not None]
        started: set[str] = set()
        completed: set[str] = set()
        latest: dict[tuple[str, str], str] = {}  # (learner, check) -> latest outcome
        incorrect_ever: dict[tuple[str, str], set[str]] = defaultdict(set)  # (concept) -> learners
        attempted: dict[str, set[str]] = defaultdict(set)  # concept -> learners
        for learner, rows in by_learner.items():
            for e in rows:
                if e.kind in ("lesson_started", "lesson_completed") and e.subject_id == lesson.id:
                    started.add(learner)
                    if e.kind == "lesson_completed":
                        completed.add(learner)
                elif e.kind in _CHECK_KINDS and e.subject_id.startswith(lesson.id + "/"):
                    check_id = e.subject_id.split("/", 1)[1]
                    started.add(learner)
                    latest[(learner, check_id)] = e.outcome or "incorrect"
                    concept = str(e.detail.get("concept") or lesson.id)
                    attempted[concept].add(learner)
                    if e.outcome == "incorrect":
                        incorrect_ever[(lesson.id, concept)].add(learner)
        check_rows: list[CheckRow] = []
        answered_total = correct_total = 0
        for section in checks:
            learners_answered = {lr for (lr, cid) in latest if cid == section.id}
            correct_here = {lr for lr in learners_answered if latest[(lr, section.id)] == "correct"}
            check_rows.append(CheckRow(check_id=section.id, concept=section.concept or lesson.id, answered=len(learners_answered), correct=len(correct_here)))
            answered_total += len(learners_answered)
            correct_total += len(correct_here)
        lesson_rows.append(
            LessonRow(
                lesson_id=lesson.id,
                title=lesson.title,
                started=len(started),
                completed=len(completed),
                developing=len(started - completed),
                assessment_answered=answered_total,
                assessment_correct=correct_total,
                checks=check_rows,
            )
        )
        for (lid, concept), learners in incorrect_ever.items():
            still = {lr for lr in learners if any(latest.get((lr, s.id)) == "incorrect" for s in checks if (s.concept or lesson.id) == concept)}
            concept_stats[(lid, concept)] = {"affected": len(learners), "still": len(still), "sample": len(attempted[concept])}

    # ---- challenges
    challenge_rows: list[ChallengeRow] = []
    failing_learners: dict[tuple[str, str], set[str]] = defaultdict(set)
    attempters: dict[str, set[str]] = defaultdict(set)
    for challenge in CHALLENGES:
        started: set[str] = set()
        solved: set[str] = set()
        tried: set[str] = set()
        attempts = failed = 0
        patterns: Counter[str] = Counter()
        pattern_learners: dict[str, set[str]] = defaultdict(set)
        for learner, rows in by_learner.items():
            for e in rows:
                if e.subject_id != challenge.id:
                    continue
                if e.kind == "challenge_started":
                    started.add(learner)
                elif e.kind == "challenge_solved":
                    started.add(learner)
                    tried.add(learner)
                    solved.add(learner)
                    attempts += 1
                elif e.kind == "challenge_failed":
                    started.add(learner)
                    tried.add(learner)
                    attempts += 1
                    failed += 1
                    for check_id in e.detail.get("failed_checks", []) if isinstance(e.detail.get("failed_checks"), list) else []:
                        if isinstance(check_id, str):
                            patterns[check_id] += 1
                            pattern_learners[check_id].add(learner)
                            failing_learners[(challenge.id, check_id)].add(learner)
        attempters[challenge.id] = tried
        challenge_rows.append(
            ChallengeRow(
                challenge_id=challenge.id,
                title=challenge.title,
                lesson_id=challenge.lesson_id,
                started=len(started),
                attempting_learners=len(tried),
                attempts=attempts,
                solved_learners=len(solved),
                failed_attempts=failed,
                failure_patterns=[
                    FailurePattern(check_id=cid, label=_check_label(challenge, cid), count=n, learners=len(pattern_learners[cid]))
                    for cid, n in patterns.most_common(6)
                ],
            )
        )

    # ---- misconceptions: concept-check mistakes and the authored idea behind a failed challenge check
    misconceptions: list[MisconceptionRow] = []
    for (lesson_id, concept), stats in concept_stats.items():
        misconceptions.append(
            MisconceptionRow(
                kind="concept",
                category=concept,
                lesson_id=lesson_id,
                challenge_id=None,
                learners_affected=stats["affected"],
                still_incorrect=stats["still"],
                sample_size=stats["sample"],
                explanation=None,
            )
        )
    for (challenge_id, check_id), learners in failing_learners.items():
        challenge = challenge_by_id[challenge_id]
        authored = next((c.misconception for c in challenge.checks if c.id == check_id), None)
        if authored is None:  # a structure rule has no authored misconception: it is reported under the challenge's failure patterns only
            continue
        misconceptions.append(
            MisconceptionRow(
                kind="challenge_check",
                category=_check_label(challenge, check_id),
                lesson_id=challenge.lesson_id,
                challenge_id=challenge_id,
                learners_affected=len(learners),
                still_incorrect=None,
                sample_size=len(attempters[challenge_id]),
                explanation=authored,
            )
        )
    misconceptions.sort(key=lambda m: (-m.learners_affected, m.category))

    # ---- recent activity (newest first), as aliases
    def label(subject: str) -> str:
        head = subject.split("/", 1)[0]
        if head in lesson_by_id:
            return lesson_by_id[head].title + (f" ({subject.split('/', 1)[1]})" if "/" in subject else "")
        if subject in challenge_by_id:
            return challenge_by_id[subject].title
        return "Class"

    recent = [
        RecentRow(alias=alias_for(e.learner_id), kind=e.kind, subject_id=e.subject_id, subject_label=label(e.subject_id), outcome=e.outcome, created_at=e.created_at)
        for e in reversed(events[-MAX_RECENT:])
    ]

    return ClassDashboard(
        class_info=ClassInfo(class_code=format_code(cls.class_code), title=cls.title, created_at=cls.created_at),
        sample=SampleInfo(
            learners_in_class=in_class,
            learners_left=left,
            active_learners=len(active),
            active_window_days=ACTIVE_WINDOW_DAYS,
            events_total=len(events),
        ),
        empty=in_class == 0,
        data_note=DATA_NOTE,
        lessons=lesson_rows,
        challenges=challenge_rows,
        misconceptions=misconceptions[:MAX_MISCONCEPTIONS],
        recent=recent,
    )
