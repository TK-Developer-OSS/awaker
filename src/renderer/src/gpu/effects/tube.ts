// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { TUBE_WGSL } from '../shaders'
import type { BlockIO, Insert } from '../insert'

export interface TubeParams {
  /** The one knob. 0 = clean, 1 = fully driven / harmonically rich. */
  drive: number
}

/**
 * One-knob 12AX7-flavoured tube drive/EQ insert. Fixed tone shaping + an
 * asymmetric soft-saturator; harmonics grow with `drive` (near-clean low, breaks
 * up past the middle thanks to the drive² knee). GPU: 2 threads (L/R), serial
 * over the block — 1-pole IIR is recursive, same as the reverb prototype.
 */
export class TubeInsert implements Insert {
  readonly name = 'tube'
  bypass = false
  params: TubeParams = { drive: 0.35 }

  private pipeline: GPUComputePipeline | null = null
  private sr = 0
  private ubo: GPUBuffer
  private stateBuf: GPUBuffer

  // Sample-rate-dependent filter coeffs (recomputed in configure()).
  private hpR = 0
  private lpEmphA = 0
  private lpOutA = 0

  constructor() {
    const { device } = getGpu()
    this.ubo = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.stateBuf = device.createBuffer({ size: 8 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  }

  private configure(sampleRate: number): void {
    const lp1 = (fc: number): number => 1 - Math.exp((-2 * Math.PI * fc) / sampleRate)
    this.hpR = Math.exp((-2 * Math.PI * 22) / sampleRate) // DC block ~22 Hz
    this.lpEmphA = lp1(1800) // pre-emphasis corner ~1.8 kHz
    this.lpOutA = lp1(12000) // Miller rolloff ~12 kHz
    this.sr = sampleRate
    this.reset()
  }

  private getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      const { device } = getGpu()
      this.pipeline = device.createComputePipeline({
        label: 'tube',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: TUBE_WGSL }), entryPoint: 'main' }
      })
    }
    return this.pipeline
  }

  reset(): void {
    getGpu().device.queue.writeBuffer(this.stateBuf, 0, new Float32Array(8))
  }

  process(enc: GPUCommandEncoder, io: BlockIO): void {
    if (this.bypass) return
    if (this.sr !== io.sampleRate) this.configure(io.sampleRate)
    const { device } = getGpu()

    const drive = Math.min(1, Math.max(0, this.params.drive))
    // drive² knee: lower half barely moves, upper half opens up to ~+33 dB.
    const preGain = Math.pow(10, (drive * drive * 33) / 20)
    const bias = 0.12 + 0.12 * drive // asymmetry grows a little with drive
    const emphAmt = 0.6 + 0.5 * drive // brighter into the shaper as it's pushed
    const makeup = Math.pow(preGain, -0.6) // partial level compensation

    const u = new ArrayBuffer(48)
    new Uint32Array(u, 0, 1)[0] = io.blockFrames
    new Float32Array(u, 8, 7).set([this.hpR, this.lpEmphA, emphAmt, this.lpOutA, bias, preGain, makeup])
    device.queue.writeBuffer(this.ubo, 0, u)

    const pipe = this.getPipeline()
    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: { buffer: io.sig } },
        { binding: 2, resource: { buffer: this.stateBuf } }
      ]
    })
    const pass = enc.beginComputePass({ label: 'tube' })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(1)
    pass.end()
  }
}
