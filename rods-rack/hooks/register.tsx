import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  RackAgent,
  RackEffort,
  RackFamily,
  RackHelper,
  RackPrefs,
  RackSeen,
  RackUpgrade,
} from '../types'

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

const PANEL = 'rods-rack'
const DOCK = 'rods-rack-dock'
const STORE_KEY = 'prefs'
const UPGRADE_TIMEOUT_MS = 5000

const ORANGE = '#E8743B'
const PURPLE = '#B07AA1'
const INK = '#1a1a1a'

// No model list is exposed to plugins on this build, so the panel's models are fixed here.
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
const HELPERS: ReadonlyArray<{ value: RackHelper; label: string; alias: 'haiku' | 'sonnet' | null }> = [
  { value: 'fast', label: 'Fast & Cheap', alias: 'haiku' },
  { value: 'balanced', label: 'Balanced', alias: 'sonnet' },
  { value: 'same', label: 'Same as main', alias: null },
]

const DEFAULT_PREFS: RackPrefs = {
  model: null,
  effort: null,
  cleanView: false,
  promptUpgrade: false,
  helper: 'same',
}

const prefs = atom({ plugin: 'rods-rack', key: 'prefs' } as const, DEFAULT_PREFS)
const panelOpen = atom({ plugin: 'rods-rack', key: 'panelOpen' } as const, false)
const seen = atom({ plugin: 'rods-rack', key: 'seen' } as const, { model: null, effort: null } as RackSeen)
const agents = atom({ plugin: 'rods-rack', key: 'agents' } as const, {} as Record<string, RackAgent>)
const lastUpgrade = atom({ plugin: 'rods-rack', key: 'lastUpgrade' } as const, null as RackUpgrade | null)
const dockTick = atom({ plugin: 'rods-rack', key: 'dockTick' } as const, 0)

type Dollar = EngineInterface

const familyOf = (model: string | null): RackFamily | null =>
  MODELS.find(m => model !== null && model.includes(m.family))?.family ?? null

const isPrefs = (value: unknown): value is Partial<RackPrefs> =>
  typeof value === 'object' && value !== null

async function hydrate($: Dollar) {
  const saved = await $.store.get(STORE_KEY)
  if (isPrefs(saved)) {
    await update($, prefs, () => ({ ...DEFAULT_PREFS, ...saved }))
  }
  $.ui.invalidate('ui.render')
}

async function setPrefs($: Dollar, change: (p: RackPrefs) => RackPrefs) {
  const next = await update($, prefs, change)
  await $.store.set(STORE_KEY, next)
}

async function openPanel($: Dollar) {
  await update($, panelOpen, () => true)
  await $.ui.open({ id: PANEL, title: 'Rods Rack', focus: true, closeOnEscape: true, rows: 16, columns: 62 })
}

async function closePanel($: Dollar) {
  await update($, panelOpen, () => false)
  await $.ui.close({ id: PANEL })
}

async function togglePanel($: Dollar) {
  if (await read($, panelOpen)) {
    await closePanel($)
  } else {
    await openPanel($)
  }
}

let dockTimer: { cancel: () => void } | null = null

async function openDock($: Dollar) {
  await $.ui.open({ id: DOCK, title: 'Agent Dock' })
  if (dockTimer === null) {
    dockTimer = $.clock.every(2000, () => void update($, dockTick, n => n + 1))
  }
}

const spaced = (text: string) => text.split(' ').map(word => word.split('').join(' ')).join('   ')

const rule = (label: string, width: number) => {
  const head = `── ${spaced(label)} `
  return head + '─'.repeat(Math.max(2, width - head.length))
}

function describeCall(tool: string, input: unknown): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const pick = (...names: string[]) => {
    for (const name of names) {
      const value = args[name]
      if (typeof value === 'string' && value !== '') return value
    }
    return ''
  }
  const verbs: Record<string, [string, string[]]> = {
    Bash: ['Ran', ['description', 'command']],
    Read: ['Read', ['file_path']],
    Edit: ['Edited', ['file_path']],
    Write: ['Wrote', ['file_path']],
    NotebookEdit: ['Edited', ['notebook_path']],
    Grep: ['Searched', ['pattern']],
    Glob: ['Listed', ['pattern']],
    WebFetch: ['Fetched', ['url']],
    WebSearch: ['Searched the web for', ['query']],
    Agent: ['Delegated', ['description']],
    Skill: ['Used skill', ['skill']],
  }
  const [verb, fields] = verbs[tool] ?? [tool, ['description', 'file_path', 'path', 'query', 'url', 'command']]
  const target = pick(...fields).split('\n')[0] ?? ''
  return target === '' ? verb : `${verb} ${target.length > 80 ? target.slice(0, 79) + '…' : target}`
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await hydrate($)
    await update($, panelOpen, () => false)
    try {
      await $.command.register({ name: 'tools', description: 'Toggle the Rods Rack control panel', immediate: true })
    } catch {
      // A built-in already owns /tools on this build; /rack still works.
    }
    await $.command.register({ name: 'rack', description: 'Toggle the Rods Rack control panel', immediate: true })

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
  })

  on('command.run', { command: 'rack' }, async $ => {
    await togglePanel($)
    return { text: '' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANEL) {
      await update($, panelOpen, () => false)
    }
    if (e.id === DOCK && dockTimer !== null) {
      dockTimer.cancel()
      dockTimer = null
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The chip at the right end of the prompt footer, beside any mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="rack-chip" plain onPress={() => void togglePanel($)}>
          <Text color={INK} backgroundColor={ORANGE}> ◆ Rods Rack ▾ </Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const p = await read($, prefs)
    const s = await read($, seen)
    const upgrade = await read($, lastUpgrade)
    const width = Math.min(60, e.props.bodyColumns)

    const activeFamily = p.model ?? familyOf(s.model)
    const activeEffort = p.effort ?? s.effort
    const modelLabel = MODELS.find(m => m.family === activeFamily)?.label ?? s.model ?? 'Default'
    const effortLabel = EFFORTS.find(x => x.value === activeEffort)?.label ?? 'Default'
    const helper = HELPERS.find(h => h.value === p.helper) ?? HELPERS[0]!

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
          <Box flexDirection="row" gap={1}>
            <Text color="gray">{modelLabel} · {effortLabel}</Text>
            <Button key="collapse" plain dimColor onPress={() => void closePanel($)}>[–]</Button>
          </Box>
        </Box>
        <Text> </Text>
        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor>{'MODEL   '}</Text>
          {MODELS.map(m => (
            <Button
              key={`model-${m.family}`}
              plain
              {...(m.family === activeFamily ? { autoFocus: true as const } : {})}
              onPress={() => void setPrefs($, x => ({ ...x, model: m.family }))}
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
        {toggleRow('toggle-clean-view', 'Clean View', 'simple checklist', p.cleanView, x => ({ ...x, cleanView: !x.cleanView }))}
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
                const at = HELPERS.findIndex(h => h.value === x.helper)
                return { ...x, helper: HELPERS[(at + 1) % HELPERS.length]!.value }
              })
            }
          >
            <Text>[{helper.label} ▸]</Text>
          </Button>
        </Box>
        {upgrade !== null && (
          <Button key="view-original" plain dimColor onPress={() => $.ui.log(`Original prompt:\n${upgrade.original}`)}>
            Last prompt was upgraded. View the original
          </Button>
        )}
        <Text> </Text>
        {heading('LAUNCH')}
        <Box flexDirection="row" gap={4}>
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
        </Box>
      </Box>
    )

    return isTerminal && e.props.placement === 'dock' ? (
      <Box borderStyle="round" borderColor={ORANGE} paddingX={1}>{body}</Box>
    ) : (
      body
    )
  })

  on('ui.render', { component: 'Pane', requestId: DOCK }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, dockTick)
    const tracked = await read($, agents)
    const list = await $.agent.list()
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        <Text bold color={ORANGE}>◆ Agent Dock</Text>
        {list.length === 0 && <Text dimColor>No subagents in this session yet.</Text>}
        {list.map(agent => {
          const info = tracked[agent.id]
          const isLive = agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting'
          return (
            <Box flexDirection="row" gap={2}>
              <Text color={isLive ? 'green' : 'gray'}>{agent.status.padEnd(9)}</Text>
              <Box flexGrow={1}><Text wrap="truncate-end">{agent.description || agent.type}</Text></Box>
              <Text dimColor>{info ? (familyOf(info.model) ?? info.model) : '—'}</Text>
              <Text dimColor>{info && isLive ? elapsed(now - info.startedAt) : '—'}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // Model and effort: no session setter exists, so each main-loop request is rewritten.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const known = await read($, agents)
      if (known[e.agentId] === undefined) {
        const startedAt = await $.clock.now()
        const id = e.agentId
        await update($, agents, all => ({ ...all, [id]: { model: e.model, startedAt } }))
      }
      return yield* next(e)
    }

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

  // Clean View: one line per tool call, its result block hidden.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, prefs)).cleanView) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { isRunning, isErrored, isInterrupted, tool, input } = e.props
    const mark = isRunning ? '…' : isErrored || isInterrupted ? '✗' : '✓'
    const color = isRunning ? 'gray' : isErrored || isInterrupted ? 'error' : 'success'

    return (
      <Box flexDirection="row">
        <Text color={color}>{mark} </Text>
        <Text wrap="truncate-end">{describeCall(tool, input)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, prefs)).cleanView) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!(await read($, prefs)).cleanView) return next(e)
    return next({ ...e, props: { ...e.props, tail: 'Clean View —' } })
  })

  // Prompt Upgrade: rewrite the person's own prompt on the cheapest model, or send it as typed.
  on('prompt.submit', async ($, e, next) => {
    const p = await read($, prefs)
    const isOwnPrompt = e.origin.kind === 'composer'
    if (!p.promptUpgrade || !isOwnPrompt || e.text.trim() === '' || e.text.startsWith('/') || (e.attachments?.length ?? 0) > 0) {
      return next(e)
    }

    const reply = await $.model.complete({
      model: 'haiku',
      system: UPGRADE_SYSTEM,
      prompt: e.text,
      maxTokens: 2000,
      timeoutMs: UPGRADE_TIMEOUT_MS,
    })
    const upgraded = reply.isAnswered ? reply.text.trim() : ''
    if (upgraded === '') return next(e)

    await update($, lastUpgrade, () => ({ original: e.text, upgraded }))
    $.ui.toast('Prompt upgraded')
    return next({ ...e, text: upgraded })
  }).catch(($, e, next) => next(e))

  // Helper agents: point the Agent tool at the chosen model.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const p = await read($, prefs)
    const alias = HELPERS.find(h => h.value === p.helper)?.alias ?? null
    if (alias === null || e.subagent_type === 'fork') return next(e)
    return next({ ...e, model: alias })
  }).catch(($, e, next) => next(e))
}
