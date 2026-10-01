/**
 * axe-core over the rendered screens (jsdom). jsdom has no layout, so the rules that need one are off here (colour contrast, which
 * `contrast.test.ts` covers from the theme, and region/scroll geometry, which the real-browser audit covers): what runs is the
 * structural set: names and labels, roles, headings, duplicate ids, landmarks. A real-Chrome axe run is part of the sprint's
 * verification; this keeps the structural findings from coming back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'

const client = vi.hoisted(() => ({
  listLessons: vi.fn(),
  listChallenges: vi.fn(),
  getGenerationStatus: vi.fn(),
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  traceCircuit: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import App from '@/App'
import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '@/features/learn/store'
import { emptyCircuit, type GateOp } from '@/circuit/types'
import type { Challenge, Lesson } from '@/api'

const CHALLENGE: Challenge = {
  id: 'a',
  lessonId: 'l1',
  title: 'Challenge a',
  goal: 'Goal of a.',
  difficulty: 'beginner',
  successCondition: 'Solved when a.',
  fixedOracle: false,
  constraints: { numQubits: 1, numClbits: 0, allowedGates: ['h', 'x'], maxOps: 6, minGateCounts: {}, anchor: [], anchorName: 'oracle', mustMeasure: [], gateQubits: {} },
  starterCircuit: emptyCircuit(1, 0),
  checks: [{ id: 'state.x', label: 'The state is right' }],
  hints: ['hint one'],
}

const LESSON: Lesson = {
  id: 'l1',
  title: 'First Lesson',
  shortDescription: 'd',
  concept: 'c',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'b' }],
  linkedCircuit: null,
  prerequisiteLessonIds: [],
}

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()
const op = (gate: GateOp['gate'], targets: number[]): GateOp => ({ gate, targets, controls: [], params: [], clbits: [] })

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } },
  })
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('qentor.welcome.dismissed', '1')
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([LESSON])
  client.listChallenges.mockResolvedValue([CHALLENGE])
  client.getGenerationStatus.mockResolvedValue({ available: false, provider: null, model: null, reason: 'No language model is configured on this server.' })
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})
afterEach(cleanup)

describe('axe: structural accessibility of each screen', () => {
  it('the Lab, with a circuit on the canvas, has no violations and one level-one heading', { timeout: 30000 }, async () => {
    useBuildStore.getState().loadCircuit({ ...emptyCircuit(2, 0), ops: [op('h', [0]), op('h', [0])] })
    window.history.replaceState(null, '', '/')
    render(<App />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(await violations()).toEqual([])
  })

  it('the Lab with the Generate code tab open and no model configured has no violations', async () => {
    window.history.replaceState(null, '', '/')
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: 'Generate code' }))
    await waitFor(() => expect(screen.getByTestId('generate-panel')).toBeInTheDocument())
    expect(await violations()).toEqual([])
  })

  for (const [label, path, nav] of [
    ['Learn', '/learn', 'Learn'],
    ['Challenges', '/challenges', 'Challenges'],
    ['Progress', '/progress', 'Progress'],
  ] as const) {
    it(`${label} has no violations`, async () => {
      window.history.replaceState(null, '', path)
      render(<App />)
      const current = within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: nav })
      expect(current.getAttribute('aria-current')).toBe('page')
      expect(await violations()).toEqual([])
    })
  }
})
