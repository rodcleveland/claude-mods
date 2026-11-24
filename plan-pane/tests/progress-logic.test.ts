import { expect, test } from 'claude-code/testing'

import type { Milestone, MilestoneStatus, Plan, PlanSection } from '../types'
import { applyStatus, flashesFor, fromTaskStatus, rowsFor, unitIdsIn, withProgress } from '../hooks/progress-logic'

// Plans built by hand, so these tests don't lean on the parser.
const ms = (id: string, status: MilestoneStatus = 'todo', label = `${id} work`): Milestone => ({ id, label, status })
const section = (id: string, milestones: Milestone[] = [], title = id.replace(/^s:/, '')): PlanSection => ({
  id,
  title,
  milestones,
})
const plan = (sections: PlanSection[], path = 'docs/plans/cal.md'): Plan => ({ path, title: 'Calendar plan', sections })

const base = () =>
  plan([
    section('s:overview'),
    section('s:units', [ms('U1'), ms('U2'), ms('U3')]),
    section('s:phases', [ms('phase-1'), ms('phase-2')]),
  ])

// The same plan with some milestones moved on.
const moved = (p: Plan, to: Record<string, MilestoneStatus>): Plan => withProgress(p, to)

test('unit ids come out of task subjects in order, once each', () => {
  expect(unitIdsIn('U3: Calendar view')).toEqual(['U3'])
  expect(unitIdsIn('Finish U4 and U5')).toEqual(['U4', 'U5'])
  expect(unitIdsIn('U12b. Edge cases, then U2')).toEqual(['U12b', 'U2'])
  expect(unitIdsIn('U3 again: redo U3 and U3')).toEqual(['U3'])
  expect(unitIdsIn('Task 2 - API')).toEqual(['task-2'])
  expect(unitIdsIn('phase 1 then PHASE 3, unit 4')).toEqual(['phase-1', 'phase-3', 'unit-4'])
  expect(unitIdsIn('U2 before Task 1 before U1')).toEqual(['U2', 'task-1', 'U1'])
})

test('lookalikes are not unit ids', () => {
  expect(unitIdsIn('Fix UTF8 decoding in the U.S. build')).toEqual([])
  expect(unitIdsIn('u3 lower case, MU3, U3x9, U3abc')).toEqual([])
  expect(unitIdsIn('subtask 2, Tasks 3, multiphase 4')).toEqual([])
  expect(unitIdsIn('')).toEqual([])
})

test('unit ranges expand, capped at 30', () => {
  expect(unitIdsIn('U3–U5 together')).toEqual(['U3', 'U4', 'U5'])
  expect(unitIdsIn('U3-U5')).toEqual(['U3', 'U4', 'U5'])
  expect(unitIdsIn('U3 — U4, then U9')).toEqual(['U3', 'U4', 'U9'])
  // Backwards or lettered ranges keep only their ends.
  expect(unitIdsIn('U5-U3')).toEqual(['U5', 'U3'])
  expect(unitIdsIn('U3a-U3c')).toEqual(['U3a', 'U3c'])
  const long = unitIdsIn('U1-U500')
  expect(long.length).toBe(30)
  expect(long[0]).toBe('U1')
  expect(long[29]).toBe('U30')
  // Overlaps de-duplicate.
  expect(unitIdsIn('U2, U1-U3')).toEqual(['U2', 'U1', 'U3'])
})

test('task statuses map to milestone statuses', () => {
  expect(fromTaskStatus('pending')).toBe('todo')
  expect(fromTaskStatus('in_progress')).toBe('active')
  expect(fromTaskStatus('completed')).toBe('done')
  expect(fromTaskStatus('deleted')).toBe(null)
  expect(fromTaskStatus(undefined)).toBe(null)
})

test('applyStatus returns a new object and leaves the old one alone', () => {
  const before = { U1: 'done' as const }
  const after = applyStatus(before, ['U2', 'U3'], 'active')
  expect(after).toEqual({ U1: 'done', U2: 'active', U3: 'active' })
  expect(before).toEqual({ U1: 'done' })
  expect(after === before).toBe(false)
  expect(applyStatus(after, ['U1'], 'todo').U1).toBe('todo')
})

test('withProgress takes the further-along status and never mutates', () => {
  const p = plan([section('s:units', [ms('U1', 'done'), ms('U2', 'active'), ms('U3'), ms('U4')])])
  const merged = withProgress(p, { U1: 'todo', U2: 'done', U3: 'active', other: 'done' })
  expect(merged.sections[0]!.milestones.map((m) => m.status)).toEqual(['done', 'done', 'active', 'todo'])
  expect(p.sections[0]!.milestones.map((m) => m.status)).toEqual(['done', 'active', 'todo', 'todo'])
  expect(merged === p).toBe(false)
  expect(merged.path).toBe(p.path)
  expect(merged.title).toBe(p.title)
})

test('a first or different plan lights nothing', () => {
  expect(flashesFor(null, base())).toEqual({})
  const other = { ...moved(base(), { U1: 'done' }), path: 'docs/plans/other.md' }
  expect(flashesFor(base(), other)).toEqual({})
  expect(flashesFor(base(), base())).toEqual({})
})

test('new sections and milestones light purple', () => {
  const before = base()
  const after = plan([...before.sections.slice(0, 1), section('s:units', [ms('U1'), ms('U2'), ms('U3'), ms('U4')]), section('s:extra', [ms('U9')]), ...before.sections.slice(2)])
  expect(flashesFor(before, after)).toEqual({ 'm:U4': 'purple', 's:extra': 'purple', 'm:U9': 'purple' })
})

test('started work lights orange, finished work green, sections with it', () => {
  const before = base()
  expect(flashesFor(before, moved(before, { U1: 'active' }))).toEqual({ 'm:U1': 'orange', 's:units': 'orange' })
  // One done but not all: the milestone is green, its section orange.
  expect(flashesFor(before, moved(before, { U2: 'done' }))).toEqual({ 'm:U2': 'green', 's:units': 'orange' })
  // The last one done: the section goes green.
  const nearly = moved(before, { U1: 'done', U2: 'done' })
  expect(flashesFor(nearly, moved(nearly, { U3: 'done' }))).toEqual({ 'm:U3': 'green', 's:units': 'green' })
  // Straight from todo to all done in one step is green too.
  expect(flashesFor(before, moved(before, { 'phase-1': 'done', 'phase-2': 'done' }))).toEqual({
    'm:phase-1': 'green',
    'm:phase-2': 'green',
    's:phases': 'green',
  })
})

test('unchanged or backward moves light nothing', () => {
  const before = moved(base(), { U1: 'done', U2: 'active' })
  const back = plan(before.sections.map((s) => ({ ...s, milestones: s.milestones.map((m) => ({ ...m, status: 'todo' as const })) })))
  expect(flashesFor(before, back)).toEqual({})
  expect(flashesFor(before, moved(before, { U2: 'active' }))).toEqual({})
})

test('a new section keeps purple even when its milestones are done', () => {
  const before = base()
  const after = plan([...before.sections, section('s:late', [ms('U7', 'done')])])
  expect(flashesFor(before, after)).toEqual({ 's:late': 'purple', 'm:U7': 'purple' })
})

test('rows show the header, sections and milestones with glyphs and counts', () => {
  const p = moved(base(), { U1: 'done', U2: 'active' })
  const rows = rowsFor(p, {})
  expect(rows.map((r) => r.id)).toEqual(['header', 's:overview', 's:units', 'm:U1', 'm:U2', 'm:U3', 's:phases', 'm:phase-1', 'm:phase-2'])

  const [header, overview, units, u1, u2, u3] = rows
  expect(header).toEqual({ id: 'header', indent: 0, glyph: '', text: 'Calendar plan', bold: true, right: '1/5' })
  expect(overview).toEqual({ id: 's:overview', indent: 0, glyph: '•', text: 'overview', bold: true })
  expect(units).toEqual({ id: 's:units', indent: 0, glyph: '▾', text: 'units', bold: true, right: '1/3' })
  expect(u1).toEqual({ id: 'm:U1', indent: 2, glyph: '✓', glyphColor: '#22c55e', text: 'U1 work', dim: true })
  expect(u2).toEqual({ id: 'm:U2', indent: 2, glyph: '●', glyphColor: '#f97316', text: 'U2 work' })
  expect(u3).toEqual({ id: 'm:U3', indent: 2, glyph: '○', glyphColor: '#6b7280', text: 'U3 work' })
  expect(rows.find((r) => r.id === 's:phases')!.right).toBe('0/2')
  expect(rows.some((r) => r.tone)).toBe(false)
})

test('a plan with no milestones has no counts', () => {
  const rows = rowsFor(plan([section('s:notes')]), {})
  expect(rows.length).toBe(2)
  expect('right' in rows[0]!).toBe(false)
  expect('right' in rows[1]!).toBe(false)
})

test('lit rows carry their tone', () => {
  const rows = rowsFor(base(), { header: 'purple', 's:units': 'orange', 'm:U2': 'green', 'm:gone': 'purple' })
  const tones = Object.fromEntries(rows.filter((r) => r.tone).map((r) => [r.id, r.tone]))
  expect(tones).toEqual({ header: 'purple', 's:units': 'orange', 'm:U2': 'green' })
})
