/**
 * The circuit as code, in tabs: OpenQASM 3 (the editable, canonical form) and read-only Qiskit, Cirq and PennyLane
 * source. The three SDK tabs show TEXT that the server generated from the canonical circuit
 * (`POST /api/circuit/code`, `qentor.circuit.codegen`); nothing here runs it, and nothing in the browser can — there is no
 * evaluator, only a `<pre>`. The editor stays mounted while another tab is showing, so switching tabs never disturbs an
 * edit in progress or the stale-echo protections in `QASMEditor`.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { getApiClient, type CodeFramework, type CodeViewsResult } from '@/api'
import type { Circuit } from '@/circuit/types'
import { QASMEditor } from './QASMEditor'
import { useBuildStore } from './store'

type Tab = 'qasm' | CodeFramework

export const CODE_TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'qasm', label: 'OpenQASM 3' },
  { id: 'qiskit', label: 'Qiskit' },
  { id: 'cirq', label: 'Cirq' },
  { id: 'pennylane', label: 'PennyLane' },
]

const DEBOUNCE_MS = 250

export function CodePane() {
  const [active, setActive] = useState<Tab>('qasm')
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = CODE_TABS.findIndex((t) => t.id === active)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % CODE_TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + CODE_TABS.length) % CODE_TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = CODE_TABS.length - 1
    else return
    event.preventDefault()
    setActive(CODE_TABS[next].id)
    tabRefs.current[CODE_TABS[next].id]?.focus()
  }

  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="Circuit code" onKeyDown={onKeyDown} className="flex items-center gap-1 border-b border-void-500 px-3 pt-1.5">
        {CODE_TABS.map((tab) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el
              }}
              type="button"
              role="tab"
              id={`code-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`code-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              className={`rounded-t-md border-b-2 px-3 py-1.5 text-xs font-semibold tracking-wide ${
                selected ? 'border-cyan-glow text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
        {active !== 'qasm' && (
          <span className="ml-auto pr-1 font-mono-qasm text-[11px] text-void-200">read-only · written by the server · never run</span>
        )}
      </div>

      <div
        role="tabpanel"
        id="code-panel-qasm"
        aria-labelledby="code-tab-qasm"
        hidden={active !== 'qasm'}
        className="min-h-0 flex-1"
      >
        <QASMEditor />
      </div>

      {active !== 'qasm' && (
        <div
          role="tabpanel"
          id={`code-panel-${active}`}
          aria-labelledby={`code-tab-${active}`}
          className="min-h-0 flex-1"
        >
          <GeneratedCode framework={active} />
        </div>
      )}
    </div>
  )
}

interface Loaded {
  circuit: Circuit
  views?: CodeViewsResult
  error?: string
}

function GeneratedCode({ framework }: { framework: CodeFramework }) {
  const circuit = useBuildStore((s) => s.circuit)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [copied, setCopied] = useState<'copied' | 'unavailable' | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const views = await getApiClient().generateCode(circuit)
        if (!cancelled) setLoaded({ circuit, views })
      } catch (err) {
        if (!cancelled) setLoaded({ circuit, error: err instanceof Error ? err.message : String(err) })
      }
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [circuit, attempt])

  // A response answers one circuit; for any other circuit the pane is loading again, never showing the old code as current.
  const current = loaded && loaded.circuit === circuit ? loaded : null
  const text = current?.views?.code[framework]

  async function copy() {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied('copied')
    } catch {
      setCopied('unavailable')
    }
  }

  if (!current) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-slate-400" role="status">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-glow" aria-hidden="true" />
        Generating {framework} code…
      </p>
    )
  }

  if (current.error !== undefined) {
    return (
      <div role="alert" className="m-4 rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
        <p className="font-semibold text-danger-glow">Code view unavailable</p>
        <p className="mt-1 font-mono-qasm text-xs text-danger-glow/80">{current.error}</p>
        <p className="mt-2.5 text-xs text-slate-400">No substitute code is shown.</p>
        <button
          type="button"
          onClick={() => {
            setLoaded(null)
            setAttempt((n) => n + 1)
          }}
          className="mt-2 rounded-md border border-void-400 px-2.5 py-1 text-xs text-slate-200 hover:border-void-300"
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="relative h-full">
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute top-2 right-3 z-10 rounded-md border border-void-400 bg-void-800 px-2 py-1 text-[11px] text-slate-300 hover:border-void-300"
      >
        {copied === 'copied' ? 'Copied' : copied === 'unavailable' ? 'Copy unavailable' : 'Copy'}
      </button>
      <pre
        tabIndex={0}
        aria-label={`${framework} code for this circuit`}
        className="h-full overflow-auto p-4 font-mono-qasm text-[12.5px] leading-relaxed text-slate-200 focus-visible:outline-2 focus-visible:outline-cyan-glow"
      >
        {text}
      </pre>
    </div>
  )
}
