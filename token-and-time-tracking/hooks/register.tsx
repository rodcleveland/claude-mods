import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Scope, SessionRecord, Tab } from '../types'
import { dataDir, flushWrites, save, sessionFile, sessionsDir } from './disk'
import { INITIAL_LIVE, settings } from './shared'
import {
  MINUTE,
  addAgentTurn,
  addTurn,
  dayKey,
  dayMap,
  formatReport,
  isPaused,
  newRecord,
  parseQuery,
  pause,
  readUsage,
  resume,
  touch,
  unpause,
} from './logic'
import { PANE, PANE_COLUMNS, PANE_TITLE, drawPane } from './pane'

const live = atom({ plugin: 'token-and-time-tracking', key: 'live' } as const, INITIAL_LIVE)
const now = atom({ plugin: 'token-and-time-tracking', key: 'now' } as const, 0)
const tab = atom({ plugin: 'token-and-time-tracking', key: 'tab' } as const, 'today' as Tab)
const scope = atom({ plugin: 'token-and-time-tracking', key: 'scope' } as const, 'project' as Scope)

// The central list of every project tracked, so reports can cover them all.
const INDEX_KEY = 'projects'
type ProjectIndex = Record<string, { name: string; lastSeen: number }>

function isRecord(v: unknown): v is SessionRecord {
  const r = v as SessionRecord
  return typeof r === 'object' && r !== null && r.version === 1 && typeof r.sessionId === 'string' &&
    Array.isArray(r.segments) && Array.isArray(r.turns) && Array.isArray(r.agentTurns)
}

async function readRecord($: EngineInterface, path: string): Promise<SessionRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function loadProject($: EngineInterface, root: string): Promise<SessionRecord[]> {
  const entries = await $.fs.list(sessionsDir(root)).catch(() => [])
  const records = await Promise.all(
    entries
      .filter(e => e.kind === 'file' && e.name.endsWith('.json'))
      .map(e => readRecord($, `${sessionsDir(root)}/${e.name}`)),
  )
  return records.filter((r): r is SessionRecord => r !== null)
}

async function projectRoot($: EngineInterface): Promise<string> {
  const repo = await $.session.repo().catch(() => null)
  return repo?.root ?? (await $.session.root())
}

/** Every other session by day, for this project and for all of them: what the pane's longer tabs show. */
async function refreshHistory($: EngineInterface, root: string, sessionId: string, t: number) {
  const index = ((await $.store.get(INDEX_KEY)) ?? {}) as ProjectIndex
  const roots = [...new Set([root, ...Object.keys(index)])]
  const loaded = await Promise.all(roots.map(r => loadProject($, r)))
  const others = (records: SessionRecord[]) => records.filter(r => r.sessionId !== sessionId)
  const project = dayMap(others(loaded[0] ?? []), settings.idleMs)
  const all = dayMap(others(loaded.flat()), settings.idleMs)
  await update($, live, l => ({ ...l, day: dayKey(t), history: { project, all } }))
}

/** Makes sure the pane's record is this session's: starts one, picks a resumed one up, or follows a /clear. */
async function ensureSession($: EngineInterface): Promise<SessionRecord> {
  const id = await $.session.id()
  const current = (await read($, live)).record
  if (current !== null && current.sessionId === id) return current

  const t = await $.clock.now()
  const root = await projectRoot($)
  const saved = await readRecord($, sessionFile(root, id))
  const rec = saved ? resume(saved, t) : newRecord(id, root, t)

  await update($, live, l => ({ ...l, record: rec, turnStartedAt: null }))
  await update($, now, () => t)
  if (!(await $.fs.exists(`${dataDir(root)}/.gitignore`))) {
    // Keeps the usage files out of the project's git history.
    await $.fs.write(`${dataDir(root)}/.gitignore`, '*\n').catch(() => undefined)
  }
  await save($, rec)
  const index = ((await $.store.get(INDEX_KEY)) ?? {}) as ProjectIndex
  await $.store.set(INDEX_KEY, { ...index, [root]: { name: rec.project.name, lastSeen: t } })
  await refreshHistory($, root, id, t)
  return rec
}

/** Moves the session's clock to now and saves it. */
async function heartbeat($: EngineInterface) {
  const rec = await ensureSession($)
  const t = await $.clock.now()
  let next: SessionRecord | null = null
  await update($, live, l => {
    next = l.record === null ? null : touch(l.record, t)
    return { ...l, record: next }
  })
  if (next !== null) await save($, next)
  if ((await read($, live)).day !== dayKey(t)) await refreshHistory($, rec.project.root, rec.sessionId, t)
}

export const register: Register = (on, options) => {
  settings.idleMs = Math.max(1, Number(options.idleMinutes ?? 15)) * MINUTE
  const openOnStart = options.openOnStart !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-time',
      description: 'Open the live tokens and time pane, or pause / resume the timer',
      argumentHint: '[pause | resume]',
    })
    await $.command.register({
      name: 'token-time-report',
      description: 'Report tokens and time: today, yesterday, week, month, all or a date; add all-projects or sessions',
      argumentHint: '[today|week|month|all|YYYY-MM-DD] [all-projects] [sessions]',
    })
    const savedTab = await $.store.get('tab')
    const savedScope = await $.store.get('scope')
    if (typeof savedTab === 'string') await update($, tab, () => savedTab as Tab)
    if (savedScope === 'all' || savedScope === 'project') await update($, scope, () => savedScope as Scope)
    await ensureSession($)
    // Other sessions (another terminal, another project) show up within 15 minutes.
    $.clock.every(15 * MINUTE, () => {
      void (async () => {
        const rec = (await read($, live)).record
        if (rec !== null) await refreshHistory($, rec.project.root, rec.sessionId, await $.clock.now())
      })()
    })
    // The pane's clocks tick every second; the session file is saved every minute.
    $.clock.every(1000, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })
    $.clock.every(MINUTE, () => void heartbeat($))
    if (openOnStart && e.isInteractive) void $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await ensureSession($)
    const t = await $.clock.now()
    await update($, live, l => ({ ...l, turnStartedAt: t }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await ensureSession($)
    const t = await $.clock.now()
    const u = readUsage(e.usage)
    let saved: SessionRecord | null = null
    await update($, live, l => {
      if (l.record === null) return l
      if (e.agentId !== undefined) {
        saved = addAgentTurn(l.record, { start: t, ...u })
        return { ...l, record: saved }
      }
      const ms = Math.max(0, e.durationMs)
      saved = addTurn(l.record, { start: t - ms, ms, ...u, reason: e.reason })
      return { ...l, record: saved, turnStartedAt: null }
    })
    if (saved !== null) await save($, saved)
    return result
  })

  on('session.end', async ($, e, next) => {
    const t = await $.clock.now()
    const l = await read($, live)
    if (l.record !== null && l.record.sessionId === e.sessionId) {
      const closed = touch(l.record, t)
      await save($, closed)
      // After a /clear the process goes on under a new id; the next turn starts a fresh record.
      await update($, live, x => ({ ...x, record: null, turnStartedAt: null }))
    }
    return next(e)
  })

  on('command.run', { command: 'token-time' }, async ($, e) => {
    await ensureSession($)
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === '') {
      await $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS, focus: true })
      return { text: 'Tokens and time pane opened.' }
    }
    if (arg !== 'pause' && arg !== 'resume') return { text: 'Usage: /token-time [pause | resume]' }

    const pausing = arg === 'pause'
    const t = await $.clock.now()
    let changed: SessionRecord | null = null
    await update($, live, l => {
      if (l.record === null || isPaused(l.record) === pausing) return l
      const next = pausing ? pause(l.record, t) : unpause(l.record, t)
      changed = next
      return { ...l, record: next }
    })
    if (changed === null) return { text: pausing ? 'The timer is already paused.' : "The timer isn't paused." }
    await save($, changed)
    return { text: pausing ? 'Timer paused.' : 'Timer resumed.' }
  })

  on('command.run', { command: 'token-time-report' }, async ($, e) => {
    const rec = await ensureSession($)
    await heartbeat($)
    await flushWrites()
    const q = parseQuery(e.args ?? '', await $.clock.now())
    if ('error' in q) return { text: q.error }

    const index = ((await $.store.get(INDEX_KEY)) ?? {}) as ProjectIndex
    const roots = q.allProjects ? Object.keys(index) : [rec.project.root]
    const projects = await Promise.all(
      roots.map(async root => ({
        root,
        name: index[root]?.name ?? rec.project.name,
        records: await loadProject($, root),
      })),
    )
    projects.sort((a, b) => a.name.localeCompare(b.name))
    return { text: formatReport(q, projects, settings.idleMs) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, e))
}
