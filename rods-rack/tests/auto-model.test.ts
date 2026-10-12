import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { familyFor, guessLevel, isShortReply, parseLevel } from '../hooks/auto-model'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PREFS = {
  model: null,
  effort: null,
  promptUpgrade: false,
  helper: 'same',
  autoModel: false,
  autoPrevious: null,
  autoUnavailable: [],
}

// The test stands for the engine beneath the plugin: it keeps the store, answers the sorter with
// `answer` and counts the calls, and sends every prompt on as given.
function engine(on: On, initial: Record<string, unknown>, answer: string | null) {
  const store = new Map(Object.entries(initial))
  const calls: string[] = []
  const status: Array<string | undefined> = []
  mock.clock(on)
  mock.env(on, {})
  on('classic.SessionStart', () => ({}) as never)
  on('classic.PostModelSwitch', () => ({}) as never)
  on('ui.status', ($, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('model.complete', ($, e) => {
    calls.push(e.prompt)
    return (answer === null
      ? { value: { isAnswered: false, reason: 'aborted', usage: USAGE } }
      : { value: { isAnswered: true, text: answer, usage: USAGE } }) as never
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const prefs = () => store.get('prefs') as typeof PREFS
  return { calls, prefs, status }
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('the one-word answer is read as a level', async () => {
  expect(parseLevel('strong')).toBe('strong')
  expect(parseLevel(' Strongest.')).toBe('strongest')
  expect(parseLevel('Small\n')).toBe('small')
  expect(parseLevel('everyday')).toBe('everyday')
  expect(parseLevel('banana')).toBeNull()
  expect(parseLevel('')).toBeNull()
})

test('a short reply is spotted', async () => {
  for (const reply of ['yes', 'ok', 'Keep going.', 'do it', 'go ahead!', 'fix it now']) {
    expect(isShortReply(reply)).toBe(true)
  }
  expect(isShortReply('Build me a pricing page for the site')).toBe(false)
  expect(isShortReply('Summarize this article for me please')).toBe(false)
})

test('the word-based fallback guesses a level, strong when in doubt', async () => {
  expect(guessLevel('Summarize the paragraph below')).toBe('small')
  expect(guessLevel('Write an email to my landlord about the leak')).toBe('everyday')
  expect(guessLevel('Refactor the login flow across the app')).toBe('strong')
  expect(guessLevel('Migrate the entire codebase from Vue to React')).toBe('strongest')
  expect(guessLevel('What do you make of this idea for a garden')).toBe('strong')
  expect(familyFor('strongest', ['fable'])).toBe('opus')
  expect(familyFor('everyday', [])).toBe('sonnet')
})

test('a new prompt switches the model', async ($, on) => {
  const { calls, prefs, status } = engine(on, { prefs: { ...PREFS, autoModel: true } }, 'everyday')
  await $.classic.SessionStart({ source: 'startup' })

  await $.prompt.submit(typed('Write a short post announcing our summer sale'))
  expect(calls).toHaveLength(1)
  expect(prefs().model).toBe('sonnet')
  expect(status.at(-1)).toBe('Auto · Sonnet 5.5')
})

test('the word guess decides when the sorter times out', async ($, on) => {
  const { calls, prefs } = engine(on, { prefs: { ...PREFS, autoModel: true } }, null)
  await $.classic.SessionStart({ source: 'startup' })

  await $.prompt.submit(typed('Migrate the entire codebase from Vue to React'))
  expect(calls).toHaveLength(1)
  expect(prefs().model).toBe('fable')
})

test('a short reply, a slash command and a message mid-turn keep the model', async ($, on) => {
  const { calls, prefs } = engine(on, { prefs: { ...PREFS, autoModel: true, model: 'opus' } }, 'small')
  await $.classic.SessionStart({ source: 'startup' })

  await $.prompt.submit(typed('ok keep going'))
  await $.prompt.submit(typed('/compact now please and thanks'))
  await $.turn.start({ text: 'Build the pricing section of the site', turnId: 't1' })
  await $.prompt.submit(typed('Also translate the footer into Spanish'))

  expect(calls).toHaveLength(0)
  expect(prefs().model).toBe('opus')
})

test('turning it off goes back to the earlier model', async ($, on) => {
  const { prefs, status } = engine(on, { prefs: { ...PREFS, model: 'haiku' } }, 'strongest')
  await $.classic.SessionStart({ source: 'startup' })

  expect((await $.command.run({ command: 'automodel', args: 'on' } as never)).text).toBe('Auto Model is on.')
  await $.prompt.submit(typed('Run deep research on solar storage for the next decade'))
  expect(prefs().model).toBe('fable')

  expect((await $.command.run({ command: 'automodel', args: 'status' } as never)).text).toContain('Fable 5.1')
  await $.command.run({ command: 'automodel', args: 'off' } as never)
  expect(prefs()).toMatchObject({ autoModel: false, model: 'haiku' })
  expect(status.at(-1)).toBeUndefined()
})

test('a model picked by hand turns Auto Model off', async ($, on) => {
  const { prefs } = engine(on, { prefs: { ...PREFS, autoModel: true, model: 'opus' } }, 'strong')
  await $.classic.SessionStart({ source: 'startup' })

  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5',
    requested_model: 'sonnet',
    source: 'command',
  } as never)
  expect(prefs()).toMatchObject({ autoModel: false, model: null })
})
