/**
 * Which simulator Run, Trace and Optimize send their request to. It is a real control: the choice goes into the
 * request body (`backend`), the server runs the circuit there, and every result carries that backend's name and version
 * in its provenance badge. Changing it clears the results, because they belong to the backend that produced them.
 */
import type { Backend } from '@/api'
import { useBuildStore } from './store'

export const BACKEND_LABELS: Record<Backend, string> = {
  'qiskit-aer': 'Qiskit Aer',
  cirq: 'Cirq',
  pennylane: 'PennyLane',
}

export function BackendSelector() {
  const backend = useBuildStore((s) => s.backend)
  const setBackend = useBuildStore((s) => s.setBackend)

  return (
    <label className="flex items-center gap-1.5 text-void-200">
      backend
      <select
        aria-label="Execution backend"
        value={backend}
        onChange={(e) => setBackend(e.target.value as Backend)}
        className="rounded border border-void-400 bg-void-800 px-1.5 py-1 text-slate-200 focus:border-cyan-glow focus:outline-none"
      >
        {(Object.keys(BACKEND_LABELS) as Backend[]).map((name) => (
          <option key={name} value={name}>
            {BACKEND_LABELS[name]}
          </option>
        ))}
      </select>
    </label>
  )
}
