/**
 * The top bar's responsive contract. jsdom has no layout, so what is pinned is the class contract that produced the phone fix
 * (Run used to sit on top of "Progress" below ~400px; the real-browser audit now measures it at 390px and 320px): below `md` the
 * four destinations wrap onto a row of their own, each with an equal share and a touch-sized height, and from `md` up it is one row.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { TopBar } from '@/features/shell/TopBar'

afterEach(cleanup)

describe('top bar layout contract', () => {
  it('wraps the navigation onto its own full-width row below md and keeps one row from md up', () => {
    render(<TopBar screen="lab" onNavigate={() => {}} />)
    const header = screen.getByRole('banner')
    expect(header.className).toContain('flex-wrap')
    expect(header.className).toContain('md:flex-nowrap')
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav.className).toContain('order-4')
    expect(nav.className).toContain('basis-full')
    expect(nav.className).toContain('md:order-none')
  })

  it('keeps the reading order logo, navigation, then the Lab controls, with Run still a named button', () => {
    render(<TopBar screen="lab" onNavigate={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const run = screen.getByRole('button', { name: 'Run' })
    expect(nav.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Lab', 'Learn', 'Challenges', 'Progress'])
  })

  it('gives each destination a touch-sized height on a phone, and the keyboard hint is not read out', () => {
    render(<TopBar screen="lab" onNavigate={() => {}} />)
    for (const b of within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('button')) {
      expect(b.className).toContain('min-h-9')
      expect(b.className).toContain('flex-1')
    }
    expect(screen.getByRole('button', { name: 'Run' }).querySelector('[aria-hidden="true"]')?.textContent).toBe('⌘↵')
  })

  it('has no Lab controls on the other screens', () => {
    render(<TopBar screen="progress" onNavigate={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
  })
})
