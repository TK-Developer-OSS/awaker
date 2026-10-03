// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from './device'
import { PEAKS_WGSL, RESAMPLE_WGSL, TONE_WGSL } from './shaders'
import { polyphaseCoeffs, resampledLength, RESAMPLE_PHASES, RESAMPLE_TAPS } from './resample-gpu'

/** Frames collapsed into one (min,max) peak bucket. Fixed for the MVP. */
export const SAMPLES_PER_PEAK = 256

interface Pipelines {
  peaks: GPUComputePipeline
  tone: GPUComputePipeline
  resample: GPUComputePipeline
}
let pipelines: Pipelines | null = null

function getPipelines(): Pipelines {
  if (pipelines) return pipelines
  const { device } = getGpu()
  pipelines = {
    peaks: device.createComputePipeline({
      label: 'peaks',
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: PEAKS_WGSL }), entryPoint: 'main' }
    }),
    tone: device.createComputePipeline({
      label: 'tone',
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: TONE_WGSL }), entryPoint: 'main' }
    }),
    resample: device.createComputePipeline({
      label: 'resample',
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: RESAMPLE_WGSL }), entryPoint: 'main' }
    })
  }
  return pipelines
}

/**
 * One audio track whose sample data lives in GPU VRAM as **planar** float32
 * channel buffers (1 = mono, 2 = stereo). The CPU keeps no copy after upload.
 * Waveform peaks are computed on the GPU from channel 0.
 */
export class GpuTrack {
  channelCount: 1 | 2 = 2
  totalFrames = 0
  peakCount = 0
  /** channels[c]: array<f32> of totalFrames. */
  channels: GPUBuffer[] = []
  peakBuffer: GPUBuffer | null = null

  private allocate(frames: number, channelCount: 1 | 2): void {
    const { device } = getGpu()
    for (const b of this.channels) b.destroy()
    this.peakBuffer?.destroy()

    this.channelCount = channelCount
    this.totalFrames = frames
    this.peakCount = Math.max(1, Math.ceil(frames / SAMPLES_PER_PEAK))

    this.channels = Array.from({ length: channelCount }, (_, c) =>
      device.createBuffer({
        label: `track.ch${c}`,
        size: Math.max(4, frames * 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      })
    )
    this.peakBuffer = device.createBuffer({
      label: 'track.peaks',
      size: this.peakCount * 8, // vec2<f32>
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    })
  }

  /**
   * Upload decoded planar channels (1 or 2). When `fromRate !== toRate` the
   * samples are band-limited resampled to the project rate on the GPU
   * (`RESAMPLE_WGSL`) as they land in VRAM — the CPU array is never kept at
   * project rate. `fromRate === toRate` (or omitted) writes straight through.
   */
  uploadChannels(planar: Float32Array[], fromRate = 0, toRate = 0): void {
    const { device } = getGpu()
    const channelCount: 1 | 2 = planar.length >= 2 ? 2 : 1
    const inLen = planar[0].length

    if (!fromRate || !toRate || fromRate === toRate) {
      this.allocate(inLen, channelCount)
      for (let c = 0; c < channelCount; c++) {
        device.queue.writeBuffer(
          this.channels[c],
          0,
          planar[c].buffer as ArrayBuffer,
          planar[c].byteOffset,
          planar[c].byteLength
        )
      }
      this.computePeaks()
      return
    }

    const outLen = resampledLength(inLen, fromRate, toRate)
    this.allocate(outLen, channelCount)

    const coeffs = polyphaseCoeffs(fromRate, toRate)
    const coeffBuf = device.createBuffer({
      label: 'resample.coeffs',
      size: coeffs.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    device.queue.writeBuffer(coeffBuf, 0, coeffs.buffer as ArrayBuffer, coeffs.byteOffset, coeffs.byteLength)

    const scratch = device.createBuffer({
      label: 'resample.src',
      size: Math.max(4, inLen * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })

    const ubo = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const up = new ArrayBuffer(32)
    new Uint32Array(up, 0, 4).set([outLen, inLen, RESAMPLE_PHASES, RESAMPLE_TAPS])
    new Float32Array(up, 16, 1)[0] = fromRate / toRate // input samples per output frame
    device.queue.writeBuffer(ubo, 0, up)

    const pipe = getPipelines().resample
    // One submit per channel: the scratch buffer is rewritten between channels,
    // and queue writes/submits are ordered, so each pass sees its own input.
    for (let c = 0; c < channelCount; c++) {
      device.queue.writeBuffer(
        scratch,
        0,
        planar[c].buffer as ArrayBuffer,
        planar[c].byteOffset,
        planar[c].byteLength
      )
      const bind = device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: { buffer: scratch } },
          { binding: 2, resource: { buffer: coeffBuf } },
          { binding: 3, resource: { buffer: this.channels[c] } }
        ]
      })
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipe)
      pass.setBindGroup(0, bind)
      // Cap workgroups; the shader grid-strides over the rest.
      pass.dispatchWorkgroups(Math.min(Math.ceil(outLen / 256), 65535))
      pass.end()
      device.queue.submit([enc.finish()])
    }

    scratch.destroy()
    coeffBuf.destroy()
    ubo.destroy()
    this.computePeaks()
  }

  /**
   * Take ownership of a finished recording: copy the first `frames` samples of
   * each capacity buffer in `src` into exact-size channel buffers (the capture
   * buffers are over-allocated and are destroyed by the caller), then peaks.
   */
  adoptRecorded(src: GPUBuffer[], frames: number): void {
    const { device } = getGpu()
    const channelCount: 1 | 2 = src.length >= 2 ? 2 : 1
    this.allocate(frames, channelCount)
    const enc = device.createCommandEncoder()
    for (let c = 0; c < channelCount; c++) enc.copyBufferToBuffer(src[c], 0, this.channels[c], 0, frames * 4)
    device.queue.submit([enc.finish()])
    this.computePeaks()
  }

  /** Read every channel back to the CPU (planar). Used once per take, to write the WAV. */
  async readChannels(): Promise<Float32Array[]> {
    const { device } = getGpu()
    const out: Float32Array[] = []
    for (const ch of this.channels) {
      const bytes = this.totalFrames * 4
      const staging = device.createBuffer({
        size: Math.max(4, bytes),
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      })
      const enc = device.createCommandEncoder()
      enc.copyBufferToBuffer(ch, 0, staging, 0, bytes)
      device.queue.submit([enc.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      out.push(new Float32Array(staging.getMappedRange().slice(0, bytes)))
      staging.unmap()
      staging.destroy()
    }
    return out
  }

  /** Generate a calm stereo test chord entirely on the GPU (no disk, no CPU array). */
  generateTone(seconds: number, sampleRate: number, rootHz = 196): void {
    const { device } = getGpu()
    const frames = Math.floor(seconds * sampleRate)
    this.allocate(frames, 2)

    const pipe = getPipelines().tone
    // Slight detune per channel for stereo width.
    for (let c = 0; c < 2; c++) {
      const params = new ArrayBuffer(32)
      new Uint32Array(params, 0, 1)[0] = frames
      new Float32Array(params, 4, 5).set([sampleRate, rootHz, 0, c === 0 ? 0.997 : 1.003, 0])
      const ubo = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(ubo, 0, params)

      const bind = device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: { buffer: this.channels[c] } }
        ]
      })
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipe)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(Math.ceil(frames / 256))
      pass.end()
      device.queue.submit([enc.finish()])
      ubo.destroy()
    }
    this.computePeaks()
  }

  /** Recompute the (min,max) peak pyramid from channel 0. */
  computePeaks(): void {
    if (!this.channels[0] || !this.peakBuffer) return
    const { device } = getGpu()

    const params = new Uint32Array([this.totalFrames, SAMPLES_PER_PEAK, this.peakCount, 0])
    const ubo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(ubo, 0, params)

    const pipe = getPipelines().peaks
    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubo } },
        { binding: 1, resource: { buffer: this.channels[0] } },
        { binding: 2, resource: { buffer: this.peakBuffer } }
      ]
    })
    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(pipe)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(Math.min(Math.ceil(this.peakCount / 64), 65535))
    pass.end()
    device.queue.submit([enc.finish()])
    ubo.destroy()
  }
}
