import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { changeTvSettings, DEFAULT_TV_SETTINGS, linkOf, parseTvCommand, parseVideos, readTvSettings, stepChannel, wrapLines } from '../hooks/tv-logic'

const PANE = {
  plugin: 'rods-rack',
  component: 'Pane',
  requestId: 'rods-rack-tv',
  props: { title: 'YouTube TV', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const FOOTER = { plugin: 'rods-rack', component: 'SessionMode', props: { modes: [] } } as const
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const id = (n: number) => `video${String(n).padStart(6, '0')}`
const SEARCH = JSON.stringify({ entries: [1, 2, 3].map(n => ({ id: id(n), title: `Lofi beats ${n}`, channel: 'Lofi Girl' })) })

// The test stands for the engine and the machine beneath the plugin: a store, yt-dlp's answers, a
// player program that says it is listening and then whatever the test hands it, and the page's
// answers to each command.
function engine(on: On, store: Record<string, unknown> = {}) {
  const ran: string[][] = []
  const commands: Array<Record<string, unknown>> = []
  const spawned: string[][] = []
  const lines: string[] = []
  const saved = new Map<string, unknown>()
  let wake: () => void = () => undefined
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 16) })
  for (const [key, value] of Object.entries(store)) saved.set(key, value)
  on('store.get', ($, e) => ({ value: saved.get(e.key) }) as never)
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...saved.keys()] }) as never)
  mock.env(on, { HOME: '/home/test', BROWSER: '/usr/local/bin/win-chrome' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}) as never)
  on('classic.Notification', () => ({}) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__rods-rack__${e.name}` } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[0] === 'yt-dlp' ? SEARCH : e.argv[0] === 'date' ? '2026-10-12\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('process.spawn', async function* ($, e, next) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: '{"type":"listening","port":4242}\n' }
    while (!next.signal.aborted) {
      const line = lines.shift()
      if (line !== undefined) yield { stream: 'stdout' as const, text: `${line}\n` }
      else await new Promise<void>(resolve => {
        wake = resolve
        next.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    return { value: { code: null, signal: 'SIGTERM' } } as never
  })
  on('http.fetch', ($, e) => {
    if (e.url.includes('/command')) commands.push(JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>)
    return { value: { status: 200, ok: true, headers: {}, text: '{"windows":1}' } } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('session.end', () => ({}) as never)
  // The page reports a state, as it does when a video starts or pauses.
  const report = (state: Record<string, unknown>) => {
    lines.push(JSON.stringify({ type: 'state', index: 0, count: 3, volume: 50, muted: false, needsClick: false, error: null, ...state }))
    wake()
  }
  return { ran, commands, spawned, report, clock, saved }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const drawn = async (mounted: { drawn: () => Promise<unknown> }) => JSON.stringify(await mounted.drawn())
const answered = (turnId: string) =>
  ({ answer: 'Done.', durationMs: 1000, isAborted: false, turnId, reason: 'answer', usage: { ...USAGE, model: 'claude-opus-5-5' } }) as never

test('/tv words, numbers, volumes, links and searches', () => {
  expect(parseTvCommand('')).toEqual({ op: 'open' })
  expect(parseTvCommand('3')).toEqual({ op: 'channel', number: 3 })
  expect(parseTvCommand('UP')).toEqual({ op: 'up' })
  expect(parseTvCommand('vol 40')).toEqual({ op: 'volume', value: 40 })
  expect(parseTvCommand('volume +')).toEqual({ op: 'louder' })
  expect(parseTvCommand('vol 140')).toMatchObject({ op: 'error' })
  expect(parseTvCommand('pause')).toEqual({ op: 'pause' })
  expect(parseTvCommand('play')).toEqual({ op: 'resume' })
  expect(parseTvCommand('off')).toEqual({ op: 'off' })
  expect(parseTvCommand('search lofi jazz')).toEqual({ op: 'search', query: 'lofi jazz' })
  // Any other words are a search too.
  expect(parseTvCommand('rainy day piano')).toEqual({ op: 'search', query: 'rainy day piano' })
  expect(parseTvCommand('https://youtu.be/dQw4w9WgXcQ')).toEqual({ op: 'link', link: { kind: 'video', id: 'dQw4w9WgXcQ', list: null } })
  expect(parseTvCommand('https://example.com/watch?v=dQw4w9WgXcQ')).toMatchObject({ op: 'error' })
  expect(parseTvCommand('settings autopause off')).toEqual({ op: 'settings', rest: 'autopause off' })
})

test('YouTube links in their usual forms', () => {
  expect(linkOf('https://www.youtube.com/watch?v=aD-h7Bcn5OY')).toEqual({ kind: 'video', id: 'aD-h7Bcn5OY', list: null })
  expect(linkOf('https://m.youtube.com/watch?v=aD-h7Bcn5OY&t=30s')).toEqual({ kind: 'video', id: 'aD-h7Bcn5OY', list: null })
  expect(linkOf('https://youtube.com/shorts/aD-h7Bcn5OY')).toEqual({ kind: 'video', id: 'aD-h7Bcn5OY', list: null })
  expect(linkOf('https://www.youtube.com/watch?v=aD-h7Bcn5OY&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')).toEqual({
    kind: 'video',
    id: 'aD-h7Bcn5OY',
    list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
  })
  expect(linkOf('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')).toEqual({ kind: 'playlist', list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' })
  expect(linkOf('https://www.youtube.com/@LofiGirl')).toBeNull()
  expect(linkOf('lofi jazz')).toBeNull()
})

test("yt-dlp's answer becomes the channel's videos", () => {
  const videos = parseVideos(
    JSON.stringify({
      entries: [
        { id: 'aD-h7Bcn5OY', title: 'One', channel: 'A' },
        { id: 'not-an-id', title: 'Bad' },
        { id: 'aD-h7Bcn5OY', title: 'Twice' },
        { id: 'jfKfPfyJRdk', title: 'Two', uploader: 'B' },
      ],
    }),
  )
  expect(videos).toEqual([
    { id: 'aD-h7Bcn5OY', title: 'One', channel: 'A' },
    { id: 'jfKfPfyJRdk', title: 'Two', channel: 'B' },
  ])
  expect(parseVideos('not json')).toEqual([])
})

test('channels step round the end, and long titles wrap', () => {
  expect(stepChannel(4, 1, 5)).toBe(0)
  expect(stepChannel(0, -1, 5)).toBe(4)
  expect(stepChannel(null, 1, 5)).toBe(0)
  expect(stepChannel(null, -1, 5)).toBe(4)
  expect(wrapLines('A very long title about lofi beats to study and relax to', 20, 2)).toEqual(['A very long title', 'about lofi beats to…'])
  expect(wrapLines('Short', 20, 2)).toEqual(['Short'])
})

test('settings: change a channel, add one, turn pausing off, and read back what was saved', () => {
  const changed = changeTvSettings(DEFAULT_TV_SETTINGS, 'channel 2 Jazz Piano = smooth jazz piano')
  if (typeof changed === 'string') throw new Error(changed)
  expect(changed.channels[1]).toEqual({ name: 'Jazz Piano', query: 'smooth jazz piano' })
  const added = changeTvSettings(changed, 'channel 6 Nature = nature documentary')
  if (typeof added === 'string') throw new Error(added)
  expect(added.channels).toHaveLength(6)
  expect(changeTvSettings(added, 'channel 9 Too far = x')).toContain('from 1 to 7')
  const quiet = changeTvSettings(added, 'autopause off')
  if (typeof quiet === 'string') throw new Error(quiet)
  expect(quiet.autoPause).toBe(false)
  expect(readTvSettings({ ...quiet, volume: 400, channel: 99 })).toMatchObject({ volume: 100, channel: 0, autoPause: false })
  expect(readTvSettings(null).channels.map(c => c.name)).toEqual(['AI Made Easy', 'Study Music', 'AI News', '90s TV Shows', '90s Music'])
})

test('the remote starts off, with the five channels and a search box', async ($, on) => {
  engine(on)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = await drawn(pane)
  for (const name of ['AI Made Easy', 'Study Music', 'AI News', '90s TV Shows', '90s Music']) expect(text).toContain(name)
  expect(text).toContain('POWER')
  expect(text).toContain('Press POWER or a channel')
  expect(await pane.find({ key: 'tv-search' })).toBeDefined()
})

test('a channel searches YouTube, starts the player, opens the window and plays the videos', async ($, on) => {
  const machine = engine(on)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'tv-channel-2' })
  await machine.clock.settle()

  expect(machine.spawned).toHaveLength(1)
  expect(machine.spawned[0]![1]).toMatch(/scripts\/tv-server\.mjs$/)
  expect(machine.ran.some(argv => argv[0] === 'yt-dlp' && argv.includes('ytsearch15:study music'))).toBe(true)
  expect(machine.ran.some(argv => argv[0] === '/usr/local/bin/win-chrome' && argv[1]!.startsWith('http://127.0.0.1:4242/?t='))).toBe(true)
  const play = machine.commands.find(c => c.op === 'play')
  expect(play).toMatchObject({ ids: [id(1), id(2), id(3)], index: 0, channel: { number: 2, name: 'Study Music' } })

  machine.report({ state: 1, videoId: id(1), title: 'Lofi beats 1', author: 'Lofi Girl' })
  await machine.clock.settle()
  const text = await drawn(pane)
  expect(text).toContain('Lofi beats 1')
  expect(text).toContain('PLAYING')
  expect(text).toContain('02')

  const footer = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  expect((await footer.find({ key: 'tv-chip' }))?.text).toContain('TV ▶')
})

test('the TV pauses when Claude finishes, unless pausing is turned off', async ($, on) => {
  const machine = engine(on)
  await start($)
  await $.command.run({ command: 'tv', args: '1' } as never)
  await machine.clock.settle()
  machine.report({ state: 1, videoId: id(1), title: 'Lofi beats 1' })
  await machine.clock.settle()

  // A helper finishing is not Claude finishing.
  await $.turn.complete({ ...(answered('t0') as object), agentId: 'helper-1' } as never)
  expect(machine.commands.filter(c => c.op === 'pause')).toHaveLength(0)

  await $.turn.complete(answered('t1'))
  expect(machine.commands.filter(c => c.op === 'pause')).toHaveLength(1)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await drawn(pane)).toContain('Paused: Claude finished')

  await $.command.run({ command: 'tv', args: 'settings autopause off' } as never)
  machine.report({ state: 1, videoId: id(1), title: 'Lofi beats 1' })
  await machine.clock.settle()
  await $.turn.complete(answered('t2'))
  expect(machine.commands.filter(c => c.op === 'pause')).toHaveLength(1)
})

test('the TV pauses when Claude needs your permission', async ($, on) => {
  const machine = engine(on)
  await start($)
  await $.command.run({ command: 'tv', args: 'on' } as never)
  await machine.clock.settle()
  machine.report({ state: 1, videoId: id(1), title: 'Lofi beats 1' })
  await machine.clock.settle()
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  expect(machine.commands.filter(c => c.op === 'pause')).toHaveLength(1)
})

test('it does not turn itself on: nothing starts until you press something', async ($, on) => {
  const machine = engine(on)
  await start($)
  await $.prompt.submit({ text: 'Research bakery pricing', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.complete(answered('t1'))
  await $.command.run({ command: 'tv', args: '' } as never)
  await machine.clock.settle()
  expect(machine.spawned).toHaveLength(0)
  expect(machine.commands).toHaveLength(0)
})

test('off stops the player program, and /tv vol keeps the volume', async ($, on) => {
  const machine = engine(on)
  await start($)
  await $.command.run({ command: 'tv', args: '5' } as never)
  await machine.clock.settle()
  const answer = await $.command.run({ command: 'tv', args: 'vol 30' } as never)
  expect(JSON.stringify(answer)).toContain('Volume 30')
  expect(machine.commands.at(-1)).toEqual({ op: 'volume', value: 30 })
  expect(machine.saved.get('tvSettings')).toMatchObject({ volume: 30, channel: 4 })

  await $.command.run({ command: 'tv', args: 'off' } as never)
  await machine.clock.settle()
  expect(machine.commands.at(-1)).toEqual({ op: 'off' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await drawn(pane)).toContain('Press POWER or a channel')
  const next = await $.command.run({ command: 'tv', args: 'next' } as never)
  expect(JSON.stringify(next)).toContain('YouTube TV is off')
})
