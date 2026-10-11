// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { GENRES, targetFromGenre, targetFromSpectrum, type Target } from './spectrum'

/**
 * What the AI mix steers towards: a genre's typical balance, or a reference song's own average spectrum. One
 * target at a time, kept for the session (the AI Mix dialog sets it; `mix_target` reads / sets the genre).
 */

let current: Target | null = null
const listeners = new Set<(t: Target | null) => void>()

export const getMixTarget = (): Target | null => current

export function onMixTarget(cb: (t: Target | null) => void): void {
  listeners.add(cb)
  cb(current)
}

function set(t: Target | null): void {
  current = t
  for (const cb of listeners) cb(t)
}

/** Pick a genre (by id). Returns null for an unknown id and leaves the target as it was. */
export function setMixGenre(id: string): Target | null {
  const t = targetFromGenre(id)
  if (t) set(t)
  return t
}

/** Use a reference song's average spectrum (band levels from `longTermSpectrum*`) as the target. */
export function setMixReference(name: string, levelDb: readonly number[]): Target {
  const t = targetFromSpectrum(name, levelDb)
  set(t)
  return t
}

export const genreChoices = (): { id: string; name: string; label: string }[] => GENRES.map((g) => ({ id: g.id, name: g.name, label: g.label }))
