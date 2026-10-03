// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { MAXIMIZER_WGSL } from '../shaders'
import type { BlockIO, Insert } from '../insert'

/** Look-ahead time the delay line is sized for. */
const LOOKAHEAD_S = 0.0015

export interface MaximizerParams {
  /** Input drive into the limiter, dB (0..+24). */
  gainDb: number
  /** Output ceiling, dBFS (-3..0). */
  ceilingDb: number
  /** Release, ms (1..1000). */
  releaseMs: number
}

/**
 * Master maximizer / brick-wall limiter (see MAXIMIZER_WGSL). Look-ahead
 * (~1.5 ms, uncompensated) so the gain is already down when a transient arrives;
 * a hard clamp at the ceiling is the safety net. One GPU thread (stereo-linked +
 * circular delay line). The delay line persists across blocks; `reset()` zeroes
 * it.
 */
export class MaximizerInsert implements Insert {
  readonly name = 'maximizer'
  bypass = false
  params: MaximizerParams = { gainDb: 0, ceilingDb: -1, releaseMs: 200 }

  private pipeline: GPUComputePipeline | null = null
  private sr = 0
  private lineLen = 0
  private lookahead = 0
  private ubo: GPUBuffer
  private line: GPUBuffer | null = null
  private stt: GPUBuffer | null = null
  private ab = new ArrayBuffer(48)
  private u32 = new Uint32Array(this.ab)
  private f32 = new Float32Array(this.ab)

  constructor() {
    const { device } = getGpu()
    this.ubo = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  private configure(sampleRate: number): void {
    const { device } = getGpu()
    this.line?.destroy()
    this.stt?.destroy()
    this.sr = sampleRate
    this.lookahead = Math.max(8, Math.round(LOOKAHEAD_S * sampleRate))
    this.lineLen = this.lookahead + 1
    this.line = device.createBuffer({
      label: 'maximizer.line',
      size: this.lineLen * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.stt = device.createBuffer({
      label: 'maximizer.state',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.reset()
  }

  private getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      const { device } = getGpu()
      this.pipeline = device.createComputePipeline({
        label: 'maximizer',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: MAXIMIZER_WGSL }), entryPoint: 'main' }
      })
    }
    return this.pipeline
  }

  reset(): void {
    if (!this.line) return
    const { device } = getGpu()
    const enc = device.createCommandEncoder()
    enc.clearBuffer(this.line)
    enc.clearBuffer(this.stt!)
    device.queue.submit([enc.finish()])
    // gEnv / gHold must start at unity, not 0.
    device.queue.writeBuffer(this.stt!, 0, new Float32Array([1, 1]))
  }

  process(enc: GPUCommandEncoder, io: BlockIO): void {
    if (this.bypass) return
    if (this.sr !== io.sampleRate) this.configure(io.sampleRate)
    const { device } = getGpu()
    const p = this.params
    const fs = io.sampleRate
    const rc = (ms: number): number => 1 - Math.exp(-1 / ((fs * ms) / 1000))

    const inGain = Math.pow(10, Math.max(0, Math.min(24, p.gainDb)) / 20)
    const ceilingLin = Math.pow(10, Math.max(-3, Math.min(0, p.ceilingDb)) / 20)
    const atkCoef = 1 - Math.exp(-5 / this.lookahead) // gain settles within the look-ahead window
    const relCoef = rc(20) // envelope smoothing on recovery
    const holdRel = rc(Math.max(1, Math.min(1000, p.releaseMs)))

    this.u32[0] = io.blockFrames
    this.u32[1] = io.baseIndex >>> 0
    this.u32[2] = this.lineLen
    this.u32[3] = this.lookahead
    this.f32.set([inGain, ceilingLin, atkCoef, relCoef, holdRel, 1 /* outTrim */, 0, 0], 4)
    device.queue.writeBuffer(this.ubo, 0, this.ab)

    const pipe = this.getPipeline()
    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: { buffer: io.sig } },
        { binding: 2, resource: { buffer: this.line! } },
        { binding: 3, resource: { buffer: this.stt! } }
      ]
    })
    const pass = enc.beginComputePass({ label: 'maximizer' })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(1)
    pass.end()
  }
}
