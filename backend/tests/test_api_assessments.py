"""Server-graded concept checks: the answer key never leaves the server, and every verdict comes from it.

Requests go through the real FastAPI/Starlette stack with a minimal ASGI driver (httpx/TestClient is not a project
dependency), so malformed bodies, status codes and the JSON on the wire are what a browser would see. The reference answers
are read from the authored lesson content; nothing is graded by this test file's own logic beyond comparing with that key.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from qentor.api import app as app_module
from qentor.api.schemas import ConceptCheckGradeRequest, RegradeRequest
from qentor.lessons import (
    LESSONS,
    ConceptCheckOption,
    ConceptCheckSection,
    ExplanationSection,
    Lesson,
    PublicConceptCheckSection,
    PublicLesson,
    get_lesson,
    public_lesson,
)
from qentor.lessons.registry import LESSON_BY_ID
from qentor.lessons.grading import (
    CONCEPT_CHECK_NOT_FOUND,
    CONCEPT_CHECK_NOT_GRADED,
    GRADER,
    LESSON_NOT_FOUND,
    OPTION_NOT_FOUND,
    GradeError,
    RegradeItem,
    grade_concept_check,
    regrade,
)
from qentor.tutor import resolve_lesson_context  # noqa: F401  (import check: the tutor still resolves lessons)


def http(method: str, path: str, body: bytes | None = None, content_type: str = "application/json") -> tuple[int, bytes]:
    """Drive the ASGI app once, as uvicorn would, with an optional request body."""

    async def run() -> tuple[int, bytes]:
        sent: list[dict] = []
        pending = [{"type": "http.request", "body": body or b"", "more_body": False}]

        async def receive() -> dict:
            return pending.pop(0) if pending else {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            sent.append(message)

        headers = [(b"host", b"testserver")]
        if body is not None:
            headers += [(b"content-type", content_type.encode()), (b"content-length", str(len(body)).encode())]
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": headers,
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 1234),
            "root_path": "",
        }
        await app_module.app(scope, receive, send)
        start = next(m for m in sent if m["type"] == "http.response.start")
        return start["status"], b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")

    return asyncio.run(run())


def post_json(path: str, payload) -> tuple[int, dict]:
    status, body = http("POST", path, json.dumps(payload).encode())
    return status, json.loads(body)


def grade_path(lesson_id: str, check_id: str) -> str:
    return f"/api/lessons/{lesson_id}/concept-checks/{check_id}/grade"


def graded_checks():
    """Every (lesson, check) that has a real question, straight from the authored content."""
    return [(lesson, s) for lesson in LESSONS for s in lesson.sections if isinstance(s, ConceptCheckSection) and s.question is not None]


def synthetic_lesson() -> Lesson:
    """A lesson that exists only in this test module, for the shapes the authored content does not contain: a prompt-only
    concept check, and two checks whose option ids differ. It is patched into the grading registry (never into ``LESSONS``,
    so the real catalog and ``GET /api/lessons`` are untouched)."""
    return Lesson(
        id="synthetic-lesson",
        title="Synthetic",
        short_description="test only",
        concept="test",
        difficulty="beginner",
        estimated_minutes=1,
        learning_objectives=["test"],
        sections=[
            ExplanationSection(id="e1", title="t", body="b"),
            ConceptCheckSection(id="prompt-only", title="t", prompt="Think about it."),
            ConceptCheckSection(
                id="check-one",
                title="t",
                prompt="p",
                question="Pick one",
                options=[ConceptCheckOption(id="x", text="X"), ConceptCheckOption(id="y", text="Y")],
                correct_option_id="y",
                explanation="SYNTHETIC-EXPLANATION-ONE",
            ),
            ConceptCheckSection(
                id="check-two",
                title="t",
                prompt="p",
                question="Pick another",
                options=[ConceptCheckOption(id="p", text="P"), ConceptCheckOption(id="q", text="Q")],
                correct_option_id="p",
                explanation="SYNTHETIC-EXPLANATION-TWO",
            ),
        ],
    )


def with_synthetic_lesson():
    return patch.dict(LESSON_BY_ID, {"synthetic-lesson": synthetic_lesson()})


class TestTheCatalogCarriesNoAnswerKey(unittest.TestCase):
    def setUp(self) -> None:
        status, body = http("GET", "/api/lessons")
        self.assertEqual(status, 200)
        self.text = body.decode("utf-8")
        self.catalog = json.loads(self.text)

    def test_there_are_graded_checks_to_protect(self) -> None:
        self.assertEqual(len(graded_checks()), 36)  # 14 foundation + 6 advanced + 6 batch 1 + 6 algorithms + 2 variational + 2 Shor: a guard against a vacuous pass

    def test_no_key_anywhere_in_the_response_body(self) -> None:
        self.assertNotIn("correct_option_id", self.text)
        self.assertNotIn("correctOptionId", self.text)
        # the FIELD (as a key, in any section); "explanation" as a section type is fine and is how explanation sections are named
        self.assertNotRegex(self.text, r'"explanation"\s*:')
        for lesson in self.catalog["lessons"]:
            for section in lesson["sections"]:
                self.assertNotIn("explanation", {k for k in section if k != "type"}, (lesson["id"], section["id"]))

    def test_no_authored_explanation_text_anywhere_in_the_response_body(self) -> None:
        for lesson, section in graded_checks():
            self.assertNotIn(section.explanation, self.text, (lesson.id, section.id))

    def test_a_concept_check_still_has_what_a_learner_needs_to_answer_it(self) -> None:
        served = {lesson["id"]: lesson for lesson in self.catalog["lessons"]}
        for lesson, section in graded_checks():
            shown = next(s for s in served[lesson.id]["sections"] if s["id"] == section.id)
            self.assertEqual(shown["type"], "concept_check")
            self.assertEqual(shown["question"], section.question)
            self.assertEqual([o["id"] for o in shown["options"]], [o.id for o in section.options])
            self.assertEqual([o["text"] for o in shown["options"]], [o.text for o in section.options])
            self.assertEqual(set(shown), {"type", "id", "title", "prompt", "question", "options", "concept"})

    def test_a_prompt_only_check_is_served_as_a_prompt(self) -> None:
        lesson = synthetic_lesson()
        shown = next(s for s in public_lesson(lesson).model_dump()["sections"] if s["id"] == "prompt-only")
        self.assertEqual((shown["question"], shown["options"]), (None, None))
        self.assertEqual(shown["prompt"], "Think about it.")

    def test_a_synthetic_check_loses_its_key_and_explanation_when_made_public(self) -> None:
        dumped = json.dumps(public_lesson(synthetic_lesson()).model_dump())
        self.assertNotIn("SYNTHETIC-EXPLANATION", dumped)
        self.assertNotIn("correct_option_id", dumped)

    def test_the_public_model_cannot_hold_the_key_or_the_explanation(self) -> None:
        self.assertFalse({"correct_option_id", "explanation"} & set(PublicConceptCheckSection.model_fields))
        with self.assertRaises(Exception):
            PublicConceptCheckSection(id="x", title="t", prompt="p", correct_option_id="a")  # type: ignore[call-arg]
        with self.assertRaises(Exception):
            PublicConceptCheckSection(id="x", title="t", prompt="p", explanation="because")  # type: ignore[call-arg]

    def test_the_rest_of_each_lesson_is_unchanged(self) -> None:
        served = {lesson["id"]: lesson for lesson in self.catalog["lessons"]}
        for lesson in LESSONS:
            shown = served[lesson.id]
            self.assertEqual([s["id"] for s in shown["sections"]], [s.id for s in lesson.sections])
            self.assertEqual(shown["prerequisite_lesson_ids"], lesson.prerequisite_lesson_ids)
            self.assertEqual(shown["linked_circuit"], None if lesson.linked_circuit is None else lesson.linked_circuit.model_dump(mode="json", by_alias=True))
            self.assertEqual(shown["learning_objectives"], lesson.learning_objectives)

    def test_public_lesson_is_built_only_from_the_authored_lesson(self) -> None:
        for lesson in LESSONS:
            self.assertIsInstance(public_lesson(lesson), PublicLesson)
            self.assertEqual(public_lesson(lesson), public_lesson(lesson))  # deterministic


class TestGradingOneSelection(unittest.TestCase):
    def test_the_right_answer_is_correct_and_returns_the_explanation(self) -> None:
        for lesson, section in graded_checks():
            with self.subTest(lesson=lesson.id, check=section.id):
                status, body = post_json(grade_path(lesson.id, section.id), {"selected_option_id": section.correct_option_id})
                self.assertEqual(status, 200)
                self.assertEqual(
                    body,
                    {
                        "lesson_id": lesson.id,
                        "check_id": section.id,
                        "selected_option_id": section.correct_option_id,
                        "correct": True,
                        "explanation": section.explanation,
                        "grader": GRADER,
                    },
                )

    def test_every_wrong_answer_is_incorrect_and_returns_the_explanation(self) -> None:
        count = 0
        for lesson, section in graded_checks():
            for option in section.options:
                if option.id == section.correct_option_id:
                    continue
                count += 1
                status, body = post_json(grade_path(lesson.id, section.id), {"selected_option_id": option.id})
                self.assertEqual(status, 200, (lesson.id, section.id, option.id))
                self.assertIs(body["correct"], False, (lesson.id, section.id, option.id))
                self.assertEqual(body["explanation"], section.explanation)
        self.assertGreater(count, 40)

    def test_exactly_one_option_per_check_is_correct(self) -> None:
        for lesson, section in graded_checks():
            verdicts = [grade_concept_check(lesson.id, section.id, o.id).correct for o in section.options]
            self.assertEqual(verdicts.count(True), 1, (lesson.id, section.id))

    def test_a_response_never_names_the_key(self) -> None:
        for lesson, section in graded_checks():
            wrong = next(o.id for o in section.options if o.id != section.correct_option_id)
            for chosen in (wrong, section.correct_option_id):
                _, body = post_json(grade_path(lesson.id, section.id), {"selected_option_id": chosen})
                self.assertEqual(set(body), {"lesson_id", "check_id", "selected_option_id", "correct", "explanation", "grader"})
                self.assertNotIn("correct_option_id", json.dumps(body))

    def test_grading_is_deterministic_and_repeatable(self) -> None:
        lesson, section = graded_checks()[0]
        first = post_json(grade_path(lesson.id, section.id), {"selected_option_id": section.correct_option_id})
        second = post_json(grade_path(lesson.id, section.id), {"selected_option_id": section.correct_option_id})
        self.assertEqual(first, second)

    def test_the_route_function_and_the_wire_agree(self) -> None:
        lesson, section = graded_checks()[3]
        direct = app_module.grade_concept_check_endpoint(lesson.id, section.id, ConceptCheckGradeRequest(selected_option_id=section.correct_option_id))
        _, wire = post_json(grade_path(lesson.id, section.id), {"selected_option_id": section.correct_option_id})
        self.assertEqual(direct.model_dump(), wire)


class TestInvalidSelections(unittest.TestCase):
    def setUp(self) -> None:
        self.lesson, self.section = graded_checks()[0]

    def error(self, path: str, payload, status: int) -> dict:
        got, body = post_json(path, payload)
        self.assertEqual(got, status, body)
        self.assertEqual(set(body), {"detail"})
        self.assertEqual(set(body["detail"]), {"code", "message"})
        return body["detail"]

    def test_an_option_that_is_not_one_of_the_choices(self) -> None:
        detail = self.error(grade_path(self.lesson.id, self.section.id), {"selected_option_id": "zzz"}, 422)
        self.assertEqual(detail["code"], OPTION_NOT_FOUND)
        self.assertIn("zzz", detail["message"])
        self.assertNotIn(self.section.explanation, json.dumps(detail))  # a refusal gives nothing away
        for option in self.section.options:  # the message may list the choices (they are public) but never a verdict
            self.assertNotIn("correct", detail["message"].replace("concept check", ""))
            self.assertIn(option.id, detail["message"])

    def test_the_option_of_another_check_is_not_accepted(self) -> None:
        with with_synthetic_lesson():
            detail = self.error(grade_path("synthetic-lesson", "check-one"), {"selected_option_id": "p"}, 422)  # p belongs to check-two
            self.assertEqual(detail["code"], OPTION_NOT_FOUND)
            ok = post_json(grade_path("synthetic-lesson", "check-two"), {"selected_option_id": "p"})
            self.assertEqual((ok[0], ok[1]["correct"]), (200, True))

    def test_the_option_text_is_not_an_option_id(self) -> None:
        detail = self.error(grade_path(self.lesson.id, self.section.id), {"selected_option_id": self.section.options[0].text}, 422)
        self.assertEqual(detail["code"], OPTION_NOT_FOUND)

    def test_an_unknown_lesson(self) -> None:
        detail = self.error(grade_path("no-such-lesson", self.section.id), {"selected_option_id": "a"}, 404)
        self.assertEqual(detail["code"], LESSON_NOT_FOUND)

    def test_an_unknown_check(self) -> None:
        detail = self.error(grade_path(self.lesson.id, "no-such-check"), {"selected_option_id": "a"}, 404)
        self.assertEqual(detail["code"], CONCEPT_CHECK_NOT_FOUND)

    def test_a_section_that_is_not_a_concept_check(self) -> None:
        explanation = next(s for s in self.lesson.sections if s.type == "explanation")
        detail = self.error(grade_path(self.lesson.id, explanation.id), {"selected_option_id": "a"}, 404)
        self.assertEqual(detail["code"], CONCEPT_CHECK_NOT_FOUND)

    def test_a_check_of_another_lesson_is_not_found_under_this_one(self) -> None:
        with with_synthetic_lesson():
            detail = self.error(grade_path(self.lesson.id, "check-one"), {"selected_option_id": "x"}, 404)
            self.assertEqual(detail["code"], CONCEPT_CHECK_NOT_FOUND)

    def test_a_prompt_only_check_has_nothing_to_grade(self) -> None:
        with with_synthetic_lesson():
            detail = self.error(grade_path("synthetic-lesson", "prompt-only"), {"selected_option_id": "a"}, 422)
        self.assertEqual(detail["code"], CONCEPT_CHECK_NOT_GRADED)

    def test_grading_errors_carry_a_stable_code_and_status(self) -> None:
        for call, code, status in (
            (lambda: grade_concept_check("x", "y", "a"), LESSON_NOT_FOUND, 404),
            (lambda: grade_concept_check(self.lesson.id, "y", "a"), CONCEPT_CHECK_NOT_FOUND, 404),
            (lambda: grade_concept_check(self.lesson.id, self.section.id, "zzz"), OPTION_NOT_FOUND, 422),
        ):
            with self.assertRaises(GradeError) as raised:
                call()
            self.assertEqual((raised.exception.code, raised.exception.status_code), (code, status))
            self.assertEqual(set(raised.exception.detail()), {"code", "message"})


class TestMalformedRequests(unittest.TestCase):
    def setUp(self) -> None:
        self.lesson, self.section = graded_checks()[0]
        self.path = grade_path(self.lesson.id, self.section.id)

    def refused(self, body: bytes | None, content_type: str = "application/json") -> dict:
        status, raw = http("POST", self.path, body, content_type)
        self.assertEqual(status, 422, raw)
        parsed = json.loads(raw)
        self.assertEqual(set(parsed), {"detail"})
        self.assertEqual(set(parsed["detail"]), {"code", "message"})
        self.assertEqual(parsed["detail"]["code"], "GRADE_REQUEST_INVALID")
        self.assertTrue(parsed["detail"]["message"])
        return parsed["detail"]

    def test_not_json(self) -> None:
        self.refused(b"this is not json")

    def test_an_empty_body(self) -> None:
        self.refused(b"")

    def test_a_json_array_instead_of_an_object(self) -> None:
        self.refused(b'["a"]')

    def test_a_missing_field(self) -> None:
        self.assertIn("selected_option_id", self.refused(b"{}")["message"])

    def test_the_wrong_type(self) -> None:
        for payload in (b'{"selected_option_id": 7}', b'{"selected_option_id": null}', b'{"selected_option_id": ["a"]}', b'{"selected_option_id": {"id": "a"}}'):
            with self.subTest(payload=payload):
                self.refused(payload)

    def test_an_empty_or_enormous_option_id(self) -> None:
        self.refused(b'{"selected_option_id": ""}')
        self.refused(json.dumps({"selected_option_id": "a" * 201}).encode())

    def test_the_client_cannot_send_a_verdict_a_key_or_a_score(self) -> None:
        for extra in ({"correct": True}, {"correct_option_id": self.section.correct_option_id}, {"score": 1}, {"explanation": "x"}):
            with self.subTest(extra=extra):
                self.refused(json.dumps({"selected_option_id": self.section.correct_option_id, **extra}).encode())

    def test_a_refusal_never_echoes_what_was_sent(self) -> None:
        secret = "SUPER-SECRET-VALUE-123"
        status, raw = http("POST", self.path, json.dumps({"selected_option_id": 5, "note": secret}).encode())
        self.assertEqual(status, 422)
        self.assertNotIn(secret, raw.decode())

    def test_a_get_is_not_a_grading_request(self) -> None:
        status, body = http("GET", self.path)
        self.assertIn(status, (404, 405))
        self.assertNotIn(b"explanation", body)  # nothing is graded, and nothing is given away, by a GET

    def test_other_endpoints_keep_the_standard_validation_response(self) -> None:
        status, raw = http("POST", "/api/execute", b"{}")
        self.assertEqual(status, 422)
        detail = json.loads(raw)["detail"]
        self.assertIsInstance(detail, list)  # FastAPI's own list of errors, not our structured object

    def test_the_request_model_forbids_extra_fields(self) -> None:
        with self.assertRaises(Exception):
            ConceptCheckGradeRequest.model_validate({"selected_option_id": "a", "correct": True})


class TestRegradingSavedSelections(unittest.TestCase):
    def test_a_mixed_batch_is_answered_item_by_item_in_order(self) -> None:
        lesson, section = graded_checks()[0]
        wrong = next(o.id for o in section.options if o.id != section.correct_option_id)
        with with_synthetic_lesson():
            status, body = post_json(
                "/api/assessments/regrade",
                {
                    "answers": [
                        {"lesson_id": lesson.id, "check_id": section.id, "selected_option_id": section.correct_option_id},
                        {"lesson_id": lesson.id, "check_id": section.id, "selected_option_id": wrong},
                        {"lesson_id": "gone", "check_id": section.id, "selected_option_id": "a"},
                        {"lesson_id": lesson.id, "check_id": "gone", "selected_option_id": "a"},
                        {"lesson_id": lesson.id, "check_id": section.id, "selected_option_id": "gone"},
                        {"lesson_id": "synthetic-lesson", "check_id": "prompt-only", "selected_option_id": "a"},
                    ]
                },
            )
        self.assertEqual(status, 200)
        results = body["results"]
        self.assertEqual([r["status"] for r in results], ["GRADED", "GRADED", "UNKNOWN_LESSON", "UNKNOWN_CHECK", "UNKNOWN_OPTION", "NOT_GRADED"])
        self.assertEqual([r["correct"] for r in results], [True, False, None, None, None, None])
        self.assertEqual(results[0]["explanation"], section.explanation)
        self.assertEqual([r["explanation"] for r in results[2:]], [None] * 4)  # nothing is said about what cannot be graded
        self.assertEqual([r["selected_option_id"] for r in results[:2]], [section.correct_option_id, wrong])

    def test_one_stale_entry_does_not_sink_the_rest(self) -> None:
        lesson, section = graded_checks()[1]
        results = regrade(
            [
                RegradeItem(lesson_id="gone", check_id="x", selected_option_id="a"),
                RegradeItem(lesson_id=lesson.id, check_id=section.id, selected_option_id=section.correct_option_id),
            ]
        )
        self.assertEqual([r.status for r in results], ["UNKNOWN_LESSON", "GRADED"])

    def test_regrading_reproduces_the_verdict_of_grading_for_every_option_of_every_check(self) -> None:
        items = [
            RegradeItem(lesson_id=lesson.id, check_id=section.id, selected_option_id=option.id)
            for lesson, section in graded_checks()
            for option in section.options
        ]
        self.assertGreater(len(items), 60)
        for item, result in zip(items, regrade(items)):
            single = grade_concept_check(item.lesson_id, item.check_id, item.selected_option_id)
            self.assertEqual((result.status, result.correct, result.explanation), ("GRADED", single.correct, single.explanation))

    def test_an_empty_batch_is_an_empty_answer(self) -> None:
        self.assertEqual(post_json("/api/assessments/regrade", {"answers": []}), (200, {"results": []}))

    def test_a_batch_over_the_limit_is_refused(self) -> None:
        lesson, section = graded_checks()[0]
        item = {"lesson_id": lesson.id, "check_id": section.id, "selected_option_id": section.correct_option_id}
        self.assertEqual(post_json("/api/assessments/regrade", {"answers": [item] * 500})[0], 200)
        status, body = post_json("/api/assessments/regrade", {"answers": [item] * 501})
        self.assertEqual((status, body["detail"]["code"]), (422, "GRADE_REQUEST_INVALID"))

    def test_malformed_batches_are_structured_errors(self) -> None:
        for payload in (
            {},
            {"answers": "no"},
            {"answers": [{"lesson_id": "a"}]},
            {"answers": [{"lesson_id": "a", "check_id": "b", "selected_option_id": "c", "correct": True}]},
            {"answers": [], "extra": 1},
        ):
            with self.subTest(payload=payload):
                status, body = post_json("/api/assessments/regrade", payload)
                self.assertEqual((status, body["detail"]["code"]), (422, "GRADE_REQUEST_INVALID"))
        status, raw = http("POST", "/api/assessments/regrade", b"not json")
        self.assertEqual((status, json.loads(raw)["detail"]["code"]), (422, "GRADE_REQUEST_INVALID"))

    def test_the_request_model_bounds_each_id(self) -> None:
        with self.assertRaises(Exception):
            RegradeRequest.model_validate({"answers": [{"lesson_id": "", "check_id": "b", "selected_option_id": "c"}]})
        with self.assertRaises(Exception):
            RegradeRequest.model_validate({"answers": [{"lesson_id": "a" * 201, "check_id": "b", "selected_option_id": "c"}]})

    def test_regrading_reveals_nothing_a_single_grade_would_not(self) -> None:
        lesson, section = graded_checks()[0]
        items = [{"lesson_id": lesson.id, "check_id": section.id, "selected_option_id": o.id} for o in section.options]
        _, body = post_json("/api/assessments/regrade", {"answers": items})
        self.assertNotIn("correct_option_id", json.dumps(body))
        for result in body["results"]:
            self.assertEqual(set(result), {"lesson_id", "check_id", "selected_option_id", "status", "correct", "explanation"})


class TestTheKeyDoesNotLeakThroughAnotherEndpoint(unittest.TestCase):
    """The tutor reads lesson data server-side. A hint or an explanation request on a quiz must not hand over the key or the
    explanation the grading endpoint keeps back."""

    def test_the_tutor_never_returns_a_checks_explanation_or_key_field(self) -> None:
        from qentor.api.schemas import TutorRequest

        questions = ("Give me a hint", "Explain this concept", "Give me a simpler explanation", "Which option is correct?", "What is the answer?")
        for lesson, section in graded_checks():
            for question in questions:
                response = app_module.tutor_endpoint(TutorRequest(lesson_id=lesson.id, section_id=section.id, question=question))
                text = response.model_dump_json()
                self.assertNotIn(section.explanation, text, (lesson.id, section.id, question))
                self.assertNotIn("correct_option_id", text)

    def test_the_tutor_does_not_announce_which_option_is_right(self) -> None:
        from qentor.api.schemas import TutorRequest

        for lesson, section in graded_checks():
            correct_text = next(o.text for o in section.options if o.id == section.correct_option_id)
            response = app_module.tutor_endpoint(TutorRequest(lesson_id=lesson.id, section_id=section.id, question="Which option is correct?"))
            text = response.model_dump_json().lower()
            # the options may be quoted as material, but never singled out as "the correct option"
            self.assertNotRegex(text, r"(the )?(correct|right) (option|answer) is", (lesson.id, section.id))
            self.assertNotIn(f"correct answer: {correct_text.lower()}", text)

    def test_the_other_endpoints_that_carry_lesson_text_do_not_carry_a_key(self) -> None:
        for path in ("/api/lessons", "/api/challenges"):
            status, body = http("GET", path)
            self.assertEqual(status, 200)
            self.assertNotIn("correct_option_id", body.decode())

    def test_no_route_serialises_the_internal_lesson_model(self) -> None:
        """A structural guard: no response model in the API reuses ``Lesson`` or ``ConceptCheckSection`` (the internal,
        key-bearing types), so a new endpoint cannot hand them out by reusing a declared model."""
        from typing import get_args, get_origin

        from pydantic import BaseModel

        from qentor.api import schemas
        from qentor.lessons import Lesson

        def mentions(annotation, target) -> bool:
            if annotation is target:
                return True
            return any(mentions(arg, target) for arg in get_args(annotation)) or (
                get_origin(annotation) is None
                and isinstance(annotation, type)
                and issubclass(annotation, BaseModel)
                and annotation is not target
                and any(mentions(f.annotation, target) for f in annotation.model_fields.values())
            )

        for name in dir(schemas):
            model = getattr(schemas, name)
            if isinstance(model, type) and issubclass(model, BaseModel) and model.__module__ == schemas.__name__:
                for target in (Lesson, ConceptCheckSection):
                    self.assertFalse(mentions(model, target), f"{name} exposes {target.__name__}")


class TestTheGradingLayerStaysInItsLane(unittest.TestCase):
    def test_grading_imports_no_web_framework_execution_or_tutor_code(self) -> None:
        import ast
        from pathlib import Path

        source = (Path(__file__).resolve().parents[1] / "qentor" / "lessons" / "grading.py").read_text(encoding="utf-8")
        imported = {
            node.module or ""
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.ImportFrom)
        } | {alias.name for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Import) for alias in node.names}
        for module in imported:
            self.assertFalse(module.startswith(("fastapi", "starlette", "qentor.execution", "qentor.verification", "qentor.tutor", "qentor.api")), module)

    def test_the_lesson_model_is_not_changed_by_serving_it(self) -> None:
        before = [lesson.model_dump() for lesson in LESSONS]
        app_module.list_lessons()
        self.assertEqual([lesson.model_dump() for lesson in LESSONS], before)
        check = next(s for s in get_lesson(graded_checks()[0][0].id).sections if isinstance(s, ConceptCheckSection) and s.question)
        self.assertIsNotNone(check.correct_option_id)  # the key is still on the server's own model


if __name__ == "__main__":
    unittest.main()
