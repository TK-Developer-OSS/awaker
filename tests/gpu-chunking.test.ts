// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * The reverb and delay shaders run their recurrences in parallel chunks (REVERB_COMB_WGSL /
 * REVERB_AP_WGSL / DELAY_WGSL). Node has no WebGPU, so this test pins the MATH they rely on:
 * the chunked algorithm (same chunk sizes, 24-tap damping FIR with carry, segmented scan for the
 * delay's feedback low-pass) must equal the plain sample-by-sample recurrence in float64.
 * The shaders themselves were checked live against a float64 reference through the MCP bounce
 * (reverb 143.9 dB, delay 161 dB SNR) — see DEVELOP.md.
 */

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

// ---------------------------------------------------------------- reverb
const COMB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const AP = [556, 441, 341, 225]

function lens(sr: number): { comb: number[]; ap: number[] } {
  const s = sr / 44100
  return { comb: COMB.map((n) => Math.max(1, Math.round(n * s))), ap: AP.map((n) => Math.max(1, Math.round(n * s))) }
}

interface RP { room: number; damp: number; wet: number; dry: number }

function reverbSerial(x: Float64Array, sr: number, p: RP): Float64Array {
  const { comb, ap } = lens(sr)
  const fb = p.room * 0.28 + 0.7
  const a = p.damp * 0.4
  const b = 1 - a
  const cb = comb.map((l) => new Float64Array(l))
  const lp = new Float64Array(8)
  const ab = ap.map((l) => new Float64Array(l))
  const out = new Float64Array(x.length)
  for (let n = 0; n < x.length; n++) {
    const xi = x[n] * 0.015
    let acc = 0
    for (let k = 0; k < 8; k++) {
      const pos = n % comb[k]
      const y = cb[k][pos]
      lp[k] = y * b + lp[k] * a
      cb[k][pos] = xi + lp[k] * fb
      acc += y
    }
    let s = acc
    for (let k = 0; k < 4; k++) {
      const pos = n % ap[k]
      const y = ab[k][pos]
      ab[k][pos] = s + y * 0.5
      s = y - s
    }
    out[n] = x[n] * p.dry + s * p.wet
  }
  return out
}

function reverbChunked(x: Float64Array, sr: number, p: RP, block: number, taps = 24): Float64Array {
  const { comb, ap } = lens(sr)
  const fb = p.room * 0.28 + 0.7
  const a = p.damp * 0.4
  const b = 1 - a
  const cb = comb.map((l) => new Float64Array(l))
  const carry = new Float64Array(8)
  const ab = ap.map((l) => new Float64Array(l))
  const out = new Float64Array(x.length)
  for (let base = 0; base < x.length; base += block) {
    const bf = Math.min(block, x.length - base)
    const ys = Array.from({ length: 8 }, () => new Float64Array(bf))
    for (let k = 0; k < 8; k++) {
      const L = comb[k]
      for (let c = 0; c < bf; ) {
        const n = Math.min(L, bf - c)
        for (let j = 0; j < n; j++) ys[k][c + j] = cb[k][(base + c + j) % L] // all reads are old values
        const fsLast = { v: 0 }
        const fsAll = new Float64Array(n)
        for (let j = 0; j < n; j++) {
          const lo = j >= taps ? j - taps : 0
          let fs = 0
          let w = b
          for (let i = 0; i <= j - lo; i++) {
            fs += w * ys[k][c + j - i]
            w *= a
          }
          if (lo === 0) fs += carry[k] * (w / b)
          fsAll[j] = fs
        }
        for (let j = 0; j < n; j++) cb[k][(base + c + j) % L] = x[base + c + j] * 0.015 + fsAll[j] * fb
        fsLast.v = fsAll[n - 1]
        carry[k] = fsLast.v
        c += n
      }
    }
    const s = new Float64Array(bf)
    for (let n = 0; n < bf; n++) {
      let acc = 0
      for (let k = 0; k < 8; k++) acc += ys[k][n]
      s[n] = acc
    }
    for (let k = 0; k < 4; k++) {
      const L = ap[k]
      for (let c = 0; c < bf; ) {
        const n = Math.min(L, bf - c)
        for (let j = 0; j < n; j++) {
          const pos = (base + c + j) % L
          const y = ab[k][pos]
          ab[k][pos] = s[c + j] + y * 0.5
          s[c + j] = y - s[c + j]
        }
        c += n
      }
    }
    for (let n = 0; n < bf; n++) out[base + n] = x[base + n] * p.dry + s[n] * p.wet
  }
  return out
}

function noise(n: number, seed = 1): Float64Array {
  const x = new Float64Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    x[i] = (s / 2 ** 32 - 0.5) * 0.4
    if (i % 4999 === 0) x[i] += 1
  }
  return x
}

const maxDiff = (a: Float64Array, b: Float64Array): number => {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

for (const [sr, block, damp] of [[48000, 8192, 0.35], [48000, 1000, 1.0], [96000, 32768, 0.35], [96000, 3000, 0.0]] as const) {
  const p = { room: 0.6, damp, wet: 0.3, dry: 0.7 }
  const x = noise(sr === 96000 ? 70000 : 30000, 7)
  const d = maxDiff(reverbSerial(x, sr, p), reverbChunked(x, sr, p, block))
  check(`reverb chunked == serial (sr ${sr}, block ${block}, damp ${damp})`, d < 1e-11, `max diff ${d.toExponential(2)}`)
}

// ---------------------------------------------------------------- delay
interface DP { timeSamples: number; feedback: number; damp: number; wet: number; dry: number; pingpong: boolean; lineLen: number }

function delaySerial(xL: Float64Array, xR: Float64Array, p: DP): [Float64Array, Float64Array] {
  const LL = p.lineLen
  const lineL = new Float64Array(LL)
  const lineR = new Float64Array(LL)
  let lpL = 0
  let lpR = 0
  const oL = new Float64Array(xL.length)
  const oR = new Float64Array(xL.length)
  for (let n = 0; n < xL.length; n++) {
    const w = n % LL
    const r = (n + LL - p.timeSamples) % LL
    const dL = lineL[r]
    const dR = lineR[r]
    lpL += p.damp * (dL - lpL)
    lpR += p.damp * (dR - lpR)
    if (p.pingpong) {
      lineL[w] = xL[n] + lpR * p.feedback
      lineR[w] = xR[n] + lpL * p.feedback
    } else {
      lineL[w] = xL[n] + lpL * p.feedback
      lineR[w] = xR[n] + lpR * p.feedback
    }
    oL[n] = xL[n] * p.dry + dL * p.wet
    oR[n] = xR[n] * p.dry + dR * p.wet
  }
  return [oL, oR]
}

/** One workgroup of 256 "threads": per chunk, local scans per segment, a carry pass, then the fix-up. */
function delayChunked(xL: Float64Array, xR: Float64Array, p: DP, block: number): [Float64Array, Float64Array] {
  const LL = p.lineLen
  const D = p.timeSamples
  const A = 1 - p.damp
  const lineL = new Float64Array(LL)
  const lineR = new Float64Array(LL)
  const state = [0, 0]
  const oL = new Float64Array(xL.length)
  const oR = new Float64Array(xL.length)
  for (let base = 0; base < xL.length; base += block) {
    const bf = Math.min(block, xL.length - base)
    for (let c = 0; c < bf; ) {
      const n = Math.min(D, LL - D, bf - c)
      const S = Math.ceil(n / 256)
      const locL = new Float64Array(n)
      const locR = new Float64Array(n)
      const segEnd = [new Float64Array(256), new Float64Array(256)]
      for (let t = 0; t < 256; t++) {
        const s0 = Math.min(n, t * S)
        const s1 = Math.min(n, s0 + S)
        let eL = 0
        let eR = 0
        for (let m = s0; m < s1; m++) {
          const r = (base + c + m + LL - D) % LL
          eL += p.damp * (lineL[r] - eL)
          eR += p.damp * (lineR[r] - eR)
          locL[m] = eL
          locR[m] = eR
        }
        segEnd[0][t] = eL
        segEnd[1][t] = eR
      }
      const segIn = [new Float64Array(256), new Float64Array(256)]
      for (let ch = 0; ch < 2; ch++) {
        let cin = state[ch]
        for (let t = 0; t < 256; t++) {
          segIn[ch][t] = cin
          const a0 = Math.min(n, t * S)
          const a1 = Math.min(n, a0 + S)
          cin = A ** (a1 - a0) * cin + segEnd[ch][t]
        }
        state[ch] = cin
      }
      for (let t = 0; t < 256; t++) {
        const s0 = Math.min(n, t * S)
        const s1 = Math.min(n, s0 + S)
        for (let m = s0; m < s1; m++) {
          const i = base + c + m
          const decay = A ** (m - s0 + 1)
          const lpL = locL[m] + decay * segIn[0][t]
          const lpR = locR[m] + decay * segIn[1][t]
          const w = i % LL
          const r = (i + LL - D) % LL
          const dL = lineL[r]
          const dR = lineR[r]
          if (p.pingpong) {
            lineL[w] = xL[i] + lpR * p.feedback
            lineR[w] = xR[i] + lpL * p.feedback
          } else {
            lineL[w] = xL[i] + lpL * p.feedback
            lineR[w] = xR[i] + lpR * p.feedback
          }
          oL[i] = xL[i] * p.dry + dL * p.wet
          oR[i] = xR[i] * p.dry + dR * p.wet
        }
      }
      c += n
    }
  }
  return [oL, oR]
}

for (const [timeSamples, lineLen, damp, pp, block] of [
  [4000, 20000, 0.3, false, 8192],
  [4000, 20000, 0.3, true, 8192],
  [900, 5000, 1.0, true, 3000],
  [300, 700, 0.05, false, 2048], // near the ring size: the chunk is limited by LL - D, not D
  [6000, 7000, 0.5, true, 16384]
] as const) {
  const p = { timeSamples, lineLen, feedback: 0.6, damp, wet: 0.4, dry: 0.6, pingpong: pp }
  const xL = noise(30000, 3)
  const xR = noise(30000, 11)
  const [sL, sR] = delaySerial(xL, xR, p)
  const [cL, cR] = delayChunked(xL, xR, p, block)
  const d = Math.max(maxDiff(sL, cL), maxDiff(sR, cR))
  check(`delay chunked == serial (D ${timeSamples}, ring ${lineLen}, damp ${damp}, pingpong ${pp}, block ${block})`, d < 1e-11, `max diff ${d.toExponential(2)}`)
}

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
