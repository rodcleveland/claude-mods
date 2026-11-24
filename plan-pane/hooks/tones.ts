// Ramps and sweep adapted from the filetree mod (MIT, Copyright (c) 2026 Kurt Buhler); see ACKNOWLEDGEMENTS.md.
import type { ToneRamps } from '../types'

// The shimmer's colour ramps, base first and lightest last; the sweep's head takes the lightest.

// Ramps for a dark background: filetree's bright tones (Tailwind 500 -> 100).
export const DARK_TONES: ToneRamps = {
  purple: ['#a855f7', '#c084fc', '#d8b4fe', '#f3e8ff'],
  orange: ['#f97316', '#fb923c', '#fdba74', '#ffedd5'],
  green: ['#22c55e', '#4ade80', '#86efac', '#dcfce7'],
}

// Ramps for a light background: deeper bases (Tailwind 700 -> 400), so no stop fades into white.
export const LIGHT_TONES: ToneRamps = {
  purple: ['#7e22ce', '#9333ea', '#a855f7', '#c084fc'],
  orange: ['#c2410c', '#ea580c', '#f97316', '#fb923c'],
  green: ['#15803d', '#16a34a', '#22c55e', '#4ade80'],
}

// The ramps for a background.
export const tonesFor = (isLight: boolean): ToneRamps => (isLight ? LIGHT_TONES : DARK_TONES)

// How long a row stays lit.
export const FLASH_MS = 2700
