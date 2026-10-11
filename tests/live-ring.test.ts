// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { LiveRing } from '../src/main/live-ring'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}
const block = (vals: number[]): Float32Array => Float32Array.from(vals.flatMap((v) => [v, -v])) // L = v, R = -v

// 1. a block lands at the frame it was tagged with, whenever it arrives
{
  const r = new LiveRing(1024)
  r.write(100, block([1, 2, 3, 4]), 0)
  const dst = new Float32Array(16) // frames 96..103
  r.take(96, 8, dst)
  eq('placed at frames 100..103', Array.from(dst), [0, 0, 0, 0, 0, 0, 0, 0, 1, -1, 2, -2, 3, -3, 4, -4])
  const again = new Float32Array(16)
  eq('consumed frames are cleared', [r.take(96, 8, again), Array.from(again).every((v) => v === 0)], [false, true])
}

// 2. it adds onto what is already in the playback block
{
  const r = new LiveRing(1024)
  r.write(0, block([0.5, 0.5]), 0)
  const dst = Float32Array.from([1, 1, 1, 1])
  r.take(0, 2, dst)
  eq('adds to playback', Array.from(dst), [1.5, 0.5, 1.5, 0.5])
}

// 3. late block: the part already played is dropped, the future part is kept, in place
{
  const r = new LiveRing(1024)
  const stored = r.write(10, block([1, 2, 3, 4]), 12) // frames 10,11 already played; 12,13 still to come
  eq('stored the future half', stored, 2)
  eq('counted as late', r.late, 1)
  const dst = new Float32Array(8) // frames 10..13
  r.take(10, 4, dst)
  eq('future half sits at 12,13 — not slid to the start', Array.from(dst), [0, 0, 0, 0, 3, -3, 4, -4])
}

// 4. completely late block is dropped
{
  const r = new LiveRing(1024)
  eq('fully late → nothing stored', [r.write(0, block([1, 1, 1]), 100), r.late], [0, 1])
}

// 5. on-time blocks are not counted late
{
  const r = new LiveRing(1024)
  r.write(50, block([1]), 50)
  eq('exactly on time is not late', r.late, 0)
}

// 6. wrap-around and far-future guard
{
  const r = new LiveRing(8)
  r.write(6, block([1, 2, 3, 4]), 6) // playing at frame 6: frames 6,7,8,9 wrap the 8-frame ring
  const dst = new Float32Array(8)
  r.take(6, 4, dst)
  eq('wraps around the ring end', Array.from(dst), [1, -1, 2, -2, 3, -3, 4, -4])
  const r2 = new LiveRing(8)
  eq('beyond capacity is refused', [r2.write(20, block([1, 1]), 0), r2.tooFar], [0, 2])
}

// 7. contiguous blocks form a continuous stream (what the live path produces)
{
  const r = new LiveRing(4096)
  for (let b = 0; b < 4; b++) r.write(1000 + b * 256, block(Array.from({ length: 256 }, (_, i) => b * 256 + i + 1)), 0)
  const dst = new Float32Array(1024 * 2)
  r.take(1000, 1024, dst)
  let ok = true
  for (let i = 0; i < 1024; i++) if (dst[i * 2] !== i + 1) ok = false
  eq('four 256-frame blocks are gapless and in order', ok, true)
}

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
