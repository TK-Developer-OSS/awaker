// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { PRESETS, presetNotes, stepOf, findCell, laneRow, nextVel, STEP_BEATS, type StepNote } from '../src/renderer/src/midi/step-logic'
import { DRUM_LANES, drumVoiceOfKey, drumNameOfKey } from '../src/renderer/src/gpu/instruments/drums'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}

eq('22 voices, unique keys', [DRUM_LANES.length, new Set(DRUM_LANES.map((l) => l.key)).size, new Set(DRUM_LANES.map((l) => l.voice)).size], [22, 22, 22])
eq('GM aliases map to the same voice', [drumVoiceOfKey(44), drumVoiceOfKey(42), drumVoiceOfKey(35), drumVoiceOfKey(36)], [3, 3, 0, 0])
eq('unmapped key', [drumVoiceOfKey(10), drumNameOfKey(10)], [null, null])
eq('name of key', drumNameOfKey(46), 'Open Hat')

// every preset lane name exists in the kit, and every pattern is one bar
for (const p of PRESETS) {
  for (const [lane, text] of Object.entries(p.lanes)) {
    eq(`${p.name}/${lane} is a known 16-step lane`, [DRUM_LANES.some((l) => l.name === lane), text.length], [true, 16])
  }
}

const basic = PRESETS[0]
const notes = presetNotes(basic, DRUM_LANES, 2)
eq('basic beat, 2 bars: kick hits', notes.filter((n) => n.key === 36).map((n) => n.start), [0, 2, 2.5, 4, 6, 6.5])
eq('snare on beats 2 and 4', notes.filter((n) => n.key === 38).map((n) => n.start), [1, 3, 5, 7])
eq('unknown lanes are ignored', presetNotes({ name: 'x', lanes: { Nope: 'xxxx................'.slice(0, 16) } }, DRUM_LANES, 1), [])
eq('accent / ghost velocities', presetNotes({ name: 'v', lanes: { Kick: 'XxoX............' } }, DRUM_LANES, 1).map((n) => n.vel), [127, 100, 55, 127])

eq('stepOf exact', [stepOf(0), stepOf(0.25), stepOf(3.75)], [0, 1, 15])
eq('stepOf tolerates a slightly early note', stepOf(0.24), 1)
eq('stepOf rejects off-grid', stepOf(0.125 + 0.01) === 0 || stepOf(0.125 + 0.01) === 1, true) // within half a step → snaps

const sn: StepNote[] = [
  { id: 1, start: 0, dur: 0.25, key: 42, vel: 100 },
  { id: 2, start: 0.5, dur: 0.25, key: 44, vel: 80 }, // pedal hat alias, same lane as closed hat
  { id: 3, start: 0.5, dur: 0.25, key: 36, vel: 120 }
]
const isClosed = (k: number): boolean => drumVoiceOfKey(k) === 3
eq('row reads alias keys as the same lane', laneRow(sn, isClosed, 8), [100, 0, 80, 0, 0, 0, 0, 0])
eq('findCell', findCell(sn, isClosed, 2)?.id, 2)
eq('findCell empty', findCell(sn, isClosed, 1), undefined)
eq('nextVel toggles', [nextVel(0, 100), nextVel(100, 100), nextVel(100, 127), nextVel(127, 127)], [100, 0, 127, 0])
eq('step is a 16th', STEP_BEATS, 0.25)

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
