// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Piano-roll geometry and edit math — no DOM, so it is unit-testable. Time is in
 * beats, pitch is a MIDI key. Screen y grows downward; `topKey` is the (fractional)
 * key at the top edge of the note area.
 */

export interface RollView {
  pxPerBeat: number
  rowH: number
  /** Beat at the left edge of the note area. */
  scrollBeats: number
  /** Key at the top edge of the note area. */
  topKey: number
}

export interface RollNote {
  id: number
  start: number
  dur: number
  key: number
  vel: number
}

export const beatToX = (v: RollView, beat: number): number => (beat - v.scrollBeats) * v.pxPerBeat
export const xToBeat = (v: RollView, x: number): number => x / v.pxPerBeat + v.scrollBeats
export const keyToY = (v: RollView, key: number): number => (v.topKey - key) * v.rowH
/** Key whose row contains screen y. */
export const yToKey = (v: RollView, y: number): number => Math.ceil(v.topKey - y / v.rowH - 1e-9)

/** Grid step in beats for a snap label; 0 = off. */
export function gridBeats(label: string): number {
  switch (label) {
    case '1/4':
      return 1
    case '1/8':
      return 0.5
    case '1/16':
      return 0.25
    case '1/32':
      return 0.125
    case '1/8T':
      return 1 / 3
    case '1/16T':
      return 1 / 6
    default:
      return 0
  }
}

export const snapNearest = (beat: number, grid: number): number => (grid > 0 ? Math.round(beat / grid) * grid : beat)
export const snapFloor = (beat: number, grid: number): number => (grid > 0 ? Math.floor(beat / grid + 1e-9) * grid : beat)

export interface NoteRect {
  x: number
  y: number
  w: number
  h: number
}

export function noteRect(v: RollView, n: RollNote): NoteRect {
  return { x: beatToX(v, n.start), y: keyToY(v, n.key), w: Math.max(2, n.dur * v.pxPerBeat), h: v.rowH }
}

export type HitZone = 'body' | 'right'

/** Topmost note under (x, y); the right edge (up to 8 px or a third of the note) resizes. */
export function hitTest(v: RollView, notes: RollNote[], x: number, y: number): { id: number; zone: HitZone } | null {
  for (let i = notes.length - 1; i >= 0; i--) {
    const r = noteRect(v, notes[i])
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y < r.y + r.h) {
      const edge = Math.min(8, r.w / 3)
      return { id: notes[i].id, zone: x >= r.x + r.w - edge ? 'right' : 'body' }
    }
  }
  return null
}

/** Notes whose rectangles intersect the box (any two opposite corners). */
export function notesInRect(v: RollView, notes: RollNote[], x0: number, y0: number, x1: number, y1: number): number[] {
  const l = Math.min(x0, x1)
  const r = Math.max(x0, x1)
  const t = Math.min(y0, y1)
  const b = Math.max(y0, y1)
  const out: number[] = []
  for (const n of notes) {
    const nr = noteRect(v, n)
    if (nr.x <= r && nr.x + nr.w >= l && nr.y <= b && nr.y + nr.h >= t) out.push(n.id)
  }
  return out
}

export interface Origin {
  id: number
  start: number
  dur: number
  key: number
}

/**
 * Move notes by a pointer delta. The *grabbed* note is snapped and the others keep
 * their offset from it, so a chord stays a chord. Keys clamp to 0..127 together.
 */
export function moveNotes(
  origins: Origin[],
  grabbedId: number,
  dxBeats: number,
  dKeys: number,
  grid: number
): Map<number, { start: number; key: number }> {
  const g = origins.find((o) => o.id === grabbedId) ?? origins[0]
  const out = new Map<number, { start: number; key: number }>()
  if (!g) return out
  let dStart = snapNearest(g.start + dxBeats, grid) - g.start
  const minStart = Math.min(...origins.map((o) => o.start))
  if (minStart + dStart < 0) dStart = -minStart
  const maxKey = Math.max(...origins.map((o) => o.key))
  const minKey = Math.min(...origins.map((o) => o.key))
  const dk = Math.max(-minKey, Math.min(127 - maxKey, dKeys))
  for (const o of origins) out.set(o.id, { start: o.start + dStart, key: o.key + dk })
  return out
}

/** Resize durations by a pointer delta (grabbed note's end snaps; min one grid step or 1/64). */
export function resizeNotes(
  origins: Origin[],
  grabbedId: number,
  dxBeats: number,
  grid: number
): Map<number, number> {
  const g = origins.find((o) => o.id === grabbedId) ?? origins[0]
  const out = new Map<number, number>()
  if (!g) return out
  const minDur = grid > 0 ? grid : 1 / 64
  const newEnd = snapNearest(g.start + g.dur + dxBeats, grid)
  const dDur = Math.max(minDur, newEnd - g.start) - g.dur
  for (const o of origins) out.set(o.id, Math.max(minDur, o.dur + dDur))
  return out
}

/** Ruler / grid line spacing in beats that stays readable at this zoom. */
export function gridLineStep(pxPerBeat: number): number {
  const steps = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4]
  for (const s of steps) if (s * pxPerBeat >= 14) return s
  return 4
}
