import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PREFS = { model: null, effort: null, cleanView: false, promptUpgrade: false, helper: 'same' }
const PANEL = {
  plugin: 'rods-rack',
  component: 'Pane',
  requestId: 'rods-rack',
  props: {
    title: 'Rods Rack',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 16 },
    view: {},
  },
} as const

// The test stands for the engine beneath the plugin: it answers SessionStart and keeps the store.
// Every test hook is registered here, before the test first calls $.
function engine(on: On, initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial))
  const writes: Array<{ key: string; value: unknown }> = []
  on('classic.SessionStart', () => ({}) as never)
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    writes.push({ key: e.key, value: e.value })
    return { value: undefined } as never
  })
  return writes
}

const start = ($: Engine, source: 'startup' | 'clear') => $.classic.SessionStart({ source })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a toggle pressed on ${surface} is saved to the store`, async ($, on) => {
    const writes = engine(on)
    await start($, 'startup')
    const panel = await $.ui.mount({ ...PANEL, surface })

    await panel.press({ key: 'toggle-clean-view' })

    expect(writes.at(-1)).toMatchObject({ key: 'prefs', value: { cleanView: true } })
    expect((await panel.find({ key: 'toggle-clean-view' }))?.text).toContain('On')
  })
}

test('saved toggles come back after /clear', async ($, on) => {
  engine(on, { prefs: { ...PREFS, promptUpgrade: true, helper: 'balanced' } })

  await start($, 'clear')
  const panel = await $.ui.mount({ ...PANEL, surface: 'terminal' })

  expect((await panel.find({ key: 'toggle-prompt-upgrade' }))?.text).toContain('On')
  expect((await panel.find({ key: 'helper-cycle' }))?.text).toContain('Balanced')
})

for (const [helper, expected] of [['fast', 'haiku'], ['balanced', 'sonnet'], ['same', undefined]] as const) {
  test(`helper agents "${helper}" sends model ${expected ?? 'unchanged'}`, async ($, on) => {
    engine(on, { prefs: { ...PREFS, helper } })
    let model: unknown = 'not called'
    on('tool.call', { tool: 'Agent' }, ($, e) => {
      model = e.model
      return { result: { agentId: 'a1', content: [], totalToolUseCount: 0, totalDurationMs: 0 } } as never
    })

    await start($, 'startup')
    await $.tool.call({ tool: 'Agent', description: 'look around', prompt: 'List the files.' } as never)

    expect(model).toBe(expected)
  })
}

test('prompt upgrade sends the original when the upgrade call times out', async ($, on) => {
  engine(on, { prefs: { ...PREFS, promptUpgrade: true } })
  let timeoutMs: number | undefined
  let sent = ''
  on('model.complete', ($, e) => {
    timeoutMs = e.timeoutMs
    return { value: { isAnswered: false, reason: 'aborted', usage: USAGE } } as never
  })
  on('prompt.submit', ($, e) => {
    sent = e.text
    return { text: e.text }
  })

  await start($, 'startup')
  await $.prompt.submit({ text: 'fix the failing test in a.ts, do not touch b.ts', wait: false, origin: { kind: 'composer' } })

  expect(timeoutMs).toBe(5000)
  expect(sent).toBe('fix the failing test in a.ts, do not touch b.ts')
})

test('prompt upgrade sends the rewrite when the call answers', async ($, on) => {
  engine(on, { prefs: { ...PREFS, promptUpgrade: true } })
  let sent = ''
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Fix the failing test in a.ts. Do not modify b.ts.', usage: USAGE } }) as never)
  on('prompt.submit', ($, e) => {
    sent = e.text
    return { text: e.text }
  })

  await start($, 'startup')
  await $.prompt.submit({ text: 'fix the failing test in a.ts, do not touch b.ts', wait: false, origin: { kind: 'composer' } })

  expect(sent).toBe('Fix the failing test in a.ts. Do not modify b.ts.')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the footer chip draws on ${surface} and opens the panel`, async ($, on) => {
    engine(on)
    const opened: string[] = []
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } } as never
    })
    await start($, 'startup')
    const footer = await $.ui.mount({ plugin: 'rods-rack', surface, component: 'SessionMode', props: { modes: ['focus'] } })

    expect((await footer.find({ key: 'rack-chip' }))?.text).toContain('Rods Rack')
    expect((await footer.find({ type: 'Text', text: 'focus' }))).toBeDefined()
    await footer.press({ key: 'rack-chip' })

    expect(opened).toEqual(['rods-rack'])
  })
}

test('clean view draws a tool call as one checklist line', async ($, on) => {
  engine(on, { prefs: { ...PREFS, cleanView: true } })
  await start($, 'startup')
  const row = await $.ui.mount({
    plugin: 'rods-rack',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      tool_use_id: 't1',
      tool: 'Read',
      input: { file_path: 'src/a.ts' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })

  const drawn = JSON.stringify(await row.drawn())
  expect(drawn).toContain('✓')
  expect(drawn).toContain('Read src/a.ts')
})
