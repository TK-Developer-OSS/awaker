// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { AWAKER_WGSL } from '../shaders'
import type { BlockIO, Insert } from '../insert'

export interface AwakerParams {
  /** 0..1 — amount of HF harmonic generation + broadband sparkle. The main knob. */
  air: number
  /** Crossover / focus frequency (Hz) for the excited HF band. */
  freq: number
  /** 0..1 — voicing of the generated sheen: 0 = warm / rolled, 1 = bright / extended. */
  tone: number
  /** 0..1 — transient lift on the excited band (attacks cut through). Works even at air = 0. */
  punch: number
  /** 0..1 — overall wet blend. The dry signal is always kept at full (parallel enhancer). */
  amount: number
}

/** Same cubic soft shaper as AWAKER_WGSL — used to precompute the bias DC offset. */
const shape = (u: number): number => {
  const a = Math.max(-1, Math.min(1, u))
  return a - a * a * a * 0.33333333
}

/**
 * "Awaker" enhancer insert — a silky top-end exciter with a transient lift.
 * Parallel by construction: the dry signal passes through untouched and a
 * generated sheen bus is added on top (`out = dry + Amount·wet`), so the source
 * phase is preserved and the mix "opens up" without smearing.
 *
 * GPU: `@workgroup_size(2)`, one thread per channel, serial over the block — the
 * crossover, pre-emphasis, post-LP and transient envelopes are all recursive
 * one-pole filters, same shape as the tube / reverb prototypes. All coeffs are
 * derived on the CPU per block (cheap) so there is no sample-rate cache.
 */
export class AwakerInsert implements Insert {
  readonly name = 'awaker'
  bypass = false
  params: AwakerParams = { air: 0.4, freq: 4000, tone: 0.5, punch: 0.3, amount: 0.8 }

  private pipeline: GPUComputePipeline | null = null
  private ubo: GPUBuffer
  private state: GPUBuffer
  private ab = new ArrayBuffer(96)
  private u32 = new Uint32Array(this.ab)
  private f32 = new Float32Array(this.ab)

  constructor() {
    const { device } = getGpu()
    this.ubo = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    // 2 channels × 8 f32 of filter / envelope memory.
    this.state = device.createBuffer({ size: 16 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.reset()
  }

  private getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      const { device } = getGpu()
      this.pipeline = device.createComputePipeline({
        label: 'awaker',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: AWAKER_WGSL }), entryPoint: 'main' }
      })
    }
    return this.pipeline
  }

  reset(): void {
    getGpu().device.queue.writeBuffer(this.state, 0, new Float32Array(16))
  }

  process(enc: GPUCommandEncoder, io: BlockIO): void {
    if (this.bypass) return
    const c01 = (v: number): number => Math.max(0, Math.min(1, v))
    const air = c01(this.params.air)
    const tone = c01(this.params.tone)
    const punch = c01(this.params.punch)
    const amount = c01(this.params.amount)
    // Defaults (air 0 & punch 0) are a full passthrough — skip the dispatch.
    if (air <= 0 && punch <= 0) return

    const { device } = getGpu()
    const fs = io.sampleRate
    const TWO_PI = Math.PI * 2
    const lp1 = (fc: number): number => 1 - Math.exp((-TWO_PI * Math.min(fc, fs * 0.49)) / fs)
    const rc = (ms: number): number => 1 - Math.exp(-1 / ((fs * ms) / 1000))

    const dcR = Math.exp((-TWO_PI * 20) / fs) // DC block ~20 Hz
    const fc = Math.min(12000, Math.max(1000, this.params.freq))
    const xoA = lp1(fc)
    const preGain = 1 + air * air * 4.5 // up to ~+15 dB, drive² knee
    const bias = 0.05 + 0.3 * air // asymmetry -> 2nd harmonic
    const biasC = shape(bias)
    const emphA = lp1(3000 - tone * 1800) // brighter Tone widens the pre-emphasis
    const emph = 0.25 + 0.75 * tone
    const postA = lp1(6500 + tone * 10500) // warm Tone rolls the harmonic top off (silky)
    const harmAmt = air * (0.5 + 0.5 * air)
    const shelfAmt = air * 0.5
    const fastA = rc(2)
    const slowA = rc(90)
    const punchAmt = punch * 3.5
    const punchMax = 1 + punch * 3
    const transThru = punch * 1.1
    const outTrim = 1 / (1 + 0.12 * air)
    const limT = 0.7

    this.u32[0] = io.blockFrames
    this.f32.set(
      [
        dcR, xoA, preGain, bias, biasC, emphA, emph, postA, harmAmt, shelfAmt,
        fastA, slowA, punchAmt, punchMax, transThru, amount, outTrim, limT
      ],
      2
    )
    device.queue.writeBuffer(this.ubo, 0, this.ab)

    const pipe = this.getPipeline()
    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: { buffer: io.sig } },
        { binding: 2, resource: { buffer: this.state } }
      ]
    })
    const pass = enc.beginComputePass({ label: 'awaker' })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(1)
    pass.end()
  }
}
