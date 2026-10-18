import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { RackPrefs } from '../types'
import { addFile, baseName, clip, EMPTY_VIEW, filesFor, isOffered, MD_PANE, question } from './md-viewer-logic'

export { MD_PANE } from './md-viewer-logic'

type Dollar = EngineInterface

const ORANGE = '#E8743B'
const INK = '#1a1a1a'

const DEFAULT_PREFS: RackPrefs = {
  model: null,
  effort: null,
  promptUpgrade: false,
  helper: 'same',
  autoModel: false,
  autoPrevious: null,
  autoUnavailable: [],
  mdViewer: true,
}

// Owned by Rods Rack (register.tsx); its Markdown viewer switch turns the question on and off.
const prefs = atom({ plugin: 'rods-rack', key: 'prefs' } as const, DEFAULT_PREFS)
// The Markdown files Claude wrote in the turn now running, offered when it ends.
const mdPending = atom({ plugin: 'rods-rack', key: 'mdPending' } as const, [] as string[])
// What the viewer pane shows: this turn's files, the one showing, and its text or why it failed.
const mdView = atom({ plugin: 'rods-rack', key: 'mdView' } as const, EMPTY_VIEW)

async function load($: Dollar, files: readonly string[], index: number) {
  const path = files[index]!
  try {
    const text = await $.fs.read(path)
    await update($, mdView, () => ({ files: [...files], index, text: clip(text), error: null }))
  } catch (err) {
    await update($, mdView, () => ({ files: [...files], index, text: null, error: String(err) }))
  }
}

const isOn = async ($: Dollar) => (await read($, prefs)).mdViewer

async function openViewer($: Dollar, files: readonly string[]) {
  await load($, files, 0)
  const opened = await $.ui.open({ id: MD_PANE, title: baseName(files[0]!), columns: 100 })
  if (!opened.isPlaced) $.ui.toast('The window is too narrow to show the Markdown viewer. Widen it, or type /mdview.')
}

async function showFile($: Dollar, index: number) {
  const view = await read($, mdView)
  await load($, view.files, index)
  await $.ui.open({ id: MD_PANE, title: baseName(view.files[index]!) })
}

// The question, once the turn has ended; a dismissed dialog is a no.
async function offer($: Dollar, files: readonly string[]) {
  const q = question(files)
  let answer: string
  try {
    answer = await $.ui.ask(q.text, { options: q.options, header: 'Markdown' })
  } catch {
    return
  }
  const picked = filesFor(files, answer)
  if (picked.length > 0) await openViewer($, picked)
}

async function drawViewer($: Dollar, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { Box, Text, Button, Markdown } = $.ui.resolve(e)
  const width = Math.max(28, e.props.bodyColumns)
  const view = await read($, mdView)
  const path = view.files[view.index]

  if (path === undefined) {
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>No file is open. Type /mdview and a path to open one.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}><Text dimColor wrap="truncate-start">{path}</Text></Box>
        <Button key="md-reload" plain onPress={() => void showFile($, view.index)}>
          <Text dimColor>[↻ Reload]</Text>
        </Button>
      </Box>
      {view.files.length > 1 && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {view.files.map((f, i) => (
            <Button key={`md-file-${i}`} plain onPress={() => void showFile($, i)}>
              {i === view.index ? <Text color={INK} backgroundColor={ORANGE}> {baseName(f)} </Text> : <Text> {baseName(f)} </Text>}
            </Button>
          ))}
        </Box>
      )}
      <Text> </Text>
      {view.error !== null ? (
        <Text color="red">The file could not be read: {view.error}</Text>
      ) : (
        <Markdown text={view.text === null || view.text.trim() === '' ? '*The file is empty.*' : view.text} />
      )}
    </Box>
  )
}

export function registerMdViewer(on: On) {
  on('session.start', { cwd: /./ }, async ($, e, next) => {
    await update($, mdPending, () => [])
    await $.command.register({ name: 'mdview', description: 'Open a Markdown file in the viewer pane', argumentHint: '<path>' })
    return next(e)
  })

  // A Markdown file Claude wrote in the main conversation, once the write has gone through.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined && !('deny' in result && result.deny !== undefined) && result.isError !== true && isOffered(e.file_path) && (await isOn($))) {
        await update($, mdPending, files => addFile(files, e.file_path))
      }
    } catch {
      // Not offered.
    }
    return result
  })

  // The turn has ended: ask about this turn's files, after the engine has finished with the turn.
  // An interrupted turn is not asked about.
  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const files = await read($, mdPending)
    await update($, mdPending, () => [])
    const result = await next(e)
    if (files.length > 0 && e.reason !== 'aborted' && (await isOn($))) void offer($, files)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mdview' }, async ($, e) => {
    const path = e.args.trim()
    if (path === '') {
      const view = await read($, mdView)
      if (view.files.length === 0) return { text: 'Type /mdview and the path of a Markdown file.' }
      await openViewer($, [...view.files.slice(view.index), ...view.files.slice(0, view.index)])
      return { text: '' }
    }
    if (!(await $.fs.exists(path))) return { text: `There is no file at ${path}.` }
    await openViewer($, [path])
    return { text: '' }
  }).catch(() => ({ text: 'The Markdown viewer could not open just now. Try /mdview again.' }))

  on('ui.render', { component: 'Pane', requestId: MD_PANE }, async ($, e) => drawViewer($, e))
}
