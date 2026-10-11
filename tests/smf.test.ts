// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { parseSmf, writeSmf } from '../src/renderer/src/midi/smf'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}

// 1. round trip
const src = [
  { name: 'Lead', channel: 0, notes: [{ tick: 0, dur: 480, key: 60, vel: 100 }, { tick: 480, dur: 240, key: 64, vel: 80 }, { tick: 480, dur: 960, key: 67, vel: 127 }] },
  { name: 'Bass', channel: 2, notes: [{ tick: 0, dur: 1920, key: 36, vel: 90 }, { tick: 0, dur: 100, key: 36, vel: 90 }] }
]
const bytes = writeSmf(src, { ppq: 480, bpm: 128, timeSig: { num: 6, den: 8 } })
const back = parseSmf(bytes)
eq('ppq', back.ppq, 480)
eq('bpm', Math.round(back.bpm * 100) / 100, 128)
eq('timeSig', back.timeSig, { num: 6, den: 8 })
eq('tracks', back.tracks.map((t) => [t.name, t.channel, t.notes.length]), [['Lead', 0, 3], ['Bass', 2, 2]])
eq('lead notes', back.tracks[0].notes.map((n) => [n.tick, n.dur, n.key, n.vel]), [[0, 480, 60, 100], [480, 240, 64, 80], [480, 960, 67, 127]])
eq('overlapping same-key notes pair FIFO', back.tracks[1].notes.map((n) => [n.tick, n.dur]), [[0, 100], [0, 1920]].sort((a, b) => a[0] - b[0] || 0))

// 2. hand-made format 0: running status, note-on vel 0 as off, two channels, tempo 500000 (120)
const f0 = Uint8Array.from([
  0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, // MThd fmt0, 1 track, ppq 480
  0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0x2a,
  0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo
  0x00, 0x90, 60, 100, // ch0 on
  0x00, 62, 90, // running status: ch0 on key 62
  0x00, 0x91, 72, 64, // ch1 on
  0x83, 0x60, 0x90, 60, 0, // delta 480: note-on vel 0 = off (key 60)
  0x00, 62, 0, // running: off key 62
  0x00, 0x81, 72, 0, // ch1 off
  0x00, 0xff, 0x2f, 0x00
])
// patch the chunk length to the real size
const body = f0.length - 22
f0[21] = body
const p0 = parseSmf(f0)
eq('fmt0 split by channel', p0.tracks.map((t) => [t.channel, t.notes.map((n) => [n.tick, n.dur, n.key])]), [[0, [[0, 480, 60], [0, 480, 62]]], [1, [[0, 480, 72]]]])
eq('fmt0 tempo', Math.round(p0.bpm), 120)

// 3. garbage
let threw = false
try { parseSmf(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])) } catch { threw = true }
eq('rejects non-midi', threw, true)

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
