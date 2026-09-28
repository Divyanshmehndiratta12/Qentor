/**
 * Quantum Lab workspace shell: left lesson sidebar, center circuit canvas,
 * right verified results panel, bottom AI tutor panel. This is Milestone 2's
 * Build screen — Test/Optimize/Reality-check/Reflect are not laid out here
 * yet because their backend endpoints don't exist (see docs/48_HOUR_PLAN.md).
 */
import { LessonSidebar } from '@/features/lessons/LessonSidebar'
import { BuildScreen } from '@/features/build/BuildScreen'
import { ResultsPanel } from '@/features/build/ResultsPanel'
import { TutorPanel } from '@/features/tutor/TutorPanel'
import { TopBar } from '@/features/shell/TopBar'

function App() {
  return (
    <div className="flex h-screen flex-col bg-void-950 text-slate-200">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-r border-void-500 bg-void-900">
          <LessonSidebar />
        </aside>

        <main className="min-w-0 flex-1 border-r border-void-500 bg-void-950">
          <BuildScreen />
        </main>

        <aside className="w-96 shrink-0 bg-void-900">
          <ResultsPanel />
        </aside>
      </div>

      <footer className="h-64 shrink-0 border-t border-void-500 bg-void-900">
        <TutorPanel />
      </footer>
    </div>
  )
}

export default App
