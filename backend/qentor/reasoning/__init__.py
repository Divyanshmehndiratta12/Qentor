"""Quantum reasoning engine (Sprint 6): server-side analysis above execution, trace, optimisation and comparison.

Dependency direction: this package imports ``circuit``, ``execution`` and ``verification`` and nothing above them. It never
imports ``qentor.tutor``, the provenance STORE or the attempt log: it takes already-fetched ``ProvenanceRecord`` objects and an
injected ``runner`` / ``record_execution`` callback, exactly like ``qentor.verification.multi_input_harness``. The API layer
(``qentor.api.reasoning``) fetches and verifies the records, stores each analysis as one more provenance record, and hands that
record to the tutor, which reads its facts back (``qentor.tutor.reasoning_facts``). See ``docs/REASONING_ENGINE.md``.
"""

from __future__ import annotations

from .debug import analyze_debug, structure_facts
from .models import METHOD, REASONING_BACKEND, REASONING_MODE, Analysis, Intent, ReasoningError, Source, source_of
from .optimization import analyze_optimization
from .probability import (
    BasisStateTarget,
    EachQubitValueTarget,
    MostLikelyTarget,
    ProbabilityTarget,
    QubitValueTarget,
    SampledVsTheoreticalTarget,
    analyze_probability,
)
from .trace_change import analyze_trace_change
from .whatif import (
    InsertGate,
    Modification,
    RemoveGate,
    ReplaceGate,
    SetAngle,
    WhatIfPreview,
    WhatIfRejected,
    analyze_what_if,
    apply_modification,
    preview_what_if,
)

__all__ = [
    "METHOD",
    "REASONING_BACKEND",
    "REASONING_MODE",
    "Analysis",
    "BasisStateTarget",
    "EachQubitValueTarget",
    "Intent",
    "InsertGate",
    "Modification",
    "MostLikelyTarget",
    "ProbabilityTarget",
    "QubitValueTarget",
    "ReasoningError",
    "RemoveGate",
    "ReplaceGate",
    "SampledVsTheoreticalTarget",
    "SetAngle",
    "Source",
    "WhatIfPreview",
    "WhatIfRejected",
    "analyze_debug",
    "analyze_optimization",
    "analyze_probability",
    "analyze_trace_change",
    "analyze_what_if",
    "apply_modification",
    "preview_what_if",
    "source_of",
    "structure_facts",
]
