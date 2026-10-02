/**
 * Colour contrast, pinned. A real-browser axe-core audit found 380 text nodes below WCAG AA (4.5:1), nearly all of them one token
 * (`void-200`, a mid grey used for notes and captions, 2.4:1) and one Tailwind class (`text-slate-500`, 3.9:1). The token is now
 * readable and the weak classes are gone; these tests keep them gone. jsdom has no layout, so contrast is checked from the theme's own
 * colours: the muted-text token against every surface text can sit on, and a scan of the source for the classes that failed.
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Read from disk: under test, a `?raw` import of a stylesheet is processed (and comes back empty).
const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8') // vitest runs from web/

const sources = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const appSources = Object.entries(sources).filter(([path]) => !path.includes('.test.'))

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)
  if (!match) throw new Error(`token ${name} is not a #rrggbb colour in index.css`)
  return match[1]!
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// Tailwind's slate-400, the colour of secondary text that is not a caption.
const SLATE_400 = '#90a1b9'

describe('muted text is readable on every surface it sits on', () => {
  const surfaces = ['void-950', 'void-900', 'void-800', 'void-700', 'void-600', 'void-500']

  for (const surface of surfaces) {
    it(`void-200 on ${surface} is at least 4.5:1`, () => {
      expect(contrast(token('void-200'), token(surface))).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('slate-400 (secondary text) is at least 4.5:1 on the same surfaces', () => {
    for (const surface of surfaces) expect(contrast(SLATE_400, token(surface))).toBeGreaterThanOrEqual(4.5)
  })

  it('the old muted grey really was too dark (the check can fail)', () => {
    expect(contrast('#4a525e', token('void-950'))).toBeLessThan(3)
  })

  it('void-200 stays a step dimmer than the secondary text so the hierarchy survives', () => {
    expect(luminance(token('void-200'))).toBeLessThan(luminance(SLATE_400))
  })
})

describe('classes that failed the audit are not used for text', () => {
  const offenders = (pattern: RegExp) => appSources.filter(([, text]) => pattern.test(text)).map(([path]) => path)

  it('no text-slate-600 (2.4:1) anywhere', () => {
    expect(offenders(/text-slate-600/)).toEqual([])
  })

  it('no text-void-300 (1.9:1) anywhere, and no placeholder in it', () => {
    expect(offenders(/text-void-300/)).toEqual([])
  })

  it('text-slate-500 (3.9:1) survives only on the empty-slot "+" of the circuit canvas, a control and not text', () => {
    const using = offenders(/text-slate-500/)
    expect(using).toEqual(['../features/build/CircuitCanvas.tsx'])
    const lines = (sources['../features/build/CircuitCanvas.tsx'] ?? '').split('\n').filter((l) => l.includes('text-slate-500'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('hover:border-cyan-glow')
  })
})

describe('the code editor’s line numbers are readable', () => {
  // Found by axe in real Chrome with a long circuit (25 gutter numbers at 2.45:1: the old colour was Tailwind slate-600).
  const editor = appSources.find(([path]) => path.endsWith('/features/build/QASMEditor.tsx'))![1]
  const gutter = /'\.cm-gutters':\s*\{[^}]*color:\s*'(#[0-9a-fA-F]{6})'/.exec(editor)

  it('the gutter colour is a plain colour in the editor theme', () => {
    expect(gutter).not.toBeNull()
  })

  it('is at least 4.5:1 on the editor background, which is the void-900 surface', () => {
    expect(editor).toMatch(/'&':\s*\{\s*backgroundColor:\s*'var\(--color-void-900\)'/)
    expect(contrast(gutter![1]!, token('void-900'))).toBeGreaterThanOrEqual(4.5)
  })

  it('is not the colour that failed', () => {
    expect(gutter![1]!.toLowerCase()).not.toBe('#475569')
  })
})
