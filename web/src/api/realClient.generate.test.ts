/**
 * The generation endpoints from the client's side: what goes out (words, identifiers and the current circuit, never a result or a
 * verdict), how each failure is told apart (unavailable, failed, refused), and that what comes back is parsed through the schema
 * before anything can render it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError, GenerationFailedError, GenerationUnavailableError } from './client'
import { MockApiClient } from './mockClient'
import type { Circuit } from '@/circuit/types'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const BELL: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 2,
  num_clbits: 0,
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

const PROPOSED = {
  status: 'PROPOSED',
  label: 'AI proposal — not yet verified against your intent',
  verification_status: 'UNVERIFIED_AGAINST_INTENT',
  generator: 'anthropic',
  model: 'a-model',
  raw_qasm: 'qubit[2] q; h q[0]; cx q[0], q[1];',
  circuit: BELL,
  canonical_qasm: 'OPENQASM 3.0;\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n',
  circuit_hash: 'abc123',
  summary: 'The proposal uses 2 qubits and 2 operations.',
  explanation: 'It applies H then CX.',
  explanation_source: 'AI',
  explanation_note: null,
  problems: [],
  constraint_notes: [],
}

describe('RealApiClient — AI code generation', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const call = (n = 0) => ({ url: fetchMock.mock.calls[n]![0] as string, init: fetchMock.mock.calls[n]![1] as RequestInit | undefined })
  const body = (n = 0) => JSON.parse(call(n).init!.body as string)

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  describe('getGenerationStatus', () => {
    it('reads /api/generate/status', async () => {
      fetchMock.mockResolvedValueOnce(json({ available: true, provider: 'anthropic', model: 'm', reason: null }))
      expect(await new RealApiClient().getGenerationStatus()).toEqual({ available: true, provider: 'anthropic', model: 'm', reason: null })
      expect(call().url).toMatch(/\/api\/generate\/status$/)
    })

    it('an unconfigured server is an answer (available: false with its reason), not an error', async () => {
      fetchMock.mockResolvedValueOnce(json({ available: false, provider: null, model: null, reason: 'not configured' }))
      expect(await new RealApiClient().getGenerationStatus()).toMatchObject({ available: false, reason: 'not configured' })
    })

    it('a malformed answer is refused, and an unreachable server is an honest unavailable error', async () => {
      fetchMock.mockResolvedValueOnce(json({ available: 'yes' }))
      await expect(new RealApiClient().getGenerationStatus()).rejects.toThrow()
      fetchMock.mockRejectedValueOnce(new TypeError('network down'))
      await expect(new RealApiClient().getGenerationStatus()).rejects.toBeInstanceOf(BackendUnavailableError)
      fetchMock.mockResolvedValueOnce(json({ detail: 'boom' }, 500))
      await expect(new RealApiClient().getGenerationStatus()).rejects.toMatchObject({ status: 500, message: 'boom' })
    })
  })

  describe('generateCircuit', () => {
    it('sends the words, the language and nothing else by default', async () => {
      fetchMock.mockResolvedValueOnce(json(PROPOSED))
      await new RealApiClient().generateCircuit({ prompt: '  Create a Bell state.  ' })
      expect(call().url).toMatch(/\/api\/generate\/circuit$/)
      expect(call().init!.method).toBe('POST')
      expect(body()).toEqual({ prompt: 'Create a Bell state.', language: 'en' })
    })

    it('carries identifiers and the current circuit as context when there are any', async () => {
      fetchMock.mockResolvedValueOnce(json(PROPOSED))
      await new RealApiClient().generateCircuit({ prompt: 'Make it', language: 'hi', lessonId: 'bell-state', sectionId: 's2', challengeId: 'create-bell', circuit: BELL })
      expect(body()).toEqual({ prompt: 'Make it', language: 'hi', lesson_id: 'bell-state', section_id: 's2', challenge_id: 'create-bell', circuit: BELL })
    })

    it('does not send an empty circuit as context', async () => {
      fetchMock.mockResolvedValueOnce(json(PROPOSED))
      await new RealApiClient().generateCircuit({ prompt: 'Make one', circuit: { ...BELL, ops: [] } })
      expect(body()).not.toHaveProperty('circuit')
    })

    it('has no way to send a result, a probability, a verdict or code: the body has only the known keys', async () => {
      fetchMock.mockResolvedValueOnce(json(PROPOSED))
      await new RealApiClient().generateCircuit({
        prompt: 'x y z',
        circuit: BELL,
        // @ts-expect-error — the input type has no such fields; this shows they are dropped even if a caller forces them
        resultId: 'res_1',
        probabilities: { '00': 1 },
        passed: true,
        qasm: 'h q[0];',
      })
      expect(Object.keys(body()).sort()).toEqual(['circuit', 'language', 'prompt'])
    })

    it('maps a PROPOSED answer field by field, with the server\'s label and the unverified status', async () => {
      fetchMock.mockResolvedValueOnce(json(PROPOSED))
      const proposal = await new RealApiClient().generateCircuit({ prompt: 'Create a Bell state.' })
      expect(proposal).toMatchObject({
        status: 'PROPOSED',
        label: 'AI proposal — not yet verified against your intent',
        verificationStatus: 'UNVERIFIED_AGAINST_INTENT',
        generator: 'anthropic',
        model: 'a-model',
        circuitHash: 'abc123',
        explanationSource: 'AI',
        constraintNotes: [],
      })
      expect(proposal.circuit).toEqual(BELL)
      expect(proposal.canonicalQasm).toContain('cx q[0], q[1];')
      expect(Object.keys(proposal)).not.toContain('resultId')
    })

    it('maps a REJECTED answer with its problems and no circuit', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ ...PROPOSED, status: 'REJECTED', circuit: null, canonical_qasm: null, circuit_hash: null, summary: null, explanation: null, explanation_source: null, problems: [{ code: 'QASM_PARSE_ERROR', message: 'unknown gate', line: 4 }] }),
      )
      const proposal = await new RealApiClient().generateCircuit({ prompt: 'Create a Bell state.' })
      expect(proposal).toMatchObject({ status: 'REJECTED', circuit: null, canonicalQasm: null, problems: [{ code: 'QASM_PARSE_ERROR', message: 'unknown gate', line: 4 }] })
    })

    it('503 AI_GENERATION_UNAVAILABLE is "unavailable": nothing to retry', async () => {
      fetchMock.mockResolvedValueOnce(json({ detail: { code: 'AI_GENERATION_UNAVAILABLE', message: 'not configured' } }, 503))
      const error = await new RealApiClient().generateCircuit({ prompt: 'Make a Bell state' }).catch((e) => e)
      expect(error).toBeInstanceOf(GenerationUnavailableError)
      expect(error.message).toBe('not configured')
    })

    it('502 AI_GENERATION_FAILED is "failed": asking again may work', async () => {
      fetchMock.mockResolvedValueOnce(json({ detail: { code: 'AI_GENERATION_FAILED', message: 'try again' } }, 502))
      const error = await new RealApiClient().generateCircuit({ prompt: 'Make a Bell state' }).catch((e) => e)
      expect(error).toBeInstanceOf(GenerationFailedError)
      expect(error).not.toBeInstanceOf(GenerationUnavailableError)
    })

    it('any other refusal keeps its status, and the two special codes on the wrong status are not special', async () => {
      fetchMock.mockResolvedValueOnce(json({ detail: { code: 'CHALLENGE_NOT_FOUND', message: 'no such challenge' } }, 404))
      await expect(new RealApiClient().generateCircuit({ prompt: 'x', challengeId: 'nope' })).rejects.toMatchObject({ status: 404, message: 'no such challenge' })
      fetchMock.mockResolvedValueOnce(json({ detail: { code: 'AI_GENERATION_UNAVAILABLE', message: 'm' } }, 500))
      const error = await new RealApiClient().generateCircuit({ prompt: 'x y z' }).catch((e) => e)
      expect(error).toBeInstanceOf(BackendUnavailableError)
      expect(error).not.toBeInstanceOf(GenerationUnavailableError)
      fetchMock.mockResolvedValueOnce(json({ detail: [{ msg: 'field required' }] }, 422))
      await expect(new RealApiClient().generateCircuit({ prompt: 'x y z' })).rejects.toMatchObject({ status: 422 })
    })

    it('an unreachable server is an honest unavailable error, never a made-up proposal', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('network down'))
      await expect(new RealApiClient().generateCircuit({ prompt: 'x y z' })).rejects.toBeInstanceOf(BackendUnavailableError)
    })

    it('a response that does not match the schema is refused rather than partly shown', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...PROPOSED, status: 'APPROVED' }))
      await expect(new RealApiClient().generateCircuit({ prompt: 'x y z' })).rejects.toThrow()
      fetchMock.mockResolvedValueOnce(json({ ...PROPOSED, circuit: { ...BELL, ops: [{ gate: 'frobnicate', targets: [0] }] } }))
      await expect(new RealApiClient().generateCircuit({ prompt: 'x y z' })).rejects.toThrow()
      fetchMock.mockResolvedValueOnce(json({ ...PROPOSED, explanation_source: 'HUMAN' }))
      await expect(new RealApiClient().generateCircuit({ prompt: 'x y z' })).rejects.toThrow()
    })
  })

  describe('the FIXTURE mock adapter', () => {
    it('says it is unavailable and generates nothing: there is no substitute for a language model', async () => {
      const mock = new MockApiClient()
      expect(await mock.getGenerationStatus()).toMatchObject({ available: false, provider: null, model: null })
      await expect(mock.generateCircuit({ prompt: 'Create a Bell state.' })).rejects.toBeInstanceOf(GenerationUnavailableError)
    })
  })
})
