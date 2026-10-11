// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Landing the master at a target integrated loudness (e.g. -14 LUFS) with the master fader.
 *
 * The master fader acts on the way INTO the master chain (EQ / bus comp / maximizer), so the final loudness is not
 * a 1:1 function of it: a limiter at the end keeps the output near its ceiling and answers less than the fader
 * moved. The only safe way is to measure, move, and measure again. This is the search for that, pure (the render
 * is a function handed in), so it is unit-tested with a synthetic limiter in Node.
 */

export interface LandOptions {
  /** Target integrated loudness, LUFS. */
  target: number
  /** Accept when within this many LU of the target. */
  tolerance: number
  maxIterations: number
  minGainDb: number
  maxGainDb: number
  /** Largest fader move in one step, dB (guards against a flat stretch of the curve). */
  maxStepDb: number
  /** The fader moves in steps of this many dB (the master fader is 0.5 dB); 0 = continuous. */
  quantizeDb: number
}

export const DEFAULT_LAND: LandOptions = {
  target: -14,
  tolerance: 0.3,
  maxIterations: 8,
  minGainDb: -60,
  maxGainDb: 6,
  maxStepDb: 12,
  quantizeDb: 0
}

export interface LandStep {
  gainDb: number
  lufs: number
}

export interface LandResult {
  reached: boolean
  /** The fader value to leave the master at (the best one measured). */
  gainDb: number
  lufs: number
  steps: LandStep[]
  /** 'reached' | 'silent' | 'fader limit' | 'no change' | 'iteration limit'. */
  reason: string
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x))

/**
 * @param startGainDb the fader now
 * @param measure render the song at this fader value and return the integrated loudness (LUFS; -Infinity = silent)
 */
export async function landLoudness(
  startGainDb: number,
  measure: (gainDb: number) => Promise<number>,
  opts: Partial<LandOptions> = {}
): Promise<LandResult> {
  const o: LandOptions = { ...DEFAULT_LAND, ...opts }
  const steps: LandStep[] = []
  const best = (): LandStep => steps.reduce((a, b) => (Math.abs(b.lufs - o.target) < Math.abs(a.lufs - o.target) ? b : a))
  // the fader cannot take values between its steps: search on the values it really has, so what is reported
  // (and left) is what was measured
  const snap = (x: number): number => (o.quantizeDb > 0 ? Math.round(x / o.quantizeDb) * o.quantizeDb : x)
  let g = snap(clamp(startGainDb, o.minGainDb, o.maxGainDb))

  for (let i = 0; i < o.maxIterations; i++) {
    const lufs = await measure(g)
    if (!Number.isFinite(lufs)) {
      return { reached: false, gainDb: startGainDb, lufs, steps, reason: 'silent' }
    }
    steps.push({ gainDb: g, lufs })
    const err = o.target - lufs
    if (Math.abs(err) <= o.tolerance) {
      return { reached: true, gainDb: g, lufs, steps, reason: 'reached' }
    }
    // how many LU the output moves per dB of fader: 1 until the first two points say otherwise
    let slope = 1
    if (steps.length >= 2) {
      const a = steps[steps.length - 2]
      const b = steps[steps.length - 1]
      if (Math.abs(b.gainDb - a.gainDb) > 1e-6) {
        const s = (b.lufs - a.lufs) / (b.gainDb - a.gainDb)
        if (Number.isFinite(s) && s > 0.05) slope = clamp(s, 0.1, 2)
      }
    }
    const step = clamp(err / slope, -o.maxStepDb, o.maxStepDb)
    const next = snap(clamp(g + step, o.minGainDb, o.maxGainDb))
    if (Math.abs(next - g) < 0.05) {
      const b = best()
      return { reached: false, gainDb: b.gainDb, lufs: b.lufs, steps, reason: next === o.maxGainDb || next === o.minGainDb ? 'fader limit' : 'no change' }
    }
    g = next
  }
  const b = best()
  return { reached: false, gainDb: b.gainDb, lufs: b.lufs, steps, reason: 'iteration limit' }
}
