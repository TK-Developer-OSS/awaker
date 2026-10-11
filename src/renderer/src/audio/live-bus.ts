// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from '../gpu/device'
import { MasterBus, type MixSource, type TrackMix } from '../gpu/master-bus'
import type { ChannelStrip } from '../gpu/channel-strip'
import type { Insert } from '../gpu/insert'
import type { RecChunk } from '../../../preload/index'

/**
 * Real-time line input through the same GPU channel strip + inserts as every other track.
 *
 * The playback path renders far ahead (look-ahead 0.5 s) and cannot take live input. This is a
 * second, small-block path: main batches the device's input to ~256 frames and sends it here;
 * we accumulate `BLOCK` frames, upload each live lane's channel(s) to a tiny VRAM buffer, and run
 * them through a private `MasterBus` (strip → inserts → fader/pan) — the input block is just a
 * one-block "clip" at its own timeline position. The result goes back to main tagged with the
 * **output frame** it belongs at (`input frame + latency`), and main places it by frame number
 * (see main/live-ring.ts), so IPC and GPU timing jitter can make a block late but never misplace
 * it. A late block is dropped, not slid.
 *
 * Total monitoring latency = device input latency + (accumulate + process + IPC, covered by
 * `latencyMs`, ~20 ms by default and self-adjusting) + device output latency. Master-bus inserts are not applied to the live path
 * (they are stateful and belong to the playback stream); the master fader is.
 */

/** One line-input track as the live bus sees it. */
export interface LiveLane {
  id: number
  /** First hardware input channel (0-based) and whether ch+1 is the right side. */
  ch: number
  stereo: boolean
  /** Fader (linear, mute folded in) and pan, same meaning as for playback. */
  mix: TrackMix
  strip?: ChannelStrip
  inserts?: Insert[]
}

/** Frames processed per GPU pass: small enough for low latency, large enough to be cheap per block. */
export const LIVE_BLOCK = 512
const MAX_QUEUE = 6

export interface LiveStats {
  /** Blocks processed / dropped because the GPU fell behind. */
  blocks: number
  dropped: number
  /** GPU time per block (ms): mean / max. */
  procMeanMs: number
  procMaxMs: number
}

export class LiveBus {
  private readonly bus = new MasterBus()
  private chunks: Float32Array[] = []
  private accFrames = 0
  private accStart = 0
  private nextStart = -1
  private channels = 0
  private queue: { start: number; data: Float32Array }[] = []
  private busy = false
  private bufs = new Map<number, { l: GPUBuffer; r: GPUBuffer }>()
  private procSum = 0
  private procMax = 0
  blocks = 0
  dropped = 0
  /** Output position = input position + this many ms (accumulate + process + IPC head-room). */
  latencyMs = 0

  constructor(
    private getLanes: () => LiveLane[],
    private masterGain: () => number
  ) {}

  /** Fresh start (stream reopened: input frame counter restarts at 0). */
  reset(): void {
    this.chunks = []
    this.accFrames = 0
    this.nextStart = -1
    this.queue = []
    this.bus.resetStrips()
    this.bus.resetInserts()
    // each live lane's own inserts hold delay lines / filter memory too
    for (const l of this.getLanes()) l.inserts?.forEach((fx) => fx.reset())
  }

  /**
   * Run silence through every live lane once, before the stream opens. The first pass compiles the
   * strip / insert pipelines and builds bind groups (tens of ms) — done live, that backlog would
   * drop blocks at the start of every session. State and counters are cleared afterwards.
   */
  async warmup(sr: number): Promise<void> {
    const need = this.requiredChannels()
    if (need === 0) return
    // Not just once: a cold GPU runs the first ~20 blocks 3-4x slower than steady state (measured:
    // 12-16 ms vs 3.4 ms), enough to overflow the queue at the start of a session. Keep feeding
    // silence until a block costs well under its real-time budget, for at most ~1.2 s.
    const budgetMs = ((LIVE_BLOCK / sr) * 1000) * 0.6
    const silence = new Float32Array(LIVE_BLOCK * need)
    const t0 = performance.now()
    let calm = 0
    for (let i = 0; i < 120 && performance.now() - t0 < 1200; i++) {
      const t = performance.now()
      await this.process(0, silence, sr, need, false)
      calm = performance.now() - t < budgetMs ? calm + 1 : 0
      if (calm >= 4) break
    }
    this.blocks = 0
    this.procSum = 0
    this.procMax = 0
    this.dropped = 0
    this.reset()
  }

  /** Input channels the live lanes need open on the device (0 = no live lanes). */
  requiredChannels(): number {
    let n = 0
    for (const l of this.getLanes()) n = Math.max(n, l.ch + (l.stereo ? 2 : 1))
    return n
  }

  /** Extra head-room learned this session (grows when blocks arrive late, see `bumpAuto`). */
  autoExtraMs = 0

  /**
   * Automatic latency: one block to accumulate + 15 ms for GPU readback and IPC + whatever this
   * session has learned it needs. Measured: 20 ms landed every block of a strip + 3 inserts lane
   * (GPU ~3.5 ms per block); a cold GPU or a busy UI thread can need more.
   */
  defaultLatencyMs(sr: number): number {
    return (LIVE_BLOCK / sr) * 1000 + 15 + this.autoExtraMs
  }

  /** Called when main reports a late block in automatic mode: widen the landing margin a little. */
  bumpAuto(stepMs = 5, maxExtraMs = 60): void {
    this.autoExtraMs = Math.min(maxExtraMs, this.autoExtraMs + stepMs)
  }

  stats(): LiveStats {
    return {
      blocks: this.blocks,
      dropped: this.dropped,
      procMeanMs: this.blocks ? this.procSum / this.blocks : 0,
      procMaxMs: this.procMax
    }
  }

  /** Batched line input from main. */
  feed(c: RecChunk, sr: number): void {
    const ch = c.channels
    const data = new Float32Array(c.data)
    const frames = data.length / ch
    if (ch !== this.channels || c.startFrame !== this.nextStart) {
      // stream (re)opened or a gap — never stitch across it
      this.reset()
      this.channels = ch
      this.accStart = c.startFrame
    }
    this.chunks.push(data)
    this.accFrames += frames
    this.nextStart = c.startFrame + frames

    while (this.accFrames >= LIVE_BLOCK) {
      const block = new Float32Array(LIVE_BLOCK * ch)
      let need = LIVE_BLOCK * ch
      let o = 0
      while (need > 0) {
        const a = this.chunks[0]
        if (a.length <= need) {
          block.set(a, o)
          o += a.length
          need -= a.length
          this.chunks.shift()
        } else {
          block.set(a.subarray(0, need), o)
          this.chunks[0] = a.subarray(need)
          need = 0
        }
      }
      this.queue.push({ start: this.accStart, data: block })
      this.accStart += LIVE_BLOCK
      this.accFrames -= LIVE_BLOCK
      if (this.queue.length > MAX_QUEUE) {
        this.queue.shift() // the GPU is behind: drop the oldest rather than fall further behind
        this.dropped++
      }
    }
    void this.drain(sr)
  }

  private async drain(sr: number): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length) {
        const b = this.queue.shift()!
        await this.process(b.start, b.data, sr)
      }
    } finally {
      this.busy = false
    }
  }

  private laneBuffers(id: number): { l: GPUBuffer; r: GPUBuffer } {
    let b = this.bufs.get(id)
    if (!b) {
      const { device } = getGpu()
      const mk = (label: string): GPUBuffer =>
        device.createBuffer({ label, size: LIVE_BLOCK * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      b = { l: mk(`live.lane${id}.L`), r: mk(`live.lane${id}.R`) }
      this.bufs.set(id, b)
    }
    return b
  }

  private async process(start: number, data: Float32Array, sr: number, nCh = this.channels, send = true): Promise<void> {
    const lanes = this.getLanes()
    if (lanes.length === 0) return
    const t0 = performance.now()
    const { device } = getGpu()
    const plane = (c: number): Float32Array => {
      const p = new Float32Array(LIVE_BLOCK)
      if (c >= 0 && c < nCh) for (let i = 0; i < LIVE_BLOCK; i++) p[i] = data[i * nCh + c]
      return p
    }
    const sources: MixSource[] = lanes.map((ln) => {
      const b = this.laneBuffers(ln.id)
      const left = plane(ln.ch)
      device.queue.writeBuffer(b.l, 0, left.buffer as ArrayBuffer, 0, LIVE_BLOCK * 4)
      if (ln.stereo) {
        const right = plane(ln.ch + 1)
        device.queue.writeBuffer(b.r, 0, right.buffer as ArrayBuffer, 0, LIVE_BLOCK * 4)
      }
      return {
        clips: [
          {
            srcL: b.l,
            srcR: ln.stereo ? b.r : b.l,
            channelCount: ln.stereo ? 2 : 1,
            srcTotalFrames: LIVE_BLOCK,
            startFrame: start,
            srcOffset: 0,
            lengthFrames: LIVE_BLOCK,
            fadeIn: 0,
            fadeOut: 0,
            fadeInShape: 0,
            fadeOutShape: 0,
            gain: 1
          }
        ],
        mix: ln.mix,
        strip: ln.strip,
        inserts: ln.inserts
      }
    })
    this.bus.masterGain = this.masterGain()
    const out = await this.bus.renderBlock(sources, start, LIVE_BLOCK, sr)
    // renderBlock reuses its output array — copy before it goes over IPC
    if (send) {
      const copy = out.slice()
      const latFrames = Math.round(((this.latencyMs || this.defaultLatencyMs(sr)) * sr) / 1000)
      window.daw.liveOut(copy.buffer as ArrayBuffer, start + latFrames, start)
    }
    const ms = performance.now() - t0
    if (send && ms > 12) console.log(`[live] slow block #${this.blocks}: ${ms.toFixed(1)} ms (queue ${this.queue.length})`)
    this.blocks++
    this.procSum += ms
    if (ms > this.procMax) this.procMax = ms
  }
}
