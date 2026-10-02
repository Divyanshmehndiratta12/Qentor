"""Import the native-extension backends on the process's main thread, once, at startup.

Why this exists (evidence in docs/BUILD_STATE.md "Process stability"): when the FIRST import of Qiskit / Qiskit Aer
happens on a worker thread and that thread later exits, a later ``QuantumCircuit(...)`` constructed on a fresh worker
thread can die with a segmentation fault inside Qiskit's Rust extension. FastAPI runs the synchronous endpoints on AnyIO
worker threads that retire after about ten idle seconds, and every adapter imports its library lazily inside ``run`` —
so the first request used to be that first importing thread. Importing here, on the main thread before the server
accepts a request, removes that trigger. In isolated-process measurements (100 fresh threads per process, repeated) the
cold start crashed in 4 of 6 runs and the main-thread import crashed in 0 of 24. This is a mitigation of an observed
trigger, not a fix of the dependency, and the root cause inside the extension is not claimed.

Nothing here runs a circuit or produces a quantum value; an import that fails is reported and left for the adapter to
report as ``AdapterUnavailable`` when it is actually used.
"""

from __future__ import annotations

import importlib
import logging

logger = logging.getLogger("qentor.runtime")

# Every module an adapter or the verification layer imports lazily inside a function.
BACKEND_MODULES: tuple[str, ...] = (
    "numpy",
    "qiskit",
    "qiskit.quantum_info",
    "qiskit_aer",
    "cirq",
    "pennylane",
)


def preload_backends() -> dict[str, bool]:
    """Import each backend module on the calling thread. Returns {module: imported}; never raises."""
    outcome: dict[str, bool] = {}
    for name in BACKEND_MODULES:
        try:
            importlib.import_module(name)
            outcome[name] = True
        except Exception as exc:  # noqa: BLE001 - an unavailable backend must stay "unavailable", not crash startup
            outcome[name] = False
            logger.warning("backend module %s could not be preloaded: %s: %s", name, type(exc).__name__, exc)
    return outcome
