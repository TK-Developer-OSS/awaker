// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Pure helpers behind the Add Track panel (no DOM): default names that do not collide with
 * existing tracks, default clip length per instrument, and the line-input channel choices.
 */

/** `base`, or `base 2`, `base 3`… — the first one not already used (case-insensitive). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.trim().toLowerCase()))
  const clean = base.trim() || 'Track'
  if (!used.has(clean.toLowerCase())) return clean
  for (let n = 2; ; n++) {
    const cand = `${clean} ${n}`
    if (!used.has(cand.toLowerCase())) return cand
  }
}

/** A name the user typed that is blank or still the previous auto-name follows the instrument choice. */
export function followsDefault(current: string, previousDefault: string): boolean {
  return current.trim() === '' || current.trim() === previousDefault
}

/** Drum patterns loop a bar or two; everything else starts with a 4-bar clip. */
export const defaultBarsFor = (kind: string): number => (kind === 'drums' ? 2 : 4)

export const BAR_CHOICES = [1, 2, 4, 8, 16]

export interface InputChoice {
  value: string
  label: string
}

/** Mono inputs 1..n and stereo pairs 1-2, 3-4…; value = `m<ch>` / `s<ch>` (ch is 0-based). */
export function inputChoices(channels = 8): InputChoice[] {
  const out: InputChoice[] = []
  for (let n = 0; n < channels; n++) out.push({ value: `m${n}`, label: `In ${n + 1} (mono)` })
  for (let n = 0; n + 1 < channels; n += 2) out.push({ value: `s${n}`, label: `In ${n + 1}-${n + 2} (stereo)` })
  return out
}

export function parseInput(value: string): { ch: number; stereo: boolean } | null {
  const m = /^([ms])(\d+)$/.exec(value)
  if (!m) return null
  return { ch: Number(m[2]), stereo: m[1] === 's' }
}
