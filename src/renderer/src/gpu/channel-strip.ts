// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from './device'
import { CHANNELSTRIP_WGSL } from './shaders'
import { biquad } from './biquad'

/** One analogue-console-style EQ band. LF (band 0) / HF (band 3) can be shelf or bell. */
export interface StripEqBand {
  freq: number
  gainDb: number
  q: number
  shelf: boolean
}

export interface StripComp {
  on: boolean
  threshDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  makeupDb: number
}

/** Saturation voicing: parallel multiband ("SSL-ish" forward grit) or transformer + Class-A ("Neve-ish" warmth). */
export type SatMode = 'drive' | 'color'

export interface ChannelStripParams {
  bypass: boolean
  /** Input trim in dB. */
  trimDb: number
  /** 0..1 saturation amount. Drives whichever `satMode` is active; 0 = bypassed. */
  drive: number
  /** Which saturation voicing the `drive` knob runs. */
  satMode: SatMode
  /** High-pass corner in Hz. 0 = off. */
  hpfHz: number
  eqOn: boolean
  /** [LF, LMF, HMF, HF]. */
  eq: [StripEqBand, StripEqBand, StripEqBand, StripEqBand]
  comp: StripComp
}

export function defaultStripParams(): ChannelStripParams {
  return {
    bypass: false,
    trimDb: 0,
    drive: 0,
    satMode: 'color',
    hpfHz: 0,
    eqOn: false,
    eq: [
      { freq: 100, gainDb: 0, q: 0.7, shelf: true }, // LF
      { freq: 500, gainDb: 0, q: 1.0, shelf: false }, // LMF
      { freq: 3000, gainDb: 0, q: 1.0, shelf: false }, // HMF
      { freq: 9000, gainDb: 0, q: 0.7, shelf: true } // HF
    ],
    comp: { on: false, threshDb: -18, ratio: 2, attackMs: 12, releaseMs: 120, makeupDb: 0 }
  }
}

const FLAG_DRIVE = 1 // saturation stage active (amount > 0)
const FLAG_HPF = 2
const FLAG_EQ = 4
const FLAG_SATCOLOR = 8 // saturation mode = color
const FLAG_COMP = 16

/** f32 words per track slot — CS struct pads to 256 B, state slice is the same 64. */
const STRIP_WORDS = 64
/** Invocations per workgroup in the batched strip pass (one warp; one track each). */
const STRIP_WG = 32

type BqKind = Parameters<typeof biquad>[0]

/**
 * Built-in per-track channel strip: trim → saturation (one knob; mode = drive
 * (12AX7 triode + feedback FET comp) | color (transformer + Class-A)) → HPF →
 * analogue-console 4-band EQ → stereo-linked compressor.
 *
 * This is now just the parameter + coefficient holder: `StripBank` owns the GPU
 * buffers and runs every track's strip in ONE batched dispatch (see
 * CHANNELSTRIP_WGSL). `writeCoeffs()` bakes this instance's voicing into the
 * shared params array; `StripBank` uploads it and dispatches.
 *
 * `vary` holds a tiny per-instance coefficient dither, baked in once at
 * construction from Math.random() and never surfaced to the user (no seed field,
 * no re-roll, no "pick a channel number"). Each value is small enough to be
 * inaudible on a solo track; its only purpose is that a stack of ~30 copies of
 * one source decorrelates instead of collapsing into a single blob.
 */
export class ChannelStrip {
  bypass = false
  params: ChannelStripParams = defaultStripParams()

  /** Per-instance micro-variation (see class doc). Fixed for this instance's life; not persisted. */
  private readonly vary = {
    gain: 1 + (Math.random() - 0.5) * 0.006, // ±0.3% saturation gain
    bias: (Math.random() - 0.5) * 0.004, // ±0.002 extra asymmetry
    corner: 1 + (Math.random() - 0.5) * 0.03, // ±1.5% on one HF corner
    allpass: (Math.random() - 0.5) * 0.06 // ±0.03 magnitude-flat decorrelation allpass
  }

  /** Which stages would change the signal. */
  private flags(): number {
    const p = this.params
    let f = 0
    if (p.drive > 0.001) f |= FLAG_DRIVE
    if (p.hpfHz > 0) f |= FLAG_HPF
    if (p.eqOn) f |= FLAG_EQ
    if (p.drive > 0.001 && p.satMode === 'color') f |= FLAG_SATCOLOR
    if (p.comp.on) f |= FLAG_COMP
    return f
  }

  /** True when this strip needs a batch slot (else `StripBank` leaves it inactive). */
  wouldProcess(): boolean {
    return !this.bypass && (this.flags() !== 0 || Math.abs(this.params.trimDb) >= 0.01)
  }

  /**
   * Bake this strip's coefficients into `u` / `f` (aliased views of one buffer)
   * starting at word `B` (= slot * STRIP_WORDS), for sample rate `fs`. Mirrors
   * the old per-instance UBO layout one-to-one. Only called when `wouldProcess()`.
   */
  writeCoeffs(u: Uint32Array, f: Float32Array, B: number, fs: number): void {
    const p = this.params

    u[B + 0] = 1 // slotOn — this slot gets processed
    u[B + 1] = this.flags()
    f[B + 2] = Math.pow(10, p.trimDb / 20)

    const d = Math.min(1, Math.max(0, p.drive))
    const lp1 = (fc: number): number => 1 - Math.exp((-2 * Math.PI * fc) / fs)

    // Tiny per-instance magnitude-flat decorrelation allpass (see `vary` doc).
    // Read by satVary() in the WGSL whenever the saturation stage runs.
    f[B + 60] = this.vary.allpass

    // --- DRIVE mode — 12AX7 triode grit + feedback FET compressor (see
    //     driveStage in CHANNELSTRIP_WGSL). Voiced after an 1176 with all four
    //     ratio buttons in ("British mode"), used to shove a kick / bass forward:
    //     one knob drives hard into a bright, ragged asymmetric triode clip
    //     ("ささくれ"), then a very fast feedback compressor at extreme ratio
    //     levels it — the fast attack lets the transient front bite through
    //     ("バイト"). `vary` nudges triode gain / bias / HF corner per instance.
    // Knob curve: `d^2.1` lays the lower half right back so you turn well past
    // 12 o'clock before it really bites — tuned on-device in two passes
    // (0.85 → 1.35 → 2.1), each shifting "what's at 10 o'clock" up to 12 o'clock.
    // Full (d = 1) is unchanged. `k` gears the whole drive character below.
    const k = Math.pow(d, 2.1)
    const dPre = Math.pow(10, (k * 30) / 20) * this.vary.gain // up to ~+30 dB into the triode
    const dTriG = 1 + 2.6 * k // extra triode drive on top of dPre
    const dBias = 0.12 + 0.4 * k + this.vary.bias // triode asymmetry → 2nd, ragged
    const dBiasT = Math.tanh(dBias)
    const dThr = 0.14 - 0.09 * k // threshold drops as the knob opens → always slamming
    const dRatioInv = 1 / (3 + 17 * k) // ratio ~3:1 … ~20:1 ("all buttons")
    const dDensity = 0.35 + 1.2 * k // final surge soft-clip
    f[B + 3] = dPre
    f[B + 4] = lp1(1800 * this.vary.corner) // dEmphA — HF pre-emphasis corner (bright, ragged grit)
    f[B + 5] = 0.5 + 1.2 * k // dEmph — brighter / more ragged as pushed ("ささくれ")
    f[B + 6] = dTriG
    f[B + 7] = dBias
    f[B + 8] = dBiasT
    f[B + 9] = dThr
    f[B + 10] = dRatioInv
    f[B + 11] = 1 - Math.exp(-1 / (0.0004 * fs)) // dAtt ≈ 0.4 ms — transient front bites through
    f[B + 12] = 1 - Math.exp(-1 / (0.18 * fs)) // dRelSlow ≈ 180 ms
    f[B + 13] = 1 - Math.exp(-1 / (0.04 * fs)) // dRelFast ≈ 40 ms — pump when slammed (not so fast it self-oscillates)
    f[B + 15] = dDensity
    // dMakeup: numeric level match — push a nominal test sine through the triode
    // + a steady-state estimate of the GR + the surge clip, normalise RMS back.
    // The sine model badly under-reads real (high-crest) kick/bass — they slam
    // the fast feedback detector + surge clip and come out much hotter. NB the
    // WGSL detector taps the POST-makeup output, so trimming dMakeup only moves
    // the level ~½ dB per dB (the loop compensates) — that's why each A/B round
    // only shaved ~3 dB. The real 1:1 level match is `dOut` (f[16]) below,
    // applied outside the loop. Leave the `(1 - 0.76·k)` here as-is.
    let dInSq = 0
    let dGritSq = 0
    for (let n = 0; n < 64; n++) {
      const sn = 0.2 * Math.sin((2 * Math.PI * n) / 64)
      const gr = Math.tanh(sn * dPre * dTriG + dBias) - dBiasT
      dInSq += sn * sn
      dGritSq += gr * gr
    }
    const gritRms = Math.sqrt(dGritSq / 64)
    const envSS = gritRms * 1.3
    const grSS = envSS / dThr > 1 ? Math.pow(envSS / dThr, dRatioInv - 1) : 1
    const postGr = gritRms * grSS
    const postSurge = postGr / (1 + postGr * 1.2 * dDensity)
    f[B + 14] = (Math.sqrt(dInSq / 64) / Math.max(1e-6, postSurge)) * (1 - 0.76 * k)
    // dOut — 1:1 final trim (outside the feedback loop). sqrt shape: the level
    // excess is roughly constant-dB once Drive is engaged, so this ramps in fast
    // then flattens (~-5 dB @ 12 o'clock, -8 dB @ full). Tune this ONE coeff for
    // the Color↔Drive level match.
    f[B + 16] = 1 - 0.6 * Math.sqrt(k)
    // dLimT — headroom-limiter threshold (softTop clamps toward a 1.0 ceiling).
    // The post-surge signal reaches ~1.5 at low-mid Drive but the surge itself
    // caps it ~0.65 near full, so the threshold drops fairly steeply with k to
    // stay below that and keep topping transients across the range.
    f[B + 17] = 0.92 - 0.35 * k
    f[B + 18] = 0 // _dpad
    f[B + 56] = 0 // _dpad2

    // --- COLOR mode — one-knob transformer + Class-A (see colorStage in WGSL). ---
    // DC-block → LF bloom (weight / 2nd) → HF pre-emphasis → asymmetric Class-A
    // (bias = 2nd, tanh = 3rd) → output shoulder + half-direct top (sparkle).
    // Unity at amount 0. `vary` nudges gain / bias / HF corner per instance.
    // Voicing round 2026-09-07(2): today's max should sit around CENTRE now, and
    // the top of the knob is meant to be extreme ("えぐく", slight breakup ok).
    // knee d^1.2→d^0.68, drive span 22→34 dB, bloom/emph/shoulder/bias all up.
    const ck = Math.pow(d, 0.68)
    const colG = Math.pow(10, (ck * 34) / 20) * this.vary.gain
    const colBias = 0.12 + 0.32 * ck + this.vary.bias
    f[B + 44] = lp1(90) // colLoA
    f[B + 45] = 0.85 * ck // colBloom — more transformer weight
    f[B + 46] = lp1(2500) // colEmphA
    f[B + 47] = 0.5 + 0.95 * ck // colEmph — brighter into the shaper as pushed
    const colBiasT = Math.tanh(colBias)
    f[B + 48] = colG
    f[B + 49] = colBias
    f[B + 50] = colBiasT // precomputed
    f[B + 57] = 0.28 + 0.55 * ck // colShoulder — up to ~0.83 (hard shoulder at the top)
    f[B + 58] = lp1((26000 - 11000 * ck) * this.vary.corner) // colOutA — sparkle, closes a bit more when slammed
    // colMakeup: numerically match the Class-A stage's level. Drive a nominal
    // (~-16 dBFS RMS) test sine through the exact same curve and normalise its
    // RMS back. A level-bounded nonlinearity can't be compensated by 1/colG
    // (buries the top) or a fixed slam level (jumps); an RMS match tracks it.
    // The `(1 - 0.2·ck)` then lets the output drift ~2 dB DOWN as Color is
    // pushed — turning gain up must not read as turning volume up.
    let inSq = 0
    let outSq = 0
    for (let n = 0; n < 64; n++) {
      const sn = 0.2 * Math.sin((2 * Math.PI * n) / 64)
      const on = Math.tanh(sn * colG + colBias) - colBiasT
      inSq += sn * sn
      outSq += on * on
    }
    f[B + 59] = Math.sqrt(inSq / Math.max(1e-9, outSq)) * (1 - 0.2 * ck)

    // HPF (only consumed when FLAG_HPF)
    f.set(biquad('highpass', fs, p.hpfHz || 20, 0.707, 0), B + 19)

    // Console-style 4-band EQ. 0 dB peak/shelf coeffs collapse to identity, so an untouched
    // band is a true passthrough even while the pass runs.
    const kinds: BqKind[] = [
      p.eq[0].shelf ? 'lowshelf' : 'peak',
      'peak',
      'peak',
      p.eq[3].shelf ? 'highshelf' : 'peak'
    ]
    for (let i = 0; i < 4; i++) {
      f.set(biquad(kinds[i], fs, p.eq[i].freq, p.eq[i].q, p.eq[i].gainDb), B + 24 + i * 5)
    }

    // Compressor (stereo-linked, feed-forward, hard knee).
    const c = p.comp
    f[B + 51] = Math.pow(10, c.threshDb / 20)
    f[B + 52] = 1 / Math.max(1, c.ratio)
    f[B + 53] = 1 - Math.exp(-1 / (Math.max(0.1, c.attackMs) * 0.001 * fs))
    f[B + 54] = 1 - Math.exp(-1 / (Math.max(1, c.releaseMs) * 0.001 * fs))
    f[B + 55] = Math.pow(10, c.makeupDb / 20)
  }
}

/**
 * Owns the batched channel-strip GPU resources and runs every track's strip in
 * one dispatch. Replaces the old "one `@workgroup_size(1)` pass per track" — with
 * saturation on across a whole session that was N serial single-lane passes and
 * pegged the GPU. Now invocation `i` handles track `i` over its `[L|R]` slice of
 * the caller's big post-gather scratch; the per-sample chain is still serial
 * within a track (recursive IIR) but the tracks run in parallel.
 *
 * `params` (array<CS>) and `state` (64 f32 / track) grow with the track count;
 * `state` is zeroed by `reset()` at transport start (comp gain → unity).
 */
export class StripBank {
  private pipeline: GPUComputePipeline | null = null
  private params: GPUBuffer | null = null
  private state: GPUBuffer | null = null
  private readonly batchUbo: GPUBuffer
  private cap = 0
  private ab = new ArrayBuffer(0)
  private u32 = new Uint32Array(0)
  private f32 = new Float32Array(0)
  private bind: GPUBindGroup | null = null
  private boundSig: GPUBuffer | null = null

  constructor() {
    this.batchUbo = getGpu().device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
  }

  private ensure(n: number): void {
    if (n <= this.cap && this.params) return
    const { device } = getGpu()
    const cap = Math.max(8, n)
    this.params?.destroy()
    this.state?.destroy()
    this.params = device.createBuffer({
      label: 'strip-bank.params',
      size: cap * STRIP_WORDS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.state = device.createBuffer({
      label: 'strip-bank.state',
      size: cap * STRIP_WORDS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.ab = new ArrayBuffer(cap * STRIP_WORDS * 4)
    this.u32 = new Uint32Array(this.ab)
    this.f32 = new Float32Array(this.ab)
    this.cap = cap
    this.bind = null // params / state buffers changed
    this.reset()
  }

  private getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      const { device } = getGpu()
      const module = device.createShaderModule({ code: CHANNELSTRIP_WGSL })
      // Surface WGSL errors/warnings explicitly (createComputePipeline itself
      // won't throw a useful message for a bad shader).
      void module.getCompilationInfo().then((info) => {
        for (const m of info.messages) {
          if (m.type === 'info') continue
          console.error(`[strip-bank WGSL ${m.type}] ${m.lineNum}:${m.linePos} ${m.message}`)
        }
      })
      this.pipeline = device.createComputePipeline({
        label: 'channel-strip-bank',
        layout: 'auto',
        compute: { module, entryPoint: 'main' }
      })
    }
    return this.pipeline
  }

  /** Zero every track's DSP state (filter memory, envelopes); comp gain → unity. */
  reset(): void {
    if (!this.state) return
    const z = new Float32Array(this.cap * STRIP_WORDS)
    for (let t = 0; t < this.cap; t++) z[t * STRIP_WORDS + 59] = 1
    getGpu().device.queue.writeBuffer(this.state, 0, z)
  }

  /**
   * One batched dispatch: invocation i runs `strips[i]` in place on track i's
   * `[L|R]` slice of `bigSig` (slice stride = blockFrames*2 samples). Slots whose
   * strip is missing / bypassed / transparent are left inactive. Returns false
   * (nothing dispatched) when no track needs the strip.
   */
  process(
    enc: GPUCommandEncoder,
    bigSig: GPUBuffer,
    strips: readonly (ChannelStrip | undefined)[],
    blockFrames: number,
    sampleRate: number
  ): boolean {
    const n = strips.length
    if (n === 0) return false
    this.ensure(n)
    const { device } = getGpu()

    this.u32.fill(0, 0, n * STRIP_WORDS) // clear active flags + stale coeffs for the live slots
    let any = false
    for (let i = 0; i < n; i++) {
      const s = strips[i]
      if (s && s.wouldProcess()) {
        s.writeCoeffs(this.u32, this.f32, i * STRIP_WORDS, sampleRate)
        any = true
      }
    }
    if (!any) return false

    device.queue.writeBuffer(this.params!, 0, this.ab, 0, n * STRIP_WORDS * 4)
    device.queue.writeBuffer(this.batchUbo, 0, new Uint32Array([n, blockFrames]))

    const pipe = this.getPipeline()
    if (!this.bind || this.boundSig !== bigSig) {
      this.bind = device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params! } },
          { binding: 1, resource: { buffer: bigSig } },
          { binding: 2, resource: { buffer: this.state! } },
          { binding: 3, resource: { buffer: this.batchUbo } }
        ]
      })
      this.boundSig = bigSig
    }

    const pass = enc.beginComputePass({ label: 'channel-strip-bank' })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, this.bind)
    pass.dispatchWorkgroups(Math.ceil(n / STRIP_WG))
    pass.end()
    return true
  }
}
