"""Process-stability smoke for the production server. Starts the real API under uvicorn in a child process, drives it
over real HTTP, and checks the process survives, answers every request, and shuts down cleanly.

  python backend/scripts/stability_smoke.py churn      [--requests 60]
  python backend/scripts/stability_smoke.py sustained  [--requests 600] [--workers 8]

churn      the child runs with AnyIO worker threads that retire almost at once (changes only that child's AnyIO idle
           timeout, nothing in the product), so nearly every request lands on a brand-new thread — what a human-paced
           browser session does, since idle workers retire after ten seconds. This is the condition under which a
           Qiskit native-extension segfault was reproduced (docs/BUILD_STATE.md "Process stability").
sustained  the child runs exactly as production does (default AnyIO settings); N requests from W concurrent clients.

Every request exercises Qiskit code (run, trace, equivalence, optimize) so a native crash would show. Exit status 0
means: no request failed, the child never died, and SIGINT shut it down with exit status 0. Nothing here asserts a
quantum value; the product's own tests do that.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from qentor.circuit.model import Circuit, GateOp  # noqa: E402  (pure model, imports no quantum library)

CHURN_BOOTSTRAP = """
import sys
sys.path.insert(0, {backend!r})
from anyio._backends import _asyncio as a
a.WorkerThread.MAX_IDLE_TIME = 0.02
{control}import uvicorn
uvicorn.run("qentor.api.app:app", host="127.0.0.1", port={port}, log_level="warning")
"""
SUSTAINED_BOOTSTRAP = """
import sys
sys.path.insert(0, {backend!r})
{control}import uvicorn
uvicorn.run("qentor.api.app:app", host="127.0.0.1", port={port}, log_level="warning")
"""


NO_PRELOAD = "import qentor.execution.runtime as r\nr.preload_backends = lambda: {}\n"


def _circuit(ops: list[GateOp], n: int = 2, clbits: int = 0) -> dict:
    return json.loads(Circuit(num_qubits=n, num_clbits=clbits, ops=ops).model_dump_json(by_alias=True))


def _requests() -> list[tuple[str, dict]]:
    bell = [GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])]
    bell_padded = [GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[1]), GateOp(gate="h", targets=[1]), *bell[1:]]
    measured = [*bell, GateOp(gate="measure", targets=[0], clbits=[0]), GateOp(gate="measure", targets=[1], clbits=[1])]
    ghz = [GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1]), GateOp(gate="cx", controls=[1], targets=[2])]
    return [
        ("/api/execute", {"circuit": _circuit(bell), "mode": "statevector"}),
        ("/api/execute", {"circuit": _circuit(measured, clbits=2), "mode": "shots", "shots": 256}),
        ("/api/execute", {"circuit": _circuit(bell), "mode": "statevector", "backend": "cirq"}),
        ("/api/execute/trace", {"circuit": _circuit(ghz, n=3), "mode": "statevector"}),
        ("/api/verify/equivalence", {"circuit_a": _circuit(bell), "circuit_b": _circuit(bell_padded)}),
        ("/api/optimize", {"circuit": _circuit(bell_padded)}),
    ]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _post(base: str, path: str, body: dict) -> int:
    request = urllib.request.Request(
        base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as exc:
        print(f"  {path} -> {exc.code}: {exc.read().decode()[:300]}")
        return exc.code
    except (urllib.error.URLError, ConnectionError, OSError) as exc:
        return -1  # the server went away mid-request; main() reports whether the process died and how


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["churn", "sustained"])
    parser.add_argument("--requests", type=int, default=None)
    parser.add_argument("--workers", type=int, default=None, help="concurrent clients (default: 1 for churn, 8 for sustained)")
    parser.add_argument("--pause", type=float, default=0.05, help="churn only: seconds to wait after each request so the idle worker retires")
    parser.add_argument(
        "--no-preload",
        action="store_true",
        help="negative control: the child skips the startup preload (patched in the child only) to show the smoke "
        "can detect the crash the preload prevents",
    )
    args = parser.parse_args()
    total = args.requests or (60 if args.mode == "churn" else 600)
    workers = args.workers or (1 if args.mode == "churn" else 8)

    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    source = (CHURN_BOOTSTRAP if args.mode == "churn" else SUSTAINED_BOOTSTRAP).format(
        backend=str(BACKEND), port=port, control=NO_PRELOAD if args.no_preload else ""
    )
    env = {**os.environ, "QENTOR_DB_PATH": str(Path(os.environ.get("TMPDIR", "/tmp")) / f"stability_{port}.db")}
    child = subprocess.Popen([sys.executable, "-c", source], env=env, cwd=BACKEND)
    try:
        started = time.monotonic()
        while True:
            if child.poll() is not None:
                print(f"FAIL: server exited during startup, status {child.returncode}")
                return 1
            try:
                with urllib.request.urlopen(base + "/api/health", timeout=2):
                    break
            except Exception:  # noqa: BLE001 - still starting
                if time.monotonic() - started > 120:
                    print("FAIL: server did not become healthy in 120 s")
                    return 1
                time.sleep(0.25)
        print(f"server up in {time.monotonic() - started:.1f} s (pid {child.pid}, mode {args.mode})")

        plan = _requests()
        jobs = [plan[i % len(plan)] for i in range(total)]
        statuses: dict[int, int] = {}

        def fire(job: tuple[str, dict]) -> int:
            status = _post(base, *job)
            if args.mode == "churn":
                time.sleep(args.pause)  # lets the idle worker retire, so the next request starts a fresh thread
            return status

        begin = time.monotonic()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for status in pool.map(fire, jobs):
                statuses[status] = statuses.get(status, 0) + 1
        elapsed = time.monotonic() - begin
        alive = child.poll() is None
        print(f"requests={total} workers={workers} elapsed={elapsed:.1f}s rate={total / elapsed:.1f}/s statuses={statuses}")
        if not alive:
            print(f"FAIL: server died during the run, status {child.returncode}")
            return 1
        failed = total - statuses.get(200, 0)
        if failed:
            print(f"FAIL: {failed} request(s) did not return 200")
            return 1
    finally:
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
                print("FAIL: server ignored SIGINT for 30 s and was killed")
                return 1
    print(f"clean shutdown, exit status {child.returncode}")
    return 0 if child.returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
