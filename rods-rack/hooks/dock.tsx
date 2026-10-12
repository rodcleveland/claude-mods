import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { DockCard, DockMission, RackPrefs } from '../types'
import { autoStatusText, isShortReply } from './auto-model'
import {
  addQueued,
  atATime,
  badge,
  badgeColor,
  capDenial,
  CARD_LIMIT,
  cardMeter,
  cardsPerRow,
  claimSlot,
  clock,
  composeStatus,
  CORAL,
  counts,
  finishCard,
  finishMission,
  GOLD,
  HELPER_OPTIONS,
  IDLE_MISSION,
  IDLE_SEATS,
  infoLine,
  initials,
  INK,
  isBigTeam,
  isSettled,
  jobName,
  LIVE_GREEN,
  missionPercent,
  mix,
  MUTED,
  nudgeText,
  parseSize,
  removeCard,
  restoredSize,
  SIZES,
  SLATE,
  splitInstruction,
  startMission,
  STOPPED_DENIAL,
  STUCK_RED,
  summary,
  sweep,
  taskName,
  TEXT,
} from './dock-logic'

// The Agent Dock: a Team Size, every request split across that many helper agents, and a pane
// with one card per helper. Its plain logic is in dock-logic.ts.

type Dollar = EngineInterface

export const DOCK_PANE = 'rods-rack-dock'
const SIZE_KEY = 'dockSize'
const PANE_COLUMNS = 80
const FRAME_MS = 250
const WORKING_LIST_MAX = 15
const NARROW = 'The window is too narrow to show the Agent Dock. Widen it or watch the status bar.'

const DEFAULT_PREFS: RackPrefs = {
  model: null,
  effort: null,
  promptUpgrade: false,
  helper: 'same',
  autoModel: false,
  autoPrevious: null,
  autoUnavailable: [],
}

const dockSize = atom({ plugin: 'rods-rack', key: 'dockSize' } as const, 1)
const dockPending = atom({ plugin: 'rods-rack', key: 'dockPending' } as const, null as number | null)
const dockCustomOpen = atom({ plugin: 'rods-rack', key: 'dockCustomOpen' } as const, false)
const dockMission = atom({ plugin: 'rods-rack', key: 'dockMission' } as const, IDLE_MISSION)
const dockFrame = atom({ plugin: 'rods-rack', key: 'dockFrame' } as const, 0)
const dockFolded = atom({ plugin: 'rods-rack', key: 'dockFolded' } as const, false)
// Owned by Rods Rack (register.tsx) and Clean View (clean-view.tsx); the dock reads them.
const prefs = atom({ plugin: 'rods-rack', key: 'prefs' } as const, DEFAULT_PREFS)
const isWorking = atom({ plugin: 'rods-rack', key: 'isWorking' } as const, false)

// ── Clocks, the status line and the pane ─────────────────────────────────────

// One clock, running only while helpers are live.
let frameTimer: { cancel: () => void } | null = null

function syncFrame($: Dollar, mission: DockMission) {
  const isLive = mission.phase === 'live'
  if (isLive && frameTimer === null) {
    frameTimer = $.clock.every(FRAME_MS, () => void update($, dockFrame, n => n + 1))
  } else if (!isLive && frameTimer !== null) {
    frameTimer.cancel()
    frameTimer = null
  }
}

// Rods Rack's one status line: Auto Model's entry, and the dock's badge while it is folded.
async function refreshStatus($: Dollar) {
  const p = await read($, prefs)
  const isFolded = await read($, dockFolded)
  const mission = await read($, dockMission)
  $.ui.status(composeStatus(autoStatusText(p.autoModel, p.model), isFolded ? badge(mission) : null))
}

async function changeMission($: Dollar, fn: (m: DockMission) => DockMission) {
  const next = await update($, dockMission, fn)
  syncFrame($, next)
  if (await read($, dockFolded)) await refreshStatus($)
  return next
}

async function setSize($: Dollar, size: number) {
  await update($, dockSize, () => size)
  await update($, dockPending, () => null)
  await update($, dockCustomOpen, () => false)
  await $.store.set(SIZE_KEY, size)
}

// A size up to 20 is set at once; a bigger one waits for the dock's Continue.
async function chooseSize($: Dollar, size: number) {
  if (isBigTeam(size)) {
    await update($, dockCustomOpen, () => false)
    await update($, dockPending, () => size)
  } else {
    await setSize($, size)
  }
}

async function openDockPane($: Dollar) {
  const opened = await $.ui.open({ id: DOCK_PANE, title: 'Agent Dock', columns: PANE_COLUMNS })
  if (!opened.isPlaced) $.ui.toast(NARROW)
  await update($, dockFolded, () => false)
  await refreshStatus($)
}

async function foldDockPane($: Dollar) {
  await $.ui.close({ id: DOCK_PANE })
  await update($, dockFolded, () => true)
  await refreshStatus($)
}

async function toggleDockPane($: Dollar) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === DOCK_PANE)
  if (isUp) await foldDockPane($)
  else await openDockPane($)
}

async function helperLabel($: Dollar) {
  const helper = (await read($, prefs)).helper
  return HELPER_OPTIONS.find(h => h.value === helper)?.label ?? 'Same as main'
}

async function perWave($: Dollar) {
  return atATime(await $.env.get('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'), await $.env.get('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY'))
}

// ── Drawing ──────────────────────────────────────────────────────────────────

const spaced = (text: string) => text.split(' ').map(word => word.split('').join(' ')).join('   ')
const fit = (text: string, width: number) =>
  width <= 1 ? '' : text.length <= width ? text.padEnd(width) : text.slice(0, width - 1) + '…'

async function drawDock($: Dollar, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  const width = Math.max(30, e.props.bodyColumns)
  const size = await read($, dockSize)
  const pending = await read($, dockPending)
  const isCustomOpen = await read($, dockCustomOpen)
  const mission = await read($, dockMission)
  const frame = mission.phase === 'live' ? await read($, dockFrame) : 0
  const now = await $.clock.now()
  const label = await helperLabel($)
  const wave = await perWave($)
  const hasCards = mission.cards.length > 0 && mission.phase !== 'idle'

  // Masthead: the wordmark from coral to gold, and the dock's state at the right.
  const status =
    mission.phase === 'live' ? (
      <Text color={frame % 8 < 4 ? LIVE_GREEN : mix(LIVE_GREEN, '#0E1A14', 0.45)}>● L I V E</Text>
    ) : mission.phase === 'done' ? (
      <Text color={GOLD}>C O M P L E T E</Text>
    ) : (
      <Text color={MUTED}>S T A N D I N G   B Y</Text>
    )
  const masthead = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Text bold>
        <Text color={CORAL}>{'◆  '}</Text>
        {sweep(spaced('AGENT DOCK'), CORAL, GOLD).map((run, i) => (
          <Text key={`mark-${i}`} color={run.color}>{run.text}</Text>
        ))}
      </Text>
      {status}
    </Box>
  )

  // Team Size: one segmented control; the chosen size a filled coral chip.
  const isCustomSize = !SIZES.includes(size as (typeof SIZES)[number])
  const chip = (key: string, text: string, isPicked: boolean, onPress: () => void) => (
    <Button key={key} plain onPress={onPress}>
      {isPicked ? <Text bold color={INK} backgroundColor={CORAL}> {text} </Text> : <Text color={TEXT}> {text} </Text>}
    </Button>
  )
  const sizeRow = (
    <Box flexDirection="row" flexWrap="wrap" width={width}>
      <Text color={MUTED}>{'T E A M  S I Z E   '}</Text>
      {SIZES.map(n => chip(`size-${n}`, String(n), n === size, () => void chooseSize($, n)))}
      <Text color={SLATE}> │ </Text>
      {chip('size-custom', isCustomSize ? `Custom ${size}` : 'Custom', isCustomSize, () => void update($, dockCustomOpen, x => !x))}
    </Box>
  )

  const customBox =
    isCustomOpen && 'Input' in table ? (
      <Box flexDirection="row" gap={2} width={width}>
        <table.Input
          key="custom-size"
          label="How many helpers?"
          placeholder="1 to 100"
          autoFocus
          onSubmit={value => {
            const parsed = parseSize(value)
            if (parsed === null) $.ui.toast('Type a whole number from 1 to 100')
            else void chooseSize($, parsed)
          }}
        />
        <Button key="custom-cancel" plain onPress={() => void update($, dockCustomOpen, () => false)}>
          <Text color={MUTED}>Cancel</Text>
        </Button>
      </Box>
    ) : null

  const bigTeamBox =
    pending !== null ? (
      <Box borderStyle="round" borderColor={GOLD} paddingX={1} flexDirection="column" width={width}>
        <Text color={GOLD}>Big team: this uses your plan quickly. Continue?</Text>
        <Box flexDirection="row" gap={2}>
          <Button key="big-continue" plain onPress={() => void setSize($, pending)}>
            <Text bold color={INK} backgroundColor={GOLD}> Continue with {pending} </Text>
          </Button>
          <Button key="big-cancel" plain onPress={() => void update($, dockPending, () => null)}>
            <Text color={MUTED}>Cancel</Text>
          </Button>
        </Box>
      </Box>
    ) : null

  const rule = <Text color={SLATE}>{'─'.repeat(width)}</Text>

  return (
    <Box flexDirection="column" width={width}>
      {masthead}
      {rule}
      {sizeRow}
      <Text color={MUTED}>{infoLine(size, wave, label)}</Text>
      {customBox}
      {bigTeamBox}
      <Text> </Text>
      {hasCards ? drawMission(table, mission, width, frame, now) : drawIdle(table, size, width)}
    </Box>
  )
}

type Table = ReturnType<EngineInterface['ui']['resolve']>

// Standing by: one seat per team member, up to 25, and what the next request does.
function drawIdle(table: Table, size: number, width: number): RenderElement {
  const { Box, Text } = table
  const seats = Math.min(size, IDLE_SEATS)
  return (
    <Box flexDirection="column" alignItems="center" width={width}>
      <Text>
        {Array.from({ length: seats }, (_, i) => (
          <Text key={`seat-${i}`} color={badgeColor(i)}>● </Text>
        ))}
      </Text>
      <Text bold color={TEXT}>Your team of {size} is standing by</Text>
      <Text color={MUTED}>
        {size <= 1 ? 'Send a request and Claude decides how many helpers to use.' : `Send a request and it splits across ${size} helpers.`}
      </Text>
    </Box>
  )
}

function drawMission(table: Table, mission: DockMission, width: number, frame: number, now: number): RenderElement {
  const { Box, Text } = table
  const c = counts(mission.cards)
  const total = mission.cards.length
  const percent = missionPercent(mission.cards)
  const elapsed = clock((mission.finishedAt ?? now) - (mission.startedAt ?? now))
  const right = `${percent}%   ${elapsed}`

  // The mission bar: done a coral-to-gold sweep, working a shimmering green, the rest a hairline.
  const doneCells = Math.round((c.done / total) * width)
  const workCells = Math.min(width - doneCells, Math.round((c.working / total) * width))
  const bar = (
    <Text>
      {sweep('━'.repeat(doneCells), CORAL, GOLD).map((run, i) => (
        <Text key={`done-${i}`} color={run.color}>{run.text}</Text>
      ))}
      {Array.from({ length: workCells }, (_, i) => (
        <Text key={`work-${i}`} color={(i + frame) % 6 < 2 ? mix(LIVE_GREEN, '#FFFFFF', 0.35) : LIVE_GREEN}>━</Text>
      ))}
      <Text color={SLATE}>{'─'.repeat(Math.max(0, width - doneCells - workCells))}</Text>
    </Text>
  )

  const head = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Text wrap="truncate-end">
        <Text color={MUTED}>{'M I S S I O N   '}</Text>
        <Text bold color={TEXT}>{fit(mission.name, Math.max(8, width - 18 - right.length))}</Text>
      </Text>
      <Text color={TEXT}>{right}</Text>
    </Box>
  )

  const tally = (
    <Text wrap="truncate-end">
      <Text color={LIVE_GREEN}>● {c.working} working</Text>
      <Text color={MUTED}>{'    '}○ {c.queued} queued</Text>
      <Text color={GOLD}>{'    '}✓ {c.done} done</Text>
      <Text color={c.stuck > 0 ? STUCK_RED : MUTED}>{'    '}✕ {c.stuck} stuck</Text>
    </Text>
  )

  const body = total <= CARD_LIMIT ? drawCards(table, mission.cards, width, frame, now) : drawSeats(table, mission.cards, width, frame, now)

  const done =
    mission.phase === 'done' ? (
      <Box borderStyle="round" borderColor={LIVE_GREEN} paddingX={1} width={width}>
        <Text color={LIVE_GREEN} wrap="wrap">{summary(mission, now)}</Text>
      </Box>
    ) : null

  return (
    <Box flexDirection="column" width={width}>
      {head}
      {bar}
      {tally}
      <Text> </Text>
      {done}
      {body}
    </Box>
  )
}

const cardTimer = (card: DockCard, now: number) =>
  card.startedAt === null ? '—' : clock((card.finishedAt ?? now) - card.startedAt)

function cardLabel(card: DockCard): string {
  if (card.status === 'done') return '100%'
  if (card.status === 'stuck') return 'Stuck'
  if (card.status === 'queued') return 'Queued'
  return card.hasReported ? `${card.percent}%` : 'Working'
}

// Up to 12 helpers: a card each, two or three a row.
function drawCards(table: Table, cards: readonly DockCard[], width: number, frame: number, now: number): RenderElement {
  const { Box, Text } = table
  const perRow = cardsPerRow(width)
  const cardWidth = Math.floor((width - (perRow - 1)) / perRow)
  const inner = cardWidth - 4
  const rows: DockCard[][] = []
  for (let at = 0; at < cards.length; at += perRow) rows.push(cards.slice(at, at + perRow))

  const card = (helper: DockCard, index: number) => {
    const isQueued = helper.status === 'queued'
    const timer = cardTimer(helper, now).padStart(5)
    const nameWidth = Math.max(4, inner - 4 - 1 - timer.length)
    const labelText = cardLabel(helper).padStart(7)
    const meterCells = Math.max(4, inner - 4 - labelText.length - 1)
    const meterColor = helper.status === 'done' ? GOLD : helper.status === 'stuck' ? STUCK_RED : isQueued ? SLATE : LIVE_GREEN
    return (
      <Box
        key={`card-${helper.id}`}
        borderStyle="round"
        borderColor={helper.status === 'stuck' ? STUCK_RED : isQueued ? SLATE : '#3A4150'}
        hover={{ borderColor: CORAL }}
        paddingX={1}
        flexDirection="column"
        width={cardWidth}
      >
        <Text wrap="truncate-end" dimColor={isQueued}>
          <Text bold color={INK} backgroundColor={badgeColor(index)}>{initials(helper.name)}</Text>
          <Text>{'  '}</Text>
          <Text bold color={TEXT}>{fit(helper.name, nameWidth)}</Text>
          <Text color={MUTED}>{timer}</Text>
        </Text>
        <Text wrap="truncate-end" dimColor={isQueued}>
          <Text>{'    '}</Text>
          <Text color={meterColor}>{cardMeter(helper, meterCells, frame + index)}</Text>
          <Text color={helper.status === 'stuck' ? STUCK_RED : TEXT}> {labelText}</Text>
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row, r) => (
        <Box key={`row-${r}`} flexDirection="row" gap={1} width={width}>
          {row.map((helper, i) => card(helper, r * perRow + i))}
        </Box>
      ))}
    </Box>
  )
}

// More than 12 helpers: a seat each in one strip, and the list of the ones working now.
function drawSeats(table: Table, cards: readonly DockCard[], width: number, frame: number, now: number): RenderElement {
  const { Box, Text } = table
  const seat = (helper: DockCard) =>
    helper.status === 'working' ? (
      <Text key={`seat-${helper.id}`} color={LIVE_GREEN}>● </Text>
    ) : helper.status === 'done' ? (
      <Text key={`seat-${helper.id}`} color={GOLD}>● </Text>
    ) : helper.status === 'stuck' ? (
      <Text key={`seat-${helper.id}`} color={STUCK_RED}>✕ </Text>
    ) : (
      <Text key={`seat-${helper.id}`} color={SLATE}>○ </Text>
    )
  const working = cards.filter(c => c.status === 'working')
  const shown = working.slice(0, WORKING_LIST_MAX)
  const nameWidth = Math.max(8, width - 10 - 2 - 7 - 7)

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" flexWrap="wrap" width={width}>{cards.map(seat)}</Box>
      <Text>
        <Text color={LIVE_GREEN}>● working  </Text>
        <Text color={SLATE}>○ queued  </Text>
        <Text color={GOLD}>● done  </Text>
        <Text color={STUCK_RED}>✕ stuck</Text>
      </Text>
      <Text> </Text>
      <Text color={MUTED}>{'W O R K I N G   N O W'}</Text>
      {shown.map((helper, i) => (
        <Text key={`now-${helper.id}`} wrap="truncate-end">
          <Text color={LIVE_GREEN}>{cardMeter(helper, 10, frame + i)}</Text>
          <Text>{'  '}</Text>
          <Text color={TEXT}>{fit(helper.name, nameWidth)}</Text>
          <Text color={MUTED}>{cardTimer(helper, now).padStart(7)}</Text>
          <Text color={TEXT}>{cardLabel(helper).padStart(7)}</Text>
        </Text>
      ))}
      {working.length > shown.length && <Text color={MUTED}>and {working.length - shown.length} more working</Text>}
    </Box>
  )
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const agentBlocks = (content: unknown): Array<{ id: string; description: unknown }> =>
  Array.isArray(content)
    ? content
        .filter((b): b is { type: string; id: string; name: string; input?: Record<string, unknown> } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_use' && (b as { name?: unknown }).name === 'Agent',
        )
        .map(b => ({ id: b.id, description: b.input?.description }))
    : []

export function registerDock(on: On) {
  // A saved size up to 20 comes back; a big team starts the session at 1. Registers /dock.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const saved = await $.store.get(SIZE_KEY)
    const size = restoredSize(saved)
    await update($, dockSize, () => size)
    if (saved !== size) await $.store.set(SIZE_KEY, size)
    await update($, dockPending, () => null)
    await update($, dockCustomOpen, () => false)
    syncFrame($, await read($, dockMission))
    await $.command.register({
      name: 'dock',
      description: 'Agent Dock: open or fold it, or set the Team Size (/dock 10)',
      argumentHint: '[1-100]',
      immediate: true,
    })
    return next(e)
  })

  // Answers at once; the pane opens or folds after.
  on('command.run', { command: 'dock' }, async ($, e) => {
    try {
      const arg = e.args.trim()
      if (arg === '') {
        void (async () => {
          try {
            await toggleDockPane($)
          } catch {
            $.ui.toast(NARROW)
          }
        })()
        return { text: `Agent Dock · Team Size ${await read($, dockSize)}` }
      }
      const size = parseSize(arg)
      if (size === null) return { text: 'Team Size is a whole number from 1 to 100, e.g. /dock 10.' }
      await chooseSize($, size)
      if (isBigTeam(size)) {
        void (async () => {
          try {
            await openDockPane($)
          } catch {
            $.ui.toast(NARROW)
          }
        })()
        return { text: `Confirm the team of ${size} in the Agent Dock.` }
      }
      return { text: `Team Size is ${size}.` }
    } catch {
      return { text: 'The Agent Dock could not answer just now. Try /dock again.' }
    }
  }).catch(() => ({ text: 'The Agent Dock could not answer just now. Try /dock again.' }))

  on('ui.render', { component: 'Pane', requestId: DOCK_PANE }, async ($, e) => drawDock($, e))

  // A new request starts a mission; above size 1 it carries the split instruction.
  // Its own work is guarded: a failure here sends the request on untouched, and never takes Rods
  // Rack's other prompt.submit hook (Prompt Upgrade, Auto Model) down with it.
  on('prompt.submit', { text: /^/ }, async ($, e, next) => {
    let instruction: string | null = null
    try {
      const text = e.text.trim()
      const isTyped = e.origin.kind === 'composer' && text !== '' && !text.startsWith('/')
      if (isTyped && !isShortReply(text) && !(await read($, isWorking))) {
        const size = await read($, dockSize)
        instruction = splitInstruction(size)
        const now = await $.clock.now()
        await changeMission($, m => startMission(m, jobName(text), size, instruction !== null, now))
      }
    } catch {
      instruction = null
    }
    return instruction === null ? next(e) : next({ ...e, context: [...(e.context ?? []), instruction] })
  }).catch(($, e, next) => next(e))

  // Claude wrote its Agent calls: queued cards at once, before any runs.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        const blocks = agentBlocks(e.message.content)
        if (blocks.length > 0) {
          const now = await $.clock.now()
          await changeMission($, m => blocks.reduce((acc, b) => addQueued(acc, b.id, taskName(b.description), now), m))
        }
      }
    } catch {
      // The cards wait for tool.call instead.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every Agent call: the helper model, the Team Size cap, a slot in the wave, and its card.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const helper = (await read($, prefs)).helper
    const alias = HELPER_OPTIONS.find(h => h.value === helper)?.alias ?? null
    const call = alias !== null && e.model === undefined && e.subagent_type !== 'fork' ? { ...e, model: alias } : e
    if (e.agentId !== undefined) return next(call)

    const id = e.tool_use_id
    // The dock's own work is guarded: if it fails, the helper still runs, uncounted.
    let isTracked = false
    try {
      const mission = await read($, dockMission)
      if (mission.wantsSplit && mission.admitted >= mission.size) {
        await changeMission($, m => removeCard(m, id))
        return { deny: capDenial(mission.size) }
      }

      const queuedAt = await $.clock.now()
      await changeMission($, m => {
        const withCard = addQueued(m, id, taskName(e.description), queuedAt)
        return { ...withCard, admitted: withCard.admitted + 1 }
      })
      isTracked = true

      // Past the engine's limit the call waits here for a slot, rather than being refused.
      const limit = await perWave($)
      for (;;) {
        const startedAt = await $.clock.now()
        const claimed = await changeMission($, m => claimSlot(m, id, limit, startedAt).mission)
        if (claimed.cards.find(c => c.id === id)?.status === 'working') break
        if (next.signal.aborted) {
          await changeMission($, m => removeCard(m, id))
          return { deny: STOPPED_DENIAL }
        }
        await $.process.run(['/bin/sleep', '1'])
      }
    } catch {
      // Run it anyway.
    }

    const ran = await next(call)
    if (isTracked) {
      try {
        const endedAt = await $.clock.now()
        if (ran.deny !== undefined) {
          await changeMission($, m => ({ ...removeCard(m, id), admitted: Math.max(0, m.admitted - 1) }))
        } else {
          await changeMission($, m => finishCard(m, id, ran.isError !== true, endedAt))
        }
      } catch {
        // The card keeps its last state.
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The request's turn ended: one nudge if it used fewer helpers than the Team Size, else the summary.
  on('turn.complete', { reason: /^/ }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      const mission = await read($, dockMission)
      const now = await $.clock.now()
      const isShort = mission.wantsSplit && mission.admitted < mission.size && isSettled(mission)
      if (e.reason === 'answer' && isShort && !mission.nudged) {
        await changeMission($, m => ({ ...m, nudged: true }))
        void $.prompt.submit({ text: nudgeText(mission.admitted, mission.size) }).catch(() => undefined)
      } else if (mission.phase === 'live') {
        await changeMission($, m => finishMission(m, e.reason === 'aborted', now))
      }
    } catch {
      // The dock keeps what it had; the turn ends as it would.
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}

