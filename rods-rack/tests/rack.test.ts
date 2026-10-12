import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PREFS = { model: null, effort: null, promptUpgrade: false, helper: 'same' }
const BAND = {
  plugin: 'rods-rack',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 29 },
    view: {},
  },
} as const

// Opens the panel as the person does with /rack, then draws the band it lives in.
async function openPanel($: Engine, surface: 'terminal' | 'desktop') {
  await $.command.run({ command: 'rack', args: '' } as never)
  return $.ui.mount({ ...BAND, surface })
}

// The test stands for the engine beneath the plugin: it answers SessionStart and keeps the store.
// Every test hook is registered here, before the test first calls $.
function engine(on: On, initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial))
  const writes: Array<{ key: string; value: unknown }> = []
  on('classic.SessionStart', () => ({}) as never)
  // The engine's own empty band, drawn while the panel is closed.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
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
    const panel = await openPanel($, surface)

    await panel.press({ key: 'toggle-prompt-upgrade' })
    expect(writes.at(-1)).toMatchObject({ key: 'prefs', value: { promptUpgrade: true } })
    expect((await panel.find({ key: 'toggle-prompt-upgrade' }))?.text).toContain('On')

    // Clean View starts on; the panel's switch is the same one /simple and the band's button flip.
    await panel.press({ key: 'toggle-clean-view' })
    expect(writes.at(-1)).toEqual({ key: 'cleanView', value: false })
    expect((await panel.find({ key: 'toggle-clean-view' }))?.text).toContain('Off')
  })
}

test('saved toggles come back after /clear', async ($, on) => {
  engine(on, { prefs: { ...PREFS, promptUpgrade: true, helper: 'balanced' } })

  await start($, 'clear')
  const panel = await openPanel($, 'terminal')

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
  test(`the footer chip draws on ${surface} and toggles the panel in the band`, async ($, on) => {
    engine(on)
    await start($, 'startup')
    const footer = await $.ui.mount({ plugin: 'rods-rack', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    const band = await $.ui.mount({ ...BAND, surface })

    expect((await footer.find({ key: 'rack-chip' }))?.text).toContain('Rods Rack')
    expect(await footer.find({ type: 'Text', text: 'focus' })).toBeDefined()
    expect(await band.find({ key: 'toggle-clean-view' })).toBeUndefined()

    await footer.press({ key: 'rack-chip' })
    await band.redraw(BAND.props)
    expect(await band.find({ key: 'toggle-clean-view' })).toBeDefined()

    await footer.press({ key: 'rack-chip' })
    await band.redraw(BAND.props)
    expect(await band.find({ key: 'toggle-clean-view' })).toBeUndefined()
  })
}
