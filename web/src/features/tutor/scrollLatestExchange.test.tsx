/**
 * The Tutor's footer is short, so a new answer must start in view. These pin where the conversation rests after each new turn: the newest
 * question at the top of its own scroll box, never the end of a long answer, never the page, and no scrolling for anything that is not a new
 * turn. jsdom does no layout, so element positions are stubbed from the turns' order (each turn 100 px below the previous one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useBuildStore, type TutorTurn } from '@/features/build/store'
import { TutorPanel } from './TutorPanel'
import { exchangeStartIndex, scrollLatestExchangeIntoView } from './scrollLatestExchange'

describe('exchangeStartIndex', () => {
  it('is the newest learner question, so the question and the start of its answer are what the learner sees', () => {
    expect(exchangeStartIndex([{ role: 'learner' }, { role: 'tutor' }, { role: 'learner' }, { role: 'analysis' }])).toBe(2)
  })
  it('is the newest turn when there is no question, and -1 when there are no turns', () => {
    expect(exchangeStartIndex([{ role: 'tutor' }, { role: 'error' }])).toBe(1)
    expect(exchangeStartIndex([])).toBe(-1)
  })
})

describe('scrollLatestExchangeIntoView', () => {
  const mk = (tops: number[], scrollerTop = 0, scrollTop = 0) => {
    const scroller = document.createElement('div')
    const log = document.createElement('div')
    scroller.appendChild(log)
    const kids = tops.map((top) => {
      const el = document.createElement('p')
      el.getBoundingClientRect = () => ({ top }) as DOMRect
      log.appendChild(el)
      return el
    })
    scroller.getBoundingClientRect = () => ({ top: scrollerTop }) as DOMRect
    scroller.scrollTop = scrollTop
    return { scroller, log, kids }
  }

  it('puts the question at the top of the scroll box, a small gap below the edge', () => {
    const { scroller, log } = mk([0, 100, 200, 300])
    expect(scrollLatestExchangeIntoView(scroller, log, [{ role: 'learner' }, { role: 'tutor' }, { role: 'learner' }, { role: 'analysis' }])).toBe(true)
    expect(scroller.scrollTop).toBe(192)
  })

  it('accounts for where the box is already scrolled to and where the box sits', () => {
    const { scroller, log } = mk([140, 240], 40, 60) // the box is at 40 and already scrolled by 60; the question (turn 0) is at 140
    scrollLatestExchangeIntoView(scroller, log, [{ role: 'learner' }, { role: 'tutor' }])
    expect(scroller.scrollTop).toBe(140 - 40 + 60 - 8)
  })

  it('never scrolls above the top and does nothing when there is no turn', () => {
    const { scroller, log } = mk([2])
    scrollLatestExchangeIntoView(scroller, log, [{ role: 'learner' }])
    expect(scroller.scrollTop).toBe(0)
    expect(scrollLatestExchangeIntoView(scroller, log, [])).toBe(false)
  })
})

describe('TutorPanel scrolls to a new exchange only', () => {
  const learner = (text: string): TutorTurn => ({ role: 'learner', text })
  const error = (message: string): TutorTurn => ({ role: 'error', message })
  const INITIAL = useBuildStore.getState()
  let rectSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    useBuildStore.setState(INITIAL, true)
    // each child of the conversation log sits 100 px below the one before it; the scroll box is at 0
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const parent = this.parentElement
      const top = parent?.getAttribute('role') === 'log' ? [...parent.children].indexOf(this) * 100 : 0
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
  })
  afterEach(() => {
    rectSpy.mockRestore()
    cleanup()
    useBuildStore.setState(INITIAL, true)
  })

  const scroller = (container: HTMLElement) => container.querySelector('[role="log"]')!.parentElement as HTMLElement

  it('a new question and answer bring the question to the top; the page itself is not scrolled', () => {
    const pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const lab = render(<TutorPanel />)
    const box = scroller(lab.container)
    act(() => useBuildStore.setState({ tutorTurns: [learner('first'), error('first answer failed')] }))
    expect(box.scrollTop).toBe(0) // the question is already at the top
    act(() => useBuildStore.setState({ tutorTurns: [learner('first'), error('first answer failed'), learner('second'), error('second answer failed')] }))
    expect(box.scrollTop).toBe(200 - 8)
    expect(pageScroll).not.toHaveBeenCalled()
  })

  it('a turn count that does not grow (a language change, a re-render) does not move the box', () => {
    act(() => useBuildStore.setState({ tutorTurns: [learner('a'), error('x'), learner('b'), error('y')] }))
    const { container } = render(<TutorPanel />)
    const box = scroller(container)
    box.scrollTop = 33
    act(() => useBuildStore.setState({ tutorLanguage: 'hi' }))
    expect(box.scrollTop).toBe(33)
    // the same number of turns in a fresh array (a re-render of the same conversation) is not a new turn either
    act(() => useBuildStore.setState({ tutorTurns: [learner('a'), error('x'), learner('b'), error('y')] }))
    expect(box.scrollTop).toBe(33)
  })

  it('switching to another lesson’s conversation, which has more turns, is not a new turn and does not scroll', () => {
    act(() => useBuildStore.setState({ lessonTutorTurns: { a: [learner('q'), error('x')], b: [learner('1'), error('1'), learner('2'), error('2'), learner('3'), error('3')] } }))
    const view = render(<TutorPanel context={{ kind: 'lesson', lessonId: 'a', sectionId: null }} />)
    const box = scroller(view.container)
    box.scrollTop = 33
    view.rerender(<TutorPanel context={{ kind: 'lesson', lessonId: 'b', sectionId: null }} />)
    expect(box.scrollTop).toBe(33)
    // but a new turn in that conversation does (the stubbed layout does not move with scrolling, so start the box from the top)
    box.scrollTop = 0
    act(() => useBuildStore.setState({ lessonTutorTurns: { a: [], b: [learner('1'), error('1'), learner('2'), error('2'), learner('3'), error('3'), learner('4'), error('4')] } }))
    expect(box.scrollTop).toBe(600 - 8) // the fourth question is the seventh child, 600 px below the top by the stubbed layout
  })

  it('loading a conversation that already has many turns (opening it) does not scroll either', () => {
    act(() => useBuildStore.setState({ tutorTurns: [learner('a'), error('x'), learner('b'), error('y')] }))
    const { container } = render(<TutorPanel />)
    expect(scroller(container).scrollTop).toBe(0)
  })
})
