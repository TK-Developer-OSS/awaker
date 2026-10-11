// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * MIDI data model. MIDI never touches the GPU audio path: it is plain event data
 * (notes in beats) kept next to the audio lanes, edited in the piano roll, played
 * out to an external synth over Web MIDI and exported / imported as SMF.
 *
 * Positions are in **beats** so a tempo change moves the music, not the grid. The
 * transport is in frames; `beatsToFrames` / `framesToBeats` bridge the two using the
 * (constant) project tempo.
 */

import { normalizeInstrumentKind } from '../gpu/instrument'

export interface MidiNote {
  id: number
  /** Start, in beats from the clip start. */
  start: number
  /** Duration in beats (> 0). */
  dur: number
  /** 0..127 */
  key: number
  /** 1..127 */
  vel: number
}

export interface MidiClip {
  id: number
  name: string
  /** Clip head on the timeline, in beats. */
  start: number
  /** Clip length in beats. */
  length: number
  notes: MidiNote[]
}

export interface MidiTrack {
  id: number
  name: string
  /** MIDI channel 0..15 events are sent on. */
  channel: number
  mute: boolean
  solo: boolean
  /** Web MIDI output port id (null = not routed). */
  outId: string | null
  /** Web MIDI input port id that records into this track (null = none). */
  inId: string | null
  clips: MidiClip[]
  /**
   * GPGPU instrument that plays this track (null = plain MIDI track, silent).
   * `params` is plain JSON owned by the track; the instrument is rebuilt from it on
   * every render.
   */
  instrument: { kind: string; params: object } | null
  /** Runtime only (not saved): params of instruments this track has been switched away from, so switching back restores them. */
  stash?: Record<string, object>
}

let nextTrackId = 1
let nextClipId = 1
let nextNoteId = 1

export const midiTracks: MidiTrack[] = []

type Listener = () => void
const listeners = new Set<Listener>()
export function onMidiChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function midiChanged(): void {
  for (const fn of listeners) fn()
}

export const beatsToFrames = (beats: number, bpm: number, sr: number): number => (beats * 60 * sr) / bpm
export const framesToBeats = (frames: number, bpm: number, sr: number): number => (frames * bpm) / (60 * sr)

export function addMidiTrack(name: string, channel = 0): MidiTrack {
  const t: MidiTrack = {
    id: nextTrackId++,
    name,
    channel: Math.max(0, Math.min(15, channel | 0)),
    mute: false,
    solo: false,
    outId: null,
    inId: null,
    clips: [],
    instrument: null
  }
  midiTracks.push(t)
  midiChanged()
  return t
}

export function removeMidiTrack(id: number): void {
  const i = midiTracks.findIndex((t) => t.id === id)
  if (i >= 0) midiTracks.splice(i, 1)
  midiChanged()
}

export function addMidiClip(track: MidiTrack, start: number, length: number, name = 'MIDI'): MidiClip {
  const c: MidiClip = { id: nextClipId++, name, start: Math.max(0, start), length: Math.max(0.25, length), notes: [] }
  track.clips.push(c)
  midiChanged()
  return c
}

export function addNote(clip: MidiClip, start: number, dur: number, key: number, vel = 100): MidiNote {
  const n: MidiNote = {
    id: nextNoteId++,
    start: Math.max(0, start),
    dur: Math.max(1 / 64, dur),
    key: Math.max(0, Math.min(127, key | 0)),
    vel: Math.max(1, Math.min(127, vel | 0))
  }
  clip.notes.push(n)
  const end = n.start + n.dur
  if (end > clip.length) clip.length = Math.ceil(end) // clips grow to hold what is played in
  midiChanged()
  return n
}

export function removeNote(clip: MidiClip, id: number): void {
  const i = clip.notes.findIndex((n) => n.id === id)
  if (i >= 0) clip.notes.splice(i, 1)
  midiChanged()
}

export function clearMidi(): void {
  midiTracks.length = 0
  nextTrackId = 1
  nextClipId = 1
  nextNoteId = 1
  midiChanged()
}

/** Last beat that has anything in it (for the transport end). */
export function midiEndBeats(): number {
  let end = 0
  for (const t of midiTracks) for (const c of t.clips) end = Math.max(end, c.start + c.length)
  return end
}

// ---- persistence ------------------------------------------------------------

export interface SzMidiTrack {
  name: string
  channel: number
  mute: boolean
  solo: boolean
  outId: string | null
  inId: string | null
  instrument?: { kind: string; params: object } | null
  clips: { name: string; start: number; length: number; notes: { start: number; dur: number; key: number; vel: number }[] }[]
}

export function serializeMidi(): SzMidiTrack[] {
  return midiTracks.map((t) => ({
    name: t.name,
    channel: t.channel,
    mute: t.mute,
    solo: t.solo,
    outId: t.outId,
    inId: t.inId,
    instrument: t.instrument ? { kind: t.instrument.kind, params: structuredClone(t.instrument.params) } : null,
    clips: t.clips.map((c) => ({
      name: c.name,
      start: c.start,
      length: c.length,
      notes: c.notes.map((n) => ({ start: n.start, dur: n.dur, key: n.key, vel: n.vel }))
    }))
  }))
}

export function restoreMidi(src: SzMidiTrack[] | undefined): void {
  clearMidi()
  for (const st of src ?? []) {
    const t = addMidiTrack(String(st.name ?? 'MIDI'), Number(st.channel) | 0)
    t.mute = !!st.mute
    t.solo = !!st.solo
    t.outId = st.outId ?? null
    t.inId = st.inId ?? null
    t.instrument = st.instrument
      ? { kind: normalizeInstrumentKind(String(st.instrument.kind)), params: structuredClone(st.instrument.params ?? {}) }
      : null
    for (const sc of st.clips ?? []) {
      const c = addMidiClip(t, Number(sc.start) || 0, Number(sc.length) || 4, String(sc.name ?? 'MIDI'))
      for (const sn of sc.notes ?? []) addNote(c, Number(sn.start) || 0, Number(sn.dur) || 0.25, Number(sn.key) | 0, Number(sn.vel) | 0 || 100)
      c.length = Math.max(0.25, Number(sc.length) || c.length)
    }
  }
}
