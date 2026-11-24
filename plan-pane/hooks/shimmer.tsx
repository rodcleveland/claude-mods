// Shimmer adapted from the filetree mod's rows.tsx (MIT, Copyright (c) 2026 Kurt Buhler); see ACKNOWLEDGEMENTS.md.
import type { ClientModule } from 'claude-code'
import type { PaneRow, ShimmerProps } from '../types'

// phase counts ticks; ref holds the running timer's stop and the phase it started at, so each
// flash sweeps from the left edge. ref is mutated in place: keeping it needs no setState.
type Local = { phase: number; ref: { stop?: () => void; base: number } }

const TICK_MS = 90

// The ramp step for character i: a light band sweeps left to right, base colour around it.
function shimmer(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.6) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? '#f97316'
}

// Cuts s to n cells, ending in "…" when it had to cut. Counts code points as cells.
function fit(s: string, n: number): string {
  const chars = [...s]
  if (chars.length <= n) return s
  return n <= 0 ? '' : chars.slice(0, n - 1).join('') + '…'
}

const Shimmer: ClientModule<ShimmerProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { phase: 0, ref: { base: 0 } }
    surface.setState(state)
  }
  const still = surface.isMotionReduced
  const rampOf = (r: PaneRow) => (r.tone ? props.tones[r.tone] : undefined)
  // Tick only while a row is lit and motion is welcome; no timer at rest.
  const animate = !still && props.rows.some(r => rampOf(r)?.length)
  if (animate && !state.ref.stop) {
    state.ref.base = state.phase
    state.ref.stop = surface.every(TICK_MS, () => {
      const cur = surface.state
      if (cur) surface.setState({ ...cur, phase: cur.phase + 1 })
    })
  } else if (!animate && state.ref.stop) {
    state.ref.stop()
    state.ref.stop = undefined
  }
  const phase = state.phase - state.ref.base

  const line = (r: PaneRow) => {
    const ramp = rampOf(r)
    const lit = Boolean(ramp?.length)
    // Indent, glyph and the space after it; a row with no glyph (the title) gets no space.
    const lead = ' '.repeat(Math.max(0, r.indent)) + (r.glyph ? r.glyph + ' ' : '')
    // Room for the text: the line never wraps, and keeps a space before the right note.
    const rightW = r.right ? [...r.right].length + 1 : 0
    const room = surface.columns > 0 ? surface.columns - [...lead].length - rightW : Infinity
    const text = fit(r.text, room)
    let glyph
    let body
    if (lit && ramp) {
      // The glyph glints in one colour as the sweep starts, as filetree's icons do.
      glyph = <Text color={still ? ramp[0] : shimmer(-1, phase, text.length, ramp)}>{lead}</Text>
      const chars = [...text]
      body = still ? (
        <Text color={ramp[0]} bold>
          {text}
        </Text>
      ) : (
        <Text bold>
          {chars.map((ch, i) => (
            <Text color={shimmer(i, phase, chars.length, ramp)}>{ch}</Text>
          ))}
        </Text>
      )
    } else {
      glyph = (
        <Text color={r.glyphColor ?? r.color} dimColor={!r.glyphColor && r.dim}>
          {lead}
        </Text>
      )
      body = (
        <Text color={r.color} dimColor={r.dim} bold={r.bold}>
          {text}
        </Text>
      )
    }
    return (
      <Box flexDirection="row" height={1} overflow="hidden">
        <Box flexShrink={1} overflow="hidden">
          {glyph}
          {body}
        </Box>
        <Box flexGrow={1} />
        {r.right ? <Text dimColor>{' ' + r.right}</Text> : null}
      </Box>
    )
  }

  return <Box flexDirection="column">{props.rows.map(line)}</Box>
}

export default Shimmer
