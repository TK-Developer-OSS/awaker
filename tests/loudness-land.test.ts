// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { landLoudness } from '../src/renderer/src/audio/loudness-land'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

/** A master chain seen from the fader: gain into a limiter, so the output answers less than the fader moves. */
function limiter(drive: number, knee: number, ceilingLufs: number) {
  let calls = 0
  const f = async (g: number): Promise<number> => {
    calls++
    const x = g + drive // level into the limiter
    // below the knee: 1 LU per dB; above it: compressed (0.3 LU per dB) towards a ceiling
    const lufs = x <= knee ? x : Math.min(ceilingLufs, knee + (x - knee) * 0.3)
    return lufs
  }
  return { f, calls: () => calls }
}

async function main(): Promise<void> {
{
  const m = limiter(1.5, -16, -8)
  const r = await landLoudness(-10, m.f)
  check('lands within the tolerance from a loud start (-8.5 LUFS in, -14 out)', r.reached && Math.abs(r.lufs + 14) <= 0.3, `${r.lufs.toFixed(2)} LUFS at ${r.gainDb.toFixed(2)} dB in ${r.steps.length} steps`)
  check('it takes a handful of renders, not dozens', m.calls() <= 6, `${m.calls()} renders`)
}
{
  // a limiter that is working hard: the fader moved 10 dB changes the output by only a few LU
  // 0.3 LU out per dB in: the fader has to move far for a small change at the output
  const m = limiter(30, -30, -6)
  const r = await landLoudness(0, m.f, { target: -14 })
  check('a heavily limited chain (0.3 LU per dB) still converges', r.reached && Math.abs(r.lufs + 14) <= 0.3, `${r.lufs.toFixed(2)} LUFS at ${r.gainDb.toFixed(2)} dB, ${r.steps.length} steps`)
  check('...and it needed to move the fader a long way (about -7 dB), which a 1:1 guess would have missed', r.gainDb < -5 && r.gainDb > -9, `${r.gainDb.toFixed(2)} dB`)
}
{
  const m = limiter(0, -10, 0)
  const r = await landLoudness(-30, m.f, { target: -14 })
  check('a quiet mix is raised to the target', r.reached && r.gainDb > -30 && Math.abs(r.lufs + 14) <= 0.3, `${r.lufs.toFixed(2)} LUFS at ${r.gainDb.toFixed(2)} dB`)
}
{
  const m = limiter(-30, -100, 0) // so quiet that even the top of the fader is below the target
  const r = await landLoudness(0, m.f, { target: -14 })
  check('a mix that cannot get there says so (fader limit) and keeps the closest', !r.reached && r.reason === 'fader limit' && r.gainDb === 6, `${r.reason}, ${r.lufs.toFixed(1)} LUFS at ${r.gainDb} dB`)
}
{
  // a fader with 0.5 dB steps: every value that is measured, reported and left is one the fader really has
  const seen: number[] = []
  const m = limiter(1.5, -16, -8)
  const r = await landLoudness(-10, async (g) => { seen.push(g); return m.f(g) }, { target: -14, quantizeDb: 0.5 })
  check('quantized: every measured fader value is a multiple of 0.5 dB', seen.every((g) => Math.abs(g * 2 - Math.round(g * 2)) < 1e-9), seen.join(' '))
  check('quantized: the value left is one that was measured, and it lands within tolerance', r.steps.some((s) => s.gainDb === r.gainDb) && Math.abs(r.lufs + 14) <= 0.3 + 0.5, `${r.gainDb} dB → ${r.lufs.toFixed(2)} LUFS`)
}
{
  const r = await landLoudness(-10, async () => -Infinity)
  check('silence is reported, not chased', !r.reached && r.reason === 'silent' && r.gainDb === -10)
}
{
  const m = limiter(1.5, -16, -8)
  const r = await landLoudness(-10, m.f, { target: -14, tolerance: 0.001, maxIterations: 2 })
  check('stops at the iteration limit and returns the best step it measured', r.steps.length <= 2 && r.steps.some((s) => s.gainDb === r.gainDb))
}
{
  let seen = -99
  const r = await landLoudness(-10, async (g) => { seen = g; return -14 + (g + 10) * 0.9 }, { target: -14 })
  check('already on target: one render, nothing moved', r.reached && r.steps.length === 1 && r.gainDb === -10 && seen === -10)
}
{
  // a flat stretch (limiter pinned): the step is bounded
  const gains: number[] = []
  await landLoudness(0, async (g) => { gains.push(g); return -6 }, { target: -14, maxIterations: 3 })
  const jumps = gains.slice(1).map((g, i) => Math.abs(g - gains[i]))
  check('one step never moves the fader more than 12 dB', jumps.every((j) => j <= 12.0001), gains.map((g) => g.toFixed(1)).join(' → '))
}

}

void main().then(() => {
  if (fails) {
    console.log(`${fails} FAILED`)
    process.exit(1)
  }
  console.log('ALL OK')
})
