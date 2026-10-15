// The look of Rods Rack's Work Report (rods-rack/hooks/report-logic.ts), copied since a mod can
// only import its own files: the same colors, big numerals, bars and chart columns.

export const GOLD = '#F2C46D'
export const HAIRLINE = '#262B33'
export const SLATE = '#262B33'
export const MUTED = '#7D8590'
export const TEXT = '#E6EDF3'
export const GREEN = '#3DD68C'
export const BLUE = '#5AB0F0'
export const PURPLE = '#B48CF2'
export const INK = '#14161A'

// Big numerals: three rows of heavy box-drawing characters per glyph.
const GLYPHS: Readonly<Record<string, readonly [string, string, string]>> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
  '.': [' ', ' ', '•'],
  h: ['╻  ', '┣━┓', '╹ ╹'],
  m: ['   ', '┏┳┓', '╹╹╹'],
  k: ['╻  ', '┣┛ ', '╹┗╸'],
  M: ['┏┳┓', '┃┃┃', '╹ ╹'],
}

/** Three rows, or null when a character has no glyph. */
export function bigText(text: string): [string, string, string] | null {
  const rows: [string[], string[], string[]] = [[], [], []]
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (glyph === undefined) return null
    for (let r = 0; r < 3; r += 1) rows[r]!.push(glyph[r]!)
  }
  return [rows[0].join(' '), rows[1].join(' '), rows[2].join(' ')]
}

export const bigWidth = (text: string) => bigText(text)?.[0].length ?? Infinity

/** A duration short enough for a tile: 45s, 18m, 1h08m, 120h. */
export function bigDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.round(ms / 1000)}`
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  return h >= 100 ? `${h}h` : `${h}h${String(minutes % 60).padStart(2, '0')}m`
}

/** Three tiles a row when the pane is wide, then two, then one. */
export function tilesPerRow(width: number): number {
  return width >= 66 ? 3 : width >= 44 ? 2 : 1
}

/** A bar of `cells` scaled to the largest value. */
export function barCells(value: number, max: number, cells: number): number {
  if (value <= 0 || max <= 0) return 0
  return Math.min(cells, Math.max(1, Math.round((value / max) * cells)))
}

/** A column three rows tall: each row a block from ▁ to █, top row first. */
const LEVELS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
export function column(value: number, max: number): [string, string, string] {
  const eighths = max <= 0 || value <= 0 ? 0 : Math.max(1, Math.round((value / max) * 24))
  const row = (from: number) => LEVELS[Math.max(0, Math.min(8, eighths - from))]!
  return [row(16), row(8), row(0)]
}

/** Letters spread out for a section heading: W H E R E   T H E   T I M E. */
export const spaced = (text: string) => text.split(' ').map(word => word.split('').join(' ')).join('   ')

export const fit = (text: string, width: number) =>
  width <= 1 ? '' : text.length <= width ? text.padEnd(width) : text.slice(0, width - 1) + '…'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const dateOf = (key: string) => {
  const [y = 1970, m = 1, d = 1] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const weekday = (key: string) => WEEKDAYS[dateOf(key).getDay()]!
export const monthName = (yyyyMm: string) => MONTHS[Number(yyyyMm.slice(5, 7)) - 1] ?? yyyyMm
export const shortDate = (key: string) => `${MONTHS[dateOf(key).getMonth()]} ${dateOf(key).getDate()}`
export const longDate = (key: string) => `${WEEKDAYS[dateOf(key).getDay()]}, ${shortDate(key)}`
