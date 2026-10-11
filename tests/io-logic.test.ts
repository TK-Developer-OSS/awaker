// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { planWindow, NoteCapture, parseNoteMessage } from '../src/renderer/src/midi/io-logic'
import type { MidiTrack } from '../src/renderer/src/midi/model'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}

const mk = (id: number, outId: string | null): MidiTrack => ({
  id, name: 't' + id, channel: 0, mute: false, solo: false, outId, inId: null, instrument: null,
  clips: [{ id: 1, name: 'c', start: 4, length: 4, notes: [
    { id: 1, start: 0, dur: 1, key: 60, vel: 100 },
    { id: 2, start: 1, dur: 1, key: 60, vel: 90 }, // same key, retrigger exactly when note 1 ends
    { id: 3, start: 2, dur: 0.5, key: 64, vel: 80 }
  ] }]
})
const b2f = (b: number): number => b * 1000 // 1000 frames per beat

const t = [mk(1, 'portA'), mk(2, null)]
eq('track without a port is skipped', planWindow(t, () => true, 0, 1e9, b2f).every((e) => e.trackId === 1), true)
const all = planWindow(t, () => true, 0, 1e9, b2f)
eq('6 events', all.length, 6)
eq('note on at clip.start + note.start', all[0], { trackId: 1, frame: 4000, kind: 'on', key: 60, vel: 100 })
eq('off before on at the same frame', [all[1].kind, all[2].kind, all[1].frame === all[2].frame], ['off', 'on', true])
eq('window is half-open', planWindow(t, () => true, 4000, 5000, b2f).map((e) => e.kind), ['on'])
eq('window end exclusive', planWindow(t, () => true, 5000, 6000, b2f).map((e) => e.kind), ['off', 'on'])
eq('inaudible track skipped', planWindow(t, () => false, 0, 1e9, b2f), [])
eq('adjacent windows do not duplicate', [...planWindow(t, () => true, 0, 5000, b2f), ...planWindow(t, () => true, 5000, 1e9, b2f)].length, 6)

const cap = new NoteCapture()
cap.noteOn(1.0, 60, 100)
cap.noteOn(1.5, 64, 70)
cap.noteOff(2.0, 60)
cap.noteOn(2.5, 60, 0) // clamps to vel 1
eq('capture closes held notes', cap.finish(3.0).map((n) => [n.start, n.dur, n.key, n.vel]), [[1, 1, 60, 100], [1.5, 1.5, 64, 70], [2.5, 0.5, 60, 1]])
const c2 = new NoteCapture()
c2.noteOff(1, 60) // stray off is ignored
eq('stray note-off ignored', c2.finish(2), [])

eq('parse note on', parseNoteMessage([0x93, 60, 100]), { on: true, channel: 3, key: 60, vel: 100 })
eq('parse vel0 as off', parseNoteMessage([0x90, 60, 0]), { on: false, channel: 0, key: 60, vel: 0 })
eq('parse note off', parseNoteMessage([0x80, 62, 64]), { on: false, channel: 0, key: 62, vel: 0 })
eq('ignore cc', parseNoteMessage([0xb0, 7, 100]), null)
eq('ignore short', parseNoteMessage([0x90, 60]), null)

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
