import { expect, test } from 'claude-code/testing'

import type { Flash, Plan } from '../types'
import { DARK_TONES } from '../hooks/tones'

// The shimmer module runs only inside Plan Pane's own Pane (a Client a test's hook draws has no
// surface module behind it), so these tests feed the pane its plan and flash through state.get.
const PANE = {
  plugin: 'plan-pane',
  component: 'Pane',
  requestId: 'plan-pane',
  props: { title: 'Plan', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const IN = { in: 'plan-rows' }

const PLAN: Plan = {
  path: '/repo/docs/plans/calendar.md',
  title: 'Calendar plan',
  sections: [
    {
      id: 's:units',
      title: 'units',
      milestones: [
        { id: 'U1', label: 'U1 work', status: 'done' },
        { id: 'U2', label: 'U2 work', status: 'active' },
        { id: 'U3', label: 'U3 a label far too long to fit in the narrow pane', status: 'todo' },
      ],
    },
  ],
}

type World = { flash: Flash }

function world(on: any): World {
  const w: World = { flash: { ids: {}, generation: 0 } }
  on('state.get', (_$: any, e: any, next: any) => {
    if (e.plugin !== 'plan-pane') return next(e)
    if (e.key === 'plan') return { value: { value: { shape: 'plan-1', value: PLAN }, version: 1 } }
    if (e.key === 'flash') return { value: { value: { shape: 'flash-1', value: w.flash }, version: 1 } }
    return next(e)
  })
  return w
}

type Run = { text: string; color?: string; bold?: boolean; dim?: boolean }

// Every Text leaf of a drawing, in order, with the colour and weight it inherits.
function runs(node: any, up: Omit<Run, 'text'> = {}): Run[] {
  if (typeof node === 'string') return [{ text: node, ...up }]
  if (!node || typeof node !== 'object') return []
  const p = node.props ?? {}
  const here = node.type === 'Text' ? { color: p.color ?? up.color, bold: p.bold ?? up.bold, dim: p.dimColor ?? up.dim } : up
  return ((node.children ?? []) as unknown[]).flatMap(c => runs(c, here))
}

// The runs of the line holding `text`: the first column row whose leaves spell it.
async function line(ui: any, text: string): Promise<Run[]> {
  const tree: any = await ui.drawn(IN)
  for (const row of tree.children ?? []) {
    const rs = runs(row)
    if (rs.map(r => r.text).join('').includes(text)) return rs
  }
  throw new Error(`no line holds ${text}`)
}

const orange = DARK_TONES.orange

test('shimmer: a lit row sweeps per character in bold, an unlit row draws as given', async ($, on) => {
  const w = world(on)
  w.flash = { ids: { 'm:U2': 'orange' }, generation: 1 }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 40, rows: 6, ...IN })

  // At the first frame the band sits left of the text: every character in the base colour.
  const lit = await line(ui, 'U2 work')
  const chars = lit.filter(r => r.text.length === 1 && r.text !== ' ')
  expect(chars.map(r => r.text).join('')).toBe('U2work')
  expect(chars.every(r => r.color === orange[0] && r.bold === true)).toBe(true)

  // A few ticks on, the band has reached the text: lighter stops show.
  await ui.advance(90 * 4)
  const swept = (await line(ui, 'U2 work')).map(r => r.color)
  expect(swept.some(c => c === orange[1] || c === orange[2] || c === orange[3])).toBe(true)

  // An unlit row: one run of text, dim as the row says, its glyph in its own colour.
  const done = await line(ui, 'U1 work')
  expect(done.find(r => r.text.includes('U1 work'))).toMatchObject({ dim: true })
  expect(done.find(r => r.text.includes('✓'))?.color).toBe('#22c55e')
  expect(done.some(r => Object.values(DARK_TONES).some(ramp => ramp.slice(1).includes(r.color ?? '')))).toBe(false)
  await ui.unmount()
})

test('shimmer: the timer stops when nothing is lit and restarts from the left edge', async ($, on) => {
  const w = world(on)
  w.flash = { ids: { 'm:U2': 'orange' }, generation: 1 }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.advance(90 * 10)

  w.flash = { ids: {}, generation: 2 }
  await ui.redraw()
  await ui.advance(90 * 10)

  // Had the timer run on, the phase would be 20 and the band over the text. Stopped and
  // restarted, the sweep begins again left of it: all base colour.
  w.flash = { ids: { 'm:U2': 'orange' }, generation: 3 }
  await ui.redraw()
  const chars = (await line(ui, 'U2 work')).filter(r => r.text.length === 1 && r.text !== ' ')
  expect(chars.every(r => r.color === orange[0])).toBe(true)
  await ui.unmount()
})

test('shimmer: with motion reduced a lit row is still, bold in its base colour', async ($, on) => {
  const w = world(on)
  w.flash = { ids: { 'm:U2': 'orange' }, generation: 1 }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.setMotionReduced(true)
  await ui.advance(90 * 4)
  const lit = await line(ui, 'U2 work')
  expect(lit.find(r => r.text === 'U2 work')).toMatchObject({ color: orange[0], bold: true })
  await ui.unmount()
})

test('shimmer: a long label is cut with an ellipsis to the region and the count stays', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 24, rows: 6, ...IN })
  const long = (await line(ui, 'U3 a')).map(r => r.text).join('')
  expect(long.endsWith('…')).toBe(true)
  expect([...long].length).toBeLessThanOrEqual(24)
  const header = (await line(ui, 'Calendar plan')).map(r => r.text).join('')
  expect(header).toBe('Calendar plan 1/3')
  await ui.unmount()
})
