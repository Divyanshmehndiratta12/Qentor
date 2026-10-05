# Qentor documentation

A map of the documents in this folder. For the project overview and the live demo, start with the [repository README](../README.md).

## Architecture

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Modules, the canonical circuit model, backend adapters, storage, deployment, failure handling and the API surface |
| [`VISUALIZATION.md`](VISUALIZATION.md) | The 3D Bloch spheres, per-qubit states and the editor visuals |
| [`REASONING_ENGINE.md`](REASONING_ENGINE.md) | The server-side analysis layer: probability, optimisation, what-if and trace change |

## Verification and trust

| Document | What it covers |
|---|---|
| [`VERIFICATION_ARCHITECTURE.md`](VERIFICATION_ARCHITECTURE.md) | How results are produced and trusted: provenance, equivalence checking, agreement, challenge verdicts |
| [`AI_BOUNDARY.md`](AI_BOUNDARY.md) | What the AI tutor may and may not do, and how its claims are guarded |

## Curriculum

| Document | What it covers |
|---|---|
| [`SHOR_LESSON.md`](SHOR_LESSON.md) | The order-finding lesson: the fixed instance, what is verified, what it is not |
| [`VARIATIONAL.md`](VARIATIONAL.md) | The one-parameter VQE-style lesson and where its numbers come from |
| [`NOISE_LAB.md`](NOISE_LAB.md) | The Noise Lab and the "Understanding Quantum Noise" lesson: models, API, provenance, limits |

## Development

| Document | What it covers |
|---|---|
| [`BUILD_STATE.md`](BUILD_STATE.md) | What is built, the [environment](BUILD_STATE.md#environment) and commands, and the [known limitations](BUILD_STATE.md#known-limitations) |
| [Repository README: Local Development](../README.md#local-development) | Install, run and build commands |

## Testing

| Document | What it covers |
|---|---|
| [Repository README: Testing](../README.md#testing) | The backend, frontend, content and browser-journey commands |
| [`DEMO_JOURNEY.md`](DEMO_JOURNEY.md) | The canonical end-to-end demo path, what each step asserts, and how to re-run it |
| [`BUILD_STATE.md`: verification](BUILD_STATE.md#verification-last-full-run) | The recorded results of the last verification runs and what was not verified |

## Deployment

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`: Deployment](ARCHITECTURE.md#12-deployment) | The one-process model, resource guards, the image and secrets |
| [`BUILD_STATE.md`: resource limits](BUILD_STATE.md#resource-limits) and [process stability](BUILD_STATE.md#process-stability) | What bounds the server process and why exactly one `uvicorn` process is used |
| [Repository README: Deployment](../README.md#deployment) | The current Railway deployment |
