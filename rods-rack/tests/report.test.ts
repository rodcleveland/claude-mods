import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { addDays, classify, dayOfYear, emptyDay, isTypedPrompt, recordTask, signalsOf, streak, sumDays, writesOutsideTmp } from '../hooks/report-logic'

const TODAY = '2026-10-12'
const PANE = {
  plugin: 'rods-rack',
  component: 'Pane',
  requestId: 'rods-rack-report',
  props: { title: 'Work Report', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The test stands for the engine beneath the plugin: a store and clock in memory, today's date from
// `date`, an optional history file, and every tool and prompt answered as given.
function engine(on: On, store: Record<string, unknown> = {}, historyFile: string | null = null) {
  mock.clock(on, { now: Date.UTC(2026, 9, 12, 16) })
  mock.store(on, store)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__rods-rack__${e.name}` } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${TODAY}\n`, stderr: '' } }) as never)
  on('fs.read', () => {
    if (historyFile === null) throw new Error('no such file')
    return { value: historyFile } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }) as never)
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const answered = (turnId: string) =>
  ({ answer: 'Done.', durationMs: 1000, isAborted: false, turnId, reason: 'answer', usage: { ...USAGE, model: 'claude-opus-5-5' } }) as never
const drawn = async (mounted: { drawn: () => Promise<unknown> }) => JSON.stringify(await mounted.drawn())

// One finished typed task that used `tool`.
async function task($: Engine, prompt: string, tool: Record<string, unknown> | null, turnId: string) {
  await $.prompt.submit(typed(prompt))
  if (tool !== null) await $.tool.call(tool as never)
  await $.turn.complete(answered(turnId))
}

test('a task is sorted by the tools it used', async () => {
  expect(classify(signalsOf('mcp__claude_ai_Gmail__send_message', {}))).toBe('emails')
  expect(classify(signalsOf('mcp__claude_ai_OpenArt__openart_generate_image', {}))).toBe('media')
  expect(classify(signalsOf('Write', { file_path: '/out/poster.png' }))).toBe('media')
  expect(classify(signalsOf('Write', { file_path: '/out/proposal.docx' }))).toBe('documents')
  expect(classify(signalsOf('WebSearch', { query: 'bakeries' }))).toBe('research')
  // Coding: a code file written, or a build, test or git command.
  expect(classify(signalsOf('Edit', { file_path: '/src/app.ts' }))).toBe('coding')
  expect(classify(signalsOf('Bash', { command: 'npm test' }))).toBe('coding')
  expect(classify(signalsOf('Bash', { command: 'git commit -F msg.txt' }))).toBe('coding')
  // Looking up docs while coding is still coding.
  expect(classify([...signalsOf('WebFetch', { url: 'https://docs.example.com' }), ...signalsOf('Edit', { file_path: '/src/app.ts' })])).toBe('coding')
  // Answering a question with no tools, or only reading, is Other.
  expect(classify([])).toBe('other')
  expect(classify(signalsOf('Bash', { command: 'ls -la' }))).toBe('other')
  // A screenshot read while debugging is not image work.
  expect(classify(signalsOf('Read', { file_path: '/tmp/screenshot.png' }))).toBe('other')
  // Mail outranks research when a task did both.
  expect(classify([...signalsOf('WebSearch', {}), ...signalsOf('mcp__outlook-desktop__send_email', {})])).toBe('emails')
})

test('only prompts you typed count', async () => {
  expect(isTypedPrompt('Write an email to my landlord', 'composer')).toBe(true)
  expect(isTypedPrompt('/compact', 'composer')).toBe(false)
  expect(isTypedPrompt('<task-notification>done</task-notification>', 'composer')).toBe(false)
  expect(isTypedPrompt('You used 3 of 10 helpers.', 'plugin')).toBe(false)
  expect(isTypedPrompt('   ', 'composer')).toBe(false)
})

test('typed requests that finish count once; cancelled, plugin and mid-turn ones do not', async ($, on) => {
  engine(on)
  await start($)

  await task($, 'Research bakery pricing in Jacksonville', { tool: 'WebSearch', query: 'bakery prices' }, 't1')
  // Cancelled.
  await $.prompt.submit(typed('Draft a long report on everything'))
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't2', reason: 'aborted' } as never)
  // A plugin's prompt.
  await $.prompt.submit({ text: 'You used 0 of 5 helpers.', wait: false, origin: { kind: 'plugin', name: 'rods-rack' } } as never)
  await $.turn.complete(answered('t3'))
  // A message typed while a turn runs is folded into that turn.
  await $.turn.start({ text: 'Fix the login bug', turnId: 't4' })
  await $.prompt.submit(typed('Also check the signup page'))
  await $.turn.complete(answered('t4'))

  const text = await drawn(await $.ui.mount({ ...PANE, surface: 'terminal' }))
  expect(text).toContain('finished tasks')
  // One task, the research one: its row counts 1, and no row counts 2.
  expect(text).toContain('Research')
  expect(text).toContain('Opus 5.5')
  expect(text).toContain('"      1"')
  expect(text).not.toContain('"      2"')
})

test('the streak counts days in a row, from yesterday while today is still empty', async () => {
  const active = new Set(['2026-10-12', '2026-10-11', '2026-10-10', '2026-10-08'])
  expect(streak(k => active.has(k), '2026-10-12')).toBe(3)
  expect(streak(k => active.has(k) && k !== '2026-10-12', '2026-10-12')).toBe(2)
  expect(streak(() => false, '2026-10-12')).toBe(0)
})

test('days add together and step across clock changes and years', async () => {
  const day = recordTask(recordTask(emptyDay(), 'emails', 'claude-opus-5-5'), 'research', 'claude-haiku-5-5')
  const total = sumDays([day, day, undefined])
  expect(total.kinds.emails).toBe(2)
  expect(total.kinds.research).toBe(2)
  expect(total.models['claude-opus-5-5']).toBe(2)
  // US clocks change on November 1, 2026; the date still steps one day at a time.
  expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
  expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
  expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
})

test('the day of the year', async () => {
  expect(dayOfYear('2026-01-01')).toBe(1)
  expect(dayOfYear('2026-10-12')).toBe(285)
  expect(dayOfYear('2024-12-31')).toBe(366)
})

for (const [tab, title, chart] of [
  ['today', "TODAY'S WORK", 'L A S T   7   D A Y S'],
  ['week', 'LAST 7 DAYS', 'L A S T   7   D A Y S'],
  ['month', 'LAST 30 DAYS', 'D A Y   B Y   D A Y'],
  ['year', 'THIS YEAR', 'M O N T H   B Y   M O N T H'],
] as const) {
  test(`the ${tab} tab draws its own title and chart`, async ($, on) => {
    engine(on)
    await start($)
    await task($, 'Write an email to my landlord about the leak', { tool: 'mcp__claude_ai_Gmail__send_message' }, 't1')

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    if (tab !== 'today') await pane.press({ key: `tab-${tab}` })
    await pane.redraw(PANE.props)
    const text = await drawn(pane)
    expect(text).toContain(title)
    expect(text).toContain(chart)
    if (tab === 'year') {
      expect(text).toContain('Oct')
      expect(text).toContain('Best month: Oct')
    }
    if (tab === 'month') expect(text).toContain('active days')
    if (tab === 'week') expect(text).toContain('day streak')
  })
}

test('the empty state', async ($, on) => {
  engine(on)
  await start($)
  const text = await drawn(await $.ui.mount({ ...PANE, surface: 'terminal' }))
  expect(text).toContain('Nothing finished yet today. Your first finished task shows up here.')
  expect(text).not.toContain('HOURS SAVED')
})

test('a narrow pane stacks the tiles one to a row and nothing outgrows it', async ($, on) => {
  engine(on)
  await start($)
  await task($, 'Research bakery pricing in Jacksonville', { tool: 'WebSearch', query: 'bakery prices' }, 't1')

  const narrow = { ...PANE.props, bodyColumns: 36 }
  const pane = await $.ui.mount({ ...PANE, props: narrow, surface: 'terminal' })
  const tree = (await pane.drawn()) as { children?: unknown[] }
  const text = JSON.stringify(tree)
  // One tile a row: each tile is as wide as the pane.
  expect(text).toContain('"width":36')
  expect(text.match(/"borderStyle":"round"/g)?.length).toBe(3)
  // Every width in the drawing fits inside the pane.
  const widths = [...text.matchAll(/"width":(\d+)/g)].map(m => Number(m[1]))
  expect(Math.max(...widths)).toBeLessThanOrEqual(36)
})

test('the history estimate fills the days before today', async ($, on) => {
  const history = JSON.stringify({
    cutoffDay: TODAY,
    days: { '2026-10-11': { kinds: { emails: 0, documents: 0, media: 0, research: 4, other: 2 }, models: { 'claude-opus-5-5': 6 } } },
  })
  engine(on, {}, history)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'tab-week' })
  await pane.redraw(PANE.props)
  const text = await drawn(pane)
  expect(text).toContain('Research')
  expect(text).toContain('Sun')
  expect(text).not.toContain('Nothing finished')
})

test('/report settings lists the estimate and changes it', async ($, on) => {
  engine(on)
  await start($)
  expect((await $.command.run({ command: 'report', args: 'settings' } as never)).text).toContain('Hourly rate: $50')
  expect((await $.command.run({ command: 'report', args: 'settings rate 75' } as never)).text).toContain('Hourly rate: $75')
  expect((await $.command.run({ command: 'report', args: 'settings emails 15' } as never)).text).toContain('Emails: 15 minutes')
  expect((await $.command.run({ command: 'report', args: 'settings' } as never)).text).toContain('Coding: 20 minutes')
  expect((await $.command.run({ command: 'report', args: 'settings coding 45' } as never)).text).toContain('Coding: 45 minutes')
  expect((await $.command.run({ command: 'report', args: 'settings rate lots' } as never)).text).toContain('Give a number')
})

test('a coding request is recorded under Coding with its own minutes', async ($, on) => {
  engine(on)
  await start($)
  await task($, 'Fix the login bug in the signup form', { tool: 'Edit', file_path: '/src/login.ts', old_string: 'a', new_string: 'b' }, 't1')
  await $.command.run({ command: 'report', args: 'settings coding 30' } as never)

  const text = await drawn(await $.ui.mount({ ...PANE, surface: 'terminal' }))
  expect(text).toContain('Coding')
  // One coding task at 30 minutes is half an hour, on the Coding row.
  const row = text.slice(text.indexOf('"Coding'), text.indexOf('"Other'))
  expect(row).toContain('"      1"')
  expect(row).toContain('0.5 h')
})

// The same commands, and answers, the history script's writes_outside_tmp() is checked against.
const SHELL_CASES: ReadonlyArray<[string, boolean]> = [
  ["cd /home/u/proj && sed -i 's/a/b/' src/app.ts", true],
  ["cat > /tmp/x.txt <<'EOF'\nhello > /home/u/nope.txt\nEOF", false],
  ["D=/tmp/claude-1/x; mkdir -p $D && cat > $D/notes.md <<'EOF'\nbody\nEOF", false],
  ["python3 - <<'EOF'\np='hooks/report.tsx'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF", true],
  ["cd /tmp/claude-1/scratch && python3 - <<'EOF'\nopen('out.json','w').write('{}')\nEOF", false],
  ['rg -n foo src 2>/dev/null | head -5', false],
  ['cp /tmp/a.png /mnt/c/Users/me/Downloads/a.png', true],
  ['mkdir -p /tmp/claude-1/scratch', false],
  ['curl -s https://example.com/a > /tmp/a.html', false],
  ['ls -la > /dev/null', false],
  ['echo hi >> notes.md', true],
  ['cd /home/u/proj && git status && cat README.md', false],
  ['python3 rods-rack/scripts/report-history.py', false],
]

test('shell edits and scripts that write outside /tmp count as Coding', async () => {
  for (const [command, expected] of SHELL_CASES) expect([command, writesOutsideTmp(command)]).toEqual([command, expected])
  expect(classify(signalsOf('Bash', { command: "cd /home/u/proj && sed -i 's/a/b/' src/app.ts" }))).toBe('coding')
  expect(classify(signalsOf('Bash', { command: 'mkdir -p /tmp/claude-1/scratch' }))).toBe('other')
})

test('curl with flags is research, generate is images and video, the browser is research', async () => {
  expect(classify(signalsOf('Bash', { command: 'curl -sL https://example.com/page' }))).toBe('research')
  expect(classify(signalsOf('Skill', { skill: 'generate' }))).toBe('media')
  expect(classify(signalsOf('mcp__claude-in-chrome__get_page_text', {}))).toBe('research')
  // A browser tool whose name says gif or image is still browsing, not image work.
  expect(classify(signalsOf('mcp__claude-in-chrome__gif_creator', {}))).toBe('research')
  // Coordination tools and plain answers stay in Other.
  expect(classify(signalsOf('AskUserQuestion', {}))).toBe('other')
})

test('artifacts are their own kind, ranked above coding and below documents', async () => {
  expect(classify(signalsOf('Artifact', { file_path: '/tmp/page.html' }))).toBe('artifacts')
  expect(classify(signalsOf('ArtifactData', {}))).toBe('artifacts')
  // A coding session that publishes its page counts as Artifacts.
  expect(classify([...signalsOf('Edit', { file_path: '/src/board.tsx' }), ...signalsOf('Artifact', {})])).toBe('artifacts')
  // A document written alongside still counts as Documents.
  expect(classify([...signalsOf('Artifact', {}), ...signalsOf('Write', { file_path: '/out/brief.docx' })])).toBe('documents')
})

test('/report settings has its own Artifacts minutes', async ($, on) => {
  engine(on)
  await start($)
  expect((await $.command.run({ command: 'report', args: 'settings' } as never)).text).toContain('Artifacts: 30 minutes')
  expect((await $.command.run({ command: 'report', args: 'settings artifacts 45' } as never)).text).toContain('Artifacts: 45 minutes')
})
