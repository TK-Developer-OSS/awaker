// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { EARLY_ALGORITHMS, defaultEarlyOp, type EarlySynthOp, type EarlySynthParams } from './types'

/**
 * Factory presets for the FM synth, written from scratch (no patch data from any existing
 * instrument). Aimed at electropop: punchy basses, plucks, keys, stabs, leads. Every preset
 * is dry — add chorus / delay / reverb on the track's inserts — and hits hard: attacks are
 * sub-millisecond for the percussive ones, with a short noise `click` and a quick pitch drop
 * where it helps.
 *
 * op(ratio, level, atk, dec, sus, rel, velSens, fine): `dec` / `rel` are times to fall ~40 dB.
 * Operator j can only modulate operator i when j > i (see fm-types.ts).
 */

const op = (ratio: number, level: number, atk: number, dec: number, sus: number, rel: number, velSens = 0.5, fine = 0): EarlySynthOp => ({
  ...defaultEarlyOp(),
  ratio,
  level,
  atk,
  dec,
  sus,
  rel,
  velSens,
  fine
})
const silent = (): EarlySynthOp => op(1, 0, 0.001, 0.1, 0, 0.05)

interface Spec {
  algo: keyof typeof EARLY_ALGORITHMS
  ops: EarlySynthOp[]
  /** Overrides the algorithm's default output mix. */
  out?: number[]
  fb?: { op: number; amount: number }
  click?: number
  punch?: number
  punchTime?: number
  gain?: number
}

function build(name: string, s: Spec): EarlySynthParams {
  const alg = EARLY_ALGORITHMS[s.algo]
  const ops = [...s.ops]
  while (ops.length < 4) ops.push(silent())
  return {
    preset: name,
    algo: s.algo,
    ops,
    mod: alg.mod.map((r) => [...r]),
    out: [...(s.out ?? alg.out)],
    feedback: s.fb ?? { op: 0, amount: 0 },
    index: 1,
    click: s.click ?? 0,
    pitchPunch: s.punch ?? 0,
    pitchTime: s.punchTime ?? 0.015,
    atkScale: 1,
    relScale: 1,
    gain: s.gain ?? 1
  }
}

const list: [string, Spec][] = [
  // ---- basses ----
  [
    'Punch Bass',
    {
      algo: 'stack2',
      ops: [op(1, 1, 0.0004, 0.5, 0.8, 0.09, 0.3), op(1, 0.55, 0.0004, 0.1, 0.12, 0.06, 0.8), op(0.5, 1, 0.0004, 0.4, 0.85, 0.09, 0.2)],
      out: [1, 0, 0.5, 0],
      click: 0.45,
      punch: 6,
      punchTime: 0.014
    }
  ],
  [
    'Pluck Bass',
    { algo: 'serial', ops: [op(1, 1, 0.0004, 0.22, 0, 0.06, 0.3), op(2, 0.6, 0.0004, 0.07, 0.05, 0.05, 0.8)], click: 0.35, punch: 3 }
  ],
  [
    'Rubber Bass',
    {
      algo: 'serial',
      ops: [op(1, 1, 0.0005, 0.35, 0.7, 0.1, 0.3), op(1, 0.75, 0.0005, 0.16, 0.4, 0.08, 0.9)],
      fb: { op: 1, amount: 0.35 },
      click: 0.25,
      punch: 9,
      punchTime: 0.02
    }
  ],
  [
    'Hollow Bass',
    { algo: 'serial', ops: [op(1, 1, 0.001, 0.4, 0.8, 0.1, 0.3), op(2, 0.35, 0.001, 0.3, 0.6, 0.08, 0.6)], click: 0.15, punch: 2 }
  ],
  // ---- keys / plucks / mallets ----
  [
    'Electric Piano',
    {
      algo: 'stack2',
      ops: [op(1, 0.9, 0.0006, 2.2, 0, 0.3, 0.4), op(1, 0.4, 0.0006, 0.45, 0.05, 0.2, 0.9), op(1, 0.55, 0.0006, 1.4, 0, 0.3, 0.4), op(14, 0.22, 0.0005, 0.06, 0, 0.05, 0.9)],
      out: [1, 0, 0.6, 0],
      click: 0.12
    }
  ],
  [
    'FM Keys',
    {
      algo: 'stack2',
      ops: [op(1, 0.9, 0.0006, 1.2, 0.1, 0.25, 0.4), op(2, 0.3, 0.0006, 0.3, 0.05, 0.2, 0.8), op(1, 0.6, 0.0006, 0.8, 0.05, 0.25, 0.4, 5), op(1, 0.3, 0.0006, 0.2, 0, 0.15, 0.8)],
      out: [1, 0, 0.7, 0],
      click: 0.15
    }
  ],
  [
    'Glass Pluck',
    {
      algo: 'serial',
      ops: [op(1, 1, 0.0005, 0.7, 0, 0.35, 0.3), op(3.5, 0.5, 0.0005, 0.28, 0, 0.2, 0.8), op(7.01, 0.25, 0.0004, 0.05, 0, 0.05, 0.9)],
      click: 0.3
    }
  ],
  [
    'Marimba',
    {
      algo: 'stack2',
      ops: [op(1, 1, 0.0004, 0.55, 0, 0.15, 0.3), op(4, 0.4, 0.0004, 0.035, 0, 0.04, 0.8), op(4, 0.3, 0.0004, 0.12, 0, 0.1, 0.3)],
      out: [1, 0, 0.35, 0],
      click: 0.5
    }
  ],
  [
    'Bell',
    {
      algo: 'stack2',
      ops: [op(1, 0.9, 0.0005, 3.8, 0, 1.6, 0.3), op(3.5, 0.65, 0.0005, 2.4, 0, 1.2, 0.6), op(2.76, 0.45, 0.0005, 3, 0, 1.4, 0.3), op(5.4, 0.4, 0.0005, 1.6, 0, 1, 0.6)],
      out: [1, 0, 0.55, 0],
      click: 0.2
    }
  ],
  [
    'Clav',
    { algo: 'serial', ops: [op(1, 1, 0.0004, 0.25, 0, 0.05, 0.3), op(2, 0.8, 0.0004, 0.05, 0, 0.04, 0.9), op(5, 0.15, 0.0004, 0.03, 0, 0.03, 0.9)], click: 0.35 }
  ],
  [
    'Pop Pluck',
    { algo: 'serial', ops: [op(1, 1, 0.0004, 0.26, 0, 0.08, 0.3), op(1, 0.6, 0.0004, 0.08, 0.05, 0.06, 0.8), op(2, 0.2, 0.0004, 0.04, 0, 0.04, 0.9)], click: 0.35, punch: 2 }
  ],
  [
    'Arp Bleep',
    { algo: 'serial', ops: [op(1, 1, 0.0004, 0.12, 0.03, 0.05, 0.3), op(2, 0.45, 0.0004, 0.05, 0, 0.04, 0.7)], click: 0.3, punch: 4 }
  ],
  // ---- stabs / brass / leads ----
  [
    'Brass Stab',
    {
      algo: 'stack2',
      ops: [op(1, 1, 0.012, 0.35, 0.65, 0.14, 0.3), op(1, 0.8, 0.012, 0.4, 0.5, 0.12, 1), op(1, 0.9, 0.012, 0.35, 0.65, 0.14, 0.3, 7), op(1, 0.7, 0.012, 0.4, 0.5, 0.12, 1)],
      out: [1, 0, 0.8, 0],
      click: 0.12,
      punch: 2,
      punchTime: 0.02
    }
  ],
  [
    'Synth Brass',
    {
      algo: 'stack2',
      ops: [op(1, 1, 0.05, 0.5, 0.85, 0.2, 0.3), op(1, 0.7, 0.05, 0.6, 0.7, 0.18, 1), op(1, 0.9, 0.05, 0.5, 0.85, 0.2, 0.3, -7), op(1, 0.65, 0.05, 0.6, 0.7, 0.18, 1)],
      out: [1, 0, 0.8, 0],
      click: 0.08
    }
  ],
  [
    'Saw Lead',
    { algo: 'serial', ops: [op(1, 1, 0.002, 0.2, 0.9, 0.15, 0.3), op(1, 0.8, 0.002, 0.2, 0.9, 0.15, 0.4)], fb: { op: 1, amount: 1.4 }, click: 0.15 }
  ],
  [
    'Square Lead',
    { algo: 'fan', ops: [op(1, 1, 0.002, 0.2, 0.9, 0.15, 0.3), op(3, 0.12, 0.002, 0.2, 0.9, 0.15, 0.4), op(5, 0.07, 0.002, 0.2, 0.9, 0.15, 0.4)], click: 0.12 }
  ],
  // ---- pad / organ ----
  [
    'Soft Pad',
    {
      algo: 'stack2',
      ops: [op(1, 0.8, 0.35, 1.5, 0.8, 0.9, 0.1), op(2, 0.18, 0.5, 1.5, 0.8, 0.8, 0.3), op(1, 0.7, 0.35, 1.5, 0.8, 0.9, 0.1, 6), op(1, 0.15, 0.5, 1.5, 0.8, 0.8, 0.3, -5)],
      out: [1, 0, 0.9, 0]
    }
  ],
  [
    'Organ',
    {
      algo: 'additive',
      ops: [op(1, 0.8, 0.003, 0.01, 1, 0.04, 0), op(2, 0.6, 0.003, 0.01, 1, 0.04, 0), op(3, 0.35, 0.003, 0.01, 1, 0.04, 0), op(4, 0.25, 0.003, 0.01, 1, 0.04, 0)],
      click: 0.12,
      gain: 0.8
    }
  ]
]

export const EARLY_PRESETS: Record<string, EarlySynthParams> = Object.fromEntries(list.map(([name, spec]) => [name, build(name, spec)]))
export const EARLY_PRESET_NAMES: string[] = list.map(([name]) => name)
