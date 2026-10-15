export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** A stretch of the session being open: a launch, or a resume of it. */
export type Segment = { start: number; end: number }

/** One main-loop turn: how long Claude worked on it and what it cost. */
export type Turn = Tokens & {
  start: number
  ms: number
  model: string
  reason: string
}

/** One subagent turn: tokens only, since its time overlaps the main turn that spawned it. */
export type AgentTurn = Tokens & { start: number; model: string }

/** What one session file in `<project>/.claude/token-time/sessions/` holds. */
export type SessionRecord = {
  version: 1
  sessionId: string
  project: { root: string; name: string }
  segments: Segment[]
  turns: Turn[]
  agentTurns: AgentTurn[]
}

/** Summed figures for any slice: a session, a day, a project. */
export type Totals = Tokens & {
  sessions: number
  turns: number
  clockMs: number
  activeMs: number
  claudeMs: number
  agentTokens: Tokens
}

/** What the pane draws from. */
export type Live = {
  record: SessionRecord | null
  /** When the running main-loop turn started; null between turns. */
  turnStartedAt: number | null
  /** This project's other sessions, summed when the session started (or the day changed). */
  projectToday: Totals | null
  projectAll: Totals | null
  /** The local day `projectToday` counts, as YYYY-MM-DD. */
  day: string
}

declare module 'claude-code' {
  interface PluginState {
    'token-and-time-tracking': { live: Live; now: number }
  }
}
