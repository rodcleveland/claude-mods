import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { CleanChecklist, CleanPhase, CleanTask } from '../types'

// Clean View: tool rows hidden while Claude works, and one plain checklist above the prompt
// showing the plan, the step under way and how far along it is.

type Dollar = EngineInterface

const PLAN_TOOL = 'mcp__rods-rack__plan_steps'
const REPORT_TOOL = 'mcp__rods-rack__report_progress'
const STORE_KEY = 'cleanView'
const SECTION_ID = 'rods-rack:clean-view'

const NAME_MAX = 40
const METER_CELLS = 10
const FRAME_MS = 250
const COLLAPSE_MS = 5000
const FAILURES_TO_STUCK = 3

const PLACEHOLDER_TITLE = 'Working on your request'
const PLACEHOLDER_STEPS = ['Understand your request', 'Plan the steps']
const EMPTY_NAME = 'Working on it'

// Tools the plan gate always lets through: the ones Claude needs to make a plan or reach me.
const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN_TOOL, REPORT_TOOL])

const REASONS = {
  permission: 'Claude needs your OK to continue',
  question: 'Claude has a question for you',
  reply: 'Claude is waiting for your reply',
  saidNo: 'you said no to a step, so Claude paused',
  failing: 'a step keeps failing, Claude is trying another way',
  refusal: "Claude couldn't help with that request",
  usage: 'you hit your usage limit, try again a little later',
  busy: "Claude's servers are busy, try again in a minute",
  compact: 'type /compact and try again',
  network: 'the internet connection dropped',
  login: 'type /login',
  unknown: 'something went wrong reaching Claude, try again',
} as const

const NAMER_SYSTEM =
  'Name the job this request asks for in 2 to 6 plain words a non-technical person understands. ' +
  'Start with a verb. No file names, paths, code, commands or punctuation. Reply with the name only.'

const GUIDANCE = [
  'Clean View is on: the person sees a plain checklist of your steps instead of your tool calls.',
  `- For every request, even a quick question, call ${PLAN_TOOL} first with every step of the job, 2 to 8 in order. If it is deferred, load it with ToolSearch first.`,
  `- Then call ${REPORT_TOOL} as real progress happens on the current step, and with percent 100 the moment a step finishes.`,
  '- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".',
  '- Never put file paths, file names, commands, code or tool names in a step name.',
  '- If this session has TodoWrite or TaskCreate, you may use that to-do list as the plan instead.',
].join('\n')

const IDLE: CleanChecklist = {
  jobId: 0,
  title: '',
  phase: 'idle',
  tasks: [],
  source: 'placeholder',
  hasPlan: false,
  needsYouReason: null,
  stuckReason: null,
  failures: 0,
  startedAt: null,
  finishedAt: null,
  isCollapsed: false,
}

const cleanViewEnabled = atom({ plugin: 'rods-rack', key: 'cleanViewEnabled' } as const, true)
const checklist = atom({ plugin: 'rods-rack', key: 'checklist' } as const, IDLE)
const tick = atom({ plugin: 'rods-rack', key: 'tick' } as const, 0)
// Whether a main-conversation turn is running, whatever Clean View's switch; Auto Model reads it.
const isWorking = atom({ plugin: 'rods-rack', key: 'isWorking' } as const, false)

// ── Plain names ──────────────────────────────────────────────────────────────

const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|cs|c|cc|cpp|h|hpp|css|scss|less|html?|json|ya?ml|toml|ini|md|sh|bash|ps1|sql|vue|svelte|php|xml|lock|env|vb|csproj|sln|gradle)$/i

export function cleanName(raw: string): string {
  const words = raw
    .replace(/`[^`]*`?/g, ' ')
    .split(/\s+/)
    .filter(word => {
      const bare = word.replace(/^[("'[]+|[)"'\],.;:!?]+$/g, '')
      return bare !== '' && !/[/\\]/.test(bare) && !CODE_FILE.test(bare)
    })
  let name = words.join(' ').trim()
  if (name === '') return EMPTY_NAME
  name = name.charAt(0).toUpperCase() + name.slice(1)
  if (name.length <= NAME_MAX) return name

  const head = name.slice(0, NAME_MAX - 1)
  const space = head.lastIndexOf(' ')
  return (space > 0 ? head.slice(0, space) : head).replace(/[\s,.;:–-]+$/, '') + '…'
}

// ── The checklist as plain data ──────────────────────────────────────────────

const isOpen = (c: CleanChecklist) => c.phase === 'working' || c.phase === 'needsYou' || c.phase === 'stuck'
const isAnimated = (phase: CleanPhase) => phase === 'working' || phase === 'needsYou'
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)))
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const step = (id: string, name: string, status: CleanTask['status']): CleanTask => ({
  id,
  name,
  status,
  percent: status === 'done' ? 100 : 0,
  hasReported: status === 'done',
})

export function startJob(jobId: number, now: number): CleanChecklist {
  return {
    ...IDLE,
    jobId,
    title: PLACEHOLDER_TITLE,
    phase: 'working',
    tasks: PLACEHOLDER_STEPS.map((name, i) => step(`placeholder-${i}`, name, i === 0 ? 'active' : 'upcoming')),
    startedAt: now,
  }
}

const resume = (c: CleanChecklist): CleanChecklist => ({ ...c, phase: 'working', needsYouReason: null, stuckReason: null, failures: 0 })

export function planSteps(c: CleanChecklist, steps: readonly string[]): CleanChecklist {
  const names = steps.map(cleanName).slice(0, 8)
  return {
    ...c,
    tasks: names.map((name, i) => step(`step-${c.jobId}-${i}`, name, i === 0 ? 'active' : 'upcoming')),
    source: 'plan',
    hasPlan: true,
  }
}

export function reportProgress(c: CleanChecklist, task: string, percent: number): CleanChecklist {
  const name = cleanName(task)
  const value = clamp(percent)
  let tasks = c.source === 'placeholder' ? [] : [...c.tasks]
  let at = tasks.findIndex(t => sameName(t.name, name))

  if (at === -1) {
    // A step that was not planned is a detour: it goes in where the current step is, which waits.
    const active = tasks.findIndex(t => t.status === 'active')
    at = active === -1 ? tasks.length : active
    tasks.splice(at, 0, step(`step-${c.jobId}-${tasks.length}-${name}`, name, 'active'))
  }

  tasks = tasks.map((t, i) => {
    if (i < at) return { ...t, status: 'done', percent: 100, hasReported: true }
    if (i === at) return { ...t, status: value >= 100 ? 'done' : 'active', percent: value, hasReported: true }
    return t.status === 'active' ? { ...t, status: 'upcoming' } : t
  })

  if (value >= 100) {
    const nextStep = tasks.findIndex((t, i) => i > at && t.status === 'upcoming')
    if (nextStep !== -1) tasks[nextStep] = { ...tasks[nextStep]!, status: 'active', percent: 0, hasReported: false }
  }

  return { ...c, tasks, source: c.source === 'placeholder' ? 'plan' : c.source }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export function fromTodos(c: CleanChecklist, todos: readonly Todo[]): CleanChecklist {
  const tasks = todos.map((todo, i): CleanTask => {
    const name = cleanName(todo.content)
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'
    const known = c.tasks.find(t => sameName(t.name, name) && t.hasReported)
    if (status === 'active' && known !== undefined) return { ...known, status }
    return step(`todo-${c.jobId}-${i}`, name, status)
  })
  return { ...c, tasks, source: 'todo', hasPlan: tasks.length > 0 || c.hasPlan }
}

function addTask(c: CleanChecklist, id: string, subject: string): CleanChecklist {
  const tasks = c.source === 'placeholder' ? [] : c.tasks
  const status = tasks.some(t => t.status === 'active') ? 'upcoming' : 'active'
  return { ...c, tasks: [...tasks, step(`task-${id}`, cleanName(subject), status)], source: 'todo', hasPlan: true }
}

function updateTask(c: CleanChecklist, id: string, change: { subject?: string; status?: string }): CleanChecklist {
  const key = `task-${id}`
  if (change.status === 'deleted') return { ...c, tasks: c.tasks.filter(t => t.id !== key) }
  return {
    ...c,
    tasks: c.tasks.map(t => {
      if (t.id !== key) return t
      const name = change.subject === undefined ? t.name : cleanName(change.subject)
      if (change.status === 'completed') return { ...t, name, status: 'done', percent: 100, hasReported: true }
      if (change.status === 'in_progress') return { ...t, name, status: 'active' }
      if (change.status === 'pending') return { ...t, name, status: 'upcoming' }
      return { ...t, name }
    }),
  }
}

export function apiErrorReason(kind: string, details = ''): string {
  if (/prompt is too long|context (window|length)|too many tokens/i.test(details)) return REASONS.compact
  if (/network|connection|ECONN|ENOTFOUND|socket|fetch failed|offline/i.test(details)) return REASONS.network
  switch (kind) {
    case 'rate_limit':
    case 'billing_error':
      return REASONS.usage
    case 'overloaded':
    case 'server_error':
      return REASONS.busy
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return REASONS.login
    default:
      return REASONS.unknown
  }
}

const SAID_NO = /doesn't want to proceed|tool use was rejected|user (rejected|declined|denied)/i

// ── Writes, and the clocks they drive ────────────────────────────────────────

let frameTimer: { cancel: () => void } | null = null

// Clean View is for a person at the prompt: a -p run or an SDK host never turns it on.
let isActive = false

async function isLive($: Dollar) {
  return isActive && (await read($, cleanViewEnabled))
}

function syncFrames($: Dollar, phase: CleanPhase) {
  if (isAnimated(phase) && frameTimer === null) {
    frameTimer = $.clock.every(FRAME_MS, () => void update($, tick, n => n + 1))
  } else if (!isAnimated(phase) && frameTimer !== null) {
    frameTimer.cancel()
    frameTimer = null
  }
}

async function change($: Dollar, fn: (c: CleanChecklist) => CleanChecklist) {
  const next = await update($, checklist, fn)
  syncFrames($, next.phase)
  return next
}

// Changes an open job only; a finished or absent one is left as it is.
const changeOpen = ($: Dollar, fn: (c: CleanChecklist) => CleanChecklist) => change($, c => (isOpen(c) ? fn(c) : c))

async function finish($: Dollar, phase: 'done' | 'stopped' | 'needsYou' | 'stuck', reason: string | null = null) {
  const now = await $.clock.now()
  const done = await changeOpen($, c => ({
    ...c,
    phase,
    needsYouReason: phase === 'needsYou' ? reason : null,
    stuckReason: phase === 'stuck' ? reason : null,
    finishedAt: phase === 'done' || phase === 'stopped' ? now : c.finishedAt,
    tasks: phase === 'done' ? c.tasks.map(t => ({ ...t, status: 'done', percent: 100, hasReported: true })) : c.tasks,
  }))
  if (phase === 'done') {
    const jobId = done.jobId
    $.clock.after(COLLAPSE_MS, () => void change($, c => (c.jobId === jobId && c.phase === 'done' ? { ...c, isCollapsed: true } : c)))
  }
}

async function setCleanView($: Dollar, isOn: boolean) {
  await update($, cleanViewEnabled, () => isOn)
  await $.store.set(STORE_KEY, isOn)
  $.ui.toast(isOn ? 'Clean View is on' : 'Clean View is off: every step is showing again')
}

async function hydrate($: Dollar) {
  const saved = await $.store.get(STORE_KEY)
  if (typeof saved === 'boolean') await update($, cleanViewEnabled, () => saved)
}

async function nameJob($: Dollar, jobId: number, text: string) {
  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    system: NAMER_SYSTEM,
    prompt: text.slice(0, 2000),
    maxTokens: 30,
    timeoutMs: 10000,
  })
  if (!reply.isAnswered) return
  // Quotes and a closing period go; an apostrophe inside a word (Florida's) stays.
  const words = reply.text.trim().replace(/^["'“‘\s]+|["'”’.\s]+$/g, '').replace(/"/g, '').split(/\s+/).slice(0, 6).join(' ')
  const title = cleanName(words)
  if (title === EMPTY_NAME) return
  await change($, c => (c.jobId === jobId ? { ...c, title } : c))
}

// ── The band ─────────────────────────────────────────────────────────────────

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function meter(t: CleanTask, frame: number): string {
  if (t.status === 'done') return '█'.repeat(METER_CELLS)
  if (t.status === 'upcoming') return '░'.repeat(METER_CELLS)
  if (t.hasReported) {
    const filled = Math.round(t.percent / 10)
    return '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled)
  }
  // No percent yet: a three-cell sweep that moves one cell a frame.
  return Array.from({ length: METER_CELLS }, (_, i) => ((i - frame) % METER_CELLS + METER_CELLS) % METER_CELLS < 3 ? '█' : '░').join('')
}

// The whole job at a glance: which step of how many, and how far along the job is. Each done step
// counts in full and the current one by its reported percent.
export function overallProgress(tasks: readonly CleanTask[]): { step: number; total: number; percent: number } {
  const total = tasks.length
  if (total === 0) return { step: 0, total: 0, percent: 0 }
  const done = tasks.filter(t => t.status === 'done').length
  const active = tasks.findIndex(t => t.status === 'active')
  const share = tasks.reduce((sum, t) => sum + (t.status === 'done' ? 100 : t.status === 'active' && t.hasReported ? t.percent : 0), 0)
  return { step: active === -1 ? Math.max(1, done) : active + 1, total, percent: Math.round(share / total) }
}

// Each job's own color, taken in turn: its border, its title, its ▶ and its meter. Green, yellow and
// the error color keep their meaning (done, needs you, stuck), so none of them is here.
export const JOB_COLORS = ['#5AB0F0', '#B07AA1', '#4FC1B0', '#E8743B', '#E06C9F', '#8F9BFF'] as const

export const jobColor = (jobId: number) => JOB_COLORS[(((jobId - 1) % JOB_COLORS.length) + JOB_COLORS.length) % JOB_COLORS.length]!

// The border and the padding inside it take two cells each side.
const FRAME_CELLS = 4

const fit = (name: string, width: number) => (name.length <= width ? name.padEnd(width) : name.slice(0, Math.max(1, width - 1)) + '…')

// The checklist with its Clean View button above it; with Clean View off, the button alone.
async function drawCleanBand($: Dollar, e: RenderInput<'AbovePrompt'>): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isOn = await read($, cleanViewEnabled)
  const c = await read($, checklist)
  const isFramed = e.surface === 'terminal' && isOn && c.phase !== 'idle'
  const columns = e.props.bodyColumns - (isFramed ? FRAME_CELLS : 0)
  const color = jobColor(c.jobId)

  const button = (
    <Button key="clean-view-toggle" label={isOn ? '● Clean View: ON' : '○ Clean View: OFF'} onPress={() => setCleanView($, !isOn)} />
  )
  const header = (left: RenderElement | null) => (
    <Box flexDirection="row" justifyContent="space-between" width={columns}>
      <Box flexGrow={1} flexShrink={1}>{left ?? <Text> </Text>}</Box>
      {button}
    </Box>
  )

  if (!isOn || c.phase === 'idle') return header(null)

  const frame = isAnimated(c.phase) ? await read($, tick) : 0
  const now = await $.clock.now()
  const started = c.startedAt ?? now
  const title = c.title || PLACEHOLDER_TITLE

  const headline = (() => {
    switch (c.phase) {
      case 'needsYou':
        return (
          <Text wrap="truncate-end">
            <Text bold color="black" backgroundColor="yellow"> Needs you </Text>
            <Text> {c.needsYouReason ?? REASONS.reply}</Text>
          </Text>
        )
      case 'stuck':
        return <Text color="yellow" wrap="truncate-end">⚠ Stuck: {c.stuckReason ?? REASONS.unknown}</Text>
      case 'stopped':
        return <Text wrap="truncate-end">■ Stopped · {title} · you pressed Esc</Text>
      case 'done':
        return <Text color="green" wrap="truncate-end">✓ All done · {title} · took {elapsed((c.finishedAt ?? now) - started)}</Text>
      default:
        return <Text bold color={color} wrap="truncate-end">{title} · {elapsed(now - started)}</Text>
    }
  })()

  // A rounded border in the job's color, on the terminal; other surfaces draw their own frame.
  const framed = (body: RenderElement) =>
    isFramed ? (
      <Box borderStyle="round" borderColor={color} paddingX={1} width={e.props.bodyColumns}>{body}</Box>
    ) : (
      body
    )

  if (c.phase === 'done' && c.isCollapsed) return framed(header(headline))

  // Mark, space, name, two spaces, a 10-cell meter, two spaces, a label of up to 7.
  const nameWidth = Math.max(8, Math.min(NAME_MAX, columns - 2 - 2 - METER_CELLS - 2 - 7))
  const firstUpcoming = c.tasks.findIndex(t => t.status === 'upcoming')

  // "Step 2 of 4", a bar ending where the step meters end, and the job's percent in the label column.
  // The placeholders a new job shows are not the plan, so they get no step count.
  const overall = overallProgress(c.tasks)
  const stepLine = (() => {
    if (c.source === 'placeholder' || overall.total === 0) return null
    const label = `Step ${overall.step} of ${overall.total}`
    const barCells = Math.max(METER_CELLS, 2 + nameWidth + 2 + METER_CELLS - label.length - 2)
    const filled = Math.round((overall.percent / 100) * barCells)
    return (
      <Text key="overall" wrap="truncate-end">
        <Text dimColor>{label}  </Text>
        <Text color={color}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(barCells - filled)}</Text>
        <Text color={color}>  {overall.percent}%</Text>
      </Text>
    )
  })()

  const rows = c.tasks.map((t, i) => {
    if (t.status === 'done') {
      return (
        <Text key={t.id} wrap="truncate-end">
          <Text color="green">✓ </Text>
          <Text dimColor>{fit(t.name, nameWidth)}</Text>
          <Text color="green">  {meter(t, frame)}  </Text>
          <Text dimColor>Done</Text>
        </Text>
      )
    }
    if (t.status === 'active') {
      return (
        <Text key={t.id} wrap="truncate-end">
          <Text color={color}>{c.phase === 'needsYou' ? '‖ ' : '▶ '}</Text>
          <Text bold>{fit(t.name, nameWidth)}</Text>
          <Text color={color}>  {meter(t, frame)}  </Text>
          <Text>{t.hasReported ? `${t.percent}%` : 'Working'}</Text>
        </Text>
      )
    }
    return (
      <Text key={t.id} dimColor wrap="truncate-end">
        {'○ '}{fit(t.name, nameWidth)}  {meter(t, frame)}  {i === firstUpcoming ? 'Next' : 'Up next'}
      </Text>
    )
  })

  return framed(
    <Box flexDirection="column" width={columns}>
      {header(headline)}
      {stepLine}
      {rows}
    </Box>,
  )
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const toolText = (ran: { text?: string; deny?: string }) => ran.deny ?? ran.text ?? ''

export function registerCleanView(on: On) {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    isActive = true
    await hydrate($)
    syncFrames($, (await read($, checklist)).phase)
    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off (on | off; nothing flips it)',
      argumentHint: 'on|off',
      immediate: true,
    })
    await $.tool.register({
      name: 'plan_steps',
      description:
        "Lay out every step of the job up front for the person's checklist: 2 to 8 short plain-English names, in order, " +
        'each under 40 characters and starting with a verb. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        "Report progress on the current step of the person's checklist. task is the step's name as planned; " +
        'percent is 0 to 100, and 100 the moment the step finishes, which starts the next one.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, percent: { type: 'number' } },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  // /clear starts over; /resume and /branch keep the checklist.
  on('classic.SessionStart', { source: 'clear' }, async ($, e, next) => {
    try {
      await change($, () => IDLE)
    } catch {
      // Keep the live values.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The checklist sits on top of the band; whatever else draws there (the Rods Rack panel) goes below.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !isActive) return next(e)
    const own = await drawCleanBand($, e)
    const below = await next(e)
    const { Box } = $.ui.resolve(e)
    // The wrapper carries no size: the engine refuses its own node under a Box with a width.
    return (
      <Box flexDirection="column">
        {own}
        {below}
      </Box>
    )
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: 'Use /simple on, /simple off, or /simple to flip it.' }
    const isOn = arg === '' ? !(await read($, cleanViewEnabled)) : arg === 'on'
    await setCleanView($, isOn)
    return { text: isOn ? 'Clean View is on.' : 'Clean View is off.' }
  }).catch(() => ({ text: 'Clean View could not be switched just now. Try /simple again.' }))

  on('prompt.compose', async ($, e, next) => {
    const built = await next(e)
    if (!(await isLive($))) return built
    return { sections: [...built.sections.filter(s => s.id !== SECTION_ID), { id: SECTION_ID, text: GUIDANCE, scope: 'session' }] }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await update($, isWorking, () => true)
    const text = e.text.trim()
    if (text === '' || text.startsWith('/') || !(await isLive($))) return next(e)

    const c = await read($, checklist)
    if (isOpen(c)) {
      await change($, resume)
    } else {
      const jobId = c.jobId + 1
      const now = await $.clock.now()
      await change($, () => startJob(jobId, now))
      void nameJob($, jobId, text).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const steps = Array.isArray(e.steps) ? e.steps.filter((s): s is string => typeof s === 'string') : []
    if (steps.length === 0) return { deny: 'plan_steps needs steps: a list of 2 to 8 short step names.' }
    if (e.agentId === undefined) {
      const c = await read($, checklist)
      if (!isOpen(c)) {
        const now = await $.clock.now()
        await change($, () => startJob(c.jobId + 1, now))
      }
      await change($, x => planSteps(x, steps))
    }
    const count = Math.min(8, steps.length)
    return { result: `Planned ${count} steps. The first one has started.` }
  }).catch(() => ({ result: 'Planned the steps. The first one has started.' }))

  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    const percent = clamp(typeof e.percent === 'number' ? e.percent : Number(e.percent))
    if (e.agentId === undefined && typeof e.task === 'string') {
      await changeOpen($, c => reportProgress(c, e.task as string, percent))
    }
    return { result: `Progress noted: ${percent}%.` }
  }).catch(() => ({ result: 'Progress noted.' }))

  // The plan gate, and the checklist's reading of what the main agent's tools did.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (e.agentId !== undefined || tool === PLAN_TOOL || tool === REPORT_TOOL) return next(e)

    const isOn = await isLive($)
    const c = await read($, checklist)
    if (isOn && isOpen(c) && !c.hasPlan && !ALWAYS_ALLOWED.has(tool)) {
      return { deny: `Clean View: call ${PLAN_TOOL} first to lay out the steps of this job, then try again.` }
    }

    if (tool === 'AskUserQuestion') {
      await changeOpen($, x => ({ ...x, phase: 'needsYou', needsYouReason: REASONS.question }))
    } else if (c.phase === 'needsYou') {
      await changeOpen($, x => ({ ...x, phase: 'working', needsYouReason: null }))
    }

    const ran = await next(e)
    const hasFailed = ran.deny !== undefined || ran.isError === true

    if (hasFailed && SAID_NO.test(toolText(ran))) {
      await changeOpen($, x => ({ ...x, phase: 'stuck', stuckReason: REASONS.saidNo, needsYouReason: null, failures: 0 }))
    } else if (hasFailed) {
      await changeOpen($, x => {
        const failures = x.failures + 1
        return failures >= FAILURES_TO_STUCK ? { ...x, failures, phase: 'stuck', stuckReason: REASONS.failing } : { ...x, failures }
      })
    } else {
      await changeOpen($, x => ({ ...x, phase: 'working', stuckReason: null, needsYouReason: null, failures: 0 }))
      if (e.tool === 'TodoWrite') {
        await changeOpen($, x => fromTodos(x, e.todos))
      } else if (e.tool === 'TaskCreate') {
        const created = ran.result as { task?: { id?: string } } | undefined
        const id = created?.task?.id
        if (id !== undefined) await changeOpen($, x => addTask(x, id, e.subject))
      } else if (e.tool === 'TaskUpdate') {
        const id = e.taskId
        const update = { subject: e.subject, status: e.status }
        await changeOpen($, x => updateTask(x, id, update))
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') {
      await changeOpen($, c => ({ ...c, phase: 'needsYou', needsYouReason: REASONS.permission }))
    } else if (e.notification_type === 'elicitation_dialog') {
      await changeOpen($, c => ({ ...c, phase: 'needsYou', needsYouReason: REASONS.question }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    const reason = apiErrorReason(e.error, e.error_details)
    await change($, c => (isOpen(c) ? { ...c, phase: 'stuck', stuckReason: reason, needsYouReason: null } : c))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, isWorking, () => false)
    const c = await read($, checklist)
    if (e.reason === 'aborted') {
      await finish($, 'stopped')
    } else if (e.reason === 'refusal') {
      await finish($, 'stuck', REASONS.refusal)
    } else if (e.reason === 'error') {
      if (c.phase !== 'stuck') await finish($, 'stuck', REASONS.unknown)
    } else if (c.hasPlan && c.tasks.some(t => t.status !== 'done')) {
      await finish($, 'needsYou', REASONS.reply)
    } else {
      await finish($, 'done')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Hide the technical rows while Clean View is on; Claude's written replies stay.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await isLive($))) return next(e)
    return $.ui.resolve(e).Box({})
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await isLive($))) return next(e)
    return $.ui.resolve(e).Box({})
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await isLive($))) return next(e)
    return $.ui.resolve(e).Box({})
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await isLive($))) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })
}
