export type RackFamily = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type RackEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RackHelper = 'fast' | 'balanced' | 'same'

export type RackPrefs = {
  model: RackFamily | null
  effort: RackEffort | null
  promptUpgrade: boolean
  helper: RackHelper
}

export type RackSeen = { model: string | null; effort: string | null }
export type RackAgent = { model: string; startedAt: number }
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

declare module 'claude-code' {
  interface PluginState {
    'rods-rack': {
      prefs: RackPrefs
      panelOpen: boolean
      seen: RackSeen
      agents: Record<string, RackAgent>
      lastUpgrade: RackUpgrade | null
      dockTick: number
      cleanViewEnabled: boolean
      checklist: CleanChecklist
      tick: number
    }
  }
}
