// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { buildDawprojectXml, type ExpProject } from '../src/renderer/src/project/dawproject-export'
import { parseDawproject } from '../src/renderer/src/project/dawproject-import'


let fails = 0
const eq = (n: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', n, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}

const p: ExpProject = {
  bpm: 150,
  timeSig: { num: 3, den: 4 },
  masterGainDb: -2,
  sources: [
    { id: 1, file: 'audio/001_kick & sub.wav', sampleRate: 48000, channels: 2, durationSec: 30 },
    { id: 2, file: 'audio/002_loop.wav', sampleRate: 44100, channels: 1, durationSec: 10 }
  ],
  tracks: [
    {
      kind: 'audio', name: 'Kick & "Sub" <1>', gainDb: -6.0206, pan: -0.5, mute: false, solo: true, channels: 2, midiClips: [],
      audioClips: [
        { sourceId: 1, name: 'kick take', startSec: 1.6, offsetSec: 0.5, lengthSec: 3.2, fadeInSec: 0.01, fadeOutSec: 0.2 },
        { sourceId: 2, name: 'loop', startSec: 6.4, offsetSec: 0, lengthSec: 1.6, fadeInSec: 0, fadeOutSec: 0 },
        { sourceId: 99, name: 'dangling source is dropped', startSec: 0, offsetSec: 0, lengthSec: 1, fadeInSec: 0, fadeOutSec: 0 }
      ]
    },
    {
      kind: 'notes', name: 'Lead', gainDb: 0, pan: 0.5, mute: true, solo: false, channels: 2, audioClips: [],
      midiClips: [{ name: 'riff', startBeats: 4, lengthBeats: 4, notes: [{ start: 0, dur: 0.5, key: 60, vel: 64 }, { start: 1, dur: 1.5, key: 64, vel: 127 }] }]
    }
  ]
}
const xml = buildDawprojectXml(p)


// round trip through our own importer
const r = parseDawproject(xml)
eq('bpm', r.bpm, 150)
eq('timeSig', r.timeSig, { num: 3, den: 4 })
eq('master dB', Math.round(r.masterGainDb * 100) / 100, -2)
eq('track names (escaped)', r.tracks.map((t) => t.name), ['Kick & "Sub" <1>', 'Lead'])
eq('audio mix', [Math.round(r.tracks[0].gainDb * 100) / 100, r.tracks[0].pan, r.tracks[0].solo], [-6.02, -0.5, true])
eq('audio clips (dangling dropped)', r.tracks[0].audioClips.map((c) => [c.file, c.startSec, c.srcOffsetSec, c.lengthSec, c.fadeInSec, c.fadeOutSec]),
  [['audio/001_kick & sub.wav', 1.6, 0.5, 3.2, 0.01, 0.2], ['audio/002_loop.wav', 6.4, 0, 1.6, 0, 0]])
eq('note track', [r.tracks[1].kind, r.tracks[1].mute, r.tracks[1].pan], ['notes', true, 0.5])
eq('midi notes', r.tracks[1].midiClips[0].notes.map((n) => [n.startBeats, n.durBeats, n.key, n.vel]), [[4, 0.5, 60, 64], [5, 1.5, 64, 127]])
eq('no warnings', r.warnings, [])
console.log(fails ? `${fails} FAILED` : 'ROUND TRIP OK')
process.exit(fails ? 1 : 0)
