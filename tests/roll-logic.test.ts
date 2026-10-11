// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import * as R from '../src/renderer/src/midi/roll-logic'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}

const v: R.RollView = { pxPerBeat: 80, rowH: 12, scrollBeats: 2, topKey: 72 }
eq('beat<->x', R.xToBeat(v, R.beatToX(v, 5.25)), 5.25)
eq('key at y', R.yToKey(v, R.keyToY(v, 60) + 5), 60)
eq('key row top', R.keyToY(v, 72), 0)

const notes: R.RollNote[] = [
  { id: 1, start: 2, dur: 1, key: 72, vel: 100 },
  { id: 2, start: 3, dur: 0.5, key: 70, vel: 100 }
]
// note 1 occupies x 0..80, y 0..12
eq('hit body', R.hitTest(v, notes, 20, 5), { id: 1, zone: 'body' })
eq('hit right edge', R.hitTest(v, notes, 77, 5), { id: 1, zone: 'right' })
eq('miss', R.hitTest(v, notes, 200, 5), null)
eq('second note', R.hitTest(v, notes, 100 + 2, 24 + 3)?.id, 2)

eq('marquee', R.notesInRect(v, notes, 0, 0, 90, 14), [1])
eq('marquee both', R.notesInRect(v, notes, 0, 0, 200, 40).sort(), [1, 2])

eq('grid 1/16', R.gridBeats('1/16'), 0.25)
eq('snap', R.snapNearest(1.37, 0.25), 1.25)

const org = [{ id: 1, start: 2, dur: 1, key: 72 }, { id: 2, start: 3, dur: 0.5, key: 70 }]
const m = R.moveNotes(org, 1, 0.6, -3, 0.25) // grabbed note 2.6 → snaps 2.5
eq('move snapped by grabbed note', [m.get(1), m.get(2)], [{ start: 2.5, key: 69 }, { start: 3.5, key: 67 }])
const m2 = R.moveNotes(org, 1, -10, 100, 0.25) // clamp: start ≥ 0 and key ≤ 127 as a group
eq('move clamps as a group', [m2.get(1), m2.get(2)], [{ start: 0, key: 127 }, { start: 1, key: 125 }])

const rz = R.resizeNotes(org, 1, 0.9, 0.25) // end 3.9 → 4.0 → dur 2
eq('resize', [rz.get(1), rz.get(2)], [1.75 + 0.25, 0.5 + 1])
const rz2 = R.resizeNotes(org, 1, -5, 0.25)
eq('resize min', rz2.get(1), 0.25)

eq('line step', R.gridLineStep(80), 0.25 > 14 / 80 ? 0.25 : 0.5)
console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
