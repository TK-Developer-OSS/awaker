// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../device'
import { DRUMS_WGSL } from '../shaders'
import { registerInstrument, type Instrument, type InstrumentNote } from '../instrument'
import type { GpuTrack } from '../track'

/**
 * Analog-style drum machine + hand percussion (GPGPU instrument). Hits are one-shots
 * picked by MIDI key; see DRUMS_WGSL for the voices. The kit is synthesized, not sampled.
 */

export interface DrumLane {
  /** Voice id in the shader. */
  voice: number
  /** MIDI key this voice is written to by the step grid / piano roll. */
  key: number
  name: string
}

export const DRUM_LANES: DrumLane[] = [
  { voice: 0, key: 36, name: 'Kick' },
  { voice: 1, key: 38, name: 'Snare' },
  { voice: 2, key: 39, name: 'Clap' },
  { voice: 3, key: 42, name: 'Closed Hat' },
  { voice: 4, key: 46, name: 'Open Hat' },
  { voice: 5, key: 41, name: 'Tom Lo' },
  { voice: 6, key: 45, name: 'Tom Mid' },
  { voice: 7, key: 48, name: 'Tom Hi' },
  { voice: 8, key: 37, name: 'Rim' },
  { voice: 9, key: 56, name: 'Cowbell' },
  { voice: 10, key: 75, name: 'Clave' },
  { voice: 11, key: 49, name: 'Cymbal' },
  { voice: 12, key: 52, name: 'Djembe Bass' },
  { voice: 13, key: 53, name: 'Djembe Tone' },
  { voice: 14, key: 54, name: 'Djembe Slap' },
  { voice: 15, key: 73, name: 'Guiro Short' },
  { voice: 16, key: 74, name: 'Guiro Long' },
  { voice: 17, key: 60, name: 'Bongo Hi' },
  { voice: 18, key: 61, name: 'Bongo Lo' },
  { voice: 19, key: 62, name: 'Conga Mute' },
  { voice: 20, key: 63, name: 'Conga Open' },
  { voice: 21, key: 64, name: 'Conga Low' }
]

/** Extra General-MIDI keys that map onto the same voices (so imported GM drum parts play). */
const KEY_ALIASES: Record<number, number> = {
  35: 0, // acoustic bass drum
  40: 1, // electric snare
  44: 3, // pedal hat
  43: 5, // floor tom
  47: 6,
  50: 7,
  51: 11, // ride
  57: 11, // crash 2
  59: 11 // ride 2
}

const VOICE_BY_KEY = new Map<number, number>([...DRUM_LANES.map((l): [number, number] => [l.key, l.voice]), ...Object.entries(KEY_ALIASES).map(([k, v]): [number, number] => [Number(k), v])])

export const drumVoiceOfKey = (key: number): number | null => VOICE_BY_KEY.get(key) ?? null
export const drumNameOfKey = (key: number): string | null => {
  const v = VOICE_BY_KEY.get(key)
  return v === undefined ? null : (DRUM_LANES.find((l) => l.voice === v)?.name ?? null)
}

export interface DrumParams {
  /** Pitch ratio for the whole kit. */
  tune: number
  kickDecay: number
  /** Kick pitch-sweep depth 0..1. */
  kickPunch: number
  snareSnap: number
  hatDecay: number
  gain: number
}

export const defaultDrumParams = (): DrumParams => ({
  tune: 1,
  kickDecay: 1,
  kickPunch: 0.5,
  snareSnap: 1,
  hatDecay: 1,
  gain: 1
})

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Seconds until a voice has died out (its envelope is ~-50 dB); the shader stops there. */
function lifeSeconds(voice: number, p: DrumParams): number {
  const base = [1.25 * p.kickDecay, 0.55, 0.5, 0.15 * p.hatDecay, 1.0 * p.hatDecay, 0.9, 0.9, 0.9, 0.12, 0.7, 0.18, 2.8 * p.hatDecay,
    1.5, 0.7, 0.3, 0.12, 0.36, 0.6, 0.7, 0.35, 0.9, 1.1]
  return base[voice] ?? 0.5
}

let pipe: GPUComputePipeline | null = null
const getPipe = (): GPUComputePipeline => {
  if (pipe) return pipe
  const { device } = getGpu()
  pipe = device.createComputePipeline({
    label: 'drums',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: DRUMS_WGSL }), entryPoint: 'main' }
  })
  return pipe
}

const CHUNK = 65535 * 256

export class DrumInstrument implements Instrument {
  readonly kind = 'drums'
  params: DrumParams

  constructor(p?: Partial<DrumParams>) {
    this.params = { ...defaultDrumParams(), ...p }
  }

  tailSeconds(): number {
    return 3
  }

  render(notes: InstrumentNote[], sr: number, out: GpuTrack): void {
    const { device } = getGpu()
    const p = this.params
    // hits → (start, lastFrame, voice, vel), with open hats choked by the next closed hat
    const hits = notes
      .map((n) => ({ start: n.startFrame, voice: drumVoiceOfKey(n.key), vel: clamp(n.vel, 1, 127) / 127 }))
      .filter((h): h is { start: number; voice: number; vel: number } => h.voice !== null)
      .sort((a, b) => a.start - b.start)
    const closed = hits.filter((h) => h.voice === 3).map((h) => h.start)
    const rows = hits.map((h) => {
      let last = h.start + lifeSeconds(h.voice, p) * sr
      if (h.voice === 4) {
        const c = closed.find((s) => s > h.start)
        if (c !== undefined) last = Math.min(last, c)
      }
      return { ...h, last }
    })
    const frames = Math.max(256, Math.ceil(rows.reduce((m, r) => Math.max(m, r.last), 0)) + 1)
    out.prepare(frames, 2)

    const nf = new Float32Array(Math.max(4, rows.length * 4))
    rows.forEach((r, i) => {
      nf[i * 4] = r.start
      nf[i * 4 + 1] = r.last
      nf[i * 4 + 2] = r.voice
      nf[i * 4 + 3] = r.vel
    })
    const noteBuf = device.createBuffer({ label: 'drums.notes', size: nf.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(noteBuf, 0, nf)

    const pl = getPipe()
    const ubos: GPUBuffer[] = []
    for (let base = 0; base < frames; base += CHUNK) {
      const count = Math.min(CHUNK, frames - base)
      const u = new ArrayBuffer(48)
      const u32 = new Uint32Array(u)
      const f32 = new Float32Array(u)
      u32[0] = count
      u32[1] = rows.length
      u32[2] = base
      f32[4] = sr
      f32[5] = clamp(p.tune, 0.5, 2)
      f32[6] = clamp(p.kickDecay, 0.3, 3)
      f32[7] = clamp(p.kickPunch, 0, 1)
      f32[8] = clamp(p.snareSnap, 0, 2)
      f32[9] = clamp(p.hatDecay, 0.3, 3)
      f32[10] = clamp(p.gain, 0, 4)
      const ubo = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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

registerInstrument('drums', 'Drum Machine', (p) => new DrumInstrument(p as Partial<DrumParams> | undefined))
