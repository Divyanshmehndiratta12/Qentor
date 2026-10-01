"""Read-only shared experiments: an immutable snapshot of what an owner chose to share, and nothing about the owner.

A shared experiment holds the canonical circuit, the backend and run mode that were selected, an optional lesson or challenge it belongs to, an optional
short title, and (when the owner had run it) the id of ONE provenance record of that very circuit. The page that shows it is built from the circuit
and from that record's stored, authoritative payload: nothing in it is typed in by the owner, and nothing about the owner (a learner token, a class, an
address, a path, a key) is stored with it.
"""

from __future__ import annotations

from .store import ExperimentRecord, ExperimentStore, is_experiment_id

__all__ = ["ExperimentRecord", "ExperimentStore", "is_experiment_id"]
