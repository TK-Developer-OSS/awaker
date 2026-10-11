// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Moving an insert between slots (drag and drop in a rack). The racks are packed lists (no holes), so a slot is
 * its position in the list and an empty slot means "the end".
 *
 * Same rack: the item goes to position `to` (as the final index). Another rack: it is inserted at `to`
 * (clamped to the end); refused when that rack is full. Returns what changed, so the caller redraws only then.
 */
export function moveSlot<T>(src: T[], from: number, dst: T[], to: number, capacity: number): boolean {
  if (from < 0 || from >= src.length) return false
  if (src === dst) {
    const target = Math.max(0, Math.min(src.length - 1, to))
    if (target === from) return false
    const [item] = src.splice(from, 1)
    src.splice(target, 0, item)
    return true
  }
  if (dst.length >= capacity) return false
  const [item] = src.splice(from, 1)
  dst.splice(Math.max(0, Math.min(dst.length, to)), 0, item)
  return true
}
