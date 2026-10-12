import type { DockCard, DockCardStatus, DockMission, RackHelper } from '../types'

// The Agent Dock's plain logic, with no engine calls: team sizes, names, badges, the instruction
// and nudge texts, counts, clocks, the summary, meters and the mission's changes.

export const SIZES = [1, 3, 5, 10, 20, 50, 100] as const
export const MAX_SIZE = 100
// Above this a size asks first, and never carries over to the next session.
export const BIG_TEAM = 20
// More helpers than this and the cards give way to a strip of seats and a "working now" list.
export const CARD_LIMIT = 12
export const IDLE_SEATS = 25

export const CORAL = '#F2785C'
export const GOLD = '#F2C46D'
export const LIVE_GREEN = '#3DD68C'
export const STUCK_RED = '#F25C5C'
export const SLATE = '#262B33'
export const MUTED = '#7D8590'
export const TEXT = '#E6EDF3'
export const INK = '#14161A'

const BADGE_COLORS = ['#5AB0F0', '#B07AA1', '#4FC1B0', '#E8743B', '#E06C9F', '#8F9BFF', '#D9A441', '#6CC5E8'] as const

// The model helper agents use, set in Rods Rack's Helper agents row and shown in the dock.
export const HELPER_OPTIONS: ReadonlyArray<{ value: RackHelper; label: string; alias: 'haiku' | 'sonnet' | null }> = [
  { value: 'fast', label: 'Fast & Cheap', alias: 'haiku' },
  { value: 'balanced', label: 'Balanced', alias: 'sonnet' },
  { value: 'same', label: 'Same as main', alias: null },
]

export const PLAN_TOOL = 'mcp__rods-rack__plan_steps'
export const REPORT_TOOL = 'mcp__rods-rack__report_progress'

export const IDLE_MISSION: DockMission = {
  id: 0,
  name: '',
  phase: 'idle',
  size: 1,
  wantsSplit: false,
  admitted: 0,
  nudged: false,
  cards: [],
  startedAt: null,
  finishedAt: null,
}

// ── Sizes ────────────────────────────────────────────────────────────────────

// A whole number from 1 to 100, or null.
export function parseSize(text: string): number | null {
  const plain = text.trim()
  if (!/^\d+$/.test(plain)) return null
  const size = Number(plain)
  return size >= 1 && size <= MAX_SIZE ? size : null
}

// What a new session starts with: a saved size up to 20 stays, a big team goes back to 1.
export function restoredSize(saved: unknown): number {
  return typeof saved === 'number' && Number.isInteger(saved) && saved >= 1 && saved <= BIG_TEAM ? saved : 1
}

export const isBigTeam = (size: number) => size > BIG_TEAM

// How many helpers run at once: the lower of the engine's subagent limit and its tool limit.
export function atATime(subagents: string | undefined, tools: string | undefined): number {
  const read = (value: string | undefined, fallback: number) => {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 ? n : fallback
  }
  return Math.min(read(subagents, 20), read(tools, 10))
}

// ── Names ────────────────────────────────────────────────────────────────────

function trimTo(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return (space > max / 2 ? head.slice(0, space) : head).replace(/[\s,.;:–-]+$/, '') + '…'
}

// The mission: the request's first clause, about 40 characters.
export function jobName(request: string): string {
  const first = request.trim().split(/[.!?\n;:]|,\s|\s[-–—]\s|\s+(?:and then|then)\s+/)[0] ?? ''
  const plain = first.replace(/\s+/g, ' ').trim()
  if (plain === '') return 'Your request'
  return trimTo(plain.charAt(0).toUpperCase() + plain.slice(1), 40)
}

// A helper's task, from the Agent call's short description.
export function taskName(description: unknown): string {
  const plain = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : ''
  return plain === '' ? 'Helper task' : trimTo(plain, 36)
}

// Two letters for a helper's badge: the first and last words' first letters ("Price check: Panera"
// is PP), or a lone word's first two.
export function initials(name: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? []
  if (words.length === 0) return '··'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase().padEnd(2, '·')
  return (words[0]!.charAt(0) + words.at(-1)!.charAt(0)).toUpperCase()
}

export const badgeColor = (index: number) => BADGE_COLORS[index % BADGE_COLORS.length]!

// ── What Claude is told ──────────────────────────────────────────────────────

export const HELPER_NOTE =
  `As you work, call ${REPORT_TOOL} with your task name and a percent at about 25, 50, 75 and 100. ` +
  `Do not call ${PLAN_TOOL}.`

// The context a request carries at Team Size n; nothing at 1, where Claude decides.
export function splitInstruction(size: number): string | null {
  if (size <= 1) return null
  return [
    `Team Size is ${size}. Split this request into exactly ${size} independent pieces and launch one helper (the Agent tool) per piece, all ${size} in one message so they run in parallel.`,
    'Find a real split, one helper per item: per store, per task, per file, per section. Never argue that it cannot be split, and never pad it with useless work.',
    'Give each helper a short plain-English description of 3 to 5 words, like "Price check: Panera".',
    `In each helper's prompt add: "${HELPER_NOTE}"`,
    'When they finish, combine their results into one answer.',
  ].join('\n')
}

export const capDenial = (size: number) =>
  `Team Size is ${size}: this request already has ${size} helpers. Finish with the helpers you have.`

export function nudgeText(used: number, size: number): string {
  return `You used ${used} of ${size} helpers. Split the remaining work across the other ${size - used}, one helper per piece, all in parallel.`
}

export const STOPPED_DENIAL = 'Stopped before this helper started.'
export const HELPER_PLAN_ANSWER = 'Helpers skip the plan. Just call report_progress as you work.'

// ── Counts, clocks and lines ─────────────────────────────────────────────────

export type DockCounts = Record<DockCardStatus, number>

export function counts(cards: readonly DockCard[]): DockCounts {
  const tally: DockCounts = { queued: 0, working: 0, done: 0, stuck: 0 }
  for (const card of cards) tally[card.status] += 1
  return tally
}

// The status-line badge while the dock is folded: "12 working · 8 queued · 30 done".
export function badge(mission: DockMission): string | null {
  if (mission.phase === 'idle' || mission.cards.length === 0) return null
  const c = counts(mission.cards)
  if (mission.phase === 'done') return `Dock: ${summary(mission, mission.finishedAt ?? 0)}`
  return [`${c.working} working`, `${c.queued} queued`, `${c.done} done`, ...(c.stuck > 0 ? [`${c.stuck} stuck`] : [])].join(' · ')
}

// "1:12", minutes and seconds.
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// "2m 14s", for the summary.
export function took(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export function summary(mission: DockMission, now: number): string {
  const n = mission.cards.length
  const stuck = counts(mission.cards).stuck
  const ms = (mission.finishedAt ?? now) - (mission.startedAt ?? now)
  const who = n === 1 ? '1 agent' : `${n} agents`
  return `${who} finished ${mission.name} in ${took(ms)}${stuck > 0 ? ` (${stuck} got stuck)` : ''}`
}

export function infoLine(size: number, perWave: number, helperLabel: string): string {
  const split = size <= 1 ? 'Claude decides how many helpers' : `Splits each request across ${size} helpers`
  return `${split}  ·  ${Math.min(perWave, Math.max(size, 1))} at a time  ·  ${helperLabel}`
}

// The whole mission's percent: each done helper in full, a working one by its report.
export function missionPercent(cards: readonly DockCard[]): number {
  if (cards.length === 0) return 0
  const share = cards.reduce((sum, c) => sum + (c.status === 'done' ? 100 : c.status === 'working' && c.hasReported ? c.percent : 0), 0)
  return Math.round(share / cards.length)
}

export function cardMeter(card: DockCard, cells: number, frame: number): string {
  if (card.status === 'done') return '━'.repeat(cells)
  if (card.status === 'queued') return '─'.repeat(cells)
  if (card.hasReported || card.status === 'stuck') {
    const filled = Math.round((card.percent / 100) * cells)
    return '━'.repeat(filled) + '─'.repeat(cells - filled)
  }
  // Not reported yet: a three-cell sweep.
  return Array.from({ length: cells }, (_, i) => ((i - frame) % cells + cells) % cells < 3 ? '━' : '─').join('')
}

// Two or three cards a row, by width; one when it is very narrow.
export function cardsPerRow(columns: number): number {
  return columns >= 100 ? 3 : columns >= 60 ? 2 : 1
}

// Rods Rack's status line holds Auto Model's entry and the folded dock's badge together.
export function composeStatus(auto: string | null, dock: string | null): string | undefined {
  const parts = [auto, dock].filter((p): p is string => p !== null && p !== '')
  return parts.length === 0 ? undefined : parts.join('  ·  ')
}

// ── Colors ───────────────────────────────────────────────────────────────────

const hex = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))

// The color a fraction t of the way from one hex color to another.
export function mix(from: string, to: string, t: number): string {
  const a = hex(from)
  const b = hex(to)
  const clamped = Math.max(0, Math.min(1, t))
  return '#' + a.map((v, i) => Math.round(v + (b[i]! - v) * clamped).toString(16).padStart(2, '0')).join('')
}

// Text cut into runs, each a color along a coral-to-gold sweep.
export function sweep(text: string, from: string, to: string, runs = 8): Array<{ text: string; color: string }> {
  if (text.length === 0) return []
  const size = Math.max(1, Math.ceil(text.length / runs))
  const out: Array<{ text: string; color: string }> = []
  for (let at = 0; at < text.length; at += size) {
    out.push({ text: text.slice(at, at + size), color: mix(from, to, text.length <= 1 ? 0 : at / (text.length - 1)) })
  }
  return out
}

// ── The mission's changes ────────────────────────────────────────────────────

export function startMission(previous: DockMission, name: string, size: number, wantsSplit: boolean, now: number): DockMission {
  return { ...IDLE_MISSION, id: previous.id + 1, name, phase: 'idle', size, wantsSplit, startedAt: now }
}

// Claude wrote an Agent call: a queued card, before the call runs. A finished mission starts over.
export function addQueued(mission: DockMission, id: string, name: string, now: number): DockMission {
  const base = mission.phase === 'done' ? { ...mission, id: mission.id + 1, cards: [], admitted: 0, nudged: false, startedAt: now, finishedAt: null } : mission
  if (base.cards.some(c => c.id === id)) return base
  const card: DockCard = { id, name, agentId: null, status: 'queued', percent: 0, hasReported: false, startedAt: null, finishedAt: null }
  return { ...base, phase: 'live', startedAt: base.startedAt ?? now, cards: [...base.cards, card] }
}

// The call is about to run: its card goes working, if a slot is free. Says whether it got one.
export function claimSlot(mission: DockMission, id: string, limit: number, now: number): { mission: DockMission; isClaimed: boolean } {
  const working = mission.cards.filter(c => c.status === 'working').length
  const card = mission.cards.find(c => c.id === id)
  if (card === undefined || card.status !== 'queued' || working >= limit) return { mission, isClaimed: card?.status === 'working' }
  return {
    mission: { ...mission, cards: mission.cards.map(c => (c.id === id ? { ...c, status: 'working', startedAt: now } : c)) },
    isClaimed: true,
  }
}

export function finishCard(mission: DockMission, id: string, isOk: boolean, now: number): DockMission {
  return {
    ...mission,
    cards: mission.cards.map(c =>
      c.id !== id ? c : isOk ? { ...c, status: 'done', percent: 100, hasReported: true, finishedAt: now } : { ...c, status: 'stuck', finishedAt: now },
    ),
  }
}

export function removeCard(mission: DockMission, id: string): DockMission {
  return { ...mission, cards: mission.cards.filter(c => c.id !== id) }
}

// A helper reported: its card is the one bound to its agentId, else the working card its
// description (or the task it named) matches, which it is then bound to.
export function applyHelperProgress(
  mission: DockMission,
  report: { agentId: string; description: string | null; task: string; percent: number },
): DockMission {
  const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(report.percent) ? report.percent : 0)))
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const bound = mission.cards.find(c => c.agentId === report.agentId)
  const target =
    bound ??
    mission.cards.find(c => c.agentId === null && c.status === 'working' && report.description !== null && same(c.name, taskName(report.description))) ??
    mission.cards.find(c => c.agentId === null && c.status === 'working' && same(c.name, taskName(report.task)))
  if (target === undefined) return mission
  return {
    ...mission,
    cards: mission.cards.map(c =>
      c.id === target.id ? { ...c, agentId: report.agentId, percent: c.status === 'done' ? 100 : percent, hasReported: true } : c,
    ),
  }
}

// The request's turn ended: a mission with helpers shows its summary; one without stands by.
export function finishMission(mission: DockMission, isAborted: boolean, now: number): DockMission {
  if (mission.cards.length === 0) return { ...mission, phase: 'idle' }
  const cards = isAborted
    ? mission.cards.map(c => (c.status === 'queued' || c.status === 'working' ? { ...c, status: 'stuck' as const, finishedAt: now } : c))
    : mission.cards
  return { ...mission, cards, phase: 'done', finishedAt: now }
}

export const isSettled = (mission: DockMission) => mission.cards.every(c => c.status === 'done' || c.status === 'stuck')
