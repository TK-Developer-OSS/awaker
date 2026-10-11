// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * EQ5_WGSL runs each biquad as a chunked parareal-style scan (zero-state chunks -> carry the state ->
 * rerun from it -> correct the carry -> final run). Node has no WebGPU, so this pins the MATH: the same algorithm in float64
 * must equal the plain Direct-Form-I loop, for the awkward cases (poles near the unit circle,
 * blocks that don't divide into 256 chunks, tiny blocks, state carried across blocks).
 */
import { biquad } from '../src/renderer/src/gpu/biquad'
import { chunkTransition } from '../src/renderer/src/gpu/effects/eq5'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

interface St { x1: number; x2: number; y1: number; y2: number }

function serial(x: Float64Array, c: number[], s: St): Float64Array {
  const [b0, b1, b2, a1, a2] = c
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * s.x1 + b2 * s.x2 - a1 * s.y1 - a2 * s.y2
    s.x2 = s.x1; s.x1 = x[i]; s.y2 = s.y1; s.y1 = y
    out[i] = y
  }
  return out
}

function chunked(x: Float64Array, c: number[], s: St): Float64Array {
  const [b0, b1, b2, a1, a2] = c
  const N = x.length
  const C = Math.ceil(N / 256)
  const [mp1, mp2, md1, md2] = chunkTransition(a1, a2, C)
  const own = (t: number): [number, number] => {
    const i0 = Math.min(t * C, N)
    return [i0, Math.min(i0 + C, N) - i0]
  }
  const pre = (t: number): [number, number] => {
    const [i0] = own(t)
    if (i0 >= 2) return [x[i0 - 1], x[i0 - 2]]
    if (i0 === 1) return [x[0], s.x1]
    return [s.x1, s.x2]
  }
  const run = (t: number, y1: number, y2: number, out?: Float64Array): [number, number] => {
    const [i0, n] = own(t)
    let [u1, u2] = pre(t)
    for (let j = 0; j < n; j++) {
      const u = x[i0 + j]
      const y = b0 * u + b1 * u1 + b2 * u2 - a1 * y1 - a2 * y2
      if (out) out[i0 + j] = y
      u2 = u1; u1 = u; y2 = y1; y1 = y
    }
    return [y1, y2]
  }
  // 1-2. zero-state end states, first carry
  const S: [number, number][] = []
  let s1 = s.y1, s2 = s.y2
  for (let t = 0; t < 256; t++) {
    S.push([s1, s2])
    const e = run(t, 0, 0)
    const p = s1, d = s1 - s2
    ;[s1, s2] = [e[0] + p * mp1 + d * md1, e[1] + p * mp2 + d * md2]
  }
  // 3-4. true end states from the estimate, correct the carry
  const F = S.map((st, t) => run(t, st[0], st[1]))
  const Nw: [number, number][] = []
  let n1 = s.y1, n2 = s.y2
  for (let t = 0; t < 256; t++) {
    Nw.push([n1, n2])
    const dp = n1 - S[t][0]
    const dd = (n1 - n2) - (S[t][0] - S[t][1])
    ;[n1, n2] = [F[t][0] + dp * mp1 + dd * md1, F[t][1] + dp * mp2 + dd * md2]
  }
  // 5. final run
  const sig = new Float64Array(N)
  for (let t = 0; t < 256; t++) run(t, Nw[t][0], Nw[t][1], sig)
  if (N >= 2) { s.x1 = x[N - 1]; s.x2 = x[N - 2]; s.y1 = sig[N - 1]; s.y2 = sig[N - 2] }
  return sig
}

let seed = 12345
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5 }

const cases: [string, Parameters<typeof biquad>][] = [
  ['lowshelf 32Hz@96k', ['lowshelf', 96000, 32, 0.7, -3]],
  ['lowshelf 120Hz@96k', ['lowshelf', 96000, 120, 0.7, 3]],
  ['peak 710Hz@96k', ['peak', 96000, 710, 1, -2]],
  ['peak 4k@44.1k', ['peak', 44100, 4000, 1, -2.5]],
  ['highshelf 10k@192k', ['highshelf', 192000, 10000, 0.7, -1]],
  ['peak 20Hz Q3 @192k (very sharp)', ['peak', 192000, 20, 3, 6]]
]
for (const [name, args] of cases) {
  for (const N of [32768, 32767, 1000, 300, 255, 5, 2]) {
    const x = new Float64Array(N)
    for (let i = 0; i < N; i++) x[i] = rnd()
    const c = biquad(...args)
    const s1: St = { x1: 0.1, x2: -0.2, y1: 0.3, y2: -0.1 }
    const s2: St = { ...s1 }
    let worst = 0
    let peak = 1e-12
    // two consecutive blocks: state must carry
    for (let blk = 0; blk < 2; blk++) {
      const a = serial(x, c, s1)
      const b = chunked(x, c, s2)
      for (let i = 0; i < N; i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); peak = Math.max(peak, Math.abs(a[i])) }
    }
    worst = Math.max(worst, Math.abs(s1.y1 - s2.y1), Math.abs(s1.y2 - s2.y2), Math.abs(s1.x1 - s2.x1), Math.abs(s1.x2 - s2.x2))
    check(`${name} N=${N}`, worst / Math.max(peak, 1) < 1e-8, `rel maxdiff ${(worst / Math.max(peak, 1)).toExponential(1)}`)
  }
}
// ---------------------------------------------------------------- one-pole carry
// The bus comp's emphasis / DC one-poles and the strip's Color one-poles are solved as zero-state
// chunks + carry S' = E + (1-a)^C * S (exact: the recursion is linear).
function onePoleSerial(x: Float64Array, a: number, s0: number): { y: Float64Array; end: number } {
  const y = new Float64Array(x.length)
  let e = s0
  for (let i = 0; i < x.length; i++) { e = e + a * (x[i] - e); y[i] = e }
  return { y, end: e }
}
function onePoleChunked(x: Float64Array, a: number, s0: number): { y: Float64Array; end: number } {
  const N = x.length
  const C = Math.ceil(N / 256)
  const dec = Math.pow(1 - a, C)
  const E: number[] = []
  for (let t = 0; t < 256; t++) {
    const i0 = Math.min(t * C, N), i1 = Math.min(i0 + C, N)
    let e = 0
    for (let i = i0; i < i1; i++) e = e + a * (x[i] - e)
    E.push(e)
  }
  const S: number[] = []
  let c0 = s0
  for (let t = 0; t < 256; t++) { S.push(c0); c0 = E[t] + dec * c0 }
  const y = new Float64Array(N)
  let end = s0
  for (let t = 0; t < 256; t++) {
    const i0 = Math.min(t * C, N), i1 = Math.min(i0 + C, N)
    let e = S[t]
    for (let i = i0; i < i1; i++) { e = e + a * (x[i] - e); y[i] = e }
    if (i1 === N && i1 > i0) end = e
  }
  return { y, end }
}
for (const a of [0.0016, 0.0059, 0.111, 0.82]) {
  for (const N of [32768, 32767, 1000, 255, 5]) {
    const x = new Float64Array(N)
    for (let i = 0; i < N; i++) x[i] = rnd()
    const p = onePoleSerial(x, a, 0.3), q = onePoleChunked(x, a, 0.3)
    let worst = Math.abs(p.end - q.end)
    for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(p.y[i] - q.y[i]))
    check(`one-pole a=${a} N=${N}`, worst < 1e-12, `maxdiff ${worst.toExponential(1)}`)
  }
}
if (fails) { console.log(`${fails} FAILED`); process.exit(1) }
