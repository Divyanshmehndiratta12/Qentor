/**
 * Classroom state: whether this browser is in a class (as an anonymous learner), and which classes it created (as an instructor).
 *
 * Nothing here decides anything. The class code is validated by the server when joining; the learner token and the instructor key are
 * issued by the server; every count an instructor sees is computed by the server. Joining does not touch the learner's local
 * progress, and leaving removes only the membership: the token is kept so rejoining is the same anonymous learner, and nothing the
 * browser stored about lessons, answers or challenges is deleted.
 */
import { create } from 'zustand'
import { BackendUnavailableError, ClassroomRejectedError, EndpointNotImplementedError, getApiClient } from '@/api'
import { setLearnerTokenSource } from '@/api/learnerToken'
import { emptyClassroom, loadClassroom, saveClassroom, type Membership, type StoredClassroom, type TeachingClass } from './storage'

export type ClassroomBusy = 'idle' | 'joining' | 'leaving' | 'creating'

interface ClassroomState {
  learnerToken: string | null
  membership: Membership | null
  teaching: TeachingClass[]
  /** `device`: remembered in this browser. `session-only`: this browser would not save it. */
  persistence: 'device' | 'session-only'
  /** Whether the server has confirmed the membership since this page loaded. */
  confirmed: boolean
  busy: ClassroomBusy
  /** The last problem, in words a person can act on. Cleared by the next action. */
  error: string | null
  /** Which panel `error` belongs to, so a failed join is not shown under "Teach a class" and the reverse. */
  errorScope: 'join' | 'teach' | null

  /** Join by class code (validated by the server). Resolves with the membership, or `null` when it did not work (see `error`). */
  join: (classCode: string) => Promise<Membership | null>
  /** Leave the class. Local learning data is untouched. */
  leave: () => Promise<boolean>
  /** Create a class and remember its instructor key in this browser. Resolves with the class, or `null` (see `error`). */
  createClass: (title: string) => Promise<TeachingClass | null>
  /** Delete a class on the server (and everything recorded in it), then forget it here. */
  deleteClass: (classCode: string) => Promise<boolean>
  /** Forget a class's key in this browser without deleting the class. */
  forgetClass: (classCode: string) => void
  /** Ask the server where this learner token stands, so the shell shows the truth (a deleted class, for instance). */
  confirmMembership: () => Promise<void>
  clearError: () => void
}

export function classroomMessage(err: unknown): string {
  if (err instanceof ClassroomRejectedError) {
    if (err.code === 'CLASS_NOT_FOUND') return 'No class has that code. Check it with your instructor.'
    if (err.code === 'CLASS_CODE_INVALID') return 'A class code is eight letters and digits, like ABCD-2345.'
    if (err.code === 'RATE_LIMITED') return 'Too many tries in a short time. Wait a moment and try again.'
    return err.message
  }
  if (err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError) return `The classroom server could not be reached: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

const boot = loadClassroom()

function snapshot(state: ClassroomState): StoredClassroom {
  return { learnerToken: state.learnerToken, membership: state.membership, teaching: state.teaching }
}

export const useClassroomStore = create<ClassroomState>((set, get) => ({
  learnerToken: boot.learnerToken,
  membership: boot.membership,
  teaching: boot.teaching,
  persistence: 'device',
  confirmed: false,
  busy: 'idle',
  error: null,
  errorScope: null,

  join: async (classCode) => {
    if (get().busy !== 'idle') return null
    set({ busy: 'joining', error: null, errorScope: null })
    try {
      const joined = await getApiClient().joinClass(classCode, get().learnerToken)
      const membership: Membership = { classCode: joined.classCode, classTitle: joined.classTitle, alias: joined.alias }
      set({ learnerToken: joined.learnerToken, membership, confirmed: true, busy: 'idle' })
      persist()
      return membership
    } catch (err) {
      set({ busy: 'idle', error: classroomMessage(err), errorScope: 'join' })
      return null
    }
  },

  leave: async () => {
    const { learnerToken, membership, busy } = get()
    if (busy !== 'idle' || !learnerToken || !membership) return false
    set({ busy: 'leaving', error: null, errorScope: null })
    try {
      await getApiClient().leaveClass(learnerToken)
    } catch (err) {
      // The server could not confirm: the learner is still shown as in the class, so the page never claims a leave that did not happen.
      set({ busy: 'idle', error: `You are still in the class: ${classroomMessage(err)}`, errorScope: 'join' })
      return false
    }
    set({ membership: null, busy: 'idle' })
    persist()
    return true
  },

  createClass: async (title) => {
    if (get().busy !== 'idle') return null
    set({ busy: 'creating', error: null, errorScope: null })
    try {
      const made = await getApiClient().createClass(title)
      const cls: TeachingClass = { classCode: made.classCode, title: made.title, instructorKey: made.instructorKey, createdAt: made.createdAt }
      set({ teaching: [cls, ...get().teaching.filter((t) => t.classCode !== cls.classCode)].slice(0, 20), busy: 'idle' })
      persist()
      return cls
    } catch (err) {
      set({ busy: 'idle', error: classroomMessage(err), errorScope: 'teach' })
      return null
    }
  },

  deleteClass: async (classCode) => {
    const cls = get().teaching.find((t) => t.classCode === classCode)
    if (!cls) return false
    set({ error: null, errorScope: null })
    try {
      await getApiClient().deleteClass(classCode, cls.instructorKey)
    } catch (err) {
      set({ error: `The class was not deleted: ${classroomMessage(err)}`, errorScope: 'teach' })
      return false
    }
    set({ teaching: get().teaching.filter((t) => t.classCode !== classCode) })
    persist()
    return true
  },

  forgetClass: (classCode) => {
    set({ teaching: get().teaching.filter((t) => t.classCode !== classCode) })
    persist()
  },

  confirmMembership: async () => {
    const { learnerToken, membership } = get()
    if (!learnerToken || !membership) return
    try {
      const me = await getApiClient().getMyClass(learnerToken)
      if (!me.inClass || !me.classCode) {
        // the class was deleted, or this learner left from elsewhere: the shell stops saying otherwise
        set({ membership: null, confirmed: true })
        persist()
        return
      }
      set({ membership: { classCode: me.classCode, classTitle: me.classTitle ?? membership.classTitle, alias: me.alias ?? membership.alias }, confirmed: true })
      persist()
    } catch {
      // Not reachable right now: keep what is remembered, and leave `confirmed` false so nothing treats it as checked.
    }
  },

  clearError: () => set({ error: null, errorScope: null }),
}))

function persist(): void {
  const saved = saveClassroom(snapshot(useClassroomStore.getState()))
  const next = saved ? 'device' : 'session-only'
  if (useClassroomStore.getState().persistence !== next) useClassroomStore.setState({ persistence: next })
}

// The API client reads the token from here. Only a learner who is IN a class sends one; after leaving, nothing identifying is sent.
setLearnerTokenSource(() => {
  const { learnerToken, membership } = useClassroomStore.getState()
  return learnerToken && membership ? learnerToken : null
})

/** Test helper: back to a browser that has never touched the classroom (does not write storage). */
export function resetClassroomForTests(next: StoredClassroom = emptyClassroom()): void {
  useClassroomStore.setState({ ...next, persistence: 'device', confirmed: false, busy: 'idle', error: null, errorScope: null })
}
