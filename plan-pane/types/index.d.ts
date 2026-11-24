// Plan Pane's shared types and its $.state contract. Every hooks file imports from here.

// A milestone's state. 'active' is "work has started", from a task marked in progress or some of its
// checkboxes ticked.
export type MilestoneStatus = 'todo' | 'active' | 'done'

// One milestone: a plan unit such as "### U3. Calendar view".
// id is the key progress is matched on (see milestoneId in hooks/plan-logic.ts): 'U3', 'U3a',
// 'task-2', 'phase-1', 'unit-4'.
export type Milestone = { id: string; label: string; status: MilestoneStatus }

// One major section: an H2 heading of the plan. A plan's standard contract headings may be folded
// into one section by the parser. id is 's:' + a slug of the title, unique within the plan.
export type PlanSection = { id: string; title: string; milestones: Milestone[] }

export type Plan = { path: string; title: string; sections: PlanSection[] }

// Progress learned outside the file (Claude's to-do and task updates), per milestone id.
export type PlanProgress = Record<string, MilestoneStatus>

// The shimmer's tones: purple a row that just appeared, orange one whose work just started, green
// one just finished.
export type FlashTone = 'purple' | 'orange' | 'green'

// The rows lit now (row id -> tone). generation stops an old timer from clearing a newer flash.
export type Flash = { ids: Record<string, FlashTone>; generation: number }

// A 4-step colour ramp per tone, base first and lightest last (the file tree mod's layout).
export type ToneRamps = Record<FlashTone, string[]>

// One drawn line of the pane. Both the animated Client module and the static fallback draw these.
export type PaneRow = {
  id: string
  indent: number
  glyph: string
  glyphColor?: string
  text: string
  color?: string
  dim?: boolean
  bold?: boolean
  // Right-aligned note, e.g. "3/7".
  right?: string
  // Set while the row shimmers.
  tone?: FlashTone
}

// The props of the Client module in hooks/shimmer.tsx.
export type ShimmerProps = { rows: PaneRow[]; tones: ToneRamps }

declare module 'claude-code' {
  interface PluginState {
    'plan-pane': {
      // The plan shown, with progress merged in; null before any plan is found.
      plan: Shaped<Plan | null>
      flash: Shaped<Flash>
      // Plan paths this mod shows, so Rods Rack's Markdown viewer doesn't also offer them. Set to []
      // at session start, which also tells Rods Rack this mod is installed.
      claimed: string[]
      // The plan path Claude was last told about with a one-time note, so a re-read or edit of
      // the same plan doesn't repeat it; null before any.
      announced: string | null
    }
  }
}
