// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { TUBEEQ_WGSL } from '../shaders'
import { biquad } from '../biquad'
import type { BlockIO, Insert } from '../insert'

/** EQP-1A front-panel frequency switch positions (Hz). Exposed for the UI. */
export const TUBEEQ_LOW_FREQS = [20, 30, 60, 100]
export const TUBEEQ_HI_BOOST_FREQS = [3000, 4000, 5000, 8000, 10000, 12000, 16000]
export const TUBEEQ_HI_ATTEN_FREQS = [5000, 10000, 20000]

/** Circular short-delay line length per channel (f32). ~42 ms @ 96 kHz. */
const DLY_LEN = 4096

export interface TubeEqParams {
  /** dB into the input 12AX7. ~clean at 0, breaks up when pushed. */
  inputGainDb: number
  lowFreq: number
  /** Low-shelf boost, 0..10 (Pultec-style dial). Voiced 1.5× hotter than an EQP-1A. */
  lowBoost: number
  /** Low-shelf atten, 0..10. Boost + atten together = the classic curve. */
  lowAtten: number
  hiBoostFreq: number
  /** HF peaking boost, 0..10. */
  hiBoost: number
  /** Peak width, 0 = sharp .. 10 = broad. */
  bandwidth: number
  hiAttenFreq: number
  /** HF shelving atten, 0..10. */
  hiAtten: number
  /** Output make-up / trim, dB. */
  outputVolDb: number
}

/**
 * Tube program EQ — a Pultec EQP-1A homage.
 *
 *   input 12AX7 (gain stage + cathode follower — a 12AX7 is a dual triode)
 *   → passive program EQ (4 RBJ biquads; 0 = mathematical passthrough)
 *   → output 12AX7 (make-up gain stage + cathode follower)
 *   → gentle program-dependent compression (glue)
 *   → a barely-perceptible short delay (sheen / dimension)
 *   → Output trim
 *
 * The follower halves run near-unity with a small HF bloom for gloss rather than
 * grit. GPU: one thread per channel, serial over the block (see TUBEEQ_WGSL).
 */
export class TubeEqInsert implements Insert {
  readonly name = 'tubeeq'
  bypass = false
  // Defaults = the master-bus setting the user dialled in and saved as "the
  // sweet spot": a touch of Input Gain back-off, a gentle low-shelf lift and a
  // little top tame. A fresh insert with every knob at its initial position
  // already sounds like that; the dials move from there, and 0 is still flat.
  params: TubeEqParams = {
    inputGainDb: -3.77,
    lowFreq: 60,
    lowBoost: 3.64,
    lowAtten: 0,
    hiBoostFreq: 10000,
    hiBoost: 0,
    bandwidth: 5,
    hiAttenFreq: 10000,
    hiAtten: 3.79,
    outputVolDb: 0
  }

  // Per-instance voicing dither, baked once at construction: so the same EQ
  // dropped on 20 tracks doesn't stack into one identical tone. Sub-audible on
  // its own, and deliberately not exposed (no seed, no number picker).
  private readonly vary = {
    gain: 1 + (Math.random() - 0.5) * 0.008,
    bias: (Math.random() - 0.5) * 0.02,
    corner: 1 + (Math.random() - 0.5) * 0.03
  }

  private pipeline: GPUComputePipeline | null = null
  private sr = 0
  private ubo: GPUBuffer
  private state: GPUBuffer
  private dline: GPUBuffer
  private ab = new ArrayBuffer(320)
  private u32 = new Uint32Array(this.ab)
  private f32 = new Float32Array(this.ab)

  // Sample-rate-dependent coeffs (recomputed in configure()).
  private gHpR = 0 // gain-stage halves (A, C)
  private gEmphA = 0
  private gLpA = 0
  private fHpR = 0 // follower halves (B, D)
  private fEmphA = 0
  private fLpA = 0
  private compAtt = 0
  private compRel = 0
  private dlySampL = 0
  private dlySampR = 0

  constructor() {
    const { device } = getGpu()
    this.ubo = device.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.state = device.createBuffer({ size: 512, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.dline = device.createBuffer({
      size: DLY_LEN * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
  }

  private configure(sampleRate: number): void {
    const lp1 = (fc: number): number => 1 - Math.exp((-2 * Math.PI * fc) / sampleRate)
    const pole = (fc: number): number => Math.exp((-2 * Math.PI * fc) / sampleRate)
    // gain-stage halves: brighter pre-emphasis, more Miller roll-off
    this.gHpR = pole(22)
    this.gEmphA = lp1(2000 * this.vary.corner)
    this.gLpA = lp1(15000)
    // follower halves: silky — gentle HF bloom, softer roll-off
    this.fHpR = pole(14)
    this.fEmphA = lp1(3500 * this.vary.corner)
    this.fLpA = lp1(20000)
    // compression ballistics (~6 ms attack, ~160 ms release)
    this.compAtt = 1 - Math.exp(-1 / (0.006 * sampleRate))
    this.compRel = 1 - Math.exp(-1 / (0.16 * sampleRate))
    // short-delay taps — different per channel for a subtle sheen / width
    this.dlySampL = Math.min(DLY_LEN - 1, Math.round(0.0131 * sampleRate))
    this.dlySampR = Math.min(DLY_LEN - 1, Math.round(0.0167 * sampleRate))
    this.sr = sampleRate
    this.reset()
  }

  private getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      const { device } = getGpu()
      this.pipeline = device.createComputePipeline({
        label: 'tubeeq',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: TUBEEQ_WGSL }), entryPoint: 'main' }
      })
    }
    return this.pipeline
  }

  reset(): void {
    const { device } = getGpu()
    device.queue.writeBuffer(this.state, 0, new Float32Array(128))
    device.queue.writeBuffer(this.dline, 0, new Float32Array(DLY_LEN * 2))
  }

  process(enc: GPUCommandEncoder, io: BlockIO): void {
    if (this.bypass) return
    if (this.sr !== io.sampleRate) this.configure(io.sampleRate)
    const { device } = getGpu()
    const p = this.params
    const fs = io.sampleRate

    // Pultec dials (0..10) → dB. Ranges roughly match an EQP-1A, except the low
    // boost, which the user wants 1.5× hotter (13.5 → ~20 dB at 10).
    const lowBoostDb = (p.lowBoost / 10) * 13.5 * 1.5
    const lowAttenDb = (p.lowAtten / 10) * 17
    const hiBoostDb = (p.hiBoost / 10) * 16
    const hiAttenDb = (p.hiAtten / 10) * 16
    const bwQ = 2.6 - (p.bandwidth / 10) * (2.6 - 0.55)

    // triode A — input gain stage, driven by the Input Gain dial. Base was 1.16
    // and drove the tube ~6 dB too hot at the 0 dB detent (highs broke up) —
    // dropped to 0.58 so the dial centre is the sweet spot the user landed on.
    const inG = Math.pow(10, p.inputGainDb / 20)
    const aPre = 0.58 * inG * this.vary.gain
    const aBias = 0.12 + (0.05 * Math.max(0, p.inputGainDb)) / 12 + this.vary.bias
    const aMakeup = Math.pow(aPre, -0.55)
    // triode B — input cathode follower: near unity, a little 2nd + HF sheen
    const bPre = 1.03 * this.vary.gain
    const bBias = 0.05 + this.vary.bias * 0.5
    const bMakeup = Math.pow(bPre, -0.7)
    // triode C — output make-up gain stage
    const cPre = 1.08 * this.vary.gain
    const cBias = 0.07 + this.vary.bias * 0.5
    const cMakeup = Math.pow(cPre, -0.6)
    // triode D — output cathode follower
    const dPre = 1.03 * this.vary.gain
    const dBias = 0.045 + this.vary.bias * 0.5
    const dMakeup = Math.pow(dPre, -0.7)

    const gEmphAmt = 0.28
    const fEmphAmt = 0.1 // subtle HF bloom = gloss ("つややかさ")

    // subtle glue compression (~-18 dBFS threshold, gentle, ~+1 dB make-up)
    const compThr = Math.pow(10, -18 / 20)
    const compSlope = 0.22
    const compMakeup = Math.pow(10, 1.0 / 20)

    // passive network: the atten shelf sits ~1.5 oct above the boost shelf so
    // boost + atten together leave a low bump and a low-mid dip.
    const q0 = biquad('lowshelf', fs, p.lowFreq, 0.72, lowBoostDb)
    const q1 = biquad('lowshelf', fs, Math.min(p.lowFreq * 2.8, fs * 0.45), 0.72, -lowAttenDb)
    const q2 = biquad('peak', fs, p.hiBoostFreq, bwQ, hiBoostDb)
    const q3 = biquad('highshelf', fs, p.hiAttenFreq, 0.72, -hiAttenDb)
    // baked presence dip — broad, shallow cut through the ~4-8 kHz harsh region.
    // Always on, not on any dial, so the box calms the highs a touch by itself.
    const pDip = biquad('peak', fs, 5600, 0.8, -1.4)

    this.u32[0] = io.blockFrames
    this.u32[1] = io.baseIndex >>> 0
    this.f32.set([this.gHpR, this.gEmphA, gEmphAmt, this.gLpA, aPre, aBias, Math.tanh(aBias), aMakeup], 2)
    this.f32.set([this.fHpR, this.fEmphA, fEmphAmt, this.fLpA, bPre, bBias, Math.tanh(bBias), bMakeup], 10)
    this.f32.set([this.gHpR, this.gEmphA, gEmphAmt, this.gLpA, cPre, cBias, Math.tanh(cBias), cMakeup], 18)
    this.f32.set([this.fHpR, this.fEmphA, fEmphAmt, this.fLpA, dPre, dBias, Math.tanh(dBias), dMakeup], 26)
    this.f32.set(q0, 34)
    this.f32.set(q1, 39)
    this.f32.set(q2, 44)
    this.f32.set(q3, 49)
    this.f32.set([compThr, compSlope, this.compAtt, this.compRel, compMakeup], 54)
    this.u32[59] = DLY_LEN
    this.u32[60] = this.dlySampL
    this.u32[61] = this.dlySampR
    this.f32[62] = 0.09 // dlyMix — ~-21 dB, "barely perceptible"
    this.f32[63] = 0.12 // dlyFb — a touch of regeneration, keeps it from being a hard slap
    this.f32.set(pDip, 64) // baked presence dip
    this.f32[69] = Math.pow(10, p.outputVolDb / 20) // outVol
    device.queue.writeBuffer(this.ubo, 0, this.ab)

    const pipe = this.getPipeline()
    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: { buffer: io.sig } },
        { binding: 2, resource: { buffer: this.state } },
        { binding: 3, resource: { buffer: this.dline } }
      ]
    })
    const pass = enc.beginComputePass({ label: 'tubeeq' })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(1)
    pass.end()
  }
}
