import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyHelperProgress, IDLE_MISSION, addQueued, claimSlot, launchedAgent, parseSize, summary } from '../hooks/dock-logic'

const AGENT_DONE = { result: { agentId: 'a1', content: [], totalToolUseCount: 0, totalDurationMs: 0 } }
const PANE = {
  plugin: 'rods-rack',
  component: 'Pane',
  requestId: 'rods-rack-dock',
  props: { title: 'Agent Dock', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The test stands for the engine beneath the plugin: a clock, a store and an environment in memory,
// panes it keeps open, a status line it records, and Agent calls it answers when `release` says.
function engine(on: On, store: Record<string, unknown> = {}, env: Record<string, string> = {}, answer: unknown = AGENT_DONE) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, store)
  mock.env(on, env)
  const panes = new Set<string>()
  const status: Array<string | undefined> = []
  const sent: Array<{ text: string; context: readonly string[]; origin: string }> = []
  let gate: Promise<void> = Promise.resolve()
  let open: () => void = () => undefined

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__rods-rack__${e.name}` } }) as never)
  on('ui.status', ($, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.open', ($, e) => {
    panes.add(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined } as never
  })
  on('ui.panes', () =>
    ({ value: [...panes].map(id => ({ id, title: 'Agent Dock', isShown: true, isFocused: false, isPlaced: true })) }) as never,
  )
  // The queue's one-second wait: held while the helpers are held, so a queued call waits rather than spins.
  on('process.run', async () => {
    await gate
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    sent.push({ text: e.text, context: e.context ?? [], origin: e.origin.kind })
    return { text: e.text }
  })
  on('tool.call', { tool: 'Agent' }, async () => {
    await gate
    return answer as never
  })
  const hold = () => {
    gate = new Promise(resolve => (open = resolve))
  }
  const release = () => open()
  return { clock, panes, status, sent, hold, release }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const agent = (description: string) => ({ tool: 'Agent', description, prompt: `Do: ${description}` }) as never
const drawn = async (mounted: { drawn: () => Promise<unknown> }) => JSON.stringify(await mounted.drawn())

test('parseSize takes a whole number from 1 to 100', async () => {
  expect(parseSize('10')).toBe(10)
  expect(parseSize(' 25 ')).toBe(25)
  for (const bad of ['0', '101', 'abc', '2.5', '', '-3']) expect(parseSize(bad)).toBeNull()
})

test('a saved size of 50 comes back as 1; 10 stays 10', async ($, on) => {
  engine(on, { dockSize: 50 })
  await start($)
  expect((await $.command.run({ command: 'dock', args: '' } as never)).text).toContain('Team Size 1')

  await $.command.run({ command: 'dock', args: '10' } as never)
  await start($)
  expect((await $.command.run({ command: 'dock', args: '' } as never)).text).toContain('Team Size 10')
})

test('at size 5 a request carries the exactly-5 instruction; at size 1 nothing', async ($, on) => {
  const { sent } = engine(on)
  await start($)

  await $.prompt.submit(typed('Research bakery pricing in five cities'))
  expect(sent.at(-1)!.context).toHaveLength(0)

  expect((await $.command.run({ command: 'dock', args: '5' } as never)).text).toBe('Team Size is 5.')
  await $.prompt.submit(typed('Research bakery pricing in five cities'))
  expect(sent.at(-1)!.context.join('\n')).toContain('exactly 5 independent pieces')
  expect(sent.at(-1)!.context.join('\n')).toContain('report_progress')

  // A short reply carries nothing.
  await $.prompt.submit(typed('ok thanks'))
  expect(sent.at(-1)!.context).toHaveLength(0)
})

test('the 6th Agent call at size 5 is denied with the Team Size message', async ($, on) => {
  engine(on)
  await start($)
  await $.command.run({ command: 'dock', args: '5' } as never)
  await $.prompt.submit(typed('Price check five bakeries in Jacksonville'))

  for (let i = 1; i <= 5; i += 1) expect((await $.tool.call(agent(`Price check: Bakery ${i}`))).deny).toBeUndefined()
  const sixth = await $.tool.call(agent('Price check: Bakery 6'))
  expect(sixth.deny).toBe('Team Size is 5: this request already has 5 helpers. Finish with the helpers you have.')
})

test('a request that used 3 of 10 gets exactly one nudge', async ($, on) => {
  const { sent, clock } = engine(on)
  await start($)
  await $.command.run({ command: 'dock', args: '10' } as never)
  await $.prompt.submit(typed('Research ten bakery competitors'))
  for (const name of ['Panera', 'Crumbl', 'Publix']) await $.tool.call(agent(`Price check: ${name}`))

  const done = { answer: 'Here you go.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const
  await $.turn.complete(done)
  await clock.settle()
  await $.turn.complete({ ...done, turnId: 't2' })
  await clock.settle()

  const nudges = sent.filter(s => s.text.startsWith('You used 3 of 10 helpers'))
  expect(nudges).toHaveLength(1)
  expect(nudges[0]!.text).toContain('the other 7')
})

// Clean View's plan for the request: every step reported done, or the first one only. The engine
// starts the turn and answers the plan's tool calls.
function planned(on: On) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }) as never)
}

async function plan($: Engine, finishAll: boolean) {
  await $.turn.start({ text: 'Commit, pull and push my changes', turnId: 't1' })
  const steps = ['Save the changes', 'Get the latest', 'Send the changes']
  await $.tool.call({ tool: 'mcp__rods-rack__plan_steps', steps } as never)
  for (const task of finishAll ? steps : steps.slice(0, 1)) {
    await $.tool.call({ tool: 'mcp__rods-rack__report_progress', task, percent: 100 } as never)
  }
}

const ANSWERED = { answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('no nudge when every step of the plan is done, even with 0 of 5 helpers', async ($, on) => {
  const { sent, clock } = engine(on)
  planned(on)
  await start($)
  await $.command.run({ command: 'dock', args: '5' } as never)
  await $.prompt.submit(typed('Commit, pull and push my changes'))
  await plan($, true)

  await $.turn.complete(ANSWERED)
  await clock.settle()
  expect(sent.filter(s => s.text.startsWith('You used'))).toHaveLength(0)
})

test('a plan with steps left still gets the nudge', async ($, on) => {
  const { sent, clock } = engine(on)
  planned(on)
  await start($)
  await $.command.run({ command: 'dock', args: '5' } as never)
  await $.prompt.submit(typed('Commit, pull and push my changes'))
  await plan($, false)

  await $.turn.complete(ANSWERED)
  await clock.settle()
  expect(sent.filter(s => s.text.startsWith('You used 0 of 5 helpers'))).toHaveLength(1)
})

test('three Agent calls show queued, then working, then done cards', async ($, on) => {
  const { clock, hold, release } = engine(on, {}, { CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '2' })
  await start($)
  await $.command.run({ command: 'dock', args: '3' } as never)
  await $.prompt.submit(typed('Price check three bakeries'))

  hold()
  const calls = ['Panera', 'Crumbl', 'Publix'].map(name => $.tool.call(agent(`Price check: ${name}`)))
  await clock.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const live = await drawn(pane)
  expect(live).toContain('Price check: Panera')
  expect(live).toContain('Working')
  expect(live).toContain('Queued')
  expect(live).toContain('L I V E')

  release()
  await Promise.all(calls)
  await pane.redraw(PANE.props)
  const after = await drawn(pane)
  expect(after).toContain('100%')
  expect(after).not.toContain('Queued')
})

test('a helper report of 60 moves its card to 60%', async () => {
  let mission = addQueued(IDLE_MISSION, 'tu1', 'Price check: Panera', 0)
  mission = claimSlot(mission, 'tu1', 10, 0).mission
  mission = applyHelperProgress(mission, { agentId: 'a1', description: 'Price check: Panera', task: 'Price check: Panera', percent: 60 })
  expect(mission.cards[0]).toMatchObject({ agentId: 'a1', percent: 60, hasReported: true, status: 'working' })

  // Later reports find the card by its agent, whatever task they name.
  mission = applyHelperProgress(mission, { agentId: 'a1', description: null, task: 'something else', percent: 90 })
  expect(mission.cards[0]!.percent).toBe(90)
})

test('a helper that reports 100 shows 99% until its call returns', async () => {
  let mission = addQueued(IDLE_MISSION, 'tu1', 'Price check: Panera', 0)
  mission = claimSlot(mission, 'tu1', 10, 0).mission
  mission = applyHelperProgress(mission, { agentId: 'a1', description: 'Price check: Panera', task: 'Price check: Panera', percent: 100 })
  expect(mission.cards[0]).toMatchObject({ percent: 99, status: 'working' })
})

test('a background helper stays working until its own turn ends', async ($, on) => {
  // This engine launches every Agent call in the background, as the Agent tool does by default.
  const launched = { result: { status: 'async_launched', agentId: 'a1', description: 'Price check: Panera', prompt: '', outputFile: '' } }
  const { clock } = engine(on, {}, {}, launched)
  await start($)
  await $.command.run({ command: 'dock', args: '3' } as never)
  await $.prompt.submit(typed('Price check three bakeries'))
  await $.tool.call(agent('Price check: Panera'))
  // The request's turn ends with the helper still out: the dock stays live, the card working.
  await $.turn.complete(ANSWERED)
  await clock.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const live = await drawn(pane)
  expect(live).toContain('Working')
  expect(live).not.toContain('100%')
  expect(live).toContain('L I V E')

  await $.turn.complete({ ...ANSWERED, turnId: 'h1', agentId: 'a1' })
  await clock.settle()
  await pane.redraw(PANE.props)
  expect(await drawn(pane)).toContain('100%')
  expect(launchedAgent({ agentId: 'a1', content: [] })).toBeNull()
})

test('when all are done the dock shows "3 agents finished <job> in …"', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.command.run({ command: 'dock', args: '3' } as never)
  await $.prompt.submit(typed('Research bakery pricing, then compare them'))
  for (const name of ['Panera', 'Crumbl', 'Publix']) await $.tool.call(agent(`Price check: ${name}`))
  await clock.advance(134_000)
  await $.turn.complete({ answer: 'Done.', durationMs: 134_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const text = await drawn(await $.ui.mount({ ...PANE, surface: 'terminal' }))
  expect(text).toContain('3 agents finished Research bakery pricing in')
  expect(text).toContain('C O M P L E T E')
  expect(summary({ ...IDLE_MISSION, name: 'X', cards: [], startedAt: 0, finishedAt: 134_000 }, 0)).toBe('0 agents finished X in 2m 14s')
})

test('/dock folds the pane to the status-line badge and back', async ($, on) => {
  const { panes, status, clock, hold, release } = engine(on)
  await start($)
  await $.command.run({ command: 'dock', args: '3' } as never)
  await $.command.run({ command: 'dock', args: '' } as never)
  await clock.settle()
  expect(panes.has('rods-rack-dock')).toBe(true)

  await $.prompt.submit(typed('Price check three bakeries'))
  hold()
  const calls = ['Panera', 'Crumbl'].map(name => $.tool.call(agent(`Price check: ${name}`)))
  await clock.settle()

  await $.command.run({ command: 'dock', args: '' } as never)
  await clock.settle()
  expect(panes.has('rods-rack-dock')).toBe(false)
  expect(status.at(-1)).toBe('2 working · 0 queued · 0 done')

  await $.command.run({ command: 'dock', args: '' } as never)
  await clock.settle()
  expect(panes.has('rods-rack-dock')).toBe(true)
  expect(status.at(-1)).toBeUndefined()

  release()
  await Promise.all(calls)
})

test('a pinned model stays on the status line when the dock folds', async ($, on) => {
  const { panes, status, clock, hold } = engine(on, {
    prefs: { model: 'haiku', effort: null, promptUpgrade: false, helper: 'same', autoModel: false, autoPrevious: null, autoUnavailable: [] },
  })
  await start($)
  await $.command.run({ command: 'dock', args: '3' } as never)
  await $.command.run({ command: 'dock', args: '' } as never)
  await clock.settle()

  await $.prompt.submit(typed('Price check three bakeries'))
  hold()
  const calls = ['Panera', 'Crumbl'].map(name => $.tool.call(agent(`Price check: ${name}`)))
  await clock.settle()

  await $.command.run({ command: 'dock', args: '' } as never)
  await clock.settle()
  expect(panes.has('rods-rack-dock')).toBe(false)
  expect(status.at(-1)).toBe('Rods Rack: Haiku 5.5  ·  2 working · 0 queued · 0 done')
})
