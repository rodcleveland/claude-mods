import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type {
  RackEffort,
  RackFamily,
  RackHelper,
  RackPrefs,
  RackSeen,
  RackUpgrade,
} from '../types'
import { autoStatusText, familyFor, guessLevel, isShortReply, parseLevel, SORT_SYSTEM } from './auto-model'
import { registerCleanView } from './clean-view'
import { DOCK_PANE, registerDock } from './dock'
import { REPORT_PANE, registerReport } from './report'
import { registerTv, TV_PANE } from './tv'
import { isPlaying, OFF_STATE } from './tv-logic'
import { badge, composeStatus, HELPER_OPTIONS, IDLE_MISSION, isBigTeam, SIZES } from './dock-logic'

// Edit this to change what "Create photo or video" asks for.
export const CREATE_PROMPT =
  'I want to create a photo or a video. First ask me what I want to make: ' +
  'the subject, the style, the format (image or video) and any size or length. ' +
  'Then make it with whichever image or video generation MCP server is connected. ' +
  'If none is connected, tell me so instead of guessing.'

const UPGRADE_SYSTEM =
  'Rewrite the user prompt so it is clearer and more specific for a coding assistant. ' +
  'Keep the user\'s intent and every constraint, file name, value and instruction they stated. ' +
  'Do not add requirements they did not ask for. Reply with the rewritten prompt only.'

const DOCK_SIZE_KEY = 'dockSize'
const DOCK_NARROW = 'The window is too narrow to show the Agent Dock. Widen it or watch the status bar.'
const STORE_KEY = 'prefs'
const CLEAN_VIEW_KEY = 'cleanView'
const UPGRADE_TIMEOUT_MS = 5000
const SORT_TIMEOUT_MS = 4000
const SORT_MAX_TOKENS = 8

const ORANGE = '#E8743B'
const PURPLE = '#B07AA1'
const INK = '#1a1a1a'
// Auto Model's footer chip: gold while on, slate while off.
const GOLD = '#F2C46D'
const SLATE = '#262B33'
const LIGHT = '#E6EDF3'

// No model list is exposed to plugins on this build (2.1.296: no $.model.list, no session setter),
// so the four current model lines are fixed here, smallest to most capable. Auto Model reads this too.
const MODELS: ReadonlyArray<{ family: RackFamily; label: string; id: string }> = [
  { family: 'haiku', label: 'Haiku 5.5', id: 'claude-haiku-5-5' },
  { family: 'sonnet', label: 'Sonnet 5.5', id: 'claude-sonnet-5-5' },
  { family: 'opus', label: 'Opus 5.5', id: 'claude-opus-5-5' },
  { family: 'fable', label: 'Fable 5.1', id: 'claude-fable-5-1' },
]
const EFFORTS: ReadonlyArray<{ value: RackEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
]

const DEFAULT_PREFS: RackPrefs = {
  model: null,
  effort: null,
  promptUpgrade: false,
  helper: 'same',
  autoModel: false,
  autoPrevious: null,
  autoUnavailable: [],
}

const prefs = atom({ plugin: 'rods-rack', key: 'prefs' } as const, DEFAULT_PREFS)
const panelOpen = atom({ plugin: 'rods-rack', key: 'panelOpen' } as const, false)
const seen = atom({ plugin: 'rods-rack', key: 'seen' } as const, { model: null, effort: null } as RackSeen)
// Owned by Clean View (clean-view.tsx); the panel's switch writes the same value.
const cleanViewEnabled = atom({ plugin: 'rods-rack', key: 'cleanViewEnabled' } as const, true)
const lastUpgrade = atom({ plugin: 'rods-rack', key: 'lastUpgrade' } as const, null as RackUpgrade | null)
// Owned by the Agent Dock (dock.tsx); the panel's Team size row and its launcher write the same values.
const dockSize = atom({ plugin: 'rods-rack', key: 'dockSize' } as const, 1)
const dockPending = atom({ plugin: 'rods-rack', key: 'dockPending' } as const, null as number | null)
const dockCustomOpen = atom({ plugin: 'rods-rack', key: 'dockCustomOpen' } as const, false)
const dockFolded = atom({ plugin: 'rods-rack', key: 'dockFolded' } as const, false)
const dockMission = atom({ plugin: 'rods-rack', key: 'dockMission' } as const, IDLE_MISSION)
// Written by Clean View's turn.start and turn.complete (clean-view.tsx).
const isWorking = atom({ plugin: 'rods-rack', key: 'isWorking' } as const, false)
// Owned by YouTube TV (tv.tsx); its footer chip shows when it plays.
const tv = atom({ plugin: 'rods-rack', key: 'tv' } as const, OFF_STATE)

type Dollar = EngineInterface

const familyOf = (model: string | null): RackFamily | null =>
  MODELS.find(m => model !== null && model.includes(m.family))?.family ?? null

const isPrefs = (value: unknown): value is Partial<RackPrefs> =>
  typeof value === 'object' && value !== null

async function hydrate($: Dollar) {
  const saved = await $.store.get(STORE_KEY)
  if (isPrefs(saved)) {
    // Clean View's switch lives in its own store key now; an old cleanView field is dropped.
    const { cleanView: _old, ...kept } = saved as Partial<RackPrefs> & { cleanView?: unknown }
    await update($, prefs, () => ({ ...DEFAULT_PREFS, ...kept }))
  }
  $.ui.invalidate('ui.render')
}

async function setPrefs($: Dollar, change: (p: RackPrefs) => RackPrefs) {
  const next = await update($, prefs, change)
  await $.store.set(STORE_KEY, next)
}

const labelOf = (family: RackFamily | null) => MODELS.find(m => m.family === family)?.label ?? 'Default'

// Rods Rack's one status line: Auto Model's pick (its one sign on screen), and the Agent Dock's
// badge while the dock is folded.
async function showAutoStatus($: Dollar, p: RackPrefs) {
  const isFolded = await read($, dockFolded)
  const mission = await read($, dockMission)
  $.ui.status(composeStatus(autoStatusText(p.autoModel, p.model), isFolded ? badge(mission) : null))
}

// On: remember the model in use to go back to. Off: go back to it.
async function setAutoModel($: Dollar, isOn: boolean) {
  const next = await update($, prefs, p => {
    if (p.autoModel === isOn) return p
    return isOn ? { ...p, autoModel: true, autoPrevious: p.model } : { ...p, autoModel: false, model: p.autoPrevious, autoPrevious: null }
  })
  await $.store.set(STORE_KEY, next)
  await showAutoStatus($, next)
}

// A model picked by hand wins: Auto Model turns off and stays out of its way.
async function pickModelByHand($: Dollar, family: RackFamily | null) {
  const next = await update($, prefs, p => ({ ...p, model: family, autoModel: false, autoPrevious: null }))
  await $.store.set(STORE_KEY, next)
  await showAutoStatus($, next)
}

// The model line for a prompt: the smallest model sorts it, the words decide if it cannot.
async function pickFamily($: Dollar, text: string, unavailable: readonly RackFamily[]) {
  const reply = await $.model.complete({
    model: 'haiku',
    system: SORT_SYSTEM,
    prompt: text.slice(0, 4000),
    maxTokens: SORT_MAX_TOKENS,
    timeoutMs: SORT_TIMEOUT_MS,
  })
  const level = (reply.isAnswered ? parseLevel(reply.text) : null) ?? guessLevel(text)
  return familyFor(level, unavailable)
}

async function upgradePrompt($: Dollar, text: string) {
  const reply = await $.model.complete({
    model: 'haiku',
    system: UPGRADE_SYSTEM,
    prompt: text,
    maxTokens: 2000,
    timeoutMs: UPGRADE_TIMEOUT_MS,
  })
  return reply.isAnswered ? reply.text.trim() : ''
}

// The panel is drawn in the band above the prompt while panelOpen is set; the write redraws it.
// The same switch as Clean View's own button and /simple.
async function setCleanView($: Dollar, isOn: boolean) {
  await update($, cleanViewEnabled, () => isOn)
  await $.store.set(CLEAN_VIEW_KEY, isOn)
  $.ui.toast(isOn ? 'Clean View is on' : 'Clean View is off: every step is showing again')
}

async function closePanel($: Dollar) {
  await update($, panelOpen, () => false)
}

async function togglePanel($: Dollar) {
  await update($, panelOpen, isOpen => !isOpen)
}

// The Agent Dock's pane, opened from the panel's launcher or its Team size row (a press, so asked).
async function openDock($: Dollar) {
  const opened = await $.ui.open({ id: DOCK_PANE, title: 'Agent Dock', columns: 80 })
  if (!opened.isPlaced) $.ui.toast(DOCK_NARROW)
  await update($, dockFolded, () => false)
  await showAutoStatus($, await read($, prefs))
}

// The Work Report's pane, from the footer chip or the panel's launcher (a press, so asked). The
// report keeps today's date fresh itself when a task finishes or a tab is pressed.
async function openReport($: Dollar) {
  const opened = await $.ui.open({ id: REPORT_PANE, title: 'Work Report', columns: 80 })
  if (!opened.isPlaced) $.ui.toast('The window is too narrow to show the Work Report. Widen it and type /report again.')
}

// YouTube TV's remote, from the footer chip or the panel's launcher (a press, so asked). The TV
// itself comes on from its own POWER button or a channel.
async function openTv($: Dollar) {
  const opened = await $.ui.open({ id: TV_PANE, title: 'YouTube TV', columns: 64 })
  if (!opened.isPlaced) $.ui.toast('The window is too narrow to show YouTube TV. Widen it and type /tv again.')
}

// Windows Notepad, from the panel's launcher: PowerShell starts it and returns at once. From WSL
// powershell.exe is usually on the PATH; if not, its usual place under /mnt/c is tried.
const POWERSHELLS = ['powershell.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']
const NOTEPAD_ARGS = ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process notepad.exe']

async function openNotepad($: Dollar) {
  for (const shell of POWERSHELLS) {
    try {
      const ran = await $.process.run([shell, ...NOTEPAD_ARGS], { timeoutMs: 15_000 })
      if (ran.exitCode === 0) return
    } catch {
      // Try the next.
    }
  }
  $.ui.toast("Notepad didn't open: PowerShell wasn't found, or it couldn't start Notepad.")
}

// The panel's Team size row: up to 20 is set at once; a big team, or Custom, finishes in the dock.
async function pickTeamSize($: Dollar, size: number | 'custom') {
  if (size === 'custom') {
    await update($, dockPending, () => null)
    await update($, dockCustomOpen, () => true)
    await openDock($)
  } else if (isBigTeam(size)) {
    await update($, dockCustomOpen, () => false)
    await update($, dockPending, () => size)
    await openDock($)
  } else {
    await update($, dockSize, () => size)
    await update($, dockPending, () => null)
    await $.store.set(DOCK_SIZE_KEY, size)
  }
}

const spaced = (text: string) => text.split(' ').map(word => word.split('').join(' ')).join('   ')

const rule = (label: string, width: number) => {
  const head = `── ${spaced(label)} `
  return head + '─'.repeat(Math.max(2, width - head.length))
}

// The panel's body: model, effort, settings and launchers, in a bordered box at the band's right edge.
async function drawPanel($: Dollar, e: RenderInput<'AbovePrompt'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isTerminal = e.surface === 'terminal'
  const p = await read($, prefs)
  const isClean = await read($, cleanViewEnabled)
  const s = await read($, seen)
  const upgrade = await read($, lastUpgrade)
  const outer = Math.min(64, e.props.bodyColumns)
  const width = isTerminal ? outer - 4 : outer

  const activeFamily = p.model ?? familyOf(s.model)
  const activeEffort = p.effort ?? s.effort
  const modelLabel = MODELS.find(m => m.family === activeFamily)?.label ?? s.model ?? 'Default'
  const effortLabel = EFFORTS.find(x => x.value === activeEffort)?.label ?? 'Default'
  const helper = HELPER_OPTIONS.find(h => h.value === p.helper) ?? HELPER_OPTIONS[0]!
  const teamSize = await read($, dockSize)
  const isCustomTeam = !SIZES.includes(teamSize as (typeof SIZES)[number])

  const heading = (label: string) =>
    isTerminal ? <Text color={ORANGE}>{rule(label, width)}</Text> : <Text bold color={ORANGE}>{label}</Text>

  const chip = (selected: boolean, label: string, background: string) => (
    <Text {...(selected ? { color: INK, backgroundColor: background } : {})}> {label} </Text>
  )

  const toggleRow = (key: string, label: string, hint: string, isOn: boolean, flip: (p: RackPrefs) => RackPrefs) => (
    <Box flexDirection="row">
      <Text color={isOn ? 'green' : undefined}>{isOn ? '● ' : '○ '}</Text>
      <Box width={16}><Text color="white">{label}</Text></Box>
      <Box flexGrow={1}><Text dimColor>{hint}</Text></Box>
      <Button key={key} plain onPress={() => void setPrefs($, flip)}>
        {isOn ? <Text color={INK} backgroundColor="green"> ● On  </Text> : <Text dimColor>[○ Off]</Text>}
      </Button>
    </Box>
  )

  const body = (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={ORANGE}>{isTerminal ? `◆ ${spaced('RODS RACK')}` : '◆ RODS RACK'}</Text>
        <Text color="gray">{modelLabel} · {effortLabel}</Text>
      </Box>
      <Text> </Text>
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>{'MODEL   '}</Text>
        {MODELS.map(m => (
          <Button
            key={`model-${m.family}`}
            plain
            {...(m.family === activeFamily ? { autoFocus: true as const } : {})}
            onPress={() => void pickModelByHand($, m.family)}
          >
            {chip(m.family === activeFamily, m.label, ORANGE)}
          </Button>
        ))}
      </Box>
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>{'EFFORT  '}</Text>
        {EFFORTS.map(x => (
          <Button key={`effort-${x.value}`} plain onPress={() => void setPrefs($, y => ({ ...y, effort: x.value }))}>
            {chip(x.value === activeEffort, x.label, PURPLE)}
          </Button>
        ))}
      </Box>
      <Text> </Text>
      {heading('SETTINGS')}
      <Box flexDirection="row">
        <Text color={isClean ? 'green' : undefined}>{isClean ? '● ' : '○ '}</Text>
        <Box width={16}><Text color="white">Clean View</Text></Box>
        <Box flexGrow={1}><Text dimColor>simple checklist</Text></Box>
        <Button key="toggle-clean-view" plain onPress={() => void setCleanView($, !isClean)}>
          {isClean ? <Text color={INK} backgroundColor="green"> ● On  </Text> : <Text dimColor>[○ Off]</Text>}
        </Button>
      </Box>
      {toggleRow('toggle-prompt-upgrade', 'Prompt Upgrade', 'better prompts', p.promptUpgrade, x => ({ ...x, promptUpgrade: !x.promptUpgrade }))}
      <Box flexDirection="row">
        <Text color={p.helper !== 'same' ? 'green' : undefined}>{p.helper !== 'same' ? '● ' : '○ '}</Text>
        <Box width={16}><Text color="white">Helper agents</Text></Box>
        <Box flexGrow={1}><Text dimColor>model they use</Text></Box>
        <Button
          key="helper-cycle"
          plain
          onPress={() =>
            void setPrefs($, x => {
              const at = HELPER_OPTIONS.findIndex(h => h.value === x.helper)
              return { ...x, helper: HELPER_OPTIONS[(at + 1) % HELPER_OPTIONS.length]!.value }
            })
          }
        >
          <Text>[{helper.label} ▸]</Text>
        </Button>
      </Box>
      <Box flexDirection="row" flexWrap="wrap">
        <Text color={teamSize > 1 ? 'green' : undefined}>{teamSize > 1 ? '● ' : '○ '}</Text>
        <Box width={16}><Text color="white">Team size</Text></Box>
        {SIZES.map(n => (
          <Button key={`team-${n}`} plain onPress={() => void pickTeamSize($, n)}>
            {n === teamSize ? <Text color={INK} backgroundColor={ORANGE}> {n} </Text> : <Text> {n} </Text>}
          </Button>
        ))}
        <Button key="team-custom" plain onPress={() => void pickTeamSize($, 'custom')}>
          {isCustomTeam ? <Text color={INK} backgroundColor={ORANGE}> {teamSize} </Text> : <Text dimColor> Custom </Text>}
        </Button>
      </Box>
      <Box flexDirection="row">
        <Text color={p.autoModel ? 'green' : undefined}>{p.autoModel ? '● ' : '○ '}</Text>
        <Box width={16}><Text color="white">Auto Model</Text></Box>
        <Box flexGrow={1}><Text dimColor>model per prompt</Text></Box>
        <Button key="toggle-auto-model" plain onPress={() => void setAutoModel($, !p.autoModel)}>
          {p.autoModel ? <Text color={INK} backgroundColor="green"> ● On  </Text> : <Text dimColor>[○ Off]</Text>}
        </Button>
      </Box>
      {upgrade !== null && (
        <Button key="view-original" plain dimColor onPress={() => $.ui.log(`Original prompt:\n${upgrade.original}`)}>
          Last prompt was upgraded. View the original
        </Button>
      )}
      <Text> </Text>
      {heading('LAUNCH')}
      <Box flexDirection="row" flexWrap="wrap" columnGap={4}>
        <Button
          key="launch-create"
          plain
          onPress={async () => {
            await closePanel($)
            await $.prompt.submit({ text: CREATE_PROMPT })
          }}
        >
          ✦ Create photo or video
        </Button>
        <Button key="launch-dock" plain onPress={() => void openDock($)}>
          ◆ Agent Dock
        </Button>
        <Button key="launch-report" plain onPress={() => void openReport($)}>
          ▤ Work Report
        </Button>
        <Button key="launch-tv" plain onPress={() => void openTv($)}>
          ▣ YouTube TV
        </Button>
        <Button key="launch-notepad" plain onPress={() => void openNotepad($)}>
          ⌸ Open Notepad
        </Button>
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="row" justifyContent="flex-end" width={e.props.bodyColumns}>
      {isTerminal ? (
        <Box borderStyle="round" borderColor={ORANGE} paddingX={1} width={outer}>{body}</Box>
      ) : (
        body
      )}
    </Box>
  )
}

export const register: Register = on => {
  // The dock first, so its hooks sit above Clean View's.
  registerDock(on)
  registerReport(on)
  registerTv(on)
  registerCleanView(on)

  on('session.start', async ($, e, next) => {
    await hydrate($)
    await update($, panelOpen, () => false)
    try {
      await $.command.register({ name: 'tools', description: 'Toggle the Rods Rack control panel', immediate: true })
    } catch {
      // A built-in already owns /tools on this build; /rods-rack still works.
    }
    await $.command.register({ name: 'rods-rack', description: 'Toggle the Rods Rack control panel', immediate: true })
    await $.command.register({
      name: 'automodel',
      description: 'Auto Model: pick the model for each new prompt (on | off | status)',
      argumentHint: 'on|off|status',
      immediate: true,
    })
    await showAutoStatus($, await read($, prefs))

    return next(e)
  })

  // /clear, /resume and /branch start over without a session.start; this one fires for each.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      await hydrate($)
    } catch {
      // Keep the live values.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'tools' }, async $ => {
    await togglePanel($)
    return { text: '' }
  }).catch(() => ({ text: 'The Rods Rack panel could not open just now. Try again.' }))

  on('command.run', { command: 'rods-rack' }, async $ => {
    await togglePanel($)
    return { text: '' }
  }).catch(() => ({ text: 'The Rods Rack panel could not open just now. Try again.' }))

  on('command.run', { command: 'automodel' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await setAutoModel($, arg === 'on')
      return { text: arg === 'on' ? 'Auto Model is on.' : 'Auto Model is off.' }
    }
    if (arg === 'status' || arg === '') {
      const p = await read($, prefs)
      if (!p.autoModel) return { text: 'Auto Model is off.' }
      return { text: `Auto Model is on. The current pick is ${p.model === null ? 'not made yet' : labelOf(p.model)}.` }
    }
    return { text: 'Use /automodel on, /automodel off or /automodel status.' }
  }).catch(() => ({ text: 'Auto Model could not be changed just now. Try /automodel again.' }))

  // /model or the model picker is a pick by hand: Auto Model turns off, and the panel's own model
  // choice is cleared so the session's new model is the one used.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if ((e.source === 'command' || e.source === 'picker') && (await read($, prefs)).autoModel) {
      await pickModelByHand($, null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A model this plan cannot use: Auto Model steps down past it from the next prompt on.
  on('classic.StopFailure', { error: 'model_not_found' }, async ($, e, next) => {
    const p = await read($, prefs)
    const refused = p.model
    if (p.autoModel && refused !== null && !p.autoUnavailable.includes(refused)) {
      await setPrefs($, x => ({ ...x, autoUnavailable: [...x.autoUnavailable, refused] }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The chips at the right end of the prompt footer, beside any mode labels: Auto Model's switch,
  // the Work Report, YouTube TV, then the panel's.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isAuto = (await read($, prefs)).autoModel
    const isTvPlaying = isPlaying(await read($, tv))

    return (
      <Box flexDirection="row" gap={1}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="auto-chip" plain onPress={() => void setAutoModel($, !isAuto)}>
          {isAuto ? (
            <Text bold color={INK} backgroundColor={GOLD}> Auto Model: On </Text>
          ) : (
            <Text color={LIGHT} backgroundColor={SLATE}> Auto Model: Off </Text>
          )}
        </Button>
        <Button key="report-chip" plain onPress={() => void openReport($)}>
          <Text color={LIGHT} backgroundColor={SLATE}> ◆ Report </Text>
        </Button>
        <Button key="tv-chip" plain onPress={() => void openTv($)}>
          <Text color={LIGHT} backgroundColor={SLATE}>{isTvPlaying ? ' ▣ TV ▶ ' : ' ▣ TV '}</Text>
        </Button>
        <Button key="rack-chip" plain onPress={() => void togglePanel($)}>
          <Text color={INK} backgroundColor={ORANGE}> ◆ Rods Rack ▾ </Text>
        </Button>
      </Box>
    )
  })

  // The panel: a bordered box at the right of the band above the prompt, below whatever else draws
  // there (Clean View's checklist). The engine draws its [–] collapse mark outside it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, panelOpen))) return next(e)
    const above = await next(e)
    const panel = await drawPanel($, e)
    const { Box } = $.ui.resolve(e)
    // The wrapper carries no size: the engine refuses its own node under a Box with a width.
    return (
      <Box flexDirection="column">
        {above}
        {panel}
      </Box>
    )
  })

  // Model and effort: no session setter exists, so each main-loop request is rewritten.
  on('turn.step', async function* ($, e, next) {
    // Helper agents keep their own model; only the main conversation's requests are rewritten.
    if (e.agentId !== undefined) return yield* next(e)

    const s = await read($, seen)
    const effort = e.effort === undefined ? null : String(e.effort)
    if (s.model !== e.model || s.effort !== effort) {
      await update($, seen, () => ({ model: e.model, effort }))
    }

    const p = await read($, prefs)
    const model = MODELS.find(m => m.family === p.model)?.id
    const request = {
      ...e,
      ...(model !== undefined ? { model } : {}),
      ...(p.effort !== null && e.effort !== undefined ? { effort: p.effort } : {}),
    }
    return yield* next(request)
  })

  // Before the person's own prompt is sent: Prompt Upgrade rewrites it and Auto Model picks its
  // model, both on the smallest model and at the same time, so neither waits on the other.
  on('prompt.submit', async ($, e, next) => {
    const p = await read($, prefs)
    const text = e.text.trim()
    const isTyped = e.origin.kind === 'composer' && text !== '' && !text.startsWith('/')
    const wantsUpgrade = isTyped && p.promptUpgrade && (e.attachments?.length ?? 0) === 0
    // Never sorted: a short reply, or a message sent while Claude is working; the model stays.
    const wantsPick = isTyped && p.autoModel && !isShortReply(text) && !(await read($, isWorking))
    if (!wantsUpgrade && !wantsPick) return next(e)

    const [upgraded, family] = await Promise.all([
      wantsUpgrade ? upgradePrompt($, e.text) : Promise.resolve(''),
      wantsPick ? pickFamily($, e.text, p.autoUnavailable) : Promise.resolve(null),
    ])

    if (family !== null) {
      const picked = await update($, prefs, x => (x.autoModel ? { ...x, model: family } : x))
      await $.store.set(STORE_KEY, picked)
      await showAutoStatus($, picked)
    }
    if (upgraded === '') return next(e)

    await update($, lastUpgrade, () => ({ original: e.text, upgraded }))
    $.ui.toast('Prompt upgraded')
    return next({ ...e, text: upgraded })
  }).catch(($, e, next) => next(e))

}
