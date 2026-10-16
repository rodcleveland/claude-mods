import type { AgentTurn, DayMap, Pause, SessionRecord, Tokens, Totals, Turn } from '../types'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const emptyTotals = (): Totals => ({
  ...emptyTokens(),
  sessions: 0,
  turns: 0,
  clockMs: 0,
  activeMs: 0,
  claudeMs: 0,
  pausedMs: 0,
  agentTokens: emptyTokens(),
  models: {},
})

export const tokenSum = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite

/** The four counts the engine reports, renamed; anything missing reads as zero. */
export function readUsage(usage: unknown): Tokens & { model: string } {
  const u = (usage ?? {}) as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    model: typeof u.model === 'string' ? u.model : '',
  }
}

export function newRecord(sessionId: string, root: string, now: number): SessionRecord {
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  return {
    version: 1,
    sessionId,
    project: { root, name },
    segments: [{ start: now, end: now }],
    turns: [],
    agentTurns: [],
  }
}

/**
 * A resumed session keeps its file and opens a new segment, so the time it was closed isn't counted.
 * A pause left open when it closed ends where the old segment did, so the resumed one starts unpaused.
 */
export function resume(rec: SessionRecord, now: number): SessionRecord {
  const oldEnd = rec.segments[rec.segments.length - 1]?.end
  const pauses = (rec.pauses ?? []).map((p): Pause =>
    p.end === null ? { start: p.start, end: Math.max(p.start, oldEnd ?? now) } : p,
  )
  return {
    ...rec,
    ...(rec.pauses === undefined ? {} : { pauses }),
    segments: [...rec.segments, { start: now, end: now }],
  }
}

export const isPaused = (rec: SessionRecord): boolean => rec.pauses?.[rec.pauses.length - 1]?.end === null

/** Starts a pause; does nothing if one is already open. */
export const pause = (rec: SessionRecord, now: number): SessionRecord =>
  isPaused(rec) ? rec : touch({ ...rec, pauses: [...(rec.pauses ?? []), { start: now, end: null }] }, now)

/** Ends the open pause; does nothing if the timer isn't paused. */
export function unpause(rec: SessionRecord, now: number): SessionRecord {
  const pauses = (rec.pauses ?? []).slice()
  const last = pauses[pauses.length - 1]
  if (last === undefined || last.end !== null) return rec
  pauses[pauses.length - 1] = { start: last.start, end: Math.max(last.start, now) }
  return touch({ ...rec, pauses }, now)
}

/** The paused stretches that have ended; an open pause runs to the end of the last segment. */
export function pauseSpans(rec: SessionRecord): Array<[number, number]> {
  const limit = rec.segments[rec.segments.length - 1]?.end ?? -Infinity
  return (rec.pauses ?? []).map((p): Span => [p.start, Math.max(p.start, p.end ?? limit)])
}

/** Moves the open segment's end to now. */
export function touch(rec: SessionRecord, now: number): SessionRecord {
  const segments = rec.segments.slice()
  const last = segments[segments.length - 1]
  if (last === undefined) segments.push({ start: now, end: now })
  else segments[segments.length - 1] = { ...last, end: Math.max(last.end, now) }
  return { ...rec, segments }
}

export const addTurn = (rec: SessionRecord, turn: Turn): SessionRecord =>
  touch({ ...rec, turns: [...rec.turns, turn] }, turn.start + turn.ms)

export const addAgentTurn = (rec: SessionRecord, turn: AgentTurn): SessionRecord =>
  touch({ ...rec, agentTurns: [...rec.agentTurns, turn] }, turn.start)

type Span = [number, number]

/** `spans` with every `cuts` stretch taken out; overlapping cuts only remove their time once. */
function subtract(spans: Span[], cuts: Span[]): Span[] {
  const sorted = cuts.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Span[] = []
  for (const [a, b] of spans) {
    let from = a
    for (const [c, d] of sorted) {
      if (d <= from) continue
      if (c >= b) break
      if (c > from) out.push([from, c])
      from = Math.max(from, d)
      if (from >= b) break
    }
    if (from < b) out.push([from, b])
  }
  return out
}

const clippedLength = (spans: Span[], from: number, to: number) =>
  spans.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0)

/**
 * The stretches someone was working: every turn, plus the gaps between them (reading, typing)
 * that are shorter than the idle limit. A session left open overnight adds nothing past it.
 */
export function activeSpans(rec: SessionRecord, idleMs: number): Span[] {
  const spans: Span[] = []
  for (const seg of rec.segments) {
    const turns = rec.turns.filter(t => t.start >= seg.start && t.start <= seg.end).sort((a, b) => a.start - b.start)
    let cursor = seg.start
    for (const t of turns) {
      const gap = t.start - cursor
      if (gap > 0 && gap <= idleMs) spans.push([cursor, t.start])
      const end = t.start + t.ms
      if (end > Math.max(cursor, t.start)) spans.push([Math.max(cursor, t.start), end])
      cursor = Math.max(cursor, end)
    }
    const tail = seg.end - cursor
    if (tail > 0 && tail <= idleMs) spans.push([cursor, seg.end])
  }
  return spans
}

/** One session's figures inside [from, to). A turn's tokens count on the day it started. */
export function sessionTotals(rec: SessionRecord, idleMs: number, from = -Infinity, to = Infinity): Totals {
  const tot = emptyTotals()
  const segs: Span[] = rec.segments.map(s => [s.start, s.end])
  tot.clockMs = clippedLength(segs, from, to)
  const cuts = pauseSpans(rec)
  tot.activeMs = clippedLength(subtract(activeSpans(rec, idleMs), cuts), from, to)
  tot.claudeMs = clippedLength(subtract(rec.turns.map(t => [t.start, t.start + t.ms] as Span), cuts), from, to)
  tot.pausedMs = tot.clockMs - clippedLength(subtract(segs, cuts), from, to)
  for (const t of rec.turns) {
    if (t.start < from || t.start >= to) continue
    tot.turns += 1
    tot.input += t.input
    tot.output += t.output
    tot.cacheRead += t.cacheRead
    tot.cacheWrite += t.cacheWrite
    tot.models[t.model] = (tot.models[t.model] ?? 0) + tokenSum(t)
  }
  for (const t of rec.agentTurns) {
    if (t.start < from || t.start >= to) continue
    tot.agentTokens.input += t.input
    tot.agentTokens.output += t.output
    tot.agentTokens.cacheRead += t.cacheRead
    tot.agentTokens.cacheWrite += t.cacheWrite
  }
  const touched = tot.clockMs > 0 || tot.turns > 0 || tokenSum(tot.agentTokens) > 0
  const startsInside = rec.segments.some(s => s.start >= from && s.start < to)
  tot.sessions = touched || startsInside ? 1 : 0
  return tot
}

export function addTotals(a: Totals, b: Totals): Totals {
  return {
    sessions: a.sessions + b.sessions,
    turns: a.turns + b.turns,
    clockMs: a.clockMs + b.clockMs,
    activeMs: a.activeMs + b.activeMs,
    claudeMs: a.claudeMs + b.claudeMs,
    pausedMs: a.pausedMs + b.pausedMs,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    agentTokens: {
      input: a.agentTokens.input + b.agentTokens.input,
      output: a.agentTokens.output + b.agentTokens.output,
      cacheRead: a.agentTokens.cacheRead + b.agentTokens.cacheRead,
      cacheWrite: a.agentTokens.cacheWrite + b.agentTokens.cacheWrite,
    },
    models: mergeCounts(a.models, b.models),
  }
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a }
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n
  return out
}

export const sumTotals = (records: SessionRecord[], idleMs: number, from?: number, to?: number) =>
  records.reduce((acc, r) => addTotals(acc, sessionTotals(r, idleMs, from, to)), emptyTotals())

// ---- Days, in local time ----

const pad = (n: number) => String(n).padStart(2, '0')

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function ymd(key: string): [number, number, number] {
  const [y = NaN, m = NaN, d = NaN] = key.split('-').map(Number)
  return [y, m, d]
}

/** Local midnight that opens the day `key` (YYYY-MM-DD). */
export function dayStart(key: string): number {
  const [y, m, d] = ymd(key)
  return new Date(y, m - 1, d).getTime()
}

/** The local midnight `days` days after the one that opens `key`, safe across clock changes. */
export function shiftDay(key: string, days: number): number {
  const [y, m, d] = ymd(key)
  return new Date(y, m - 1, d + days).getTime()
}

/** Every local day a record touches, oldest first. */
function daysTouched(records: SessionRecord[]): string[] {
  const days = new Set<string>()
  for (const r of records) {
    for (const s of r.segments) {
      for (let key = dayKey(s.start); dayStart(key) <= s.end; key = dayKey(shiftDay(key, 1))) days.add(key)
    }
  }
  return [...days].sort()
}

export function byDay(records: SessionRecord[], idleMs: number, from = -Infinity, to = Infinity) {
  return daysTouched(records)
    .map(day => {
      const a = Math.max(dayStart(day), from)
      const b = Math.min(shiftDay(day, 1), to)
      return { day, totals: a < b ? sumTotals(records, idleMs, a, b) : emptyTotals() }
    })
    .filter(d => d.totals.sessions > 0)
}

export const dayMap = (records: SessionRecord[], idleMs: number): DayMap =>
  Object.fromEntries(byDay(records, idleMs).map(d => [d.day, d.totals]))

export function mergeDayMaps(a: DayMap, b: DayMap): DayMap {
  const out = { ...a }
  for (const [day, t] of Object.entries(b)) out[day] = out[day] ? addTotals(out[day], t) : t
  return out
}

export const sumDays = (map: DayMap, keep: (day: string) => boolean = () => true) =>
  Object.entries(map).reduce((acc, [day, t]) => (keep(day) ? addTotals(acc, t) : acc), emptyTotals())

/** The last `n` local days, oldest first, ending today. */
export const lastDays = (today: string, n: number) =>
  Array.from({ length: n }, (_, i) => dayKey(shiftDay(today, i - (n - 1))))

/** Every day of today's month so far. */
export const monthDays = (today: string) => lastDays(today, Number(today.slice(8, 10)))

/** The last `n` months as YYYY-MM, oldest first, ending this one. */
export function lastMonths(today: string, n: number): string[] {
  const [y = 1970, m = 1] = today.split('-').map(Number)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 - (n - 1 - i), 1)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  })
}

/** Days in a row, back from today, with any active time; a quiet today doesn't break it yet. */
export function streak(map: DayMap, today: string): number {
  let run = 0
  for (let i = (map[today]?.activeMs ?? 0) > 0 ? 0 : 1; ; i += 1) {
    if ((map[dayKey(shiftDay(today, -i))]?.activeMs ?? 0) <= 0) return run
    run += 1
  }
}

// "claude-opus-5-5" is Opus 5.5; anything else keeps its own name.
export function modelLabel(model: string): string {
  if (model === '') return 'Not recorded'
  const match = /claude-([a-z]+)-(\d+)-(\d+)/i.exec(model)
  if (match === null) return model
  const family = match[1] ?? ''
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`
}

// ---- The report command's arguments ----

export type Query = {
  from: number
  to: number
  label: string
  allProjects: boolean
  listSessions: boolean
}

export const USAGE =
  'Usage: /token-time-report [today | yesterday | week | month | all | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD] [all-projects] [sessions]'

export function parseQuery(args: string, now: number): Query | { error: string } {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const q: Query = { from: dayStart(dayKey(now)), to: Infinity, label: 'Today', allProjects: false, listSessions: false }
  const today = dayKey(now)
  const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayStart(s))
  for (const w of words) {
    if (w === 'all-projects' || w === 'projects') q.allProjects = true
    else if (w === 'sessions') q.listSessions = true
    else if (w === 'today') Object.assign(q, { from: dayStart(today), to: Infinity, label: 'Today' })
    else if (w === 'yesterday') Object.assign(q, { from: shiftDay(today, -1), to: dayStart(today), label: 'Yesterday' })
    else if (w === 'week') Object.assign(q, { from: shiftDay(today, -6), to: Infinity, label: 'Last 7 days' })
    else if (w === 'month') {
      const first = `${today.slice(0, 7)}-01`
      Object.assign(q, { from: dayStart(first), to: Infinity, label: `This month (${today.slice(0, 7)})` })
    } else if (w === 'all') Object.assign(q, { from: -Infinity, to: Infinity, label: 'All time' })
    else if (isDay(w)) Object.assign(q, { from: dayStart(w), to: shiftDay(w, 1), label: w })
    else if (/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(w)) {
      const [a = '', b = ''] = w.split('..')
      if (!isDay(a) || !isDay(b) || a > b) return { error: `"${w}" isn't a date range. ${USAGE}` }
      Object.assign(q, { from: dayStart(a), to: shiftDay(b, 1), label: `${a} to ${b}` })
    } else return { error: `I don't know "${w}". ${USAGE}` }
  }
  return q
}

// ---- Formatting ----

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${pad(m)}m`
  if (m > 0) return `${m}m ${pad(s % 60)}s`
  return `${s}s`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

const tokenCells = (t: Tokens) =>
  [t.input, t.output, t.cacheRead, t.cacheWrite, tokenSum(t)].map(formatTokens).join(' | ')

const row = (label: string, t: Totals) =>
  `| ${label} | ${t.sessions} | ${t.turns} | ${formatDuration(t.clockMs)} | ${formatDuration(t.activeMs)} | ` +
  `${formatDuration(t.claudeMs)} | ${formatDuration(t.pausedMs)} | ${tokenCells(t)} | ${formatTokens(tokenSum(t.agentTokens))} |`

const HEADER =
  '| | Sessions | Turns | On the clock | Active | Claude working | Paused | Input | Output | Cache read | Cache write | Total tokens | Subagent tokens |\n' +
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'

export function formatReport(
  q: Query,
  projects: { name: string; root: string; records: SessionRecord[] }[],
  idleMs: number,
): string {
  const scope = q.allProjects ? 'all projects' : (projects[0]?.name ?? 'this project')
  const lines = [`## Token and time report: ${q.label}, ${scope}`, '']
  const all = projects.flatMap(p => p.records)
  const total = sumTotals(all, idleMs, q.from, q.to)
  if (total.sessions === 0) return [...lines, 'Nothing was tracked in that period.'].join('\n')

  lines.push(HEADER, row('**Total**', total), '')

  if (q.allProjects) {
    lines.push('### By project', '', HEADER)
    for (const p of projects) {
      const t = sumTotals(p.records, idleMs, q.from, q.to)
      if (t.sessions > 0) lines.push(row(p.name, t))
    }
    lines.push('')
  }

  const days = byDay(all, idleMs, q.from, q.to)
  if (days.length > 1 || q.from === -Infinity) {
    lines.push('### By day', '', HEADER, ...days.map(d => row(d.day, d.totals)), '')
  }

  if (q.listSessions) {
    lines.push('### Sessions', '', HEADER)
    const rows = projects
      .flatMap(p => p.records.map(r => ({ p, r, t: sessionTotals(r, idleMs, q.from, q.to) })))
      .filter(x => x.t.sessions > 0)
      .sort((a, b) => (a.r.segments[0]?.start ?? 0) - (b.r.segments[0]?.start ?? 0))
    for (const { p, r, t } of rows) {
      const started = r.segments[0] ? new Date(r.segments[0].start) : undefined
      const when = started ? `${dayKey(started.getTime())} ${pad(started.getHours())}:${pad(started.getMinutes())}` : '?'
      lines.push(row(`${when}${q.allProjects ? ` ${p.name}` : ''} \`${r.sessionId.slice(0, 8)}\``, t))
    }
    lines.push('')
  }

  lines.push(
    `_On the clock: how long sessions were open. Active: turns plus gaps under ${Math.round(idleMs / MINUTE)} minutes. ` +
      'Claude working: time Claude spent on turns. ' +
      'Paused: time you paused the timer, left out of Active and Claude working. Subagent tokens are extra to the token columns._',
  )
  return lines.join('\n')
}

export { DAY, MINUTE }
