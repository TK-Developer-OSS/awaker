// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { RecChunk } from '../../../preload/index'
import { getGpu } from '../gpu/device'
import { GpuTrack } from '../gpu/track'

/**
 * Capture side of recording. Input blocks arrive from main (interleaved f32 from
 * the native duplex stream) and are appended straight into growable VRAM buffers
 * — the take's truth lives on the GPU while it is being recorded, same as every
 * other audio source. Nothing is kept in a CPU array; the take is read back once
 * on stop only to write the WAV file.
 */

/** One armed lane's capture routing: which hardware input channel(s) feed it. */
export interface RecTarget {
  laneId: number
  /** First hardware input channel (0-based). */
  ch: number
  /** true = record ch and ch+1 as a stereo pair, false = mono from ch. */
  stereo: boolean
}

export interface Take {
  laneId: number
  startFrame: number
  frames: number
  gpu: GpuTrack
  /** Planar read-back (for the WAV file + meter envelope). */
  planar: Float32Array[]
}

interface Cap {
  target: RecTarget
  bufs: GPUBuffer[]
  capacity: number // frames
  written: number // highest frame written + 1
}

const INITIAL_SECONDS = 30

export class Recorder {
  private caps: Cap[] = []
  readonly startFrame: number

  constructor(targets: RecTarget[], startFrame: number, sampleRate: number) {
    this.startFrame = startFrame
    const { device } = getGpu()
    const capacity = Math.ceil(sampleRate * INITIAL_SECONDS)
    for (const t of targets) {
      const n = t.stereo ? 2 : 1
      this.caps.push({
        target: t,
        capacity,
        written: 0,
        bufs: Array.from({ length: n }, (_, c) =>
          device.createBuffer({
            label: `rec.lane${t.laneId}.ch${c}`,
            size: capacity * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
          })
        )
      })
    }
  }

  /** Targets whose input channels aren't available on the opened device. */
  dropUnavailable(inputChannels: number): RecTarget[] {
    const dropped: RecTarget[] = []
    this.caps = this.caps.filter((c) => {
      const need = c.target.ch + (c.target.stereo ? 2 : 1)
      if (need <= inputChannels) return true
      for (const b of c.bufs) b.destroy()
      dropped.push(c.target)
      return false
    })
    return dropped
  }

  get active(): boolean {
    return this.caps.length > 0
  }

  private grow(cap: Cap, need: number): void {
    const { device } = getGpu()
    let next = cap.capacity
    while (next < need) next *= 2
    const enc = device.createCommandEncoder()
    const bufs = cap.bufs.map((old, c) => {
      const nb = device.createBuffer({
        label: `rec.lane${cap.target.laneId}.ch${c}`,
        size: next * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      })
      enc.copyBufferToBuffer(old, 0, nb, 0, cap.written * 4)
      return nb
    })
    device.queue.submit([enc.finish()])
    for (const b of cap.bufs) b.destroy()
    cap.bufs = bufs
    cap.capacity = next
  }

  /** Append one batched input chunk (deinterleave per target, upload to VRAM). */
  push(chunk: RecChunk): void {
    const { device } = getGpu()
    const nIn = chunk.channels
    const data = new Float32Array(chunk.data)
    const frames = data.length / nIn
    const end = chunk.startFrame + frames
    for (const cap of this.caps) {
      if (end > cap.capacity) this.grow(cap, end)
      for (let c = 0; c < cap.bufs.length; c++) {
        const src = cap.target.ch + c
        if (src >= nIn) continue
        const plane = new Float32Array(frames)
        for (let i = 0; i < frames; i++) plane[i] = data[i * nIn + src]
        device.queue.writeBuffer(cap.bufs[c], chunk.startFrame * 4, plane.buffer as ArrayBuffer, 0, frames * 4)
      }
      if (end > cap.written) cap.written = end
    }
  }

  /** Finish: turn each capture into a GpuTrack (+ CPU read-back for the WAV), free capture buffers. */
  async finish(): Promise<Take[]> {
    const takes: Take[] = []
    for (const cap of this.caps) {
      if (cap.written > 0) {
        const gpu = new GpuTrack()
        gpu.adoptRecorded(cap.bufs, cap.written)
        const planar = await gpu.readChannels()
        takes.push({ laneId: cap.target.laneId, startFrame: this.startFrame, frames: cap.written, gpu, planar })
      }
      for (const b of cap.bufs) b.destroy()
    }
    this.caps = []
    return takes
  }

  /** Abort without producing takes. */
  discard(): void {
    for (const cap of this.caps) for (const b of cap.bufs) b.destroy()
    this.caps = []
  }
}
