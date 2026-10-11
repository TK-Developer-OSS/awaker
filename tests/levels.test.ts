// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { LevelMeter, suggestTrimDb } from '../src/renderer/src/audio/levels'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const SR = 48000

function sine(seconds: number, amp: number, hz = 440): Float32Array {
  const n = Math.round(SR * seconds)
  const o = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin((2 * Math.PI * hz * i) / SR)
    o[i * 2] = v
    o[i * 2 + 1] = v
  }
  return o
}
const run = (x: Float32Array): ReturnType<LevelMeter['finish']> => {
  const m = new LevelMeter(SR)
  // feed in awkward blocks
  for (let at = 0; at < x.length / 2; ) {
    const c = Math.min(777, x.length / 2 - at)
    m.pushInterleaved(x.subarray(at * 2, (at + c) * 2), c)
    at += c
  }
  return m.finish()
}

{
  const s = run(sine(3, 0.5))
  check('sine 0.5: RMS -9.0 dB, peak -6.0 dB, crest 3 dB', !!s && near(s.rmsDb, -9.03, 0.1) && near(s.peakDb, -6.02, 0.1) && near(s.crestDb, 3.0, 0.15), JSON.stringify(s))
  check('a steady tone does not stick out', !!s && near(s.stickOutDb, 0, 0.15))
  check('active time = its length', !!s && near(s.activeSeconds, 3, 0.15))
}
{
  // 2 s of -30 dB tone, then 0.3 s of a loud burst, then 2 s of -30 dB again
  const a = sine(2, 0.0316)
  const b = sine(0.3, 0.5)
  const x = new Float32Array(a.length * 2 + b.length)
  x.set(a, 0)
  x.set(b, a.length)
  x.set(a, a.length + b.length)
  const s = run(x)
  check('a burst over a quiet bed sticks out by about its difference from the average (-9 dB window over -20.4 dB)', !!s && near(s.stickOutDb, 11.4, 0.6), JSON.stringify(s))
  check('the average is dominated by the bed, not the burst', !!s && s.rmsDb < -20, JSON.stringify(s))
  check('the peak is the burst', !!s && near(s.peakDb, -6.02, 0.1))
}
{
  // sparse part: 0.2 s of tone in 10 s of silence is judged on the tone
  const t = sine(0.2, 0.25)
  const x = new Float32Array(SR * 10 * 2)
  x.set(t, SR * 4 * 2)
  const s = run(x)
  check('silence around a part does not dilute its level', !!s && near(s.rmsDb, -15.05, 0.7), JSON.stringify(s))
  check('only the playing part counts as active', !!s && s.activeSeconds <= 0.4)
}
check('a silent track has no level', run(new Float32Array(SR * 2 * 2)) === null)
check('suggested trim moves the level to the target', suggestTrimDb(0, -25, -18) === 7 && suggestTrimDb(-3, -12, -18) === -9)
check('suggested trim is limited and in half-dB steps', suggestTrimDb(0, -80, -18) === 24 && suggestTrimDb(0, 20, -18) === -24 && suggestTrimDb(0, -20.3, -18) === 2.5)

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
