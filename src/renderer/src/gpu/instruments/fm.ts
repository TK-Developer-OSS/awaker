// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { FM_WGSL } from '../shaders'
import { registerInstrument, type Instrument, type InstrumentNote } from '../instrument'
import type { GpuTrack } from '../track'
import { FM_PRESETS } from './fm-presets'
import { FM_OPS, defaultFmOp, type FmParams } from './fm-types'

export * from './fm-types'

/**
 * FM Synth (kind `fm`) — the line under development. EarlySynth (gpu/instruments/earlysynth/) is the
 * frozen copy of how this instrument first sounded; change this one freely, EarlySynth has its own
 * code and shader (EARLYSYNTH_WGSL) and cannot be affected.
 *
 * 4-operator FM synth (GPGPU instrument), dry by design: chorus / delay / reverb belong on
 * the track's inserts. Tuned for tight transients (see FM_WGSL). Parameters are plain JSON
 * so a preset — or an AI — can write them directly.
 *
 * Routing is a matrix: `mod[i][j]` (j > i) is how much operator j phase-modulates operator
 * i; `out[i]` is operator i's level in the output. Operators with `out[i] === 0` are pure
 * modulators and follow the `index` macro.
 */

export function defaultFmParams(): FmParams {
  // "Pop Pluck" is a good neutral starting point: bright, short, punchy
  return structuredClone(FM_PRESETS['Pop Pluck'])
}

/** A preset's params with the macros reset (used when switching presets). */
export function fmPreset(name: string): FmParams | null {
  const p = FM_PRESETS[name]
  return p ? structuredClone(p) : null
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const keyHz = (k: number): number => 440 * Math.pow(2, (k - 69) / 12)
const CHUNK = 65535 * 256

let pipe: GPUComputePipeline | null = null
const getPipe = (): GPUComputePipeline => {
  if (pipe) return pipe
  const { device } = getGpu()
  pipe = device.createComputePipeline({
    label: 'fm',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: FM_WGSL }), entryPoint: 'main' }
  })
  return pipe
}

/** Longest release time constant (seconds) after the macro — sizes the tail and the gather window. */
function maxRelTau(p: FmParams): number {
  let m = 0.005
  for (const o of p.ops) m = Math.max(m, (o.rel * clamp(p.relScale, 0.1, 8)) / 4.6)
  return m
}

export class FmInstrument implements Instrument {
  readonly kind = 'fm'
  params: FmParams

  constructor(p?: Partial<FmParams>) {
    this.params = { ...defaultFmParams(), ...p }
  }

  tailSeconds(): number {
    return maxRelTau(this.params) * 7 + 0.05
  }

  render(notes: InstrumentNote[], sr: number, out: GpuTrack): void {
    const { device } = getGpu()
    const p = this.params
    let lastEnd = 0
    for (const n of notes) lastEnd = Math.max(lastEnd, n.endFrame)
    const frames = Math.max(256, Math.ceil(lastEnd + this.tailSeconds() * sr))
    out.prepare(frames, 2)

    const sorted = [...notes].sort((a, b) => a.startFrame - b.startFrame)
    const nf = new Float32Array(Math.max(4, sorted.length * 4))
    sorted.forEach((n, i) => {
      nf[i * 4] = n.startFrame
      nf[i * 4 + 1] = Math.max(n.endFrame, n.startFrame + 1)
      nf[i * 4 + 2] = keyHz(n.key)
      nf[i * 4 + 3] = clamp(n.vel, 1, 127) / 127
    })
    const noteBuf = device.createBuffer({ label: 'fm.notes', size: nf.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(noteBuf, 0, nf)

    const pl = getPipe()
    const ubos: GPUBuffer[] = []
    const atkS = clamp(p.atkScale, 0.1, 8)
    const relS = clamp(p.relScale, 0.1, 8)
    for (let base = 0; base < frames; base += CHUNK) {
      const count = Math.min(CHUNK, frames - base)
      const u = new ArrayBuffer(272)
      const u32 = new Uint32Array(u)
      const f = new Float32Array(u)
      u32[0] = count
      u32[1] = sorted.length
      u32[2] = base
      f[4] = sr
      f[5] = clamp(p.gain, 0, 4)
      f[6] = clamp(p.click, 0, 2)
      f[7] = Math.pow(2, clamp(p.pitchPunch, 0, 36) / 12) - 1
      f[8] = Math.max(0.001, p.pitchTime)
      f[9] = p.feedback.amount > 0 ? clamp(p.feedback.op | 0, 0, FM_OPS - 1) : -1
      f[10] = clamp(p.feedback.amount, 0, 3)
      f[11] = clamp(p.index, 0, 4)
      f[12] = maxRelTau(p)
      for (let i = 0; i < FM_OPS; i++) {
        const o = p.ops[i] ?? defaultFmOp()
        f.set([o.ratio * Math.pow(2, o.fine / 1200), Math.max(0, o.fixedHz), clamp(o.level, 0, 2), clamp(o.velSens, 0, 1)], 16 + i * 4)
        f.set([Math.max(0.0003, o.atk * atkS), Math.max(1e-3, o.dec / 4.6), clamp(o.sus, 0, 1), Math.max(1e-3, (o.rel * relS) / 4.6)], 32 + i * 4)
        f.set([0, 1, 2, 3].map((j) => (j > i ? (p.mod[i]?.[j] ?? 0) : 0)), 48 + i * 4)
      }
      f.set([0, 1, 2, 3].map((i) => p.out[i] ?? 0), 64)
      const ubo = device.createBuffer({ size: 272, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(ubo, 0, u)
      ubos.push(ubo)
      const off = base * 4
      const size = Math.max(4, count * 4)
      const bind = device.createBindGroup({
        layout: pl.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: { buffer: noteBuf } },
          { binding: 2, resource: { buffer: out.channels[0], offset: off, size } },
          { binding: 3, resource: { buffer: out.channels[1], offset: off, size } }
        ]
      })
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pl)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(Math.ceil(count / 256))
      pass.end()
      device.queue.submit([enc.finish()])
    }
    out.computePeaks()
    noteBuf.destroy()
    for (const b of ubos) b.destroy()
  }
}

registerInstrument('fm', 'FM Synth', (p) => new FmInstrument(p as Partial<FmParams> | undefined))
