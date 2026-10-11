// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { REVERB_AP_WGSL, REVERB_COMB_WGSL } from '../shaders'
import type { BlockIO, Insert } from '../insert'

// Freeverb tunings at 44.1 kHz (Jezar). Scaled to the project sample rate.
const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_TUNING = [556, 441, 341, 225]

export interface ReverbParams {
  /** 0..1 → comb feedback. Bigger = longer tail. */
  roomSize: number
  /** 0..1 → high-frequency damping in the combs. */
  damp: number
  /** 0..1 wet mix. */
  wet: number
  /** 0..1 dry mix. */
  dry: number
}

/**
 * GPU insert reverb (Freeverb). Two compute passes, parallel across comb / sample chunks and
 * numerically equal to the plain serial recurrence (see REVERB_COMB_WGSL). State buffers
 * persist across blocks; `reset()` zeroes them.
 */
export class ReverbInsert implements Insert {
  readonly name = 'reverb'
  bypass = false

  // wet + dry form a single Dry↔Wet balance in the UI (dry = 1 - wet).
  params: ReverbParams = { roomSize: 0.72, damp: 0.35, wet: 0.32, dry: 0.68 }

  private combPipe: GPUComputePipeline | null = null
  private apPipe: GPUComputePipeline | null = null
  private scratch: GPUBuffer | null = null
  private scratchFrames = 0
  private sr = 0
  private combLen: number[] = []
  private apLen: number[] = []
  private cfgBuf: GPUBuffer | null = null
  private combBuf: GPUBuffer | null = null
  private apBuf: GPUBuffer | null = null
  private lpfBuf: GPUBuffer | null = null
  private ubo: GPUBuffer

  constructor() {
    const { device } = getGpu()
    this.ubo = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  private configure(sampleRate: number): void {
    const { device } = getGpu()
    const scale = sampleRate / 44100
    this.combLen = COMB_TUNING.map((n) => Math.max(1, Math.round(n * scale)))
    this.apLen = ALLPASS_TUNING.map((n) => Math.max(1, Math.round(n * scale)))

    const combOff: number[] = []
    let acc = 0
    for (const l of this.combLen) {
      combOff.push(acc)
      acc += l
    }
    const sumComb = acc

    const apOff: number[] = []
    acc = 0
    for (const l of this.apLen) {
      apOff.push(acc)
      acc += l
    }
    const sumAp = acc

    // cfg layout: [combLen x8, combOff x8, apLen x4, apOff x4, sumComb, sumAp]
    const cfg = new Uint32Array(26)
    cfg.set(this.combLen, 0)
    cfg.set(combOff, 8)
    cfg.set(this.apLen, 16)
    cfg.set(apOff, 20)
    cfg[24] = sumComb
    cfg[25] = sumAp

    this.cfgBuf?.destroy()
    this.combBuf?.destroy()
    this.apBuf?.destroy()
    this.lpfBuf?.destroy()

    this.cfgBuf = device.createBuffer({ size: cfg.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(this.cfgBuf, 0, cfg)

    const mk = (floats: number): GPUBuffer =>
      device.createBuffer({ size: floats * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.combBuf = mk(sumComb * 2)
    this.apBuf = mk(sumAp * 2)
    this.lpfBuf = mk(8 * 2)

    this.sr = sampleRate
    this.reset()
  }

  private pipelines(): { comb: GPUComputePipeline; ap: GPUComputePipeline } {
    if (!this.combPipe || !this.apPipe) {
      const { device } = getGpu()
      const make = (label: string, code: string): GPUComputePipeline =>
        device.createComputePipeline({
          label,
          layout: 'auto',
          compute: { module: device.createShaderModule({ code }), entryPoint: 'main' }
        })
      this.combPipe = make('reverb.comb', REVERB_COMB_WGSL)
      this.apPipe = make('reverb.allpass', REVERB_AP_WGSL)
    }
    return { comb: this.combPipe, ap: this.apPipe }
  }

  /** 16 comb outputs + 2 channel accumulators, one block long each. */
  private ensureScratch(blockFrames: number): GPUBuffer {
    if (!this.scratch || this.scratchFrames < blockFrames) {
      const { device } = getGpu()
      this.scratch?.destroy()
      this.scratch = device.createBuffer({ label: 'reverb.scratch', size: 18 * blockFrames * 4, usage: GPUBufferUsage.STORAGE })
      this.scratchFrames = blockFrames
    }
    return this.scratch
  }

  reset(): void {
    if (!this.combBuf) return
    const { device } = getGpu()
    const enc = device.createCommandEncoder()
    enc.clearBuffer(this.combBuf)
    enc.clearBuffer(this.apBuf!)
    enc.clearBuffer(this.lpfBuf!)
    device.queue.submit([enc.finish()])
  }

  process(enc: GPUCommandEncoder, io: BlockIO): void {
    if (this.bypass) return
    if (this.sr !== io.sampleRate) this.configure(io.sampleRate)
    const { device } = getGpu()

    const { roomSize, damp, wet, dry } = this.params
    const feedback = roomSize * 0.28 + 0.7
    const damp1 = damp * 0.4
    const u = new ArrayBuffer(32)
    new Uint32Array(u, 0, 2).set([io.blockFrames, io.baseIndex >>> 0])
    new Float32Array(u, 8, 6).set([feedback, damp1, 1 - damp1, 0.5, wet, dry])
    device.queue.writeBuffer(this.ubo, 0, u)

    const { comb, ap } = this.pipelines()
    const scratch = this.ensureScratch(io.blockFrames)
    const buf = (b: GPUBuffer): GPUBindingResource => ({ buffer: b })
    // 'auto' layouts only contain the bindings a pass uses, so each pass gets exactly its own entries
    const combBind = device.createBindGroup({
      layout: comb.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: buf(this.ubo) },
        { binding: 1, resource: buf(this.cfgBuf!) },
        { binding: 2, resource: buf(io.sig) }, // planar [L | R]
        { binding: 3, resource: buf(this.combBuf!) },
        { binding: 5, resource: buf(this.lpfBuf!) },
        { binding: 6, resource: buf(scratch) }
      ]
    })
    const apBind = device.createBindGroup({
      layout: ap.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: buf(this.ubo) },
        { binding: 1, resource: buf(this.cfgBuf!) },
        { binding: 2, resource: buf(io.sig) },
        { binding: 4, resource: buf(this.apBuf!) },
        { binding: 6, resource: buf(scratch) }
      ]
    })
    // pass 1: 16 workgroups (channel x comb); pass 2: 2 workgroups (channel) — allpass chain + wet/dry
    const p1 = enc.beginComputePass({ label: 'reverb.comb' })
    p1.setPipeline(comb)
    p1.setBindGroup(0, combBind)
    p1.dispatchWorkgroups(16)
    p1.end()
    const p2 = enc.beginComputePass({ label: 'reverb.allpass' })
    p2.setPipeline(ap)
    p2.setBindGroup(0, apBind)
    p2.dispatchWorkgroups(2)
    p2.end()
  }
}
