// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { humanizePreset, humanizeShiftMs, humanizeVel, isDrumTrack, noteRandom, trackFillHeads } from '../src/renderer/src/midi/humanize'
import { planWindow } from '../src/renderer/src/midi/io-logic'
import type { MidiTrack } from '../src/renderer/src/midi/model'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}

const rock = humanizePreset('rock8')
const drum = { drum: true }
eq('off is no preset', humanizePreset('off'), undefined)
eq('old "strong" id maps onto rock8', humanizePreset('rock8-strong')?.id, 'rock8')
eq('kick on 1 stays on the grid', humanizeShiftMs(rock, 4, 1, { ...drum, key: 36 }), 0)
eq('snare on 2 stays on the grid', humanizeShiftMs(rock, 1, 1, { ...drum, key: 38 }), 0)
eq('snare on 4 pushed', humanizeShiftMs(rock, 3, 1, { ...drum, key: 38 }), -2)
eq('snare on 4 of the next bar pushed', humanizeShiftMs(rock, 7, 1, { ...drum, key: 38 }), -2)
eq('key 38 on beat 4 of a non-drum track stays', humanizeShiftMs(rock, 3, 1, { key: 38 }), 0)
eq('off-beat pushed', humanizeShiftMs(rock, 2.5, 1, { ...drum, key: 42 }), -2)
eq('16th left alone', humanizeShiftMs(rock, 2.25), 0)
eq('strength 150 % = 3 ms', humanizeShiftMs(rock, 2.5, 1.5), -3)
eq('strength 50 % = 1 ms', humanizeShiftMs(rock, 2.5, 0.5), -1)
eq('3/4: the last beat is beat 3', humanizeShiftMs(rock, 2, 1, { ...drum, key: 38, barBeats: 3 }), -2)

// velocity: only the snare on 4, about 10 % softer (6..14 %), the same every time
const v4 = humanizeVel(rock, 3, 100, 1, { ...drum, key: 38 })
eq('snare on 4 softer by 6..14 %', v4 >= 86 && v4 <= 94, true)
eq('the same note gets the same velocity', humanizeVel(rock, 3, 100, 1, { ...drum, key: 38 }), v4)
eq('snare on 2 keeps its velocity', humanizeVel(rock, 1, 100, 1, { ...drum, key: 38 }), 100)
eq('kick on 4 keeps its velocity', humanizeVel(rock, 3, 100, 1, { ...drum, key: 36 }), 100)
const vs = [3, 7, 11, 15, 19, 23, 27, 31].map((b) => humanizeVel(rock, b, 100, 1, { ...drum, key: 38 }))
eq('it varies bar to bar', new Set(vs).size > 2, true)
eq('strength 0 = untouched', humanizeVel(rock, 3, 100, 0, { ...drum, key: 38 }), 100)
let lo = 1, hi = -1
for (let i = 0; i < 2000; i++) {
  const r = noteRandom(i * 0.25, 30 + (i % 50))
  lo = Math.min(lo, r)
  hi = Math.max(hi, r)
}
eq('note random stays in [-1, 1)', lo >= -1 && hi < 1, true)
eq('drum track: drum machine or channel 10', [isDrumTrack({ channel: 0, instrument: { kind: 'drums' } }), isDrumTrack({ channel: 9 }), isDrumTrack({ channel: 0 })], [true, true, false])

// tom fills: the first two onsets of each fill lean ahead
const fill = [
  { start: 2, key: 50 }, { start: 2.25, key: 48 }, { start: 2.5, key: 45 }, { start: 2.75, key: 41 },
  { start: 5, key: 48 }, { start: 5, key: 45 }, { start: 5.25, key: 43 }, { start: 5.5, key: 41 },
  { start: 5.5, key: 36 }
]
const heads = trackFillHeads([{ start: 0, notes: fill }])
eq('fill heads: first two onsets of each fill, chords count once, no kick', fill.map((n) => heads.has(n)), [true, true, false, false, true, true, true, false, false])
eq('a fill head is pushed', humanizeShiftMs(rock, 2.25, 1, { ...drum, key: 48, fillHead: true }), -2)
eq('the rest of the fill stays', humanizeShiftMs(rock, 2.75, 1, { ...drum, key: 41 }), 0)
eq('fill head on a non-drum track stays', humanizeShiftMs(rock, 2.25, 1, { key: 48, fillHead: true }), 0)

const t: MidiTrack = {
  id: 1, name: 't', channel: 9, mute: false, solo: false, outId: 'p', inId: null, instrument: null, humanize: 'rock8',
  clips: [{ id: 1, name: 'c', start: 0, length: 4, notes: [
    { id: 1, start: 0, dur: 0.5, key: 36, vel: 100 },
    { id: 2, start: 1.5, dur: 0.25, key: 42, vel: 100 },
    { id: 3, start: 3, dur: 0.25, key: 38, vel: 100 }
  ] }]
}
const fpb = 48000 // 120 BPM at 96 kHz
const ons = planWindow([t], () => true, 0, 1e9, (b) => b * fpb, 96).filter((e) => e.kind === 'on')
eq('MIDI out: kick on 1 on the grid, off-beat and snare on 4 earlier', ons.map((e) => e.frame), [0, 1.5 * fpb - 2 * 96, 3 * fpb - 2 * 96])
eq('MIDI out: the snare on 4 is softer, the others are not', ons.map((e) => e.vel), [100, 100, v4])
eq('the stored note stays on the grid', t.clips[0].notes[2].start, 3)
eq('no framesPerMs = no shift', planWindow([t], () => true, 0, 1e9, (b) => b * 1000).filter((e) => e.kind === 'on')[1].frame, 1500)

if (fails) {
  console.error(`${fails} failed`)
  process.exit(1)
}
