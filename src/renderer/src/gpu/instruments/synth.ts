// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { SYNTH_WGSL, SYNTH_FILTER_WGSL } from '../shaders'
import { registerInstrument, type Instrument, type InstrumentNote } from '../instrument'
import type { GpuTrack } from '../track'

export type SynthWave = 'saw' | 'square' | 'tri' | 'sine'
const WAVE_CODE: Record<SynthWave, number> = { saw: 0, square: 1, tri: 2, sine: 3 }

export interface SynthParams {
  wave: SynthWave
  /** Cents between the two oscillators (each is ±detune/2). */
  detuneCents: number
  /** Sub-oscillator (sine, one octave down) 0..1. */
  sub: number
  /** 0 = mono .. 1 = detuned oscillators split left/right. */
  spread: number
  /** Square pulse width 0.05..0.95. */
  pw: number
  atk: number
  dec: number
  sus: number
  rel: number
  /** Low-pass cutoff (>= 0.45·sr = off). */
  cutoffHz: number
  /** 0..1 resonance. */
  res: number
  /** Output gain (linear). */
  gain: number
}

export const defaultSynthParams = (): SynthParams => ({
  wave: 'saw',
  detuneCents: 12,
  sub: 0.3,
  spread: 0.6,
  pw: 0.5,
  atk: 0.01,
  dec: 0.2,
  sus: 0.7,
  rel: 0.25,
  cutoffHz: 9000,
  res: 0.2,
  gain: 1
})

interface Pipes {
  synth: GPUComputePipeline
  filter: GPUComputePipeline
}
let pipes: Pipes | null = null
function getPipes(): Pipes {
  if (pipes) return pipes
  const { device } = getGpu()
  pipes = {
    synth: device.createComputePipeline({
      label: 'synth',
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: SYNTH_WGSL }), entryPoint: 'main' }
    }),
    filter: device.createComputePipeline({
      label: 'synth.filter',
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: SYNTH_FILTER_WGSL }), entryPoint: 'main' }
    })
  }
  return pipes
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const keyHz = (k: number): number => 440 * Math.pow(2, (k - 69) / 12)

// 65535 workgroups × 256 frames per dispatch; chunk byte offsets stay 256-aligned.
const SYNTH_CHUNK = 65535 * 256
const FILTER_CHUNK = 1 << 20

export class SynthInstrument implements Instrument {
  readonly kind = 'synth'
  params: SynthParams

  constructor(p?: Partial<SynthParams>) {
    this.params = { ...defaultSynthParams(), ...p }
  }

  tailSeconds(): number {
    return Math.max(0.01, this.params.rel) + 0.05
  }

  render(notes: InstrumentNote[], sr: number, out: GpuTrack): void {
    const { device } = getGpu()
    const p = this.params
    let lastEnd = 0
    for (const n of notes) lastEnd = Math.max(lastEnd, n.endFrame)
    const frames = Math.max(256, Math.ceil(lastEnd + this.tailSeconds() * sr))
    out.prepare(frames, 2)

    // sorted note table: (start, end, hz, vel)
    const sorted = [...notes].sort((a, b) => a.startFrame - b.startFrame)
    const nf = new Float32Array(Math.max(4, sorted.length * 4))
    sorted.forEach((n, i) => {
      nf[i * 4] = n.startFrame
      nf[i * 4 + 1] = Math.max(n.endFrame, n.startFrame + 1)
      nf[i * 4 + 2] = keyHz(n.key)
      nf[i * 4 + 3] = clamp(n.vel, 1, 127) / 127
    })
    const noteBuf = device.createBuffer({
      label: 'synth.notes',
      size: nf.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    device.queue.writeBuffer(noteBuf, 0, nf)

    const pipe = getPipes().synth
    const ubos: GPUBuffer[] = []
    for (let base = 0; base < frames; base += SYNTH_CHUNK) {
      const count = Math.min(SYNTH_CHUNK, frames - base)
      const u = new ArrayBuffer(64)
      const u32 = new Uint32Array(u)
      const f32 = new Float32Array(u)
      u32[0] = count
      u32[1] = sorted.length
      u32[2] = WAVE_CODE[p.wave] ?? 0
      u32[3] = base
      f32[4] = sr
      f32[5] = clamp(p.detuneCents, 0, 100)
      f32[6] = clamp(p.sub, 0, 1)
      f32[7] = clamp(p.spread, 0, 1)
      f32[8] = Math.max(0.001, p.atk) // never a hard click on note-on
      f32[9] = Math.max(0.001, p.dec)
      f32[10] = clamp(p.sus, 0, 1)
      f32[11] = Math.max(0.005, p.rel)
      f32[12] = clamp(p.gain, 0, 4)
      f32[13] = clamp(p.pw, 0.05, 0.95)
      const ubo = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(ubo, 0, u)
      ubos.push(ubo)
      const off = base * 4
      const size = Math.max(4, count * 4)
      const bind = device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: { buffer: noteBuf } },
          { binding: 2, resource: { buffer: out.channels[0], offset: off, size } },
          { binding: 3, resource: { buffer: out.channels[1], offset: off, size } }
        ]
      })
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipe)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(Math.ceil(count / 256))
      pass.end()
      device.queue.submit([enc.finish()])
    }

    // optional low-pass (recursive → serial, chunked so no single dispatch runs long)
    if (p.cutoffHz < 0.45 * sr) {
      const fp = getPipes().filter
      const st = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      })
      device.queue.writeBuffer(st, 0, new Float32Array(4))
      const g = Math.tan((Math.PI * clamp(p.cutoffHz, 20, 0.45 * sr)) / sr)
      const k = 1 / (0.6 + clamp(p.res, 0, 1) * 9)
      for (let off = 0; off < frames; off += FILTER_CHUNK) {
        const u = new ArrayBuffer(32)
        new Uint32Array(u, 0, 3).set([off, Math.min(FILTER_CHUNK, frames - off), frames])
        new Float32Array(u, 16, 2).set([g, k])
        const ubo = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(ubo, 0, u)
        ubos.push(ubo)
        const bind = device.createBindGroup({
          layout: fp.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: ubo } },
            { binding: 1, resource: { buffer: out.channels[0] } },
            { binding: 2, resource: { buffer: out.channels[1] } },
            { binding: 3, resource: { buffer: st } }
          ]
        })
        const enc = device.createCommandEncoder()
        const pass = enc.beginComputePass()
        pass.setPipeline(fp)
        pass.setBindGroup(0, bind)
        pass.dispatchWorkgroups(1)
        pass.end()
        device.queue.submit([enc.finish()])
      }
      st.destroy() // WebGPU defers destruction until the queued work that uses it is done
    }

    out.computePeaks()
    noteBuf.destroy()
    for (const b of ubos) b.destroy()
  }
}

registerInstrument('synth', 'Simple Synth', (p) => new SynthInstrument(p as Partial<SynthParams> | undefined))
