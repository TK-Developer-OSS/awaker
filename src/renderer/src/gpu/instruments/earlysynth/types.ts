// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * FM synth parameter types, the algorithm (routing) table and small constructors. Kept apart
 * from fm.ts so the preset table can use them without an import cycle.
 *
 * Routing is a matrix: `mod[i][j]` (j > i) is how much operator j phase-modulates operator
 * i; `out[i]` is operator i's level in the output. Operators with `out[i] === 0` are pure
 * modulators and follow the `index` macro.
 */

export const EARLY_OPS = 4

export interface EarlySynthOp {
  /** Frequency ratio to the note (1 = fundamental). */
  ratio: number
  /** Detune in cents. */
  fine: number
  /** Fixed frequency in Hz (0 = follow the note). */
  fixedHz: number
  /** Carrier: amplitude. Modulator: modulation depth (peak phase deviation = level × 8 rad). */
  level: number
  /** 0..1: how much velocity scales the level (a modulator gets brighter when hit harder). */
  velSens: number
  /** Seconds: attack (floored at 0.3 ms), time to fall ~40 dB during decay, sustain level 0..1, release (~40 dB). */
  atk: number
  dec: number
  sus: number
  rel: number
}

export interface EarlySynthParams {
  /** Name of the preset these values came from (informational). */
  preset: string
  algo: string
  ops: EarlySynthOp[]
  /** mod[i][j]: operator j → operator i (only j > i is used). */
  mod: number[][]
  out: number[]
  /** Self-feedback on one operator. */
  feedback: { op: number; amount: number }
  /** Macro: scales every pure modulator's level (1 = as designed). */
  index: number
  /** Noise tick on every hit, 0..1. */
  click: number
  /** Initial pitch excess in semitones, falling away over `pitchTime` seconds. */
  pitchPunch: number
  pitchTime: number
  /** Macros: scale every operator's attack / release. */
  atkScale: number
  relScale: number
  gain: number
}

export interface EarlyAlgorithm {
  name: string
  mod: number[][]
  out: number[]
}

const matrix = (pairs: [number, number][]): number[][] => {
  const m = Array.from({ length: EARLY_OPS }, () => new Array<number>(EARLY_OPS).fill(0))
  for (const [i, j] of pairs) m[i][j] = 1
  return m
}

export const EARLY_ALGORITHMS: Record<string, EarlyAlgorithm> = {
  serial: { name: 'serial 3→2→1→0', mod: matrix([[2, 3], [1, 2], [0, 1]]), out: [1, 0, 0, 0] },
  stack2: { name: 'two stacks', mod: matrix([[2, 3], [0, 1]]), out: [1, 0, 1, 0] },
  fan: { name: 'fan 1,2,3→0', mod: matrix([[0, 1], [0, 2], [0, 3]]), out: [1, 0, 0, 0] },
  y: { name: 'Y (2,3→1→0)', mod: matrix([[0, 1], [1, 2], [1, 3]]), out: [1, 0, 0, 0] },
  branch: { name: 'branch (3→1,2)', mod: matrix([[2, 3], [1, 3]]), out: [1, 1, 1, 0] },
  chainSolo: { name: 'chain + solo', mod: matrix([[2, 3], [1, 2]]), out: [1, 1, 0, 0] },
  additive: { name: 'additive', mod: matrix([]), out: [1, 1, 1, 1] }
}

export const defaultEarlyOp = (): EarlySynthOp => ({ ratio: 1, fine: 0, fixedHz: 0, level: 0, velSens: 0.5, atk: 0.001, dec: 0.3, sus: 0.6, rel: 0.15 })

