import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { FlashTone, MilestoneStatus, PaneRow, Plan, PlanProgress } from '../types'
import { isPlanDoc, isPlanPath, parsePlan } from './plan-logic'
import {
  MARK_STATUS,
  applyStatus,
  flashesFor,
  fromTaskStatus,
  resolveIds,
  rowsFor,
  unitIdsIn,
  withProgress,
} from './progress-logic'
import { FLASH_MS, tonesFor } from './tones'

type Dollar = EngineInterface

const PANE = 'plan-pane'
const COMMAND = 'planpane'
const SECTION_ID = 'plan-pane:units'
const LAST_KEY = 'last'
const MAX_ROWS = 400
const progressKey = (path: string) => `progress:${path}`

const NO_PLAN = 'No plan yet. Write or open a plan document in a plans folder and it shows here.'
const TOO_NARROW = 'The window is too narrow to show the plan. Widen it and type /planpane again.'
const MARK_NAME = 'mark_milestone'
const MARK_TOOL = `mcp__plan-pane__${MARK_NAME}`
const MAX_LISTED = 40

// How Claude moves the marks: the mod's own tool first, which every session has; task and to-do
// names as well where a session has those tools.
const HOW_TO_MARK =
  `As you work through its milestones, call ${MARK_TOOL} with the milestone ids from the plan (for example ` +
  '["U3"]) and status "started" when work on one begins and "done" when it is finished, so the pane ticks ' +
  "them off. If you also track the work with TaskCreate or TodoWrite, start each task's subject with the " +
  'milestone id (for example "U3: Calendar view").'
const GUIDANCE = `A plan document is loaded in the Plan pane. ${HOW_TO_MARK}`
const NO_PLAN_ANSWER = 'No plan is loaded in the Plan pane, so nothing was marked.'

const listIds = (ids: readonly string[]) =>
  ids.slice(0, MAX_LISTED).join(', ') + (ids.length > MAX_LISTED ? `, and ${ids.length - MAX_LISTED} more` : '')
const milestoneIds = (p: Plan) => p.sections.flatMap(s => s.milestones.map(m => m.id))

// The one-time note for a plan that loads partway through a conversation, whose system prompt was
// fixed before the plan was there.
const announcement = (p: Plan) =>
  `The Plan pane now shows "${p.title}" (${p.path}). Its milestone ids: ${listIds(milestoneIds(p))}. ${HOW_TO_MARK}`

// The plan shown (progress merged in), the rows lit now, and the plan paths this mod shows.
const plan = atom({ plugin: 'plan-pane', key: 'plan' } as const, null, { shape: 'plan-1' })
const flash = atom({ plugin: 'plan-pane', key: 'flash' } as const, { ids: {}, generation: 0 }, { shape: 'flash-1' })
const claimed = atom({ plugin: 'plan-pane', key: 'claimed' } as const, [] as string[])
const announced = atom({ plugin: 'plan-pane', key: 'announced' } as const, null as string | null)

// The current plan as the file alone says it, and its progress from tasks. Module state: after a
// hot reload both are rebuilt from the file and the store (see current).
let base: Plan | null = null
let progress: PlanProgress = {}
// Task id (per agent) -> the milestone ids its subject names.
const taskUnits = new Map<string, string[]>()
let isLight: boolean | null = null

const taskKey = (agentId: string | undefined, taskId: string) => `${agentId ?? 'main'}:${taskId}`

async function readProgress($: Dollar, path: string): Promise<PlanProgress> {
  const saved = await $.store.get(progressKey(path))
  return saved !== null && typeof saved === 'object' ? (saved as PlanProgress) : {}
}

// The base plan and its progress, rebuilt from the file when module state was lost to a reload.
async function current($: Dollar): Promise<{ base: Plan; progress: PlanProgress } | null> {
  if (base !== null) return { base, progress }
  const shown = await read($, plan)
  if (shown === null) return null
  try {
    const text = await $.fs.read(shown.path)
    if (!isPlanDoc(shown.path, text)) return null
    base = parsePlan(shown.path, text)
    progress = await readProgress($, shown.path)
    return { base, progress }
  } catch {
    return null
  }
}

// Lights ids on top of the rows already lit; the timer clears them unless a newer flash came.
async function light($: Dollar, ids: Record<string, FlashTone>) {
  if (Object.keys(ids).length === 0) return
  let generation = 0
  await update($, flash, f => {
    generation = f.generation + 1
    return { ids: { ...f.ids, ...ids }, generation }
  })
  $.clock.after(FLASH_MS, () => {
    void update($, flash, f => (f.generation === generation ? { ids: {}, generation: f.generation } : f))
  })
}

async function claim($: Dollar, paths: readonly string[]) {
  await update($, claimed, list => [...list.filter(p => !paths.includes(p)), ...paths])
}

// A plan document was written, edited, read or approved: show it, replacing the one before.
async function showPlan($: Dollar, path: string, text: string, alsoClaim: readonly string[] = []) {
  if (!isPlanDoc(path, text)) return
  const parsed = parsePlan(path, text)
  const saved = await readProgress($, path)
  const merged = withProgress(parsed, saved)
  const before = await read($, plan)
  const hadPlan = before !== null
  base = parsed
  progress = saved
  await update($, plan, () => merged)
  await claim($, [path, ...alsoClaim.filter(p => p !== path)])
  await $.store.set(LAST_KEY, path)
  // flashesFor lights nothing when before is null; a different plan's rows all count as new.
  await light($, flashesFor(before, merged))
  // The system prompt's nudge is answered only while a plan is loaded.
  if (!hadPlan) $.ui.invalidate('prompt.section')
  try {
    await announce($, merged)
  } catch {
    // The pane still shows the plan; Claude misses the note this time.
  }
}

// Tells Claude, once per plan per session, what the plan's ids are and how to mark them. The system
// prompt's note can't do this: a conversation's prompt is fixed at its start, before this plan was.
async function announce($: Dollar, p: Plan) {
  if (milestoneIds(p).length === 0 || (await read($, announced)) === p.path) return
  await update($, announced, () => p.path)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: announcement(p) }] } })
}

// mark_milestone's work: set the named milestones to status and say what happened.
async function mark($: Dollar, given: readonly string[], status: MilestoneStatus): Promise<string> {
  const now = await current($)
  if (now === null) return NO_PLAN_ANSWER
  const known = milestoneIds(now.base)
  const { ids, unknown } = resolveIds(given, known)
  if (ids.length > 0) await applyChanges($, [[ids, status]])
  const all = (await read($, plan))?.sections.flatMap(s => s.milestones) ?? []
  const done = all.filter(m => m.status === 'done').length
  const word = status === 'done' ? 'done' : status === 'active' ? 'started' : 'not started'
  const parts: string[] = []
  if (ids.length > 0) parts.push(`Marked ${ids.join(', ')} ${word}.`)
  if (unknown.length > 0) parts.push(`Not in the plan: ${unknown.join(', ')}. Its milestone ids: ${listIds(known)}.`)
  parts.push(`${done} of ${all.length} done.`)
  return parts.join(' ')
}

// Status changes from tasks: each [milestone ids, status], applied in order.
async function applyChanges($: Dollar, changes: ReadonlyArray<readonly [readonly string[], MilestoneStatus]>) {
  const now = await current($)
  if (now === null) return
  const known = new Set(now.base.sections.flatMap(s => s.milestones.map(m => m.id)))
  let next = now.progress
  for (const [ids, status] of changes) {
    const inPlan = ids.filter(id => known.has(id))
    if (inPlan.length > 0) next = applyStatus(next, inPlan, status)
  }
  if (next === now.progress) return
  progress = next
  await $.store.set(progressKey(now.base.path), next)
  const before = await read($, plan)
  const merged = withProgress(now.base, next)
  await update($, plan, () => merged)
  await light($, flashesFor(before, merged))
}

const RANK: Record<MilestoneStatus, number> = { todo: 0, active: 1, done: 2 }

// A to-do list names milestones; each takes the furthest-along status of the to-dos naming it.
function todoChanges(todos: ReadonlyArray<{ content?: unknown; status?: unknown }>) {
  const best = new Map<string, MilestoneStatus>()
  for (const todo of todos) {
    const status = fromTaskStatus(typeof todo.status === 'string' ? todo.status : undefined)
    if (status === null || typeof todo.content !== 'string') continue
    for (const id of unitIdsIn(todo.content)) {
      const had = best.get(id)
      if (had === undefined || RANK[status] > RANK[had]) best.set(id, status)
    }
  }
  return [...best].map(([id, status]) => [[id], status] as const)
}

async function restore($: Dollar) {
  const path = await $.store.get(LAST_KEY)
  if (typeof path !== 'string') return
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    await $.store.delete(LAST_KEY)
    return
  }
  if (!isPlanDoc(path, text)) return
  base = parsePlan(path, text)
  progress = await readProgress($, path)
  await update($, plan, () => withProgress(base!, progress))
  await update($, claimed, () => [path])
}

async function lightBackground($: Dollar): Promise<boolean> {
  if (isLight !== null) return isLight
  try {
    // The /config menu's theme row: "light", "light-daltonized", "dark", "auto" and so on.
    const row = (await $.config.list()).find(r => r.key === 'theme')
    isLight = typeof row?.value === 'string' && row.value.includes('light')
  } catch {
    isLight = false
  }
  return isLight
}

const isFailed = (ran: { deny?: unknown; isError?: unknown }) => ran.deny !== undefined || ran.isError === true

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Written every start: Rods Rack reads it to know this mod is installed.
    await update($, claimed, () => [])
    await $.command.register({
      name: COMMAND,
      description: 'Show the current plan in a side pane: /planpane, or /planpane close',
      argumentHint: '[close]',
    })
    try {
      // Every session has this one, unlike TaskCreate and TodoWrite.
      await $.tool.register({
        name: MARK_NAME,
        description:
          'Tick milestones off in the Plan pane, the side pane that shows the plan document you are working ' +
          'from. ids are milestone ids as the plan names them ("U3", "task-2", "phase-1"; a range such as ' +
          '"U3–U5" works too). status is "started" when work on them begins, "done" when it is finished, or ' +
          '"not_started" to undo. The answer says what was marked and lists the plan\'s ids if one was not found.',
        inputSchema: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
            status: { type: 'string', enum: Object.keys(MARK_STATUS) },
          },
          required: ['ids', 'status'],
        },
        isDeferred: false,
      })
    } catch {
      // Progress still comes from checkboxes, tasks and to-dos.
    }
    try {
      await restore($)
    } catch {
      // No plan to bring back.
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Plan pane closed.' }
    }
    if (arg !== '') return { text: 'Use /planpane to open the plan, or /planpane close.' }
    isLight = null
    const opened = await $.ui.open({ id: PANE, title: 'Plan', columns: 48 })
    if (!opened.isPlaced) {
      $.ui.toast(TOO_NARROW)
      return { text: 'The plan pane is waiting for a wider window.' }
    }
    return { text: (await read($, plan)) === null ? 'Plan pane opened. No plan yet.' : 'Plan pane opened.' }
  }).catch(() => ({ text: 'The plan pane could not open just now. Try /planpane again.' }))

  // The mod's own tool, served here: answered at tool.call, it needs no permission prompt. A helper
  // agent's call counts too.
  on('tool.call', { tool: MARK_TOOL }, async ($, e) => {
    const input = e as unknown as { ids?: unknown; status?: unknown }
    const given = Array.isArray(input.ids)
      ? input.ids.filter((s): s is string => typeof s === 'string')
      : typeof input.ids === 'string'
        ? [input.ids]
        : []
    const status = typeof input.status === 'string' ? MARK_STATUS[input.status] : undefined
    if (status === undefined) return { deny: 'status must be "started", "done" or "not_started".' }
    if (given.length === 0) return { deny: 'ids needs at least one milestone id from the plan, such as "U3".' }
    return { result: await mark($, given, status) }
  }).catch(() => ({ result: 'The Plan pane could not record that just now.' }))

  // Plans and progress, read off the tools once they have run. Subagents' calls count too: a
  // helper may write the plan or move its tasks.
  on(
    'tool.call',
    { tool: ['Write', 'Edit', 'Read', 'ExitPlanMode', 'TodoWrite', 'TaskCreate', 'TaskUpdate'] },
    async ($, e, next) => {
      const ran = await next(e)
      if (isFailed(ran)) return ran
      try {
        const tool = String(e.tool)
        if (e.tool === 'Write') {
          const r = ran.result as { filePath?: string; content?: string; staged?: boolean } | undefined
          if (r?.staged !== true && isPlanPath(e.file_path)) {
            const text = typeof r?.content === 'string' ? r.content : e.content
            const also = typeof r?.filePath === 'string' ? [r.filePath] : []
            await showPlan($, e.file_path, text, also)
          }
        } else if (e.tool === 'Edit' || e.tool === 'Read') {
          const r = ran.result as { staged?: boolean } | undefined
          if (r?.staged !== true && isPlanPath(e.file_path)) {
            // Read the whole file: a Read may have taken only a range of it.
            await showPlan($, e.file_path, await $.fs.read(e.file_path))
          }
        } else if (tool === 'ExitPlanMode') {
          const r = ran.result as { plan?: string | null; filePath?: string } | undefined
          if (typeof r?.filePath === 'string' && typeof r.plan === 'string') await showPlan($, r.filePath, r.plan)
        } else if (e.tool === 'TodoWrite') {
          await applyChanges($, todoChanges(Array.isArray(e.todos) ? e.todos : []))
        } else if (e.tool === 'TaskCreate') {
          const r = ran.result as { task?: { id?: string; subject?: string } } | undefined
          const id = r?.task?.id
          const subject = r?.task?.subject ?? e.subject
          if (typeof id === 'string' && typeof subject === 'string') {
            const ids = unitIdsIn(subject)
            taskUnits.set(taskKey(e.agentId, id), ids)
            // A new task starts pending, which says nothing; a status given with it counts.
            const status = fromTaskStatus((e as { status?: string }).status)
            if (status !== null && status !== 'todo') await applyChanges($, [[ids, status]])
          }
        } else if (e.tool === 'TaskUpdate') {
          const key = taskKey(e.agentId, e.taskId)
          // A helper may move a task of the main conversation's list.
          const known = taskUnits.has(key) ? key : taskKey(undefined, e.taskId)
          if (typeof e.subject === 'string') taskUnits.set(known, unitIdsIn(e.subject))
          const ids = taskUnits.get(known) ?? []
          if (e.status === 'deleted') taskUnits.delete(known)
          const status = fromTaskStatus(e.status)
          if (status !== null && ids.length > 0) await applyChanges($, [[ids, status]])
        }
      } catch {
        // The pane misses this one; the tool's result stands.
      }
      return ran
    },
  )

  on('prompt.compose', async ($, e, next) => {
    const built = await next(e)
    if ((await read($, plan)) === null) return built
    return { sections: [...built.sections.filter(s => s.id !== SECTION_ID), { id: SECTION_ID, text: GUIDANCE, scope: 'session' }] }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e): Promise<RenderElement> => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const width = Math.max(1, e.props.bodyColumns)
    const shown = await read($, plan)
    if (shown === null) {
      return (
        <Box flexDirection="column" width={width}>
          <Text dimColor>{NO_PLAN}</Text>
        </Box>
      )
    }
    const lit = (await read($, flash)).ids
    // Capped so the Client's props stay well under its 100,000-character limit.
    const rows = rowsFor(shown, lit).slice(0, MAX_ROWS)
    const tones = tonesFor(await lightBackground($))

    if ((e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in elements) {
      const { Client } = elements
      return <Client key="plan-rows" module="./shimmer.tsx" width={width} props={{ rows, tones }} />
    }

    // The surfaces that run no Client module draw the same rows still, lit rows bold in their tone.
    const staticRow = (row: PaneRow) => {
      const toneColor = row.tone !== undefined ? tones[row.tone][0] : undefined
      const isBold = toneColor !== undefined || row.bold === true
      const isDim = toneColor === undefined && row.dim === true
      return (
        <Box key={`row:${row.id}`} flexDirection="row">
          {row.indent > 0 && <Text>{' '.repeat(row.indent)}</Text>}
          {row.glyph !== '' && <Text color={toneColor ?? row.glyphColor} bold={isBold}>{`${row.glyph} `}</Text>}
          <Box flexShrink={1} flexGrow={1}>
            <Text color={toneColor ?? row.color} bold={isBold} dimColor={isDim} wrap="truncate-end">
              {row.text}
            </Text>
          </Box>
          {row.right !== undefined && <Text dimColor>{` ${row.right}`}</Text>}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width={width}>
        {rows.map(staticRow)}
      </Box>
    )
  })
}
