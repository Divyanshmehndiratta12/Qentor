"""Verification layer (docs/ARCHITECTURE.md §7, docs/VERIFICATION_ARCHITECTURE.md).

This package only ever reads a canonical ``Circuit`` and a real, already-persisted
``ProvenanceRecord`` and reports structured evidence about them. It never executes a
circuit, never invents a probability or count, and never writes to the provenance
log — see ``qentor.execution`` and ``qentor.provenance`` for those. It must never
import ``tutor``; see ``backend/tests/test_architecture_rule.py``.

Milestone 2 foundation: the general test harness, equivalence checker and optimiser
from docs/VERIFICATION_ARCHITECTURE.md §4 are not built yet. ``bell_state`` is the
first concrete verifier.
"""

from __future__ import annotations

from .bell_state import (
    VERIFIER_NAME,
    BellPatternMismatch,
    UnsupportedExecutionMode,
    verify_bell_state,
)
from .models import CheckStatus, VerificationCheck, VerificationReport, VerificationStatus

__all__ = [
    "VERIFIER_NAME",
    "BellPatternMismatch",
    "UnsupportedExecutionMode",
    "verify_bell_state",
    "CheckStatus",
    "VerificationCheck",
    "VerificationReport",
    "VerificationStatus",
]
