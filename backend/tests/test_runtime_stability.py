"""Process-stability regression tests (docs/BUILD_STATE.md "Process stability").

Background: Qiskit 2.5.2's Rust extension was observed to segfault when the first import of Qiskit happened on a worker
thread that later exited and a later fresh thread then built a ``QuantumCircuit``. The server's mitigation is to import
the native backends on the main thread at startup (``qentor.execution.runtime.preload_backends``). These tests pin that
mitigation; they do not claim the dependency bug is fixed.

The thread-churn tests run in a CHILD process: a native crash must fail one test with a signal exit status, not kill
the test runner.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from qentor.execution import runtime

BACKEND = Path(__file__).resolve().parents[1]

CHURN_CHILD = textwrap.dedent(
    """
    import faulthandler, sys, threading
    sys.path.insert(0, {backend!r})
    faulthandler.enable()
    {warm}
    from qentor.circuit.model import Circuit, GateOp
    from qentor.execution.aer import AerAdapter
    from qentor.verification.equivalence import check_equivalence

    c = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])])
    d = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1]), GateOp(gate="z", targets=[1]), GateOp(gate="z", targets=[1])])
    aer = AerAdapter()
    for _ in range({iterations}):
        def body():
            aer.run(c, "statevector")
            assert check_equivalence(c, d).equivalent
        t = threading.Thread(target=body)
        t.start()
        t.join()
    print("completed")
    """
)


def _run_child(warm: bool, iterations: int) -> subprocess.CompletedProcess[str]:
    source = CHURN_CHILD.format(
        backend=str(BACKEND),
        warm="from qentor.execution.runtime import preload_backends; preload_backends()" if warm else "",
        iterations=iterations,
    )
    return subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, timeout=300)


class PreloadBackendsTests(unittest.TestCase):
    def test_imports_the_native_backends_on_the_calling_thread(self) -> None:
        outcome = runtime.preload_backends()
        for name in ("numpy", "qiskit", "qiskit.quantum_info", "qiskit_aer"):
            self.assertTrue(outcome[name], f"{name} must preload in the pinned environment")
            self.assertIn(name, sys.modules)

    def test_covers_every_lazily_imported_backend_module(self) -> None:
        # The adapters and the equivalence checker import these inside functions; each must be preloaded or the
        # first request would import it on an AnyIO worker thread again.
        for name in ("qiskit", "qiskit.quantum_info", "qiskit_aer", "cirq", "pennylane"):
            self.assertIn(name, runtime.BACKEND_MODULES)

    def test_an_unavailable_backend_is_reported_not_raised(self) -> None:
        real = runtime.importlib.import_module

        def fake(name: str, *args, **kwargs):
            if name == "cirq":
                raise ImportError("simulated missing backend")
            return real(name, *args, **kwargs)

        with mock.patch.object(runtime.importlib, "import_module", side_effect=fake):
            with self.assertLogs("qentor.runtime", level="WARNING") as logged:
                outcome = runtime.preload_backends()
        self.assertFalse(outcome["cirq"])
        self.assertTrue(outcome["qiskit"])
        self.assertTrue(any("cirq" in line and "simulated missing backend" in line for line in logged.output))

    def test_importing_the_app_preloads_before_any_request(self) -> None:
        source = textwrap.dedent(
            f"""
            import sys, threading
            sys.path.insert(0, {str(BACKEND)!r})
            import qentor.api.app  # noqa: F401
            assert threading.current_thread() is threading.main_thread()
            for name in ("qiskit", "qiskit_aer", "qiskit.quantum_info"):
                assert name in sys.modules, name + " not imported at app import"
            print("preloaded")
            """
        )
        done = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertIn("preloaded", done.stdout)


class ThreadChurnTests(unittest.TestCase):
    def test_fresh_threads_run_real_backend_work_after_preload(self) -> None:
        # 100 fresh threads per process, three processes: the cold-start version of this crashed in roughly two of
        # three processes (4 of 6 measured), so a regression of the preload shows up here as a signal exit status.
        for attempt in range(3):
            done = _run_child(warm=True, iterations=100)
            self.assertEqual(done.returncode, 0, f"attempt {attempt}: exit {done.returncode}\n{done.stderr[-2000:]}")
            self.assertIn("completed", done.stdout)

    def test_the_child_harness_reports_a_failing_child(self) -> None:
        # Failure case for the harness itself: a child that dies must surface as a non-zero exit, not a pass.
        done = subprocess.run(
            [sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGSEGV)"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotEqual(done.returncode, 0)
        self.assertNotIn("completed", done.stdout)


if __name__ == "__main__":
    unittest.main()
