"""Resource smoke: how long the largest ACCEPTED requests take, how big their answers and stored records are, how the database grows, and
whether the server stays up and answers under a modest concurrent load of them. Drives a running server over real HTTP; prints what it measured
and changes nothing in the product.

  python backend/scripts/resource_smoke.py --base http://127.0.0.1:8011 --db /tmp/qentor_prod.db [--concurrency 4] [--rounds 2]

"Largest accepted" means exactly the documented limits (qentor.execution.limits and the harness/trace/variational caps): 16 qubits and 500
operations on Aer, 14 on Cirq and PennyLane, 100000 shots, a 255-operation 8-qubit trace, a 256-case 8-input multi-input test, a 10-qubit 500-operation
equivalence check, a 64-point sweep, a 25-step optimisation. Nothing here is a quantum value to be trusted; it is a stopwatch.
Exit status 0 means every request got the expected answer and the server stayed healthy.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from qentor.circuit.model import Circuit, GateOp  # noqa: E402  (pure model)


def _circuit(n: int, ops: int, *, measure: bool = False) -> dict:
    """A deterministic dense circuit: layers of h / rx / cx over every qubit, up to `ops` operations (measurements add n)."""
    body: list[GateOp] = []
    layer = 0
    while len(body) < ops - (n if measure else 0):
        for q in range(n):
            if len(body) >= ops - (n if measure else 0):
                break
            if layer % 3 == 0:
                body.append(GateOp(gate="h", targets=[q]))
            elif layer % 3 == 1:
                body.append(GateOp(gate="rx", targets=[q], params=[0.1 + 0.01 * q]))
            elif n > 1:
                body.append(GateOp(gate="cx", controls=[q], targets=[(q + 1) % n]))
            else:
                body.append(GateOp(gate="x", targets=[q]))
        layer += 1
    if measure:
        body += [GateOp(gate="measure", targets=[q], clbits=[q]) for q in range(n)]
    return json.loads(Circuit(num_qubits=n, num_clbits=n if measure else 0, ops=body).model_dump_json(by_alias=True))


def _post(base: str, path: str, body: dict) -> tuple[int, int, float]:
    data = json.dumps(body).encode()
    request = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"}, method="POST")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            raw = response.read()
            return response.status, len(raw), time.monotonic() - started
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, len(raw), time.monotonic() - started
    except Exception:  # noqa: BLE001 - connection reset: the server died
        return -1, 0, time.monotonic() - started


def worst_cases() -> list[tuple[str, str, dict]]:
    eight = _circuit(8, 255)
    basis_cases = [{"input_bits": format(i, "08b"), "expected_output": "0" * 8} for i in range(256)]
    return [
        ("execute  aer 16q 500 ops statevector", "/api/execute", {"circuit": _circuit(16, 500), "mode": "statevector"}),
        ("execute  aer 16q 500 ops 100000 shots", "/api/execute", {"circuit": _circuit(16, 500, measure=True), "mode": "shots", "shots": 100000}),
        ("execute  cirq 14q 500 ops statevector", "/api/execute", {"circuit": _circuit(14, 500), "mode": "statevector", "backend": "cirq"}),
        ("execute  pennylane 14q 500 ops statevector", "/api/execute", {"circuit": _circuit(14, 500), "mode": "statevector", "backend": "pennylane"}),
        ("trace    8q 255 ops (256 backend runs)", "/api/execute/trace", {"circuit": eight, "mode": "statevector"}),
        ("multi-input 8 inputs 256 cases 8q 120 ops", "/api/test/multi-input", {"circuit": _circuit(8, 120), "input_qubits": list(range(8)), "output_qubits": list(range(8)), "cases": basis_cases}),
        ("equivalence 10q 500 ops vs itself", "/api/verify/equivalence", {"circuit_a": _circuit(10, 500), "circuit_b": _circuit(10, 500)}),
        ("optimize 10q 500 ops", "/api/optimize", {"circuit": _circuit(10, 500)}),
        ("compare backends 14q 200 ops", "/api/compare/backends", {"circuit": _circuit(14, 200)}),
        ("variational sweep 64 points", "/api/variational/sweep", {"theta_min": 0.0, "theta_max": 2 * math.pi, "points": 64}),
        ("variational optimize 25 steps", "/api/variational/optimize", {"theta_start": 1.0, "steps": 25, "learning_rate": 0.5}),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:8011")
    parser.add_argument("--db", default=None, help="the server's SQLite file, to report its growth")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--rounds", type=int, default=2, help="rounds of the whole worst-case set run concurrently")
    parser.add_argument("--flood", type=int, default=0, help="also send this many heavy equivalence requests at once and time light requests meanwhile")
    args = parser.parse_args()

    def db_bytes() -> int:
        return os.path.getsize(args.db) if args.db and os.path.exists(args.db) else 0

    failures = 0
    print(f"{'worst-case request':<46} {'status':>6} {'seconds':>8} {'answer KB':>10} {'db +KB':>9}")
    for label, path, body in worst_cases():
        before = db_bytes()
        status, size, seconds = _post(args.base, path, body)
        print(f"{label:<46} {status:>6} {seconds:>8.2f} {size / 1024:>10.1f} {(db_bytes() - before) / 1024:>9.1f}")
        if status != 200:
            failures += 1

    print(f"\nconcurrent: {args.rounds} round(s) of the whole set, {args.concurrency} at a time")
    jobs = [(label, path, body) for _ in range(args.rounds) for (label, path, body) in worst_cases()]
    started = time.monotonic()
    before = db_bytes()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        results = list(pool.map(lambda j: _post(args.base, j[1], j[2]), jobs))
    elapsed = time.monotonic() - started
    statuses: dict[int, int] = {}
    for status, _, _ in results:
        statuses[status] = statuses.get(status, 0) + 1
    slowest = max(results, key=lambda r: r[2])
    print(f"requests={len(jobs)} elapsed={elapsed:.1f}s statuses={statuses} slowest={slowest[2]:.1f}s db growth={(db_bytes() - before) / 1024 / 1024:.1f} MB")
    failures += len(jobs) - statuses.get(200, 0)

    if args.flood:
        print(f"\nflood: {args.flood} heavy equivalence requests at once; light requests are timed while they run")
        heavy = ("/api/verify/equivalence", {"circuit_a": _circuit(10, 500), "circuit_b": _circuit(10, 500)})
        light_seconds: list[float] = []
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=args.flood + 1) as pool:
            futures = [pool.submit(_post, args.base, *heavy) for _ in range(args.flood)]
            time.sleep(1.0)
            while not all(f.done() for f in futures) and time.monotonic() - started < 600:
                t0 = time.monotonic()
                try:
                    with urllib.request.urlopen(args.base + "/api/lessons", timeout=60) as response:
                        response.read()
                        light_seconds.append(time.monotonic() - t0)
                except Exception:  # noqa: BLE001
                    light_seconds.append(float("inf"))
                time.sleep(0.5)
            flood_statuses: dict[int, int] = {}
            for f in futures:
                flood_statuses[f.result()[0]] = flood_statuses.get(f.result()[0], 0) + 1
        light_seconds.sort()
        median = light_seconds[len(light_seconds) // 2] if light_seconds else float("nan")
        print(f"elapsed={time.monotonic() - started:.1f}s heavy statuses={flood_statuses}; {len(light_seconds)} light GETs during it: median {median * 1000:.0f} ms, worst {light_seconds[-1] * 1000 if light_seconds else float('nan'):.0f} ms")
        if any(status not in (200, 503) for status in flood_statuses) or not light_seconds or light_seconds[-1] == float("inf"):
            failures += 1

    try:
        with urllib.request.urlopen(args.base + "/api/health", timeout=10) as response:
            healthy = response.status == 200
    except Exception:  # noqa: BLE001
        healthy = False
    print(f"server healthy afterwards: {healthy}; database {db_bytes() / 1024 / 1024:.1f} MB")
    if not healthy or failures:
        print(f"FAIL: {failures} request(s) not 200, healthy={healthy}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
