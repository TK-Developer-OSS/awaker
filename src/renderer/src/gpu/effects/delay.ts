// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { DELAY_WGSL } from '../shaders'
import type { BlockIO, Insert } from '../insert'

/** Longest delay time the line is sized for. */
const MAX_DELAY_S = 1.6

export interface DelayParams {
  /** Delay time in milliseconds. */
  timeMs: number
  /** Feedback amount 0..~0.95. */
  feedback: number
  /** 0..1 one-pole low-pass in the feedback path (darkens repeats). */
  damp: number
  /** 0..1 wet mix. */
  wet: number
  /** 0..1 dry mix. */
  dry: number
  /** Cross-feed the feedback between channels. */
  pingpong: boolean
}

/**
 * GPU stereo delay insert. Circular delay line + damped feedback, one thread
 * doing both channels serially (see DELAY_WGSL). The line buffer persists across
 * blocks; `reset()` zeroes it.
 */
export class DelayInsert implements Insert {
  readonly name = 'delay'
  bypass = false
  // wet + dry form a single Dry↔Wet balance in the UI (dry = 1 - wet).
  params: DelayParams = { timeMs: 300, feedback: 0.35, damp: 0.3, wet: 0.25, dry: 0.75, pingpong: false }

  private pipeline: GPUComputePipeline | null = null
  private sr = 0
  private lineLen = 0
  private ubo: GPUBuffer
  private line: GPUBuffer | null = null
  private lpst: GPUBuffer | null = null
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
    this.lpst?.destroy()
    this.sr = sampleRate
    this.lineLen = Math.max(2, Math.ceil(MAX_DELAY_S * sampleRate))
    this.line = device.createBuffer({
      label: 'delay.line',
      size: this.lineLen * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.lpst = device.createBuffer({
      label: 'delay.lpst',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.reset()
  }

  private getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      const { device } = getGpu()
      this.pipeline = device.createComputePipeline({
        label: 'delay',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: DELAY_WGSL }), entryPoint: 'main' }
      })
    }
    return this.pipeline
  }

  reset(): void {
    if (!this.line) return
    const { device } = getGpu()
    const enc = device.createCommandEncoder()
    enc.clearBuffer(this.line)
    enc.clearBuffer(this.lpst!)
    device.queue.submit([enc.finish()])
  }

  process(enc: GPUCommandEncoder, io: BlockIO): void {
    if (this.bypass) return
    if (this.sr !== io.sampleRate) this.configure(io.sampleRate)
    const { device } = getGpu()
    const p = this.params

    const delaySamples = Math.min(
      this.lineLen - 1,
      Math.max(1, Math.round((p.timeMs / 1000) * io.sampleRate))
    )
    this.u32[0] = io.blockFrames
    this.u32[1] = io.baseIndex >>> 0
    this.u32[2] = this.lineLen
    this.u32[3] = delaySamples
    this.f32[4] = Math.min(0.98, Math.max(0, p.feedback))
    this.f32[5] = Math.min(1, Math.max(0, p.damp))
    this.f32[6] = Math.min(1, Math.max(0, p.wet))
    this.f32[7] = Math.min(1, Math.max(0, p.dry))
    this.f32[8] = p.pingpong ? 1 : 0
    device.queue.writeBuffer(this.ubo, 0, this.ab)

    const pipe = this.getPipeline()
    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: { buffer: io.sig } },
        { binding: 2, resource: { buffer: this.line! } },
        { binding: 3, resource: { buffer: this.lpst! } }
      ]
    })
    const pass = enc.beginComputePass({ label: 'delay' })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(1)
    pass.end()
  }
}
