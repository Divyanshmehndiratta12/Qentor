/**
 * Honesty about the language model. With no model on the server the Tutor says so in one line ("Generative AI unavailable — grounded
 * guidance remains available."); with a model, or when the server cannot be asked, it claims nothing either way. An answer carries the
 * "AI" avatar only when a model wrote it: a template (or reasoning-engine) answer is Qentor's own wording of the server's facts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ExecutePayload, TutorAnswerResult } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const client = vi.hoisted(() => ({ getGenerationStatus: vi.fn(), askTutor: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { useBuildStore } from '@/features/build/store'
import { useGenerateStore } from '@/features/generate/store'
import { AI_UNAVAILABLE_NOTE } from './AiStatusNote'
import { TutorPanel } from './TutorPanel'

const BUILD0 = useBuildStore.getState()
const GEN0 = useGenerateStore.getState()

const PROVENANCE: Provenance = {
  resultId: 'res_ai_1',
  circuitHash: 'hash_ai_1',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'shots',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-10-01T00:00:00Z',
}
const answer = (over: Partial<TutorAnswerResult>): TutorAnswerResult => ({
  answer: 'ANSWER TEXT',
  resultId: 'res_ai_1',
  circuitHash: 'hash_ai_1',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  usedFallbackTemplate: true,
  facts: [],
  ...over,
})

beforeEach(() => {
  client.getGenerationStatus.mockReset()
  client.askTutor.mockReset()
  useBuildStore.setState(BUILD0, true)
  useGenerateStore.setState(GEN0, true)
})
afterEach(() => {
  cleanup()
  useBuildStore.setState(BUILD0, true)
  useGenerateStore.setState(GEN0, true)
})

describe('the Tutor says when there is no language model', () => {
  it('shows the exact sentence when the server reports generation unavailable', async () => {
    client.getGenerationStatus.mockResolvedValue({ available: false, reason: 'not configured' })
    render(<TutorPanel />)
    const note = await screen.findByTestId('ai-unavailable-note')
    expect(note.textContent).toBe('Generative AI unavailable — grounded guidance remains available.')
    expect(AI_UNAVAILABLE_NOTE).toBe(note.textContent)
  })

  it('shows nothing when a model is configured', async () => {
    client.getGenerationStatus.mockResolvedValue({ available: true, reason: null })
    render(<TutorPanel />)
    await waitFor(() => expect(client.getGenerationStatus).toHaveBeenCalled())
    await act(async () => undefined)
    expect(screen.queryByTestId('ai-unavailable-note')).toBeNull()
  })

  it('shows nothing when the server cannot be asked: unknown is not "unavailable"', async () => {
    client.getGenerationStatus.mockRejectedValue(new Error('network down'))
    render(<TutorPanel />)
    await waitFor(() => expect(client.getGenerationStatus).toHaveBeenCalled())
    await act(async () => undefined)
    expect(screen.queryByTestId('ai-unavailable-note')).toBeNull()
  })

  it('asks the server once, however many panels are mounted', async () => {
    client.getGenerationStatus.mockResolvedValue({ available: false, reason: 'not configured' })
    render(
      <>
        <TutorPanel />
        <TutorPanel landmarkSuffix=" (guide)" />
      </>,
    )
    await screen.findAllByTestId('ai-unavailable-note')
    expect(client.getGenerationStatus).toHaveBeenCalledTimes(1)
  })
})

describe('the avatar does not claim a model wrote a template answer', () => {
  const seed = () => {
    const circuit = { ...emptyCircuit(1, 0), ops: [{ gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] }] }
    useBuildStore.setState({ circuit, result: toQuantumValue<ExecutePayload>({ executionId: 'aer-1', probabilities: { '0': 0.5, '1': 0.5 } }, PROVENANCE) })
  }

  it('a template answer carries Q, a model answer carries AI', async () => {
    client.getGenerationStatus.mockResolvedValue({ available: false, reason: 'x' })
    seed()
    render(<TutorPanel />)
    client.askTutor.mockResolvedValueOnce(answer({ usedFallbackTemplate: true }))
    await act(async () => void (await useBuildStore.getState().askTutor('What does this circuit do?')))
    let avatars = screen.getAllByTestId('tutor-avatar')
    expect(avatars.map((a) => [a.textContent, a.getAttribute('data-generated')])).toEqual([['Q', 'false']])
    client.askTutor.mockResolvedValueOnce(answer({ usedFallbackTemplate: false }))
    await act(async () => void (await useBuildStore.getState().askTutor('And now?')))
    avatars = screen.getAllByTestId('tutor-avatar')
    expect(avatars.map((a) => a.textContent)).toEqual(['Q', 'AI'])
  })
})
