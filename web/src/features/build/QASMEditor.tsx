/**
 * OpenQASM 3 text editor, two-way bound to the canvas via `useBuildStore`.
 * Editing here parses through the same client-side parser the canvas edits
 * emit through (`circuit/qasmParser.ts`); editing the canvas re-emits text
 * here. Per docs/ARCHITECTURE.md §4, this client parser is a UX convenience
 * only — the server independently re-parses with Qiskit's `qasm3` importer
 * before trusting anything. Only QASM text can be typed here; there is no
 * code path that executes it as a program.
 *
 * The "synced with canvas" status dot and the error-line highlight are pure
 * chrome — cosmetic feedback about the client-side parse, not a claim about
 * what the server will accept.
 */
import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Annotation, EditorState, Compartment, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet } from '@codemirror/view'
import { toQasm3 } from '@/circuit/qasmEmitter'
import { qasmLineOfOp } from '@/circuit/qasmLines'
import { useBuildStore } from './store'

const theme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--color-void-900)',
      color: '#cbd5e1',
      height: '100%',
      fontSize: '13px',
    },
    '.cm-content': { fontFamily: 'var(--font-mono-qasm)', caretColor: '#5eead4' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-void-900)',
      color: '#94a3b8', // slate-400: line numbers meet 4.5:1 on the editor background (the old slate-600 was 2.45:1)
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(94, 234, 212, 0.05)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(94, 234, 212, 0.05)' },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
)

/**
 * Marks a change the editor makes to ITSELF to mirror the store (a canvas edit,
 * "Open in Lab", an applied optimisation). CodeMirror reports those exactly like
 * typing, so without this the editor would echo the store's own text back into
 * `applyQasmEdit` 400ms later — which re-parses identical text, replaces the
 * circuit and clears every result, trace and verification that arrived in the
 * meantime (an auto-run answers at ~250ms + latency, i.e. just before the echo).
 * Only what a PERSON types is a user edit.
 */
const programmaticSync = Annotation.define<boolean>()

const errorLineMark = Decoration.line({ attributes: { class: 'cm-error-line' } })
const setErrorLine = StateEffect.define<number | null>()
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setErrorLine)) continue
      if (effect.value == null || effect.value < 1 || effect.value > tr.state.doc.lines) return Decoration.none
      const line = tr.state.doc.line(effect.value)
      return Decoration.set([errorLineMark.range(line.from)])
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * The line of the gate picked on the canvas (violet) or, with nothing picked, of the operation behind the selected trace step (amber).
 * A mark only: it follows the text through edits, and is dropped (never guessed) when the editor's text is not the canonical text of
 * the circuit, because then a line number would not mean an operation.
 */
const opLineSelected = Decoration.line({ attributes: { class: 'cm-op-line-selected' } })
const opLineTraced = Decoration.line({ attributes: { class: 'cm-op-line-traced' } })
const setOpLine = StateEffect.define<{ line: number; kind: 'selected' | 'traced' } | null>()
const opLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setOpLine)) continue
      const target = effect.value
      if (!target || target.line < 1 || target.line > tr.state.doc.lines) return Decoration.none
      const line = tr.state.doc.line(target.line)
      return Decoration.set([(target.kind === 'selected' ? opLineSelected : opLineTraced).range(line.from)])
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function QASMEditor() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAppliedRef = useRef<string>('')
  const [parseError, setParseError] = useState<string | null>(null)

  const qasmText = useBuildStore((s) => s.qasmText)
  const applyQasmEdit = useBuildStore((s) => s.applyQasmEdit)
  const circuit = useBuildStore((s) => s.circuit)
  const selectedOp = useBuildStore((s) => s.selectedOpIndex)
  const tracedOp = useBuildStore((s) => s.trace?.steps[s.selectedTraceStep]?.operationIndex ?? null)

  // Mount CodeMirror once.
  useEffect(() => {
    if (!hostRef.current) return

    const readOnlyCompartment = new Compartment()
    const state = EditorState.create({
      doc: qasmText,
      extensions: [
        // a name for the editing area (axe: an input field must have one), and a tab stop so it can be reached and scrolled by keyboard
        EditorView.contentAttributes.of({ 'aria-label': 'OpenQASM 3 source, editable', tabindex: '0' }),
        basicSetup,
        theme,
        errorLineField,
        opLineField,
        readOnlyCompartment.of([]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          // A store-driven mirror of the canvas is not the learner editing.
          if (update.transactions.some((tr) => tr.annotation(programmaticSync))) return
          const text = update.state.doc.toString()
          if (debounceRef.current) clearTimeout(debounceRef.current)
          debounceRef.current = setTimeout(() => {
            const result = applyQasmEdit(text)
            if (result.ok) {
              lastAppliedRef.current = text
              setParseError(null)
              viewRef.current?.dispatch({ effects: setErrorLine.of(null) })
            } else {
              setParseError(result.error)
              viewRef.current?.dispatch({ effects: setErrorLine.of(result.line) })
            }
          }, 400)
        }),
      ],
    })

    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    lastAppliedRef.current = qasmText

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Mount once; store-driven external updates are handled in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push canvas-driven changes into the editor, but only when the change
  // didn't originate from this editor's own debounced parse (avoids clobbering
  // the cursor while the learner is mid-edit).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (qasmText === lastAppliedRef.current) return
    if (qasmText === view.state.doc.toString()) return

    // The store moved on (a canvas edit, say). A user edit still waiting on its
    // debounce is now STALE — applying it would overwrite this newer circuit with
    // older text — so it is dropped, and the editor takes the store's text.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: qasmText },
      effects: setErrorLine.of(null),
      annotations: programmaticSync.of(true),
    })
    lastAppliedRef.current = qasmText
    setParseError(null)
  }, [qasmText])

  // Mark the line of the picked gate (or the traced one) while the editor shows the canvas's own text.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const index = selectedOp ?? tracedOp
    const line =
      index !== null && view.state.doc.toString() === qasmText && qasmText === toQasm3(circuit) ? qasmLineOfOp(circuit, index) : null
    view.dispatch({ effects: setOpLine.of(line === null ? null : { line, kind: selectedOp !== null ? 'selected' : 'traced' }) })
  }, [selectedOp, tracedOp, circuit, qasmText])

  return (
    <div className="relative flex h-full flex-col">
      {/* The tab above already names the language; this says that the text is editable and whether it is in step with the canvas. */}
      <span
        className={`pointer-events-none absolute top-1.5 right-3 z-10 flex items-center gap-1.5 rounded-full bg-void-900/90 px-2 py-0.5 font-mono-qasm text-[11px] font-medium ${
          parseError ? 'text-danger-glow' : 'text-cyan-glow'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${parseError ? 'bg-danger-glow' : 'bg-cyan-glow'}`} />
        {parseError ? 'parse error' : 'synced with canvas'}
        {!parseError && <span className="text-void-200">· editable</span>}
      </span>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-auto" />
      {parseError && (
        <p className="border-t border-danger-glow/30 bg-danger-dim/30 px-4 py-2 text-xs text-danger-glow">
          {parseError}
        </p>
      )}
    </div>
  )
}
