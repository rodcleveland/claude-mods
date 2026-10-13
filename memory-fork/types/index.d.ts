export type Change = { name: string; kind: 'added' | 'updated' | 'deleted'; added: number; removed: number }

// written; unindexed: the file was written but memsearch index failed; off: memsearch is not installed.
export type Sink = 'written' | 'unindexed' | 'off' | 'failed'

export type Run = {
  id: string
  at: number
  status: 'classifying' | 'skipped' | 'forking' | 'done' | 'failed'
  reason?: string
  changes: Change[]
  // Where the fork's log note went besides the auto-memory, once it is written.
  sinks?: { vault: 'written' | 'failed'; memsearch: Sink }
}

declare module 'claude-code' {
  interface PluginState {
    'memory-fork': { runs: Run[]; dismissed: string | null }
  }
}
