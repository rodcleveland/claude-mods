import type { TvChannel, TvSettings, TvState, TvVideo } from '../types'

// YouTube TV's plain logic, with no engine calls: the /tv words, YouTube links, yt-dlp's answers,
// channel and volume steps, settings, and the screen's text.

export const DEFAULT_CHANNELS: readonly TvChannel[] = [
  { name: 'AI Made Easy', query: 'AI explained simply for beginners' },
  { name: 'Study Music', query: 'study music' },
  { name: 'AI News', query: 'AI news this week' },
  { name: '90s TV Shows', query: '90s TV shows' },
  { name: '90s Music', query: '90s music hits' },
]

export const DEFAULT_TV_SETTINGS: TvSettings = {
  channels: DEFAULT_CHANNELS.map(c => ({ ...c })),
  volume: 50,
  channel: 0,
  autoPause: true,
}

export const OFF_STATE: TvState = {
  power: 'off',
  channel: null,
  label: '',
  videos: [],
  index: 0,
  title: null,
  author: null,
  playState: -2,
  windows: 0,
  needsClick: false,
  isTuning: false,
  note: null,
}

// How many videos one search fills a channel with.
export const SEARCH_SIZE = 15
export const MAX_CHANNELS = 9
export const VOLUME_STEP = 10

export type TvLink = { kind: 'video'; id: string; list: string | null } | { kind: 'playlist'; list: string }

export type TvCommand =
  | { op: 'open' | 'on' | 'off' | 'up' | 'down' | 'louder' | 'quieter' | 'pause' | 'resume' | 'next' | 'prev' | 'window' }
  | { op: 'channel'; number: number }
  | { op: 'volume'; value: number }
  | { op: 'search'; query: string }
  | { op: 'link'; link: TvLink }
  | { op: 'settings'; rest: string }
  | { op: 'error'; text: string }

const VIDEO_ID = /^[\w-]{11}$/
const LIST_ID = /^[\w-]{10,64}$/

const WORDS: Readonly<Record<string, TvCommand['op']>> = {
  on: 'on',
  off: 'off',
  up: 'up',
  'ch+': 'up',
  down: 'down',
  'ch-': 'down',
  louder: 'louder',
  'vol+': 'louder',
  quieter: 'quieter',
  'vol-': 'quieter',
  pause: 'pause',
  stop: 'pause',
  play: 'resume',
  resume: 'resume',
  next: 'next',
  skip: 'next',
  prev: 'prev',
  previous: 'prev',
  back: 'prev',
  window: 'window',
}

// What /tv was asked: a word, a channel number, a volume, a link, settings, or a search.
export function parseTvCommand(args: string): TvCommand {
  const text = args.trim()
  if (text === '') return { op: 'open' }
  const lower = text.toLowerCase()
  const [first = '', ...rest] = lower.split(/\s+/)
  const word = WORDS[lower]
  if (word !== undefined) return { op: word } as TvCommand

  if (/^\d+$/.test(lower)) return { op: 'channel', number: Number(lower) }

  if (first === 'vol' || first === 'volume') {
    const value = rest.join('')
    if (value === '+' || value === 'up') return { op: 'louder' }
    if (value === '-' || value === 'down') return { op: 'quieter' }
    const n = Number(value)
    if (value === '' || !Number.isInteger(n) || n < 0 || n > 100) return { op: 'error', text: 'Volume is a whole number from 0 to 100, like /tv vol 40.' }
    return { op: 'volume', value: n }
  }

  if (first === 'settings') return { op: 'settings', rest: text.slice('settings'.length).trim() }

  const link = linkOf(text)
  if (link !== null) return { op: 'link', link }
  if (/^https?:\/\//i.test(text)) return { op: 'error', text: 'That link is not a YouTube video or playlist.' }

  const query = first === 'search' ? text.slice('search'.length).trim() : text
  if (query === '') return { op: 'error', text: 'Say what to search for, like /tv search lofi jazz.' }
  return { op: 'search', query }
}

// A YouTube video or playlist link, in any of its usual forms; null for anything else.
export function linkOf(text: string): TvLink | null {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return null
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  const list = url.searchParams.get('list')
  const goodList = list !== null && LIST_ID.test(list) ? list : null

  let id: string | null = null
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0] ?? null
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'watch') id = url.searchParams.get('v')
    else if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live' || parts[0] === 'v') id = parts[1] ?? null
    else if (parts[0] === 'playlist' && goodList !== null) return { kind: 'playlist', list: goodList }
  } else {
    return null
  }
  if (id !== null && VIDEO_ID.test(id)) return { kind: 'video', id, list: goodList }
  if (goodList !== null) return { kind: 'playlist', list: goodList }
  return null
}

// yt-dlp's -J answer for a search or a playlist: its videos, in order.
export function parseVideos(stdout: string): TvVideo[] {
  try {
    const parsed = JSON.parse(stdout) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) return []
    const videos: TvVideo[] = []
    for (const entry of parsed.entries as Array<Record<string, unknown>>) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = entry.id
      if (typeof id !== 'string' || !VIDEO_ID.test(id)) continue
      const title = typeof entry.title === 'string' ? entry.title : 'Untitled video'
      const channel = typeof entry.channel === 'string' ? entry.channel : typeof entry.uploader === 'string' ? entry.uploader : ''
      if (!videos.some(v => v.id === id)) videos.push({ id, title, channel })
    }
    return videos
  } catch {
    return []
  }
}

// One step up or down the channels, round the end; from nothing, up is the first and down the last.
export function stepChannel(current: number | null, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0
  if (current === null) return delta === 1 ? 0 : count - 1
  return (((current + delta) % count) + count) % count
}

export const clampVolume = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

export function stateLabel(state: TvState): string {
  if (state.power === 'off') return 'OFF'
  if (state.power === 'starting') return 'WARMING UP'
  if (state.isTuning) return 'TUNING'
  switch (state.playState) {
    case 1:
      return '▶ PLAYING'
    case 2:
      return '❚❚ PAUSED'
    case 3:
      return 'BUFFERING'
    case 0:
      return 'ENDED'
    default:
      return 'STARTING'
  }
}

export const isPlaying = (state: TvState) => state.power === 'on' && (state.playState === 1 || state.playState === 3)

// The channel number in the red display: two digits, AV for a search or link, -- while off.
export function channelDisplay(state: TvState): string {
  if (state.power === 'off') return '--'
  if (state.channel === null) return 'AV'
  return String(state.channel + 1).padStart(2, '0')
}

// The text cut into lines of at most `width`, at most `lines` of them, the last ending … when cut.
export function wrapLines(text: string, width: number, lines: number): string[] {
  if (width <= 0 || lines <= 0) return []
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  for (const word of words) {
    const piece = word.length > width ? word.slice(0, width - 1) + '…' : word
    if (line === '') line = piece
    else if (line.length + 1 + piece.length <= width) line += ` ${piece}`
    else {
      out.push(line)
      line = piece
      if (out.length === lines) break
    }
  }
  if (out.length < lines && line !== '') out.push(line)
  const isCut = out.join(' ').length < words.join(' ').length
  if (isCut && out.length > 0) {
    const last = out[out.length - 1]!
    out[out.length - 1] = last.length < width ? `${last}…` : `${last.slice(0, width - 1)}…`
  }
  return out
}

// Snow for a screen that is tuning: the same seed draws the same snow.
export function snow(width: number, rows: number, seed: number): string[] {
  const marks = [' ', '░', '▒', '▓', '·']
  let x = (seed * 2654435761) >>> 0 || 1
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < width; c++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      line += marks[x % marks.length]
    }
    out.push(line)
  }
  return out
}

export function volumeBar(volume: number, cells: number): { filled: number; empty: number } {
  const filled = Math.round((clampVolume(volume) / 100) * cells)
  return { filled, empty: cells - filled }
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function readTvSettings(saved: unknown): TvSettings {
  if (typeof saved !== 'object' || saved === null) return { ...DEFAULT_TV_SETTINGS, channels: DEFAULT_TV_SETTINGS.channels.map(c => ({ ...c })) }
  const s = saved as Partial<TvSettings>
  const channels = Array.isArray(s.channels)
    ? s.channels
        .filter((c): c is TvChannel => typeof c === 'object' && c !== null && typeof c.name === 'string' && typeof c.query === 'string' && c.name.trim() !== '' && c.query.trim() !== '')
        .slice(0, MAX_CHANNELS)
    : []
  const list = channels.length > 0 ? channels : DEFAULT_TV_SETTINGS.channels.map(c => ({ ...c }))
  const channel = typeof s.channel === 'number' && Number.isInteger(s.channel) && s.channel >= 0 && s.channel < list.length ? s.channel : 0
  return {
    channels: list,
    volume: typeof s.volume === 'number' ? clampVolume(s.volume) : DEFAULT_TV_SETTINGS.volume,
    channel,
    autoPause: typeof s.autoPause === 'boolean' ? s.autoPause : DEFAULT_TV_SETTINGS.autoPause,
  }
}

export function describeTvSettings(settings: TvSettings): string {
  const lines = settings.channels.map((c, i) => `${i + 1}. ${c.name}: searches "${c.query}"`)
  return [
    ...lines,
    `Volume: ${settings.volume}`,
    `Pause when Claude finishes or needs you: ${settings.autoPause ? 'on' : 'off'}`,
    'Change a channel with /tv settings channel 2 Jazz Piano = smooth jazz piano, or turn pausing off with /tv settings autopause off. /tv settings reset puts the first five channels back.',
  ].join('\n')
}

// "channel 2 Name = search", "autopause on", "remove 6" or "reset": the new settings, or a plain
// sentence saying what was wrong.
export function changeTvSettings(settings: TvSettings, args: string): TvSettings | string {
  const text = args.trim()
  const [first = '', second = ''] = text.toLowerCase().split(/\s+/)

  if (first === 'reset') return { ...settings, channels: DEFAULT_CHANNELS.map(c => ({ ...c })), channel: 0 }

  if (first === 'autopause' || first === 'pause') {
    if (second !== 'on' && second !== 'off') return 'Say on or off, like /tv settings autopause off.'
    return { ...settings, autoPause: second === 'on' }
  }

  if (first === 'remove') {
    const n = Number(second)
    if (!Number.isInteger(n) || n < 1 || n > settings.channels.length) return `Give a channel from 1 to ${settings.channels.length}, like /tv settings remove 5.`
    if (settings.channels.length === 1) return 'The TV needs at least one channel.'
    const channels = settings.channels.filter((_, i) => i !== n - 1)
    return { ...settings, channels, channel: Math.min(settings.channel, channels.length - 1) }
  }

  if (first === 'channel') {
    const match = /^channel\s+(\d+)\s+(.+?)\s*=\s*(.+)$/i.exec(text)
    if (match === null) return 'Write it as /tv settings channel 2 Jazz Piano = smooth jazz piano.'
    const n = Number(match[1])
    const name = match[2]!.trim().slice(0, 24)
    const query = match[3]!.trim().slice(0, 120)
    // A channel past the end is added there, up to the most the TV holds.
    if (n < 1 || n > Math.min(settings.channels.length + 1, MAX_CHANNELS)) {
      return `Give a channel from 1 to ${Math.min(settings.channels.length + 1, MAX_CHANNELS)}.`
    }
    const channels = settings.channels.map(c => ({ ...c }))
    channels[n - 1] = { name, query }
    return { ...settings, channels }
  }

  return 'Change channel, autopause, remove or reset, like /tv settings channel 2 Jazz Piano = smooth jazz piano.'
}
