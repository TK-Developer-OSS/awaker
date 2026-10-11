// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/** The channel strip's number for a fader position in dB (range -60..+6; the bottom of the rail is -inf). */
export function fmtFaderDb(db: number): string {
  if (!Number.isFinite(db) || db <= -60) return '\u2212\u221e'
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}
