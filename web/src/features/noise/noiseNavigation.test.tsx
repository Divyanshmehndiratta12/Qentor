/**
 * How a learner gets to the Noise Lab: the top-bar item, the address bar (/noise, Back and Forward), and the lesson whose lab is the comparison
 * ("Open in Noise Lab" puts the lesson's circuit on the Lab's one canvas and opens the screen). The real lesson catalog is used for the lesson.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Lesson } from '@/api'
import { RealApiClient } from '@/api/realClient'

const client = vi.hoisted(() => ({
  listLessons: vi.fn(),
  listChallenges: vi.fn(),
  listNoiseModels: vi.fn(),
  compareNoise: vi.fn(),
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  traceCircuit: vi.fn(),
  getGenerationStatus: vi.fn(),
  regradeConceptChecks: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import App from '@/App'
import { LessonPlayer } from '@/features/learn/LessonPlayer'
import { useLearnStore } from '@/features/learn/store'
import { useBuildStore } from '@/features/build/store'
import { pathForScreen, screenFromPath } from '@/features/shell/routes'
import { parseCatalog } from '@/test/noiseFixtures'
import { useNoiseStore } from './store'

const RAW = import.meta.glob('../../../../fixtures/catalog/public_catalog.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const WIRE = JSON.parse(Object.values(RAW)[0]!)

let LESSONS: Lesson[] = []
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(WIRE.lessons), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  LESSONS = await new RealApiClient().listLessons()
})
afterAll(() => vi.unstubAllGlobals())

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()
const INITIAL_NOISE = useNoiseStore.getState()

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('qentor.welcome.dismissed.v1', '1')
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([])
  client.listChallenges.mockResolvedValue([])
  client.regradeConceptChecks.mockResolvedValue([])
  client.getGenerationStatus.mockResolvedValue({ available: false, provider: null, model: null, reason: 'none' })
  client.listNoiseModels.mockResolvedValue(parseCatalog())
  client.executeCircuit.mockReturnValue(new Promise(() => {}))
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
  useNoiseStore.setState(INITIAL_NOISE, true)
})
afterEach(cleanup)

const nav = () => within(screen.getByRole('navigation', { name: 'Primary' }))
const current = () => nav().getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page')?.textContent

describe('the address', () => {
  it('maps /noise to the Noise Lab and back', () => {
    expect(screenFromPath('/noise')).toBe('noise')
    expect(screenFromPath('/noise/')).toBe('noise')
    expect(pathForScreen('noise')).toBe('/noise')
    expect(screenFromPath('/')).toBe('lab')
  })

  it('a direct visit to /noise opens the Noise Lab', async () => {
    window.history.replaceState(null, '', '/noise')
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Noise Lab' })).toBeInTheDocument()
    expect(current()).toBe('Noise Lab')
    expect(await screen.findByLabelText('Noise model')).toBeInTheDocument()
  })

  it('the top-bar item opens it, updates the path, and Back returns to the Lab', async () => {
    render(<App />)
    expect(current()).toBe('Lab')
    fireEvent.click(nav().getByRole('button', { name: 'Noise Lab' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Noise Lab' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/noise')
    expect(current()).toBe('Noise Lab')
    act(() => {
      window.history.back()
    })
    await waitFor(() => expect(current()).toBe('Lab'))
    expect(screen.queryByRole('heading', { level: 1, name: 'Noise Lab' })).not.toBeInTheDocument()
  })

  it('focus moves into the Noise Lab’s content when it opens', async () => {
    render(<App />)
    fireEvent.click(nav().getByRole('button', { name: 'Noise Lab' }))
    await screen.findByRole('heading', { level: 1, name: 'Noise Lab' })
    expect(document.activeElement).toBe(document.getElementById('main-content'))
  })

  it('is reachable without finishing any lesson or challenge: nothing gates it', async () => {
    render(<App />)
    const item = nav().getByRole('button', { name: 'Noise Lab' })
    expect(item).toBeEnabled()
    expect(item).not.toHaveAttribute('aria-disabled')
  })

  it('has exactly one main landmark and the skip link still points at it', async () => {
    window.history.replaceState(null, '', '/noise')
    render(<App />)
    await screen.findByLabelText('Noise model')
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(document.querySelector('a[href="#main-content"]')).toBeInTheDocument()
  })

  it('the Lab’s circuit is the Noise Lab’s circuit: an edit made in one is there in the other', async () => {
    render(<App />)
    act(() => useBuildStore.getState().loadCircuit({ schema: 'qentor.circuit/1', num_qubits: 3, num_clbits: 3, ops: [] }))
    fireEvent.click(nav().getByRole('button', { name: 'Noise Lab' }))
    await screen.findByRole('heading', { level: 1, name: 'Noise Lab' })
    expect(within(screen.getByRole('group', { name: 'Circuit editor' })).getAllByRole('group', { name: /^Qubit \d/ })).toHaveLength(3)
  })
})

describe('the lesson that opens it', () => {
  const noise = () => LESSONS.find((l) => l.id === 'quantum-noise')!
  const labIndex = () => noise().sections.findIndex((s) => s.type === 'interactive_lab')

  it('is in the real catalog with a noise lab, a linked Bell circuit and prerequisites that are guidance only', () => {
    expect(noise()).toBeDefined()
    const lab = noise().sections[labIndex()]!
    expect(lab).toMatchObject({ type: 'interactive_lab', capability: 'noise_compare' })
    expect(noise().linkedCircuit!.ops.map((o) => o.gate)).toEqual(['h', 'cx', 'measure', 'measure'])
    expect(noise().prerequisiteLessonIds).toEqual(['bell-state'])
  })

  it('its lab section says "Open in Noise Lab" and hands the lesson’s circuit to the Noise Lab, not the Lab', () => {
    useLearnStore.setState({ ...INITIAL_LEARN, lessons: LESSONS, selectedLessonId: 'quantum-noise' })
    useLearnStore.getState().setActiveSectionIndex('quantum-noise', labIndex())
    const onOpenLab = vi.fn()
    const onOpenNoiseLab = vi.fn()
    render(<LessonPlayer lesson={noise()} onOpenLab={onOpenLab} onOpenNoiseLab={onOpenNoiseLab} />)
    expect(screen.queryByRole('button', { name: 'Open in Lab' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Noise Lab' }))
    expect(onOpenNoiseLab).toHaveBeenCalledWith(noise().linkedCircuit)
    expect(onOpenLab).not.toHaveBeenCalled()
    expect(screen.getByText(/the noise is simulated — nothing is computed here/)).toBeInTheDocument()
  })

  it('without a Noise Lab handler it falls back to the ordinary Lab button', () => {
    useLearnStore.setState({ ...INITIAL_LEARN, lessons: LESSONS, selectedLessonId: 'quantum-noise' })
    useLearnStore.getState().setActiveSectionIndex('quantum-noise', labIndex())
    const onOpenLab = vi.fn()
    render(<LessonPlayer lesson={noise()} onOpenLab={onOpenLab} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))
    expect(onOpenLab).toHaveBeenCalledWith(noise().linkedCircuit)
  })

  it('other lessons’ labs are unchanged: they still open the Lab', () => {
    const bell = LESSONS.find((l) => l.id === 'bell-state')!
    const index = bell.sections.findIndex((s) => s.type === 'interactive_lab')
    useLearnStore.setState({ ...INITIAL_LEARN, lessons: LESSONS, selectedLessonId: 'bell-state' })
    useLearnStore.getState().setActiveSectionIndex('bell-state', index)
    const onOpenLab = vi.fn()
    const onOpenNoiseLab = vi.fn()
    render(<LessonPlayer lesson={bell} onOpenLab={onOpenLab} onOpenNoiseLab={onOpenNoiseLab} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))
    expect(onOpenLab).toHaveBeenCalledTimes(1)
    expect(onOpenNoiseLab).not.toHaveBeenCalled()
  })
})
