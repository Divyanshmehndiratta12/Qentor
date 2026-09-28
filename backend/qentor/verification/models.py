"""Verification evidence shapes.

A verifier never returns a bare boolean. It returns a ``VerificationReport``: the
checks it actually performed, the support it expected from theory, the support it
observed in the real execution result, and the ``result_id``/``circuit_hash`` that
tie the report back to the provenance log (docs/VERIFICATION_ARCHITECTURE.md §3-4).

``VerificationStatus`` here is intentionally separate from
``qentor.provenance.models.VerificationStatus``: that one describes whether an
*execution* completed cleanly (VERIFIED/FAILED/ERROR). This one describes whether a
*verifier's judgement* about a circuit holds, which also needs UNVERIFIABLE for
circuits a given verifier does not know how to check (docs/VERIFICATION_ARCHITECTURE.md
§4.3 uses the same status for the equivalence checker).
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict


class CheckStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"


class VerificationStatus(str, Enum):
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"
    UNVERIFIABLE = "UNVERIFIABLE"
    ERROR = "ERROR"


class VerificationCheck(BaseModel):
    """One named check a verifier performed, with a human-readable reason."""

    model_config = ConfigDict(extra="forbid")

    name: str
    status: CheckStatus
    detail: str


class VerificationReport(BaseModel):
    """Structured evidence returned by every verifier. Never a bare pass/fail."""

    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit_hash: str
    verifier: str
    verification_status: VerificationStatus
    checks: list[VerificationCheck]
    expected_support: list[str]
    observed_support: list[str]
