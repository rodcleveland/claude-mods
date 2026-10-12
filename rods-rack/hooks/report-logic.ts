import type { ReportDay, ReportHistory, ReportKind, ReportSettings, ReportTab } from '../types'

// The Work Report's plain logic, with no engine calls: sorting a task by its tools, which prompts
// count, calendar days stepped at noon, adding days, ranges, streaks, estimates and big numerals.

export const KINDS: readonly ReportKind[] = ['emails', 'documents', 'media', 'research', 'coding', 'other']

export const KIND_LABELS: Readonly<Record<ReportKind, string>> = {
  emails: 'Emails',
  documents: 'Documents',
  media: 'Images and video',
  research: 'Research',
  coding: 'Coding',
  other: 'Other',
}

// The names /report settings takes for each kind.
export const KIND_SETTING_NAMES: Readonly<Record<string, ReportKind>> = {
  emails: 'emails',
  email: 'emails',
  documents: 'documents',
  docs: 'documents',
  images: 'media',
  video: 'media',
  media: 'media',
  research: 'research',
  coding: 'coding',
  code: 'coding',
  other: 'other',
}

export const DEFAULT_SETTINGS: ReportSettings = {
  minutes: { emails: 10, documents: 30, media: 20, research: 25, coding: 20, other: 10 },
  rate: 50,
}

export const GOLD = '#F2C46D'
export const HAIRLINE = '#262B33'
export const MUTED = '#7D8590'
export const TEXT = '#E6EDF3'
export const GREEN = '#3DD68C'
export const AMBER = '#E3B341'
export const BLUE = '#5AB0F0'
export const INK = '#14161A'

export const KIND_COLORS: Readonly<Record<ReportKind, string>> = {
  emails: '#8F9BFF',
  documents: GOLD,
  media: '#E06C9F',
  research: GREEN,
  coding: '#6CC5E8',
  other: MUTED,
}

// ── Which tasks count, and what kind each is ─────────────────────────────────

// One typed request is one task: the person's own prompt, not a slash command or a notice.
export function isTypedPrompt(text: string, originKind: string): boolean {
  const plain = text.trim()
  return (originKind === 'composer' || originKind === 'human') && plain !== '' && !plain.startsWith('/') && !plain.startsWith('<')
}

// Tools that write a file: only a file written (an image made, a document saved) says what the
// work was; one merely read, like a screenshot looked at while debugging, does not.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// What a tool call touched, as signals: its name, plus the file it wrote, the skill or the command.
export function signalsOf(tool: string, input: Record<string, unknown>): string[] {
  const out = [`tool:${tool}`]
  if (WRITE_TOOLS.has(tool)) {
    for (const key of ['file_path', 'notebook_path']) {
      const value = input[key]
      if (typeof value === 'string' && value !== '') out.push(`file:${value}`)
    }
  }
  if (typeof input.skill === 'string') out.push(`skill:${input.skill}`)
  if (typeof input.command === 'string') out.push(`bash:${input.command.slice(0, 300)}`)
  return out
}

const MAIL = /gmail|outlook|email|_mail|mail_/i
const MEDIA_TOOL = /image|video|openart|higgsfield|photo|thumbnail|gif|nano.?banana|generate_image/i
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|heic|svg|mp4|mov|webm|m4v|avi|mkv)$/i
const DOC_TOOL = /docx|pptx|xlsx|\bpdf\b|_pdf|pdf_|slides?|spreadsheet|sheets?|claude_docs|google_drive|documents?|word/i
const DOC_FILE = /\.(docx?|pptx?|xlsx?|pdf|odt|rtf|key|pages)$/i
// Coding: a file written that is no image, video or document, or a build, test or git command.
const CODE_COMMAND = /\b(git (commit|push|merge|rebase|checkout|switch)|npm (run|test|install|ci)|npx|pnpm|yarn|bun|pytest|jest|vitest|tsc|cargo|go (build|test|run)|dotnet|msbuild|gradle|mvn|make|claude plugin (test|validate))\b/
const RESEARCH = /websearch|webfetch|web_search|fetch|search_web|transcript|youtube|yt-dlp|context7|scrape|deep-research|research/i

// One kind per task, the first that any of its signals matches: Emails, Images and video, Documents,
// Coding, Research, then Other. Coding outranks Research, so looking up docs while coding is coding.
export function classify(signals: readonly string[]): ReportKind {
  const tools = signals.filter(s => s.startsWith('tool:') || s.startsWith('skill:')).map(s => s.slice(s.indexOf(':') + 1))
  const files = signals.filter(s => s.startsWith('file:')).map(s => s.slice(5))
  const commands = signals.filter(s => s.startsWith('bash:')).map(s => s.slice(5))
  if (tools.some(t => MAIL.test(t))) return 'emails'
  if (tools.some(t => MEDIA_TOOL.test(t)) || files.some(f => MEDIA_FILE.test(f))) return 'media'
  if (tools.some(t => DOC_TOOL.test(t)) || files.some(f => DOC_FILE.test(f))) return 'documents'
  if (files.length > 0 || commands.some(c => CODE_COMMAND.test(c))) return 'coding'
  if (tools.some(t => RESEARCH.test(t)) || commands.some(c => /yt-dlp|curl\s+https?:/.test(c))) return 'research'
  return 'other'
}

// "claude-opus-5-5" is Opus 5.5; anything else keeps its own name.
export function modelLabel(model: string | null | undefined): string {
  if (model === null || model === undefined || model === '') return 'Not recorded'
  const match = /claude-([a-z]+)-(\d+)-(\d+)/i.exec(model)
  if (match === null) return model
  const family = match[1]!
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`
}

// ── Days ─────────────────────────────────────────────────────────────────────

export const emptyDay = (): ReportDay => ({ kinds: { emails: 0, documents: 0, media: 0, research: 0, coding: 0, other: 0 }, models: {} })

export function recordTask(day: ReportDay | undefined, kind: ReportKind, model: string): ReportDay {
  const base = day ?? emptyDay()
  return {
    kinds: { ...base.kinds, [kind]: (base.kinds[kind] ?? 0) + 1 },
    models: { ...base.models, [model]: (base.models[model] ?? 0) + 1 },
  }
}

// Days are stepped at noon UTC, so a clock change never skips or repeats a date.
const noon = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12)
}
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export const isDayKey = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text.trim())

export function addDays(key: string, n: number): string {
  return keyOf(noon(key) + n * 86_400_000)
}

export function dayOfYear(key: string): number {
  return Math.round((noon(key) - noon(`${key.slice(0, 4)}-01-01`)) / 86_400_000) + 1
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const weekday = (key: string) => WEEKDAYS[new Date(noon(key)).getUTCDay()]!
export const shortDate = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`
export const longDate = (key: string) => `${WEEKDAYS_LONG[new Date(noon(key)).getUTCDay()]}, ${shortDate(key)}`

// The days a tab covers, oldest first: today; the last 7; the last 30; January 1 through today.
export function daysFor(tab: ReportTab, today: string): string[] {
  const back = (n: number) => Array.from({ length: n }, (_, i) => addDays(today, i - n + 1))
  if (tab === 'today') return [today]
  if (tab === 'week') return back(7)
  if (tab === 'month') return back(30)
  return back(dayOfYear(today))
}

export const TAB_TITLES: Readonly<Record<ReportTab, string>> = {
  today: "TODAY'S WORK",
  week: 'LAST 7 DAYS',
  month: 'LAST 30 DAYS',
  year: 'THIS YEAR',
}

export function tabDates(tab: ReportTab, today: string): string {
  if (tab === 'today') return longDate(today)
  const days = daysFor(tab, today)
  return `${shortDate(days[0]!)} to ${shortDate(today)}`
}

// A day's record: the history estimate before its cutoff day, both on that day, live records after.
export function dayRecord(key: string, live: Readonly<Record<string, ReportDay>>, history: ReportHistory | null): ReportDay | undefined {
  const own = live[key]
  const past = history !== null && key <= history.cutoffDay ? history.days[key] : undefined
  if (past === undefined) return own
  if (own === undefined || key < history!.cutoffDay) return past
  return sumDays([past, own])
}

export function sumDays(days: ReadonlyArray<ReportDay | undefined>): ReportDay {
  const total = emptyDay()
  for (const day of days) {
    if (day === undefined) continue
    for (const kind of KINDS) total.kinds[kind] += day.kinds[kind] ?? 0
    for (const [model, n] of Object.entries(day.models)) total.models[model] = (total.models[model] ?? 0) + n
  }
  return total
}

export const taskCount = (day: ReportDay | undefined) => (day === undefined ? 0 : KINDS.reduce((n, k) => n + (day.kinds[k] ?? 0), 0))

export const kindHours = (day: ReportDay, kind: ReportKind, settings: ReportSettings) => ((day.kinds[kind] ?? 0) * settings.minutes[kind]) / 60

export function hoursSaved(day: ReportDay | undefined, settings: ReportSettings): number {
  if (day === undefined) return 0
  return KINDS.reduce((h, k) => h + kindHours(day, k, settings), 0)
}

// ── Streaks and best days ────────────────────────────────────────────────────

// Days in a row with a finished task, ending today (or yesterday, while today has none yet).
export function streak(hasTasks: (key: string) => boolean, today: string): number {
  let day = hasTasks(today) ? today : addDays(today, -1)
  let count = 0
  while (hasTasks(day) && count < 3660) {
    count += 1
    day = addDays(day, -1)
  }
  return count
}

export function bestDay(days: readonly string[], hoursOf: (key: string) => number): { key: string; hours: number } | null {
  let best: { key: string; hours: number } | null = null
  for (const key of days) {
    const hours = hoursOf(key)
    if (hours > 0 && (best === null || hours > best.hours)) best = { key, hours }
  }
  return best
}

// ── Numbers ──────────────────────────────────────────────────────────────────

export const formatHours = (h: number) => (h < 10 ? (Math.round(h * 10) / 10).toFixed(1) : Math.round(h).toLocaleString('en-US'))
export const formatCount = (n: number) => n.toLocaleString('en-US')
export const formatDollars = (d: number) => `$${Math.round(d).toLocaleString('en-US')}`

// Big numerals: three rows of heavy box-drawing characters per glyph.
const GLYPHS: Readonly<Record<string, readonly [string, string, string]>> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
  '.': [' ', ' ', '•'],
  ',': [' ', ' ', '╻'],
  '$': ['┏┿╸', '┗┿┓', '╺┿┛'],
}

// Three rows, or null when a character has no glyph.
export function bigText(text: string): [string, string, string] | null {
  const rows: [string[], string[], string[]] = [[], [], []]
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (glyph === undefined) return null
    for (let r = 0; r < 3; r += 1) rows[r]!.push(glyph[r]!)
  }
  return [rows[0].join(' '), rows[1].join(' '), rows[2].join(' ')]
}

export const bigWidth = (text: string) => bigText(text)?.[0].length ?? Infinity

// Three tiles a row when the pane is wide, then two, then one.
export function tilesPerRow(width: number): number {
  return width >= 66 ? 3 : width >= 44 ? 2 : 1
}

// A bar of `cells` scaled to the largest value.
export function barCells(value: number, max: number, cells: number): number {
  if (value <= 0 || max <= 0) return 0
  return Math.max(1, Math.round((value / max) * cells))
}

// A column three rows tall: each row a block from ▁ to █, bottom first.
const LEVELS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
export function column(value: number, max: number): [string, string, string] {
  const eighths = max <= 0 || value <= 0 ? 0 : Math.max(1, Math.round((value / max) * 24))
  const row = (from: number) => LEVELS[Math.max(0, Math.min(8, eighths - from))]!
  return [row(16), row(8), row(0)]
}

// ── /report settings ─────────────────────────────────────────────────────────

export function describeSettings(settings: ReportSettings): string {
  const lines = KINDS.map(k => `${KIND_LABELS[k]}: ${settings.minutes[k]} minutes a task`)
  return [...lines, `Hourly rate: $${settings.rate}`, 'Change one with /report settings rate 75 or /report settings emails 15. Hours and dollars are estimates.'].join('\n')
}

// "rate 75" or "emails 15": the new settings, or a plain sentence saying what was wrong.
export function changeSettings(settings: ReportSettings, args: string): ReportSettings | string {
  const [name = '', value = ''] = args.trim().toLowerCase().split(/\s+/)
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 100_000 || value === '') return 'Give a number, like /report settings rate 75.'
  if (name === 'rate') return { ...settings, rate: n }
  const kind = KIND_SETTING_NAMES[name]
  if (kind === undefined) return 'Change rate, emails, documents, images, research, coding or other, like /report settings emails 15.'
  if (n > 1440) return 'Minutes a task is a number from 0 to 1440.'
  return { ...settings, minutes: { ...settings.minutes, [kind]: n } }
}

export function readSettings(saved: unknown): ReportSettings {
  if (typeof saved !== 'object' || saved === null) return DEFAULT_SETTINGS
  const s = saved as Partial<ReportSettings>
  return {
    rate: typeof s.rate === 'number' ? s.rate : DEFAULT_SETTINGS.rate,
    minutes: { ...DEFAULT_SETTINGS.minutes, ...(typeof s.minutes === 'object' && s.minutes !== null ? s.minutes : {}) },
  }
}

export function readHistory(text: string): ReportHistory | null {
  try {
    const parsed = JSON.parse(text) as Partial<ReportHistory>
    if (typeof parsed.cutoffDay !== 'string' || !isDayKey(parsed.cutoffDay) || typeof parsed.days !== 'object' || parsed.days === null) return null
    return { cutoffDay: parsed.cutoffDay, days: parsed.days }
  } catch {
    return null
  }
}
