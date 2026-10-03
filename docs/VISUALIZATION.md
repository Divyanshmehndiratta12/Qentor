# Visualization and lesson access

What the visualization sprint added, how it keeps the trust boundary, and how to re-check it. Three changes: every lesson opens directly; every
statevector run, trace step and shared run has an interactive 3D Bloch view, one sphere per qubit; the circuit editor draws multi-wire gates the way
circuit diagrams do and says more about what is selected. **Nothing here computes a quantum number in the browser.**

## 1. Every lesson opens directly

`getLessonState` (`web/src/features/learn/lessonState.ts`) is now only `available | completed`; there is no `locked`. Prerequisite metadata is kept
exactly as the server sends it (`prerequisite_lesson_ids`) and still drives the **recommended path**, through `getLessonReadiness`
(`completed | ready | builds_on_unfinished`):

- the Learn list says **Builds on: …** under a lesson whose prerequisites are not all completed, and **Suggested next** on the one lesson
  `getNextChallenge` recommends (the first ready, not-completed lesson; a misconception still comes first);
- a lesson's page says "recommended first, but you can start here any time";
- the Progress screen shows the same "Builds on" line and opens every row;
- the recommendation (`recommendation.ts`, `learnerInsights.ts`), mastery, concept-check state, challenge progress, local persistence (the v1
  progress blob is unchanged) and classroom events are untouched: opening a lesson out of order changes none of them.

There was never a server-side lock, and none was added. Tests: `lessonAccess.test.tsx` (every one of the real 18 lessons opens from a fresh
start; prerequisites preserved; recommendation still follows them; mastery unaffected; an old saved v1 blob loads), `lessonState.test.ts`, and the
rewritten locked-lesson tests in the curriculum and progress suites.

## 2. The 3D Bloch view

A general register has **no single Bloch vector**. One qubit gets one sphere ("Interactive Bloch sphere"); several qubits get one sphere **per
qubit**, each drawn from that qubit's own reduced state ("Qubit state view"). An entangled qubit's sphere shows the backend's reduced vector (length
about 0 for a Bell pair), with the backend's purity and "entangled with the rest of the register" beside it. A qubit the backend could not give a
usable state shows "Bloch vector unavailable for this qubit" with the backend's reason; no state at all (a shots run, an older server) shows an
honest unavailable card that says why.

### Where the numbers come from

| View | Source | Server code |
|---|---|---|
| Result: final state of a statevector run | `qubit_states` on `POST /api/execute` | `api/state_view.py` -> `execution/reduced_state.py`, from the STORED statevector, tagged with the run's result id |
| Trace: the selected step | `qubit_states` / `bloch_vector` of that step of `POST /api/execute/trace` | `execution/trace.py` (existing) |
| Comparison: run A or run B | the `qubit_states` each run was served with | as the result |
| Shared page: the stored run | `qubit_states` of the stored result | `api/state_view.py` over the stored record |
| Lesson 17 (VQE) | the sweep's single-qubit Bloch vector | `api/variational.py` (existing) |

`qubit_states` is derived on the way out and is not written into the stored payload. A shots run has none. There is no request field through which a
client could supply one (`extra="forbid"`; tested over HTTP).

### The invariant, in code

- `web/src/features/bloch3d/` takes `TraceQubitState[]` (or one single-qubit `TraceBlochVector`): never an amplitude, a statevector, a gate or a
  circuit. The scene is handed a plain `{x, y, z}`, the backend's own Bloch length (it only sizes the arrowhead) and flags.
- The one thing done to a supplied number is `toScene`, a fixed axis permutation `(x, y, z) -> (x, z, -y)` (Bloch z is up, a proper rotation). The
  arrowhead is oriented with three.js `lookAt` the origin, so no direction or length is computed.
- Every number on screen goes through `VerifiedValueInline` with its provenance. The scene draws no number: its labels are the six fixed state names
  and the axis names.
- A vector outside the unit sphere is shown as numbers and flagged, never drawn or "fixed".
- `bloch3dTrust.test.ts` scans the 3D sources for `Math.*`, square roots, trigonometry, normalisation, arithmetic on a component, and any import of
  circuit/execution/verification code; it also enforces that three.js is imported only by the lazy chunk.
- **Animation is presentation only.** When the selected step changes, the DRAWN arrow eases (a fraction of a second) from where it was to the new backend
  point and lands on it exactly; positions in between are screen positions, not states, and no number is shown for them. With reduced motion it jumps.

### Controls

Drag = orbit, wheel or two-finger pinch = zoom, **Reset view** button, **Auto rotate** toggle (off by default; nothing spins until asked; disabled with
an explanation under `prefers-reduced-motion`). Pan is disabled and the distance is limited both ways, so a sphere cannot be lost. Focus a sphere and
use the arrow keys (rotate), `+` / `-` (zoom) and `0` or `Home` (reset). Each sphere has an accessible name that states its backend vector, a help text,
and the same numbers as page text beside it (X, Y, Z, length, purity, entanglement, source result id). A step change does not reset the camera.

### Implementation

- One WebGL canvas per view, with a separate scene, camera and `OrbitControls` per qubit drawn into that qubit's tile (a scissored viewport; the
  backend allows up to 16 qubits and a browser keeps few WebGL contexts). drei's `View` was not used: it shares a module-wide tunnel, which breaks when
  the Lab shows a result view and a trace view at once.
- Rendering is on demand (`frameloop="demand"`): a frame is drawn only on a drag, zoom, new vector, easing step or the auto-rotate loop. Measured in
  Chrome: zero WebGL draw calls over 1.5 s idle.
- The 3D code is a lazy chunk (`SphereGrid`), loaded when the first view mounts. Without WebGL, or if the chunk cannot load, the flat projection
  (`BlochSphere` / `QubitSpheres`) is shown with the same numbers, and the view says so.
- Reset and keyboard steps run with the controls' damping flushed, so a reset returns the exact starting view (verified pixel for pixel).

### Bundle

| | main JS | gzip | lazy 3D chunk | gzip |
|---|---|---|---|---|
| before (`368a68c`) | 2,270,772 B | 703.52 kB | none | |
| after | MAIN_AFTER | MAIN_AFTER_GZ | CHUNK_AFTER | CHUNK_AFTER_GZ |

The first download grows by the new view shell only; three.js, react-three-fiber and drei load with the first Lab result. The large-chunk warning is
unchanged (it is Plotly's); it was not silenced. `three` is pinned to 0.182.0 because 0.183+ logs a `THREE.Clock` deprecation warning through
react-three-fiber 9.

## 3. The circuit editor

Visual only; the canonical circuit is untouched and every `aria-label`, test id and edit path is as before.

- **Gate families** (colour AND shape/letters, never colour alone): Hadamard (cyan), Pauli, phase (violet), rotation (amber, angle on the tile),
  controlled, swap, measurement. Tiles are one size (36 px) on a fixed 60 px wire pitch.
- **Controlled gates**: a dot on each control, a ROUND target, and one vertical line through every wire between them; a controlled phase writes
  `φ π/2` on the line, a swap joins two × marks.
- **Insertion**: a dashed guide runs through every wire at the insertion point, labelled `▾ next`; the cell under the pointer previews what the next
  click places (a dot for a control, then the target, or the gate's letters); a refused edit turns the cells red beside the reason.
- **Selection**: the picked gate has a white border and ring; the toolbar names its family and what it is, and the trace step that applied it; the
  gate behind the selected trace step has an amber marker, and the same line is marked in the OpenQASM editor (violet for a picked gate, amber for a
  traced one; dropped, never guessed, when the editor text is not the canvas's own).
- **Palette**: one compact strip (32 px buttons, grouped, family-coloured letters, a tiny dot-and-ring glyph on the multi-wire gates) that scrolls on its
  own on a phone.
- **Empty circuit**: "Drag a gate onto a qubit wire — or pick one below, then click a wire", beside the first insertion point.

## 4. Re-checking it

```
backend/.venv/bin/python -m unittest backend.tests.test_execute_state_view     # or the full discover command in CLAUDE.md
(cd web && npx vitest run && npx tsc -b && npm run build)
backend/.venv/bin/python backend/scripts/mutation_check.py all viz            # the 70+ mutants of this sprint
QENTOR_DB_PATH=/tmp/viz.db backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --port 8011
python3 backend/scripts/viz_http_smoke.py http://127.0.0.1:8011               # real HTTP, independent reduced-state calculation
node scripts/viz_journey.mjs /tmp/viz-out http://127.0.0.1:8011               # real Chrome: lessons, 3D, editor, phones, axe
```

`viz_journey.mjs` runs Chrome with its software GL renderer so the spheres are really drawn; a rotation is detected by comparing screenshots of a
sphere's tile (the camera is not exposed to the page), and Reset must give back the starting pixels exactly. Qubi (the roaming tutor companion) is drawn over
whatever it passes, tiles included, so the journey hides it with a style rule the harness injects (the app is untouched); Qubi has its own checks, see
`BUILD_STATE.md`.

## 5. Limits

- The spheres need WebGL. Without it the flat projection (the previous view) is shown, with a note.
- Wheel zoom captures the wheel while the pointer is over a sphere (an OrbitControls property); scrolling the Results column with the pointer over a
  sphere zooms it instead. Use the margins or the keyboard.
- A statevector run of a circuit with measurements is one collapsed branch; the view says so.
- Shots runs have no state, so they have no sphere; the card says so.
- Verified in one Chrome version through its software renderer; a real GPU, Firefox and Safari were not tried. The no-WebGL fallback was checked in
  Chrome started with WebGL disabled (flat view and note shown, numbers present, axe clean).
- On a 320 px phone the "Code" label above the code tabs is hidden so the four tabs fit; without that the page was 54 px wider than the screen.
- Changing the number of qubits starts a new empty circuit (existing behaviour, undoable); it is not changed here.
