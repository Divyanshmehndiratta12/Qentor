/** The address bar for shared experiments. */
import { describe, expect, it } from 'vitest'
import { pathForScreen, screenFromPath, sharedIdFromPath } from './routes'

describe('/shared/<id>', () => {
  const ID = 'ex_0123456789abcdef'

  it('opens the shared screen and yields the id', () => {
    expect(screenFromPath(`/shared/${ID}`)).toBe('shared')
    expect(screenFromPath(`/shared/${ID}/`)).toBe('shared')
    expect(sharedIdFromPath(`/shared/${ID}`)).toBe(ID)
    expect(sharedIdFromPath(`/shared/${ID}/`)).toBe(ID)
  })

  it.each([
    '/shared/',
    '/shared',
    '/shared/ex_0123456789abcde',
    '/shared/ex_0123456789abcdef0',
    '/shared/EX_0123456789ABCDEF',
    '/shared/ex_0123456789abcdeg',
    '/shared/..%2F..%2Fapi',
    '/shared/ex_0123456789abcdef/extra',
    '/shared/ex_0123456789abcdef%0A',
    '/learn',
  ])('%s yields no id', (path) => {
    expect(sharedIdFromPath(path)).toBeNull()
  })

  it('a malformed id still opens the shared screen (which says “not found”), so a bad link is explained rather than showing the Lab', () => {
    expect(screenFromPath('/shared/not-an-id')).toBe('shared')
  })

  it('the bare path maps to the shared screen for pathForScreen only', () => {
    expect(pathForScreen('shared')).toBe('/shared')
  })
})
