import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Live, SessionRecord, Totals } from '../types'
import {
  MINUTE,
  addAgentTurn,
  addTotals,
  addTurn,
  dayKey,
  dayStart,
  emptyTotals,
  formatDuration,
  formatReport,
  formatTokens,
  newRecord,
  parseQuery,
  readUsage,
  resume,
  sessionTotals,
  sumTotals,
  tokenSum,
  touch,
} from './logic'

const PANE = 'token-time'
const PANE_TITLE = 'Tokens and time'
const live = atom({ plugin: 'token-and-time-tracking', key: 'live' } as const, {
  record: null,
  turnStartedAt: null,
  projectToday: null,
  projectAll: null,
  day: '',
} as Live)
const now = atom({ plugin: 'token-and-time-tracking', key: 'now' } as const, 0)

// The central list of every project tracked, so reports can cover them all.
const INDEX_KEY = 'projects'
type ProjectIndex = Record<string, { name: string; lastSeen: number }>

const dataDir = (root: string) => `${root}/.claude/token-time`
const sessionsDir = (root: string) => `${dataDir(root)}/sessions`
const sessionFile = (root: string, id: string) => `${sessionsDir(root)}/${id}.json`

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

// Read from the options at each load.
let idleMs = 15 * MINUTE

// Writes go one at a time, so a slow older write never lands over a newer one.
let writing: Promise<void> = Promise.resolve()
function save($: EngineInterface, rec: SessionRecord) {
  writing = writing
    .then(() => $.fs.write(sessionFile(rec.project.root, rec.sessionId), JSON.stringify(rec)))
    .catch(() => undefined)
  return writing
}

/** This project's other sessions, summed for the pane. */
async function refreshProjectTotals($: EngineInterface, root: string, sessionId: string, t: number) {
  const others = (await loadProject($, root)).filter(r => r.sessionId !== sessionId)
  const day = dayKey(t)
  await update($, live, l => ({
    ...l,
    day,
    projectToday: sumTotals(others, idleMs, dayStart(day)),
    projectAll: sumTotals(others, idleMs),
  }))
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
  await refreshProjectTotals($, root, id, t)
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
  if ((await read($, live)).day !== dayKey(t)) await refreshProjectTotals($, rec.project.root, rec.sessionId, t)
}

export const register: Register = (on, options) => {
  idleMs = Math.max(1, Number(options.idleMinutes ?? 15)) * MINUTE
  const openOnStart = options.openOnStart !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'token-time', description: 'Open the live tokens and time pane' })
    await $.command.register({
      name: 'token-time-report',
      description: 'Report tokens and time: today, yesterday, week, month, all or a date; add all-projects or sessions',
      argumentHint: '[today|week|month|all|YYYY-MM-DD] [all-projects] [sessions]',
    })
    await ensureSession($)
    // The pane's clocks tick every second; the session file is saved every minute.
    $.clock.every(1000, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })
    $.clock.every(MINUTE, () => void heartbeat($))
    if (openOnStart && e.isInteractive) void $.ui.open({ id: PANE, title: PANE_TITLE })
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

  on('command.run', { command: 'token-time' }, async $ => {
    await ensureSession($)
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: 'Tokens and time pane opened.' }
  })

  on('command.run', { command: 'token-time-report' }, async ($, e) => {
    const rec = await ensureSession($)
    await heartbeat($)
    await writing
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
    return { text: formatReport(q, projects, idleMs) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, live)
    const t = await read($, now)
    if (l.record === null) return <Text dimColor>Waiting for the session to start.</Text>

    const rec = touch(l.record, t)
    const s = sessionTotals(rec, idleMs)
    const running = l.turnStartedAt === null ? null : Math.max(0, t - l.turnStartedAt)
    const name = rec.project.name
    const withSession = (other: Totals | null, from?: number) =>
      addTotals(other ?? emptyTotals(), sessionTotals(rec, idleMs, from))
    const today = withSession(l.projectToday, dayStart(dayKey(t)))
    const all = withSession(l.projectAll)

    const summary = (x: Totals) =>
      `${formatDuration(x.clockMs)} on the clock · ${formatDuration(x.activeMs)} active · ` +
      `${formatDuration(x.claudeMs)} Claude · ${formatTokens(tokenSum(x) + tokenSum(x.agentTokens))} tokens · ` +
      `${x.sessions} session${x.sessions === 1 ? '' : 's'}`

    return (
      <Box flexDirection="column">
        <Text bold>{`This session · ${name}`}</Text>
        <Text>{`On the clock    ${formatDuration(s.clockMs)}   (active ${formatDuration(s.activeMs)})`}</Text>
        <Text>{`Claude working  ${formatDuration(s.claudeMs)} over ${s.turns} turn${s.turns === 1 ? '' : 's'}`}</Text>
        {running !== null && <Text color="yellow">{`Working now     ${formatDuration(running)}`}</Text>}
        <Text>
          {`Tokens          in ${formatTokens(s.input)} · out ${formatTokens(s.output)} · ` +
            `cache ${formatTokens(s.cacheRead)} read / ${formatTokens(s.cacheWrite)} write`}
        </Text>
        {tokenSum(s.agentTokens) > 0 && (
          <Text dimColor>{`Subagents       ${formatTokens(tokenSum(s.agentTokens))} tokens more`}</Text>
        )}
        <Box marginTop={1} flexDirection="column">
          <Text bold>{`Today · ${name}`}</Text>
          <Text>{summary(today)}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold>{`All time · ${name}`}</Text>
          <Text>{summary(all)}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>/token-time-report week · all-projects · sessions</Text>
        </Box>
      </Box>
    )
  })
}
