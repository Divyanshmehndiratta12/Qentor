/**
 * Static guard for the Guide's trust boundary. The Guide is an ENTRY POINT to
 * the existing tutor: it must not call an LLM or any API itself, must not
 * compute anything quantum, and must not load anything from outside the app.
 * Scans every Guide source file (as raw text, comments stripped) for the
 * imports and calls that would break that. A practical tripwire, paired with
 * the behavioural tests (mounting makes no API call; a quick action sends only
 * the fixed question through the existing `askTutor`).
 */
import { describe, expect, it } from 'vitest'
import characterSource from './GuideCharacter.tsx?raw'
import contextSource from './guideContext.ts?raw'
import launcherSource from './GuideLauncher.tsx?raw'
import panelSource from './GuidePanel.tsx?raw'
import motionSource from './usePrefersReducedMotion.ts?raw'
import motionRulesSource from './qubiMotion.ts?raw'
import roamingSource from './useQubiRoaming.ts?raw'
import tutorPanelSource from '@/features/tutor/TutorPanel.tsx?raw'
import tutorContextSource from '@/features/tutor/tutorContext.ts?raw'

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FILES: Array<[string, string]> = [
  ['GuideCharacter.tsx', code(characterSource)],
  ['guideContext.ts', code(contextSource)],
  ['GuideLauncher.tsx', code(launcherSource)],
  ['GuidePanel.tsx', code(panelSource)],
  ['usePrefersReducedMotion.ts', code(motionSource)],
  ['qubiMotion.ts', code(motionRulesSource)],
  ['useQubiRoaming.ts', code(roamingSource)],
]

const importsOf = (source: string) => [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)

/** Imports that survive compilation: `import type ...` is erased, so it can
 * bring in a shape but never any behaviour. */
const valueImportsOf = (source: string) =>
  [...source.matchAll(/import\s+(?!type\b)[^;'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)

describe('Guide source: an entry point, not a second tutor', () => {
  it('actually scanned real source (guards against a vacuous pass)', () => {
    for (const [name, source] of FILES) expect(source.length, name).toBeGreaterThan(150)
    expect(FILES[3]![1]).toContain('askTutor')
  })

  it.each(FILES)('%s never imports the API layer or any client — the store’s askTutor is the only route to the tutor', (_name, source) => {
    // Only a TYPE import (`import type { TutorLessonContext } from '@/api'`) is
    // allowed: it is erased at build time and cannot call anything.
    const bad = valueImportsOf(source).filter((s) => /(^|\/)api(\/|$)|realClient|mockClient|client/i.test(s))
    expect(bad).toEqual([])
  })

  it('the value-import detector really sees value imports and ignores type imports', () => {
    expect(valueImportsOf("import { getApiClient } from '@/api'")).toEqual(['@/api'])
    expect(valueImportsOf("import { type X, getApiClient } from '@/api'")).toEqual(['@/api'])
    expect(valueImportsOf("import type { X } from '@/api'\nimport { y } from './y'")).toEqual(['./y'])
  })

  it.each(FILES)('%s makes no network call of its own', (_name, source) => {
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.sendBeacon/)
    expect(source).not.toMatch(/\baxios\b|\bky\b/)
  })

  it.each(FILES)('%s mentions no LLM provider or SDK', (_name, source) => {
    expect(source).not.toMatch(/anthropic|openai|gemini|claude|gpt|langchain|llm/i)
    expect(source).not.toMatch(/api[-_ ]?key|apikey|x-api-key|authorization/i)
  })

  it.each(FILES)('%s imports no third-party package except react', (_name, source) => {
    const packages = importsOf(source).filter((s) => !s.startsWith('.') && !s.startsWith('@/'))
    expect(packages.filter((s) => s !== 'react')).toEqual([])
  })

  it.each(FILES)('%s does no quantum computation and reads no quantum values', (_name, source) => {
    // Only the movement files do arithmetic, and only screen geometry: clamping, rounding, distance, a random rest. No trigonometry, no exponentials.
    const motion = _name === 'qubiMotion.ts' || _name === 'useQubiRoaming.ts'
    const maths = [...source.matchAll(/\bMath\.(\w+)/g)].map((m) => m[1]!)
    if (motion) expect(maths.filter((m) => !['min', 'max', 'abs', 'round', 'hypot', 'random'].includes(m))).toEqual([])
    else expect(maths).toEqual([])
    expect(source).not.toMatch(/statevector|amplitude|probabilit|bloch|fidelity|density/i)
    expect(source).not.toMatch(/\bcounts\b|\.counts|\.probabilities/)
  })

  it('the panel sends a question ONLY as askTutor(question) or askTutor(question, context.lessonRequest) — a fixed string plus lesson IDS', () => {
    const calls = [...FILES[3]![1].matchAll(/askTutor\(([^)]*)\)/g)].map((m) => m[1])
    expect(calls.sort()).toEqual(['question', 'question, context.lessonRequest'])
  })

  it('the panel reuses the existing TutorPanel and defines no chat input of its own', () => {
    const panel = FILES[3]![1]
    expect(importsOf(panel)).toContain('@/features/tutor/TutorPanel')
    expect(panel).toMatch(/<TutorPanel\s+showStarters=\{false\}/)
    expect(panel).not.toMatch(/<input\b|<textarea\b/)
    expect(panel).not.toMatch(/useState/) // no local conversation/language state
  })

  it('the Guide never reads lesson text or quiz answers — only ids and titles, from the Learn store', () => {
    for (const [name, source] of FILES) {
      expect(source.replace(/document\.body/g, ''), name).not.toMatch(/\.body\b|\.instructions\b|\.prompt\b|\.explanation\b|correctOptionId|correct_option|learningObjectives|shortDescription/)
    }
    const context = FILES[1]![1]
    expect(context).toMatch(/section\?\.id/)
    expect(context).toMatch(/section\?\.title/)
  })

  it('reads context from the existing stores and writes to neither', () => {
    const context = FILES[1]![1]
    expect(importsOf(context)).toEqual([
      '@/api',
      '@/features/build/store',
      '@/features/learn/store',
      '@/features/tutor/tutorContext',
      '@/features/build/traceFormat',
    ])
    expect(valueImportsOf(context)).toEqual([
      '@/features/build/store',
      '@/features/learn/store',
      '@/features/tutor/tutorContext',
      '@/features/build/traceFormat',
    ])
    expect(context).not.toMatch(/\.setState\(|\bset\(/)
    expect(FILES[3]![1]).not.toMatch(/\.setState\(|setTutorLanguage|selectLesson|loadCircuit|runExecution|runTrace/)
  })

  it('the launcher touches no store at all (it is only a button)', () => {
    expect(importsOf(FILES[2]![1]).filter((s) => /store/.test(s))).toEqual([])
  })

  it('randomness only ever chooses where Qubi rests: one injectable default in the roaming hook, none anywhere else', () => {
    for (const [name, source] of FILES) {
      expect(source, name).not.toMatch(/crypto|getRandomValues/i)
      if (name === 'useQubiRoaming.ts') continue
      expect(source, name).not.toMatch(/Math\.random/)
    }
    // The movement rules are pure functions of an injected `rng`; the hook's only source is the default parameter.
    const hook = FILES.find(([name]) => name === 'useQubiRoaming.ts')![1]
    const rules = FILES.find(([name]) => name === 'qubiMotion.ts')![1]
    expect([...hook.matchAll(/Math\.random/g)]).toHaveLength(1)
    expect(hook).toMatch(/rng = Math\.random/)
    expect(rules).toMatch(/rng: \(\) => number/)
  })

  it('the character is inline SVG: no image file, no external URL, no remote font', () => {
    const svg = FILES[0]![1]
    expect(svg).not.toMatch(/https?:\/\//i)
    expect(svg).not.toMatch(/<img\b|<image\b|foreignObject|xlink:href|\bhref=/i)
    expect(svg).not.toMatch(/url\((?!#)/) // gradients only, by local id
    expect(svg).not.toMatch(/\.(png|jpe?g|gif|webp|svg)['"]/i)
    expect(importsOf(svg)).toEqual(['react'])
  })

  describe('the tutor panel and its conversation contexts (used by the Guide) keep the same boundary', () => {
    const tutorFiles: Array<[string, string]> = [
      ['TutorPanel.tsx', code(tutorPanelSource)],
      ['tutorContext.ts', code(tutorContextSource)],
    ]

    it.each(tutorFiles)('%s calls no API, LLM or network of its own — only the store’s askTutor', (_name, source) => {
      expect(valueImportsOf(source).filter((s) => /(^|\/)api(\/|$)|realClient|mockClient|client/i.test(s))).toEqual([])
      expect(source).not.toMatch(/fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
      expect(source).not.toMatch(/anthropic|openai|gemini|claude|gpt|langchain|llm|api[-_ ]?key/i)
    })

    it.each(tutorFiles)('%s never reads lesson text or quiz answers — only ids', (_name, source) => {
      expect(source).not.toMatch(/\.body|\.instructions|\.prompt|\.explanation|correctOptionId|correct_option|learningObjectives|shortDescription/)
    })

    it('the panel asks lessons by id only: askTutor(text) for the Lab, askTutor(text, {lessonId, sectionId}) for a lesson', () => {
      const calls = [...tutorFiles[0]![1].matchAll(/askTutor\(([^)]*)\)/g)].map((m) => m[1])
      expect(calls.sort()).toEqual(['trimmed', 'trimmed, { lessonId: context.lessonId, sectionId: context.sectionId }'])
    })

    it('the conversation-context module is pure: no store import beyond a type, no state, no effects', () => {
      const source = tutorFiles[1]![1]
      expect(valueImportsOf(source)).toEqual([])
      expect(source).not.toMatch(/create\(|\.setState\(|useEffect|localStorage|sessionStorage/)
    })
  })
})
