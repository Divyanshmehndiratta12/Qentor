"""Typed lesson/domain model for the Learn engine (docs/PRODUCT_CONTRACT.md).

This module owns shape only — no lesson content lives here (see
``qentor.lessons.content``) and no API/route wiring lives here (see
``qentor.api.app``). Per CLAUDE.md's invariant, a lesson can *reference* an
existing backend capability for its interactive lab, but the model itself
never computes, stores or approximates a quantum result: ``InteractiveLabSection``
only names which already-existing endpoint (``qentor.api.app``) a learner's
client would call, against ``Lesson.linked_circuit`` — nothing here executes
or simulates anything.

Every model uses ``extra="forbid"``, matching every other schema in this
codebase (``qentor.circuit.model.Circuit``, ``qentor.api.schemas``), so a typo
or an invented field is a hard validation error, not a silently ignored one.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from qentor.circuit.model import Circuit

Difficulty = Literal["beginner", "intermediate", "advanced"]

# The set of already-existing, already-tested backend endpoints an
# interactive lab may point a learner at (qentor.api.app). Adding a new value
# here must correspond to a real endpoint that already exists — this model
# never invents a new execution or verification capability of its own.
LabCapability = Literal["execute", "verify_bell_state", "multi_input_test", "optimize", "variational_sweep"]


class ExplanationSection(BaseModel):
    """Static, concise explanatory text. No quantum number of any kind is
    ever embedded here — a number a learner needs to see comes from a real
    execution via ``InteractiveLabSection``, never from prose."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["explanation"] = "explanation"
    id: str
    title: str
    body: str


class ConceptCheckOption(BaseModel):
    """One selectable answer choice. ``id`` (not array index) is what a
    client submits back and what ``correct_option_id`` references, so
    reordering ``options`` can never silently change which choice is
    correct."""

    model_config = ConfigDict(extra="forbid")

    id: str
    text: str


class ConceptCheckSection(BaseModel):
    """A comprehension-check. ``prompt`` alone (question/options/etc. all
    omitted) is still valid — a plain, unscored check, as every concept_check
    was before this milestone. When a real question is present, all of
    ``question``/``options``/``correct_option_id``/``explanation`` must be
    present together (enforced below): there is no partially-specified quiz.

    This is the SERVER-SIDE model: it holds the answer key. It is never
    serialised to a client. ``GET /api/lessons`` serves ``PublicLesson``
    (below), in which a concept check carries the question and the options and
    neither ``correct_option_id`` nor ``explanation``; a client sends its
    selection to the grading endpoint and gets back correctness plus the
    explanation (``qentor.lessons.grading``).
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["concept_check"] = "concept_check"
    id: str
    title: str
    prompt: str
    question: str | None = None
    options: list[ConceptCheckOption] | None = None
    correct_option_id: str | None = None
    explanation: str | None = None
    concept: str | None = None

    @model_validator(mode="after")
    def _question_fields_are_all_or_nothing(self) -> "ConceptCheckSection":
        fields = (self.question, self.options, self.correct_option_id, self.explanation)
        present = [f is not None for f in fields]
        if any(present) and not all(present):
            raise ValueError(
                f"concept_check '{self.id}': question/options/correct_option_id/explanation "
                "must all be present together, or all omitted"
            )
        return self

    @model_validator(mode="after")
    def _options_are_well_formed(self) -> "ConceptCheckSection":
        if self.options is None:
            return self
        if len(self.options) < 2:
            raise ValueError(f"concept_check '{self.id}': needs at least 2 options")
        option_ids = [o.id for o in self.options]
        if len(option_ids) != len(set(option_ids)):
            raise ValueError(f"concept_check '{self.id}': option ids must be unique, got {option_ids}")
        if self.correct_option_id not in option_ids:
            raise ValueError(
                f"concept_check '{self.id}': correct_option_id {self.correct_option_id!r} "
                f"is not one of the option ids {option_ids}"
            )
        return self


class PublicConceptCheckSection(BaseModel):
    """A concept check as a client may see it: the question and the choices, NEVER the answer key or the explanation.

    The explanation is withheld as well as the key because an explanation almost always gives the answer away; a client
    receives it from the grading endpoint, after it has submitted a selection. ``question`` and ``options`` are both
    ``None`` for a prompt-only check (nothing to grade) and both present otherwise.
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["concept_check"] = "concept_check"
    id: str
    title: str
    prompt: str
    question: str | None = None
    options: list[ConceptCheckOption] | None = None
    concept: str | None = None


class InteractiveLabSection(BaseModel):
    """Points at ``Lesson.linked_circuit`` and names which existing backend
    endpoint operates on it. This section never carries its own circuit,
    result, probability or verdict — the frontend lab (not built in this
    milestone) is expected to submit ``linked_circuit`` to the named
    capability's real endpoint and render whatever it returns, exactly like
    every other screen in this app."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["interactive_lab"] = "interactive_lab"
    id: str
    title: str
    instructions: str
    capability: LabCapability


class ReflectionSection(BaseModel):
    """An open-ended prompt with no stored response in this milestone —
    progress/state persistence is explicitly out of scope here."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["reflection"] = "reflection"
    id: str
    title: str
    prompt: str


LessonSection = Annotated[
    Union[ExplanationSection, ConceptCheckSection, InteractiveLabSection, ReflectionSection],
    Field(discriminator="type"),
]


class Lesson(BaseModel):
    """One entry in the lesson catalog.

    ``linked_circuit`` is the single canonical circuit for this lesson's lab,
    reused by every ``InteractiveLabSection`` in ``sections`` rather than each
    section carrying its own copy — one definition per lesson, no drift. It is
    ``None`` for a lesson with no lab yet (enforced by ``_lab_requires_linked_circuit``
    below: a lesson cannot claim an interactive lab section without one).
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    short_description: str
    concept: str
    difficulty: Difficulty
    estimated_minutes: int = Field(gt=0)
    learning_objectives: list[str] = Field(min_length=1)
    sections: list[LessonSection] = Field(min_length=1)
    linked_circuit: Circuit | None = None
    prerequisite_lesson_ids: list[str] = Field(default_factory=list)
    # Why this lesson has no challenge, when none names it (``qentor.challenges``). The content validator
    # (``qentor.content.validation``) requires every lesson to have a challenge OR to say why not here, and flags a reason
    # that contradicts an existing challenge. Server-side only: ``PublicLesson`` does not carry it.
    no_challenge_reason: str | None = None

    @model_validator(mode="after")
    def _section_ids_are_unique(self) -> "Lesson":
        ids = [s.id for s in self.sections]
        if len(ids) != len(set(ids)):
            raise ValueError(f"lesson '{self.id}': section ids must be unique, got {ids}")
        return self

    @model_validator(mode="after")
    def _lab_requires_linked_circuit(self) -> "Lesson":
        has_lab = any(isinstance(s, InteractiveLabSection) for s in self.sections)
        if has_lab and self.linked_circuit is None:
            raise ValueError(
                f"lesson '{self.id}': has an interactive_lab section but no linked_circuit"
            )
        return self

    @model_validator(mode="after")
    def _no_self_prerequisite(self) -> "Lesson":
        if self.id in self.prerequisite_lesson_ids:
            raise ValueError(f"lesson '{self.id}': cannot list itself as its own prerequisite")
        return self


PublicLessonSection = Annotated[
    Union[ExplanationSection, PublicConceptCheckSection, InteractiveLabSection, ReflectionSection],
    Field(discriminator="type"),
]


class PublicLesson(BaseModel):
    """A lesson as ``GET /api/lessons`` serves it: every field of ``Lesson``, with each concept check reduced to
    ``PublicConceptCheckSection``. It cannot hold an answer key or an explanation, so no code path that builds one can leak
    them (``extra="forbid"`` makes adding either a validation error, not a silent pass-through)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    short_description: str
    concept: str
    difficulty: Difficulty
    estimated_minutes: int = Field(gt=0)
    learning_objectives: list[str] = Field(min_length=1)
    sections: list[PublicLessonSection] = Field(min_length=1)
    linked_circuit: Circuit | None = None
    prerequisite_lesson_ids: list[str] = Field(default_factory=list)


def public_lesson(lesson: Lesson) -> PublicLesson:
    """The client-facing view of ``lesson``: same order, same ids, concept checks without the key or the explanation."""
    sections: list[object] = []
    for section in lesson.sections:
        if isinstance(section, ConceptCheckSection):
            sections.append(
                PublicConceptCheckSection(
                    id=section.id,
                    title=section.title,
                    prompt=section.prompt,
                    question=section.question,
                    options=section.options,
                    concept=section.concept,
                )
            )
        else:
            sections.append(section)
    return PublicLesson(
        id=lesson.id,
        title=lesson.title,
        short_description=lesson.short_description,
        concept=lesson.concept,
        difficulty=lesson.difficulty,
        estimated_minutes=lesson.estimated_minutes,
        learning_objectives=list(lesson.learning_objectives),
        sections=sections,  # type: ignore[arg-type]
        linked_circuit=lesson.linked_circuit,
        prerequisite_lesson_ids=list(lesson.prerequisite_lesson_ids),
    )
