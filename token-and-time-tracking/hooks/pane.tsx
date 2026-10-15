import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { DayMap, Scope, Tab, Totals } from '../types'
import { INITIAL_LIVE, settings } from './shared'
import {
  dayKey,
  dayMap,
  formatDuration,
  formatTokens,
  lastDays,
  lastMonths,
  mergeDayMaps,
  modelLabel,
  monthDays,
  sessionTotals,
  streak,
  sumDays,
  tokenSum,
  touch,
} from './logic'
import {
  BLUE,
  GOLD,
  GREEN,
  HAIRLINE,
  INK,
  MUTED,
  PURPLE,
  SLATE,
  TEXT,
  barCells,
  bigDuration,
  bigText,
  bigWidth,
  column,
  fit,
  longDate,
  monthName,
  shortDate,
  spaced,
  tilesPerRow,
  weekday,
} from './look'

const live = atom({ plugin: 'token-and-time-tracking', key: 'live' } as const, INITIAL_LIVE)
const now = atom({ plugin: 'token-and-time-tracking', key: 'now' } as const, 0)
const tabAtom = atom({ plugin: 'token-and-time-tracking', key: 'tab' } as const, 'today' as Tab)
const scopeAtom = atom({ plugin: 'token-and-time-tracking', key: 'scope' } as const, 'project' as Scope)

export const PANE = 'token-time'
export const PANE_TITLE = 'Tokens and time'
export const PANE_COLUMNS = 80

const TABS: readonly Tab[] = ['session', 'today', 'week', 'month', 'all']
const TAB_LABELS: Readonly<Record<Tab, string>> = { session: 'Session', today: 'Today', week: 'Week', month: 'Month', all: 'All' }

type Table = ReturnType<EngineInterface['ui']['resolve']>

async function pickTab($: EngineInterface, t: Tab) {
  await update($, tabAtom, () => t)
  await $.store.set('tab', t)
}

async function flipScope($: EngineInterface) {
  let next: Scope = 'project'
  await update($, scopeAtom, s => (next = s === 'project' ? 'all' : 'project'))
  await $.store.set('scope', next)
}

/** The days a tab covers, or null for the session tab. */
function keepFor(t: Tab, today: string): ((day: string) => boolean) | null {
  if (t === 'session') return null
  if (t === 'today') return day => day === today
  if (t === 'week') {
    const week = new Set(lastDays(today, 7))
    return day => week.has(day)
  }
  if (t === 'month') return day => day.startsWith(today.slice(0, 7))
  return () => true
}

export async function drawPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  const width = Math.max(28, e.props.bodyColumns)
  const l = await read($, live)
  const t = await read($, now)
  const tab = await read($, tabAtom)
  const scope = await read($, scopeAtom)
  if (l.record === null) return <Text color={MUTED}>Waiting for the session to start.</Text>

  const idleMs = settings.idleMs
  const running = l.turnStartedAt === null ? null : Math.max(0, t - l.turnStartedAt)
  const touched = touch(l.record, Math.max(t, l.record.segments[l.record.segments.length - 1]?.end ?? 0))
  // The running turn counts as Claude working (and active) while it runs; its tokens come when it ends.
  const rec =
    l.turnStartedAt === null || running === null
      ? touched
      : { ...touched, turns: [...touched.turns, { start: l.turnStartedAt, ms: running, model: '', reason: 'running', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] }
  const today = dayKey(t)
  const days: DayMap = mergeDayMaps(l.history?.[scope] ?? {}, dayMap([rec], idleMs))
  const keep = keepFor(tab, today)
  const total = keep === null ? sessionTotals(rec, idleMs) : sumDays(days, keep)
  const where = scope === 'all' ? 'all projects' : rec.project.name

  const tabs = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Box flexDirection="row" gap={1}>
        {TABS.map(x => (
          <Button key={`tab-${x}`} plain onPress={() => void pickTab($, x)}>
            {x === tab ? (
              <Text bold color={INK} backgroundColor={GOLD}> {TAB_LABELS[x]} </Text>
            ) : (
              <Text color={TEXT} backgroundColor={SLATE}> {TAB_LABELS[x]} </Text>
            )}
          </Button>
        ))}
      </Box>
      {tab === 'session' ? null : (
        <Button key="scope" plain onPress={() => void flipScope($)}>
          <Text color={TEXT} backgroundColor={SLATE}> {scope === 'all' ? 'All projects' : 'This project'} ⇄ </Text>
        </Button>
      )}
    </Box>
  )

  const started = rec.segments[0]?.start ?? t
  const startedAt = new Date(started)
  const titles: Record<Tab, [string, string]> = {
    session: ['THIS SESSION', `${rec.project.name} · since ${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}`],
    today: [`TODAY · ${where.toUpperCase()}`, longDate(today)],
    week: [`LAST 7 DAYS · ${where.toUpperCase()}`, `${shortDate(lastDays(today, 7)[0]!)} – ${shortDate(today)}`],
    month: [`THIS MONTH · ${where.toUpperCase()}`, `${monthName(today.slice(0, 7))} ${today.slice(0, 4)}`],
    all: [`ALL TIME · ${where.toUpperCase()}`, Object.keys(days).length > 0 ? `since ${shortDate(Object.keys(days).sort()[0]!)}` : ''],
  }
  const [title, dates] = titles[tab]
  const titleWidth = Math.min(width, title.length)
  const titleBar = (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold color={TEXT} wrap="truncate-end">{title}</Text>
        <Text color={MUTED}>{dates}</Text>
      </Box>
      <Text>
        <Text color={GOLD}>{'━'.repeat(titleWidth)}</Text>
        <Text color={HAIRLINE}>{'─'.repeat(Math.max(0, width - titleWidth))}</Text>
      </Text>
    </Box>
  )

  const footer = (
    <Text color={MUTED} wrap="truncate-end">
      {`Active leaves out gaps over ${Math.round(idleMs / 60_000)} min · /token-time-report for tables`}
    </Text>
  )

  const isEmpty = total.clockMs === 0 && total.turns === 0 && tokenSum(total.agentTokens) === 0 && running === null
  return (
    <Box flexDirection="column" width={width}>
      {tabs}
      <Text> </Text>
      {titleBar}
      <Text> </Text>
      {isEmpty ? (
        <Text color={TEXT} wrap="wrap">Nothing tracked in this stretch yet.</Text>
      ) : (
        <Box flexDirection="column" width={width}>
          {drawTiles(table, width, total, running, tab)}
          <Text> </Text>
          {drawTime(table, width, total)}
          <Text> </Text>
          {drawTokens(table, width, total)}
        </Box>
      )}
      <Text> </Text>
      {drawChart(table, width, tab, today, days)}
      <Text> </Text>
      {footer}
    </Box>
  )
}

function heading(table: Table, label: string, width: number, right = ''): RenderElement {
  const { Text } = table
  const text = spaced(label)
  return (
    <Text wrap="truncate-end">
      <Text color={MUTED}>{text} </Text>
      <Text color={HAIRLINE}>{'─'.repeat(Math.max(0, width - text.length - 1 - (right ? right.length + 1 : 0)))}</Text>
      {right ? <Text bold color={TEXT}> {right}</Text> : null}
    </Text>
  )
}

// Three tiles with big numerals; a value too wide for them is plain bold text.
function drawTiles(table: Table, width: number, total: Totals, running: number | null, tab: Tab): RenderElement {
  const { Box, Text } = table
  const perRow = tilesPerRow(width)
  const tileWidth = Math.floor((width - (perRow - 1)) / perRow)
  const inner = tileWidth - 4
  const tokens = tokenSum(total) + tokenSum(total.agentTokens)
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const claudeCaption =
    running !== null ? `working now ${formatDuration(running)}` : plural(total.turns, 'turn')
  const tiles = [
    { key: 'active', label: 'ACTIVE TIME', value: bigDuration(total.activeMs), color: GOLD, border: GOLD,
      caption: `of ${formatDuration(total.clockMs)} on the clock` },
    { key: 'claude', label: 'CLAUDE WORKING', value: bigDuration(total.claudeMs), color: BLUE, border: SLATE,
      caption: claudeCaption, captionColor: running !== null ? GOLD : MUTED },
    { key: 'tokens', label: 'TOKENS', value: formatTokens(tokens), color: GREEN, border: SLATE,
      caption: tab === 'session' ? `${formatTokens(total.output)} output` : plural(total.sessions, 'session') },
  ]

  const tile = (x: (typeof tiles)[number]) => {
    const big = bigWidth(x.value) <= inner ? bigText(x.value) : null
    return (
      <Box key={`tile-${x.key}`} borderStyle="round" borderColor={x.border} paddingX={1} flexDirection="column" width={tileWidth}>
        <Text color={MUTED} wrap="truncate-end">{x.label}</Text>
        {big !== null ? (
          <Box flexDirection="column">
            {big.map((row, i) => (
              <Text key={`${x.key}-row-${i}`} color={x.color}>{row}</Text>
            ))}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold color={x.color} wrap="truncate-end">{x.value}</Text>
            <Text> </Text>
          </Box>
        )}
        <Text color={'captionColor' in x ? x.captionColor : MUTED} wrap="truncate-end">{x.caption}</Text>
      </Box>
    )
  }

  const rows: Array<typeof tiles> = []
  for (let at = 0; at < tiles.length; at += perRow) rows.push(tiles.slice(at, at + perRow))
  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row, r) => (
        <Box key={`tiles-${r}`} flexDirection="row" gap={1} width={width}>
          {row.map(tile)}
        </Box>
      ))}
    </Box>
  )
}

// "Where the time went": active, Claude working and idle, each against the time on the clock.
function drawTime(table: Table, width: number, total: Totals): RenderElement {
  const { Box, Text } = table
  const labelWidth = 18
  const timeWidth = 9
  const pctWidth = 6
  const barWidth = Math.max(4, width - 2 - labelWidth - timeWidth - pctWidth - 2)
  const clock = total.clockMs
  const rows = [
    { key: 'active', label: 'Active', ms: total.activeMs, color: GOLD },
    { key: 'claude', label: 'Claude working', ms: total.claudeMs, color: BLUE },
    { key: 'idle', label: 'Idle', ms: Math.max(0, clock - total.activeMs), color: MUTED },
  ]
  return (
    <Box flexDirection="column" width={width}>
      {heading(table, 'WHERE THE TIME WENT', width, `${formatDuration(clock)} on the clock`)}
      {rows.map(r => {
        const filled = barCells(r.ms, clock, barWidth)
        return (
          <Text key={`time-${r.key}`} wrap="truncate-end">
            <Text color={r.color}>● </Text>
            <Text color={TEXT}>{fit(r.label, labelWidth)}</Text>
            <Text color={r.color}>{'━'.repeat(filled)}</Text>
            <Text color={HAIRLINE}>{'─'.repeat(barWidth - filled)}</Text>
            <Text bold color={TEXT}>{formatDuration(r.ms).padStart(timeWidth)}</Text>
            <Text color={MUTED}>{`${clock > 0 ? Math.round((r.ms / clock) * 100) : 0}%`.padStart(pctWidth)}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

// "Tokens used": a row per model, a row for subagents, then the four parts the API counts.
function drawTokens(table: Table, width: number, total: Totals): RenderElement {
  const { Box, Text } = table
  const agents = tokenSum(total.agentTokens)
  const entries: Array<[string, number, string]> = Object.entries(total.models)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([model, n]) => [modelLabel(model), n, BLUE])
  if (agents > 0) entries.push(['Subagents', agents, PURPLE])
  const labelWidth = 18
  const countWidth = 8
  const unitWidth = 7
  const barWidth = Math.max(4, width - 2 - labelWidth - countWidth - unitWidth - 2)
  const max = Math.max(0, ...entries.map(x => x[1]))
  const all = {
    input: total.input + total.agentTokens.input,
    output: total.output + total.agentTokens.output,
    cacheRead: total.cacheRead + total.agentTokens.cacheRead,
    cacheWrite: total.cacheWrite + total.agentTokens.cacheWrite,
  }
  const parts = [
    `New input ${formatTokens(all.input)}`,
    `Output ${formatTokens(all.output)}`,
    `Cache reads ${formatTokens(all.cacheRead)}`,
    `Cache writes ${formatTokens(all.cacheWrite)}`,
  ]
  return (
    <Box flexDirection="column" width={width}>
      {heading(table, 'TOKENS USED', width, `${formatTokens(tokenSum(all))} total`)}
      {entries.map(([label, n, color]) => {
        const filled = barCells(n, max, barWidth)
        return (
          <Text key={`tokens-${label}`} wrap="truncate-end">
            <Text color={color}>● </Text>
            <Text color={TEXT}>{fit(label, labelWidth)}</Text>
            <Text color={color}>{'━'.repeat(filled)}</Text>
            <Text color={HAIRLINE}>{'─'.repeat(barWidth - filled)}</Text>
            <Text bold color={TEXT}>{formatTokens(n).padStart(countWidth)}</Text>
            <Text color={MUTED}>{' tokens'.padStart(unitWidth)}</Text>
          </Text>
        )
      })}
      <Text color={MUTED} wrap="wrap">{parts.join('  ·  ')}</Text>
    </Box>
  )
}

// Active time as a chart three rows tall, then one summary line.
function drawChart(table: Table, width: number, tab: Tab, today: string, days: DayMap): RenderElement {
  const { Box, Text } = table
  type Bar = { key: string; label: string; value: number; isCurrent: boolean }
  const activeOf = (key: string) => days[key]?.activeMs ?? 0
  let bars: Bar[]
  let label: string
  let summary: string

  if (tab === 'month') {
    const month = monthDays(today)
    bars = month.map(key => ({ key, label: '', value: activeOf(key), isCurrent: key === today }))
    label = 'DAY BY DAY'
    const best = month.reduce((b, k) => (activeOf(k) > activeOf(b) ? k : b), month[0]!)
    const worked = month.filter(k => activeOf(k) > 0).length
    summary = `${activeOf(best) > 0 ? `Best day: ${shortDate(best)}, ${formatDuration(activeOf(best))} active` : 'No active days yet'}  ·  ${worked} active days`
  } else if (tab === 'all') {
    const months = lastMonths(today, 12)
    const sumMonth = (m: string) => Object.keys(days).filter(k => k.startsWith(m)).reduce((s, k) => s + activeOf(k), 0)
    bars = months.map(m => ({ key: m, label: monthName(m), value: sumMonth(m), isCurrent: m === today.slice(0, 7) }))
    label = 'MONTH BY MONTH'
    const best = bars.reduce((b, x) => (x.value > b.value ? x : b), bars[0]!)
    summary = `${best.value > 0 ? `Best month: ${best.label}, ${formatDuration(best.value)} active` : 'No active months yet'}  ·  ${Object.values(days).filter(d => d.activeMs > 0).length} active days`
  } else {
    const week = lastDays(today, 7)
    bars = week.map(key => ({ key, label: weekday(key), value: activeOf(key), isCurrent: key === today }))
    label = 'LAST 7 DAYS'
    const weekMs = week.reduce((s, k) => s + activeOf(k), 0)
    const run = streak(days, today)
    summary = `${formatDuration(weekMs)} active in the last 7 days  ·  ${run} day streak`
  }

  const max = Math.max(0, ...bars.map(b => b.value))
  const slot = Math.max(1, Math.floor(width / bars.length))
  const barWidth = Math.max(1, Math.min(slot - 1, 6))
  const columns = bars.map(b => column(b.value, max))
  const rows = [0, 1, 2].map(r => (
    <Text key={`chart-${r}`}>
      {bars.map((b, i) => (
        <Text key={`c-${r}-${b.key}`} color={b.isCurrent ? GOLD : BLUE}>
          {(r === 2 && b.value === 0 ? '─' : columns[i]![r]!).repeat(barWidth).padEnd(slot)}
        </Text>
      ))}
    </Text>
  ))
  const labels =
    tab === 'month' ? (
      <Text color={MUTED} wrap="truncate-end">
        {fit(shortDate(bars[0]!.key), Math.max(1, slot * bars.length - 7))}
        <Text bold color={TEXT}>{shortDate(today)}</Text>
      </Text>
    ) : (
      <Text wrap="truncate-end">
        {bars.map(b => (
          <Text key={`l-${b.key}`} bold={b.isCurrent} color={b.isCurrent ? TEXT : MUTED}>{fit(b.label, slot)}</Text>
        ))}
      </Text>
    )

  return (
    <Box flexDirection="column" width={width}>
      {heading(table, label, width)}
      {rows}
      {labels}
      <Text color={GREEN} wrap="truncate-end">{summary}</Text>
    </Box>
  )
}
