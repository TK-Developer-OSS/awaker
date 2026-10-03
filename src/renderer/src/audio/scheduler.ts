// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { AudioOutStatus, RecChunk } from '../../../preload/index'
import { Recorder, type RecTarget, type Take } from './recorder'
import { MasterBus, type MixSource } from '../gpu/master-bus'
import { state, update } from '../state'

/**
 * Look-ahead playback scheduler. Renders the stereo master on the GPU a block at
 * a time (summing every ready track), reads it back, and streams it to the
 * native output in `main`, keeping the device's ring buffer near
 * `TARGET_LOOKAHEAD_S`.
 *
 * Pacing and transport position are driven by `main`'s `audio:status` (ring
 * occupancy + device frames elapsed), interpolated with `performance.now()`
 * between updates. There is no AudioContext clock.
 *
 * On Stop (and at end of track) the transport shows stopped immediately, but if
 * an insert is active the engine keeps feeding it silence so its tail (reverb
 * etc.) rings out before the device really closes — see `tailing`.
 */
// Render granularity for the look-ahead. Each block is one GPU submit + one
// mapAsync readback, so bigger blocks = far fewer of those per second — at
// 192 kHz, 32768 frames is ~6 readback cycles/s instead of ~23. This is the
// main lever for playback GPU-engine load. Unrelated to the device block size
// (negotiated in main).
const BLOCK_FRAMES = 32768
// Look-ahead in seconds (rate-independent). Generous: this is file playback, not
// live monitoring, and it must comfortably hold a couple of the larger blocks.
const TARGET_LOOKAHEAD_S = 0.5
const MIN_TOPUP_S = 0.25
/** Max time to keep rendering an insert tail after Stop. */
const TAIL_MAX_S = 8
/** Below this peak for a couple of blocks, the tail is considered done. */
const TAIL_SILENCE_PEAK = 2e-4

// --- LUFS metering (ITU-R BS.1770-4) -----------------------------------------
// The master readback is K-weighted and integrated in 100 ms sub-blocks; a ring
// of them gives Momentary (400 ms) and Short-term (3 s) loudness. Every 100 ms a
// 400 ms gating block is also collected for the gated Integrated measurement
// (absolute -70 LUFS + relative -10 LU gate). The K-weighting uses the exact
// BS.1770 pre-filter + RLB high-pass, derived analytically for the running sample
// rate (libebur128's method) — an earlier RBJ high-shelf approximation read
// ~1-2 dB low in the 2-8 kHz band and is not used any more.
const LUFS_SUB_S = 0.1
const LUFS_MOM_SUBS = 4 // 400 ms
const LUFS_ST_SUBS = 30 // 3 s (also the ring length)
// Absolute gate: block power below -70 LUFS is dropped before it reaches the
// Integrated average. L = -0.691 + 10·log10(p)  ⇒  p = 10^((-70 + 0.691) / 10).
const LUFS_ABS_GATE_POWER = Math.pow(10, (-70 + 0.691) / 10)
// PROVISIONAL display calibration. The BS.1770 filter maths is exact, but on the
// dev machine the readout still sat low vs. commercial masters, so a flat trim is
// added to every displayed LUFS value (Momentary / Short-term / Integrated / Max)
// until it's checked against a certified reference — then adjust or drop to 0.
// See README session log 2026-09-07(6) follow-up.
const LUFS_CALIB_DB = 2.0

export interface BounceResult {
  frames: number
  seconds: number
  sampleRate: number
  peak: number[]
  peakDb: number[]
  rmsDb: number[]
  dcOffset: number[]
  clippedFrames: number
  lufsIntegrated: number
  lufsMaxShortTerm: number
  contourDb: number[]
  renderMs: number
  audio: Float32Array | null
}

export class PlaybackScheduler {
  readonly masterBus: MasterBus
  private timer: number | null = null
  private busy = false

  private startFrame = 0
  private scheduledFrame = 0 // master-timeline frame rendered up to
  private sentFrames = 0 // total frames handed to main since start
  private started = false // device is actually pulling (post audioBegin)

  private tailing = false // Stop pressed / track ended, insert tail ringing out
  private tailDeadline = 0 // performance.now() hard stop for the tail
  private quietBlocks = 0
  private finishing = false

  // Snapshot from the last audio:status, for interpolation.
  private st = { at: 0, playedFrames: 0, bufferedFrames: 0, sentFrames: 0, underrunFrames: 0 }
  private backend = ''
  private deviceName = ''
  /** Active take capture (null unless recording). */
  private rec: Recorder | null = null
  /** Set by the host: receives the finished takes when a recording stops. */
  onTakes: ((takes: Take[], startFrame: number) => void) | null = null
  /** Set by the host: surfaces record warnings (dropped inputs, no device input…). */
  onRecNotice: ((msg: string) => void) | null = null
  /** Last status' input info, for UI / MCP. */
  inputChannels = 0
  inputError = ''
  /** Peak of the most recently rendered master block (post master-gain, ±1). */
  private masterBlockPeak = 0

  // --- LUFS meter state (see meterBlock) ---
  private lufsSr = 0
  private kwSh: number[] = [] // K-weight pre-filter (high-shelf) [b0,b1,b2,a1,a2]
  private kwHp: number[] = [] // K-weight RLB high-pass
  private kwZ = new Float64Array(16) // biquad memory: ch0 shelf 0..3, ch1 shelf 4..7, ch0 hp 8..11, ch1 hp 12..15
  private lufsSubLen = 0 // samples per sub-block
  private lufsAcc = 0 // Σ(yL²+yR²) in the current sub-block
  private lufsCount = 0 // frames accumulated in the current sub-block
  private lufsRing = new Float64Array(LUFS_ST_SUBS) // per-sub-block power (both channels)
  private lufsRingPos = 0
  private lufsRingFill = 0
  private lufsMaxST = -Infinity // loudest Short-term seen since the last start()
  private lufsGate: number[] = [] // 400 ms gating-block powers (abs-gated) for Integrated
  private lufsICache = -Infinity // memoised Integrated (two-pass gate is O(n))
  private lufsICacheLen = -1

  constructor(private getSources: () => MixSource[]) {
    this.masterBus = new MasterBus()
  }

  /** Lanes that have at least one placed clip (mute is a gain-0 mix, not a filter). */
  private ready(): MixSource[] {
    return this.getSources().filter((s) => s.clips.length > 0)
  }

  /** Transport end = the furthest clip edge across all lanes. */
  private totalFrames(): number {
    if (this.rec) return Number.MAX_SAFE_INTEGER // recording runs until Stop, past the last clip
    let m = 0
    for (const s of this.ready()) {
      for (const c of s.clips) m = Math.max(m, c.startFrame + c.lengthFrames)
    }
    return m
  }

  /** Compile the master pipeline ahead of the first Play (avoids a startup gap). */
  async warmup(): Promise<void> {
    const src = this.ready()
    if (src.length) await this.masterBus.renderBlock(src, 0, 256, state.sampleRate)
  }

  onStatus(s: AudioOutStatus): void {
    this.st = {
      at: performance.now(),
      playedFrames: s.playedFrames,
      bufferedFrames: s.bufferedFrames,
      sentFrames: this.sentFrames,
      underrunFrames: s.underrunFrames
    }
    this.backend = s.backend
    this.deviceName = s.deviceName
    this.inputChannels = s.inputChannels
    this.inputError = s.inputError
  }

  get recording(): boolean {
    return this.rec !== null
  }

  /** Input chunk from main → capture buffers (ignored when not recording). */
  onRecChunk(c: RecChunk): void {
    this.rec?.push(c)
  }

  private engineLive(): boolean {
    return (state.playing || this.tailing) && this.started
  }

  /** Estimated device frames played since start (interpolated). */
  private playedNow(): number {
    if (!this.engineLive()) return 0
    const elapsed = ((performance.now() - this.st.at) / 1000) * state.sampleRate
    return this.st.playedFrames + Math.max(0, elapsed)
  }

  /** Estimated frames sitting in main's ring, waiting to play. */
  private bufferedNow(): number {
    const producedSince = this.sentFrames - this.st.sentFrames
    const playedSince = this.playedNow() - this.st.playedFrames
    const est = this.st.bufferedFrames + producedSince - playedSince
    // Clamp: once playback is winding down the interpolation over-estimates
    // because nothing is producing but wall-clock keeps the "played" term small.
    return Math.min(Math.max(0, est), state.sampleRate) // <= ~1 s
  }

  // ---- LUFS metering -------------------------------------------------------

  private configureLufs(sr: number): void {
    if (sr === this.lufsSr) return
    // Exact BS.1770 K-weighting, derived for `sr` (libebur128 filter.c). Both
    // stages are second-order; coeffs normalised to a0 = 1 → [b0,b1,b2,a1,a2].
    {
      // Stage 1 — high-frequency shelving boost.
      const f0 = 1681.9744509555319
      const dbG = 3.999843853973347
      const Q = 0.7071752369554193
      const K = Math.tan((Math.PI * f0) / sr)
      const Vh = Math.pow(10, dbG / 20)
      const Vb = Math.pow(Vh, 0.4996667741545416)
      const a0 = 1 + K / Q + K * K
      this.kwSh = [
        (Vh + (Vb * K) / Q + K * K) / a0,
        (2 * (K * K - Vh)) / a0,
        (Vh - (Vb * K) / Q + K * K) / a0,
        (2 * (K * K - 1)) / a0,
        (1 - K / Q + K * K) / a0
      ]
    }
    {
      // Stage 2 — RLB high-pass.
      const f0 = 38.13547087602444
      const Q = 0.5003270373238773
      const K = Math.tan((Math.PI * f0) / sr)
      const a0 = 1 + K / Q + K * K
      this.kwHp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]
    }
    this.lufsSubLen = Math.max(1, Math.round(LUFS_SUB_S * sr))
    this.lufsSr = sr
    this.resetLufs()
  }

  private resetLufs(): void {
    this.kwZ.fill(0)
    this.lufsAcc = 0
    this.lufsCount = 0
    this.lufsRing.fill(0)
    this.lufsRingPos = 0
    this.lufsRingFill = 0
    this.lufsMaxST = -Infinity
    this.lufsGate.length = 0
    this.lufsICache = -Infinity
    this.lufsICacheLen = -1
  }

  /** Direct-form-I biquad, state at z[o..o+3] = x1,x2,y1,y2. */
  private df1(z: Float64Array, o: number, c: number[], x: number): number {
    const y = c[0] * x + c[1] * z[o] + c[2] * z[o + 1] - c[3] * z[o + 2] - c[4] * z[o + 3]
    z[o + 1] = z[o]
    z[o] = x
    z[o + 3] = z[o + 2]
    z[o + 2] = y
    return y
  }

  private ringMeanPower(nSubs: number): number {
    const k = Math.min(nSubs, this.lufsRingFill)
    if (k === 0) return 0
    let s = 0
    for (let i = 0; i < k; i++) {
      s += this.lufsRing[(this.lufsRingPos - 1 - i + LUFS_ST_SUBS * 2) % LUFS_ST_SUBS]
    }
    return s / k
  }

  private momLufs(): number {
    const p = this.ringMeanPower(LUFS_MOM_SUBS)
    return p > 0 ? -0.691 + 10 * Math.log10(p) + LUFS_CALIB_DB : -Infinity
  }

  private stLufs(): number {
    const p = this.ringMeanPower(LUFS_ST_SUBS)
    return p > 0 ? -0.691 + 10 * Math.log10(p) + LUFS_CALIB_DB : -Infinity
  }

  /**
   * Gated Integrated loudness over everything played since `start()` (BS.1770-4):
   * the absolute -70 LUFS gate is applied when a gating block is collected; here
   * the relative gate (mean − 10 LU) is applied and the survivors averaged.
   * Memoised — only recomputed when a new gating block has been added.
   */
  private integratedLufs(): number {
    const G = this.lufsGate
    if (G.length === this.lufsICacheLen) return this.lufsICache
    let out = -Infinity
    if (G.length > 0) {
      let sum = 0
      for (let i = 0; i < G.length; i++) sum += G[i]
      const relThreshPow = (sum / G.length) * 0.1 // mean − 10 LU, in power
      let s2 = 0
      let n2 = 0
      for (let i = 0; i < G.length; i++) {
        if (G[i] >= relThreshPow) {
          s2 += G[i]
          n2++
        }
      }
      if (n2 > 0) out = -0.691 + 10 * Math.log10(s2 / n2) + LUFS_CALIB_DB
    }
    this.lufsICache = out
    this.lufsICacheLen = G.length
    return out
  }

  /** K-weight + integrate one interleaved-stereo master block for the LUFS meter. */
  private meterBlock(block: Float32Array): void {
    this.configureLufs(state.sampleRate)
    const sh = this.kwSh
    const hp = this.kwHp
    const z = this.kwZ
    for (let j = 0; j < block.length; j += 2) {
      const l = this.df1(z, 8, hp, this.df1(z, 0, sh, block[j]))
      const r = this.df1(z, 12, hp, this.df1(z, 4, sh, block[j + 1]))
      this.lufsAcc += l * l + r * r
      if (++this.lufsCount >= this.lufsSubLen) {
        this.lufsRing[this.lufsRingPos] = this.lufsAcc / this.lufsCount // power, both channels
        this.lufsRingPos = (this.lufsRingPos + 1) % LUFS_ST_SUBS
        if (this.lufsRingFill < LUFS_ST_SUBS) this.lufsRingFill++
        this.lufsAcc = 0
        this.lufsCount = 0
        const st = this.stLufs()
        if (Number.isFinite(st) && st > this.lufsMaxST) this.lufsMaxST = st
        // Collect a 400 ms gating block (step = one sub-block = 100 ms, so 75%
        // overlap) once the ring holds a full window. Absolute -70 LUFS gate here.
        if (this.lufsRingFill >= LUFS_MOM_SUBS) {
          const gp = this.ringMeanPower(LUFS_MOM_SUBS)
          if (gp >= LUFS_ABS_GATE_POWER) this.lufsGate.push(gp)
        }
      }
    }
  }

  metrics(): {
    bufferedMs: number
    underrunFrames: number
    tailing: boolean
    backend: string
    deviceName: string
    masterPeak: number
    lufsM: number
    lufsS: number
    lufsI: number
    lufsMax: number
  } {
    const live = state.playing || this.tailing
    return {
      bufferedMs: (this.bufferedNow() / state.sampleRate) * 1000,
      underrunFrames: this.st.underrunFrames,
      tailing: this.tailing,
      backend: this.backend,
      deviceName: this.deviceName,
      masterPeak: live ? this.masterBlockPeak : 0,
      lufsM: live ? this.momLufs() : -Infinity,
      lufsS: live ? this.stLufs() : -Infinity,
      // Integrated + Max stay readable after Stop (they describe the whole take).
      lufsI: this.integratedLufs(),
      lufsMax: this.lufsMaxST
    }
  }

  /**
   * Offline bounce for regression: render the master through the full GPU path
   * (clips → strips → inserts → master chain) with NO audio device, and return
   * level / loudness statistics. Same state resets as a Play so runs are comparable.
   * `tailSeconds` renders past the last clip so reverb / delay tails are included.
   */
  async bounce(
    startFrame: number,
    seconds: number | null,
    tailSeconds: number,
    keepAudio: boolean
  ): Promise<BounceResult> {
    if (state.playing || this.rec) throw new Error('stop transport before bounce')
    if (this.tailing) await this.finish() // an insert tail still ringing out: cut it, the render has its own
    const sr = state.sampleRate
    const src = this.ready()
    const from = Math.max(0, Math.floor(startFrame))
    const frames = Math.max(
      0,
      seconds != null ? Math.floor(seconds * sr) : this.totalFrames() - from + Math.floor(tailSeconds * sr)
    )
    this.resetLufs()
    this.masterBus.resetInserts()
    this.masterBus.resetStrips()
    for (const s of this.getSources()) s.inserts?.forEach((fx) => fx.reset())

    const winFrames = Math.max(1, Math.floor(sr * 0.5))
    const pk = [0, 0]
    const sq = [0, 0]
    const sum = [0, 0]
    let clipped = 0
    const winSq: number[] = []
    let wAcc = 0
    let wN = 0
    const kept: Float32Array[] = []
    const t0 = performance.now()
    for (let pos = 0; pos < frames; pos += BLOCK_FRAMES) {
      const block = await this.masterBus.renderBlock(src, from + pos, BLOCK_FRAMES, sr)
      const n = Math.min(BLOCK_FRAMES, frames - pos)
      this.meterBlock(n === BLOCK_FRAMES ? block : block.subarray(0, n * 2))
      for (let i = 0; i < n; i++) {
        const l = block[i * 2]
        const r = block[i * 2 + 1]
        const al = l < 0 ? -l : l
        const ar = r < 0 ? -r : r
        if (al > pk[0]) pk[0] = al
        if (ar > pk[1]) pk[1] = ar
        if (al >= 1 || ar >= 1) clipped++
        sq[0] += l * l
        sq[1] += r * r
        sum[0] += l
        sum[1] += r
        wAcc += l * l + r * r
        if (++wN >= winFrames) {
          winSq.push(wAcc / (2 * wN))
          wAcc = 0
          wN = 0
        }
      }
      if (keepAudio) kept.push(block.slice(0, n * 2))
    }
    if (wN > 0) winSq.push(wAcc / (2 * wN))
    const db = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity)
    const nf = Math.max(1, frames)
    let audio: Float32Array | null = null
    if (keepAudio) {
      audio = new Float32Array(frames * 2)
      let o = 0
      for (const b of kept) {
        audio.set(b, o)
        o += b.length
      }
    }
    return {
      frames,
      seconds: frames / sr,
      sampleRate: sr,
      peak: pk,
      peakDb: [db(pk[0]), db(pk[1])],
      rmsDb: [db(Math.sqrt(sq[0] / nf)), db(Math.sqrt(sq[1] / nf))],
      dcOffset: [sum[0] / nf, sum[1] / nf],
      clippedFrames: clipped,
      lufsIntegrated: this.integratedLufs(),
      lufsMaxShortTerm: this.lufsMaxST,
      /** RMS (dB, both channels) per 0.5 s window — the loudness contour of the render. */
      contourDb: winSq.map(db),
      renderMs: performance.now() - t0,
      audio
    }
  }

  currentFrame(): number {
    if (!state.playing) return state.playhead
    return Math.min(this.startFrame + this.playedNow(), this.totalFrames())
  }

  /**
   * Relocate the transport to `frame`. While stopped this just moves the
   * playhead (Play picks it up). While playing it does a hard locate: close the
   * device and restart rendering from the new position — a brief gap on the
   * jump, and insert tails are cleared (same as pressing Play there).
   */
  async seek(frame: number): Promise<void> {
    if (this.rec) return // locating mid-take would tear the recording
    const total = this.totalFrames()
    const f = Math.max(0, Math.floor(frame))
    if (!state.playing) {
      update({ playhead: Math.min(f, total) })
      return
    }
    update({ playing: false })
    await this.finish()
    await this.start(Math.min(f, Math.max(0, total - 1)))
  }

  private hasActiveInsert(): boolean {
    if (this.masterBus.inserts.some((fx) => !fx.bypass)) return true
    // Per-track insert plugins (delay / reverb) also need their tail to ring out.
    return this.getSources().some((s) => s.inserts?.some((fx) => !fx.bypass))
  }

  /**
   * Start transport with record. Plays any existing clips from `fromFrame` while
   * capturing each target's input into a new take (committed on stop()).
   */
  async startRecord(
    fromFrame: number,
    targets: RecTarget[],
    opts: { synthetic?: boolean } = {}
  ): Promise<boolean> {
    if (state.playing || targets.length === 0) return false
    // Clear a lingering tail first — finish() would otherwise end the recording we're about to create.
    if (this.tailing || this.timer !== null) await this.finish()
    const inputChannels = opts.synthetic ? 0 : Math.max(...targets.map((t) => t.ch + (t.stereo ? 2 : 1)))
    this.rec = new Recorder(targets, Math.max(0, Math.floor(fromFrame)), state.sampleRate)
    await this.start(fromFrame, { inputChannels, synthetic: !!opts.synthetic })
    if (!this.rec) return false
    if (!opts.synthetic) {
      const dropped = this.rec.dropUnavailable(this.inputChannels)
      if (this.inputError) this.onRecNotice?.(this.inputError)
      else if (dropped.length) this.onRecNotice?.(`input has ${this.inputChannels} ch — ${dropped.length} armed track(s) skipped`)
      if (!this.rec.active) {
        await this.stop()
        return false
      }
    }
    return true
  }

  async start(fromFrame: number, rec?: { inputChannels: number; synthetic: boolean }): Promise<void> {
    if (state.playing) return
    if (!this.ready().length && !this.rec) return
    // Cancel any lingering insert tail from a previous stop.
    if (this.tailing || this.timer !== null) await this.finish()

    this.startFrame = Math.max(0, Math.floor(fromFrame))
    this.scheduledFrame = this.startFrame
    this.sentFrames = 0
    this.started = false
    this.tailing = false
    this.finishing = false
    this.masterBlockPeak = 0
    this.resetLufs()
    this.masterBus.resetInserts() // clear master reverb tails etc. from a previous run
    this.masterBus.resetStrips() // clear every track's channel-strip DSP state (batched in MasterBus now)
    // Clear per-track insert state (delay lines, filter memory).
    for (const s of this.getSources()) s.inserts?.forEach((fx) => fx.reset())

    // Open the stream (accepting chunks into the ring but not playing yet),
    // fill the initial look-ahead, then let the device start pulling. This
    // keeps startup underrun-free.
    // blockFrames 0 → ASIO uses its own buffer size; WASAPI falls back to 512.
    const st0 = await window.daw.audioStart({
      sampleRate: state.sampleRate,
      blockFrames: 0,
      inputChannels: rec?.inputChannels ?? 0,
      inputSynthetic: rec?.synthetic ?? false
    })
    this.inputChannels = st0.inputChannels
    this.inputError = st0.inputError
    update({ playing: true })

    this.st = { at: performance.now(), playedFrames: 0, bufferedFrames: 0, sentFrames: 0, underrunFrames: 0 }
    await this.renderUpTo(TARGET_LOOKAHEAD_S * state.sampleRate)

    await window.daw.audioBegin()
    this.started = true
    this.st.at = performance.now() // clock starts now

    // 25 ms is plenty: the top-up band (MIN_TOPUP_S) is hundreds of ms wide.
    const tick = (): void => {
      void this.pump()
      this.timer = window.setTimeout(tick, 25)
    }
    tick()
  }

  /**
   * Stop the transport. If an insert is active, the source stops immediately but
   * the device keeps running while the tail rings out; a second Stop (or Play)
   * cuts the tail short.
   */
  async stop(): Promise<void> {
    if (this.rec) await this.endRecording()
    if (this.tailing) {
      await this.finish()
      return
    }
    if (!state.playing) return
    update({ playing: false })

    if (this.started && this.hasActiveInsert()) {
      // Jump the render head to end-of-track so the master mix produces silence
      // from here on — only the insert tail keeps sounding. (Up to ~1 look-ahead
      // of already-rendered source stays in the ring and plays out.)
      this.scheduledFrame = Math.max(this.scheduledFrame, this.totalFrames())
      this.tailing = true
      this.tailDeadline = performance.now() + TAIL_MAX_S * 1000
      this.quietBlocks = 0
    } else {
      await this.finish()
    }
  }

  /** Flush pending input, turn the captures into takes, hand them to the host. */
  private async endRecording(): Promise<void> {
    const rec = this.rec
    if (!rec) return
    await window.daw.recFlush() // main → renderer chunks are ordered ahead of this reply
    this.rec = null // transport length reverts to the real clip extent
    const takes = await rec.finish()
    if (takes.length) this.onTakes?.(takes, rec.startFrame)
  }

  /** Actually close the device and stop the pump loop. */
  private async finish(): Promise<void> {
    this.tailing = false
    this.finishing = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.started = false
    if (this.rec) await this.endRecording()
    await window.daw.audioStop()
  }

  private async renderUpTo(bufferedTargetFrames: number): Promise<void> {
    const total = this.totalFrames()
    const src = this.ready() // track set is stable within a fill burst
    while (this.scheduledFrame < total && this.bufferedNow() < bufferedTargetFrames) {
      const block = await this.masterBus.renderBlock(src, this.scheduledFrame, BLOCK_FRAMES, state.sampleRate)
      let pk = 0
      for (let j = 0; j < block.length; j++) {
        const a = block[j] < 0 ? -block[j] : block[j]
        if (a > pk) pk = a
      }
      this.masterBlockPeak = pk
      this.meterBlock(block)
      window.daw.audioChunk(block.buffer as ArrayBuffer)
      this.scheduledFrame += BLOCK_FRAMES
      this.sentFrames += BLOCK_FRAMES
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    if (!this.ready().length && !this.rec) return
    const sr = state.sampleRate
    const target = TARGET_LOOKAHEAD_S * sr
    const topupAt = target - MIN_TOPUP_S * sr

    // --- normal playback ---
    if (state.playing) {
      if (this.scheduledFrame >= this.totalFrames()) {
        update({ playhead: this.totalFrames() })
        void this.stop() // hands off to tail (or finishes)
        return
      }
      if (this.bufferedNow() <= topupAt) {
        this.busy = true
        try {
          await this.renderUpTo(target)
        } finally {
          this.busy = false
        }
      }
      return
    }

    // --- insert tail ringing out after Stop / end of track ---
    if (this.tailing) {
      const decayed = this.quietBlocks >= 3 || performance.now() > this.tailDeadline
      if (!decayed) {
        if (this.bufferedNow() <= topupAt) {
          this.busy = true
          try {
            while (this.quietBlocks < 3 && this.bufferedNow() < target) {
              // master mix past end-of-track = silence; the inserts decay it.
              const block = await this.masterBus.renderBlock(this.ready(), this.scheduledFrame, BLOCK_FRAMES, sr)
              this.meterBlock(block)
              window.daw.audioChunk(block.buffer as ArrayBuffer)
              this.scheduledFrame += BLOCK_FRAMES
              this.sentFrames += BLOCK_FRAMES

              let peak = 0
              for (let j = 0; j < block.length; j++) {
                const a = Math.abs(block[j])
                if (a > peak) peak = a
              }
              this.masterBlockPeak = peak
              this.quietBlocks = peak < TAIL_SILENCE_PEAK ? this.quietBlocks + 1 : 0
            }
          } finally {
            this.busy = false
          }
        }
        return
      }
      // Tail has decayed (blocks already sub-threshold) — close now. A short
      // delay lets the last near-silent look-ahead drain without a counted
      // underrun spike.
      if (!this.finishing) {
        this.finishing = true
        window.setTimeout(() => void this.finish(), 120)
      }
    }
  }
}
