/**
 * The single place that decides which `ApiClient` implementation the app
 * uses. `VITE_USE_MOCK_API` must be explicitly set to `"true"` — it is unset
 * by default and unset in every production build, so the mock adapter can
 * never activate silently. Components must import `getApiClient` from here,
 * never `RealApiClient`/`MockApiClient` directly, so this stays the only
 * switch.
 */
import type { ApiClient } from './client'
import { RealApiClient } from './realClient'
import { MockApiClient } from './mockClient'

export type {
  ApiClient,
  Backend,
  BlochCoordinates,
  BlochSource,
  ConceptCheckOption,
  ExecutePayload,
  AgreementBackendResult,
  AgreementPairResult,
  AgreementResult,
  CodeFramework,
  CodeViewsResult,
  EquivalenceResult,
  ExecutionMode,
  ExecutionTraceResult,
  LabCapability,
  Lesson,
  LessonConceptCheckSection,
  LessonDifficulty,
  LessonExplanationSection,
  LessonInteractiveLabSection,
  LessonReflectionSection,
  LessonSection,
  MultiInputCaseResult,
  MultiInputCounterexampleResult,
  MultiInputTestCase,
  MultiInputTestResult,
  OptimizationEquivalenceCheckResult,
  OptimizationEquivalenceResult,
  OptimizationResult,
  TraceBlochVector,
  TraceStep,
  TraceTerminalMeasurement,
  TutorAnswerResult,
  TutorFactResult,
  TutorLanguage,
  TutorLessonContext,
  TutorTraceStepContext,
  TutorTraceStepEcho,
  VerificationCheckResult,
  VerifyBellStateResult,
} from './client'
export { BackendUnavailableError, EndpointNotImplementedError, TraceRejectedError } from './client'

let cached: ApiClient | null = null

export function getApiClient(): ApiClient {
  if (cached) return cached

  const useMock = import.meta.env.VITE_USE_MOCK_API === 'true'
  cached = useMock ? new MockApiClient() : new RealApiClient()

  if (useMock) {
    // eslint-disable-next-line no-console
    console.warn(
      '[qentor] VITE_USE_MOCK_API=true — the UI is showing FIXTURE data, not real backend results.',
    )
  }

  return cached
}
