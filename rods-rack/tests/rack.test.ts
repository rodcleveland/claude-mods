import { expect, mock, test } from 'claude-code/testing'
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

// Opens the panel as the person does with /rods-rack, then draws the band it lives in.
async function openPanel($: Engine, surface: 'terminal' | 'desktop') {
  await $.command.run({ command: 'rods-rack', args: '' } as never)
  return $.ui.mount({ ...BAND, surface })
}

// The test stands for the engine beneath the plugin: it answers SessionStart and keeps the store.
// Every test hook is registered here, before the test first calls $.
function engine(on: On, initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial))
  const writes: Array<{ key: string; value: unknown }> = []
  mock.clock(on)
  mock.env(on, {})
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

// Open Notepad: PowerShell starts Windows Notepad; its usual path under /mnt/c is the fallback, and a
// toast says so when neither runs. The engine records each program run and answers as `answer` says.
function notepadEngine(on: On, answer: (argv: string[]) => number | 'missing') {
  const clock = mock.clock(on)
  mock.env(on, {})
  on('classic.SessionStart', () => ({}) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  mock.store(on)
  const ran: string[][] = []
  const toasts: string[] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const code = answer([...e.argv])
    if (code === 'missing') throw new Error(`spawn ${e.argv[0]} ENOENT`)
    return { value: { exitCode: code, stdout: '', stderr: '' } } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  return { clock, ran, toasts }
}

const NOTEPAD_ARGS = ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process notepad.exe']

test('Open Notepad sits in the launch area with its notepad icon and starts Notepad through PowerShell', async ($, on) => {
  const { clock, ran, toasts } = notepadEngine(on, () => 0)
  await start($, 'startup')
  const panel = await openPanel($, 'terminal')

  expect((await panel.find({ key: 'launch-notepad' }))?.text).toContain('⌸ Open Notepad')
  await panel.press({ key: 'launch-notepad' })
  await clock.settle()

  expect(ran).toEqual([['powershell.exe', ...NOTEPAD_ARGS]])
  expect(toasts).toHaveLength(0)
})

test('Open Notepad tries PowerShell by its full path, then says so if neither runs', async ($, on) => {
  const { clock, ran, toasts } = notepadEngine(on, argv => (argv[0] === 'powershell.exe' ? 'missing' : 1))
  await start($, 'startup')
  const panel = await openPanel($, 'terminal')

  await panel.press({ key: 'launch-notepad' })
  await clock.settle()

  expect(ran.map(argv => argv[0])).toEqual(['powershell.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'])
  expect(toasts).toEqual(["Notepad didn't open: PowerShell wasn't found, or it couldn't start Notepad."])
})

test('the Default chips hand the model and effort back to the session', async ($, on) => {
  const writes = engine(on, { prefs: { ...PREFS, model: 'haiku', effort: 'max' } })
  await start($, 'startup')
  const panel = await openPanel($, 'terminal')

  await panel.press({ key: 'model-default' })
  await panel.press({ key: 'effort-default' })
  expect(writes.at(-1)).toMatchObject({ key: 'prefs', value: { model: null, effort: null } })

  await panel.press({ key: 'model-opus' })
  expect(writes.at(-1)).toMatchObject({ key: 'prefs', value: { model: 'opus' } })
})

test('a pinned model and effort show on the status line; clearing them empties it', async ($, on) => {
  engine(on)
  const status: Array<string | undefined> = []
  on('ui.status', ($, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  await start($, 'startup')
  const panel = await openPanel($, 'terminal')

  await panel.press({ key: 'model-haiku' })
  await panel.press({ key: 'effort-xhigh' })
  expect(status.at(-1)).toBe('Rods Rack: Haiku 5.5 · XHigh')

  await panel.press({ key: 'model-default' })
  await panel.press({ key: 'effort-default' })
  expect(status.at(-1)).toBeUndefined()
})

test('the Default model chip turns Auto Model off, the way a model pick does', async ($, on) => {
  const writes = engine(on, { prefs: { ...PREFS, autoModel: true, model: 'haiku', autoPrevious: 'opus' } })
  await start($, 'startup')
  const panel = await openPanel($, 'terminal')

  await panel.press({ key: 'model-default' })
  expect(writes.at(-1)).toMatchObject({ key: 'prefs', value: { model: null, autoModel: false, autoPrevious: null } })
})

test('with Auto Model on, a pinned effort shows beside the Auto entry', async ($, on) => {
  engine(on, { prefs: { ...PREFS, autoModel: true, model: 'opus' } })
  const status: Array<string | undefined> = []
  on('ui.status', ($, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  await start($, 'startup')
  const panel = await openPanel($, 'terminal')

  await panel.press({ key: 'effort-high' })
  expect(status.at(-1)).toBe('Auto · Opus 5.5  ·  Rods Rack: High')
})

test('/clear shows the saved pins on the status line again', async ($, on) => {
  engine(on, { prefs: { ...PREFS, model: 'haiku', effort: 'xhigh' } })
  const status: Array<string | undefined> = []
  on('ui.status', ($, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })

  await start($, 'clear')
  expect(status.at(-1)).toBe('Rods Rack: Haiku 5.5 · XHigh')
})
