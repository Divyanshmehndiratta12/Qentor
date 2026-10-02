"""The anonymous classroom layer, end to end through the real FastAPI stack: classes, anonymous learners, server-derived learning events, the
instructor dashboard, and the authorization boundary between them.

Principles under test: no personal data anywhere; a capability (instructor key, learner token) is issued by the server and is the only thing that
authorizes; nothing a client sends can name a role, another learner, or a metric; a replayed event is a no-op; an empty class shows an empty
dashboard (no invented learners or numbers); and what the instructor sees is exactly what the server recorded.
"""

from __future__ import annotations

import ast
import json
import sqlite3
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from qentor.api import app as app_module
from qentor.api import classroom as classroom_api
from qentor.api.schemas import ChallengeSubmitRequest
from qentor.challenges.content import circ, g
from qentor.classroom import ClassroomStore, alias_for, format_code, normalise_code
from qentor.classroom.codes import (
    CODE_ALPHABET,
    clean_title,
    hash_secret,
    is_instructor_key,
    is_learner_token,
    new_class_code,
    new_instructor_key,
    new_learner_token,
)
from qentor.classroom.ratelimit import RateLimiter
from qentor.classroom.store import MAX_EVENTS_PER_LEARNER, DUPLICATE, LIMIT, RECORDED
from qentor.lessons import ConceptCheckSection, get_lesson
from qentor.provenance.attempts import AttemptStore
from qentor.provenance.store import ProvenanceStore
from tests.asgi_driver import http

BACKEND = Path(__file__).resolve().parents[1]
QFT = "quantum-fourier-transform"


class Clock:
    def __init__(self) -> None:
        self.t = datetime(2026, 10, 1, 12, 0, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.t

    def advance(self, **kwargs) -> None:  # noqa: ANN003
        self.t += timedelta(**kwargs)


def checks_of(lesson_id: str):
    return [s for s in get_lesson(lesson_id).sections if isinstance(s, ConceptCheckSection) and s.question is not None]


def wrong_option(section) -> str:
    return next(o.id for o in section.options if o.id != section.correct_option_id)


class ClassroomCase(unittest.TestCase):
    """A temporary database, a controllable clock, and a tiny client over the real app."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "qentor.db"
        self.clock = Clock()
        self.store = ClassroomStore(self.db, now=self.clock)
        self.provenance = ProvenanceStore(self.db)
        self.attempts = AttemptStore(self.db)
        self._patches = [
            patch.object(app_module, "_classroom", self.store),
            patch.object(app_module, "_store", self.provenance),
            patch.object(app_module, "_attempts", self.attempts),
        ]
        for p in self._patches:
            p.start()
        classroom_api.reset_rate_limits()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self.store.close()
        self.provenance.close()
        self.attempts.close()
        self._tmp.cleanup()
        classroom_api.reset_rate_limits()

    # ---- a client over the real stack
    def call(self, method: str, path: str, body: dict | None = None, *, learner: str | None = None, instructor: str | None = None, ip: str = "10.0.0.1"):
        headers = {}
        if learner is not None:
            headers["X-Qentor-Learner"] = learner
        if instructor is not None:
            headers["X-Qentor-Instructor"] = instructor
        status, raw = http(method, path, None if body is None else json.dumps(body).encode(), headers=headers, client=(ip, 5555))
        return status, (json.loads(raw) if raw else None)

    def make_class(self, title: str | None = None):
        status, body = self.call("POST", "/api/classes", {"title": title} if title is not None else {})
        self.assertEqual(status, 201, body)
        return body["class_code"], body["instructor_key"]

    def join(self, code: str, token: str | None = None, ip: str = "10.0.0.2"):
        status, body = self.call("POST", "/api/classes/join", {"class_code": code}, learner=token, ip=ip)
        self.assertEqual(status, 200, body)
        return body["learner_token"], body

    def dashboard(self, code: str, key: str):
        status, body = self.call("GET", f"/api/classes/{code}/dashboard", instructor=key)
        self.assertEqual(status, 200, body)
        return body

    def grade(self, token: str | None, lesson_id: str, check_id: str, option_id: str):
        status, body = self.call("POST", f"/api/lessons/{lesson_id}/concept-checks/{check_id}/grade", {"selected_option_id": option_id}, learner=token)
        self.assertEqual(status, 200, body)
        return body

    def answer_all_correctly(self, token: str, lesson_id: str = QFT) -> None:
        for section in checks_of(lesson_id):
            self.assertTrue(self.grade(token, lesson_id, section.id, section.correct_option_id)["correct"])

    def submit(self, token: str | None, challenge_id: str, circuit):
        # Called as a function (not through the threadpool the ASGI driver uses): Qiskit's Rust extension can crash when a request first lands on a
        # fresh worker thread (docs/BUILD_STATE.md), which is why the other challenge tests do the same. The header is passed exactly as FastAPI would.
        response = app_module.submit_challenge(challenge_id, ChallengeSubmitRequest(circuit=circuit), x_qentor_learner=token)
        return response.model_dump(mode="json")


SOLVE_ONE = circ(1, [g("x", 0)])
FAIL_ONE = circ(1, [g("h", 0)])


# --------------------------------------------------------------------------- #
# Codes, tokens and aliases                                                    #
# --------------------------------------------------------------------------- #


class TestCodes(unittest.TestCase):
    def test_a_class_code_is_eight_unambiguous_characters_and_codes_do_not_repeat(self) -> None:
        codes = {new_class_code() for _ in range(500)}
        self.assertEqual(len(codes), 500)
        for code in codes:
            self.assertEqual(len(code), 8)
            self.assertTrue(set(code) <= set(CODE_ALPHABET))
        for lookalike in "0O1IL":
            self.assertNotIn(lookalike, CODE_ALPHABET)

    def test_a_typed_code_is_normalised_and_anything_that_cannot_be_a_code_is_refused(self) -> None:
        self.assertEqual(normalise_code("abcd-2345"), "ABCD2345")
        self.assertEqual(normalise_code("  ab cd 23 45 "), "ABCD2345")
        self.assertEqual(format_code("ABCD2345"), "ABCD-2345")
        for bad in ("", "ABC", "ABCD-23456", "ABCD-234O", "ABCD-2341", "ABCD_2345", "ÄBCD-2345", "x" * 40, "ABCD-2345\n; DROP TABLE classes"):
            self.assertIsNone(normalise_code(bad), repr(bad))
        self.assertIsNone(normalise_code(None))  # type: ignore[arg-type]
        self.assertIsNone(normalise_code(12345678))  # type: ignore[arg-type]

    def test_tokens_are_random_prefixed_validated_and_never_stored_in_the_clear(self) -> None:
        keys = {new_instructor_key() for _ in range(100)}
        tokens = {new_learner_token() for _ in range(100)}
        self.assertEqual((len(keys), len(tokens)), (100, 100))
        for k in keys:
            self.assertTrue(is_instructor_key(k) and not is_learner_token(k))
        for t in tokens:
            self.assertTrue(is_learner_token(t) and not is_instructor_key(t))
        for bad in ("", "ql_", "ql_short", "ql_" + "a" * 33, "ql_" + "a" * 31 + "!", "qx_" + "a" * 32, None, 7, "ql_" + "a" * 32 + "\n"):
            self.assertFalse(is_learner_token(bad), repr(bad))
        self.assertEqual(len(hash_secret("x")), 64)
        self.assertNotEqual(hash_secret("abc"), "abc")

    def test_an_alias_is_stable_short_and_does_not_contain_the_id(self) -> None:
        a = alias_for("ln_0123456789abcdef")
        self.assertEqual(a, alias_for("ln_0123456789abcdef"))
        self.assertRegex(a, r"^Learner [0-9A-F]{4}$")
        self.assertNotIn("0123456789abcdef", a)
        self.assertNotEqual(a, alias_for("ln_fedcba9876543210"))

    def test_a_title_is_cleaned_capped_and_optional(self) -> None:
        self.assertEqual(clean_title(None), "")
        self.assertEqual(clean_title("  Period   3 \n Physics\t"), "Period 3 Physics")
        self.assertEqual(clean_title("a\x00b\x1bc"), "abc")
        self.assertEqual(len(clean_title("x" * 500)), 60)


class TestRateLimiter(unittest.TestCase):
    def test_a_sliding_window_counts_per_key_and_recovers(self) -> None:
        now = [0.0]
        limiter = RateLimiter(3, 10, clock=lambda: now[0])
        self.assertEqual([limiter.allow("a") for _ in range(4)], [True, True, True, False])
        self.assertTrue(limiter.allow("b"))  # another key is unaffected
        self.assertGreaterEqual(limiter.retry_after("a"), 1)
        now[0] = 11.0
        self.assertTrue(limiter.allow("a"))
        self.assertEqual(limiter.retry_after("b"), 0)

    def test_a_refused_hit_is_not_counted_and_reset_clears_everything(self) -> None:
        limiter = RateLimiter(1, 100, clock=lambda: 0.0)
        self.assertTrue(limiter.allow("k"))
        for _ in range(50):
            self.assertFalse(limiter.allow("k"))
        limiter.reset()
        self.assertTrue(limiter.allow("k"))

    def test_it_refuses_a_nonsense_configuration(self) -> None:
        with self.assertRaises(ValueError):
            RateLimiter(0, 10)
        with self.assertRaises(ValueError):
            RateLimiter(1, 0)


# --------------------------------------------------------------------------- #
# Creating and joining                                                         #
# --------------------------------------------------------------------------- #


class TestCreateAndJoin(ClassroomCase):
    def test_creating_a_class_returns_a_code_and_a_key_once_and_stores_only_the_hash(self) -> None:
        code, key = self.make_class("Period 3")
        self.assertRegex(code, r"^[A-Z2-9]{4}-[A-Z2-9]{4}$")
        self.assertTrue(is_instructor_key(key))
        raw = self.db.read_bytes() + b"".join(p.read_bytes() for p in self.db.parent.glob("qentor.db-*"))
        self.assertNotIn(key.encode(), raw)  # the capability is not in the database file, in any form but its hash
        conn = sqlite3.connect(self.db)
        stored = conn.execute("SELECT instructor_key_hash, title FROM classes").fetchone()
        conn.close()
        self.assertEqual(stored[0], hash_secret(key))
        self.assertEqual(stored[1], "Period 3")

    def test_the_create_request_has_no_field_for_a_role_an_owner_or_an_id(self) -> None:
        for field in ("role", "instructor", "instructor_id", "owner", "class_code", "instructor_key", "is_admin"):
            status, body = self.call("POST", "/api/classes", {"title": "x", field: "z"})
            self.assertEqual(status, 422, field)

    def test_joining_with_a_code_issues_an_anonymous_token_and_an_alias(self) -> None:
        code, _ = self.make_class("Physics")
        token, body = self.join(code)
        self.assertTrue(is_learner_token(token))
        self.assertRegex(body["alias"], r"^Learner [0-9A-F]{4}$")
        self.assertEqual((body["class_code"], body["class_title"], body["rejoined"], body["new_identity"]), (code, "Physics", False, True))
        for forbidden in ("name", "email", "learner_id", "ip", "user"):
            self.assertNotIn(forbidden, body)

    def test_a_code_is_accepted_in_any_case_and_without_the_hyphen(self) -> None:
        code, _ = self.make_class()
        _, a = self.join(code.lower())
        _, b = self.join(code.replace("-", " ").lower())
        self.assertEqual({a["class_code"], b["class_code"]}, {code})

    def test_a_bad_or_unknown_code_is_a_structured_error(self) -> None:
        status, body = self.call("POST", "/api/classes/join", {"class_code": "nope"})
        self.assertEqual((status, body["detail"]["code"]), (422, "CLASS_CODE_INVALID"))
        status, body = self.call("POST", "/api/classes/join", {"class_code": "ZZZZ-2222"})
        self.assertEqual((status, body["detail"]["code"]), (404, "CLASS_NOT_FOUND"))

    def test_leaving_and_rejoining_in_the_same_browser_keeps_the_same_anonymous_learner(self) -> None:
        code, _ = self.make_class()
        token, first = self.join(code)
        status, me = self.call("GET", "/api/classes/me", learner=token)
        self.assertEqual((status, me["in_class"], me["class_code"], me["alias"]), (200, True, code, first["alias"]))
        status, left = self.call("POST", "/api/classes/leave", learner=token)
        self.assertEqual((status, left["left"]), (200, True))
        status, me = self.call("GET", "/api/classes/me", learner=token)
        self.assertEqual((me["in_class"], me["token_known"]), (False, True))
        again, second = self.join(code, token)
        self.assertEqual((again, second["alias"], second["rejoined"], second["new_identity"]), (token, first["alias"], True, False))
        self.assertTrue(self.call("GET", "/api/classes/me", learner=token)[1]["in_class"])

    def test_leaving_when_in_no_class_is_harmless_and_says_so(self) -> None:
        code, _ = self.make_class()
        token, _ = self.join(code)
        self.call("POST", "/api/classes/leave", learner=token)
        self.assertFalse(self.call("POST", "/api/classes/leave", learner=token)[1]["left"])

    def test_a_learner_is_in_one_class_at_a_time(self) -> None:
        a, key_a = self.make_class("A")
        b, key_b = self.make_class("B")
        token, _ = self.join(a)
        self.join(b, token)
        self.assertEqual(self.call("GET", "/api/classes/me", learner=token)[1]["class_code"], b)
        self.assertEqual(self.dashboard(a, key_a)["sample"]["learners_in_class"], 0)
        self.assertEqual(self.dashboard(b, key_b)["sample"]["learners_in_class"], 1)

    def test_an_unknown_but_well_formed_token_gets_a_new_identity_and_a_malformed_one_is_refused(self) -> None:
        code, _ = self.make_class()
        stale = new_learner_token()
        token, body = self.join(code, stale)
        self.assertNotEqual(token, stale)
        self.assertTrue(body["new_identity"])
        status, err = self.call("POST", "/api/classes/join", {"class_code": code}, learner="not-a-token")
        self.assertEqual((status, err["detail"]["code"]), (401, "LEARNER_TOKEN_INVALID"))

    def test_me_leave_and_sync_need_a_token(self) -> None:
        for method, path in (("GET", "/api/classes/me"), ("POST", "/api/classes/leave")):
            status, body = self.call(method, path)
            self.assertEqual((status, body["detail"]["code"]), (401, "LEARNER_TOKEN_REQUIRED"), path)
            status, body = self.call(method, path, learner="junk")
            self.assertEqual((status, body["detail"]["code"]), (401, "LEARNER_TOKEN_INVALID"), path)

    def test_a_joined_event_is_recorded_once_per_activation(self) -> None:
        code, key = self.make_class()
        token, _ = self.join(code)
        self.join(code, token)  # already active: nothing new
        events = [e.kind for e in self.store.member_events(self.store.class_by_code(normalise_code(code)).class_id)]
        self.assertEqual(events, ["joined_class"])
        self.call("POST", "/api/classes/leave", learner=token)
        self.join(code, token)
        events = [e.kind for e in self.store.member_events(self.store.class_by_code(normalise_code(code)).class_id)]
        self.assertEqual(events, ["joined_class", "joined_class"])


# --------------------------------------------------------------------------- #
# Events: which are derived by the server, and which a client may claim        #
# --------------------------------------------------------------------------- #


class TestServerDerivedEvents(ClassroomCase):
    def setUp(self) -> None:
        super().setUp()
        self.code, self.key = self.make_class("Class")
        self.token, _ = self.join(self.code)
        self.class_id = self.store.class_by_code(normalise_code(self.code)).class_id

    def kinds(self) -> list[tuple[str, str, str | None]]:
        return [(e.kind, e.subject_id, e.outcome) for e in self.store.member_events(self.class_id) if e.kind != "joined_class"]

    def test_grading_with_a_token_records_the_server_s_own_verdict(self) -> None:
        first = checks_of(QFT)[0]
        self.assertFalse(self.grade(self.token, QFT, first.id, wrong_option(first))["correct"])
        self.assertTrue(self.grade(self.token, QFT, first.id, first.correct_option_id)["correct"])
        self.assertEqual(
            self.kinds(),
            [("concept_check_submitted", f"{QFT}/{first.id}", "incorrect"), ("concept_check_submitted", f"{QFT}/{first.id}", "correct"), ("concept_check_corrected", f"{QFT}/{first.id}", "correct")],
        )
        details = [e.detail for e in self.store.member_events(self.class_id) if e.kind == "concept_check_submitted"]
        self.assertEqual([d["concept"] for d in details], [first.concept, first.concept])

    def test_a_first_try_correct_answer_is_not_a_correction(self) -> None:
        first = checks_of(QFT)[0]
        self.grade(self.token, QFT, first.id, first.correct_option_id)
        self.assertEqual([k for k, _, _ in self.kinds()], ["concept_check_submitted"])

    def test_the_verdict_is_the_servers_even_if_the_client_would_like_otherwise(self) -> None:
        first = checks_of(QFT)[0]
        status, body = self.call("POST", f"/api/lessons/{QFT}/concept-checks/{first.id}/grade", {"selected_option_id": wrong_option(first), "correct": True}, learner=self.token)
        self.assertEqual(status, 422)  # no field for a verdict
        self.assertEqual(self.kinds(), [])

    def test_no_token_an_unknown_token_a_malformed_token_or_a_learner_in_no_class_records_nothing_and_still_grades(self) -> None:
        first = checks_of(QFT)[0]
        stranger = new_learner_token()
        self.grade(None, QFT, first.id, first.correct_option_id)
        self.grade(stranger, QFT, first.id, first.correct_option_id)
        self.grade("garbage", QFT, first.id, first.correct_option_id)  # grading itself is unaffected by a bad header
        self.call("POST", "/api/classes/leave", learner=self.token)
        self.grade(self.token, QFT, first.id, first.correct_option_id)
        self.assertEqual(self.store.member_events(self.class_id), [])

    def test_an_unknown_option_is_a_422_and_records_nothing(self) -> None:
        first = checks_of(QFT)[0]
        status, _ = self.call("POST", f"/api/lessons/{QFT}/concept-checks/{first.id}/grade", {"selected_option_id": "nope"}, learner=self.token)
        self.assertEqual(status, 422)
        self.assertEqual(self.kinds(), [])

    def test_a_challenge_verdict_is_recorded_with_the_failed_check_ids(self) -> None:
        self.assertFalse(self.submit(self.token, "create-one", FAIL_ONE)["passed"])
        self.assertTrue(self.submit(self.token, "create-one", SOLVE_ONE)["passed"])
        events = [e for e in self.store.member_events(self.class_id) if e.kind.startswith("challenge_")]
        self.assertEqual([(e.kind, e.subject_id) for e in events], [("challenge_failed", "create-one"), ("challenge_solved", "create-one")])
        self.assertEqual(events[0].detail, {"failed_checks": ["state.is_one"]})
        self.assertEqual(events[1].detail, {})

    def test_a_challenge_submitted_without_a_token_records_nothing(self) -> None:
        self.submit(None, "create-one", SOLVE_ONE)
        self.submit(new_learner_token(), "create-one", SOLVE_ONE)
        self.assertEqual(self.kinds(), [])

    def test_a_client_cannot_attach_a_verdict_or_a_learner_to_a_submission(self) -> None:
        body = {"circuit": SOLVE_ONE.model_dump(by_alias=True, mode="json"), "passed": True, "learner_id": "x"}
        status, _ = self.call("POST", "/api/challenges/create-one/submit", body, learner=self.token)
        self.assertEqual(status, 422)

    def test_sharing_an_experiment_is_recorded_for_a_learner_in_a_class(self) -> None:
        self.store.add_event(self.class_id, self.store.membership_for_token(self.token).learner_id, "experiment_shared", "ex_demo")
        self.assertEqual(self.kinds(), [("experiment_shared", "ex_demo", None)])


class TestClientClaimedEvents(ClassroomCase):
    def setUp(self) -> None:
        super().setUp()
        self.code, self.key = self.make_class()
        self.token, _ = self.join(self.code)
        self.class_id = self.store.class_by_code(normalise_code(self.code)).class_id

    def claim(self, kind: str, subject: str, token: str | None = "default"):
        return self.call("POST", "/api/learner-events", {"kind": kind, "subject_id": subject}, learner=self.token if token == "default" else token)

    def test_started_events_are_recorded_once_and_a_replay_is_a_noop(self) -> None:
        self.assertEqual(self.claim("lesson_started", QFT)[1], {"status": "RECORDED"})
        self.assertEqual(self.claim("lesson_started", QFT)[1], {"status": "DUPLICATE"})
        self.assertEqual(self.claim("challenge_started", "qft-2qubit")[1], {"status": "RECORDED"})
        self.assertEqual(self.claim("challenge_started", "qft-2qubit")[1], {"status": "DUPLICATE"})
        kinds = [e.kind for e in self.store.member_events(self.class_id) if e.kind != "joined_class"]
        self.assertEqual(kinds, ["lesson_started", "challenge_started"])

    def test_a_started_event_for_each_subject_is_separate(self) -> None:
        self.assertEqual(self.claim("lesson_started", "phase")[1]["status"], "RECORDED")
        self.assertEqual(self.claim("lesson_started", QFT)[1]["status"], "RECORDED")

    def test_an_unknown_lesson_or_challenge_is_a_404_not_an_event(self) -> None:
        for kind, subject in (("lesson_started", "no-such-lesson"), ("lesson_completed", "x"), ("challenge_started", "no-such-challenge")):
            status, body = self.claim(kind, subject)
            self.assertEqual((status, body["detail"]["code"]), (404, "UNKNOWN_SUBJECT"), kind)
        self.assertEqual([e.kind for e in self.store.member_events(self.class_id)], ["joined_class"])

    def test_a_browser_cannot_claim_an_event_the_server_derives(self) -> None:
        for kind in ("concept_check_submitted", "concept_check_corrected", "concept_check_synced", "challenge_solved", "challenge_failed", "experiment_shared", "joined_class", "made_up"):
            status, body = self.claim(kind, "create-one")
            self.assertEqual((status, body["detail"]["code"]), (422, "EVENT_NOT_ALLOWED"), kind)

    def test_a_completion_is_refused_until_the_server_has_every_check_answered_correctly(self) -> None:
        status, body = self.claim("lesson_completed", QFT)
        self.assertEqual((status, body["detail"]["code"]), (409, "LESSON_NOT_COMPLETE_ON_SERVER"))
        sections = checks_of(QFT)
        self.grade(self.token, QFT, sections[0].id, sections[0].correct_option_id)
        self.assertEqual(self.claim("lesson_completed", QFT)[0], 409)  # one of two
        self.grade(self.token, QFT, sections[1].id, wrong_option(sections[1]))
        self.assertEqual(self.claim("lesson_completed", QFT)[0], 409)  # a wrong answer does not count
        self.grade(self.token, QFT, sections[1].id, sections[1].correct_option_id)
        self.assertEqual(self.claim("lesson_completed", QFT)[1], {"status": "RECORDED"})
        self.assertEqual(self.claim("lesson_completed", QFT)[1], {"status": "DUPLICATE"})

    def test_a_completion_cannot_borrow_another_learners_answers(self) -> None:
        other, _ = self.join(self.code, ip="10.0.0.9")
        self.answer_all_correctly(other)
        self.assertEqual(self.claim("lesson_completed", QFT)[0], 409)  # this token's own record is empty
        self.assertEqual(self.claim("lesson_completed", QFT, other)[1], {"status": "RECORDED"})

    def test_a_token_in_no_class_or_unknown_or_malformed_or_missing_is_refused(self) -> None:
        status, body = self.claim("lesson_started", QFT, None)
        self.assertEqual((status, body["detail"]["code"]), (401, "LEARNER_TOKEN_REQUIRED"))
        status, body = self.claim("lesson_started", QFT, "junk")
        self.assertEqual((status, body["detail"]["code"]), (401, "LEARNER_TOKEN_INVALID"))
        status, body = self.claim("lesson_started", QFT, new_learner_token())
        self.assertEqual((status, body["detail"]["code"]), (403, "NOT_IN_A_CLASS"))
        self.call("POST", "/api/classes/leave", learner=self.token)
        self.assertEqual(self.claim("lesson_started", QFT)[0], 403)

    def test_the_event_request_has_no_field_for_a_learner_a_class_an_outcome_or_detail(self) -> None:
        for extra in ({"learner_id": "ln_x"}, {"class_code": self.code}, {"outcome": "correct"}, {"detail": {"x": 1}}, {"role": "instructor"}, {"count": 99}):
            status, _ = self.call("POST", "/api/learner-events", {"kind": "lesson_started", "subject_id": QFT, **extra}, learner=self.token)
            self.assertEqual(status, 422, extra)
        self.assertEqual(self.call("POST", "/api/learner-events", {"kind": "lesson_started"}, learner=self.token)[0], 422)
        self.assertEqual(self.call("POST", "/api/learner-events", {"kind": 5, "subject_id": QFT}, learner=self.token)[0], 422)
        self.assertEqual(self.call("POST", "/api/learner-events", {"kind": "lesson_started", "subject_id": "x" * 500}, learner=self.token)[0], 422)

    def test_one_token_cannot_write_into_another_learners_record(self) -> None:
        a = self.token
        b, _ = self.join(self.code, ip="10.0.0.9")
        self.claim("lesson_started", QFT, a)
        self.claim("challenge_started", "create-one", b)
        by_learner = {}
        for e in self.store.member_events(self.class_id):
            by_learner.setdefault(e.learner_id, []).append(e.kind)
        self.assertEqual(sorted(len(v) for v in by_learner.values()), [2, 2])  # each: joined + their own claim
        self.assertEqual(sorted(k for v in by_learner.values() for k in v if k != "joined_class"), ["challenge_started", "lesson_started"])

    def test_a_learner_at_the_event_cap_gets_a_limit_not_a_crash(self) -> None:
        learner = self.store.membership_for_token(self.token).learner_id
        with patch("qentor.classroom.store.MAX_EVENTS_PER_LEARNER", 3):
            results = [self.store.add_event(self.class_id, learner, "challenge_failed", "create-one", "incorrect", {"failed_checks": ["a"]}) for _ in range(4)]
        self.assertEqual(results[-1], LIMIT)
        self.assertEqual(results[:2], [RECORDED, RECORDED])  # the join event already counted once

    def test_the_store_refuses_an_unknown_kind_a_bad_outcome_and_oversized_detail(self) -> None:
        learner = self.store.membership_for_token(self.token).learner_id
        for kwargs in ({"kind": "click"}, {"kind": "challenge_failed", "outcome": "maybe"}, {"kind": "challenge_failed", "subject_id": ""}, {"kind": "challenge_failed", "detail": {"x": "y" * 2000}}):
            args = {"kind": "challenge_failed", "subject_id": "create-one", **kwargs}
            with self.assertRaises(ValueError):
                self.store.add_event(self.class_id, learner, args.pop("kind"), args.pop("subject_id"), **args)


class TestSyncProgress(ClassroomCase):
    def setUp(self) -> None:
        super().setUp()
        self.code, self.key = self.make_class()
        self.token, _ = self.join(self.code)

    def sync(self, answers, token="default"):
        return self.call("POST", "/api/classes/sync-progress", {"answers": answers}, learner=self.token if token == "default" else token)

    def test_saved_selections_are_graded_by_the_server_and_recorded(self) -> None:
        sections = checks_of(QFT)
        answers = [{"lesson_id": QFT, "check_id": sections[0].id, "selected_option_id": sections[0].correct_option_id}, {"lesson_id": QFT, "check_id": sections[1].id, "selected_option_id": wrong_option(sections[1])}]
        status, body = self.sync(answers)
        self.assertEqual((status, body), (200, {"recorded": 2, "duplicates": 0, "unknown": 0}))
        outcomes = {e.subject_id: e.outcome for e in self.store.member_events(self.store.class_by_code(normalise_code(self.code)).class_id) if e.kind == "concept_check_synced"}
        self.assertEqual(outcomes, {f"{QFT}/{sections[0].id}": "correct", f"{QFT}/{sections[1].id}": "incorrect"})

    def test_a_replayed_sync_is_idempotent(self) -> None:
        s = checks_of(QFT)[0]
        answers = [{"lesson_id": QFT, "check_id": s.id, "selected_option_id": s.correct_option_id}]
        self.sync(answers)
        self.assertEqual(self.sync(answers)[1], {"recorded": 0, "duplicates": 1, "unknown": 0})

    def test_unknown_lessons_checks_and_options_are_counted_not_recorded(self) -> None:
        s = checks_of(QFT)[0]
        status, body = self.sync([
            {"lesson_id": "nope", "check_id": "s5", "selected_option_id": "a"},
            {"lesson_id": QFT, "check_id": "s4", "selected_option_id": "a"},
            {"lesson_id": QFT, "check_id": s.id, "selected_option_id": "zzz"},
        ])
        self.assertEqual((status, body), (200, {"recorded": 0, "duplicates": 0, "unknown": 3}))

    def test_a_synced_selection_cannot_claim_to_be_correct(self) -> None:
        s = checks_of(QFT)[0]
        status, _ = self.call("POST", "/api/classes/sync-progress", {"answers": [{"lesson_id": QFT, "check_id": s.id, "selected_option_id": wrong_option(s), "correct": True}]}, learner=self.token)
        self.assertEqual(status, 422)

    def test_synced_answers_let_a_lesson_completed_before_joining_count(self) -> None:
        sections = checks_of(QFT)
        self.sync([{"lesson_id": QFT, "check_id": s.id, "selected_option_id": s.correct_option_id} for s in sections])
        self.assertEqual(self.call("POST", "/api/learner-events", {"kind": "lesson_completed", "subject_id": QFT}, learner=self.token)[1], {"status": "RECORDED"})

    def test_sync_needs_a_token_in_a_class_and_is_bounded(self) -> None:
        self.assertEqual(self.sync([], None)[0], 401)
        self.assertEqual(self.sync([], new_learner_token())[0], 403)
        many = [{"lesson_id": QFT, "check_id": "s5", "selected_option_id": "a"}] * 201
        self.assertEqual(self.sync(many)[0], 422)


# --------------------------------------------------------------------------- #
# The instructor boundary                                                      #
# --------------------------------------------------------------------------- #


class TestInstructorAuthorization(ClassroomCase):
    def setUp(self) -> None:
        super().setUp()
        self.code, self.key = self.make_class("Mine")
        self.other_code, self.other_key = self.make_class("Theirs")
        self.token, _ = self.join(self.code)

    def test_the_dashboard_needs_the_instructor_key(self) -> None:
        status, body = self.call("GET", f"/api/classes/{self.code}/dashboard")
        self.assertEqual((status, body["detail"]["code"]), (401, "INSTRUCTOR_KEY_REQUIRED"))
        status, body = self.call("GET", f"/api/classes/{self.code}/dashboard", instructor=self.key)
        self.assertEqual(status, 200)

    def test_the_class_code_alone_a_learner_token_and_another_classes_key_all_fail(self) -> None:
        for attempt in (
            {"instructor": self.other_key},  # a real key, for another class
            {"instructor": new_instructor_key()},  # well-formed, never issued
            {"instructor": self.token},  # a learner token in the instructor header
            {"instructor": "role=instructor"},
            {"instructor": self.key[:-1] + ("A" if self.key[-1] != "A" else "B")},  # one character off
            {"instructor": self.key.lower() if self.key != self.key.lower() else self.key.upper()},
            {"instructor": " " + self.key},
        ):
            status, body = self.call("GET", f"/api/classes/{self.code}/dashboard", **attempt)
            self.assertIn(status, (401, 403), attempt)
            self.assertIn(body["detail"]["code"], ("INSTRUCTOR_KEY_REQUIRED", "NOT_AUTHORIZED"))

    def test_a_learner_token_header_does_not_open_the_dashboard_and_a_learner_can_not_read_it(self) -> None:
        status, _ = self.call("GET", f"/api/classes/{self.code}/dashboard", learner=self.token)
        self.assertEqual(status, 401)

    def test_an_unknown_class_and_a_wrong_key_give_the_same_answer(self) -> None:
        a = self.call("GET", f"/api/classes/{self.code}/dashboard", instructor=new_instructor_key())
        b = self.call("GET", "/api/classes/ZZZZ-2222/dashboard", instructor=self.key)
        c = self.call("GET", "/api/classes/not-a-code/dashboard", instructor=self.key)
        self.assertEqual(a, b)
        self.assertEqual(a, c)

    def test_no_request_body_or_query_can_make_a_caller_an_instructor(self) -> None:
        status, _ = self.call("POST", "/api/classes/join", {"class_code": self.code, "role": "instructor"})
        self.assertEqual(status, 422)
        status, _ = self.call("POST", "/api/learner-events", {"kind": "lesson_started", "subject_id": QFT, "role": "instructor"}, learner=self.token)
        self.assertEqual(status, 422)

    def test_failed_instructor_attempts_are_rate_limited_so_a_key_cannot_be_searched_for(self) -> None:
        statuses = [self.call("GET", f"/api/classes/{self.code}/dashboard", instructor=new_instructor_key(), ip="10.1.1.1")[0] for _ in range(25)]
        self.assertEqual(statuses[:20], [403] * 20)
        self.assertEqual(set(statuses[20:]), {429})
        self.assertEqual(self.call("GET", f"/api/classes/{self.code}/dashboard", instructor=self.key, ip="10.9.9.9")[0], 200)  # another client is unaffected

    def test_deleting_a_class_needs_the_key_and_removes_everything(self) -> None:
        self.call("POST", "/api/learner-events", {"kind": "lesson_started", "subject_id": QFT}, learner=self.token)
        self.assertEqual(self.call("DELETE", f"/api/classes/{self.code}", instructor=self.other_key)[0], 403)
        self.assertEqual(self.call("DELETE", f"/api/classes/{self.code}")[0], 401)
        status, body = self.call("DELETE", f"/api/classes/{self.code}", instructor=self.key)
        self.assertEqual((status, body["deleted"]), (200, True))
        self.assertEqual(body["events_deleted"], 2)  # joined + started
        self.assertEqual(self.call("GET", f"/api/classes/{self.code}/dashboard", instructor=self.key)[0], 403)
        self.assertEqual(self.call("POST", "/api/classes/join", {"class_code": self.code})[0], 404)
        conn = sqlite3.connect(self.db)
        counts = [conn.execute(f"SELECT COUNT(*) FROM {t} WHERE class_id = ?", (cid,)).fetchone()[0] for t, cid in (("learner_events", "x"),)]
        conn.close()
        self.assertEqual(self.call("GET", "/api/classes/me", learner=self.token)[1]["in_class"], False)
        self.assertEqual(counts, [0])
        self.assertEqual(self.call("GET", f"/api/classes/{self.other_code}/dashboard", instructor=self.other_key)[0], 200)  # the other class is untouched


class TestRateLimitsOnTheEndpoints(ClassroomCase):
    def test_creating_classes_is_limited_per_client(self) -> None:
        statuses = [self.call("POST", "/api/classes", {}, ip="10.2.2.2")[0] for _ in range(12)]
        self.assertEqual(statuses[:10], [201] * 10)
        self.assertEqual(statuses[10:], [429, 429])
        self.assertEqual(self.call("POST", "/api/classes", {}, ip="10.2.2.3")[0], 201)

    def test_guessing_class_codes_is_limited_per_client(self) -> None:
        statuses = [self.call("POST", "/api/classes/join", {"class_code": "ZZZZ-2222"}, ip="10.3.3.3")[0] for _ in range(32)]
        self.assertEqual(statuses[:30], [404] * 30)
        self.assertEqual(statuses[30:], [429, 429])
        status, body = self.call("POST", "/api/classes/join", {"class_code": "ZZZZ-2222"}, ip="10.3.3.3")
        self.assertEqual(body["detail"]["code"], "RATE_LIMITED")
        self.assertGreaterEqual(body["detail"]["retry_after_seconds"], 1)

    def test_an_event_flood_from_one_learner_is_limited(self) -> None:
        code, _ = self.make_class()
        token, _ = self.join(code)
        statuses = [self.call("POST", "/api/learner-events", {"kind": "lesson_started", "subject_id": QFT}, learner=token)[0] for _ in range(125)]
        self.assertEqual(statuses[0], 200)
        self.assertEqual(statuses[-1], 429)


# --------------------------------------------------------------------------- #
# The instructor dashboard                                                     #
# --------------------------------------------------------------------------- #


class TestDashboard(ClassroomCase):
    def test_an_empty_class_has_an_honest_empty_dashboard(self) -> None:
        code, key = self.make_class("Empty")
        d = self.dashboard(code, key)
        self.assertTrue(d["empty"])
        self.assertEqual(d["sample"], {"learners_in_class": 0, "learners_left": 0, "active_learners": 0, "active_window_days": 7, "events_total": 0})
        self.assertEqual((d["misconceptions"], d["recent"]), ([], []))
        for lesson in d["lessons"]:
            self.assertEqual((lesson["started"], lesson["completed"], lesson["developing"], lesson["assessment_answered"], lesson["assessment_correct"]), (0, 0, 0, 0, 0))
        for challenge in d["challenges"]:
            self.assertEqual((challenge["started"], challenge["attempts"], challenge["solved_learners"], challenge["failure_patterns"]), (0, 0, 0, []))
        self.assertEqual(len(d["lessons"]), 17)
        self.assertEqual(len(d["challenges"]), 19)
        self.assertIn("Anonymous classroom data", d["data_note"])
        self.assertEqual(d["class_info"], {"class_code": code, "title": "Empty", "created_at": d["class_info"]["created_at"]})

    def test_a_class_with_a_learner_who_did_nothing_is_not_empty_and_shows_no_activity(self) -> None:
        code, key = self.make_class()
        self.join(code)
        d = self.dashboard(code, key)
        self.assertFalse(d["empty"])
        self.assertEqual(d["sample"]["learners_in_class"], 1)
        self.assertEqual([r["kind"] for r in d["recent"]], ["joined_class"])
        self.assertEqual(sum(row["started"] for row in d["lessons"]), 0)

    def scenario(self):
        """Three learners: A finishes the QFT lesson and solves a challenge; B gets a check wrong then right and fails a challenge twice; C gets
        a check wrong and never recovers."""
        code, key = self.make_class("Scenario")
        a, _ = self.join(code, ip="10.0.0.1")
        b, _ = self.join(code, ip="10.0.0.2")
        c, _ = self.join(code, ip="10.0.0.3")
        sections = checks_of(QFT)
        self.call("POST", "/api/learner-events", {"kind": "lesson_started", "subject_id": QFT}, learner=a)
        self.answer_all_correctly(a)
        self.call("POST", "/api/learner-events", {"kind": "lesson_completed", "subject_id": QFT}, learner=a)
        self.call("POST", "/api/learner-events", {"kind": "challenge_started", "subject_id": "create-one"}, learner=a)
        self.submit(a, "create-one", SOLVE_ONE)
        self.clock.advance(minutes=5)
        self.call("POST", "/api/learner-events", {"kind": "lesson_started", "subject_id": QFT}, learner=b)
        self.grade(b, QFT, sections[0].id, wrong_option(sections[0]))
        self.grade(b, QFT, sections[0].id, sections[0].correct_option_id)
        self.submit(b, "create-one", FAIL_ONE)
        self.submit(b, "create-one", FAIL_ONE)
        self.grade(c, QFT, sections[1].id, wrong_option(sections[1]))
        return code, key, (a, b, c), sections

    def test_the_numbers_are_exactly_the_events_that_were_recorded(self) -> None:
        code, key, tokens, sections = self.scenario()
        d = self.dashboard(code, key)
        self.assertEqual(d["sample"]["learners_in_class"], 3)
        self.assertEqual(d["sample"]["active_learners"], 3)
        qft = next(r for r in d["lessons"] if r["lesson_id"] == QFT)
        self.assertEqual((qft["started"], qft["completed"], qft["developing"]), (3, 1, 2))
        by_check = {c["check_id"]: c for c in qft["checks"]}
        # latest outcome per learner and check: s5: A correct, B correct (corrected), C never answered; s7: A correct, C incorrect
        self.assertEqual((by_check[sections[0].id]["answered"], by_check[sections[0].id]["correct"]), (2, 2))
        self.assertEqual((by_check[sections[1].id]["answered"], by_check[sections[1].id]["correct"]), (2, 1))
        self.assertEqual((qft["assessment_answered"], qft["assessment_correct"]), (4, 3))
        ch = next(r for r in d["challenges"] if r["challenge_id"] == "create-one")
        self.assertEqual((ch["started"], ch["attempting_learners"], ch["attempts"], ch["solved_learners"], ch["failed_attempts"]), (2, 2, 3, 1, 2))
        self.assertEqual(ch["failure_patterns"], [{"check_id": "state.is_one", "label": "The final state is |1⟩", "count": 2, "learners": 1}])

    def test_misconceptions_carry_their_sample_size_and_their_lesson(self) -> None:
        code, key, tokens, sections = self.scenario()
        d = self.dashboard(code, key)
        concept_rows = [m for m in d["misconceptions"] if m["kind"] == "concept"]
        by_concept = {m["category"]: m for m in concept_rows}
        s5, s7 = sections[0].concept, sections[1].concept
        self.assertEqual(s5, s7)  # both checks of a lesson share its concept
        row = by_concept[s5]
        self.assertEqual((row["lesson_id"], row["learners_affected"], row["sample_size"]), (QFT, 2, 3))  # B and C each got one wrong; A, B, C all attempted
        self.assertEqual(row["still_incorrect"], 1)  # only C is still wrong
        challenge_rows = [m for m in d["misconceptions"] if m["kind"] == "challenge_check"]
        self.assertEqual(len(challenge_rows), 1)
        self.assertEqual((challenge_rows[0]["challenge_id"], challenge_rows[0]["learners_affected"], challenge_rows[0]["sample_size"]), ("create-one", 1, 2))
        self.assertTrue(challenge_rows[0]["explanation"])

    def test_recent_activity_is_newest_first_and_uses_aliases_only(self) -> None:
        code, key, tokens, _ = self.scenario()
        d = self.dashboard(code, key)
        self.assertTrue(d["recent"])
        times = [r["created_at"] for r in d["recent"]]
        self.assertEqual(times, sorted(times, reverse=True))
        for row in d["recent"]:
            self.assertRegex(row["alias"], r"^Learner [0-9A-F]{4}$")
            self.assertTrue(row["subject_label"])
        self.assertLessEqual(len(d["recent"]), 25)

    def test_the_dashboard_never_contains_a_token_a_learner_id_a_secret_or_an_address(self) -> None:
        code, key, tokens, _ = self.scenario()
        blob = json.dumps(self.dashboard(code, key))
        for token in tokens:
            self.assertNotIn(token, blob)
            self.assertNotIn(hash_secret(token), blob)
        self.assertNotIn(key, blob)
        self.assertNotIn(hash_secret(key), blob)
        for needle in ("ql_", "qi_", "ln_", "cls_", "10.0.0.", "127.0.0.1", "ev_"):
            self.assertNotIn(needle, blob, needle)

    def test_active_learners_are_those_with_an_event_in_the_window_and_the_window_is_stated(self) -> None:
        code, key = self.make_class()
        a, _ = self.join(code, ip="10.0.0.1")
        self.clock.advance(days=10)
        b, _ = self.join(code, ip="10.0.0.2")
        d = self.dashboard(code, key)
        self.assertEqual((d["sample"]["learners_in_class"], d["sample"]["active_learners"], d["sample"]["active_window_days"]), (2, 1, 7))

    def test_a_learner_who_leaves_disappears_from_the_view_and_comes_back_on_rejoining(self) -> None:
        code, key, (a, b, c), _ = self.scenario()
        self.call("POST", "/api/classes/leave", learner=a)
        d = self.dashboard(code, key)
        self.assertEqual((d["sample"]["learners_in_class"], d["sample"]["learners_left"]), (2, 1))
        qft = next(r for r in d["lessons"] if r["lesson_id"] == QFT)
        self.assertEqual(qft["completed"], 0)  # A's completion is no longer in this class's view
        self.assertTrue(all(r["kind"] != "lesson_completed" for r in d["recent"]))
        self.join(code, a)
        d = self.dashboard(code, key)
        self.assertEqual(next(r for r in d["lessons"] if r["lesson_id"] == QFT)["completed"], 1)

    def test_another_classs_events_never_appear(self) -> None:
        code1, key1, _, _ = self.scenario()
        code2, key2 = self.make_class("Other")
        d2 = self.dashboard(code2, key2)
        self.assertTrue(d2["empty"])
        self.assertEqual(d2["sample"]["events_total"], 0)

    def test_malformed_stored_detail_is_skipped_not_trusted_and_not_fatal(self) -> None:
        code, key = self.make_class()
        token, _ = self.join(code)
        cls = self.store.class_by_code(normalise_code(code))
        learner = self.store.membership_for_token(token).learner_id
        conn = sqlite3.connect(self.db)
        conn.execute(
            "INSERT INTO learner_events (event_id, class_id, learner_id, kind, subject_id, outcome, detail_json, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("ev_bad1", cls.class_id, learner, "challenge_failed", "create-one", "incorrect", "{not json", None, self.clock().isoformat()),
        )
        conn.execute(
            "INSERT INTO learner_events (event_id, class_id, learner_id, kind, subject_id, outcome, detail_json, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("ev_bad2", cls.class_id, learner, "challenge_failed", "create-one", "incorrect", json.dumps({"failed_checks": "oops"}), None, self.clock().isoformat()),
        )
        conn.execute(
            "INSERT INTO learner_events (event_id, class_id, learner_id, kind, subject_id, outcome, detail_json, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("ev_bad3", cls.class_id, learner, "challenge_failed", "create-one", "incorrect", json.dumps({"failed_checks": [1, None, "state.is_one"]}), None, self.clock().isoformat()),
        )
        conn.commit()
        conn.close()
        d = self.dashboard(code, key)
        ch = next(r for r in d["challenges"] if r["challenge_id"] == "create-one")
        self.assertEqual(ch["failed_attempts"], 3)
        self.assertEqual([p["check_id"] for p in ch["failure_patterns"]], ["state.is_one"])

    def test_events_for_subjects_the_catalog_no_longer_has_are_ignored_in_the_tables_but_do_not_break_them(self) -> None:
        code, key = self.make_class()
        token, _ = self.join(code)
        cls = self.store.class_by_code(normalise_code(code))
        learner = self.store.membership_for_token(token).learner_id
        self.store.add_event(cls.class_id, learner, "lesson_started", "a-lesson-that-was-removed", None, {})
        d = self.dashboard(code, key)
        self.assertEqual(sum(r["started"] for r in d["lessons"]), 0)
        self.assertEqual(d["recent"][0]["subject_label"], "Class")


# --------------------------------------------------------------------------- #
# Retention and architecture                                                   #
# --------------------------------------------------------------------------- #


class TestRetention(ClassroomCase):
    def test_old_events_are_purged_and_orphans_removed_while_recent_ones_stay(self) -> None:
        code, key = self.make_class()
        token, _ = self.join(code)
        self.call("POST", "/api/learner-events", {"kind": "lesson_started", "subject_id": QFT}, learner=token)
        self.clock.advance(days=200)
        self.call("POST", "/api/learner-events", {"kind": "challenge_started", "subject_id": "create-one"}, learner=token)
        deleted = self.store.purge_events_older_than(180)
        self.assertEqual(deleted, 2)  # joined + lesson_started are 200 days old
        kinds = [e.kind for e in self.store.member_events(self.store.class_by_code(normalise_code(code)).class_id)]
        self.assertEqual(kinds, ["challenge_started"])

    def test_startup_retention_reads_its_setting_and_survives_a_bad_one(self) -> None:
        with patch.dict("os.environ", {"QENTOR_CLASSROOM_RETENTION_DAYS": "not-a-number"}):
            self.assertEqual(app_module._purge_old_classroom_events(), 0)
        with patch.dict("os.environ", {"QENTOR_CLASSROOM_RETENTION_DAYS": "-5"}):
            self.assertEqual(app_module._purge_old_classroom_events(), 0)  # clamped to at least one day

    def test_the_schema_has_no_column_for_a_name_an_email_or_an_address(self) -> None:
        conn = sqlite3.connect(self.db)
        columns = {t: [r[1] for r in conn.execute(f"PRAGMA table_info({t})")] for t in ("classes", "learners", "memberships", "learner_events")}
        conn.close()
        everything = " ".join(c for cols in columns.values() for c in cols).lower()
        for pii in ("name", "email", "mail", "phone", "address", "ip", "user", "agent", "location", "birth"):
            self.assertNotRegex(everything, rf"\b{pii}\b")
        self.assertNotIn("secret", [c for cols in columns.values() for c in cols])  # only hashes are kept


class TestArchitecture(unittest.TestCase):
    def _imports(self, path: Path) -> set[str]:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        names |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        return names

    def test_the_tutor_never_imports_the_classroom_and_the_classroom_never_imports_the_tutor_or_the_backends(self) -> None:
        for py in (BACKEND / "qentor" / "tutor").rglob("*.py"):
            self.assertFalse({m for m in self._imports(py) if m.startswith("qentor.classroom")}, str(py))
        for py in (BACKEND / "qentor" / "classroom").rglob("*.py"):
            bad = {m for m in self._imports(py) if m.startswith(("qentor.tutor", "qentor.execution", "qentor.verification", "qentor.provenance", "qentor.api"))}
            self.assertFalse(bad, f"{py}: {bad}")

    def test_execution_verification_and_challenges_never_import_the_classroom(self) -> None:
        for pkg in ("execution", "verification", "challenges", "circuit", "lessons"):
            for py in (BACKEND / "qentor" / pkg).rglob("*.py"):
                self.assertFalse({m for m in self._imports(py) if m.startswith("qentor.classroom")}, str(py))

    def test_the_classroom_computes_no_quantum_value(self) -> None:
        for py in (BACKEND / "qentor" / "classroom").rglob("*.py"):
            source = py.read_text(encoding="utf-8")
            for forbidden in ("qiskit", "numpy", "statevector", "AerAdapter", "anthropic"):
                self.assertNotIn(forbidden, source, py.name)


if __name__ == "__main__":
    unittest.main()
