// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * How loud a track plays and how far its loudest moments stick out of it. Pure (unit-tested in Node).
 *
 * The level is the RMS over the stretches that are actually playing (100 ms windows above -60 dBFS), so a
 * sparse part (hi-hat, a vocal that sings twice) is judged on what it does, not diluted by its silence.
 * `stickOutDb` is the loudest 100 ms window over that average: the part that "jumps out". The AI uses both to
 * stage every track near a target level and to tame what still sticks out with the channel strip's compressor.
 */

export interface LevelStats {
  /** RMS of the playing stretches (both channels averaged), dBFS. */
  rmsDb: number
  /** Sample peak, dBFS. */
  peakDb: number
  /** peakDb - rmsDb. */
  crestDb: number
  /** Loudest 100 ms window - rmsDb. */
  stickOutDb: number
  /** Seconds of the track that are playing (above the gate). */
  activeSeconds: number
}

const WINDOW_SECONDS = 0.1
const GATE_MEAN_SQUARE = 1e-6 // -60 dBFS
const toDb = (ms: number): number => (ms > 1e-20 ? 10 * Math.log10(ms) : -200)
const r1 = (x: number): number => Math.round(x * 10) / 10

export class LevelMeter {
  private readonly win: number
  private acc = 0
  private n = 0
  private peak = 0
  private sumMs = 0
  private active = 0
  private maxMs = 0

  constructor(sampleRate: number) {
    this.win = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS))
  }

  /** `count` frames of interleaved stereo. */
  pushInterleaved(block: Float32Array, count: number): void {
    for (let i = 0; i < count; i++) {
      const l = block[i * 2]
      const r = block[i * 2 + 1]
      const al = l < 0 ? -l : l
      const ar = r < 0 ? -r : r
      if (al > this.peak) this.peak = al
      if (ar > this.peak) this.peak = ar
      this.acc += (l * l + r * r) * 0.5
      if (++this.n >= this.win) this.closeWindow()
    }
  }

  private closeWindow(): void {
    const ms = this.acc / this.n
    if (ms >= GATE_MEAN_SQUARE) {
      this.sumMs += ms
      this.active++
      if (ms > this.maxMs) this.maxMs = ms
    }
    this.acc = 0
    this.n = 0
  }

  /** null = nothing above the gate (silent, or muted). */
  finish(): LevelStats | null {
    if (this.n >= this.win / 2) this.closeWindow()
    if (this.active === 0) return null
    const rms = toDb(this.sumMs / this.active)
    const peak = this.peak > 0 ? 20 * Math.log10(this.peak) : -200
    return {
      rmsDb: r1(rms),
      peakDb: r1(peak),
      crestDb: r1(peak - rms),
      stickOutDb: r1(toDb(this.maxMs) - rms),
      activeSeconds: r1(this.active * WINDOW_SECONDS)
    }
  }
}

/** The channel-strip trim that brings a track's output RMS to `targetDb` (limited to ±24 dB, half-dB steps). */
export function suggestTrimDb(currentTrimDb: number, rmsDb: number, targetDb: number): number {
  const t = currentTrimDb + (targetDb - rmsDb)
  return Math.round(Math.max(-24, Math.min(24, t)) * 2) / 2
}
