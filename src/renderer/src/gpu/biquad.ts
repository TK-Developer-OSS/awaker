// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * RBJ "Audio EQ Cookbook" biquad coefficients, shared by the channel strip and
 * the digital EQ insert. Returned normalized to a0 = 1 as [b0, b1, b2, a1, a2],
 * ready to drop into a Direct-Form-I recurrence:
 *   y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2
 *
 * At `dbGain === 0` the peak / shelf forms collapse to a mathematical identity,
 * so an untouched band is a true passthrough even while its biquad runs.
 */
export type BqKind = 'peak' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass'

export function biquad(kind: BqKind, fs: number, f0: number, q: number, dbGain: number): number[] {
  const A = Math.pow(10, dbGain / 40)
  const w0 = (2 * Math.PI * Math.min(Math.max(10, f0), fs * 0.49)) / fs
  const cw = Math.cos(w0)
  const sw = Math.sin(w0)
  const alpha = sw / (2 * Math.max(0.05, q))
  let b0 = 1
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0
  if (kind === 'peak') {
    b0 = 1 + alpha * A
    b1 = -2 * cw
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cw
    a2 = 1 - alpha / A
  } else if (kind === 'lowshelf') {
    const s2 = 2 * Math.sqrt(A) * alpha
    b0 = A * (A + 1 - (A - 1) * cw + s2)
    b1 = 2 * A * (A - 1 - (A + 1) * cw)
    b2 = A * (A + 1 - (A - 1) * cw - s2)
    a0 = A + 1 + (A - 1) * cw + s2
    a1 = -2 * (A - 1 + (A + 1) * cw)
    a2 = A + 1 + (A - 1) * cw - s2
  } else if (kind === 'highshelf') {
    const s2 = 2 * Math.sqrt(A) * alpha
    b0 = A * (A + 1 + (A - 1) * cw + s2)
    b1 = -2 * A * (A - 1 + (A + 1) * cw)
    b2 = A * (A + 1 + (A - 1) * cw - s2)
    a0 = A + 1 - (A - 1) * cw + s2
    a1 = 2 * (A - 1 - (A + 1) * cw)
    a2 = A + 1 - (A - 1) * cw - s2
  } else if (kind === 'lowpass') {
    b0 = (1 - cw) / 2
    b1 = 1 - cw
    b2 = (1 - cw) / 2
    a0 = 1 + alpha
    a1 = -2 * cw
    a2 = 1 - alpha
  } else {
    // high-pass, Butterworth Q ≈ 0.707 (caller can raise Q)
    b0 = (1 + cw) / 2
    b1 = -(1 + cw)
    b2 = (1 + cw) / 2
    a0 = 1 + alpha
    a1 = -2 * cw
    a2 = 1 - alpha
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}
