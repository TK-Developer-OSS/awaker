// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { getGpu } from './device'
import { CLIPGATHER_WGSL, INTERLEAVE_WGSL, MIXADD_WGSL } from './shaders'
import type { Insert } from './insert'
import { StripBank, type ChannelStrip } from './channel-strip'

let gatherPipe: GPUComputePipeline | null = null
let mixAddPipe: GPUComputePipeline | null = null
let interleavePipe: GPUComputePipeline | null = null
function pipelines(): {
  gather: GPUComputePipeline
  mixAdd: GPUComputePipeline
  interleave: GPUComputePipeline
} {
  const { device } = getGpu()
  gatherPipe ??= device.createComputePipeline({
    label: 'clipgather',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: CLIPGATHER_WGSL }), entryPoint: 'main' }
  })
  mixAddPipe ??= device.createComputePipeline({
    label: 'mix-add',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: MIXADD_WGSL }), entryPoint: 'main' }
  })
  interleavePipe ??= device.createComputePipeline({
    label: 'interleave',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: INTERLEAVE_WGSL }), entryPoint: 'main' }
  })
  return { gather: gatherPipe, mixAdd: mixAddPipe, interleave: interleavePipe }
}

export interface TrackMix {
  gain: number
  /** -1 (hard left) .. 0 (center) .. +1 (hard right). */
  pan: number
}

/**
 * One clip resolved for rendering: its source's VRAM channel buffers plus the
 * placement / fade / gain the gather shader needs. Built per block by the host
 * from the `Clip` model + source registry.
 */
export interface LaneClip {
  srcL: GPUBuffer
  srcR: GPUBuffer // === srcL when mono
  channelCount: 1 | 2
  srcTotalFrames: number
  startFrame: number
  srcOffset: number
  lengthFrames: number
  fadeIn: number
  fadeOut: number
  fadeInShape: number // 0 lin | 1 equal-power | 2 log
  fadeOutShape: number
  /** Linear per-clip gain. */
  gain: number
}

/**
 * A group channel (bus): the tracks routed to it are summed (each through its own strip / inserts / fader / pan),
 * the sum goes through the group's inserts, then its fader / pan, and is added to the master.
 */
export interface MixGroup {
  mix: TrackMix
  /** Group insert plugins: after the sum, before the group fader / pan. */
  inserts?: Insert[]
}

export interface MixSource {
  /** Index into the `groups` passed to `renderBlock`: this track's output goes to that group instead of the master. */
  group?: number
  /** Placed clips on this lane's timeline. Empty = silent lane. */
  clips: LaneClip[]
  mix: TrackMix
  /** Built-in channel strip (trim / saturation / EQ / comp). Batched across all tracks, runs first. */
  strip?: ChannelStrip
  /** Per-track insert plugins, processed after the strip, before the fader/pan. */
  inserts?: Insert[]
}

const MASTER_UBO_SIZE = 48 // 5×u32 + 4×f32 + peakSlot, padded to 16
const CLIP_UBO_SIZE = 64 // 12×u32 + 4×f32 (see CLIPGATHER_WGSL struct P)

/**
 * Renders one timeline block of the stereo master on the GPU:
 *   1. per lane: clear its `[L|R]` slice of `big`, then accumulate every clip
 *      that overlaps the block into it (`CLIPGATHER_WGSL`, one dispatch/clip,
 *      fades applied here)
 *   2. ONE batched channel-strip dispatch (invocation i = lane i, in place on `big`)
 *   3. per lane: copy its `big` slice → shared `scratch`, run insert plugins,
 *      mix-add (scratch → planar master, gain/pan/masterGain)
 * then the master insert chain, an interleave pass, and a readback — all in a
 * single command encoder / submit. `scratch` is reused across lanes in step 3;
 * WebGPU orders storage writes between passes in one encoder, so each lane's
 * copy → inserts → mix-add sees its own data.
 */
export class MasterBus {
  masterGain = 1
  /** Offline stem / channel export: skip the master insert chain (the master fader is set to unity by the caller). */
  skipMasterChain = false
  /** Offline stem export without the master chain: do not hard-clamp the output at full scale (floats keep their headroom). */
  skipFinalClamp = false
  /** Master insert effects, processed in order after the mix sum. */
  inserts: Insert[] = []

  private blockFrames = 0
  private wgCount = 0
  private planar: GPUBuffer | null = null // [L(block) | R(block)] master sum
  private scratch: GPUBuffer | null = null // [L(block) | R(block)] per-track work buffer (step 3)
  private big: GPUBuffer | null = null // all tracks' post-gather [L|R] slices, stride 2*blockFrames
  private bigBytes = 0
  private readonly stripBank = new StripBank()
  private stripFailLogged = false
  private inter: GPUBuffer | null = null // interleaved [L0,R0,...]
  /**
   * MAP_READ readback buffers, borrowed per block and returned once read: a block's mapAsync may still be
   * pending when the next block is submitted (the live path overlaps them), so one shared buffer would not do.
   */
  private stagingPool = new Map<string, { buf: GPUBuffer; pk: GPUBuffer }[]>()
  private peaksBuf: GPUBuffer | null = null // per-track post-fader peaks (u32 bit patterns of f32), cleared every block
  private peaksCap = 0
  /** Post-fader peak (linear) of each source of the last rendered block, in the order of `sources`. */
  trackPeaks: Float32Array = new Float32Array(0)
  private interBind: GPUBindGroup | null = null // stable while blockFrames holds
  private out = new Float32Array(0) // readback destination, reused every block
  /** One uniform buffer per track slot (reused across blocks; grown on demand). */
  private trackUbos: GPUBuffer[] = []
  /** Uniform buffer pool for per-clip gather (one per clip dispatched in a block). */
  private clipUbos: GPUBuffer[] = []
  private interUbo: GPUBuffer
  private gatherLayout: GPUBindGroupLayout | null = null
  private mixAddLayout: GPUBindGroupLayout | null = null
  /** Cached mix-add bind groups by slot (scratch + planar are block-stable). */
  private mixAddBinds = new Map<string, GPUBindGroup>() // keyed by source / group + where it writes
  private groupBuf: GPUBuffer | null = null // one [L|R] slice per group: the sum of its tracks
  private groupBytes = 0
  /** Post-fader peak (linear) of each group of the last rendered block, in the order of `groups`. */
  groupPeaks: Float32Array = new Float32Array(0)
  /** Scratch for one clip-gather uniform (rewritten per clip). */
  private cuScratch = new ArrayBuffer(CLIP_UBO_SIZE)
  private cuU32 = new Uint32Array(this.cuScratch)
  private cuF32 = new Float32Array(this.cuScratch)
  /** Scratch for the per-track uniform (rewritten and uploaded each block). */
  private ubScratch = new ArrayBuffer(MASTER_UBO_SIZE)
  private ubU32 = new Uint32Array(this.ubScratch)
  private ubF32 = new Float32Array(this.ubScratch)
  /** Monotonic frames processed since the last resetInserts() (for delay indexing). */
  private processed = 0

  constructor() {
    const { device } = getGpu()
    this.interUbo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  /** Clear master insert state and the block counter — call at transport start. */
  resetInserts(): void {
    this.processed = 0
    for (const fx of this.inserts) fx.reset()
  }

  /** Clear every track's channel-strip DSP state (filter memory, envelopes) — call at transport start. */
  resetStrips(): void {
    this.stripBank.reset()
  }

  private ensureBlock(blockFrames: number): void {
    if (this.blockFrames === blockFrames && this.planar) return
    const { device } = getGpu()
    // Per-track slices of `big` are bound to gather at 256-byte offsets
    // (each slice is blockFrames*2*4 bytes) — that needs blockFrames % 32 === 0.
    if (blockFrames % 32 !== 0) {
      console.error(`[master-bus] blockFrames ${blockFrames} is not a multiple of 32 — gather slice offsets will misalign`)
    }
    this.planar?.destroy()
    this.scratch?.destroy()
    this.inter?.destroy()
    for (const list of this.stagingPool.values()) for (const s of list) (s.buf.destroy(), s.pk.destroy())
    this.stagingPool.clear() // borrowed ones return to a fresh pool once read
    this.big?.destroy()
    this.big = null
    this.bigBytes = 0
    this.blockFrames = blockFrames
    this.wgCount = Math.ceil(blockFrames / 256)
    this.out = new Float32Array(blockFrames * 2)
    this.mixAddBinds.clear() // reference the old scratch / planar buffers
    device.queue.writeBuffer(this.interUbo, 0, new Uint32Array([blockFrames]))
    this.planar = device.createBuffer({
      label: 'master.planar',
      size: blockFrames * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.scratch = device.createBuffer({
      label: 'master.scratch',
      size: blockFrames * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST // step 3 copies a `big` slice in
    })
    this.inter = device.createBuffer({
      label: 'master.interleaved',
      size: blockFrames * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    })
    this.interBind = device.createBindGroup({
      layout: pipelines().interleave.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.interUbo } },
        { binding: 1, resource: { buffer: this.planar } },
        { binding: 2, resource: { buffer: this.inter } }
      ]
    })
  }

  /** Big post-gather scratch: `nTracks` contiguous `[L|R]` slices. Grows with the track count. */
  private ensureBig(nTracks: number, blockFrames: number): GPUBuffer {
    const need = nTracks * blockFrames * 2 * 4
    if (this.big && this.bigBytes >= need) return this.big
    const { device } = getGpu()
    this.big?.destroy()
    this.big = device.createBuffer({
      label: 'master.strip-scratch',
      size: need,
      // STORAGE: strip in place · COPY_SRC: step 3 slice→scratch · COPY_DST: per-lane clearBuffer
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    })
    this.bigBytes = need
    return this.big
  }

  private ensureClipUbos(n: number): void {
    const { device } = getGpu()
    while (this.clipUbos.length < n) {
      this.clipUbos.push(
        device.createBuffer({
          label: `master.clipUbo${this.clipUbos.length}`,
          size: CLIP_UBO_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        })
      )
    }
  }

  /** The per-track peak slots (and their readback buffer); the mix-add bind groups reference them. */
  private ensurePeaks(n: number): void {
    if (this.peaksBuf && this.peaksCap >= n) return
    const { device } = getGpu()
    this.peaksBuf?.destroy()
    this.peaksCap = Math.max(32, n)
    this.peaksBuf = device.createBuffer({
      label: 'master.trackPeaks',
      size: this.peaksCap * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    })
    this.mixAddBinds.clear() // they reference the old peaks buffer
  }

  /** A readback pair (audio block + peaks), from the pool or new. Peak size is rounded up so lane-count changes reuse it. */
  private takeStaging(audioBytes: number, peakBytes: number): { buf: GPUBuffer; pk: GPUBuffer; key: string } {
    const pkBytes = Math.max(256, Math.ceil(peakBytes / 256) * 256)
    const key = `${audioBytes}:${pkBytes}`
    const free = this.stagingPool.get(key)?.pop()
    if (free) return { ...free, key }
    const { device } = getGpu()
    const usage = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    return {
      buf: device.createBuffer({ label: 'master.staging', size: audioBytes, usage }),
      pk: device.createBuffer({ label: 'master.trackPeaksStaging', size: pkBytes, usage }),
      key
    }
  }

  private giveStaging(s: { buf: GPUBuffer; pk: GPUBuffer; key: string }): void {
    const list = this.stagingPool.get(s.key) ?? []
    list.push({ buf: s.buf, pk: s.pk })
    this.stagingPool.set(s.key, list)
  }

  private ensureGroupBuf(nGroups: number, blockFrames: number): GPUBuffer {
    const need = nGroups * blockFrames * 2 * 4
    if (this.groupBuf && this.groupBytes >= need) return this.groupBuf
    const { device } = getGpu()
    this.groupBuf?.destroy()
    this.groupBytes = Math.max(need, 4 * blockFrames * 2 * 4)
    this.groupBuf = device.createBuffer({
      label: 'master.groups',
      size: this.groupBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    })
    this.mixAddBinds.clear()
    return this.groupBuf
  }

  private ensureTrackUbos(n: number): void {
    const { device } = getGpu()
    while (this.trackUbos.length < n) {
      this.trackUbos.push(
        device.createBuffer({
          label: `master.trackUbo${this.trackUbos.length}`,
          size: MASTER_UBO_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        })
      )
    }
  }

  /**
   * Compute `blockFrames` of master starting at `startFrame`, return interleaved
   * f32 stereo (`blockFrames * 2` samples). With no sources it returns silence.
   */
  async renderBlock(
    sources: MixSource[],
    startFrame: number,
    blockFrames: number,
    sampleRate: number,
    groups: MixGroup[] = []
  ): Promise<Float32Array> {
    const { device } = getGpu()
    this.ensureBlock(blockFrames)

    if (sources.length === 0) {
      this.processed += blockFrames
      this.out.fill(0)
      return this.out
    }

    const nSrc = sources.length
    const nGrp = groups.length
    this.ensureTrackUbos(nSrc + nGrp)
    this.ensurePeaks(nSrc + nGrp)
    let totalClips = 0
    for (const s of sources) totalClips += s.clips.length
    this.ensureClipUbos(totalClips)
    const { gather, mixAdd, interleave } = pipelines()
    this.gatherLayout ??= gather.getBindGroupLayout(0)
    this.mixAddLayout ??= mixAdd.getBindGroupLayout(0)

    const scratch = this.scratch!
    const planar = this.planar!
    const big = this.ensureBig(sources.length, blockFrames)
    const regionBytes = blockFrames * 2 * 4
    const groupBuf = nGrp > 0 ? this.ensureGroupBuf(nGrp, blockFrames) : null
    const mixAddLayout = this.mixAddLayout!
    const enc = device.createCommandEncoder()
    const u32 = this.ubU32
    const f32 = this.ubF32
    const cu = this.cuU32
    const cf = this.cuF32
    const blockEnd = startFrame + blockFrames

    // 1. per lane: clear its `[L|R]` slice, then accumulate each overlapping clip.
    //    Clip bind groups are rebuilt every block (a few hundred at most, ~6×/s).
    let clipUboIdx = 0
    for (let i = 0; i < sources.length; i++) {
      enc.clearBuffer(big, i * regionBytes, regionBytes)
      for (const c of sources[i].clips) {
        const ovStart = Math.max(startFrame, c.startFrame)
        const ovEnd = Math.min(blockEnd, c.startFrame + c.lengthFrames)
        if (ovEnd <= ovStart) continue
        const count = ovEnd - ovStart
        const clipLocalBase = ovStart - c.startFrame

        cu[0] = count
        cu[1] = ovStart - startFrame // dstOffset
        cu[2] = c.srcOffset + clipLocalBase // srcStart
        cu[3] = c.srcTotalFrames
        cu[4] = c.channelCount
        cu[5] = clipLocalBase
        cu[6] = c.lengthFrames
        cu[7] = c.fadeIn
        cu[8] = c.fadeOut
        cu[9] = c.fadeInShape
        cu[10] = c.fadeOutShape
        cu[11] = 0
        cf[12] = c.gain
        const ub = this.clipUbos[clipUboIdx++]
        device.queue.writeBuffer(ub, 0, this.cuScratch)

        const bind = device.createBindGroup({
          layout: this.gatherLayout,
          entries: [
            { binding: 0, resource: { buffer: ub } },
            { binding: 1, resource: { buffer: c.srcL } },
            { binding: 2, resource: { buffer: c.srcR } },
            { binding: 3, resource: { buffer: big, offset: i * regionBytes, size: regionBytes } }
          ]
        })
        const gp = enc.beginComputePass({ label: `clipgather.lane${i}` })
        gp.setPipeline(gather)
        gp.setBindGroup(0, bind)
        gp.dispatchWorkgroups(Math.ceil(count / 256))
        gp.end()
      }
    }

    // 2. built-in channel strip — ONE batched dispatch, invocation i = track i,
    //    in place on `big`. Inactive slots (no strip / bypassed / transparent) skip.
    //    Guarded: a pipeline/WGSL failure here must not kill the whole master —
    //    fall back to the dry gathered signal.
    try {
      this.stripBank.process(
        enc,
        big,
        sources.map((s) => s.strip),
        blockFrames,
        sampleRate
      )
    } catch (err) {
      if (!this.stripFailLogged) {
        console.error('[master-bus] channel-strip bank failed — running dry:', err)
        this.stripFailLogged = true
      }
    }

    enc.clearBuffer(this.peaksBuf!, 0, (nSrc + nGrp) * 4) // the mix-add passes take the max into these
    // every mix-add accumulates, so the master sum (and the group sums) start from silence each block
    enc.clearBuffer(planar)
    if (groupBuf) enc.clearBuffer(groupBuf, 0, nGrp * regionBytes)
    const fed = new Set<number>() // groups that at least one track is routed to

    // One mix-add pass: scratch -> `to` (the master planar sum or a group slice), with fader / pan / master gain.
    const mixAddInto = (idx: number, mix: TrackMix, toGroup: number | null, label: string): void => {
      const theta = ((mix.pan + 1) * Math.PI) / 4
      u32[0] = blockFrames
      u32[4] = 1 // accumulate
      u32[9] = idx // peak slot
      f32[5] = mix.gain
      f32[6] = Math.cos(theta) * Math.SQRT2 // panL (centre: constant-power, = 1)
      f32[7] = Math.sin(theta) * Math.SQRT2 // panR
      f32[8] = toGroup === null ? this.masterGain : 1 // the master fader acts once, on the way into the master
      device.queue.writeBuffer(this.trackUbos[idx], 0, this.ubScratch)
      const key = `${idx}:${toGroup === null ? 'm' : toGroup}`
      let m = this.mixAddBinds.get(key)
      if (!m) {
        m = device.createBindGroup({
          layout: mixAddLayout,
          entries: [
            { binding: 0, resource: { buffer: this.trackUbos[idx] } },
            { binding: 1, resource: { buffer: scratch } },
            {
              binding: 2,
              resource:
                toGroup === null
                  ? { buffer: planar }
                  : { buffer: groupBuf!, offset: toGroup * regionBytes, size: regionBytes }
            },
            { binding: 3, resource: { buffer: this.peaksBuf! } }
          ]
        })
        this.mixAddBinds.set(key, m)
      }
      const mp = enc.beginComputePass({ label })
      mp.setPipeline(mixAdd)
      mp.setBindGroup(0, m)
      mp.dispatchWorkgroups(this.wgCount)
      mp.end()
    }

    // 3. per track: copy its strip output slice into the shared scratch, run the insert plugins, then
    //    mix-add into the master sum — or into its group's sum. The copy lets the insert / mix-add passes
    //    keep assuming a `[L|R]`-at-0 buffer.
    for (let i = 0; i < nSrc; i++) {
      const { mix, inserts, group } = sources[i]
      enc.copyBufferToBuffer(big, i * regionBytes, scratch, 0, regionBytes)
      const io = { sig: scratch, blockFrames, baseIndex: this.processed, sampleRate }
      if (inserts) {
        for (const fx of inserts) {
          if (!fx.bypass) fx.process(enc, io)
        }
      }
      const toGroup = groupBuf && group !== undefined && group >= 0 && group < nGrp ? group : null
      if (toGroup !== null) fed.add(toGroup)
      mixAddInto(i, mix, toGroup, `mix-add.track${i}`)
    }

    // 3b. group channels: the sum of its tracks -> group inserts -> group fader / pan -> master sum
    for (let g = 0; g < nGrp; g++) {
      if (!fed.has(g)) continue
      enc.copyBufferToBuffer(groupBuf!, g * regionBytes, scratch, 0, regionBytes)
      const io = { sig: scratch, blockFrames, baseIndex: this.processed, sampleRate }
      for (const fx of groups[g].inserts ?? []) {
        if (!fx.bypass) fx.process(enc, io)
      }
      mixAddInto(nSrc + g, groups[g].mix, null, `mix-add.group${g}`)
    }

    // 4. master insert chain (in place on the planar sum)
    for (const fx of this.inserts) {
      if (fx.bypass || this.skipMasterChain) continue
      fx.process(enc, { sig: planar, blockFrames, baseIndex: this.processed, sampleRate })
    }

    // 5. interleave → readback (bind group is stable while blockFrames holds)
    device.queue.writeBuffer(this.interUbo, 0, new Uint32Array([blockFrames, this.skipFinalClamp ? 0 : 1]))
    {
      const pass = enc.beginComputePass({ label: 'interleave' })
      pass.setPipeline(interleave)
      pass.setBindGroup(0, this.interBind!)
      pass.dispatchWorkgroups(this.wgCount)
      pass.end()
    }

    const st = this.takeStaging(blockFrames * 2 * 4, (nSrc + nGrp) * 4)
    enc.copyBufferToBuffer(this.inter!, 0, st.buf, 0, blockFrames * 2 * 4)
    enc.copyBufferToBuffer(this.peaksBuf!, 0, st.pk, 0, (nSrc + nGrp) * 4)
    device.queue.submit([enc.finish()])
    this.processed += blockFrames

    // Everything above ran synchronously, in queue order, so another block may be submitted while this
    // one's readback is pending; its result is a fresh array (not the shared `out`).
    await Promise.all([st.buf.mapAsync(GPUMapMode.READ), st.pk.mapAsync(GPUMapMode.READ)])
    const out = new Float32Array(st.buf.getMappedRange().slice(0))
    st.buf.unmap()
    const pk = new Float32Array(st.pk.getMappedRange(0, (nSrc + nGrp) * 4).slice(0))
    st.pk.unmap()
    this.giveStaging(st)
    // a NaN would sort above every number in the atomic max: show it as a (red) overload, not as silence
    for (let i = 0; i < pk.length; i++) if (!Number.isFinite(pk[i])) pk[i] = 1e6
    this.trackPeaks = pk.subarray(0, nSrc)
    this.groupPeaks = pk.subarray(nSrc)
    return out
  }
}
