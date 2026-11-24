import { expect, mock, test } from 'claude-code/testing'

import type { Flash, Plan } from '../types'

const PATH = '/repo/docs/plans/2026-11-24-calendar-plan.md'
const PLAN_TEXT = `---
title: Calendar - Plan
---

# Calendar - Plan

## Implementation Units

### U1. Data model

### U2. Calendar view

### U3. Reminders
`

const PANE = {
  plugin: 'plan-pane',
  component: 'Pane',
  requestId: 'plan-pane',
  props: { title: 'Plan', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// The last value the plugin wrote to each key of its state, the shape tag taken off where the
// atom keeps one. Recorded on the way down; the engine's own state still keeps it.
const written: Record<string, unknown> = {}
function recordState(on: any) {
  for (const k of Object.keys(written)) delete written[k]
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.plugin === 'plan-pane') {
      const v = e.value
      written[e.key] = v !== null && typeof v === 'object' && 'shape' in v ? v.value : v
    }
    return next(e)
  })
}

const plan = () => (written.plan ?? null) as Plan | null
const flash = () => (written.flash ?? { ids: {}, generation: 0 }) as Flash
const claimed = () => written.claimed as string[] | undefined
const milestone = (p: Plan | null, id: string) => p?.sections.flatMap(s => s.milestones).find(m => m.id === id)

// Answers the built-in tools beneath the plugin as core would, records how often a pane opened,
// and keeps the store and the clock in memory.
function world(on: any, stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
  const clock = mock.clock(on)
  recordState(on)
  const w = { opened: 0, toasts: [] as string[], clock, tools: [] as any[], notes: [] as string[] }
  on('command.register', () => ({ value: undefined }))
  on('tool.register', (_$: any, e: any) => {
    w.tools.push(e)
    return { value: undefined }
  })
  on('session.append', (_$: any, e: any, next: any) => {
    if (e.message.type === 'user') w.notes.push(e.message.content.map((b: any) => b.text).join(''))
    return next(e)
  })
  on('tool.call', { tool: 'Read' }, (_$: any, e: any) => ({
    result: { type: 'text', file: { filePath: e.file_path, content: PLAN_TEXT } },
  }))
  on('session.start', (_$: any, e: any) => e)
  on('ui.invalidate', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, (_$: any, e: any) => ({ result: { oldTodos: [], newTodos: e.todos } }))
  on('ui.open', () => {
    w.opened += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(String(e.text ?? e.message ?? e))
    return { value: undefined }
  })
  on('fs.read', (_$: any, e: any, next: any) => (e.path === PATH ? { value: PLAN_TEXT } : next(e)))
  on('tool.call', { tool: 'Write' }, (_$: any, e: any) => ({
    result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null },
  }))
  let nextId = 1
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => ({ result: { task: { id: String(nextId++), subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))
  return w
}

const writePlan = ($: any) => $.tool.call({ tool: 'Write', file_path: PATH, content: PLAN_TEXT } as never)

test('the pane never opens at session start', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect(w.opened).toBe(0)
  expect(claimed()).toEqual([])
})

test('session start brings back the last plan with its progress, still unopened', async ($, on) => {
  const w = world(on, { last: PATH, [`progress:${PATH}`]: { U1: 'done' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect(w.opened).toBe(0)
  expect(milestone(plan(), 'U1')?.status).toBe('done')
  expect(claimed()).toEqual([PATH])
})

test('/planpane opens the pane, /planpane close closes it', async ($, on) => {
  const w = world(on)
  const ran = await $.command.run({ command: 'planpane', args: '' } as never)
  expect(w.opened).toBe(1)
  expect(String(ran.text)).toContain('opened')
  const closed = await $.command.run({ command: 'planpane', args: 'close' } as never)
  expect(String(closed.text)).toContain('closed')
})

test('a narrow window gets the widen toast', async ($, on) => {
  mock.store(on)
  const toasts: string[] = []
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }))
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  await $.command.run({ command: 'planpane', args: '' } as never)
  expect(toasts.join(' ')).toContain('type /planpane again')
})

test('a Write of a plan document fills the state and claims its path', async ($, on) => {
  world(on)
  const ran = await writePlan($)
  expect(ran.deny).toBeUndefined()
  const p = plan()
  expect(p?.path).toBe(PATH)
  expect(p?.sections.flatMap(s => s.milestones).map(m => m.id)).toEqual(['U1', 'U2', 'U3'])
  expect(claimed()).toContain(PATH)
})

test('a Write outside a plans folder is left alone', async ($, on) => {
  world(on)
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/notes.md', content: PLAN_TEXT } as never)
  expect(plan()).toBeNull()
})

test('a task naming U2 marks it done and lights it green, then the light goes out', async ($, on) => {
  const w = world(on)
  await writePlan($)
  const created = await $.tool.call({ tool: 'TaskCreate', subject: 'U2: Calendar view', description: 'Build it' } as never)
  const id = (created.result as { task: { id: string } }).task.id
  await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: 'in_progress' } as never)
  expect(milestone(plan(), 'U2')?.status).toBe('active')
  expect((flash()).ids['m:U2']).toBe('orange')

  await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: 'completed' } as never)
  expect(milestone(plan(), 'U2')?.status).toBe('done')
  expect((flash()).ids['m:U2']).toBe('green')
  expect(milestone(plan(), 'U1')?.status).toBe('todo')

  await w.clock.advance(3000)
  expect((flash()).ids).toEqual({})
})

test('a to-do list naming units moves them too', async ($, on) => {
  world(on)
  await writePlan($)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'U1: Data model', status: 'completed', activeForm: 'Modelling' },
      { content: 'U3: Reminders', status: 'in_progress', activeForm: 'Reminding' },
    ],
  } as never)
  const p = plan()
  expect(milestone(p, 'U1')?.status).toBe('done')
  expect(milestone(p, 'U3')?.status).toBe('active')
})

for (const surface of ['terminal', 'vscode'] as const) {
  test(`the pane draws the plan's milestones (${surface})`, async ($, on) => {
    world(on)
    const empty = await $.ui.mount({ ...PANE, surface })
    expect(await empty.find({ type: 'Text', text: /No plan yet/ })).toBeDefined()
    await empty.unmount()

    await writePlan($)
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      expect(await ui.find({ key: 'plan-rows' })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Text', text: /Calendar view/ })).toBeDefined()
    }
    await ui.unmount()
  })
}

test("a helper agent's plan and task moves count too", async ($, on) => {
  world(on)
  await $.tool.call({ tool: 'Write', file_path: PATH, content: PLAN_TEXT, agentId: 'helper-1' } as never)
  expect(plan()?.path).toBe(PATH)
  const created = await $.tool.call({ tool: 'TaskCreate', subject: 'U3: Reminders', description: 'x', agentId: 'helper-1' } as never)
  const id = (created.result as { task: { id: string } }).task.id
  await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: 'completed', agentId: 'helper-1' } as never)
  expect(milestone(plan(), 'U3')?.status).toBe('done')
})

const MARK = 'mcp__plan-pane__mark_milestone'
const markMilestone = ($: any, ids: unknown, status: unknown) => $.tool.call({ tool: MARK, ids, status } as never)

test('session start registers mark_milestone, offered from the start', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const spec = w.tools.find(t => t.name === 'mark_milestone')
  expect(spec).toBeDefined()
  expect(spec.isDeferred).toBe(false)
  expect(spec.inputSchema.properties.status.enum).toEqual(['started', 'done', 'not_started'])
})

test('mark_milestone marks a milestone done, lights it green and says so', async ($, on) => {
  world(on)
  await writePlan($)
  const ran = await markMilestone($, ['U2'], 'done')
  expect(String(ran.result)).toBe('Marked U2 done. 1 of 3 done.')
  expect(milestone(plan(), 'U2')?.status).toBe('done')
  expect(flash().ids['m:U2']).toBe('green')
})

test('mark_milestone takes ids in any case and ranges', async ($, on) => {
  world(on)
  await writePlan($)
  await markMilestone($, ['u1', 'U2–U3'], 'started')
  const p = plan()
  expect(['U1', 'U2', 'U3'].map(id => milestone(p, id)?.status)).toEqual(['active', 'active', 'active'])
  await markMilestone($, ['U1'], 'not_started')
  expect(milestone(plan(), 'U1')?.status).toBe('todo')
})

test('mark_milestone names an id the plan lacks and lists the real ones', async ($, on) => {
  world(on)
  await writePlan($)
  const ran = await markMilestone($, ['U9'], 'done')
  expect(String(ran.result)).toBe('Not in the plan: U9. Its milestone ids: U1, U2, U3. 0 of 3 done.')
  expect(milestone(plan(), 'U1')?.status).toBe('todo')
})

test('mark_milestone with no plan loaded marks nothing and says so', async ($, on) => {
  world(on)
  const ran = await markMilestone($, ['U1'], 'done')
  expect(String(ran.result)).toContain('No plan is loaded')
})

test('mark_milestone refuses an unknown status or no ids', async ($, on) => {
  world(on)
  await writePlan($)
  expect((await markMilestone($, ['U1'], 'finished')).deny).toContain('status must be')
  expect((await markMilestone($, [], 'done')).deny).toContain('ids needs')
})

test('a plan that loads mid-conversation tells Claude its ids once', async ($, on) => {
  const w = world(on)
  await writePlan($)
  expect(w.notes).toHaveLength(1)
  expect(w.notes[0]).toContain('Calendar')
  expect(w.notes[0]).toContain('U1, U2, U3')
  expect(w.notes[0]).toContain(MARK)
  await $.tool.call({ tool: 'Read', file_path: PATH } as never)
  await writePlan($)
  expect(w.notes).toHaveLength(1)
})

test('a plan brought back at session start sends no note', async ($, on) => {
  const w = world(on, { last: PATH })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect(plan()?.path).toBe(PATH)
  expect(w.notes).toHaveLength(0)
})
