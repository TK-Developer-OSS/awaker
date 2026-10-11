// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { biquad } from '../biquad'
import { BUSCOMP_WGSL } from '../shaders'
import { chunkTransition } from './eq5'
import type { BlockIO, Insert } from '../insert'

/** SL-style stepped values — the knobs snap to these. */
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
 * a soft knee, SL-G-bus voicing, and one knob of bright harmonic colour. Coeffs
 * are derived on the CPU per block; only the detector envelope is serial on the GPU; the rest runs as parallel scans.
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

  private bgl: GPUBindGroupLayout | null = null
  private pipes: Record<'envs' | 'prep' | 'scan', GPUComputePipeline> | null = null
  private scratchE: GPUBuffer | null = null
  private scratchW: GPUBuffer | null = null
  private scratchFrames = 0
  private ubo: GPUBuffer
  private state: GPUBuffer
  private ab = new ArrayBuffer(128)
  private u32 = new Uint32Array(this.ab)
  private f32 = new Float32Array(this.ab)

  constructor() {
    const { device } = getGpu()
    this.ubo = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.state = device.createBuffer({ size: 16 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.reset()
  }

  private getPipes(): NonNullable<BusCompInsert['pipes']> {
    if (!this.pipes) {
      const { device } = getGpu()
      const module = device.createShaderModule({ code: BUSCOMP_WGSL })
      const stor: GPUBufferBindingLayout = { type: 'storage' }
      this.bgl = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: stor }))
        ]
      })
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] })
      const mk = (entryPoint: 'envs' | 'prep' | 'scan'): GPUComputePipeline =>
        device.createComputePipeline({ label: `buscomp.${entryPoint}`, layout, compute: { module, entryPoint } })
      this.pipes = { envs: mk('envs'), prep: mk('prep'), scan: mk('scan') }
    }
    return this.pipes
  }

  private ensureScratch(blockFrames: number): void {
    if (this.scratchE && this.scratchFrames >= blockFrames) return
    const { device } = getGpu()
    this.scratchE?.destroy()
    this.scratchW?.destroy()
    this.scratchE = device.createBuffer({ label: 'buscomp.env', size: blockFrames * 4, usage: GPUBufferUsage.STORAGE })
    this.scratchW = device.createBuffer({ label: 'buscomp.work', size: 2 * blockFrames * 4, usage: GPUBufferUsage.STORAGE })
    this.scratchFrames = blockFrames
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
    // chunk constants for the parallel scans (see BUSCOMP_WGSL): float64 here, exact in the shader
    const chunk = Math.ceil(io.blockFrames / 256)
    this.f32.set(chunkTransition(Math.fround(hs[3]), Math.fround(hs[4]), chunk), 24)
    this.f32.set([Math.pow(1 - Math.fround(emphA), chunk), Math.pow(1 - Math.fround(0.0016), chunk), 0, 0], 28)
    device.queue.writeBuffer(this.ubo, 0, this.ab)

    this.ensureScratch(io.blockFrames)
    const pipes = this.getPipes()
    const bind = device.createBindGroup({
      layout: this.bgl!,
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: { buffer: io.sig } },
        { binding: 2, resource: { buffer: this.state } },
        { binding: 3, resource: { buffer: this.scratchE! } },
        { binding: 4, resource: { buffer: this.scratchW! } }
      ]
    })
    const pass = enc.beginComputePass({ label: 'buscomp' })
    pass.setBindGroup(0, bind)
    pass.setPipeline(pipes.envs)
    pass.dispatchWorkgroups(1)
    pass.setPipeline(pipes.prep)
    pass.dispatchWorkgroups(Math.ceil(io.blockFrames / 256))
    pass.setPipeline(pipes.scan)
    pass.dispatchWorkgroups(2) // one 256-thread workgroup per channel
    pass.end()
  }
}
