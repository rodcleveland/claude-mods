import type { FlashTone, Milestone, MilestoneStatus, PaneRow, Plan, PlanProgress } from '../types'

// Plan Pane's progress and view logic, with no engine calls. OWNER: the progress helper.

// The most ids one range ("U1–U40") expands to, so a stray number can't flood progress.
const MAX_RANGE = 30

// U-ids, with an optional range to a second U-id: "U3", "U12b", "U3–U5", "U3 - U5". The trailing \b
// keeps "UTF8" and "U.S." out (no digit right after the U).
const U_ID = /\bU(\d+)([a-z]?)(?:\s*[-–—]\s*U(\d+)([a-z]?))?\b/g

// "Task 2", "phase 1", "UNIT 4": the named forms milestoneId lowercases.
const NAMED_ID = /\b(task|phase|unit)\s+(\d+)\b/gi

// The milestone ids a task subject or to-do text names, using the ids milestoneId (plan-logic.ts)
// makes: "U3: Calendar view" -> ["U3"]; "Finish U4 and U5" -> ["U4", "U5"]; "Task 2 - API" -> ["task-2"].
// De-duplicated, in order of appearance; "U3–U5" expands to U3, U4, U5.
export function unitIdsIn(text: string): string[] {
  const found: { at: number; ids: string[] }[] = []
  for (const m of text.matchAll(U_ID)) {
    const [, from, fromSuffix, to, toSuffix] = m
    const start = Number(from)
    const end = Number(to)
    // A plain range of whole units expands; a lettered or backwards one keeps just its two ends.
    if (to !== undefined && !fromSuffix && !toSuffix && end > start) {
      const ids: string[] = []
      for (let n = start; n <= end && ids.length < MAX_RANGE; n++) ids.push(`U${n}`)
      found.push({ at: m.index, ids })
    } else {
      const ids = [`U${from}${fromSuffix}`]
      if (to !== undefined) ids.push(`U${to}${toSuffix}`)
      found.push({ at: m.index, ids })
    }
  }
  for (const m of text.matchAll(NAMED_ID)) {
    found.push({ at: m.index, ids: [`${m[1]!.toLowerCase()}-${m[2]}`] })
  }
  found.sort((a, b) => a.at - b.at)
  return [...new Set(found.flatMap((f) => f.ids))]
}

// A TodoWrite / TaskCreate / TaskUpdate status as a milestone status: pending -> todo,
// in_progress -> active, completed -> done; anything else (deleted, unknown) -> null.
export function fromTaskStatus(status: string | undefined): MilestoneStatus | null {
  switch (status) {
    case 'pending':
      return 'todo'
    case 'in_progress':
      return 'active'
    case 'completed':
      return 'done'
    default:
      return null
  }
}

// The statuses mark_milestone takes, as milestone statuses.
export const MARK_STATUS: Readonly<Record<string, MilestoneStatus>> = { started: 'active', done: 'done', not_started: 'todo' }

// The plan's milestone ids that the ids a caller gave name, and the ones that name none. Each given id
// matches a plan id exactly (any case: "u3", "TASK-2"), else by the ids its text names ("U3–U5",
// "Task 2"), so a caller may pass an id or a heading. De-duplicated, in order.
export function resolveIds(given: readonly string[], known: readonly string[]): { ids: string[]; unknown: string[] } {
  const byLower = new Map(known.map((id) => [id.toLowerCase(), id]))
  const ids: string[] = []
  const unknown: string[] = []
  for (const raw of given) {
    const text = raw.trim()
    if (text === '') continue
    const exact = byLower.get(text.toLowerCase())
    const found =
      exact !== undefined
        ? [exact]
        : unitIdsIn(text).flatMap((id) => {
            const hit = byLower.get(id.toLowerCase())
            return hit === undefined ? [] : [hit]
          })
    if (found.length === 0) unknown.push(text)
    else ids.push(...found)
  }
  return { ids: [...new Set(ids)], unknown }
}

// progress with each of ids set to status. A new object: the one given is never changed.
export function applyStatus(progress: PlanProgress, ids: readonly string[], status: MilestoneStatus): PlanProgress {
  const next: PlanProgress = { ...progress }
  for (const id of ids) next[id] = status
  return next
}

const RANK: Record<MilestoneStatus, number> = { todo: 0, active: 1, done: 2 }

// The further-along of two statuses.
const furthest = (a: MilestoneStatus, b: MilestoneStatus | undefined): MilestoneStatus =>
  b !== undefined && RANK[b] > RANK[a] ? b : a

// The plan with progress merged in. A milestone takes the further-along of its file status and
// its task status (todo < active < done). A new Plan; the one given is never changed.
export function withProgress(plan: Plan, progress: PlanProgress): Plan {
  return {
    ...plan,
    sections: plan.sections.map((s) => ({
      ...s,
      milestones: s.milestones.map((m) => ({ ...m, status: furthest(m.status, progress[m.id]) })),
    })),
  }
}

const allDone = (ms: readonly Milestone[]) => ms.length > 0 && ms.every((m) => m.status === 'done')

// The rows to light after a change from before to after (row ids as rowsFor makes them):
// purple for a section or milestone that is new, orange for one that became active, green for one
// that became done. A section lights with its milestones: green when they all just became done,
// orange when any rose. before null, or another plan (a new path), lights nothing: a plan that
// just loaded doesn't shimmer as a whole.
export function flashesFor(before: Plan | null, after: Plan): Record<string, FlashTone> {
  if (!before || before.path !== after.path) return {}
  const lit: Record<string, FlashTone> = {}
  const oldSections = new Map(before.sections.map((s) => [s.id, s]))
  const oldStatus = new Map<string, MilestoneStatus>()
  for (const s of before.sections) for (const m of s.milestones) if (!oldStatus.has(m.id)) oldStatus.set(m.id, m.status)

  for (const s of after.sections) {
    const oldSection = oldSections.get(s.id)
    if (!oldSection) lit[s.id] = 'purple'
    let rose = false
    for (const m of s.milestones) {
      const was = oldStatus.get(m.id)
      if (was === undefined) {
        lit[`m:${m.id}`] = 'purple'
      } else if (RANK[m.status] > RANK[was]) {
        lit[`m:${m.id}`] = m.status === 'done' ? 'green' : 'orange'
        rose = true
      }
    }
    // A new section stays purple; an old one follows its milestones.
    if (oldSection && rose) lit[s.id] = allDone(s.milestones) && !allDone(oldSection.milestones) ? 'green' : 'orange'
  }
  return lit
}

// Glyph colours, plain hex so every surface reads them.
const GREEN = '#22c55e'
const ORANGE = '#f97316'
// The todo glyph's dim grey.
const GREY = '#6b7280'

const doneCount = (ms: readonly Milestone[]) => ms.filter((m) => m.status === 'done').length

// The "done/total" note, or nothing when there are no milestones to count.
const count = (ms: readonly Milestone[]): { right?: string } =>
  ms.length > 0 ? { right: `${doneCount(ms)}/${ms.length}` } : {}

// The pane's lines: a header row (plan title, "done/total" on the right), then each section and
// its milestones indented under it, with status glyphs ✓ done, ● active, ○ todo. lit marks rows
// to shimmer. Row ids: "header", a section's id, and a milestone's id prefixed "m:".
export function rowsFor(plan: Plan, lit: Record<string, FlashTone>): PaneRow[] {
  const all = plan.sections.flatMap((s) => s.milestones)
  const rows: PaneRow[] = [
    { id: 'header', indent: 0, glyph: '', text: plan.title, bold: true, ...count(all) },
  ]
  for (const s of plan.sections) {
    const has = s.milestones.length > 0
    rows.push({ id: s.id, indent: 0, glyph: has ? '▾' : '•', text: s.title, bold: true, ...count(s.milestones) })
    for (const m of s.milestones) {
      const row: PaneRow = { id: `m:${m.id}`, indent: 2, glyph: '○', glyphColor: GREY, text: m.label }
      if (m.status === 'done') Object.assign(row, { glyph: '✓', glyphColor: GREEN, dim: true })
      else if (m.status === 'active') Object.assign(row, { glyph: '●', glyphColor: ORANGE })
      rows.push(row)
    }
  }
  for (const row of rows) {
    const tone = lit[row.id]
    if (tone) row.tone = tone
  }
  return rows
}
