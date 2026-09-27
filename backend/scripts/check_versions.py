"""Dependency version verification script.

Prints the interpreter and every required package's version. A package whose native
extension is blocked by the OS (see docs/BUILD_STATE.md) is reported as UNAVAILABLE
with the real import error, never silently skipped or faked.

Run: backend/.venv/Scripts/python.exe backend/scripts/check_versions.py
"""

from __future__ import annotations

import importlib
import sys


def report(module_name: str, label: str) -> None:
    try:
        mod = importlib.import_module(module_name)
    except Exception as exc:  # noqa: BLE001 - we want to report any import failure
        print(f"{label}: UNAVAILABLE ({type(exc).__name__}: {exc})")
        return
    version = getattr(mod, "__version__", "unknown")
    print(f"{label}: {version}")


def main() -> None:
    print(f"Python: {sys.version.split()[0]} ({sys.executable})")
    report("qiskit", "Qiskit")
    report("qiskit_aer", "Qiskit Aer")
    report("cirq", "Cirq")
    report("pennylane", "PennyLane")
    report("numpy", "NumPy")
    report("fastapi", "FastAPI")
    report("pydantic", "Pydantic")
    report("uvicorn", "Uvicorn")


if __name__ == "__main__":
    main()
