/**
 * Static guard for server-graded assessments: the browser never decides whether a concept-check answer is right.
 *
 * Scans every shipped source file (tests and `src/test/` excluded, comments stripped) and requires that
 *  - nothing names an answer key (`correctOptionId` / `correct_option_id`): the catalog does not carry one;
 *  - a verdict (`isCorrect`) is only ever assigned from what the server returned (`grade.correct`, `answer.correct`) or carried
 *    over unchanged from a saved attempt — never from comparing the learner's selection with anything;
 *  - a selection is never compared with an option id anywhere in the Learn code.
 * Like the other trust scans this is a tripwire, not a proof; it is paired with runtime tests whose server double disagrees
 * with what the client might expect (`store.test.ts`, `progressPersistence.test.tsx`).
 */
import { describe, expect, it } from 'vitest'

const SOURCES = import.meta.glob(['../../**/*.ts', '../../**/*.tsx', '!../../**/*.test.ts', '!../../**/*.test.tsx', '!../../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Vite keys a glob match relative to THIS file for nearby directories ('./store.ts', '../build/store.ts'); make them `src/…`. */
function toSrcPath(key: string): string {
  const out: string[] = []
  for (const part of `src/features/learn/${key}`.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.') out.push(part)
  }
  return out.join('/')
}

const FILES = Object.entries(SOURCES).map(([key, source]) => [toSrcPath(key), code(source)] as const)

describe('shipped source never decides correctness', () => {
  it('actually scanned the real source (guards against a vacuous pass)', () => {
    const names = FILES.map(([name]) => name)
    expect(FILES.length).toBeGreaterThan(80)
    expect(names).toContain('src/features/learn/store.ts')
    expect(names).toContain('src/features/learn/ConceptCheckQuiz.tsx')
    expect(names).toContain('src/api/realClient.ts')
    expect(names.some((n) => n.endsWith('.test.tsx') || n.startsWith('src/test/'))).toBe(false)
  })

  it('no shipped file names an answer key', () => {
    const offenders = FILES.filter(([, source]) => /correct_?option|correctOption|answerKey|answer_key/i.test(source)).map(([name]) => name)
    expect(offenders).toEqual([])
  })

  it('a verdict is assigned only from the server’s answer or carried over from a saved attempt', () => {
    const allowed = new Set(['boolean', 'grade.correct', 'answer.correct', 'attempt.isCorrect'])
    const found: string[] = []
    for (const [name, source] of FILES) {
      for (const match of source.matchAll(/\bisCorrect\s*:\s*([^,\n}]+)/g)) {
        const rhs = match[1]!.trim()
        if (!allowed.has(rhs)) found.push(`${name}: isCorrect: ${rhs}`)
      }
    }
    expect(found).toEqual([])
  })

  it('the server’s verdict is what the store records, in both places a verdict can be set', () => {
    const store = FILES.find(([name]) => name === 'src/features/learn/store.ts')![1]
    expect(store).toMatch(/isCorrect: grade\.correct/)
    expect(store).toMatch(/isCorrect: answer\.correct/)
    expect([...store.matchAll(/isCorrect\s*:/g)]).toHaveLength(2)
  })

  it('no Learn code compares a selection with an option id or with a verdict-shaped value', () => {
    const offenders: string[] = []
    for (const [name, source] of FILES) {
      if (!name.startsWith('src/features/learn/')) continue
      if (/selectedOptionId\s*[!=]==?\s*(?!null|undefined)[\w.'"]/.test(source)) {
        // the only legitimate comparisons: a re-grade answer is applied only to the attempt it was about, a verdict is accepted
        // only if it is about the selection that was sent, and the radio button shows which option is currently picked
        const lines = source.split('\n').filter((l) => /selectedOptionId\s*[!=]==?/.test(l))
        for (const line of lines) {
          const identity = /attempt\.selectedOptionId !== answer\.selectedOptionId|grade\.selectedOptionId !== selectedOptionId/
          const radio = /^\s*checked=\{selectedOptionId === option\.id\}\s*$/
          if (!identity.test(line) && !radio.test(line)) offenders.push(`${name}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the quiz component is given no key and no verdict-deciding helper', () => {
    const quiz = FILES.find(([name]) => name === 'src/features/learn/ConceptCheckQuiz.tsx')![1]
    expect(quiz).not.toMatch(/isCorrect\s*=|correct\s*=|===\s*section\./)
    expect(quiz).toMatch(/submitConceptCheckAnswer\(lessonId, section\.id, selectedOptionId\)/)
  })

  it('the API client never sends a verdict, a key or a score when it asks for grading', () => {
    const client = FILES.find(([name]) => name === 'src/api/realClient.ts')![1]
    expect(client).toMatch(/JSON\.stringify\(\{ selected_option_id: selectedOptionId \}\)/)
    // the request body of the re-grade call: exactly the three saved ids, nothing derived
    const requestItem = /answers: answers\.map\(\(a\) => \(\{([^}]*)\}\)\)/.exec(client)![1]!
    expect(requestItem.trim()).toBe('lesson_id: a.lessonId, check_id: a.checkId, selected_option_id: a.selectedOptionId')
    expect(requestItem).not.toMatch(/correct|explanation|score/)
  })
})
