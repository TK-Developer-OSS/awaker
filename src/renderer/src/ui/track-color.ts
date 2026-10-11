// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Track colours (pure: no DOM, no GPU — unit-tested).
 *
 * A track has a colour; its lane is painted with it and the waveform is drawn in a dark grey on top
 * (the colour is the base, the wave is the ink). Tracks that share a stem share one colour: choosing a stem
 * (or a colour on a track that has a stem) aligns every track of that stem — `alignStemColors`.
 */

/** Twelve distinguishable mid-tones: strong enough to read as a colour, light enough for a dark-grey wave on top. */
export const TRACK_PALETTE: readonly string[] = [
  '#e5736a', // coral
  '#e8985a', // orange
  '#e2c15a', // yellow
  '#9ccc65', // green
  '#4db6ac', // teal
  '#4fc3f7', // sky
  '#6f9bff', // blue
  '#9a86e8', // violet
  '#cf7be0', // orchid
  '#ec7fa6', // pink
  '#8fa3b0', // steel
  '#c4a77d' // sand
]

/** The waveform ink: a dark grey, the same on every track. */
export const WAVE_INK: readonly [number, number, number] = [0.15, 0.165, 0.19]

export function paletteColor(index: number): string {
  const n = TRACK_PALETTE.length
  return TRACK_PALETTE[((Math.floor(index) % n) + n) % n]
}

/** `#rrggbb` (or `#rgb`) → [r, g, b] in 0..1, or null for anything else. */
export function parseColor(hex: unknown): [number, number, number] | null {
  if (typeof hex !== 'string') return null
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const v = parseInt(h, 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** A colour from a person / an AI: `#rrggbb`, `#rgb`, or a palette number 0..11 (a number or its digits as text). Otherwise null. */
export function normalizeColor(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return paletteColor(Math.round(v))
  if (typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v)) return paletteColor(parseInt(v, 10)) // "5" = palette number 5
  const rgb = parseColor(v)
  if (!rgb) return null
  const h = (x: number): string => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`
}

const mix = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
]

export interface LanePaint {
  /** Lane background behind the waveform. */
  bg: [number, number, number]
  /** Waveform ink. */
  wave: [number, number, number]
  /** Fill behind a clip picked in the audio list (a pale tint of the track colour). */
  fill: [number, number, number]
  /** The colour as CSS (`#rrggbb`) for DOM accents. */
  css: string
}

/** How a track colour is painted: the colour itself as the lane, a dark grey wave, a pale tint for a picked clip. */
export function lanePaint(color: string): LanePaint {
  const base = parseColor(color) ?? parseColor(TRACK_PALETTE[0])!
  return {
    bg: mix(base, [0, 0, 0], 0.3), // a little under the pure colour: a long column of lanes is calmer, the grey wave still reads
    wave: [WAVE_INK[0], WAVE_INK[1], WAVE_INK[2]],
    fill: mix(base, [1, 1, 1], 0.6),
    css: normalizeColor(color) ?? TRACK_PALETTE[0]
  }
}

export interface ColoredTrack {
  stem: string
  color: string
}

/**
 * Make every track of a stem the same colour.
 *
 * `changed` is the index of the track the person just acted on (gave it this stem, or picked a colour for it):
 *   - it joins a stem that already has a colour  → it takes the stem's colour;
 *   - it starts a stem (no colour yet)           → the stem takes ITS colour;
 *   - `recolor` is true (a colour was just picked on a track that has a stem) → its colour becomes the stem's.
 * Returns the new colour of every track (the input is not changed) and the updated stem → colour table.
 */
export function alignStemColors(
  tracks: readonly ColoredTrack[],
  stemColors: Readonly<Record<string, string>>,
  changed: number,
  recolor = false
): { colors: string[]; stemColors: Record<string, string> } {
  const colors = tracks.map((t) => t.color)
  const table: Record<string, string> = { ...stemColors }
  const t = tracks[changed]
  const name = t?.stem.trim() ?? ''
  if (t && name) {
    const have = table[name]
    const color = recolor || !have ? t.color : have
    table[name] = color
    for (let i = 0; i < tracks.length; i++) if (tracks[i].stem.trim() === name) colors[i] = color
  }
  return { colors, stemColors: table }
}

/** Drop table entries for stems no track uses any more. */
export function pruneStemColors(stems: readonly string[], table: Readonly<Record<string, string>>): Record<string, string> {
  const used = new Set(stems.map((s) => s.trim()).filter(Boolean))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(table)) if (used.has(k)) out[k] = v
  return out
}

/**
 * A palette colour for a new group (or stem) that no other one uses yet. The order spreads neighbouring picks
 * across the hue circle (steps of three); once all twelve are taken it simply starts again.
 */
export function pickUnusedColor(used: readonly string[]): string {
  const taken = new Set(used.map((c) => normalizeColor(c)).filter((c): c is string => c !== null))
  const order = [5, 8, 11, 2, 6, 9, 0, 3, 7, 10, 1, 4]
  for (const i of order) if (!taken.has(TRACK_PALETTE[i])) return TRACK_PALETTE[i]
  return TRACK_PALETTE[order[used.length % order.length]]
}
