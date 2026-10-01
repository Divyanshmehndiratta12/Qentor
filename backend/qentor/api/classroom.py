"""The anonymous classroom API: create a class, join it, report learning events, and (for the instructor) read the aggregate dashboard.

Authorization is by two server-issued bearer capabilities, never by a field the client sends about itself:

* the **instructor key** (``X-Qentor-Instructor``) is issued once when a class is created, bound to that class, and the only way to read its
  dashboard or delete it. Knowing the class code is not enough; a learner token is not enough; no request body can say "I am the instructor".
* the **learner token** (``X-Qentor-Learner``) is issued when a learner joins and says only WHO the (anonymous) learner is. Every request
  schema forbids extra fields, so there is nowhere to name another learner, claim a role, or report a metric: events are derived by the server
  (``qentor.classroom.service``).

Rate limits slow code guessing, class creation and event floods per client address (in-memory, per process: see docs/ARCHITECTURE.md for what
that does and does not give). Nothing here is a full authentication system; it is a capability model sufficient for a classroom demo, with its
limits written down.
"""

from __future__ import annotations

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from qentor.classroom import ClassDashboard, ClassroomError, ClassroomService, RateLimiter, alias_for, build_dashboard, format_code, normalise_code
from qentor.classroom.codes import clean_title, is_instructor_key, is_learner_token
from qentor.classroom.service import MAX_SYNC_ANSWERS

log = logging.getLogger("qentor.classroom")

router = APIRouter(prefix="/api")

LEARNER_HEADER = "X-Qentor-Learner"
INSTRUCTOR_HEADER = "X-Qentor-Instructor"
LearnerToken = Annotated[str | None, Header(alias=LEARNER_HEADER)]
InstructorKey = Annotated[str | None, Header(alias=INSTRUCTOR_HEADER)]

RATE_LIMITED = "RATE_LIMITED"
CLASS_NOT_FOUND = "CLASS_NOT_FOUND"
CODE_INVALID = "CLASS_CODE_INVALID"
LEARNER_TOKEN_INVALID = "LEARNER_TOKEN_INVALID"
LEARNER_TOKEN_REQUIRED = "LEARNER_TOKEN_REQUIRED"
INSTRUCTOR_KEY_REQUIRED = "INSTRUCTOR_KEY_REQUIRED"
NOT_AUTHORIZED = "NOT_AUTHORIZED"

LIMITERS: dict[str, RateLimiter] = {
    "create_class": RateLimiter(10, 3600),
    "join": RateLimiter(30, 600),
    "events": RateLimiter(120, 60),
    "sync": RateLimiter(10, 600),
    "dashboard": RateLimiter(120, 60),
    "instructor_failures": RateLimiter(20, 600),
    "experiments": RateLimiter(30, 3600),
    "parse_code": RateLimiter(120, 60),
}


def reset_rate_limits() -> None:
    for limiter in LIMITERS.values():
        limiter.reset()


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateClassRequest(_Body):
    title: str | None = Field(default=None, max_length=200)


class CreateClassResponse(_Body):
    class_code: str
    instructor_key: str
    title: str
    created_at: str
    notice: str


class JoinRequest(_Body):
    class_code: str = Field(min_length=1, max_length=64)


class JoinResponse(_Body):
    learner_token: str
    alias: str
    class_code: str
    class_title: str
    rejoined: bool
    new_identity: bool


class MeResponse(_Body):
    in_class: bool
    token_known: bool
    class_code: str | None = None
    class_title: str | None = None
    alias: str | None = None
    joined_at: str | None = None


class LeaveResponse(_Body):
    left: bool


class SyncAnswer(_Body):
    lesson_id: str = Field(min_length=1, max_length=200)
    check_id: str = Field(min_length=1, max_length=200)
    selected_option_id: str = Field(min_length=1, max_length=200)


class SyncRequest(_Body):
    answers: list[SyncAnswer] = Field(max_length=MAX_SYNC_ANSWERS)


class SyncResponse(_Body):
    recorded: int
    duplicates: int
    unknown: int


class EventRequest(_Body):
    # ``kind`` is a plain string, not an enum: an unknown or forbidden kind is a structured 422 from the service, never a framework error that
    # echoes the value, and the allow-list lives in one place (qentor.classroom.service.CLIENT_CLAIMABLE).
    kind: str = Field(min_length=1, max_length=40)
    subject_id: str = Field(min_length=1, max_length=120)


class EventResponse(_Body):
    status: Literal["RECORDED", "DUPLICATE"]


class DeleteResponse(_Body):
    deleted: bool
    events_deleted: int


# ------------------------------------------------------------------------------------------------------------------------- helpers


def _app():  # imported lazily: ``qentor.api.app`` includes this router, so a module-level import would be circular
    from qentor.api import app as app_module

    return app_module


def _service() -> ClassroomService:
    return ClassroomService(_app()._classroom)


def _error(status: int, code: str, message: str, **extra) -> HTTPException:  # noqa: ANN003
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def enforce_limit(name: str, key: str) -> None:
    limiter = LIMITERS[name]
    if not limiter.allow(f"{name}:{key}"):
        raise _error(429, RATE_LIMITED, "Too many requests. Wait a moment and try again.", retry_after_seconds=limiter.retry_after(f"{name}:{key}"))


def _require_learner_token(token: str | None) -> str:
    if token is None or token == "":
        raise _error(401, LEARNER_TOKEN_REQUIRED, "this request needs a learner token")
    if not is_learner_token(token):
        raise _error(401, LEARNER_TOKEN_INVALID, "that learner token is not valid")
    return token


def _authorize_instructor(request: Request, code: str, key: str | None):
    ip = client_key(request)
    if key is None or not is_instructor_key(key):
        raise _error(401, INSTRUCTOR_KEY_REQUIRED, "this request needs the instructor key issued when the class was created")
    normal = normalise_code(code)
    cls = _app()._classroom.authorize_instructor(normal, key) if normal else None
    if cls is None:
        # one answer for "no such class" and "wrong key", and failures are rate-limited so a key cannot be searched for
        enforce_limit("instructor_failures", ip)
        raise _error(403, NOT_AUTHORIZED, "that instructor key does not open this class")
    return cls


# ----------------------------------------------------------------------------------------------------------------------- endpoints


@router.post("/classes", response_model=CreateClassResponse, status_code=201)
def create_class(request: CreateClassRequest, http: Request) -> CreateClassResponse:
    """Create a class. Returns the class code (share it with learners) and the instructor key (shown ONCE: keep it; it is the only way back in)."""
    enforce_limit("create_class", client_key(http))
    record, key = _app()._classroom.create_class(clean_title(request.title))
    return CreateClassResponse(
        class_code=format_code(record.class_code),
        instructor_key=key,
        title=record.title,
        created_at=record.created_at,
        notice="Keep the instructor key: it is shown once and is not stored in a form that can be shown again. Learners need only the class code.",
    )


@router.post("/classes/join", response_model=JoinResponse)
def join_class(request: JoinRequest, http: Request, x_qentor_learner: LearnerToken = None) -> JoinResponse:
    """Join a class by its code. A learner token presented in the header (the browser's own) is reused, so leaving and rejoining keeps the same
    anonymous learner; otherwise a new anonymous learner token is issued."""
    enforce_limit("join", client_key(http))
    if x_qentor_learner not in (None, "") and not is_learner_token(x_qentor_learner):
        raise _error(401, LEARNER_TOKEN_INVALID, "that learner token is not valid")
    code = normalise_code(request.class_code)
    if code is None:
        raise _error(422, CODE_INVALID, "A class code is eight letters and digits, like ABCD-2345.")
    outcome = _app()._classroom.join(code, x_qentor_learner or None)
    if outcome is None:
        raise _error(404, CLASS_NOT_FOUND, "No class has that code. Check it with your instructor.")
    return JoinResponse(
        learner_token=outcome.learner_token,
        alias=outcome.alias,
        class_code=format_code(outcome.cls.class_code),
        class_title=outcome.cls.title,
        rejoined=outcome.rejoined,
        new_identity=outcome.new_identity,
    )


@router.get("/classes/me", response_model=MeResponse)
def my_class(x_qentor_learner: LearnerToken = None) -> MeResponse:
    """Where this browser's learner token stands: in a class (which), or not. Used on load so the shell shows the truth, not a remembered guess."""
    token = _require_learner_token(x_qentor_learner)
    store = _app()._classroom
    member = store.membership_for_token(token)
    if member is None:
        return MeResponse(in_class=False, token_known=store.knows_token(token))
    return MeResponse(
        in_class=True,
        token_known=True,
        class_code=format_code(member.cls.class_code),
        class_title=member.cls.title,
        alias=alias_for(member.learner_id),
        joined_at=member.joined_at,
    )


@router.post("/classes/leave", response_model=LeaveResponse)
def leave_class(x_qentor_learner: LearnerToken = None) -> LeaveResponse:
    """Leave the class. This browser's own learning data is not touched; the instructor stops seeing this learner."""
    token = _require_learner_token(x_qentor_learner)
    store = _app()._classroom
    member = store.membership_for_token(token)
    return LeaveResponse(left=bool(member and store.leave(member.learner_id)))


@router.post("/classes/sync-progress", response_model=SyncResponse)
def sync_progress(request: SyncRequest, http: Request, x_qentor_learner: LearnerToken = None) -> SyncResponse:
    """Count what a learner already studied: the server GRADES each saved selection itself and records it. A selection cannot claim to be right."""
    token = _require_learner_token(x_qentor_learner)
    enforce_limit("sync", client_key(http))
    try:
        outcome = _service().sync_progress(token, [(a.lesson_id, a.check_id, a.selected_option_id) for a in request.answers])
    except ClassroomError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail()) from exc
    return SyncResponse(recorded=outcome.recorded, duplicates=outcome.duplicates, unknown=outcome.unknown)


@router.post("/learner-events", response_model=EventResponse)
def report_event(request: EventRequest, http: Request, x_qentor_learner: LearnerToken = None) -> EventResponse:
    """Report that the learner started a lesson, finished one, or started a challenge. The only metric-free events a browser may claim: the id is
    checked against the server's catalogs, a lesson is accepted as completed only when the server's own record shows every concept check answered
    correctly, and a replay is a no-op. Everything else (answers, verdicts, shares) is recorded by the server itself."""
    token = _require_learner_token(x_qentor_learner)
    enforce_limit("events", token[:12] + client_key(http))
    try:
        status = _service().claim(token, request.kind, request.subject_id)
    except ClassroomError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail()) from exc
    return EventResponse(status=status)  # type: ignore[arg-type]


@router.get("/classes/{class_code}/dashboard", response_model=ClassDashboard)
def class_dashboard(class_code: str, http: Request, x_qentor_instructor: InstructorKey = None) -> ClassDashboard:
    """The instructor's aggregate view (instructor key required)."""
    cls = _authorize_instructor(http, class_code, x_qentor_instructor)
    enforce_limit("dashboard", client_key(http))
    app_module = _app()
    return build_dashboard(app_module._classroom, cls, app_module._classroom._now())


@router.delete("/classes/{class_code}", response_model=DeleteResponse)
def delete_class(class_code: str, http: Request, x_qentor_instructor: InstructorKey = None) -> DeleteResponse:
    """Delete a class and every event recorded in it (instructor key required)."""
    cls = _authorize_instructor(http, class_code, x_qentor_instructor)
    n = _app()._classroom.delete_class(cls.class_id)
    return DeleteResponse(deleted=True, events_deleted=n)


# ------------------------------------------------------------------------------------------------- hooks used by other endpoints
# Each is best-effort: a classroom problem must never turn a grading or a verdict into an error, and a missing, malformed or unknown token
# simply produces no event (the learner is in no class as far as the server knows).


def hook_concept_check(token: str | None, lesson_id: str, check_id: str, selected_option_id: str, correct: bool) -> None:
    try:
        _service().concept_check(token if is_learner_token(token) else None, lesson_id, check_id, selected_option_id, correct)
    except Exception:  # noqa: BLE001
        log.exception("classroom: concept check event failed")


def hook_challenge_attempt(token: str | None, challenge_id: str, passed: bool, failed_check_ids: list[str]) -> None:
    try:
        _service().challenge_attempt(token if is_learner_token(token) else None, challenge_id, passed, failed_check_ids)
    except Exception:  # noqa: BLE001
        log.exception("classroom: challenge event failed")


def hook_experiment_shared(token: str | None, experiment_id: str) -> None:
    try:
        _service().experiment_shared(token if is_learner_token(token) else None, experiment_id)
    except Exception:  # noqa: BLE001
        log.exception("classroom: share event failed")
