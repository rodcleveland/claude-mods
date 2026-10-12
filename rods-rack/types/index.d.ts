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

// One calendar day's work: finished tasks per kind and per model.
export type ReportDay = {
  kinds: Record<ReportKind, number>
  models: Record<string, number>
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

declare module 'claude-code' {
  interface PluginState {
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
    }
  }
}
