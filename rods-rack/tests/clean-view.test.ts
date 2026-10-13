import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cleanName, JOB_COLORS, overallProgress } from '../hooks/clean-view'

const PLAN = 'mcp__rods-rack__plan_steps'
const REPORT = 'mcp__rods-rack__report_progress'
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BAND = {
  plugin: 'rods-rack',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 29 },
    view: {},
  },
} as const

// The test stands for the engine beneath the plugin: a clock and a store in memory, the engine's own
// empty band, and every tool answered as a success.
function engine(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__rods-rack__${e.name}` } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('classic.Notification', () => ({}) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Build my landing page', usage: USAGE } }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  on('tool.call', () => ({ result: 'ok' }) as never)
  return clock
}

async function begin($: Engine, prompt = 'Make me a landing page with pricing and a contact form') {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: prompt, turnId: 't1' })
}

const drawn = async (band: { drawn: () => Promise<unknown> }) => JSON.stringify(await band.drawn())

test('names are cleaned to plain words', async () => {
  expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanName('Fix the header in src/components/Header and the nav')).toBe('Fix the header in and the nav')
  expect(cleanName('update Pricing.tsx styles')).toBe('Update styles')

  const long = cleanName('Rewrite the whole onboarding experience so that new customers understand every option')
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long.endsWith('…')).toBe(true)
  expect(cleanName('`npm test` src/a.ts')).toBe('Working on it')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a to-do list and a 60% report draw the checklist on ${surface}`, async ($, on) => {
    engine(on)
    await begin($)
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
        { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
        { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
        { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
      ],
    } as never)
    await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 60 } as never)

    const text = await drawn(await $.ui.mount({ ...BAND, surface }))
    expect(text).toContain('✓ ')
    expect(text).toContain('Read your brand notes')
    expect(text).toContain('██████████')
    expect(text).toContain('Done')
    expect(text).toContain('▶ ')
    expect(text).toContain('██████░░░░')
    expect(text).toContain('60%')
    expect(text).toContain('Next')
    expect(text).toContain('Up next')
    expect(text).toContain('Clean View: ON')
  })
}

test('a permission prompt shows Needs you', async ($, on) => {
  engine(on)
  await begin($)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })

  const text = await drawn(await $.ui.mount({ ...BAND, surface: 'terminal' }))
  expect(text).toContain('Needs you')
  expect(text).toContain('Claude needs your OK to continue')
  expect(text).toContain('‖ ')
})

test('/simple off hides the checklist and leaves the button', async ($, on) => {
  engine(on)
  await begin($)
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] } as never)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await drawn(band)).toContain('Read your brand notes')

  await $.command.run({ command: 'simple', args: 'off' } as never)
  await band.redraw(BAND.props)

  const text = await drawn(band)
  expect(text).not.toContain('Read your brand notes')
  expect(text).not.toContain('▶')
  expect((await band.find({ key: 'clean-view-toggle' }))?.text).toContain('Clean View: OFF')
})

test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  engine(on)
  await begin($)

  const planned = await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Polish the footer'] } as never)
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')

  const noted = await $.tool.call({ tool: REPORT, task: 'Read your brand notes', percent: 100 } as never)
  expect(noted.result).toBe('Progress noted: 100%.')

  const text = await drawn(await $.ui.mount({ ...BAND, surface: 'terminal' }))
  const done = text.indexOf('Read your brand notes')
  const active = text.indexOf('Build the pricing section')
  expect(text.lastIndexOf('✓ ', done)).toBeGreaterThan(-1)
  expect(text.slice(done, active)).toContain('Done')
  expect(text.slice(active)).toContain('Working')
  expect(text.slice(active)).toContain('Next')
})

test('a tool is denied before a plan exists and allowed after', async ($, on) => {
  engine(on)
  await begin($)

  const before = await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' } as never)
  expect(before.deny).toContain('plan_steps')

  const search = await $.tool.call({ tool: 'ToolSearch', query: 'select:plan_steps', max_results: 1 } as never)
  expect(search.deny).toBeUndefined()

  await $.tool.call({ tool: PLAN, steps: ['Look at your files', 'Tell you what is there'] } as never)
  const after = await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' } as never)
  expect(after.deny).toBeUndefined()
  expect(after.result).toBe('ok')
})

test('a finished job shows All done, then shrinks to one line after 5 seconds', async ($, on) => {
  const clock = engine(on)
  await begin($)
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] } as never)
  await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 100 } as never)
  await clock.advance(134_000)
  await $.turn.complete({ answer: 'Done.', durationMs: 134_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const before = await drawn(band)
  expect(before).toContain('✓ All done')
  expect(before).toContain('took ')
  expect(before).toContain('2m 14s')
  expect(before).toContain('Read your brand notes')

  await clock.advance(5000)
  await band.redraw(BAND.props)
  const after = await drawn(band)
  expect(after).toContain('✓ All done')
  expect(after).not.toContain('Read your brand notes')
})

test('Esc shows Stopped', async ($, on) => {
  engine(on)
  await begin($)
  await $.turn.complete({ answer: '', durationMs: 900, isAborted: true, turnId: 't1', reason: 'aborted' })

  const text = await drawn(await $.ui.mount({ ...BAND, surface: 'terminal' }))
  expect(text).toContain('■ Stopped')
  expect(text).toContain('you pressed Esc')
})

test('the checklist has a border in its job\'s color, and each job gets a new color', async ($, on) => {
  engine(on)
  await begin($)
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] } as never)

  const first = await drawn(await $.ui.mount({ ...BAND, surface: 'terminal' }))
  expect(first).toContain('"borderStyle":"round"')
  expect(first).toContain(`"borderColor":"${JOB_COLORS[0]}"`)

  // The desktop draws its own frame: no border there, the job's color still on the title.
  const desktop = await drawn(await $.ui.mount({ ...BAND, surface: 'desktop' }))
  expect(desktop).not.toContain('borderStyle')
  expect(desktop).toContain(JOB_COLORS[0])

  // A finished job: the next prompt starts a new one.
  await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 100 } as never)
  await $.turn.complete({ answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'Now write a short welcome email for new customers', turnId: 't2' })
  const second = await drawn(await $.ui.mount({ ...BAND, surface: 'terminal' }))
  expect(second).toContain(`"borderColor":"${JOB_COLORS[1]}"`)
})

test('with nothing running, the button stands alone with no border', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const text = await drawn(await $.ui.mount({ ...BAND, surface: 'terminal' }))
  expect(text).not.toContain('borderStyle')
  expect(text).toContain('Clean View: ON')
})

test('the whole job is counted as done steps plus the current step\'s percent', async () => {
  const task = (status: 'done' | 'active' | 'upcoming', percent = 0, hasReported = false) =>
    ({ id: status, name: status, status, percent, hasReported })
  expect(overallProgress([])).toEqual({ step: 0, total: 0, percent: 0 })
  expect(overallProgress([task('done', 100, true), task('active', 40, true), task('upcoming'), task('upcoming')]))
    .toEqual({ step: 2, total: 4, percent: 35 })
  expect(overallProgress([task('done', 100, true), task('active'), task('upcoming')])).toEqual({ step: 2, total: 3, percent: 33 })
  expect(overallProgress([task('done', 100, true), task('done', 100, true)])).toEqual({ step: 2, total: 2, percent: 100 })
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the checklist shows Step 2 of 4 and the job's percent on ${surface}`, async ($, on) => {
    engine(on)
    await begin($)
    const placeholders = await drawn(await $.ui.mount({ ...BAND, surface }))
    expect(placeholders).not.toContain('Step ')

    await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form', 'Polish the footer'] } as never)
    await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 40 } as never)

    const text = await drawn(await $.ui.mount({ ...BAND, surface }))
    expect(text).toContain('Step 2 of 4')
    // The percent is drawn as its number and its sign, two pieces of one Text.
    expect(text).toContain('"35","%"')
    expect(text.indexOf('Step 2 of 4')).toBeLessThan(text.indexOf('Read your brand notes'))
  })
}

test('the Rods Rack panel opens above the checklist, which stays just above the prompt', async ($, on) => {
  engine(on)
  await begin($)
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the page'] } as never)
  await $.command.run({ command: 'rods-rack', args: '' } as never)

  const text = await drawn(await $.ui.mount({ ...BAND, surface: 'terminal' }))
  expect(text).toContain('Read your brand notes')
  expect(text.indexOf('R O D S   R A C K')).toBeGreaterThan(-1)
  expect(text.indexOf('R O D S   R A C K')).toBeLessThan(text.indexOf('Read your brand notes'))
})
