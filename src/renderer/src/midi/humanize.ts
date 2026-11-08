// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Groove humanizer: shifts where a note is played, without touching the stored notes (playback and
 * the GPU render read the shifted time; switch it off and the track is back to the grid). Offsets are
 * in milliseconds so the feel stays the same at any tempo, and small (1-3 ms): the grid stays the
 * reference, the downbeat (kick on 1) stays on it, and only chosen positions lean ahead.
 *
 * Bar-length changes (fills shortening a bar by a few ms) are a separate layer, still to come.
 */

export interface HumanizePreset {
  id: string
  label: string
  /** Shift for notes on the 8th off-beat ("and"), ms. − = earlier (pushed). */
  offBeatMs: number
  /** Shift for the snare on the last beat of the bar (beat 4 in 4/4), drum tracks only, ms. */
  lastBeatSnareMs: number
  /** That snare is also played softer: velocity × (1 − this), with ±lastBeatSnareVelJitter of per-note random. */
  lastBeatSnareVelCut: number
  lastBeatSnareVelJitter: number
  /** Shift for the first notes of a tom fill (drum tracks), ms. */
  tomFillHeadMs: number
}

export const HUMANIZE_PRESETS: HumanizePreset[] = [
  { id: 'off', label: 'Off', offBeatMs: 0, lastBeatSnareMs: 0, lastBeatSnareVelCut: 0, lastBeatSnareVelJitter: 0, tomFillHeadMs: 0 },
  { id: 'rock8', label: 'Rock Dr 8-Bt', offBeatMs: -2, lastBeatSnareMs: -2, lastBeatSnareVelCut: 0.1, lastBeatSnareVelJitter: 0.04, tomFillHeadMs: -2 }
]

/** Ids saved by older builds that now map onto a current preset. */
const ALIASES: Record<string, string> = { 'rock8-strong': 'rock8' }

export const humanizePreset = (id: string | undefined): HumanizePreset | undefined => {
  const want = id ? (ALIASES[id] ?? id) : undefined
  return want && want !== 'off' ? HUMANIZE_PRESETS.find((p) => p.id === want) : undefined
}

/** How close (in beats) a note must sit to a grid position to count as on it: a 64th note. */
const SNAP = 1 / 16

/** Default strength (1 = the preset's values). */
export const HUMANIZE_AMOUNT_DEFAULT = 1

/** GM snare voices: side stick, acoustic snare, electric snare. */
const SNARE_KEYS = new Set([37, 38, 40])

export interface HumanizeNote {
  /** MIDI key, for the drum roles. */
  key?: number
  /** The track is a drum track (keys are drum voices). */
  drum?: boolean
  /** Quarter notes per bar (4 in 4/4). */
  barBeats?: number
  /** One of the first notes of a tom fill (see trackFillHeads). */
  fillHead?: boolean
}

/** Shift in ms for a note starting at `beat` (project beats, quarter notes), scaled by `amount` (0..2). */
export function humanizeShiftMs(
  preset: HumanizePreset | undefined,
  beat: number,
  amount = HUMANIZE_AMOUNT_DEFAULT,
  note: HumanizeNote = {}
): number {
  if (!preset) return 0
  const k = Math.max(0, Math.min(2, amount))
  if (note.drum && note.fillHead) return preset.tomFillHeadMs * k
  const frac = beat - Math.floor(beat)
  if (Math.abs(frac - 0.5) < SNAP) return preset.offBeatMs * k
  if (isLastBeatSnare(beat, note)) return preset.lastBeatSnareMs * k
  return 0
}

/** A drum track's snare on the last beat of the bar. */
function isLastBeatSnare(beat: number, note: HumanizeNote): boolean {
  const frac = beat - Math.floor(beat)
  if (!(frac < SNAP || frac > 1 - SNAP) || !note.drum || note.key === undefined || !SNARE_KEYS.has(note.key)) return false
  const bar = Math.max(1, Math.round(note.barBeats ?? 4))
  return ((Math.round(beat) % bar) + bar) % bar === bar - 1
}

/**
 * Fixed per-note random in [-1, 1): a hash of where the note sits and its key, so the same note gets the
 * same value every time it plays and in both MIDI out and the built-in render (no live random).
 */
export function noteRandom(beat: number, key: number): number {
  let h = (Math.round(beat * 960) * 73856093) ^ (key * 19349663)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967296) * 2 - 1
}

/** Velocity after the humanizer (1..127), scaled by `amount` like the timing. */
export function humanizeVel(
  preset: HumanizePreset | undefined,
  beat: number,
  vel: number,
  amount = HUMANIZE_AMOUNT_DEFAULT,
  note: HumanizeNote = {}
): number {
  if (!preset || !preset.lastBeatSnareVelCut || !isLastBeatSnare(beat, note)) return vel
  const k = Math.max(0, Math.min(2, amount))
  const cut = (preset.lastBeatSnareVelCut + preset.lastBeatSnareVelJitter * noteRandom(beat, note.key ?? 0)) * k
  return Math.max(1, Math.min(127, Math.round(vel * (1 - cut))))
}

/** A drum track: the built-in drum machine, or MIDI channel 10 (GM drums). */
export const isDrumTrack = (t: { channel: number; instrument?: { kind: string } | null }): boolean =>
  t.instrument?.kind === 'drums' || t.channel === 9

/** GM toms: low floor, high floor, low, low-mid, hi-mid, high. */
const TOM_KEYS = new Set([41, 43, 45, 47, 48, 50])
/** A gap longer than this (beats) between tom notes starts a new fill. */
const FILL_GAP = 0.5
/** How many onsets at the head of a fill lean ahead (toms struck together count as one). */
const FILL_HEAD = 2

/**
 * The notes at the head of each tom fill on a track: tom notes are grouped into fills wherever they
 * are more than FILL_GAP beats apart, and the notes on the first FILL_HEAD onsets of each fill are
 * returned (by identity, so the caller can test each note).
 */
export function trackFillHeads<N extends { start: number; key: number }>(clips: { start: number; notes: N[] }[]): Set<N> {
  const toms: { beat: number; n: N }[] = []
  for (const c of clips) for (const n of c.notes) if (TOM_KEYS.has(n.key)) toms.push({ beat: c.start + n.start, n })
  toms.sort((a, b) => a.beat - b.beat)
  const heads = new Set<N>()
  let prev = -Infinity
  let onsets = 0
  let onsetBeat = -Infinity
  for (const t of toms) {
    if (t.beat - prev > FILL_GAP) onsets = 0 // a new fill
    if (Math.abs(t.beat - onsetBeat) > 1e-6) {
      onsets++
      onsetBeat = t.beat
    }
    if (onsets <= FILL_HEAD) heads.add(t.n)
    prev = t.beat
  }
  return heads
}
