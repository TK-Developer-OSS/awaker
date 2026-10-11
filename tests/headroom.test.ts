// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { planHeadroom } from '../src/renderer/src/audio/headroom'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}
const near = (a: number, b: number, t = 1e-9): boolean => Math.abs(a - b) <= t

{
  const p = planHeadroom([-6, -3, 4, 2.2, -20], [])
  check('every track goes down by the same amount: the loudest peak (+4.0) lands 0.5 dB under 0', near(p.trackDropDb, 4.5) && near(p.worstAfterDb, -0.5), JSON.stringify(p))
  check('the worst before is reported', near(p.worstBeforeDb, 4))
}
{
  const p = planHeadroom([-6, -3, -1.2], [])
  check('nothing is over: nothing moves', p.trackDropDb === 0 && p.worstAfterDb === -1.2)
}
{
  const p = planHeadroom([-0.2], [], 0.5)
  check('a peak inside the margin still moves (0.3 dB) so the meter has room', near(p.trackDropDb, 0.3) && near(p.worstAfterDb, -0.5), String(p.trackDropDb))
}
{
  const p = planHeadroom([2.04], [])
  check('the drop is rounded UP to 0.1 dB, never leaving a sliver of red', near(p.trackDropDb, 2.6) && p.worstAfterDb <= -0.5 + 1e-9, String(p.trackDropDb))
}
{
  // tracks fine after a 3 dB drop, but a group sum is at +6: it needs 3 more dB of its own
  const p = planHeadroom([2.5, 0, -3], [6, -8], 0.5)
  check('track drop 3.0 dB', near(p.trackDropDb, 3.0))
  check('the group that is still over gets the rest on its own fader (6 - 3 = +3 → 3.5 dB)', near(p.groupExtraDb[0], 3.5) && p.groupExtraDb[1] === 0, JSON.stringify(p.groupExtraDb))
  check('everything ends under the margin', p.worstAfterDb <= -0.5 + 1e-9, String(p.worstAfterDb))
}
{
  const p = planHeadroom([-Infinity, -Infinity], [-Infinity])
  check('silence: nothing to do', p.trackDropDb === 0 && p.groupExtraDb[0] === 0)
}
{
  const p = planHeadroom([1], [-30], 0)
  check('margin 0: ends exactly at 0 dBFS', near(p.trackDropDb, 1.0) && near(p.worstAfterDb, 0))
}

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
