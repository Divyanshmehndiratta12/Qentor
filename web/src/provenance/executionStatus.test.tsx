/**
 * What the UI says about an execution's status — and, as importantly, what it does not.
 *
 * A plain run is "state checked": the backend ran and returned a well-formed result. It is never
 * "verified", because verification is a verdict about a property of the circuit and only a verifier
 * (the Bell check, the multi-input test, the equivalence check) can give one.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { ExecuteResponseSchema, ExecutionStatusSchema } from './schema'
import type { Provenance } from './QuantumValue'
import { ProvenanceBadge } from './ProvenanceBadge'
import { bellVerdictScope, executionStatusExplanation, executionStatusLabel } from './executionStatus'
import { VerificationStatusBadge } from './VerificationStatusBadge'
import { traceResult, H0, emptyOneQubit } from '@/test/traceFixtures'
import { TraceViewer } from '@/features/build/TraceViewer'
import executionStatusSource from './executionStatus.ts?raw'
import provenanceBadgeSource from './ProvenanceBadge.tsx?raw'
import resultsPanelSource from '@/features/build/ResultsPanel.tsx?raw'

afterEach(cleanup)

const PROVENANCE: Provenance = {
  resultId: 'res_a',
  circuitHash: 'hash_a',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
}

describe('the execution status vocabulary', () => {
  it('is the backend’s: STATE_CHECKED, FAILED, ERROR, and the legacy SUCCEEDED', () => {
    expect([...ExecutionStatusSchema.options].sort()).toEqual(['ERROR', 'FAILED', 'STATE_CHECKED', 'SUCCEEDED'])
  })

  it('no longer accepts VERIFIED as the status of an execution', () => {
    const response = {
      result_id: 'r',
      circuit_hash: 'h',
      backend: 'qiskit-aer',
      backend_version: '1',
      execution_mode: 'shots',
      provenance_class: 'SIMULATION',
      verification_status: 'VERIFIED',
      created_at: 't',
      payload: {},
    }
    expect(ExecuteResponseSchema.safeParse(response).success).toBe(false)
    expect(ExecuteResponseSchema.safeParse({ ...response, verification_status: 'STATE_CHECKED' }).success).toBe(true)
  })
})

describe('every status has a label and an explanation, and none of them says "verified"', () => {
  it.each(ExecutionStatusSchema.options)('%s', (status) => {
    const label = executionStatusLabel(status)
    const explanation = executionStatusExplanation(status)
    expect(label.length).toBeGreaterThan(3)
    expect(explanation.length).toBeGreaterThan(20)
    for (const text of [label, explanation]) {
      expect(text.toLowerCase()).not.toMatch(/verified|correct|equivalent|proven|valid/)
    }
  })

  it('the state-checked explanation says what it does not show', () => {
    expect(executionStatusExplanation('STATE_CHECKED')).toContain('does not show the circuit does what you intend')
    expect(executionStatusLabel('STATE_CHECKED')).toBe('state checked')
  })
})

describe('where an execution status is shown', () => {
  it('the provenance badge tooltip says state checked and what that does not mean', () => {
    render(<ProvenanceBadge provenance={PROVENANCE} />)
    const badge = screen.getByText('Simulated').closest('span[title]') as HTMLElement
    expect(badge.title).toContain('run: STATE_CHECKED (state checked)')
    expect(badge.title).toContain('does not show the circuit does what you intend')
    expect(badge.title).not.toMatch(/verified/i)
  })

  it('the trace viewer labels the row "state check" with the explanation on hover', () => {
    render(<TraceViewer trace={emptyOneQubit()} isLoading={false} error={null} />)
    const term = screen.getByText('state check')
    const value = term.nextElementSibling as HTMLElement
    expect(value.textContent).toBe('STATE_CHECKED')
    expect(value.title).toContain('does not show the circuit does what you intend')
    expect(screen.queryByText('run status')).toBeNull()
  })

  it('a trace of several steps says the same for every step', () => {
    const trace = traceResult({
      numQubits: 1,
      ops: [H0],
      states: [[[1, 0], [0, 0]], [[0.7071067811865476, 0], [0.7071067811865476, 0]]],
    })
    render(<TraceViewer trace={trace} isLoading={false} error={null} />)
    expect(screen.getAllByText('STATE_CHECKED').length).toBeGreaterThan(0)
    expect(screen.queryByText('VERIFIED')).toBeNull()
  })
})

describe('the Bell-state verdict says which property it covers', () => {
  it.each(['VERIFIED', 'FAILED', 'UNVERIFIABLE', 'ERROR'] as const)('%s has a scope sentence', (status) => {
    expect(bellVerdictScope(status).length).toBeGreaterThan(20)
  })

  it('VERIFIED is scoped to the Bell-state pattern and disclaims everything else', () => {
    const scope = bellVerdictScope('VERIFIED')
    expect(scope).toContain('Bell-state pattern only')
    expect(scope).toContain('says nothing else about the circuit')
  })

  it('the badge itself is unchanged: a verifier verdict still reads Verified', () => {
    render(<VerificationStatusBadge status="VERIFIED" />)
    expect(within(document.body).getByText('Verified')).toBeInTheDocument()
  })
})

describe('static guard: nothing presents a plain run as verified', () => {
  it('the copy module never uses the word for an execution', () => {
    // the only "verified" in the module is the Bell verdict scope, which is a property verdict
    const withoutBellScope = executionStatusSource.split('const BELL_SCOPE')[0]
    expect(withoutBellScope.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/verified/i)
  })

  it('the provenance badge and the results panel do not print a raw VERIFIED', () => {
    expect(provenanceBadgeSource).not.toMatch(/'VERIFIED'|"VERIFIED"/)
    expect(resultsPanelSource).not.toMatch(/'VERIFIED'|"VERIFIED"/)
  })
})
