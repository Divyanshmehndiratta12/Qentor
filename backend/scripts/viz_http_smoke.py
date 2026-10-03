"""Real-HTTP smoke test of the per-qubit state view (`qubit_states` on /api/execute and on a shared experiment).

Stdlib only, and it does NOT import anything from `qentor`: it talks to a running server over HTTP and checks every number against its
own, independent calculation of each qubit's reduced state from the statevector the same response carries (explicit loops, a different
code path from the server's). It also checks textbook states written here as literals, the three simulators against each other, that a
shots run has no state view, that a client cannot supply one, and that a shared page carries the same view as the live run.

    QENTOR_DB_PATH=/tmp/smoke.db backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --port 8011
    python3 backend/scripts/viz_http_smoke.py http://127.0.0.1:8011

Exits non-zero if any check fails; prints one line per check.
"""

from __future__ import annotations

import json
import math
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8011"
FAILED: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" :: {detail}"))
    if not ok:
        FAILED.append(name)


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or "null")
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, None


def op(gate: str, targets: list[int], controls: list[int] | None = None, params: list[float] | None = None, clbits: list[int] | None = None) -> dict:
    return {"gate": gate, "targets": targets, "controls": controls or [], "params": params or [], "clbits": clbits or []}


def circuit(n: int, ops: list[dict], clbits: int = 0) -> dict:
    return {"schema": "qentor.circuit/1", "num_qubits": n, "num_clbits": clbits, "ops": ops}


def execute(circ: dict, mode: str = "statevector", backend: str = "qiskit-aer", shots: int | None = None) -> tuple[int, dict | None]:
    return call("POST", "/api/execute", {"circuit": circ, "mode": mode, "shots": shots, "backend": backend})


def independent_reduced(statevector: list[list[float]], n: int, qubit: int) -> tuple[float, float, float, float]:
    """(x, y, z, purity) of ``qubit``, by explicit loops over the amplitudes: rho = Tr_rest |psi><psi|, then <X>, <Y>, <Z> and Tr(rho^2)."""
    amps = [complex(re, im) for re, im in statevector]
    rho = [[0j, 0j], [0j, 0j]]
    for rest in range(2 ** (n - 1)):
        low = rest & ((1 << qubit) - 1)
        high = rest >> qubit
        index = [(high << (qubit + 1)) | (bit << qubit) | low for bit in (0, 1)]
        for a in (0, 1):
            for b in (0, 1):
                rho[a][b] += amps[index[a]] * amps[index[b]].conjugate()
    x = 2 * rho[0][1].real
    y = -2 * rho[0][1].imag
    z = rho[0][0].real - rho[1][1].real
    purity = sum((rho[a][b] * rho[b][a]).real for a in (0, 1) for b in (0, 1))
    return x, y, z, purity


def close(a: float, b: float, tol: float = 1e-9) -> bool:
    return abs(a - b) <= tol


def states_match_independent(resp: dict, n: int, tol: float = 1e-9) -> bool:
    sv = resp["payload"]["statevector"]
    states = resp["qubit_states"]
    if [s["qubit"] for s in states] != list(range(n)):
        return False
    for s in states:
        x, y, z, p = independent_reduced(sv, n, s["qubit"])
        b = s["bloch"]
        if s["status"] != "OK" or not (close(b["x"], x, tol) and close(b["y"], y, tol) and close(b["z"], z, tol) and close(s["purity"], p, tol)):
            return False
    return True


S, H1 = math.sqrt(0.5), "h"

# ---- textbook states, written here as literals (never recomputed with the server's code)
CASES = {
    "|+> is +x": (circuit(1, [op("h", [0])]), [(1, 0, 0, 1.0, False)]),
    "|1> is -z": (circuit(1, [op("x", [0])]), [(0, 0, -1, 1.0, False)]),
    "|+i> (H then S) is +y": (circuit(1, [op("h", [0]), op("s", [0])]), [(0, 1, 0, 1.0, False)]),
    "|-> (H then Z) is -x": (circuit(1, [op("h", [0]), op("z", [0])]), [(-1, 0, 0, 1.0, False)]),
    "a product state: q0 +x, q1 -z": (circuit(2, [op("h", [0]), op("x", [1])]), [(1, 0, 0, 1.0, False), (0, 0, -1, 1.0, False)]),
    "a Bell pair: both qubits maximally mixed": (circuit(2, [op("h", [0]), op("cx", [1], [0])]), [(0, 0, 0, 0.5, True)] * 2),
    "GHZ(3): all three maximally mixed": (circuit(3, [op("h", [0]), op("cx", [1], [0]), op("cx", [2], [1])]), [(0, 0, 0, 0.5, True)] * 3),
    "q1 flipped only: q0 +z, q1 -z": (circuit(2, [op("x", [1])]), [(0, 0, 1, 1.0, False), (0, 0, -1, 1.0, False)]),
}
for name, (circ, expected) in CASES.items():
    status, resp = execute(circ)
    n = circ["num_qubits"]
    ok = status == 200 and resp is not None and len(resp["qubit_states"]) == n
    if ok:
        for s, (x, y, z, purity, entangled) in zip(resp["qubit_states"], expected):
            b = s["bloch"]
            ok = ok and s["status"] == "OK" and close(b["x"], x) and close(b["y"], y) and close(b["z"], z) and close(s["purity"], purity) and s["entangled_with_rest"] is entangled
    check(f"textbook: {name}", ok, resp and resp["qubit_states"])

# ---- the server's numbers agree with an independent calculation from the statevector the same response carries
SWEEP = [
    circuit(3, [op("h", [0]), op("cx", [1], [0]), op("cp", [2], [0], [math.pi / 3]), op("rx", [1], [], [0.7]), op("swap", [1, 2]), op("ccx", [2], [0, 1])]),
    circuit(4, [op("h", [0]), op("h", [1]), op("cp", [1], [0], [math.pi / 2]), op("h", [1]), op("ry", [3], [], [1.1]), op("cx", [2], [3]), op("t", [0])]),
    circuit(5, [op("h", [q]) for q in range(5)] + [op("cz", [1], [0]), op("cx", [4], [2]), op("rz", [3], [], [-0.4])]),
]
for i, circ in enumerate(SWEEP):
    status, resp = execute(circ)
    check(f"independent calculation agrees with the server on a {circ['num_qubits']}-qubit circuit ({len(circ['ops'])} ops)", status == 200 and states_match_independent(resp, circ["num_qubits"]), status)

# ---- provenance: every state names the run it came from
status, resp = execute(CASES["a Bell pair: both qubits maximally mixed"][0])
src = [s["derived_from"] for s in resp["qubit_states"]]
check("every state names this run's result id, circuit hash, backend and version, and the whole circuit (2 ops)", all(
    d["result_id"] == resp["result_id"] and d["circuit_hash"] == resp["circuit_hash"] and d["backend"] == resp["backend"] and d["backend_version"] == resp["backend_version"] and d["step_index"] == 2 and d["execution_id"] == resp["payload"]["execution_id"]
    for d in src), src)
check("the run is labelled SIMULATION and the state view was not added to the stored payload", resp["provenance_class"] == "SIMULATION" and "qubit_states" not in resp["payload"])

# ---- the three simulators agree with each other
bell = CASES["a Bell pair: both qubits maximally mixed"][0]
runs = {b: execute(bell, backend=b) for b in ("qiskit-aer", "cirq", "pennylane")}
available = {b: r[1] for b, r in runs.items() if r[0] == 200}
check("at least two simulators are available here", len(available) >= 2, {b: r[0] for b, r in runs.items()})
ref = available["qiskit-aer"]["qubit_states"]
check("every available simulator gives the same per-qubit view within 1e-6", all(
    all(close(a["bloch"][k], b["bloch"][k], 1e-6) for k in "xyz") and close(a["purity"], b["purity"], 1e-6) and a["entangled_with_rest"] == b["entangled_with_rest"]
    for resp_b in available.values() for a, b in zip(ref, resp_b["qubit_states"])), list(available))

# ---- shots has no state; a client cannot supply one; a measured circuit is one collapsed state
status, shots = execute(circuit(2, [op("h", [0]), op("cx", [1], [0]), op("measure", [0], clbits=[0]), op("measure", [1], clbits=[1])], clbits=2), mode="shots", shots=64)
check("a shots run has an empty state view and no statevector", status == 200 and shots["qubit_states"] == [] and "statevector" not in shots["payload"], shots and shots["qubit_states"])
status, _ = call("POST", "/api/execute", {"circuit": CASES["|+> is +x"][0], "mode": "statevector", "qubit_states": [{"qubit": 0}]})
check("a client-supplied qubit_states is refused (the request has no such field)", status == 422, status)
status, _ = call("POST", "/api/execute", {"circuit": CASES["|+> is +x"][0], "mode": "statevector", "bloch": {"x": 0, "y": 0, "z": 1}})
check("a client-supplied Bloch vector is refused", status == 422, status)
measured = circuit(2, [op("h", [0]), op("cx", [1], [0]), op("measure", [0], clbits=[0]), op("measure", [1], clbits=[1])], clbits=2)
status, collapsed = execute(measured)
check("a measured circuit in statevector mode is one collapsed state: each qubit pure, and still the server's calculation", status == 200 and all(close(s["purity"], 1.0) for s in collapsed["qubit_states"]) and states_match_independent(collapsed, 2))

# ---- the same view appears, unchanged, on a shared page built from the stored record
status, live = execute(bell)
status2, created = call("POST", "/api/experiments", {"circuit": bell, "result_id": live["result_id"], "title": "viz smoke"})
check("a read-only share is created for the stored run", status2 == 201 and created is not None, created)
if created:
    status3, page = call("GET", f"/api/experiments/{created['experiment_id']}")
    check("the shared page's per-qubit view equals the live run's, field for field", status3 == 200 and page["result"]["qubit_states"] == live["qubit_states"], status3)
    status4, shots_page = None, None
    s_status, s_run = execute(measured, mode="shots", shots=32)
    s2, s_created = call("POST", "/api/experiments", {"circuit": measured, "result_id": s_run["result_id"]})
    s3, s_page = call("GET", f"/api/experiments/{s_created['experiment_id']}")
    check("a shared shots run has no per-qubit view", s3 == 200 and s_page["result"]["qubit_states"] == [])

print(f"\n{'ALL PASSED' if not FAILED else 'FAILED: ' + ', '.join(FAILED)}")
sys.exit(1 if FAILED else 0)
