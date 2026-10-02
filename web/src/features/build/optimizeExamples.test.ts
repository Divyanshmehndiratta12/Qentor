/** The web copy of the Optimize examples must be the shared fixture, circuit for circuit and word for word. */
import { describe, expect, it } from 'vitest'
import { CircuitSchema } from '@/circuit/types'
import { OPTIMIZE_EXAMPLES } from './optimizeExamples'

const RAW = import.meta.glob('../../../../fixtures/optimizer_examples.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const FIXTURE = JSON.parse(Object.values(RAW)[0]!) as {
  examples: { id: string; title: string; summary: string; circuit: unknown; expected_status: string }[]
}

describe('the Optimize examples', () => {
  it('are exactly the shared fixture: same ids, titles, words and circuits, in the same order', () => {
    expect(OPTIMIZE_EXAMPLES.map((e) => e.id)).toEqual(FIXTURE.examples.map((e) => e.id))
    for (const [i, example] of OPTIMIZE_EXAMPLES.entries()) {
      const fixture = FIXTURE.examples[i]!
      expect(example.title).toBe(fixture.title)
      expect(example.summary).toBe(fixture.summary)
      expect(example.circuit).toEqual(CircuitSchema.parse(fixture.circuit))
    }
  })

  it('carry no result, verdict or number a run would produce: only circuits and words', () => {
    for (const example of OPTIMIZE_EXAMPLES) {
      expect(Object.keys(example).sort()).toEqual(['circuit', 'id', 'summary', 'title'])
      expect(example.summary).not.toMatch(/\d+\.\d+|\d+\s?%|verified|proved|result id/i)
    }
  })

  it('are valid circuits the Lab can hold', () => {
    for (const example of OPTIMIZE_EXAMPLES) expect(CircuitSchema.safeParse(example.circuit).success).toBe(true)
  })
})
