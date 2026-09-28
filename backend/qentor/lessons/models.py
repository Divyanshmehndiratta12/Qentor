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
LabCapability = Literal["execute", "verify_bell_state", "multi_input_test", "optimize"]


class ExplanationSection(BaseModel):
    """Static, concise explanatory text. No quantum number of any kind is
    ever embedded here — a number a learner needs to see comes from a real
    execution via ``InteractiveLabSection``, never from prose."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["explanation"] = "explanation"
    id: str
    title: str
    body: str


class ConceptCheckSection(BaseModel):
    """A comprehension-check prompt. This milestone has no answer/scoring
    model at all — see docs/48_HOUR_PLAN.md's cut line — so this section is
    deliberately just a prompt, not a quiz question with a grading contract."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["concept_check"] = "concept_check"
    id: str
    title: str
    prompt: str


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
