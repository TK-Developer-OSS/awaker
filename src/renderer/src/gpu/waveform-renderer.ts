// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from './device'
import { WAVE_WGSL } from './shaders'
import { SAMPLES_PER_PEAK } from './track'
import type { DawState } from '../state'

/** One clip resolved for peak drawing: a slice of its source's peak pyramid. */
export interface PeakClip {
  /** Source's full-length peak buffer (vec2<f32> min/max buckets). */
  peakBuffer: GPUBuffer | null
  peakCount: number
  /** First source frame the clip plays from. */
  srcOffset: number
  /** Timeline position of the clip's head. */
  startFrame: number
  lengthFrames: number
  /** Picked in the right-pane audio list → draw this slice brighter. */
  highlight?: boolean
}

const VIEW_UBO_SIZE = 32 // 2×u32 + 4×f32 + 2×f32 clip-edge px, padded

/** Draws a lane's clips straight from their sources' GPU peak buffers. */
export class WaveformRenderer {
  private ctx: GPUCanvasContext
  private pipeline: GPURenderPipeline
  /** Filled quad behind a picked clip (pale mint bar); shares the View uniform. */
  private bgPipeline: GPURenderPipeline
  private bindLayout: GPUBindGroupLayout
  private viewUbos: GPUBuffer[] = []
  private dpr = Math.min(window.devicePixelRatio || 1, 2)

  constructor(private canvas: HTMLCanvasElement) {
    const { device, format } = getGpu()
    this.ctx = canvas.getContext('webgpu') as GPUCanvasContext
    this.ctx.configure({ device, format, alphaMode: 'opaque' })

    const module = device.createShaderModule({ code: WAVE_WGSL })
    // Shared layout so one bind group drives both the fill quad and the wave lines.
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }
      ]
    })
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] })
    this.pipeline = device.createRenderPipeline({
      label: 'waveform',
      layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'line-list' }
    })
    this.bgPipeline = device.createRenderPipeline({
      label: 'waveform-pick-bg',
      layout,
      vertex: { module, entryPoint: 'bgvs' },
      fragment: { module, entryPoint: 'bgfs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    })
  }

  resize(): void {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * this.dpr))
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * this.dpr))
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
  }

  private ensureUbos(n: number): void {
    const { device } = getGpu()
    while (this.viewUbos.length < n) {
      this.viewUbos.push(
        device.createBuffer({ size: VIEW_UBO_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      )
    }
  }

  draw(clips: PeakClip[], state: DawState): void {
    this.resize()
    const { device } = getGpu()
    const cssW = this.canvas.width / this.dpr
    const fpp = state.framesPerPixel
    const spp = SAMPLES_PER_PEAK
    const peaksPerPixel = Math.max(fpp / spp, 1e-6)
    const viewLeft = state.scrollFrames
    const viewRight = state.scrollFrames + cssW * fpp

    this.ensureUbos(clips.length)

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          // Darker emerald lane background; the wave shader draws a brighter shade.
          clearValue: { r: 0.016, g: 0.137, b: 0.106, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    let ubo = 0
    for (const clip of clips) {
      if (!clip.peakBuffer || clip.peakCount <= 0) continue
      const clipL = Math.max(viewLeft, clip.startFrame)
      const clipR = Math.min(viewRight, clip.startFrame + clip.lengthFrames)
      if (clipR <= clipL) continue

      const srcAtL = clip.srcOffset + (clipL - clip.startFrame)
      const srcAtR = clip.srcOffset + (clipR - clip.startFrame)
      const firstBucket = Math.max(0, Math.min(Math.floor(srcAtL / spp), clip.peakCount))
      const lastBucket = Math.max(firstBucket, Math.min(Math.ceil(srcAtR / spp), clip.peakCount))
      const visibleBuckets = lastBucket - firstBucket
      if (visibleBuckets <= 0) continue

      // CSS px (from viewport left) of local bucket 0 = source frame firstBucket*spp.
      const bucket0Timeline = clip.startFrame + (firstBucket * spp - clip.srcOffset)
      const pxOffset = (bucket0Timeline - state.scrollFrames) / fpp
      // Picked-clip fill spans the clip's visible frame range (not the bucket-snapped edge).
      const clipLeftPx = (clipL - state.scrollFrames) / fpp
      const clipRightPx = (clipR - state.scrollFrames) / fpp
      const picked = clip.highlight ? 1 : 0

      const buf = this.viewUbos[ubo++]
      const params = new ArrayBuffer(VIEW_UBO_SIZE)
      new Uint32Array(params, 0, 2).set([clip.peakCount, firstBucket])
      new Float32Array(params, 8, 5).set([peaksPerPixel, cssW, pxOffset, picked, clipLeftPx])
      new Float32Array(params, 28, 1).set([clipRightPx])
      device.queue.writeBuffer(buf, 0, params)

      const bind = device.createBindGroup({
        layout: this.bindLayout,
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: { buffer: clip.peakBuffer } }
        ]
      })
      pass.setBindGroup(0, bind)
      if (picked) {
        pass.setPipeline(this.bgPipeline)
        pass.draw(6)
      }
      pass.setPipeline(this.pipeline)
      pass.draw(visibleBuckets * 2)
    }

    pass.end()
    device.queue.submit([encoder.finish()])
  }
}
