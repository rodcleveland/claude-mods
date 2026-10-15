export type RackFamily = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type RackEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RackHelper = 'fast' | 'balanced' | 'same'
export type RackAutoLevel = 'small' | 'everyday' | 'strong' | 'strongest'

export type RackPrefs = {
  model: RackFamily | null
  effort: RackEffort | null
  promptUpgrade: boolean
  helper: RackHelper
  // Auto Model: on or off, the model to go back to when it is turned off, and the model lines
  // this plan refused, which it steps down past.
  autoModel: boolean
  autoPrevious: RackFamily | null
  autoUnavailable: RackFamily[]
}

export type RackSeen = { model: string | null; effort: string | null }
export type RackUpgrade = { original: string; upgraded: string }

export type CleanTaskStatus = 'done' | 'active' | 'upcoming'

export type CleanTask = {
  id: string
  name: string
  status: CleanTaskStatus
  percent: number
  hasReported: boolean
}

// idle: no job yet. working, needsYou and stuck: a job is open. stopped and done: it ended.
export type CleanPhase = 'idle' | 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

// Where the rows came from: the placeholders a new job shows, plan_steps, or a to-do list.
export type CleanSource = 'placeholder' | 'plan' | 'todo'

export type CleanChecklist = {
  jobId: number
  title: string
  phase: CleanPhase
  tasks: CleanTask[]
  source: CleanSource
  hasPlan: boolean
  needsYouReason: string | null
  stuckReason: string | null
  failures: number
  startedAt: number | null
  finishedAt: number | null
  isCollapsed: boolean
}

export type DockCardStatus = 'queued' | 'working' | 'done' | 'stuck'

// One helper agent's card: keyed by the Agent call's tool_use id; agentId once its reports name it.
export type DockCard = {
  id: string
  name: string
  agentId: string | null
  status: DockCardStatus
  percent: number
  hasReported: boolean
  startedAt: number | null
  finishedAt: number | null
}

// idle: standing by. live: helpers are queued or working. done: the summary line.
export type DockPhase = 'idle' | 'live' | 'done'

export type DockMission = {
  id: number
  name: string
  phase: DockPhase
  // The Team Size the request was sent at, whether it carried the split instruction, how many
  // Agent calls were let through, and whether the one nudge was sent.
  size: number
  wantsSplit: boolean
  admitted: number
  nudged: boolean
  cards: DockCard[]
  startedAt: number | null
  finishedAt: number | null
}

export type ReportKind = 'emails' | 'documents' | 'media' | 'artifacts' | 'research' | 'coding' | 'other'
export type ReportTab = 'today' | 'week' | 'month' | 'year'

// Tokens the API counted, in four parts: new input, output, and input read from or written to the cache.
export type ReportTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// One calendar day's work: finished tasks per kind and per model, and every token Claude and its
// helpers used that day, in total and per model. Days saved before tokens were counted have none.
export type ReportDay = {
  kinds: Record<ReportKind, number>
  models: Record<string, number>
  tokens?: ReportTokens
  modelTokens?: Record<string, number>
}

// Minutes each kind of task saves, and what an hour is worth.
export type ReportSettings = {
  minutes: Record<ReportKind, number>
  rate: number
}

// The estimate of past work, built once from saved sessions; days before cutoffDay come from it.
export type ReportHistory = {
  cutoffDay: string
  days: Record<string, ReportDay>
}

// YouTube TV: a channel is a name and the YouTube search that fills it.
export type TvChannel = { name: string; query: string }
export type TvVideo = { id: string; title: string; channel: string }

export type TvSettings = {
  channels: TvChannel[]
  volume: number
  // The channel last tuned, from 0; CH▲ and CH▼ step from it.
  channel: number
  // Pause when Claude finishes or needs you.
  autoPause: boolean
}

// off: no player. starting: the player program and window are coming up. on: it runs.
export type TvPower = 'off' | 'starting' | 'on'

export type TvState = {
  power: TvPower
  // The channel showing, from 0, or null for a search or a link.
  channel: number | null
  label: string
  videos: TvVideo[]
  index: number
  title: string | null
  author: string | null
  // YouTube's player state: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
  playState: number
  windows: number
  needsClick: boolean
  isTuning: boolean
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    // Read only: the Question Pane mod owns this value (its own contract declares it the same way).
    'question-pane': {
      enabled: boolean
    }
    'rods-rack': {
      prefs: RackPrefs
      panelOpen: boolean
      seen: RackSeen
      lastUpgrade: RackUpgrade | null
      dockSize: number
      dockPending: number | null
      dockCustomOpen: boolean
      dockMission: DockMission
      dockFrame: number
      dockFolded: boolean
      cleanViewEnabled: boolean
      checklist: CleanChecklist
      tick: number
      isWorking: boolean
      reportTab: ReportTab
      reportToday: string
      reportDays: Record<string, ReportDay>
      reportHistory: ReportHistory | null
      reportSettings: ReportSettings
      // The typed request now running: what its tools touched, or null between requests.
      reportPending: string[] | null
      tv: TvState
      tvSettings: TvSettings
    }
  }
}
