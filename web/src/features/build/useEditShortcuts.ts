/**
 * Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes a circuit edit, wherever the canvas is on screen. Not while the learner
 * is typing in a field or in the OpenQASM editor: those have their own undo for TEXT, and a shortcut that reached past them would
 * undo the circuit under someone's cursor.
 */
import { useEffect } from 'react'
import { useBuildStore } from './store'

export function useEditShortcuts(): void {
  const undo = useBuildStore((s) => s.undo)
  const redo = useBuildStore((s) => s.redo)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])
}
