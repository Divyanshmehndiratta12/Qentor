/**
 * Share / export for the circuit on screen. The file bundle comes from the SERVER (`POST /api/export/circuit`): canonical circuit,
 * OpenQASM 3, generated Qiskit/Cirq/PennyLane text and, when there is a result, that run's provenance METADATA - no numbers. The
 * share link carries the circuit only, in the URL fragment. Neither contains anything private: no key, path or server detail.
 *
 * "Share as a read-only page" asks the server to keep an immutable snapshot (`POST /api/experiments`): the circuit, the server's own
 * code for it and, when this circuit has a run, that run's stored record. The request names the run by id and carries no number; the page
 * shows what the server stored, and nothing about the sharer or their class is on it.
 */
import { useState } from 'react'
import { getApiClient, BackendUnavailableError, ClassroomRejectedError, EndpointNotImplementedError } from '@/api'
import type { CircuitExport } from '@/api'
import { useChallengeStore } from '@/features/challenges/store'
import { useLearnStore } from '@/features/learn/store'
import { useBuildStore } from '@/features/build/store'
import { StateNotice } from '@/features/shell/StateNotice'
import { shareUrl } from './shareLink'

export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const BTN =
  'rounded-md border border-void-400 px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-50'

export function ExportPanel() {
  const circuit = useBuildStore((s) => s.circuit)
  const result = useBuildStore((s) => s.result)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [page, setPage] = useState<{ url: string; path: string } | null>(null)
  const [pageError, setPageError] = useState<{ message: string; withoutRun: boolean } | null>(null)
  const [sharing, setSharing] = useState(false)
  const [title, setTitle] = useState('')
  const [lessonId, setLessonId] = useState('')
  const [challengeId, setChallengeId] = useState('')
  const lessons = useLearnStore((s) => s.lessons)
  const challenges = useChallengeStore((s) => s.challenges)

  const hasOps = circuit.ops.length > 0

  async function fetchBundle(): Promise<CircuitExport | null> {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      return await getApiClient().exportCircuit(circuit, result?.provenance.resultId ?? null)
    } catch (err) {
      setError(
        err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      )
      return null
    } finally {
      setBusy(false)
    }
  }

  async function downloadBundle() {
    const bundle = await fetchBundle()
    if (!bundle) return
    downloadText(`qentor-${bundle.circuitHash.slice(0, 8)}.json`, 'application/json', JSON.stringify(bundle, null, 2))
    setStatus(`Downloaded qentor-${bundle.circuitHash.slice(0, 8)}.json — the circuit, its code${bundle.execution ? ' and the run’s metadata' : ''}, no results.`)
  }

  async function downloadQasm() {
    const bundle = await fetchBundle()
    if (!bundle) return
    downloadText(`qentor-${bundle.circuitHash.slice(0, 8)}.qasm`, 'text/plain', bundle.qasm)
    setStatus(`Downloaded qentor-${bundle.circuitHash.slice(0, 8)}.qasm.`)
  }

  async function copyLink() {
    setError(null)
    const url = shareUrl(circuit)
    if (url === null) {
      setLink(null)
      setStatus(null)
      setError('This circuit is too large for a link. Download the bundle instead.')
      return
    }
    setLink(url)
    try {
      await navigator.clipboard.writeText(url)
      setStatus('Link copied. It carries the circuit only; whoever opens it runs it themselves.')
    } catch {
      setStatus('Copy the link below. It carries the circuit only; whoever opens it runs it themselves.')
    }
  }

  async function shareAsPage(withRun: boolean) {
    setSharing(true)
    setPageError(null)
    setPage(null)
    try {
      const made = await getApiClient().createExperiment({
        circuit,
        resultId: withRun ? (result?.provenance.resultId ?? null) : null,
        lessonId: lessonId || null,
        challengeId: challengeId || null,
        title: title || null,
      })
      setPage({ path: made.path, url: `${window.location.origin}${made.path}` })
    } catch (err) {
      const refused = err instanceof ClassroomRejectedError
      setPageError({
        message:
          err instanceof ClassroomRejectedError || err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
        // the one refusal that has a clean way forward: the run no longer belongs to this circuit
        withoutRun: withRun && refused && err.code === 'SHARE_INVALID',
      })
    } finally {
      setSharing(false)
    }
  }

  async function copyPage() {
    if (!page) return
    try {
      await navigator.clipboard.writeText(page.url)
      setStatus('Page link copied. Anyone with it can view this snapshot, but not change it.')
    } catch {
      setStatus('Copy the page link below. Anyone with it can view this snapshot, but not change it.')
    }
  }

  return (
    <section aria-labelledby="export-heading" className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4" data-testid="export-panel">
      <h3 id="export-heading" className="text-[13px] font-semibold text-slate-100">
        Share &amp; export
      </h3>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={!hasOps || busy} onClick={() => void downloadBundle()}>
          Download bundle (.json)
        </button>
        <button type="button" className={BTN} disabled={!hasOps || busy} onClick={() => void downloadQasm()}>
          Download OpenQASM (.qasm)
        </button>
        <button type="button" className={BTN} disabled={!hasOps} onClick={() => void copyLink()}>
          Copy share link
        </button>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-void-500 bg-void-950 p-2.5" data-testid="share-page">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} disabled={!hasOps || sharing} onClick={() => void shareAsPage(true)}>
            {sharing ? 'Sharing…' : 'Share as a read-only page'}
          </button>
          <span className="text-[11px] text-slate-400">{result ? 'Includes this run’s stored result.' : 'No run yet: shares the circuit alone.'}</span>
        </div>
        <details className="text-[11px] text-slate-400">
          <summary className="cursor-pointer text-slate-300">Optional: title and where it belongs</summary>
          <div className="mt-2 flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              Title (plain text, up to 80 characters)
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
                className="rounded border border-void-400 bg-void-900 px-2 py-1 text-xs text-slate-200"
              />
            </label>
            <label className="flex flex-col gap-1">
              Lesson
              <select value={lessonId} onChange={(e) => setLessonId(e.target.value)} className="rounded border border-void-400 bg-void-900 px-2 py-1 text-xs text-slate-200">
                <option value="">None</option>
                {lessons.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Challenge
              <select value={challengeId} onChange={(e) => setChallengeId(e.target.value)} className="rounded border border-void-400 bg-void-900 px-2 py-1 text-xs text-slate-200">
                <option value="">None</option>
                {challenges.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        {pageError && (
          <div role="alert" data-testid="share-page-error" className="text-[12px] text-danger-glow">
            <p>{pageError.message}</p>
            {pageError.withoutRun && (
              <button type="button" className={`${BTN} mt-1`} onClick={() => void shareAsPage(false)}>
                Share the circuit without a run
              </button>
            )}
          </div>
        )}
        {page && (
          <div className="flex flex-col gap-1.5" data-testid="share-page-result">
            <input
              readOnly
              aria-label="Read-only page link"
              value={page.url}
              onFocus={(e) => e.currentTarget.select()}
              className="rounded border border-void-400 bg-void-950 px-2 py-1 font-mono-qasm text-[10px] text-slate-300"
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN} onClick={() => void copyPage()}>
                Copy page link
              </button>
              <a href={page.path} target="_blank" rel="noopener noreferrer" className={BTN}>
                Open page
              </a>
            </div>
            <p className="text-[11px] text-slate-400">
              A snapshot nobody can edit. It shows the circuit, its code and this run’s stored result. It carries no name, class or learner token.
            </p>
          </div>
        )}
      </div>
      {!hasOps && <StateNotice kind="empty" compact title="Add gates to the circuit to export or share it." />}
      {busy && <StateNotice kind="loading" compact title="The server is preparing the export…" />}
      {error && <StateNotice kind="error" compact title="Couldn’t export" detail={error} hint="Nothing was exported." />}
      {status && !error && (
        <p role="status" className="text-[12px] text-slate-300" data-testid="export-status">
          {status}
        </p>
      )}
      {link && (
        <input
          readOnly
          aria-label="Share link"
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="rounded border border-void-400 bg-void-950 px-2 py-1 font-mono-qasm text-[10px] text-slate-300"
        />
      )}
      <p className="text-[11px] leading-snug text-void-200">
        Bundles and links hold the circuit (and, for a bundle, how it was run) — never results, keys or anything private. Run a shared circuit to get
        its numbers from the backend.
      </p>
    </section>
  )
}
