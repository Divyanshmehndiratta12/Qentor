/**
 * The public page for a shared experiment (`/shared/<id>`), read-only by construction: there is no editor, no field and no action that
 * changes the experiment, and the server has no endpoint that could. Everything shown comes from what the server stored: the circuit,
 * the code it wrote for it, and, when the sharer had run it, that run's stored record, shown through the same provenance-carrying
 * components as a live result. "Fork into my Lab" copies the circuit into the visitor's own Lab; the shared page stays as it is.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { BackendUnavailableError, ClassroomRejectedError, getApiClient, type SharedExperiment } from '@/api'
import type { Circuit } from '@/circuit/types'
import { ShotsResult, StatevectorResult } from '@/features/build/ResultsPanel'
import { StateNotice } from '@/features/shell/StateNotice'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { ReadOnlyCircuit } from './ReadOnlyCircuit'

type Tab = 'qasm' | 'qiskit' | 'cirq' | 'pennylane'
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'qasm', label: 'OpenQASM 3' },
  { id: 'qiskit', label: 'Qiskit' },
  { id: 'cirq', label: 'Cirq' },
  { id: 'pennylane', label: 'PennyLane' },
]

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'error'; message: string } | { state: 'ready'; experiment: SharedExperiment }

const CARD = 'rounded-xl border border-void-500 bg-void-900 p-4'
const H2 = 'text-[11px] font-semibold tracking-wider text-slate-400 uppercase'

export function SharedExperimentScreen({ experimentId, onFork, onOpenLab }: { experimentId: string | null; onFork: (circuit: Circuit, title: string | null) => void; onOpenLab: () => void }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    if (!experimentId) {
      setLoad({ state: 'missing' })
      return
    }
    let cancelled = false
    setLoad({ state: 'loading' })
    getApiClient()
      .getExperiment(experimentId)
      .then((experiment) => {
        if (!cancelled) setLoad({ state: 'ready', experiment })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ClassroomRejectedError && err.status === 404) setLoad({ state: 'missing' })
        else setLoad({ state: 'error', message: err instanceof BackendUnavailableError || err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [experimentId])

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      {load.state === 'loading' && <StateNotice kind="loading" compact title="Loading the shared experiment…" />}
      {load.state === 'missing' && (
        <div data-testid="shared-missing" className={CARD}>
          <h1 className="font-sans-ui text-xl font-semibold text-slate-100">Shared experiment not found</h1>
          <p className="mt-2 text-sm text-slate-400">No shared experiment has that address. It may have been mistyped.</p>
          <button type="button" onClick={onOpenLab} className="mt-3 min-h-10 rounded-md border border-void-400 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-void-700">
            Go to the Lab
          </button>
        </div>
      )}
      {load.state === 'error' && <StateNotice kind="error" compact title="The shared experiment could not be loaded." detail={load.message} hint="Nothing is shown in its place." />}
      {load.state === 'ready' && <Ready experiment={load.experiment} onFork={onFork} />}
    </div>
  )
}

function Ready({ experiment: e, onFork }: { experiment: SharedExperiment; onFork: (circuit: Circuit, title: string | null) => void }) {
  const [tab, setTab] = useState<Tab>('qasm')
  const [copied, setCopied] = useState(false)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const text = tab === 'qasm' ? e.qasm : e.code[tab]

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((t) => t.id === tab)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return
    event.preventDefault()
    setTab(TABS[next].id)
    tabRefs.current[TABS[next].id]?.focus()
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const result = e.result
  return (
    <>
      <header>
        <p className="inline-flex items-center gap-1.5 rounded-full border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-0.5 text-[11px] font-semibold tracking-wider text-cyan-glow uppercase" data-testid="readonly-badge">
          Read-only snapshot
        </p>
        <h1 className="mt-2 font-sans-ui text-2xl font-semibold text-slate-100" data-testid="shared-title">
          {e.title ?? 'Shared experiment'}
        </h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slate-400" data-testid="shared-note">
          {e.note}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Shared <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
          {e.lesson && <> · Lesson: {e.lesson.title}</>}
          {e.challenge && <> · Challenge: {e.challenge.title}</>}
        </p>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => onFork(structuredClone(e.circuit), e.title)}
            className="min-h-10 rounded-md bg-slate-100 px-4 py-2 text-sm font-semibold text-void-950 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
          >
            Fork into my Lab
          </button>
          <span className="ml-3 text-xs text-slate-400">Makes your own copy to edit. This page does not change.</span>
        </div>
      </header>

      <section aria-labelledby="sh-circuit" className={CARD}>
        <h2 id="sh-circuit" className={H2}>
          Circuit
        </h2>
        <div className="mt-2">
          <ReadOnlyCircuit circuit={e.circuit} />
        </div>
        <p className="mt-2 font-mono-qasm text-[11px] break-all text-slate-400">circuit hash {e.circuitHash}</p>
      </section>

      <section aria-labelledby="sh-code" className={CARD}>
        <h2 id="sh-code" className={H2}>
          Code
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Written by the Qentor server from the circuit above ({e.generator}). It is text only and was not run to make this page.
        </p>
        <div role="tablist" aria-label="Shared circuit code" onKeyDown={onKeyDown} className="mt-2 flex flex-wrap gap-1 border-b border-void-500">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el
              }}
              type="button"
              role="tab"
              id={`shared-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="shared-code-panel"
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => {
                setTab(t.id)
                setCopied(false)
              }}
              className={`min-h-9 rounded-t-md border-b-2 px-3 py-1.5 text-xs font-semibold tracking-wide ${
                tab === t.id ? 'border-cyan-glow text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="shared-code-panel" aria-labelledby={`shared-tab-${tab}`} tabIndex={0} className="mt-2">
          <pre data-testid="shared-code" className="max-h-80 overflow-auto rounded-lg border border-void-500 bg-void-950 p-3 font-mono-qasm text-xs whitespace-pre text-slate-200">
            {text}
          </pre>
          <button type="button" onClick={() => void copy()} className="mt-2 min-h-9 rounded-md border border-void-400 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-void-700">
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
      </section>

      <section aria-labelledby="sh-result" className={CARD}>
        <h2 id="sh-result" className={H2}>
          Result
        </h2>
        <p className="mt-1 text-xs text-slate-400" data-testid="shared-run-line">
          {result
            ? `Stored run on ${e.backend}, ${e.mode === 'shots' ? `shots mode${e.shots !== null ? ` (${e.shots} shots)` : ''}` : 'statevector mode'}.`
            : `Selected backend ${e.backend}, ${e.mode} mode. No run is attached.`}
        </p>
        {result ? (
          <div className="mt-3 flex flex-col gap-3" data-testid="shared-result">
            <ProvenanceBadge provenance={result.provenance} />
            {result.value.probabilities && (
              <ShotsResult frequencies={result.value.probabilities} counts={result.value.counts} shots={result.value.shots} provenance={result.provenance} />
            )}
            {result.value.statevector && (
              <StatevectorResult
                amplitudes={result.value.statevector}
                theoretical={result.value.theoreticalProbabilities}
                hasMeasurement={e.circuit.ops.some((op) => op.gate === 'measure')}
                provenance={result.provenance}
              />
            )}
          </div>
        ) : null}
        <p className="mt-3 text-[12px] leading-snug text-slate-400" data-testid="shared-result-note">
          {e.resultNote}
        </p>
      </section>
    </>
  )
}
