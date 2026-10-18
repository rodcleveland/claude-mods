import type { MdView } from '../types'

// Markdown Viewer's plain logic, with no engine calls: which written files to offer, the question
// asked at the end of the turn, and reading its answer.

export const MD_PANE = 'md-viewer'
export const YES = 'Yes, open it'
export const NO = 'No'
// One drawing draws 100000 characters in all; the rest of a longer file is cut with a note.
export const MAX_CHARS = 90_000

export const EMPTY_VIEW: MdView = { files: [], index: 0, text: null, error: null }

export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path)

// Claude's own bookkeeping (memory notes, saved tool output) is written under ~/.claude/projects.
export const isOffered = (path: string) => isMarkdownPath(path) && !/[\\/]\.claude[\\/]projects[\\/]/.test(path)

export const baseName = (path: string) => path.split(/[\\/]/).pop() || path

// A file written twice in one turn is offered once, in the order first written.
export const addFile = (files: readonly string[], path: string) => (files.includes(path) ? [...files] : [...files, path])

// One file: yes or no. Several: each by name (up to three), or none.
export function question(files: readonly string[]) {
  if (files.length === 1) {
    return { text: `Claude wrote ${baseName(files[0]!)}. Open it in the Markdown viewer?`, options: [YES, NO] }
  }
  const shown = files.slice(0, 3)
  return {
    text: `Claude wrote ${files.length} Markdown files. Open one in the Markdown viewer?`,
    options: [...shown.map(baseName), NO],
  }
}

// The files to open for an answer: the chosen file first, the rest of this turn's after it.
export function filesFor(files: readonly string[], answer: string): string[] {
  if (files.length === 1) return answer === YES ? [...files] : []
  const at = files.slice(0, 3).findIndex(f => baseName(f) === answer)
  return at === -1 ? [] : [files[at]!, ...files.filter((_, i) => i !== at)]
}

export const clip = (text: string) =>
  text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n\n---\n\n*The file is longer than the viewer shows. The rest is cut.*`
