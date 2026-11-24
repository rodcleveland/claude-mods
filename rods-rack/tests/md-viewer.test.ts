import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { addFile, clip, filesFor, isOffered, MAX_CHARS, NO, question, YES } from '../hooks/md-viewer-logic'

const PANE = {
  plugin: 'rods-rack',
  component: 'Pane',
  requestId: 'md-viewer',
  props: { title: 'notes.md', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const ANSWERED = { answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

// The test stands for the engine beneath the plugin: a store and files in memory, the panes it
// opens, every question asked and the label `pick` chooses for it, and every Write let through.
function engine(on: On, files: Record<string, string>, pick: string | null, store: Record<string, unknown> = {}) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on, store)
  mock.env(on, {})
  const opened: string[] = []
  const asked: Array<{ question: string; options: string[] }> = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__rods-rack__${e.name}` } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }) as never)
  on('fs.exists', ($, e) => ({ value: e.path in files }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e as unknown as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions[0]!
    asked.push({ question: q.question, options: q.options.map(o => o.label) })
    if (pick === null) return { deny: 'dismissed' } as never
    return { result: { questions: [q], answers: { [q.question]: pick } } } as never
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const w = e as unknown as { file_path: string; content: string }
    files[w.file_path] = w.content
    return { result: { type: 'create', filePath: w.file_path, content: w.content, structuredPatch: [], originalFile: null } } as never
  })
  return { opened, asked }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const write = (file_path: string, content = '# Notes\n\nHello.') => ({ tool: 'Write', file_path, content }) as never
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('only Markdown files outside Claude’s own bookkeeping are offered', () => {
  expect(isOffered('/work/README.md')).toBe(true)
  expect(isOffered('/work/guide.MARKDOWN')).toBe(true)
  expect(isOffered('/work/index.ts')).toBe(false)
  expect(isOffered('/home/me/.claude/projects/x/memory/note.md')).toBe(false)
  expect(addFile(addFile(['/a.md'], '/b.md'), '/a.md')).toEqual(['/a.md', '/b.md'])
  // A plan the Plan Pane mod shows is not offered; other Markdown still is.
  expect(isOffered('/work/plans/plan.md', ['/work/plans/plan.md'])).toBe(false)
  expect(isOffered('/work/README.md', ['/work/plans/plan.md'])).toBe(true)
})

test('one file is a yes or no; several are offered by name', () => {
  expect(question(['/work/notes.md'])).toEqual({ text: 'Claude wrote notes.md. Open it in the Markdown viewer?', options: [YES, NO] })
  expect(filesFor(['/work/notes.md'], YES)).toEqual(['/work/notes.md'])
  expect(filesFor(['/work/notes.md'], NO)).toEqual([])

  const many = ['/w/a.md', '/w/b.md', '/w/c.md', '/w/d.md']
  expect(question(many).options).toEqual(['a.md', 'b.md', 'c.md', NO])
  expect(filesFor(many, 'b.md')).toEqual(['/w/b.md', '/w/a.md', '/w/c.md', '/w/d.md'])
  expect(filesFor(many, NO)).toEqual([])
})

test('a very long file is cut with a note', () => {
  expect(clip('short')).toBe('short')
  expect(clip('x'.repeat(MAX_CHARS + 10))).toContain('The rest is cut')
})

test('a Markdown file Claude writes is offered when the turn ends, and yes opens the viewer', async ($, on) => {
  const { opened, asked } = engine(on, {}, YES)
  await start($)
  await $.tool.call(write('/work/notes.md'))
  await $.tool.call(write('/work/app.ts', 'x'))
  expect(asked).toEqual([])

  await $.turn.complete(ANSWERED)
  await settle()
  expect(asked).toEqual([{ question: 'Claude wrote notes.md. Open it in the Markdown viewer?', options: [YES, NO] }])
  expect(opened).toEqual(['md-viewer'])

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(JSON.stringify(await pane.drawn())).toContain('Hello.')
})

test('no opens nothing, and the next turn asks nothing', async ($, on) => {
  const { opened, asked } = engine(on, {}, NO)
  await start($)
  await $.tool.call(write('/work/notes.md'))
  await $.turn.complete(ANSWERED)
  await settle()
  expect(opened).toEqual([])
  await $.turn.complete({ ...ANSWERED, turnId: 't2' })
  await settle()
  expect(asked).toHaveLength(1)
})

test('with the switch off, nothing is asked', async ($, on) => {
  const prefs = { model: null, effort: null, promptUpgrade: false, helper: 'same', autoModel: false, autoPrevious: null, autoUnavailable: [], mdViewer: false }
  const { asked } = engine(on, {}, YES, { prefs })
  await start($)
  await $.tool.call(write('/work/notes.md'))
  await $.turn.complete(ANSWERED)
  await settle()
  expect(asked).toEqual([])
})

test('a helper agent’s file and an interrupted turn are not asked about', async ($, on) => {
  const { asked } = engine(on, {}, YES)
  await start($)
  await $.tool.call({ ...(write('/work/helper.md') as object), agentId: 'a1' } as never)
  await $.turn.complete(ANSWERED)
  await $.tool.call(write('/work/notes.md'))
  await $.turn.complete({ ...ANSWERED, turnId: 't2', reason: 'aborted', isAborted: true })
  await settle()
  expect(asked).toEqual([])
})

test('a plan the Plan Pane mod claims is left out, even when it claims it after the write', async ($, on) => {
  const { asked } = engine(on, {}, YES)
  // Stands for the Plan Pane mod: its claimed list, filled after the Write has gone through.
  const claimed: string[] = []
  on('state.get', { plugin: 'plan-pane', key: 'claimed' } as never, () => ({ value: { value: claimed, version: 1 } }) as never)
  await start($)
  await $.tool.call(write('/work/plans/plan.md'))
  await $.tool.call(write('/work/notes.md'))
  claimed.push('/work/plans/plan.md')

  await $.turn.complete(ANSWERED)
  await settle()
  expect(asked).toEqual([{ question: 'Claude wrote notes.md. Open it in the Markdown viewer?', options: [YES, NO] }])
})

test('a turn that wrote only a claimed plan asks nothing', async ($, on) => {
  const { asked } = engine(on, {}, YES)
  on('state.get', { plugin: 'plan-pane', key: 'claimed' } as never, () => ({ value: { value: ['/work/plan.md'], version: 1 } }) as never)
  await start($)
  await $.tool.call(write('/work/plan.md'))
  await $.turn.complete(ANSWERED)
  await settle()
  expect(asked).toEqual([])
})

test('/mdview opens a file by path', async ($, on) => {
  const { opened } = engine(on, { '/work/plan.md': '# Plan' }, null)
  await start($)
  expect((await $.command.run({ command: 'mdview', args: '/work/nope.md' } as never)).text).toContain('There is no file')
  await $.command.run({ command: 'mdview', args: '/work/plan.md' } as never)
  expect(opened).toEqual(['md-viewer'])
})
