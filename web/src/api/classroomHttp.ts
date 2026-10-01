/**
 * The classroom, sharing and code-input endpoints, as plain functions over `fetch`. `RealApiClient` delegates to these.
 *
 * Every response is parsed through a zod schema before it leaves this file; a structured refusal (`{detail: {code, message}}`) becomes a
 * `ClassroomRejectedError` carrying the server's own code and words, and anything unstructured becomes `BackendUnavailableError`. Nothing
 * here computes a count, a verdict or a result: it sends identifiers and receives what the server recorded.
 */
import type { z } from 'zod'
import { CircuitSchema } from '@/circuit/types'
import {
  ClassDashboardResponseSchema,
  ClassroomErrorDetailSchema,
  CreateClassResponseSchema,
  CreateExperimentResponseSchema,
  DeleteClassResponseSchema,
  JoinClassResponseSchema,
  LeaveClassResponseSchema,
  LearnerEventResponseSchema,
  MyClassResponseSchema,
  ParseCodeRefusalSchema,
  ParseCodeResponseSchema,
  SharedExperimentResponseSchema,
  SyncProgressResponseSchema,
} from '@/provenance/schema'
import { quantumValueFromExecuteResponse } from './executeValue'
import { learnerHeaders, LEARNER_HEADER } from './learnerToken'
import {
  BackendUnavailableError,
  ClassroomRejectedError,
  CodeNotSupportedError,
  type ClassCreated,
  type ClassDashboard,
  type ClassJoined,
  type ClassMembership,
  type ClassSyncResult,
  type CreateExperimentInput,
  type CreatedExperiment,
  type LearnerEventKind,
  type ParsedCode,
  type SavedAnswer,
  type SdkDialect,
  type SharedExperiment,
} from './client'

const INSTRUCTOR_HEADER = 'X-Qentor-Instructor'

interface RequestOptions {
  body?: unknown
  headers?: Record<string, string>
}

async function send(baseUrl: string, method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
  } catch (err) {
    throw new BackendUnavailableError(`could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A refused request: the server's structured `{code, message}` when it sent one, else an unstructured unavailable error. */
async function refusal(res: Response): Promise<Error> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return new BackendUnavailableError(`HTTP ${res.status}`, res.status)
  }
  const detail = (body as { detail?: unknown } | null)?.detail
  const structured = ClassroomErrorDetailSchema.safeParse(detail)
  if (structured.success) return new ClassroomRejectedError(structured.data.code, structured.data.message, res.status)
  if (typeof detail === 'string') return new BackendUnavailableError(detail, res.status)
  // a framework validation error (a list), or anything else: never echoed back as if it were advice
  return new BackendUnavailableError(`the request was not accepted (HTTP ${res.status})`, res.status)
}

async function call<S extends z.ZodType>(baseUrl: string, method: string, path: string, schema: S, options: RequestOptions = {}): Promise<z.infer<S>> {
  const res = await send(baseUrl, method, path, options)
  if (!res.ok) throw await refusal(res)
  return schema.parse(await res.json())
}

const token = (value: string): Record<string, string> => ({ [LEARNER_HEADER]: value })

export async function createClass(baseUrl: string, title?: string): Promise<ClassCreated> {
  const r = await call(baseUrl, 'POST', '/api/classes', CreateClassResponseSchema, { body: title?.trim() ? { title: title.trim() } : {} })
  return { classCode: r.class_code, instructorKey: r.instructor_key, title: r.title, createdAt: r.created_at, notice: r.notice }
}

export async function joinClass(baseUrl: string, classCode: string, learnerToken: string | null): Promise<ClassJoined> {
  const r = await call(baseUrl, 'POST', '/api/classes/join', JoinClassResponseSchema, {
    body: { class_code: classCode },
    headers: learnerToken ? token(learnerToken) : {},
  })
  return { learnerToken: r.learner_token, alias: r.alias, classCode: r.class_code, classTitle: r.class_title, rejoined: r.rejoined, newIdentity: r.new_identity }
}

export async function getMyClass(baseUrl: string, learnerToken: string): Promise<ClassMembership> {
  const r = await call(baseUrl, 'GET', '/api/classes/me', MyClassResponseSchema, { headers: token(learnerToken) })
  return {
    inClass: r.in_class,
    tokenKnown: r.token_known,
    classCode: r.class_code ?? null,
    classTitle: r.class_title ?? null,
    alias: r.alias ?? null,
    joinedAt: r.joined_at ?? null,
  }
}

export async function leaveClass(baseUrl: string, learnerToken: string): Promise<boolean> {
  return (await call(baseUrl, 'POST', '/api/classes/leave', LeaveClassResponseSchema, { headers: token(learnerToken) })).left
}

export async function syncClassProgress(baseUrl: string, learnerToken: string, answers: SavedAnswer[]): Promise<ClassSyncResult> {
  return call(baseUrl, 'POST', '/api/classes/sync-progress', SyncProgressResponseSchema, {
    // Identifiers only, as saved: the server grades each selection itself.
    body: { answers: answers.map((a) => ({ lesson_id: a.lessonId, check_id: a.checkId, selected_option_id: a.selectedOptionId })) },
    headers: token(learnerToken),
  })
}

export async function reportLearnerEvent(
  baseUrl: string,
  learnerToken: string,
  kind: LearnerEventKind,
  subjectId: string,
): Promise<'RECORDED' | 'DUPLICATE'> {
  const r = await call(baseUrl, 'POST', '/api/learner-events', LearnerEventResponseSchema, {
    body: { kind, subject_id: subjectId },
    headers: token(learnerToken),
  })
  return r.status
}

export async function getClassDashboard(baseUrl: string, classCode: string, instructorKey: string): Promise<ClassDashboard> {
  const r = await call(baseUrl, 'GET', `/api/classes/${encodeURIComponent(classCode)}/dashboard`, ClassDashboardResponseSchema, {
    headers: { [INSTRUCTOR_HEADER]: instructorKey },
  })
  return {
    classCode: r.class_info.class_code,
    title: r.class_info.title,
    createdAt: r.class_info.created_at,
    learnersInClass: r.sample.learners_in_class,
    learnersLeft: r.sample.learners_left,
    activeLearners: r.sample.active_learners,
    activeWindowDays: r.sample.active_window_days,
    eventsTotal: r.sample.events_total,
    empty: r.empty,
    dataNote: r.data_note,
    lessons: r.lessons.map((l) => ({
      lessonId: l.lesson_id,
      title: l.title,
      started: l.started,
      completed: l.completed,
      developing: l.developing,
      assessmentAnswered: l.assessment_answered,
      assessmentCorrect: l.assessment_correct,
      checks: l.checks.map((c) => ({ checkId: c.check_id, concept: c.concept, answered: c.answered, correct: c.correct })),
    })),
    challenges: r.challenges.map((c) => ({
      challengeId: c.challenge_id,
      title: c.title,
      lessonId: c.lesson_id,
      started: c.started,
      attemptingLearners: c.attempting_learners,
      attempts: c.attempts,
      solvedLearners: c.solved_learners,
      failedAttempts: c.failed_attempts,
      failurePatterns: c.failure_patterns.map((p) => ({ checkId: p.check_id, label: p.label, count: p.count, learners: p.learners })),
    })),
    misconceptions: r.misconceptions.map((m) => ({
      kind: m.kind,
      category: m.category,
      lessonId: m.lesson_id,
      challengeId: m.challenge_id,
      learnersAffected: m.learners_affected,
      stillIncorrect: m.still_incorrect,
      sampleSize: m.sample_size,
      explanation: m.explanation,
    })),
    recent: r.recent.map((e) => ({
      alias: e.alias,
      kind: e.kind,
      subjectId: e.subject_id,
      subjectLabel: e.subject_label,
      outcome: e.outcome,
      createdAt: e.created_at,
    })),
  }
}

export async function deleteClass(baseUrl: string, classCode: string, instructorKey: string): Promise<{ eventsDeleted: number }> {
  const r = await call(baseUrl, 'DELETE', `/api/classes/${encodeURIComponent(classCode)}`, DeleteClassResponseSchema, {
    headers: { [INSTRUCTOR_HEADER]: instructorKey },
  })
  return { eventsDeleted: r.events_deleted }
}

export async function createExperiment(baseUrl: string, input: CreateExperimentInput): Promise<CreatedExperiment> {
  const body: Record<string, unknown> = { circuit: CircuitSchema.parse(input.circuit) }
  if (input.resultId) body.result_id = input.resultId
  if (input.lessonId) body.lesson_id = input.lessonId
  if (input.challengeId) body.challenge_id = input.challengeId
  if (input.title?.trim()) body.title = input.title.trim()
  const r = await call(baseUrl, 'POST', '/api/experiments', CreateExperimentResponseSchema, { body, headers: learnerHeaders() })
  return { experimentId: r.experiment_id, path: r.path, createdAt: r.created_at }
}

export async function getExperiment(baseUrl: string, experimentId: string): Promise<SharedExperiment> {
  const r = await call(baseUrl, 'GET', `/api/experiments/${encodeURIComponent(experimentId)}`, SharedExperimentResponseSchema)
  return {
    experimentId: r.experiment_id,
    createdAt: r.created_at,
    title: r.title,
    note: r.note,
    circuitHash: r.circuit_hash,
    circuit: r.circuit,
    qasm: r.qasm,
    generator: r.generator,
    code: r.code,
    backend: r.backend,
    mode: r.mode,
    shots: r.shots,
    lesson: r.lesson,
    challenge: r.challenge,
    // the stored record, wrapped exactly as a fresh run is: its numbers are shown only with its provenance
    result: r.result ? quantumValueFromExecuteResponse(r.result) : null,
    resultNote: r.result_note,
  }
}

export async function parseCode(baseUrl: string, dialect: SdkDialect, code: string): Promise<ParsedCode> {
  const res = await send(baseUrl, 'POST', '/api/circuit/parse-code', { body: { dialect, code } })
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.clone().json()
    } catch {
      body = null
    }
    const refused = ParseCodeRefusalSchema.safeParse((body as { detail?: unknown } | null)?.detail)
    if (res.status === 422 && refused.success) {
      throw new CodeNotSupportedError(refused.data.message, refused.data.problems, refused.data.supported, refused.data.label)
    }
    throw await refusal(res)
  }
  const r = ParseCodeResponseSchema.parse(await res.json())
  return { dialect, label: r.label, circuit: r.circuit, circuitHash: r.circuit_hash, canonicalQasm: r.canonical_qasm, notes: r.notes }
}
