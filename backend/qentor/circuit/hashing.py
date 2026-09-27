"""Deterministic circuit hashing.

The hash is SHA-256 over the circuit's canonical OpenQASM 3 text (UTF-8 encoded).
Hashing the QASM text, not the JSON, means two circuits that emit identical QASM
hash identically even if some future JSON field order changes — and it is the QASM
text that is actually shared across stages (canvas, code editor, every adapter).
"""

from __future__ import annotations

import hashlib

from .model import Circuit
from .qasm import to_qasm3

_SHORT_ID_LEN = 12


def circuit_hash(circuit: Circuit) -> str:
    """Full lowercase hex SHA-256 digest of the circuit's canonical QASM text."""
    qasm_text = to_qasm3(circuit)
    return hashlib.sha256(qasm_text.encode("utf-8")).hexdigest()


def short_circuit_id(circuit: Circuit) -> str:
    """Display id used in the UI and in provenance records: ``qc_`` + 12 hex chars."""
    return f"qc_{circuit_hash(circuit)[:_SHORT_ID_LEN]}"
