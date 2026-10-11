// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { decodeRelative, panRing, posToDb, dbToPos } from '../src/renderer/src/control/mcu'
let fails = 0
const eq = (n: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', n, ok ? '' : `got ${JSON.stringify(a)} exp ${JSON.stringify(b)}`)
}
eq('cw 1 tick', decodeRelative(0x01), 1)
eq('cw 5 ticks', decodeRelative(0x05), 5)
eq('ccw 1 tick', decodeRelative(0x41), -1)
eq('ccw 3 ticks', decodeRelative(0x43), -3)
eq('ring left', panRing(-1), 1)
eq('ring centre', panRing(0), 6)
eq('ring right', panRing(1), 11)
eq('ring clamps', [panRing(-5), panRing(5)], [1, 11])
eq('fader unity', Math.abs(posToDb(0.75)) < 1e-9, true)
eq('fader round trip', Math.abs(posToDb(dbToPos(-12)) + 12) < 0.05, true)
for (const db of [-60,-48,-24,-12,-6,-1,0,3,6]) eq('round trip '+db, Math.abs(posToDb(dbToPos(db)) - db) < 0.05, true)
eq('never NaN', [-100,-60,-30,0,6,20].every((d) => Number.isFinite(dbToPos(d))), true)
console.log(fails ? `${fails} FAILED` : 'ALL OK')
process.exit(fails ? 1 : 0)
