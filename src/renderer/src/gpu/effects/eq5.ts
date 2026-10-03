// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { EQ5_WGSL } from '../shaders'
import { biquad, type BqKind } from '../biquad'
import type { BlockIO, Insert } from '../insert'

export interface Eq5Band {
  freq: number
  gainDb: number
  q: number
}

/** Fixed band shapes: shelf / peak / peak / peak / shelf. */
const KINDS: BqKind[] = ['lowshelf', 'peak', 'peak', 'peak', 'highshelf']

/**
 * Digital 5-band parametric EQ insert — 5 RBJ biquads in series per channel
 * (see EQ5_WGSL). Clean and "digital" (the counterpart to the strip's
 * analogue-voiced console EQ). A band at 0 dB is a mathematical passthrough, so all 5 always run.
 */
export class Eq5Insert implements Insert {
  readonly name = 'eq5'
  bypass = false
  bands: Eq5Band[] = [
    { freq: 80, gainDb: 0, q: 0.7 },
    { freq: 250, gainDb: 0, q: 1.0 },
    { freq: 1000, gainDb: 0, q: 1.0 },
    { freq: 4000, gainDb: 0, q: 1.0 },
    { freq: 12000, gainDb: 0, q: 0.7 }
  ]

  private pipeline: GPUComputePipeline | null = null
  private ubo: GPUBuffer
  private state: GPUBuffer
  private ab = new ArrayBuffer(128)
  private u32 = new Uint32Array(this.ab)
  private f32 = new Float32Array(this.ab)

  constructor() {
    const { device } = getGpu()
    this.ubo = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.state = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  }

  private getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      const { device } = getGpu()
      this.pipeline = device.createComputePipeline({
        label: 'eq5',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: EQ5_WGSL }), entryPoint: 'main' }
      })
    }
    return this.pipeline
  }

  reset(): void {
    getGpu().device.queue.writeBuffer(this.state, 0, new Float32Array(64))
  }

  process(enc: GPUCommandEncoder, io: BlockIO): void {
    if (this.bypass) return
    const { device } = getGpu()
    this.u32[0] = io.blockFrames
    for (let k = 0; k < 5; k++) {
      const b = this.bands[k]
      this.f32.set(biquad(KINDS[k], io.sampleRate, b.freq, b.q, b.gainDb), 2 + k * 5)
    }
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
    const pass = enc.beginComputePass({ label: 'eq5' })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(1)
    pass.end()
  }
}
