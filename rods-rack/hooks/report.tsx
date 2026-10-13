import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { ReportDay, ReportHistory, ReportKind, ReportTab } from '../types'
import {
  barCells,
  bestDay,
  bigText,
  bigWidth,
  BLUE,
  changeSettings,
  classify,
  column,
  dayRecord,
  daysFor,
  DEFAULT_SETTINGS,
  describeSettings,
  formatCount,
  formatDollars,
  formatHours,
  formatTokens,
  GOLD,
  GREEN,
  HAIRLINE,
  hoursSaved,
  INK,
  isDayKey,
  isTypedPrompt,
  KIND_COLORS,
  KIND_LABELS,
  kindHours,
  KINDS,
  modelLabel,
  MONTHS,
  MUTED,
  readHistory,
  readSettings,
  recordTask,
  recordTokens,
  shortDate,
  signalsOf,
  streak,
  sumDays,
  TAB_TITLES,
  tabDates,
  taskCount,
  TEXT,
  tokenTotal,
  usageTokens,
  tilesPerRow,
  weekday,
} from './report-logic'

// The Work Report: what Claude finished for you, the hours that is estimated to have saved, what
// that time is worth, and the tokens it used, for today, the week, the month and the year. Its plain logic is in
// report-logic.ts; the past is an estimate built from saved sessions by scripts/report-history.py.

type Dollar = EngineInterface

export const REPORT_PANE = 'rods-rack-report'
const DAY_PREFIX = 'report:day:'
const SETTINGS_KEY = 'reportSettings'
const HISTORY_FILE = '.claude/rods-rack-data/report-history.json'
const PANE_COLUMNS = 80
const TABS: readonly ReportTab[] = ['today', 'week', 'month', 'year']
const TAB_LABELS: Readonly<Record<ReportTab, string>> = { today: 'Today', week: 'Week', month: 'Month', year: 'Year' }
const SLATE = '#262B33'

const reportTab = atom({ plugin: 'rods-rack', key: 'reportTab' } as const, 'today' as ReportTab)
const reportToday = atom({ plugin: 'rods-rack', key: 'reportToday' } as const, '')
const reportDays = atom({ plugin: 'rods-rack', key: 'reportDays' } as const, {} as Record<string, ReportDay>)
const reportHistory = atom({ plugin: 'rods-rack', key: 'reportHistory' } as const, null as ReportHistory | null)
const reportSettings = atom({ plugin: 'rods-rack', key: 'reportSettings' } as const, DEFAULT_SETTINGS)
const reportPending = atom({ plugin: 'rods-rack', key: 'reportPending' } as const, null as string[] | null)
// Written by Clean View's turn.start and turn.complete (clean-view.tsx).
const isWorking = atom({ plugin: 'rods-rack', key: 'isWorking' } as const, false)

// ── Days, settings and the pane ──────────────────────────────────────────────

// Today's date where you are, from the system clock (the plugin's own clock may be UTC).
async function localToday($: Dollar): Promise<string> {
  try {
    const ran = await $.process.run(['date', '+%Y-%m-%d'])
    const day = ran.stdout.trim()
    if (isDayKey(day)) return day
  } catch {
    // Fall through.
  }
  const now = new Date(await $.clock.now())
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

async function refreshToday($: Dollar) {
  const today = await localToday($)
  await update($, reportToday, () => today)
  return today
}

async function loadAll($: Dollar) {
  await update($, reportSettings, () => DEFAULT_SETTINGS)
  const settings = readSettings(await $.store.get(SETTINGS_KEY))
  await update($, reportSettings, () => settings)

  const days: Record<string, ReportDay> = {}
  for (const key of await $.store.keys()) {
    if (!key.startsWith(DAY_PREFIX)) continue
    const value = await $.store.get(key)
    if (typeof value === 'object' && value !== null) days[key.slice(DAY_PREFIX.length)] = value as ReportDay
  }
  await update($, reportDays, () => days)

  let history: ReportHistory | null = null
  try {
    const home = await $.env.get('HOME')
    if (home !== undefined) history = readHistory(await $.fs.read(`${home}/${HISTORY_FILE}`))
  } catch {
    history = null
  }
  await update($, reportHistory, () => history)
  await refreshToday($)
}

async function openReport($: Dollar) {
  await refreshToday($)
  const opened = await $.ui.open({ id: REPORT_PANE, title: 'Work Report', columns: PANE_COLUMNS })
  if (!opened.isPlaced) $.ui.toast('The window is too narrow to show the Work Report. Widen it and type /report again.')
}

async function pickTab($: Dollar, tab: ReportTab) {
  await refreshToday($)
  await update($, reportTab, () => tab)
}

// ── Drawing ──────────────────────────────────────────────────────────────────

type Table = ReturnType<EngineInterface['ui']['resolve']>

const spaced = (text: string) => text.split(' ').map(word => word.split('').join(' ')).join('   ')
const fit = (text: string, width: number) =>
  width <= 1 ? '' : text.length <= width ? text.padEnd(width) : text.slice(0, width - 1) + '…'

async function drawReport($: Dollar, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  const width = Math.max(28, e.props.bodyColumns)
  const tab = await read($, reportTab)
  const today = (await read($, reportToday)) || '1970-01-01'
  const live = await read($, reportDays)
  const history = await read($, reportHistory)
  const settings = await read($, reportSettings)

  const recordOf = (key: string) => dayRecord(key, live, history)
  const days = daysFor(tab, today)
  const total = sumDays(days.map(recordOf))
  const tasks = taskCount(total)
  const hours = hoursSaved(total, settings)
  const dollars = hours * settings.rate

  // Tabs: the chosen one a gold chip with dark text, the rest slate chips.
  const tabs = (
    <Box flexDirection="row" gap={1} width={width}>
      {TABS.map(t => (
        <Button key={`tab-${t}`} plain onPress={() => void pickTab($, t)}>
          {t === tab ? (
            <Text bold color={INK} backgroundColor={GOLD}> {TAB_LABELS[t]} </Text>
          ) : (
            <Text color={TEXT} backgroundColor={SLATE}> {TAB_LABELS[t]} </Text>
          )}
        </Button>
      ))}
    </Box>
  )

  // Title bar: the stretch in bold capitals, its dates on the right, and the gold-then-hairline rule.
  const title = TAB_TITLES[tab]
  const dates = tabDates(tab, today)
  const titleBar = (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold color={TEXT}>{title}</Text>
        <Text color={MUTED}>{dates}</Text>
      </Box>
      <Text>
        <Text color={GOLD}>{'━'.repeat(Math.min(width, title.length))}</Text>
        <Text color={HAIRLINE}>{'─'.repeat(Math.max(0, width - title.length))}</Text>
      </Text>
    </Box>
  )

  const footer = <Text color={MUTED} wrap="truncate-end">Hours and dollars are estimates. Tune them with /report settings.</Text>

  if (tasks === 0) {
    const empty =
      tab === 'today'
        ? 'Nothing finished yet today. Your first finished task shows up here.'
        : `Nothing finished in this stretch yet. Finished tasks show up here.`
    return (
      <Box flexDirection="column" width={width}>
        {tabs}
        <Text> </Text>
        {titleBar}
        <Text> </Text>
        <Text color={TEXT} wrap="wrap">{empty}</Text>
        <Text> </Text>
        {tokenTotal(total.tokens) > 0 ? (
          <Box flexDirection="column" width={width}>
            {drawTokens(table, width, total)}
            <Text> </Text>
          </Box>
        ) : null}
        {footer}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      {tabs}
      <Text> </Text>
      {titleBar}
      <Text> </Text>
      {drawTiles(table, width, hours, tasks, dollars, settings.rate)}
      <Text> </Text>
      {drawKinds(table, width, total, settings)}
      <Text> </Text>
      {drawModels(table, width, total)}
      <Text> </Text>
      {tokenTotal(total.tokens) > 0 ? (
        <Box flexDirection="column" width={width}>
          {drawTokens(table, width, total)}
          <Text> </Text>
        </Box>
      ) : null}
      {drawChart(table, width, tab, today, key => hoursSaved(recordOf(key), settings), key => taskCount(recordOf(key)) > 0)}
      <Text> </Text>
      {footer}
    </Box>
  )
}

function heading(table: Table, label: string, width: number): RenderElement {
  const { Text } = table
  const text = spaced(label)
  return (
    <Text wrap="truncate-end">
      <Text color={MUTED}>{text} </Text>
      <Text color={HAIRLINE}>{'─'.repeat(Math.max(0, width - text.length - 1))}</Text>
    </Text>
  )
}

// Three tiles with big numerals; a number too wide for them is plain bold text.
function drawTiles(table: Table, width: number, hours: number, tasks: number, dollars: number, rate: number): RenderElement {
  const { Box, Text } = table
  const perRow = tilesPerRow(width)
  const tileWidth = Math.floor((width - (perRow - 1)) / perRow)
  const inner = tileWidth - 4
  const tiles = [
    { key: 'hours', label: 'HOURS SAVED', value: formatHours(hours), color: GOLD, caption: 'estimate', border: GOLD },
    { key: 'tasks', label: 'TASKS DONE', value: formatCount(tasks), color: BLUE, caption: 'finished tasks', border: SLATE },
    { key: 'dollars', label: "DOLLARS' WORTH", value: formatDollars(dollars), color: GREEN, caption: `est. at $${rate}/hour`, border: SLATE },
  ]

  const tile = (t: (typeof tiles)[number]) => {
    const big = bigWidth(t.value) <= inner ? bigText(t.value) : null
    return (
      <Box key={`tile-${t.key}`} borderStyle="round" borderColor={t.border} paddingX={1} flexDirection="column" width={tileWidth}>
        <Text color={MUTED} wrap="truncate-end">{t.label}</Text>
        {big !== null ? (
          <Box flexDirection="column">
            {big.map((row, i) => (
              <Text key={`${t.key}-row-${i}`} color={t.color}>{row}</Text>
            ))}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold color={t.color} wrap="truncate-end">{t.value}</Text>
            <Text> </Text>
          </Box>
        )}
        <Text color={MUTED} wrap="truncate-end">{t.caption}</Text>
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

// "Where the time went": a row per kind with a colored bar, its count and its hours.
function drawKinds(table: Table, width: number, total: ReportDay, settings: Parameters<typeof hoursSaved>[1]): RenderElement {
  const { Box, Text } = table
  const labelWidth = 18
  const countWidth = 7
  const hoursWidth = 9
  const barWidth = Math.max(4, width - 2 - labelWidth - countWidth - hoursWidth - 2)
  const max = Math.max(...KINDS.map(k => total.kinds[k] ?? 0))
  const row = (kind: ReportKind) => {
    const count = total.kinds[kind] ?? 0
    const filled = barCells(count, max, barWidth)
    return (
      <Text key={`kind-${kind}`} wrap="truncate-end">
        <Text color={KIND_COLORS[kind]}>● </Text>
        <Text color={TEXT}>{fit(KIND_LABELS[kind], labelWidth)}</Text>
        <Text color={KIND_COLORS[kind]}>{'━'.repeat(filled)}</Text>
        <Text color={HAIRLINE}>{'─'.repeat(barWidth - filled)}</Text>
        <Text bold color={TEXT}>{formatCount(count).padStart(countWidth)}</Text>
        <Text color={MUTED}>{`${formatHours(kindHours(total, kind, settings))} h`.padStart(hoursWidth)}</Text>
      </Text>
    )
  }
  return (
    <Box flexDirection="column" width={width}>
      {heading(table, 'WHERE THE TIME WENT', width)}
      {KINDS.map(row)}
    </Box>
  )
}

// "Who did the work": a row per model with a bar and its count.
function drawModels(table: Table, width: number, total: ReportDay): RenderElement {
  const { Box, Text } = table
  const entries = Object.entries(total.models).sort((a, b) => b[1] - a[1])
  const labelWidth = 18
  const countWidth = 7
  const unitWidth = 7
  const barWidth = Math.max(4, width - 2 - labelWidth - countWidth - unitWidth - 2)
  const max = entries[0]?.[1] ?? 0
  return (
    <Box flexDirection="column" width={width}>
      {heading(table, 'WHO DID THE WORK', width)}
      {entries.map(([model, count]) => {
        const filled = barCells(count, max, barWidth)
        return (
          <Text key={`model-${model}`} wrap="truncate-end">
            <Text color={MUTED}>● </Text>
            <Text color={TEXT}>{fit(modelLabel(model), labelWidth)}</Text>
            <Text color={TEXT}>{'━'.repeat(filled)}</Text>
            <Text color={HAIRLINE}>{'─'.repeat(barWidth - filled)}</Text>
            <Text bold color={TEXT}>{formatCount(count).padStart(countWidth)}</Text>
            <Text color={MUTED}>{(count === 1 ? ' task' : ' tasks').padStart(unitWidth)}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

// "Tokens used": the total on the heading, a row per model with a bar and its tokens, then the four
// parts the API counts. Helpers' tokens are in it, and turns that did not finish a task.
function drawTokens(table: Table, width: number, total: ReportDay): RenderElement {
  const { Box, Text } = table
  const tokens = total.tokens!
  const entries = Object.entries(total.modelTokens ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const labelWidth = 18
  const countWidth = 8
  const unitWidth = 7
  const barWidth = Math.max(4, width - 2 - labelWidth - countWidth - unitWidth - 2)
  const max = entries[0]?.[1] ?? 0
  const label = `TOKENS USED`
  const sum = `${formatTokens(tokenTotal(tokens))} total`
  const parts = [
    `New input ${formatTokens(tokens.input)}`,
    `Output ${formatTokens(tokens.output)}`,
    `Cache reads ${formatTokens(tokens.cacheRead)}`,
    `Cache writes ${formatTokens(tokens.cacheWrite)}`,
  ]
  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end">
        <Text color={MUTED}>{spaced(label)} </Text>
        <Text color={HAIRLINE}>{'─'.repeat(Math.max(0, width - spaced(label).length - sum.length - 2))}</Text>
        <Text bold color={TEXT}> {sum}</Text>
      </Text>
      {entries.map(([model, n]) => {
        const filled = barCells(n, max, barWidth)
        return (
          <Text key={`tokens-${model}`} wrap="truncate-end">
            <Text color={BLUE}>● </Text>
            <Text color={TEXT}>{fit(modelLabel(model), labelWidth)}</Text>
            <Text color={BLUE}>{'━'.repeat(filled)}</Text>
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

// A chart three rows tall, then one summary line.
function drawChart(
  table: Table,
  width: number,
  tab: ReportTab,
  today: string,
  hoursOf: (key: string) => number,
  hasTasks: (key: string) => boolean,
): RenderElement {
  const { Box, Text } = table
  type Bar = { key: string; label: string; value: number | null; isCurrent: boolean }
  let bars: Bar[]
  let label: string
  let summary: string

  if (tab === 'today' || tab === 'week') {
    const week = daysFor('week', today)
    bars = week.map(key => ({ key, label: weekday(key), value: hoursOf(key), isCurrent: key === today }))
    label = 'LAST 7 DAYS'
    const weekHours = week.reduce((h, k) => h + hoursOf(k), 0)
    const run = streak(hasTasks, today)
    summary = `${formatHours(weekHours)} hours saved in the last 7 days  ·  ${run} day streak`
  } else if (tab === 'month') {
    const month = daysFor('month', today)
    bars = month.map(key => ({ key, label: '', value: hoursOf(key), isCurrent: key === today }))
    label = 'DAY BY DAY'
    const best = bestDay(month, hoursOf)
    const active = month.filter(hasTasks).length
    summary = `${best === null ? 'No best day yet' : `Best day: ${shortDate(best.key)}, ${formatHours(best.hours)} hours`}  ·  ${active} active days`
  } else {
    const year = today.slice(0, 4)
    const thisMonth = Number(today.slice(5, 7))
    const all = daysFor('year', today)
    const monthHours = MONTHS.map((_, i) => all.filter(k => Number(k.slice(5, 7)) === i + 1).reduce((h, k) => h + hoursOf(k), 0))
    bars = MONTHS.map((name, i) => ({ key: `${year}-${i + 1}`, label: name, value: i + 1 > thisMonth ? null : monthHours[i]!, isCurrent: i + 1 === thisMonth }))
    label = 'MONTH BY MONTH'
    const bestIndex = monthHours.reduce((b, h, i) => (h > (monthHours[b] ?? 0) ? i : b), 0)
    const active = all.filter(hasTasks).length
    summary = `${(monthHours[bestIndex] ?? 0) > 0 ? `Best month: ${MONTHS[bestIndex]}, ${formatHours(monthHours[bestIndex]!)} hours` : 'No best month yet'}  ·  ${active} active days`
  }

  const max = Math.max(0, ...bars.map(b => b.value ?? 0))
  const slot = Math.max(1, Math.floor(width / bars.length))
  const barWidth = Math.max(1, Math.min(slot - 1, 6))
  const columns = bars.map(b => (b.value === null ? ([' ', ' ', ' '] as const) : column(b.value, max)))
  const color = (b: Bar) => (b.isCurrent ? GOLD : BLUE)
  const rows = [0, 1, 2].map(r => (
    <Text key={`chart-${r}`}>
      {bars.map((b, i) => (
        <Text key={`c-${r}-${b.key}`} color={b.value === null ? HAIRLINE : color(b)}>
          {(b.value === null && r === 2 ? '─' : columns[i]![r]!).repeat(barWidth).padEnd(slot)}
        </Text>
      ))}
    </Text>
  ))
  const labels =
    tab === 'month' ? (
      <Text color={MUTED} wrap="truncate-end">
        {fit(shortDate(bars[0]!.key), Math.max(1, Math.floor((slot * bars.length) / 2)))}
        {fit(shortDate(bars[15]!.key), Math.max(1, slot * bars.length - Math.floor((slot * bars.length) / 2) - 7))}
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

// ── Hooks ────────────────────────────────────────────────────────────────────

export function registerReport(on: On) {
  // Loads the days, the settings and the history estimate, and registers /report.
  on('session.start', { isInteractive: /^/ }, async ($, e, next) => {
    try {
      await loadAll($)
    } catch {
      // The report starts empty.
    }
    await $.command.register({
      name: 'report',
      description: 'Work Report: tasks done, hours saved, their worth and tokens used (settings: /report settings)',
      argumentHint: '[settings]',
      immediate: true,
    })
    return next(e)
  })

  // Answers at once; the pane opens after.
  on('command.run', { command: 'report' }, async ($, e) => {
    try {
      const args = e.args.trim()
      if (args === '') {
        void (async () => {
          try {
            await openReport($)
          } catch {
            $.ui.toast('The Work Report could not open just now. Try /report again.')
          }
        })()
        return { text: 'Work Report' }
      }
      const [first = '', ...rest] = args.split(/\s+/)
      if (first.toLowerCase() !== 'settings') return { text: 'Use /report, or /report settings to see or change the estimate.' }
      const current = await read($, reportSettings)
      if (rest.length === 0) return { text: describeSettings(current) }
      const changed = changeSettings(current, rest.join(' '))
      if (typeof changed === 'string') return { text: changed }
      await update($, reportSettings, () => changed)
      await $.store.set(SETTINGS_KEY, changed)
      return { text: describeSettings(changed) }
    } catch {
      return { text: 'The Work Report could not answer just now. Try /report again.' }
    }
  }).catch(() => ({ text: 'The Work Report could not answer just now. Try /report again.' }))

  on('ui.render', { component: 'Pane', requestId: REPORT_PANE }, async ($, e) => drawReport($, e))

  // A prompt you typed starts a task, unless it is folded into a turn already running.
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    try {
      if (isTypedPrompt(e.text, e.origin.kind) && !(await read($, isWorking))) await update($, reportPending, () => [])
    } catch {
      // Not counted.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every tool the request uses, its helpers' included, decides its kind.
  on('tool.call', { tool: /./ }, async ($, e, next) => {
    try {
      const pending = await read($, reportPending)
      if (pending !== null) {
        const signals = signalsOf(String(e.tool), e as unknown as Record<string, unknown>)
        await update($, reportPending, p => (p === null ? p : [...p, ...signals].slice(-400)))
      }
    } catch {
      // The kind falls back to Other.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A typed request that ends with an answer is one task; a cancelled or failed one is not. Every
  // turn's tokens count, a helper's or a cancelled one's too, since they were spent all the same.
  on('turn.complete', { turnId: /^/ }, async ($, e, next) => {
    try {
      const isMain = e.agentId === undefined
      const pending = isMain ? await read($, reportPending) : null
      if (isMain) await update($, reportPending, () => null)
      const isTask = pending !== null && e.reason === 'answer'
      const usage = e.usage !== undefined && tokenTotal(usageTokens(e.usage)) > 0 ? e.usage : undefined
      if (isTask || usage !== undefined) {
        const kind = isTask ? classify(pending) : null
        const model = e.usage?.model ?? (await $.session.model())
        const today = await refreshToday($)
        const saved = await update($, reportDays, all => {
          let day = all[today]
          if (kind !== null) day = recordTask(day, kind, model)
          if (usage !== undefined) day = recordTokens(day, usage)
          return day === undefined ? all : { ...all, [today]: day }
        })
        if (saved[today] !== undefined) await $.store.set(`${DAY_PREFIX}${today}`, saved[today])
      }
    } catch {
      // This turn goes uncounted.
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}

