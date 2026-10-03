// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { biquad } from '../biquad'
import { BUSCOMP_WGSL } from '../shaders'
import type { BlockIO, Insert } from '../insert'

/** SSL-style stepped values — the knobs snap to these. */
export const BUSCOMP_RATIOS = [2, 4, 10]
export const BUSCOMP_ATTACKS_MS = [0.1, 0.3, 1, 3, 10, 30]
/** Release positions; -1 = Auto (program-dependent). */
export const BUSCOMP_RELEASES_MS = [100, 300, 600, 1200, -1]

export interface BusCompParams {
  /** Knee-centre threshold, dBFS. */
  threshDb: number
  /** Compression ratio — one of BUSCOMP_RATIOS. */
  ratio: number
  /** Attack, ms — one of BUSCOMP_ATTACKS_MS. */
  attackMs: number
  /** Release, ms — one of BUSCOMP_RELEASES_MS (-1 = Auto). */
  releaseMs: number
  /** Make-up gain, dB. */
  makeupDb: number
  /** 0..1 — bright-harmonic drive after the gain reduction. */
  drive: number
  /** 0..1 — parallel blend against the dry input (1 = fully compressed). */
  mix: number
}

/**
 * Master bus compressor (see BUSCOMP_WGSL). Stereo-linked feed-forward comp with
 * a soft knee, SSL-G-bus voicing, and one knob of bright harmonic colour. Coeffs
 * are derived on the CPU per block; the recurrence runs on one GPU thread.
 */
export class BusCompInsert implements Insert {
  readonly name = 'buscomp'
  bypass = false
  params: BusCompParams = {
    threshDb: -14,
    ratio: 4,
    attackMs: 10,
    releaseMs: 300,
    makeupDb: 3,
    drive: 0.25,
    mix: 1
  }

  private pipeline: GPUComputePipeline | null = null
  private ubo: GPUBuffer
  private state: GPUBuffer
  private ab = new ArrayBuffer(96)
  private u32 = new Uint32Array(this.ab)
  private f32 = new Float32Array(this.ab)

  constructor() {
    const { device } = getGpu()
    this.ubo = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.state = device.createBuffer({ size: 16 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.reset()
  }

  private getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      const { device } = getGpu()
      this.pipeline = device.createComputePipeline({
        label: 'buscomp',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: BUSCOMP_WGSL }), entryPoint: 'main' }
      })
    }
    return this.pipeline
  }

  reset(): void {
    getGpu().device.queue.writeBuffer(this.state, 0, new Float32Array(16))
  }

  process(enc: GPUCommandEncoder, io: BlockIO): void {
    if (this.bypass) return
    const p = this.params
    const mixWet = Math.max(0, Math.min(1, p.mix))
    if (mixWet <= 0) return // fully dry — nothing to do

    const { device } = getGpu()
    const fs = io.sampleRate
    const TWO_PI = Math.PI * 2
    const rc = (ms: number): number => 1 - Math.exp(-1 / ((fs * ms) / 1000))
    const lp1 = (fc: number): number => 1 - Math.exp((-TWO_PI * Math.min(fc, fs * 0.49)) / fs)

    const ratio = Math.max(1.01, p.ratio)
    const auto = p.releaseMs < 0
    const attCoef = rc(Math.max(0.05, p.attackMs))
    const relCoef = auto ? rc(1200) : rc(Math.max(20, p.releaseMs))
    const relCoefFast = rc(80)
    const makeupLin = Math.pow(10, p.makeupDb / 20)

    const drive = Math.max(0, Math.min(1, p.drive))
    const emphA = lp1(3500)
    const emphAmt = 0.5 + drive * 0.9
    const driveG = 1 + drive * 1.6
    const bias = 0.12 * drive
    const biasC = Math.tanh(bias)
    // Baked bright high-shelf — this is what makes the added harmonics read as
    // "明るめ" rather than just thicker.
    const hs = biquad('highshelf', fs, 8000, 0.7, drive * 1.6)
    const outTrim = 1 / (1 + drive * 0.18)

    this.u32[0] = io.blockFrames
    this.f32.set(
      [
        p.threshDb, 6 /* kneeDb */, 1 / ratio, attCoef, relCoef, relCoefFast, auto ? 1 : 0,
        makeupLin, mixWet, drive, emphA, emphAmt, driveG, bias, biasC,
        hs[0], hs[1], hs[2], hs[3], hs[4], outTrim
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
    const pass = enc.beginComputePass({ label: 'buscomp' })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(1)
    pass.end()
  }
}
