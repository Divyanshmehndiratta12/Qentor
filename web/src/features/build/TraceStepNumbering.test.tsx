/**
 * Learner-facing trace numbering: "Step 1 of 4", never "Step 0 of 3".
 *
 * The trace data keeps its own ZERO-based indices (`stepIndex`,
 * `operationIndex` are array positions the backend returned, and everything
 * internal — selection, keyboard navigation, keys — still uses them). Only what
 * a learner READS is one-based, and it is one-based everywhere at once, so the
 * counter, the timeline chips, their accessible names, the operation caption
 * and the Bloch sphere's "source step" can never disagree.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ExecutionTraceResult } from '@/api'
import { bellMeasured, emptyOneQubit, hzh, hzhWithBloch } from '@/test/traceFixtures'
import { TraceViewer } from './TraceViewer'
import { displayOperationNumber, displayStepNumber } from './traceFormat'

const chips = () => within(screen.getByRole('group', { name: 'Trace steps' })).getAllByRole('button')
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
const previous = () => fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
const counter = () => screen.getByText(/^Step \d+ of \d+$/).textContent
const renderViewer = (trace: ExecutionTraceResult) => render(<TraceViewer trace={trace} isLoading={false} error={null} />)

afterEach(() => cleanup())

describe('the step counter', () => {
  it('starts at "Step 1 of 4" for a four-step trace (the initial state plus three gates)', () => {
    const trace = hzh()
    expect(trace.steps).toHaveLength(4)
    renderViewer(trace)

    expect(counter()).toBe('Step 1 of 4')
    expect(screen.queryByText(/Step 0/)).not.toBeInTheDocument()
  })

  it('counts 1, 2, 3, 4 going forward and back, always out of the real number of steps', () => {
    renderViewer(hzh())

    const seen = [counter()]
    for (let i = 0; i < 3; i++) {
      next()
      seen.push(counter())
    }
    expect(seen).toEqual(['Step 1 of 4', 'Step 2 of 4', 'Step 3 of 4', 'Step 4 of 4'])

    previous()
    expect(counter()).toBe('Step 3 of 4')
  })

  it('Previous is disabled on Step 1 and Next on the last step', () => {
    renderViewer(hzh())
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled()
    for (let i = 0; i < 3; i++) next()
    expect(counter()).toBe('Step 4 of 4')
    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled()
  })

  it('a trace of only the initial state reads "Step 1 of 1"', () => {
    renderViewer(emptyOneQubit())
    expect(counter()).toBe('Step 1 of 1')
  })

  it('the total is the number of steps in the trace, whatever its length', () => {
    renderViewer(bellMeasured()) // initial + H + CX
    expect(counter()).toBe('Step 1 of 3')
  })

  it('keyboard navigation still lands on the right step: End -> last, Home -> first', () => {
    renderViewer(hzh())
    const group = screen.getByRole('group', { name: 'Trace steps' })

    fireEvent.keyDown(group, { key: 'End' })
    expect(counter()).toBe('Step 4 of 4')
    fireEvent.keyDown(group, { key: 'Home' })
    expect(counter()).toBe('Step 1 of 4')
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(counter()).toBe('Step 2 of 4')
  })

  it('the live region announces the one-based label', () => {
    renderViewer(hzh())
    expect(screen.getByText('Step 1 of 4')).toHaveAttribute('aria-live', 'polite')
  })
})

describe('the timeline chips and their accessible names', () => {
  it('are numbered 1..N with matching accessible names, and the current one is marked', () => {
    renderViewer(hzh())

    expect(chips().map((c) => c.getAttribute('aria-label'))).toEqual([
      'Step 1: initial state',
      'Step 2: H on q0',
      'Step 3: Z on q0',
      'Step 4: H on q0',
    ])
    expect(chips().map((c) => c.textContent)).toEqual(['● 1initial', '2H q0', '3Z q0', '4H q0'])
    expect(chips()[0]).toHaveAttribute('aria-current', 'step')
  })

  it('clicking a chip selects that step, and the counter agrees with the chip you clicked', () => {
    renderViewer(hzh())
    fireEvent.click(screen.getByRole('button', { name: /^Step 3:/ }))

    expect(counter()).toBe('Step 3 of 4')
    expect(screen.getByRole('button', { name: /^Step 3:/ })).toHaveAttribute('aria-current', 'step')
  })

  it('no chip, label or name anywhere in the viewer says "Step 0"', () => {
    const view = renderViewer(hzh())
    for (let i = 0; i < 3; i++) {
      expect(view.container.textContent).not.toMatch(/Step 0\b/)
      expect(chips().every((c) => !/Step 0\b/.test(c.getAttribute('aria-label') ?? ''))).toBe(true)
      next()
    }
  })
})

describe('operation numbers are one-based too', () => {
  it('the caption names the first gate "Operation 1 of your circuit"', () => {
    renderViewer(hzh())
    next() // the first gate
    expect(screen.getByText(/Operation 1 of your circuit/)).toBeInTheDocument()
    next()
    expect(screen.getByText(/Operation 2 of your circuit/)).toBeInTheDocument()
    expect(screen.queryByText(/Operation 0 of your circuit/)).not.toBeInTheDocument()
  })

  it('terminal measurements are listed with one-based operation numbers', () => {
    renderViewer(bellMeasured())
    const section = screen.getByText('Terminal measurements').closest('div')!
    expect(within(section).getByText('op 3: Measure q0 → c0')).toBeInTheDocument()
    expect(within(section).getByText('op 4: Measure q1 → c1')).toBeInTheDocument()
  })
})

describe('the Bloch sphere agrees with the counter', () => {
  it('its "source step" is the same one-based number the counter shows', () => {
    renderViewer(hzhWithBloch())
    const sourceStep = () => screen.getByText('source step', { selector: 'dt' }).nextElementSibling?.textContent

    expect(counter()).toBe('Step 1 of 4')
    expect(sourceStep()).toBe('trace step 1')
    next()
    next()
    expect(counter()).toBe('Step 3 of 4')
    expect(sourceStep()).toBe('trace step 3')
  })
})

describe('the data keeps its zero-based indices', () => {
  it('the trace object handed to the viewer is not renumbered', () => {
    const trace = hzh()
    expect(trace.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3])
    expect(trace.steps.map((s) => s.operationIndex)).toEqual([null, 0, 1, 2])

    renderViewer(trace)
    for (let i = 0; i < 3; i++) next()

    expect(trace.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]) // rendering left them alone
    expect(trace.steps.map((s) => s.operationIndex)).toEqual([null, 0, 1, 2])
  })

  it('the conversion lives in exactly two pure string helpers', () => {
    expect(displayStepNumber(0)).toBe('1')
    expect(displayStepNumber(3)).toBe('4')
    expect(displayOperationNumber(0)).toBe('1')
    expect(typeof displayStepNumber(2)).toBe('string') // a label, never a number to compute with
    expect(typeof displayOperationNumber(2)).toBe('string')
  })
})
