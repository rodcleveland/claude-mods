export type RackFamily = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type RackEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RackHelper = 'fast' | 'balanced' | 'same'

export type RackPrefs = {
  model: RackFamily | null
  effort: RackEffort | null
  cleanView: boolean
  promptUpgrade: boolean
  helper: RackHelper
}

export type RackSeen = { model: string | null; effort: string | null }
export type RackAgent = { model: string; startedAt: number }
export type RackUpgrade = { original: string; upgraded: string }

declare module 'claude-code' {
  interface PluginState {
    'rods-rack': {
      prefs: RackPrefs
      panelOpen: boolean
      seen: RackSeen
      agents: Record<string, RackAgent>
      lastUpgrade: RackUpgrade | null
      dockTick: number
    }
  }
}
