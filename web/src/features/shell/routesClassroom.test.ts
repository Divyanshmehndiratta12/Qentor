/** The address bar for the Classroom screen. */
import { describe, expect, it } from 'vitest'
import { pathForScreen, screenFromPath } from './routes'

describe('/classroom', () => {
  it('opens the Classroom screen, with or without a trailing slash', () => {
    expect(screenFromPath('/classroom')).toBe('classroom')
    expect(screenFromPath('/classroom/')).toBe('classroom')
    expect(pathForScreen('classroom')).toBe('/classroom')
  })

  it('does not capture a longer path', () => {
    expect(screenFromPath('/classroom/x')).toBe('lab')
    expect(screenFromPath('/classrooms')).toBe('lab')
  })
})

describe('the existing screens are unchanged', () => {
  it.each([
    ['/', 'lab'],
    ['/learn', 'learn'],
    ['/progress', 'progress'],
    ['/challenges', 'challenges'],
    ['/challenges/some-id', 'challenges'],
    ['/nope', 'lab'],
  ])('%s -> %s', (path, screen) => {
    expect(screenFromPath(path)).toBe(screen)
  })
})
