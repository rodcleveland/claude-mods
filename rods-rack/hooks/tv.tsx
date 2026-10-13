import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { TvState, TvVideo } from '../types'
import {
  changeTvSettings,
  channelDisplay,
  clampVolume,
  DEFAULT_TV_SETTINGS,
  describeTvSettings,
  isPlaying,
  OFF_STATE,
  parseTvCommand,
  parseVideos,
  readTvSettings,
  SEARCH_SIZE,
  snow,
  stateLabel,
  stepChannel,
  VOLUME_STEP,
  volumeBar,
  wrapLines,
} from './tv-logic'
import type { TvCommand, TvLink } from './tv-logic'

// YouTube TV: a retro TV in a pane that works as the remote, and YouTube's own embedded player in
// a browser window, served from this machine by scripts/tv-server.mjs. Channels are YouTube
// searches run with yt-dlp. Its plain logic is in tv-logic.ts.

type Dollar = EngineInterface

export const TV_PANE = 'rods-rack-tv'
const SETTINGS_KEY = 'tvSettings'
const PANE_COLUMNS = 64
const START_TIMEOUT_MS = 8000
const PING_MS = 30_000
const SEARCH_TIMEOUT_MS = 45_000

const WOOD = '#8B5A2B'
const LED = '#FF3B30'
const SCREEN = '#0B0F0D'
const GLOW = '#9FE3B0'
const TEXT = '#E6EDF3'
const MUTED = '#8B949E'
const HAIRLINE = '#30363D'
const GOLD = '#F2C46D'
const INK = '#1a1a1a'
const SLATE = '#262B33'

const tv = atom({ plugin: 'rods-rack', key: 'tv' } as const, OFF_STATE)
const tvSettings = atom({ plugin: 'rods-rack', key: 'tvSettings' } as const, DEFAULT_TV_SETTINGS)

// The player program while it runs: its port and token, its output stream (ending the stream ends
// the program) and the ping that keeps it from closing itself.
type Player = {
  port: number
  token: string
  stream: ReturnType<Dollar['process']['spawn']>
  ping: { cancel: () => void }
}

let player: Player | null = null
let starting: Promise<Player> | null = null
// Each search's videos, for the session: changing back to a channel does not search again.
const found = new Map<string, TvVideo[]>()

// ── The player program ───────────────────────────────────────────────────────

const newToken = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

// The mod's own directory: plugin.root names the one holding plugin.json.
const modRoot = ($: Dollar) => $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')

async function setTv($: Dollar, change: (s: TvState) => TvState) {
  await update($, tv, change)
}

// A line the player program printed: it is up, how many windows are open, or the page's state.
async function heard($: Dollar, message: Record<string, unknown>) {
  if (message.type === 'windows' && typeof message.count === 'number') {
    const count = message.count
    await setTv($, s => ({ ...s, windows: count }))
  } else if (message.type === 'state') {
    const playState = typeof message.state === 'number' ? message.state : -1
    if (playState === -2) return
    const hasError = message.error !== null && message.error !== undefined && playState !== 1
    await setTv($, s => {
      if (s.power === 'off' || s.isTuning) return s
      const index = typeof message.index === 'number' && message.index >= 0 && message.index < s.videos.length ? message.index : s.index
      return {
        ...s,
        power: 'on',
        playState,
        index,
        title: typeof message.title === 'string' ? message.title : (s.videos[index]?.title ?? s.title),
        author: typeof message.author === 'string' ? message.author : (s.videos[index]?.channel ?? s.author),
        needsClick: message.needsClick === true && message.muted === true,
        note: hasError ? 'That video will not play outside YouTube. Skipping it.' : playState === 1 ? null : s.note,
      }
    })
  }
}

async function startPlayer($: Dollar): Promise<Player> {
  if (player !== null) return player
  if (starting !== null) return starting
  starting = (async () => {
    const token = newToken()
    const stream = $.process.spawn({ argv: ['node', `${modRoot($)}/scripts/tv-server.mjs`], env: { TV_TOKEN: token } })
    let markReady: (port: number) => void = () => undefined
    let markFailed: (why: Error) => void = () => undefined
    const ready = new Promise<number>((resolve, reject) => {
      markReady = resolve
      markFailed = reject
    })

    void (async () => {
      let pending = ''
      try {
        for await (const chunk of stream) {
          if (chunk.stream !== 'stdout') continue
          pending += chunk.text
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) {
            let message: Record<string, unknown>
            try {
              message = JSON.parse(line) as Record<string, unknown>
            } catch {
              continue
            }
            if (message.type === 'listening' && typeof message.port === 'number') markReady(message.port)
            else await heard($, message)
          }
        }
        markFailed(new Error('The player program ended.'))
      } catch (error) {
        markFailed(error instanceof Error ? error : new Error(String(error)))
      } finally {
        // However it ended, the TV is off now.
        const current = player as Player | null
        if (current !== null && current.stream === stream) {
          current.ping.cancel()
          player = null
        }
        try {
          await setTv($, s => (s.power === 'off' ? s : { ...OFF_STATE, note: s.note }))
        } catch {
          // The session is gone, and the TV with it.
        }
      }
    })()

    const timeout = $.clock.sleep(START_TIMEOUT_MS).then(() => {
      throw new Error('The player program did not start in time.')
    })
    let port: number
    try {
      port = await Promise.race([ready, timeout])
    } catch (error) {
      await stream.return({ code: null, signal: null })
      throw error
    }
    const ping = $.clock.every(PING_MS, () => void call($, '/ping', '').catch(() => undefined))
    player = { port, token, stream, ping }
    return player
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

async function stopPlayer() {
  const running = player
  player = null
  if (running === null) return
  running.ping.cancel()
  await running.stream.return({ code: null, signal: null })
}

async function call($: Dollar, path: string, body: string): Promise<number | null> {
  if (player === null) return null
  const response = await $.http.fetch(`http://127.0.0.1:${player.port}${path}?t=${player.token}`, { method: 'POST', body })
  if (!response.ok) return null
  try {
    const parsed = JSON.parse(response.text) as { windows?: unknown }
    return typeof parsed.windows === 'number' ? parsed.windows : null
  } catch {
    return null
  }
}

// One command to the player window; the answer says how many windows are open.
async function send($: Dollar, command: Record<string, unknown>) {
  const windows = await call($, '/command', JSON.stringify(command))
  if (windows !== null) await setTv($, s => ({ ...s, windows }))
}

async function playerUrl(): Promise<string | null> {
  return player === null ? null : `http://127.0.0.1:${player.port}/?t=${player.token}`
}

// The player window, in the browser BROWSER names (Windows Chrome from WSL), else the system's.
async function openWindow($: Dollar) {
  const url = await playerUrl()
  if (url === null) return
  const browser = ((await $.env.get('BROWSER')) ?? '').split(':')[0]!.trim()
  const tries = [browser !== '' ? [browser, url] : null, ['xdg-open', url], ['open', url]].filter((x): x is string[] => x !== null)
  for (const argv of tries) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      if (ran.exitCode === 0) return
    } catch {
      // Try the next.
    }
  }
  $.ui.log(`Open the YouTube TV player window yourself: ${url}`)
  await setTv($, s => ({ ...s, note: 'The browser did not open. The player link is in the log.' }))
}

// ── What the TV does ─────────────────────────────────────────────────────────

async function search($: Dollar, target: string): Promise<TvVideo[]> {
  const cached = found.get(target)
  if (cached !== undefined) return cached
  const ran = await $.process.run(['yt-dlp', '--flat-playlist', '-J', '--no-warnings', target], { timeoutMs: SEARCH_TIMEOUT_MS })
  const videos = parseVideos(ran.stdout)
  if (videos.length > 0) found.set(target, videos)
  return videos
}

// Fills the screen with what `find` brings back and plays it, turning the TV on first if needed.
async function tune($: Dollar, channel: number | null, label: string, find: () => Promise<TvVideo[]>) {
  const settings = await read($, tvSettings)
  await setTv($, s => ({
    ...s,
    power: s.power === 'off' ? 'starting' : s.power,
    channel,
    label,
    isTuning: true,
    title: null,
    author: null,
    note: null,
  }))
  try {
    const wasRunning = player !== null
    const [, videos] = await Promise.all([startPlayer($), find()])
    if (videos.length === 0) {
      await setTv($, s => ({ ...s, isTuning: false, note: `Nothing found for ${label}. Try another search.` }))
      return
    }
    await setTv($, s => ({ ...s, videos, index: 0, title: videos[0]?.title ?? null, author: videos[0]?.channel ?? null }))
    await send($, { op: 'volume', value: settings.volume })
    await send($, { op: 'play', ids: videos.map(v => v.id), index: 0, channel: { number: channel === null ? 0 : channel + 1, name: label } })
    if (!wasRunning || (await read($, tv)).windows === 0) await openWindow($)
    await setTv($, s => ({ ...s, power: 'on', isTuning: false }))
  } catch (error) {
    const missing = error instanceof Error && /ENOENT|not found|No such file/i.test(error.message)
    await setTv($, s => ({
      ...(player === null ? OFF_STATE : s),
      isTuning: false,
      note: missing ? 'YouTube TV needs node and yt-dlp installed.' : 'The TV could not tune in just now. Try again.',
    }))
  }
}

async function tuneChannel($: Dollar, index: number) {
  const settings = await read($, tvSettings)
  const channel = settings.channels[index]
  if (channel === undefined) return
  if (settings.channel !== index) await saveSettings($, { ...settings, channel: index })
  await tune($, index, channel.name, () => search($, `ytsearch${SEARCH_SIZE}:${channel.query}`))
}

async function tuneSearch($: Dollar, query: string) {
  await tune($, null, `Search: ${query}`, () => search($, `ytsearch${SEARCH_SIZE}:${query}`))
}

// A video plays alone; a playlist plays in order, from the linked video when the link names one.
async function tuneLink($: Dollar, link: TvLink) {
  if (link.kind === 'video' && link.list === null) {
    await tune($, null, 'Link', async () => [{ id: link.id, title: 'Linked video', channel: '' }])
    return
  }
  const list = link.kind === 'playlist' ? link.list : link.list!
  const id = link.kind === 'video' ? link.id : null
  await tune($, null, 'Playlist', async () => {
    const videos = await search($, `https://www.youtube.com/playlist?list=${list}`)
    if (id === null) return videos
    const at = videos.findIndex(v => v.id === id)
    if (at === -1) return [{ id, title: 'Linked video', channel: '' }, ...videos]
    return [...videos.slice(at), ...videos.slice(0, at)]
  })
}

// The power button: on to the last channel, or off.
async function power($: Dollar) {
  const s = await read($, tv)
  if (s.power === 'off') await tuneChannel($, (await read($, tvSettings)).channel)
  else await turnOff($)
}

async function turnOff($: Dollar) {
  try {
    await send($, { op: 'off' })
  } catch {
    // It is going off either way.
  }
  await stopPlayer()
  await setTv($, () => OFF_STATE)
}

async function stepTo($: Dollar, delta: 1 | -1) {
  const settings = await read($, tvSettings)
  const s = await read($, tv)
  const from = s.power === 'off' ? settings.channel - delta : s.channel
  await tuneChannel($, stepChannel(from, delta, settings.channels.length))
}

async function setVolume($: Dollar, value: number) {
  const settings = await read($, tvSettings)
  const volume = clampVolume(value)
  await saveSettings($, { ...settings, volume })
  if (player !== null) await send($, { op: 'volume', value: volume })
}

async function transport($: Dollar, op: 'pause' | 'resume' | 'toggle' | 'next' | 'prev') {
  if (player === null) {
    if (op === 'resume' || op === 'toggle') await power($)
    return
  }
  await setTv($, s => ({ ...s, note: null }))
  await send($, { op })
  if (op === 'next' || op === 'prev') {
    await setTv($, s => {
      if (s.videos.length === 0) return s
      const index = (((s.index + (op === 'next' ? 1 : -1)) % s.videos.length) + s.videos.length) % s.videos.length
      return { ...s, index, title: s.videos[index]?.title ?? null, author: s.videos[index]?.channel ?? null }
    })
  }
}

// Claude finished or needs you: the TV pauses, if it was playing and the setting is on.
async function autoPause($: Dollar, why: string) {
  const settings = await read($, tvSettings)
  const s = await read($, tv)
  if (!settings.autoPause || player === null || !isPlaying(s)) return
  await send($, { op: 'pause' })
  await setTv($, x => ({ ...x, playState: 2, note: why }))
}

async function saveSettings($: Dollar, settings: ReturnType<typeof readTvSettings>) {
  await update($, tvSettings, () => settings)
  await $.store.set(SETTINGS_KEY, settings)
}

async function openTv($: Dollar) {
  const opened = await $.ui.open({ id: TV_PANE, title: 'YouTube TV', columns: PANE_COLUMNS })
  if (!opened.isPlaced) $.ui.toast('The window is too narrow to show YouTube TV. Widen it and type /tv again.')
}

// Runs a slow TV action after /tv has answered.
function later($: Dollar, work: () => Promise<unknown>) {
  void work().catch(() => $.ui.toast('YouTube TV could not do that just now. Try again.'))
}

// ── Drawing ──────────────────────────────────────────────────────────────────

const fit = (text: string, width: number) =>
  width <= 1 ? '' : text.length <= width ? text.padEnd(width) : text.slice(0, width - 1) + '…'
const center = (text: string, width: number) => {
  const cut = text.length > width ? text.slice(0, width) : text
  const left = Math.floor((width - cut.length) / 2)
  return ' '.repeat(left) + cut + ' '.repeat(width - cut.length - left)
}

async function drawTv($: Dollar, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  const width = Math.max(40, e.props.bodyColumns)
  const s = await read($, tv)
  const settings = await read($, tvSettings)
  const isOn = s.power !== 'off'

  // The cabinet: a wood frame, the screen on the left, the red channel display and buttons right.
  const sideWidth = 11
  const screenOuter = width - 4 - sideWidth - 1
  const screenWidth = screenOuter - 2
  const screenRows = 7

  let lines: Array<{ text: string; color: string; bold?: boolean }>
  if (!isOn) {
    lines = Array.from({ length: screenRows }, (_, i) => ({ text: i === 3 ? center('·', screenWidth) : ' '.repeat(screenWidth), color: HAIRLINE }))
  } else if (s.isTuning || s.power === 'starting') {
    const seed = s.label.length * 31 + (s.channel ?? 7)
    lines = snow(screenWidth, screenRows, seed).map(text => ({ text, color: MUTED }))
    lines[3] = { text: center(` ${s.power === 'starting' ? 'WARMING UP' : 'TUNING'} · ${s.label} `, screenWidth), color: TEXT, bold: true }
  } else {
    const title = wrapLines(s.title ?? 'Tuning…', screenWidth - 2, 3)
    lines = [
      { text: fit(` ${s.label.toUpperCase()}`, screenWidth), color: GOLD, bold: true },
      { text: ' '.repeat(screenWidth), color: GLOW },
      ...title.map(t => ({ text: fit(` ${t}`, screenWidth), color: GLOW, bold: true })),
    ]
    while (lines.length < screenRows - 2) lines.push({ text: ' '.repeat(screenWidth), color: GLOW })
    lines.push({ text: fit(` ${s.author ?? ''}`, screenWidth), color: MUTED })
    const where = s.videos.length > 0 ? `${s.index + 1}/${s.videos.length} ` : ''
    const status = stateLabel(s)
    lines.push({ text: ` ${status}`.padEnd(screenWidth - where.length) + where, color: s.playState === 1 ? GLOW : MUTED })
  }

  const key = (k: string, label: string, onPress: () => void, color = TEXT) => (
    <Button key={k} plain onPress={onPress}>
      <Text color={color} backgroundColor={SLATE}>{center(label, sideWidth)}</Text>
    </Button>
  )

  const cabinet = (
    <Box borderStyle="round" borderColor={WOOD} paddingX={1} flexDirection="column" width={width}>
      <Box flexDirection="row" gap={1}>
        <Box borderStyle="round" borderColor={isOn ? '#3A4A40' : HAIRLINE} flexDirection="column" width={screenOuter}>
          {lines.map((line, i) => (
            <Text key={`screen-${i}`} color={line.color} backgroundColor={SCREEN} bold={line.bold === true}>
              {line.text}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" width={sideWidth}>
          <Text bold color={isOn ? LED : '#5A1F1C'} backgroundColor="#000000">{center(channelDisplay(s), sideWidth)}</Text>
          <Text> </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="tv-ch-up" plain onPress={() => later($, () => stepTo($, 1))}>
              <Text color={TEXT} backgroundColor={SLATE}> CH▲ </Text>
            </Button>
            <Button key="tv-ch-down" plain onPress={() => later($, () => stepTo($, -1))}>
              <Text color={TEXT} backgroundColor={SLATE}>CH▼</Text>
            </Button>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="tv-vol-up" plain onPress={() => later($, () => setVolume($, settings.volume + VOLUME_STEP))}>
              <Text color={TEXT} backgroundColor={SLATE}> VOL+</Text>
            </Button>
            <Button key="tv-vol-down" plain onPress={() => later($, () => setVolume($, settings.volume - VOLUME_STEP))}>
              <Text color={TEXT} backgroundColor={SLATE}>VOL−</Text>
            </Button>
          </Box>
          <Text> </Text>
          {key('tv-power', '⏻ POWER', () => later($, () => power($)), isOn ? LED : TEXT)}
        </Box>
      </Box>
      <Text color={MUTED}>{center('R R - 1 9 9 0     C O L O R   T V', width - 4)}</Text>
    </Box>
  )

  // Under the set: now playing, the transport and volume, the channels, then search.
  const bar = volumeBar(settings.volume, 10)
  const transportRow = (
    <Box flexDirection="row" gap={2} width={width}>
      <Button key="tv-prev" plain onPress={() => later($, () => transport($, 'prev'))}>
        <Text color={TEXT}> ⏮ </Text>
      </Button>
      <Button key="tv-toggle" plain onPress={() => later($, () => transport($, 'toggle'))}>
        <Text color={INK} backgroundColor={GOLD}> {isPlaying(s) ? '❚❚' : '▶'} </Text>
      </Button>
      <Button key="tv-next" plain onPress={() => later($, () => transport($, 'next'))}>
        <Text color={TEXT}> ⏭ </Text>
      </Button>
      <Text>
        <Text color={MUTED}>VOL </Text>
        <Text color={GOLD}>{'▮'.repeat(bar.filled)}</Text>
        <Text color={HAIRLINE}>{'▯'.repeat(bar.empty)}</Text>
        <Text color={TEXT}> {String(settings.volume).padStart(3)}</Text>
      </Text>
    </Box>
  )

  const channels = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={width}>
      <Text color={MUTED}>{'CHANNELS  '}</Text>
      {settings.channels.map((c, i) => (
        <Button key={`tv-channel-${i + 1}`} plain onPress={() => later($, () => tuneChannel($, i))}>
          {isOn && s.channel === i ? (
            <Text bold color={INK} backgroundColor={GOLD}> {i + 1} {c.name} </Text>
          ) : (
            <Text color={TEXT} backgroundColor={SLATE}> {i + 1} {c.name} </Text>
          )}
        </Button>
      ))}
    </Box>
  )

  const searchBox =
    'Input' in table ? (
      <table.Input
        key="tv-search"
        label="SEARCH"
        placeholder="Search YouTube or paste a link"
        submitLabel="tune"
        onSubmit={value => {
          const command = parseTvCommand(value)
          if (command.op === 'link') later($, () => tuneLink($, command.link))
          else if (value.trim() !== '') later($, () => tuneSearch($, value.trim()))
        }}
      />
    ) : (
      <Text color={MUTED}>Search with /tv search lofi jazz, or paste a link after /tv.</Text>
    )

  // One line of help: what to do next, or what went wrong.
  let hint: RenderElement | null = null
  if (s.note !== null) hint = <Text color={GOLD} wrap="wrap">{s.note}</Text>
  else if (s.power === 'on' && s.windows === 0)
    hint = (
      <Button key="tv-window" plain onPress={() => later($, () => openWindow($))}>
        <Text color={GOLD}>The player window is closed. Open it again ▸</Text>
      </Button>
    )
  else if (s.power === 'on' && s.needsClick) hint = <Text color={GOLD} wrap="wrap">Click the player window once to turn the sound on.</Text>
  else if (!isOn) hint = <Text color={MUTED} wrap="wrap">Press POWER or a channel. The video plays in a browser window; this is the remote.</Text>

  return (
    <Box flexDirection="column" width={width}>
      {cabinet}
      <Text wrap="truncate-end">
        <Text color={MUTED}>NOW PLAYING  </Text>
        <Text color={TEXT}>{isOn && s.title !== null ? s.title : 'Nothing'}</Text>
      </Text>
      {transportRow}
      <Text> </Text>
      {channels}
      {searchBox}
      {hint !== null ? <Text> </Text> : null}
      {hint}
    </Box>
  )
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const TV_HELP =
  'Use /tv to open the remote, /tv 1 to 9 for a channel, /tv up, /tv down, /tv vol 40, /tv pause, /tv play, /tv next, /tv off, /tv search lofi jazz, a YouTube link, or /tv settings.'

async function runCommand($: Dollar, command: TvCommand): Promise<string> {
  const settings = await read($, tvSettings)
  switch (command.op) {
    case 'open':
      later($, () => openTv($))
      return 'YouTube TV'
    case 'on':
      later($, () => tuneChannel($, settings.channel))
      return `Turning on: ${settings.channels[settings.channel]?.name ?? 'channel 1'}.`
    case 'off':
      later($, () => turnOff($))
      return 'YouTube TV is off.'
    case 'channel': {
      const channel = settings.channels[command.number - 1]
      if (channel === undefined) return `Pick a channel from 1 to ${settings.channels.length}.`
      later($, () => tuneChannel($, command.number - 1))
      return `Channel ${command.number}: ${channel.name}.`
    }
    case 'up':
    case 'down':
      later($, () => stepTo($, command.op === 'up' ? 1 : -1))
      return command.op === 'up' ? 'Channel up.' : 'Channel down.'
    case 'volume':
      await setVolume($, command.value)
      return `Volume ${clampVolume(command.value)}.`
    case 'louder':
    case 'quieter': {
      const value = clampVolume(settings.volume + (command.op === 'louder' ? VOLUME_STEP : -VOLUME_STEP))
      await setVolume($, value)
      return `Volume ${value}.`
    }
    case 'pause':
    case 'resume':
    case 'next':
    case 'prev':
      if (player === null && command.op !== 'resume') return 'YouTube TV is off. Turn it on with /tv on.'
      later($, () => transport($, command.op as 'pause' | 'resume' | 'next' | 'prev'))
      return { pause: 'Paused.', resume: 'Playing.', next: 'Next video.', prev: 'Previous video.' }[command.op]
    case 'window':
      if (player === null) return 'YouTube TV is off. Turn it on with /tv on.'
      later($, () => openWindow($))
      return 'Opening the player window.'
    case 'search':
      later($, () => tuneSearch($, command.query))
      return `Searching YouTube for ${command.query}.`
    case 'link':
      later($, () => tuneLink($, command.link))
      return 'Playing the link.'
    case 'settings': {
      if (command.rest === '') return describeTvSettings(settings)
      const changed = changeTvSettings(settings, command.rest)
      if (typeof changed === 'string') return changed
      await saveSettings($, changed)
      return describeTvSettings(changed)
    }
    case 'error':
      return command.text
  }
}

export function registerTv(on: On) {
  on('session.start', { isInteractive: /^/ }, async ($, e, next) => {
    try {
      await update($, tvSettings, () => DEFAULT_TV_SETTINGS)
      const settings = readTvSettings(await $.store.get(SETTINGS_KEY))
      await update($, tvSettings, () => settings)
    } catch {
      // The first five channels.
    }
    await $.command.register({
      name: 'tv',
      description: 'YouTube TV: watch while you wait (1-9, up, down, vol 40, pause, play, next, off, search, a link, settings)',
      argumentHint: '[channel | up | down | vol N | pause | play | next | off | search … | link | settings]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'tv' }, async ($, e) => {
    try {
      return { text: await runCommand($, parseTvCommand(e.args)) }
    } catch {
      return { text: `YouTube TV could not answer just now. ${TV_HELP}` }
    }
  }).catch(() => ({ text: 'YouTube TV could not answer just now. Try /tv again.' }))

  on('ui.render', { component: 'Pane', requestId: TV_PANE }, async ($, e) => drawTv($, e))

  // Pauses when Claude finishes its turn, or stops to ask you something.
  on('turn.complete', { reason: /./ }, async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await autoPause($, 'Paused: Claude finished. Press ▶ to keep watching.')
      } catch {
        // It plays on.
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', { notification_type: /^(permission_prompt|elicitation_dialog)$/ }, async ($, e, next) => {
    try {
      await autoPause($, 'Paused: Claude needs you. Press ▶ to keep watching.')
    } catch {
      // It plays on.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Leaving Claude Code turns the TV off; a /clear or a resume keeps it playing.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      try {
        await turnOff($)
      } catch {
        // The program ends with the session anyway.
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
