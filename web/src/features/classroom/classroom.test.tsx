/**
 * The classroom on the learner's and the instructor's side: the store, the events a browser reports, joining and leaving, the
 * indicator in the shell, and the dashboard. The API client is a stand-in for the SERVER: it decides who is in a class and what the
 * counts are, and these tests check that the browser only sends identifiers and capabilities and shows exactly what comes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ClassDashboard, Lesson } from '@/api'

const client = vi.hoisted(() => ({
  joinClass: vi.fn(),
  leaveClass: vi.fn(),
  getMyClass: vi.fn(),
  createClass: vi.fn(),
  deleteClass: vi.fn(),
  getClassDashboard: vi.fn(),
  syncClassProgress: vi.fn(),
  reportLearnerEvent: vi.fn(),
  listLessons: vi.fn(),
  gradeConceptCheck: vi.fn(),
  regradeConceptChecks: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import { ClassroomRejectedError, BackendUnavailableError } from '@/api'
import { learnerHeaders } from '@/api/learnerToken'
import { useLearnStore } from '@/features/learn/store'
import { useChallengeStore } from '@/features/challenges/store'
import { ClassChip } from './ClassChip'
import { ClassroomScreen } from './ClassroomScreen'
import { EMPTY_CLASS_TEXT, InstructorDashboard } from './InstructorDashboard'
import { resetClassroomEventsForTests, reportClassroomEvent } from './events'
import { CLASSROOM_STORAGE_KEY, parseClassroom } from './storage'
import { resetClassroomForTests, useClassroomStore } from './store'
import { syncLocalProgress } from './syncProgress'

const TOKEN = 'ql_' + 'a'.repeat(32)
const KEY = 'qi_' + 'b'.repeat(32)
const JOINED = { learnerToken: TOKEN, alias: 'Learner 4F2A', classCode: 'ABCD-2345', classTitle: 'Period 3', rejoined: false, newIdentity: true }
const IN_CLASS = { learnerToken: TOKEN, membership: { classCode: 'ABCD-2345', classTitle: 'Period 3', alias: 'Learner 4F2A' }, teaching: [] }

const LESSON: Lesson = {
  id: 'les',
  title: 'A lesson',
  shortDescription: 's',
  concept: 'c',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections: [{ type: 'explanation', id: 'e1', title: 'Intro', body: 'b' }],
  linkedCircuit: null,
  prerequisiteLessonIds: [],
}

function resetAll() {
  cleanup()
  localStorage.clear()
  resetClassroomForTests()
  resetClassroomEventsForTests()
  for (const fn of Object.values(client)) fn.mockReset()
  client.reportLearnerEvent.mockResolvedValue('RECORDED')
  client.regradeConceptChecks.mockResolvedValue([])
  client.getMyClass.mockResolvedValue({ inClass: true, tokenKnown: true, classCode: 'ABCD-2345', classTitle: 'Period 3', alias: 'Learner 4F2A', joinedAt: 'j' })
  useLearnStore.setState({ lessons: [LESSON], startedLessonIds: new Set(), lessonProgress: {}, selectedLessonId: null })
}

beforeEach(resetAll)
afterEach(cleanup)

const stored = () => parseClassroom(localStorage.getItem(CLASSROOM_STORAGE_KEY))

describe('the store: joining and leaving', () => {
  it('joining remembers the server’s token and class, in this browser only', async () => {
    client.joinClass.mockResolvedValue(JOINED)
    const membership = await useClassroomStore.getState().join('abcd-2345')
    expect(client.joinClass).toHaveBeenCalledWith('abcd-2345', null)
    expect(membership).toEqual({ classCode: 'ABCD-2345', classTitle: 'Period 3', alias: 'Learner 4F2A' })
    expect(useClassroomStore.getState()).toMatchObject({ learnerToken: TOKEN, membership, confirmed: true, busy: 'idle', error: null })
    expect(stored()).toMatchObject({ learnerToken: TOKEN, membership })
  })

  it('a failed join leaves the browser exactly as it was and says why in the server’s terms', async () => {
    client.joinClass.mockRejectedValue(new ClassroomRejectedError('CLASS_NOT_FOUND', 'No class has that code.', 404))
    expect(await useClassroomStore.getState().join('ZZZZ-9999')).toBeNull()
    const s = useClassroomStore.getState()
    expect(s.membership).toBeNull()
    expect(s.learnerToken).toBeNull()
    expect(s.error).toBe('No class has that code. Check it with your instructor.')
    expect(s.errorScope).toBe('join')
    expect(localStorage.getItem(CLASSROOM_STORAGE_KEY)).toBeNull()
  })

  it.each([
    ['CLASS_CODE_INVALID', 'A class code is eight letters and digits, like ABCD-2345.'],
    ['RATE_LIMITED', 'Too many tries in a short time. Wait a moment and try again.'],
  ])('maps %s to plain words', async (code, words) => {
    client.joinClass.mockRejectedValue(new ClassroomRejectedError(code, 'raw', 422))
    await useClassroomStore.getState().join('x')
    expect(useClassroomStore.getState().error).toBe(words)
  })

  it('an unreachable server is reported as such, never as a joined class', async () => {
    client.joinClass.mockRejectedValue(new BackendUnavailableError('could not reach'))
    expect(await useClassroomStore.getState().join('ABCD-2345')).toBeNull()
    expect(useClassroomStore.getState().membership).toBeNull()
    expect(useClassroomStore.getState().error).toContain('could not be reached')
  })

  it('leaving removes only the membership: the token stays so rejoining is the same learner, and local learning data is untouched', async () => {
    resetClassroomForTests(IN_CLASS)
    const progress = { startedLessonIds: new Set(['les']), lessonProgress: { les: { activeSectionIndex: 0, completedSectionIds: new Set(['e1']), conceptCheckAttempts: {} } } }
    useLearnStore.setState(progress)
    client.leaveClass.mockResolvedValue(true)
    expect(await useClassroomStore.getState().leave()).toBe(true)
    expect(client.leaveClass).toHaveBeenCalledWith(TOKEN)
    expect(useClassroomStore.getState()).toMatchObject({ membership: null, learnerToken: TOKEN })
    expect(useLearnStore.getState().startedLessonIds).toEqual(progress.startedLessonIds)
    expect(useLearnStore.getState().lessonProgress).toEqual(progress.lessonProgress)

    client.joinClass.mockResolvedValue({ ...JOINED, rejoined: true, newIdentity: false })
    await useClassroomStore.getState().join('ABCD-2345')
    expect(client.joinClass).toHaveBeenLastCalledWith('ABCD-2345', TOKEN)
  })

  it('a leave the server could not confirm is not shown as a leave', async () => {
    resetClassroomForTests(IN_CLASS)
    client.leaveClass.mockRejectedValue(new BackendUnavailableError('down'))
    expect(await useClassroomStore.getState().leave()).toBe(false)
    expect(useClassroomStore.getState().membership).not.toBeNull()
    expect(useClassroomStore.getState().error).toContain('You are still in the class')
  })

  it('leave does nothing when not in a class', async () => {
    expect(await useClassroomStore.getState().leave()).toBe(false)
    expect(client.leaveClass).not.toHaveBeenCalled()
  })

  it('a second action while one is in flight is ignored', async () => {
    let resolve!: (v: typeof JOINED) => void
    client.joinClass.mockReturnValue(new Promise((r) => (resolve = r)))
    const first = useClassroomStore.getState().join('ABCD-2345')
    expect(await useClassroomStore.getState().join('ABCD-2345')).toBeNull()
    resolve(JOINED)
    await first
    expect(client.joinClass).toHaveBeenCalledTimes(1)
  })

  it('on load the server is asked where this token stands: a class that no longer exists is no longer shown', async () => {
    resetClassroomForTests(IN_CLASS)
    client.getMyClass.mockResolvedValue({ inClass: false, tokenKnown: true, classCode: null, classTitle: null, alias: null, joinedAt: null })
    await useClassroomStore.getState().confirmMembership()
    expect(useClassroomStore.getState().membership).toBeNull()
    expect(useClassroomStore.getState().confirmed).toBe(true)
    expect(stored().membership).toBeNull()
  })

  it('an unreachable server leaves what is remembered, marked as not confirmed', async () => {
    resetClassroomForTests(IN_CLASS)
    client.getMyClass.mockRejectedValue(new BackendUnavailableError('down'))
    await useClassroomStore.getState().confirmMembership()
    expect(useClassroomStore.getState().membership).not.toBeNull()
    expect(useClassroomStore.getState().confirmed).toBe(false)
  })

  it('confirming does nothing for a browser that is not in a class', async () => {
    await useClassroomStore.getState().confirmMembership()
    expect(client.getMyClass).not.toHaveBeenCalled()
  })

  it('a browser that cannot save says so, and still works for this page load', async () => {
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    try {
      client.joinClass.mockResolvedValue(JOINED)
      await useClassroomStore.getState().join('ABCD-2345')
      expect(useClassroomStore.getState().membership).not.toBeNull()
      expect(useClassroomStore.getState().persistence).toBe('session-only')
    } finally {
      vi.restoreAllMocks()
      Storage.prototype.setItem = real
    }
  })
})

describe('the store: teaching', () => {
  it('creating a class keeps the instructor key in this browser', async () => {
    client.createClass.mockResolvedValue({ classCode: 'WXYZ-6789', instructorKey: KEY, title: 'Mine', createdAt: 'c', notice: 'n' })
    const made = await useClassroomStore.getState().createClass('Mine')
    expect(client.createClass).toHaveBeenCalledWith('Mine')
    expect(made).toEqual({ classCode: 'WXYZ-6789', title: 'Mine', instructorKey: KEY, createdAt: 'c' })
    expect(stored().teaching).toEqual([made])
  })

  it('a failed creation keeps nothing', async () => {
    client.createClass.mockRejectedValue(new ClassroomRejectedError('RATE_LIMITED', 'x', 429))
    expect(await useClassroomStore.getState().createClass('x')).toBeNull()
    expect(useClassroomStore.getState().teaching).toEqual([])
    expect(useClassroomStore.getState().errorScope).toBe('teach')
  })

  it('deleting asks the server with the key, then forgets the class; a refusal keeps it', async () => {
    resetClassroomForTests({ learnerToken: null, membership: null, teaching: [{ classCode: 'WXYZ-6789', title: 'Mine', instructorKey: KEY, createdAt: 'c' }] })
    client.deleteClass.mockRejectedValueOnce(new ClassroomRejectedError('NOT_AUTHORIZED', 'no', 403))
    expect(await useClassroomStore.getState().deleteClass('WXYZ-6789')).toBe(false)
    expect(useClassroomStore.getState().teaching).toHaveLength(1)
    client.deleteClass.mockResolvedValueOnce({ eventsDeleted: 3 })
    expect(await useClassroomStore.getState().deleteClass('WXYZ-6789')).toBe(true)
    expect(client.deleteClass).toHaveBeenLastCalledWith('WXYZ-6789', KEY)
    expect(useClassroomStore.getState().teaching).toEqual([])
  })

  it('forgetting a key does not call the server', () => {
    resetClassroomForTests({ learnerToken: null, membership: null, teaching: [{ classCode: 'WXYZ-6789', title: 'Mine', instructorKey: KEY, createdAt: 'c' }] })
    useClassroomStore.getState().forgetClass('WXYZ-6789')
    expect(useClassroomStore.getState().teaching).toEqual([])
    expect(client.deleteClass).not.toHaveBeenCalled()
  })
})

describe('the learner token header', () => {
  it('is present only while in a class', async () => {
    expect(learnerHeaders()).toEqual({})
    client.joinClass.mockResolvedValue(JOINED)
    await useClassroomStore.getState().join('ABCD-2345')
    expect(learnerHeaders()).toEqual({ 'X-Qentor-Learner': TOKEN })
    client.leaveClass.mockResolvedValue(true)
    await useClassroomStore.getState().leave()
    expect(learnerHeaders()).toEqual({})
  })
})

describe('reporting events', () => {
  it('a browser that is not in a class reports nothing', () => {
    reportClassroomEvent('lesson_started', 'les')
    expect(client.reportLearnerEvent).not.toHaveBeenCalled()
  })

  it('a learner in a class reports a start once, with only a kind and an id', () => {
    resetClassroomForTests(IN_CLASS)
    reportClassroomEvent('lesson_started', 'les')
    reportClassroomEvent('lesson_started', 'les')
    expect(client.reportLearnerEvent).toHaveBeenCalledTimes(1)
    expect(client.reportLearnerEvent).toHaveBeenCalledWith(TOKEN, 'lesson_started', 'les')
  })

  it('a failed delivery is silent and can be tried again; it never throws into the lesson', async () => {
    resetClassroomForTests(IN_CLASS)
    client.reportLearnerEvent.mockRejectedValueOnce(new BackendUnavailableError('down'))
    expect(() => reportClassroomEvent('lesson_completed', 'les')).not.toThrow()
    await waitFor(() => expect(client.reportLearnerEvent).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    reportClassroomEvent('lesson_completed', 'les')
    expect(client.reportLearnerEvent).toHaveBeenCalledTimes(2)
  })

  it('a learner who has left the class (the token is kept) reports nothing', async () => {
    resetClassroomForTests({ ...IN_CLASS, membership: null })
    reportClassroomEvent('lesson_started', 'les')
    useLearnStore.getState().selectLesson('les')
    expect(client.reportLearnerEvent).not.toHaveBeenCalled()
  })

  it('selecting a lesson for the first time reports it started; selecting it again does not', () => {
    resetClassroomForTests(IN_CLASS)
    useLearnStore.getState().selectLesson('les')
    useLearnStore.getState().selectLesson(null)
    useLearnStore.getState().selectLesson('les')
    expect(client.reportLearnerEvent.mock.calls.filter((c) => c[1] === 'lesson_started')).toEqual([[TOKEN, 'lesson_started', 'les']])
  })

  it('finishing the last section reports the lesson completed', () => {
    resetClassroomForTests(IN_CLASS)
    useLearnStore.getState().completeSection('les', 'e1')
    expect(client.reportLearnerEvent).toHaveBeenCalledWith(TOKEN, 'lesson_completed', 'les')
  })

  it('outside a class the same actions report nothing', () => {
    useLearnStore.getState().selectLesson('les')
    useLearnStore.getState().completeSection('les', 'e1')
    expect(client.reportLearnerEvent).not.toHaveBeenCalled()
  })

  it('selecting a challenge reports it started', () => {
    resetClassroomForTests(IN_CLASS)
    useChallengeStore.setState({
      challenges: [{ id: 'ch', title: 'C', starterCircuit: { schema: 'qentor.circuit/1', num_qubits: 1, num_clbits: 0, ops: [] } } as never],
      selectedId: null,
    })
    useChallengeStore.getState().selectChallenge('ch')
    expect(client.reportLearnerEvent).toHaveBeenCalledWith(TOKEN, 'challenge_started', 'ch')
  })
})

describe('bringing earlier progress when joining', () => {
  it('sends the saved selections as identifiers and the lesson ids, and nothing about verdicts', async () => {
    resetClassroomForTests(IN_CLASS)
    useLearnStore.setState({
      startedLessonIds: new Set(['les']),
      lessonProgress: {
        les: {
          activeSectionIndex: 0,
          completedSectionIds: new Set(['e1']),
          conceptCheckAttempts: { chk: { selectedOptionId: 'o2', isCorrect: true, attemptCount: 1, explanation: 'secret verdict' } },
        },
      },
    })
    client.syncClassProgress.mockResolvedValue({ recorded: 1, duplicates: 0, unknown: 0 })
    const summary = await syncLocalProgress()
    expect(client.syncClassProgress).toHaveBeenCalledWith(TOKEN, [{ lessonId: 'les', checkId: 'chk', selectedOptionId: 'o2' }])
    expect(JSON.stringify(client.syncClassProgress.mock.calls)).not.toMatch(/secret verdict|isCorrect|correct"/)
    expect(client.reportLearnerEvent).toHaveBeenCalledWith(TOKEN, 'lesson_started', 'les')
    expect(client.reportLearnerEvent).toHaveBeenCalledWith(TOKEN, 'lesson_completed', 'les')
    expect(summary).toEqual({ answers: { recorded: 1, duplicates: 0, unknown: 0 }, lessonsStarted: 1, lessonsFinished: 1 })
  })

  it('does nothing outside a class, and a failed sync is reported as not counted', async () => {
    expect(await syncLocalProgress()).toEqual({ answers: null, lessonsStarted: 0, lessonsFinished: 0 })
    resetClassroomForTests(IN_CLASS)
    useLearnStore.setState({
      lessonProgress: { les: { activeSectionIndex: 0, completedSectionIds: new Set(), conceptCheckAttempts: { chk: { selectedOptionId: 'o', isCorrect: false, attemptCount: 1 } } } },
    })
    client.syncClassProgress.mockRejectedValue(new BackendUnavailableError('down'))
    expect((await syncLocalProgress()).answers).toBeNull()
  })
})

describe('the Classroom screen: joining', () => {
  it('has a labelled class-code field and a Join class button, disabled until a code is typed', () => {
    render(<ClassroomScreen />)
    const input = screen.getByLabelText('Class code')
    const join = screen.getByRole('button', { name: 'Join class' })
    expect(join).toBeDisabled()
    fireEvent.change(input, { target: { value: 'abcd-2345' } })
    expect(input).toHaveValue('ABCD-2345')
    expect(join).toBeEnabled()
  })

  it('joins, shows the membership and the alias, and says what is shared and what stays local', async () => {
    client.joinClass.mockResolvedValue(JOINED)
    render(<ClassroomScreen />)
    fireEvent.change(screen.getByLabelText('Class code'), { target: { value: 'ABCD-2345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join class' }))
    const membership = await screen.findByTestId('membership')
    expect(membership).toHaveTextContent('Period 3')
    expect(membership).toHaveTextContent('ABCD-2345')
    expect(membership).toHaveTextContent('Learner 4F2A')
    expect(screen.getByTestId('join-panel')).toHaveTextContent(/Your name is never asked for/)
    expect(screen.getByTestId('join-panel')).toHaveTextContent(/leaving the class does not delete any of it/)
    expect(screen.getByRole('button', { name: 'Leave class' })).toBeInTheDocument()
  })

  it('a wrong code shows the server’s refusal in an alert and joins nothing', async () => {
    client.joinClass.mockRejectedValue(new ClassroomRejectedError('CLASS_NOT_FOUND', 'x', 404))
    render(<ClassroomScreen />)
    fireEvent.change(screen.getByLabelText('Class code'), { target: { value: 'ZZZZ-9999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join class' }))
    expect((await screen.findByTestId('join-error')).textContent).toContain('No class has that code')
    expect(screen.getByLabelText('Class code')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByTestId('membership')).toBeNull()
  })

  it('can bring earlier progress along (on by default) and says what was counted', async () => {
    client.joinClass.mockResolvedValue(JOINED)
    client.syncClassProgress.mockResolvedValue({ recorded: 2, duplicates: 0, unknown: 0 })
    useLearnStore.setState({
      startedLessonIds: new Set(['les']),
      lessonProgress: { les: { activeSectionIndex: 0, completedSectionIds: new Set(), conceptCheckAttempts: { c1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } } } },
    })
    render(<ClassroomScreen />)
    expect(screen.getByRole('checkbox')).toBeChecked()
    fireEvent.change(screen.getByLabelText('Class code'), { target: { value: 'ABCD-2345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join class' }))
    const note = await screen.findByTestId('sync-note')
    expect(note).toHaveTextContent('1 lesson started')
    expect(note).toHaveTextContent('2 concept-check answers')
    expect(note).toHaveTextContent('the server graded each itself')
  })

  it('with the box cleared, joining sends no earlier progress at all', async () => {
    client.joinClass.mockResolvedValue(JOINED)
    useLearnStore.setState({
      startedLessonIds: new Set(['les']),
      lessonProgress: { les: { activeSectionIndex: 0, completedSectionIds: new Set(), conceptCheckAttempts: { c1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } } } },
    })
    render(<ClassroomScreen />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Class code'), { target: { value: 'ABCD-2345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join class' }))
    await screen.findByTestId('membership')
    expect(client.syncClassProgress).not.toHaveBeenCalled()
    expect(client.reportLearnerEvent).not.toHaveBeenCalled()
  })

  it('leaving says that local progress is untouched and offers to join again', async () => {
    resetClassroomForTests(IN_CLASS)
    client.leaveClass.mockResolvedValue(true)
    render(<ClassroomScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Leave class' }))
    const note = await screen.findByTestId('left-note')
    expect(note).toHaveTextContent('Your progress in this browser is untouched')
    expect(screen.getByRole('button', { name: 'Join class' })).toBeInTheDocument()
  })

  it('never shows the learner token anywhere on the page', async () => {
    resetClassroomForTests(IN_CLASS)
    render(<ClassroomScreen />)
    expect(document.body.innerHTML).not.toContain(TOKEN)
    expect(document.body.innerHTML).not.toContain(TOKEN.slice(3))
  })

  it('asks for no name, email or other personal detail', () => {
    render(<ClassroomScreen />)
    const labels = screen.getAllByRole('textbox').map((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? '')
    expect(labels).toEqual(['Class code', 'Class name (optional)'])
    expect(document.querySelectorAll('input[type="email"], input[type="password"], input[type="tel"], input[autocomplete*="name"]')).toHaveLength(0)
  })
})

describe('the Classroom screen: teaching', () => {
  it('creating a class shows the code and the one-time key, and says the key is shown once', async () => {
    client.createClass.mockResolvedValue({ classCode: 'WXYZ-6789', instructorKey: KEY, title: 'Period 3', createdAt: 'c', notice: 'n' })
    client.getClassDashboard.mockResolvedValue(emptyDashboard())
    render(<ClassroomScreen />)
    fireEvent.change(screen.getByLabelText('Class name (optional)'), { target: { value: 'Period 3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create class' }))
    const fresh = await screen.findByTestId('fresh-class')
    expect(within(fresh).getByTestId('fresh-code')).toHaveTextContent('WXYZ-6789')
    expect(within(fresh).getByTestId('fresh-key')).toHaveTextContent(KEY)
    expect(fresh).toHaveTextContent(/shown once/)
    expect(client.createClass).toHaveBeenCalledWith('Period 3')
    await waitFor(() => expect(client.getClassDashboard).toHaveBeenCalledWith('WXYZ-6789', KEY))
  })

  it('lists the classes this browser created and opens the dashboard on request', async () => {
    resetClassroomForTests({ learnerToken: null, membership: null, teaching: [{ classCode: 'WXYZ-6789', title: 'Mine', instructorKey: KEY, createdAt: 'c' }] })
    client.getClassDashboard.mockResolvedValue(emptyDashboard())
    render(<ClassroomScreen />)
    expect(screen.queryByTestId('instructor-dashboard')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }))
    expect(await screen.findByTestId('instructor-dashboard')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide dashboard' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('deleting needs a second, explicit step', async () => {
    resetClassroomForTests({ learnerToken: null, membership: null, teaching: [{ classCode: 'WXYZ-6789', title: 'Mine', instructorKey: KEY, createdAt: 'c' }] })
    client.deleteClass.mockResolvedValue({ eventsDeleted: 4 })
    render(<ClassroomScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete class' }))
    expect(client.deleteClass).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByRole('button', { name: 'Yes, delete' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete class' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }))
    await waitFor(() => expect(client.deleteClass).toHaveBeenCalledWith('WXYZ-6789', KEY))
    await waitFor(() => expect(screen.queryByTestId('teaching-list')).toBeNull())
  })

  it('a creation error appears under Teach, not under Join', async () => {
    client.createClass.mockRejectedValue(new ClassroomRejectedError('RATE_LIMITED', 'x', 429))
    render(<ClassroomScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Create class' }))
    expect(await screen.findByTestId('teach-error')).toBeInTheDocument()
    expect(screen.queryByTestId('join-error')).toBeNull()
  })
})

describe('the shell indicator', () => {
  it('is a quiet “Class” link when not in a class', () => {
    const open = vi.fn()
    render(<ClassChip active={false} onOpen={open} />)
    const chip = screen.getByTestId('class-chip')
    expect(chip).toHaveTextContent('Class')
    expect(chip).toHaveAttribute('data-in-class', 'false')
    fireEvent.click(chip)
    expect(open).toHaveBeenCalled()
  })

  it('shows the class code when in a class, and says so to a screen reader', () => {
    resetClassroomForTests(IN_CLASS)
    render(<ClassChip active={false} onOpen={() => undefined} />)
    const chip = screen.getByTestId('class-chip')
    expect(chip).toHaveTextContent('ABCD-2345')
    expect(chip).toHaveAttribute('data-in-class', 'true')
    expect(chip).toHaveAccessibleName('Classroom: you are in class ABCD-2345')
    expect(chip.title).toContain('Learner 4F2A')
  })

  it('goes back to the quiet state after leaving', async () => {
    resetClassroomForTests(IN_CLASS)
    client.leaveClass.mockResolvedValue(true)
    render(<ClassChip active={false} onOpen={() => undefined} />)
    await act(async () => {
      await useClassroomStore.getState().leave()
    })
    expect(screen.getByTestId('class-chip')).toHaveAttribute('data-in-class', 'false')
  })
})

// ------------------------------------------------------------------------------------------------------------- the dashboard

function emptyDashboard(overrides: Partial<ClassDashboard> = {}): ClassDashboard {
  return {
    classCode: 'WXYZ-6789',
    title: 'Mine',
    createdAt: 'c',
    learnersInClass: 0,
    learnersLeft: 0,
    activeLearners: 0,
    activeWindowDays: 7,
    eventsTotal: 0,
    empty: true,
    dataNote: 'Anonymous classroom data. Learners are random tokens shown as aliases.',
    lessons: [],
    challenges: [],
    misconceptions: [],
    recent: [],
    ...overrides,
  }
}

function populated(): ClassDashboard {
  return emptyDashboard({
    learnersInClass: 3,
    learnersLeft: 1,
    activeLearners: 2,
    eventsTotal: 21,
    empty: false,
    lessons: [
      { lessonId: 'a', title: 'Superposition', started: 3, completed: 2, developing: 1, assessmentAnswered: 6, assessmentCorrect: 4, checks: [] },
      { lessonId: 'b', title: 'Untouched lesson', started: 0, completed: 0, developing: 0, assessmentAnswered: 0, assessmentCorrect: 0, checks: [] },
    ],
    challenges: [
      { challengeId: 'c1', title: 'Make a Bell pair', lessonId: 'a', started: 2, attemptingLearners: 2, attempts: 4, solvedLearners: 1, failedAttempts: 3, failurePatterns: [{ checkId: 'k', label: 'Entangled outcome', count: 3, learners: 2 }] },
      { challengeId: 'c2', title: 'Never opened', lessonId: 'a', started: 0, attemptingLearners: 0, attempts: 0, solvedLearners: 0, failedAttempts: 0, failurePatterns: [] },
    ],
    misconceptions: [
      { kind: 'concept', category: 'phase kickback', lessonId: 'a', challengeId: null, learnersAffected: 2, stillIncorrect: 1, sampleSize: 3, explanation: null },
      { kind: 'challenge_check', category: 'Entangled outcome', lessonId: 'a', challengeId: 'c1', learnersAffected: 2, stillIncorrect: null, sampleSize: 2, explanation: 'Applying H to both qubits is not entangling.' },
    ],
    recent: [
      { alias: 'Learner 4F2A', kind: 'challenge_failed', subjectId: 'c1', subjectLabel: 'Make a Bell pair', outcome: 'failed', createdAt: '2026-10-01T12:00:00Z' },
      { alias: 'Learner 91BC', kind: 'joined_class', subjectId: 'class', subjectLabel: 'Class', outcome: null, createdAt: '2026-10-01T11:00:00Z' },
    ],
  })
}

describe('the instructor dashboard', () => {
  const show = () => render(<InstructorDashboard classCode="WXYZ-6789" instructorKey={KEY} />)

  it('sends the instructor key it was given and nothing else about who is asking', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    await screen.findByTestId('instructor-dashboard')
    expect(client.getClassDashboard).toHaveBeenCalledWith('WXYZ-6789', KEY)
  })

  it('an empty class says exactly “No learners have joined this class yet.” and shows no tables or invented figures', async () => {
    client.getClassDashboard.mockResolvedValue(emptyDashboard())
    show()
    const empty = await screen.findByTestId('dashboard-empty')
    expect(EMPTY_CLASS_TEXT).toBe('No learners have joined this class yet.')
    expect(empty.textContent).toContain('No learners have joined this class yet.')
    expect(screen.queryByTestId('lessons-table')).toBeNull()
    expect(screen.queryByTestId('challenges-table')).toBeNull()
    expect(screen.queryByTestId('misconceptions')).toBeNull()
    expect(screen.queryByTestId('recent-activity')).toBeNull()
    expect(screen.getByTestId('stat-learners')).toHaveTextContent('0')
    expect(screen.getByTestId('stat-lessons')).toHaveTextContent('0')
    expect(screen.getByTestId('class-overview')).toHaveTextContent('WXYZ-6789')
  })

  it('shows the overview from the server’s counts: learners, active, completed lessons, solved challenges', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    await screen.findByTestId('instructor-dashboard')
    expect(screen.getByTestId('stat-learners')).toHaveTextContent('3')
    expect(screen.getByTestId('stat-active')).toHaveTextContent('2')
    expect(screen.getByTestId('stat-lessons')).toHaveTextContent('2')
    expect(screen.getByTestId('stat-challenges')).toHaveTextContent('1')
    expect(screen.getByText(/Active in the last 7 days/)).toBeInTheDocument()
    expect(screen.getByText(/1 learner left this class; they are not counted above/)).toBeInTheDocument()
  })

  it('says in words, above each table, how many anonymous learners the counts are out of', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    await screen.findByTestId('lessons-table')
    expect(screen.getByTestId('lessons-sample')).toHaveTextContent('Each count is a number of learners, out of 3 anonymous learners in this class.')
    expect(screen.getByTestId('challenges-sample')).toHaveTextContent('out of 3 anonymous learners in this class')
    expect(screen.getByTestId('challenges-sample')).toHaveTextContent('the Attempts column counts attempts')
  })

  it('the sample line uses the singular for one learner', async () => {
    client.getClassDashboard.mockResolvedValue({ ...populated(), learnersInClass: 1 })
    show()
    await screen.findByTestId('lessons-table')
    expect(screen.getByTestId('lessons-sample')).toHaveTextContent('out of 1 anonymous learner in this class.')
  })

  it('an empty class shows no table and so no sample line, only the empty state', async () => {
    client.getClassDashboard.mockResolvedValue(emptyDashboard())
    show()
    await screen.findByTestId('dashboard-empty')
    expect(screen.queryByTestId('lessons-sample')).toBeNull()
  })

  it('lists only lessons and challenges that have activity, with the sample next to every figure', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    const lessons = await screen.findByTestId('lessons-table')
    expect(within(lessons).getByText('Superposition')).toBeInTheDocument()
    expect(within(lessons).queryByText('Untouched lesson')).toBeNull()
    const row = within(lessons).getByText('Superposition').closest('tr')!
    expect(row).toHaveTextContent('3')
    expect(row).toHaveTextContent('4 of 6')
    const challenges = screen.getByTestId('challenges-table')
    expect(within(challenges).getByText('Make a Bell pair')).toBeInTheDocument()
    expect(within(challenges).queryByText('Never opened')).toBeNull()
    expect(challenges).toHaveTextContent('Entangled outcome: 3 attempts (2 learners)')
  })

  it('shows misconceptions with category, lesson, how many learners out of how many, and the authored explanation', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    const list = await screen.findByTestId('misconceptions')
    expect(list).toHaveTextContent('phase kickback')
    expect(list).toHaveTextContent('2 of 3 learners affected; 1 still incorrect on their latest answer')
    expect(list).toHaveTextContent('Concept check · Superposition')
    expect(list).toHaveTextContent('2 of 2 learners affected')
    expect(list).toHaveTextContent('Applying H to both qubits is not entangling.')
  })

  it('shows recent activity by alias, event and time, never a name', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    const recent = await screen.findByTestId('recent-activity')
    const items = within(recent).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Learner 4F2A')
    expect(items[0]).toHaveTextContent('tried a challenge (not yet solved): Make a Bell pair (failed)')
    expect(items[1]).toHaveTextContent('Learner 91BC joined the class')
    expect(items[1]!.textContent).toMatch(/Learner 91BC joined the class/) // a space between alias and event, for a screen reader
    expect(items[0]!.querySelector('time')).toHaveAttribute('datetime', '2026-10-01T12:00:00Z')
  })

  it('labels the data as anonymous, and the tables have captions and column headers for assistive technology', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    expect((await screen.findByTestId('dashboard-data-note')).textContent).toContain('Anonymous classroom data')
    const table = screen.getByTestId('lessons-table')
    expect(table.querySelector('caption')).not.toBeNull()
    expect(table.querySelectorAll('th[scope="col"]').length).toBeGreaterThan(3)
    expect(table.querySelectorAll('th[scope="row"]').length).toBe(1)
  })

  it('a table that scrolls sideways on a phone is a named, keyboard-focusable region', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    const lessons = (await screen.findByTestId('lessons-table')).parentElement!
    const challenges = screen.getByTestId('challenges-table').parentElement!
    for (const box of [lessons, challenges]) {
      expect(box).toHaveAttribute('role', 'region')
      expect(box).toHaveAttribute('tabindex', '0')
      expect(box.getAttribute('aria-label')).toMatch(/scrollable/)
      expect(box.className).toContain('overflow-x-auto')
    }
  })

  it('a refused key says so and offers no retry that could be used to guess', async () => {
    client.getClassDashboard.mockRejectedValue(new ClassroomRejectedError('NOT_AUTHORIZED', 'x', 403))
    show()
    const alert = await screen.findByTestId('dashboard-error')
    expect(alert).toHaveTextContent('did not accept this instructor key')
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('an unreachable server offers a retry, and shows no numbers in the meantime', async () => {
    client.getClassDashboard.mockRejectedValueOnce(new BackendUnavailableError('down'))
    client.getClassDashboard.mockResolvedValueOnce(populated())
    show()
    const alert = await screen.findByTestId('dashboard-error')
    expect(screen.queryByTestId('class-overview')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('instructor-dashboard')).toBeInTheDocument()
  })

  it('Refresh asks the server again', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    await screen.findByTestId('instructor-dashboard')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(client.getClassDashboard).toHaveBeenCalledTimes(2))
  })

  it('never renders anything that looks like a token or a key', async () => {
    client.getClassDashboard.mockResolvedValue(populated())
    show()
    await screen.findByTestId('instructor-dashboard')
    expect(document.body.innerHTML).not.toMatch(/ql_[A-Za-z0-9_-]{20}/)
    expect(document.body.innerHTML).not.toMatch(/qi_[A-Za-z0-9_-]{20}/)
  })
})
