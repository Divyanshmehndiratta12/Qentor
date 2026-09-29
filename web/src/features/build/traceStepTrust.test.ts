/**
 * Static trust checks on the step-aware tutor's frontend: the step identity is
 * COPIED from the backend's trace, never computed. No quantum arithmetic, no
 * Bloch derivation, no statevector access, no lesson text.
 */
import { describe, expect, it } from 'vitest'
import stepContext from './traceStepContext.ts?raw'
import guideContext from '@/features/guide/guideContext.ts?raw'
import tutorContext from '@/features/tutor/tutorContext.ts?raw'

const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('trace-step identity is copied, not computed', () => {
  const body = code(stepContext)

  it('reads no statevector, amplitude, probability, counts or Bloch value', () => {
    expect(body).not.toMatch(/statevector|amplitude|probabilit|counts|bloch/i)
  })

  it('does no arithmetic beyond stepping back one index (no Math.*, no **, no products)', () => {
    expect(body).not.toMatch(/Math\.|\*\*| \* |sqrt|hypot|atan|acos/)
    expect(body.match(/[-+]\s*1\b/g) ?? []).toEqual(['- 1'])
  })

  it('does not infer anything from a gate name', () => {
    expect(body).not.toMatch(/gate\s*(===|==|!==|!=)|switch\s*\(/)
  })

  it('imports types only (no runtime dependency, so it cannot call a simulator)', () => {
    const imports = body.match(/^import .*$/gm) ?? []
    expect(imports).toEqual(["import type { ExecutionTraceResult, TutorTraceStepContext } from '@/api'"])
  })
})

describe('the Guide and tutor contexts add labels, not values', () => {
  it('the step starter is a fixed string with no quantum content', () => {
    expect(tutorContext).toContain("TRACE_STEP_QUESTION = 'What changed in this step?'")
  })

  it('the Guide describes the selected step with counts and an operation label only', () => {
    const body = code(guideContext)
    expect(body).not.toMatch(/statevector|amplitude|probabilit|bloch|coordinates/i)
    expect(body).toContain('describeOperation(step.operation)')
  })
})
