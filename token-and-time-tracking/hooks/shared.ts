import type { Live } from '../types'
import { MINUTE } from './logic'

// The pane's state is declared beside each hook that reads it (register.tsx, pane.tsx): the
// validator reads a state reference only where it is written as a literal in the same file.

export const INITIAL_LIVE: Live = { record: null, turnStartedAt: null, history: null, day: '' }

/** Read from the options at each load. */
export const settings = { idleMs: 15 * MINUTE }
