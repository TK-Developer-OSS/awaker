// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Pure logic behind MIDI output (what to send in the next time window) and MIDI
 * recording (turning note-on / note-off events into notes). No Web MIDI, no DOM — the
 * browser glue lives in `io.ts`.
 */

import type { MidiTrack } from './model'

export interface OutEvent {
  trackId: number
  /** Project frame at which the event is due. */
  frame: number
  kind: 'on' | 'off'
  key: number
  vel: number
}

/**
 * Events due in [fromFrame, toFrame). Note-offs sort before note-ons at the same frame
 * so a repeated key re-triggers. Tracks that are not `audible` are skipped.
 */
export function planWindow(
  tracks: MidiTrack[],
  audible: (t: MidiTrack) => boolean,
  fromFrame: number,
  toFrame: number,
  beatsToFrames: (beats: number) => number
): OutEvent[] {
  const out: OutEvent[] = []
  for (const t of tracks) {
    if (!t.outId || !audible(t)) continue
    for (const c of t.clips) {
      for (const n of c.notes) {
        const on = beatsToFrames(c.start + n.start)
        const off = beatsToFrames(c.start + n.start + n.dur)
        if (on >= fromFrame && on < toFrame) out.push({ trackId: t.id, frame: on, kind: 'on', key: n.key, vel: n.vel })
        if (off >= fromFrame && off < toFrame) out.push({ trackId: t.id, frame: off, kind: 'off', key: n.key, vel: 0 })
      }
    }
  }
  out.sort((a, b) => a.frame - b.frame || (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1))
  return out
}

export interface CapturedNote {
  start: number
  dur: number
  key: number
  vel: number
}

/**
 * Collects notes for one track while recording. Positions are in beats on the project
 * timeline; `finish()` closes anything still held and returns the notes.
 */
export class NoteCapture {
  private held = new Map<number, { start: number; vel: number }[]>()
  readonly notes: CapturedNote[] = []

  noteOn(beat: number, key: number, vel: number): void {
    const stack = this.held.get(key) ?? []
    stack.push({ start: beat, vel: Math.max(1, Math.min(127, vel | 0)) })
    this.held.set(key, stack)
  }

  noteOff(beat: number, key: number): void {
    const on = this.held.get(key)?.shift()
    if (!on) return
    this.notes.push({ start: on.start, dur: Math.max(1 / 64, beat - on.start), key, vel: on.vel })
  }

  finish(endBeat: number): CapturedNote[] {
    for (const [key, stack] of this.held) {
      for (const on of stack) this.notes.push({ start: on.start, dur: Math.max(1 / 64, endBeat - on.start), key, vel: on.vel })
    }
    this.held.clear()
    this.notes.sort((a, b) => a.start - b.start || a.key - b.key)
    return this.notes
  }
}

/** Parse a raw MIDI message into a note event (anything else → null). */
export function parseNoteMessage(d: ArrayLike<number>): { on: boolean; channel: number; key: number; vel: number } | null {
  if (d.length < 3) return null
  const st = d[0] & 0xf0
  const channel = d[0] & 0x0f
  if (st === 0x90 && d[2] > 0) return { on: true, channel, key: d[1] & 0x7f, vel: d[2] & 0x7f }
  if (st === 0x80 || st === 0x90) return { on: false, channel, key: d[1] & 0x7f, vel: 0 }
  return null
}
