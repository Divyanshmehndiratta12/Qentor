/**
 * Nothing in the web app can run text it was given. Code a learner pastes is sent to the server, which parses it; the browser has no
 * evaluator for it. This pins that by reading the source: no `eval`, no `Function` constructor, no string-form timers, no dynamic
 * `import()` of a computed path, and no raw HTML insertion that could turn pasted or shared text into markup.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(['../../**/*.ts', '../../**/*.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const appSources = Object.entries(sources).filter(([path]) => !path.includes('.test.') && !path.includes('/test/'))

function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g, '""') // string contents are not code
}

describe('no dynamic execution anywhere in the web source', () => {
  it('has sources to scan (the glob works)', () => {
    expect(appSources.length).toBeGreaterThan(100)
    expect(appSources.some(([path]) => path.endsWith('CodeImport.tsx'))).toBe(true)
    expect(appSources.some(([path]) => path.endsWith('classroomHttp.ts'))).toBe(true)
  })

  for (const [name, pattern] of [
    ['eval(', /\beval\s*\(/],
    ['the Function constructor', /\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/],
    ['a string passed to setTimeout/setInterval', /\bset(?:Timeout|Interval)\s*\(\s*['"`]/],
    ['a dynamic import of a computed path', /\bimport\s*\(\s*[^'"`\s)]/],
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['innerHTML assignment', /\.innerHTML\s*=/],
    ['document.write', /document\.write\s*\(/],
  ] as const) {
    it(`uses no ${name}`, () => {
      const offenders = appSources.filter(([, text]) => pattern.test(code(text))).map(([path]) => path)
      expect(offenders).toEqual([])
    })
  }

  it('the checker itself can fail (it sees a planted eval)', () => {
    expect(/\beval\s*\(/.test(code('const x = eval("1")'))).toBe(true)
    expect(/\beval\s*\(/.test(code('// eval(x)\nconst s = "eval(x)"'))).toBe(false)
  })
})
