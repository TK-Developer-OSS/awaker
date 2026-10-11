// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { state } from '../state'
import { addMidiClip, addNote, beatsToFrames, framesToBeats, midiTracks, type MidiTrack } from './model'
import { NoteCapture, parseNoteMessage, planWindow } from './io-logic'

/**
 * Web MIDI glue: lists ports, sends a track's notes to an external synth while the
 * transport plays, and records notes from a keyboard into a new clip. The decisions
 * (what is due, how notes pair up) live in `io-logic.ts` and are unit-tested; this
 * file is the part that needs real hardware.
 *
 * Timing: playback events are sent with a Web MIDI timestamp computed from the
 * transport position, ~150 ms ahead. The audio path has its own device latency, so
 * `outDelayMs` shifts MIDI later (positive) to line an external synth up with it.
 * Recording stamps each event from `event.timeStamp` against the transport position.
 */

export interface MidiPort {
  id: string
  name: string
}

/** Control-surface ports (see control/mcu.ts) are not instrument I/O. */
const SURFACE_RE = /p1-?nano|platform ?nano|icon/i

const LOOKAHEAD_S = 0.15
const DELAY_KEY = 'awaker.midiOutDelayMs'

interface RecSession {
  mt: MidiTrack
  cap: NoteCapture
  startBeat: number
}

export class MidiIo {
  private access: MIDIAccess | null = null
  private listeners = new Set<() => void>()
  private sessions: RecSession[] = []
  private active = new Map<string, { outId: string; ch: number; key: number }>()
  private lastEnd = -1
  private timer = 0
  recording = false
  /** Extra delay (ms) applied to MIDI output, to match the audio device latency. */
  outDelayMs = 0

  constructor() {
    try {
      const v = Number(localStorage.getItem(DELAY_KEY))
      if (Number.isFinite(v)) this.outDelayMs = Math.max(-200, Math.min(500, v))
    } catch {
      /* storage unavailable */
    }
  }

  setOutDelay(ms: number): void {
    this.outDelayMs = Math.max(-200, Math.min(500, ms))
    try {
      localStorage.setItem(DELAY_KEY, String(this.outDelayMs))
    } catch {
      /* storage unavailable */
    }
  }

  async init(): Promise<boolean> {
    if (this.access || !('requestMIDIAccess' in navigator)) return !!this.access
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
      this.access.onstatechange = () => this.listeners.forEach((fn) => fn())
      this.listeners.forEach((fn) => fn())
      console.log('[midi] ports in:', this.inputs().map((p) => p.name), 'out:', this.outputs().map((p) => p.name))
      return true
    } catch (err) {
      console.warn('[midi] Web MIDI unavailable:', err)
      return false
    }
  }

  onPortsChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  inputs(): MidiPort[] {
    return this.list(this.access?.inputs)
  }
  outputs(): MidiPort[] {
    return this.list(this.access?.outputs)
  }
  private list(m: MIDIInputMap | MIDIOutputMap | undefined): MidiPort[] {
    if (!m) return []
    const out: MidiPort[] = []
    m.forEach((p) => {
      if (!SURFACE_RE.test(p.name ?? '')) out.push({ id: p.id, name: p.name ?? p.id })
    })
    return out
  }

  // ---- playback → external synth -------------------------------------------------

  /** Start the ~20 ms pump. `frame()` is the live transport position in frames. */
  startPump(frame: () => number, audible: (t: MidiTrack) => boolean): void {
    clearInterval(this.timer)
    this.timer = window.setInterval(() => this.tick(frame, audible), 20)
  }

  private tick(frame: () => number, audible: (t: MidiTrack) => boolean): void {
    if (!this.access) return
    if (!state.playing) {
      if (this.active.size || this.lastEnd >= 0) this.allOff()
      this.lastEnd = -1
      return
    }
    const sr = state.sampleRate
    const ph = frame()
    const horizon = ph + LOOKAHEAD_S * sr
    const jumped = this.lastEnd >= 0 && (ph < this.lastEnd - 2 * LOOKAHEAD_S * sr || ph > this.lastEnd + 0.5 * sr)
    if (this.lastEnd < 0 || jumped) {
      if (jumped) this.allOff() // seek / loop: don't leave notes hanging
      this.lastEnd = ph
    }
    const bpm = state.bpm
    const events = planWindow(midiTracks, audible, this.lastEnd, horizon, (b) => beatsToFrames(b, bpm, sr))
    this.lastEnd = horizon
    if (!events.length) return
    const nowMs = performance.now()
    for (const e of events) {
      const t = midiTracks.find((x) => x.id === e.trackId)
      const port = t?.outId ? this.access.outputs.get(t.outId) : undefined
      if (!t || !port) continue
      const ts = nowMs + ((e.frame - ph) / sr) * 1000 + this.outDelayMs
      const ch = t.channel & 0x0f
      const id = `${t.outId}|${ch}|${e.key}`
      try {
        if (e.kind === 'on') {
          port.send([0x90 | ch, e.key, e.vel], ts)
          this.active.set(id, { outId: t.outId as string, ch, key: e.key })
        } else {
          port.send([0x80 | ch, e.key, 0], ts)
          this.active.delete(id)
        }
      } catch {
        /* port vanished */
      }
    }
  }

  /** Release everything that is sounding (stop, seek, hot-unplug). */
  allOff(): void {
    if (!this.access) return
    const chans = new Set<string>()
    for (const a of this.active.values()) {
      try {
        this.access.outputs.get(a.outId)?.send([0x80 | a.ch, a.key, 0])
      } catch {
        /* port vanished */
      }
      chans.add(`${a.outId}|${a.ch}`)
    }
    for (const c of chans) {
      const [outId, ch] = c.split('|')
      try {
        this.access.outputs.get(outId)?.send([0xb0 | Number(ch), 123, 0]) // all notes off
      } catch {
        /* port vanished */
      }
    }
    this.active.clear()
  }

  // ---- recording ---------------------------------------------------------------

  /** Begin capturing the armed tracks' input ports. `nowFrame()` is the live transport frame. */
  startRecording(tracks: MidiTrack[], nowFrame: () => number): number {
    this.finishRecording(0) // never leave a stale session behind
    if (!this.access) return 0
    const sr = state.sampleRate
    let n = 0
    for (const mt of tracks) {
      if (!mt.inId) continue
      const input = this.access.inputs.get(mt.inId)
      if (!input) continue
      const s: RecSession = {
        mt,
        cap: new NoteCapture(),
        startBeat: framesToBeats(nowFrame(), state.bpm, sr)
      }
      this.sessions.push(s)
      input.onmidimessage = (ev) => {
        const m = parseNoteMessage(ev.data ?? [])
        if (!m) return
        // stamp from the event's own time, not "now": the handler can run late
        const lateMs = Math.max(0, performance.now() - (ev.timeStamp || performance.now()))
        const frame = nowFrame() - (lateMs * sr) / 1000
        const beat = Math.max(s.startBeat, framesToBeats(frame, state.bpm, sr))
        if (m.on) s.cap.noteOn(beat, m.key, m.vel)
        else s.cap.noteOff(beat, m.key)
      }
      n++
    }
    this.recording = n > 0
    return n
  }

  /** Stop capturing and turn what was played into one new clip per track. Returns the note count. */
  finishRecording(endFrame: number): number {
    if (!this.sessions.length) {
      this.recording = false
      return 0
    }
    let total = 0
    const endBeat = framesToBeats(endFrame, state.bpm, state.sampleRate)
    for (const s of this.sessions) {
      const input = s.mt.inId ? this.access?.inputs.get(s.mt.inId) : undefined
      if (input) input.onmidimessage = null
      const notes = s.cap.finish(Math.max(endBeat, s.startBeat))
      if (!notes.length) continue
      const start = Math.floor(s.startBeat)
      const end = notes.reduce((m, n) => Math.max(m, n.start + n.dur), start + 1)
      const clip = addMidiClip(s.mt, start, Math.max(1, Math.ceil(end - start)), `take ${s.mt.clips.length + 1}`)
      for (const n of notes) addNote(clip, n.start - start, n.dur, n.key, n.vel)
      total += notes.length
    }
    this.sessions = []
    this.recording = false
    return total
  }
}
