// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { RtAudioDeviceInfo } from 'audify'
import { loadAudioModule } from './audio-module'
import { LiveRing } from './live-ring'

// The audio module is picked at start-up: the app's own (RtAudio + cwASIO) when built, else the audify package.
const { RtAudio, RtAudioApi, RtAudioFormat, RtAudioStreamFlags } = loadAudioModule()
type RtAudio = InstanceType<typeof RtAudio>

/**
 * Native stereo output. Backend order, best first:
 *   1. **ASIO** on a pro-audio-interface driver (exclusive, native rate, ~24-bit).
 *   2. **WASAPI exclusive** at the project rate (bypasses the shared-mode SRC).
 *   3. **WASAPI shared** as a last resort (the driver may resample → glitches).
 *
 * The renderer runs the GPGPU master and reads it back, then streams interleaved
 * f32 stereo blocks here over IPC. This class keeps a ring buffer and feeds
 * RtAudio one device block at a time from `frameOutputCallback`. Producer (IPC)
 * and consumer (frameOutputCallback) both run on the main JS thread, so no locks.
 *
 * Stream format handed to RtAudio is always FLOAT32 (our whole pipeline is
 * float32); RtAudio converts to the device's native format (SINT32/24 on ASIO).
 */

const CHANNELS = 2
/** Spacing of the synthetic impulse input used to check live-path time alignment. */
const IMPULSE_PERIOD = 4800
const ZEN_RE = /zen ?go|antelope|synergy core/i

/**
 * RtAudio chats through the error callback about things that aren't ours to fix:
 *  - "no open stream to close" — a harmless double-close on teardown.
 *  - ASIO "probeDeviceInfo" failures — RtAudio initialises every registered ASIO
 *    driver during getDevices(); an unplugged 3rd-party one (e.g. TONEX) fails
 *    here and it's nothing to do with our device.
 * Downgrade those to a quiet note so a real error still stands out.
 */
const BENIGN_RT = /no open stream to close|probeDeviceInfo|getDeviceInfo: error/i
function onRtMessage(msg: string): void {
  if (BENIGN_RT.test(msg)) console.log('[audio-out] (rtaudio, benign)', msg)
  else console.error('[audio-out] RtAudio:', msg)
}

export interface AudioOutConfig {
  sampleRate: number
  /** Device block size in frames. 0 lets the driver choose (needed for ASIO). */
  blockFrames: number
  /** RtAudio device id; omit for auto-select. */
  deviceId?: number
  /** Record: number of input channels to open alongside the output (0 = none). */
  inputChannels?: number
  /**
   * Record from a built-in test signal instead of hardware (regression / no interface).
   * `true` = stereo tones (220 / 330 Hz); `'impulse'` = a click every 4800 frames on both channels,
   * used to verify time alignment of the live path.
   */
  inputSynthetic?: boolean | 'impulse'
}

export interface AudioOutStatus {
  running: boolean
  sampleRate: number
  blockFrames: number
  /** Frames actually handed to the device since start. */
  playedFrames: number
  /** Frames buffered in the ring, waiting to play. */
  bufferedFrames: number
  underrunFrames: number
  streamLatencyFrames: number
  deviceName: string
  /** "ASIO", "WASAPI(excl)", "WASAPI" — which backend actually opened. */
  backend: string
  /** Input channels actually open (0 = output-only). */
  inputChannels: number
  /** Why a requested input could not be opened (output still runs). */
  inputError: string
  /** Input frames delivered to the renderer since begin(). */
  inputFrames: number
  /** Live (line-input) path: counters and timing. All zero while no live lane is active. */
  live: {
    enabled: boolean
    blocks: number
    late: number
    tooFar: number
    /** Input block arrival in main -> processed block back in main (ms): mean / max. */
    rttMeanMs: number
    rttMaxMs: number
    /** Frames between a block's input position and the output frame it was placed at. */
    deltaFrames: number
    /** Synthetic-impulse self-test: impulses seen at the output and the worst position error (frames). */
    alignImpulses: number
    alignMaxErrFrames: number
  }
}

interface OpenPlan {
  api: number
  backend: string
  bufferFrames: number
  flags: number
  /** Resolve a device id against a live RtAudio for this api; null = skip plan. */
  pick: (rt: RtAudio) => RtAudioDeviceInfo | null
}

export class NativeAudioOut {
  private rt: RtAudio | null = null
  private ring = new Float32Array(0) // interleaved stereo
  private ringFrames = 0
  private writeFrame = 0 // absolute; modulo ringFrames on access
  private readFrame = 0
  private silence = new Float32Array(0)

  private sampleRate = 96000
  private blockFrames = 512
  private deviceName = ''
  private backend = ''
  private playedFrames = 0
  private underrunFrames = 0
  private running = false
  /** Underrun accounting is suppressed until the first real chunk lands. */
  private gotFirstChunk = false

  // --- input (record) ---
  /** Set by index.ts: receives interleaved f32 input blocks once the device is pulling. */
  onInput: ((interleaved: Float32Array, startFrame: number, channels: number) => void) | null = null
  private inputChannels = 0
  private inputError = ''
  private inputFrames = 0
  private inputSynthetic = false
  private synthKind: 'tone' | 'impulse' = 'tone'
  private inputLive = false // false until begin(); input before that is discarded

  // --- live (line-input) path ---
  /** Set by index.ts: receives batched input for the renderer's live bus (low latency, ~256 frames). */
  onLiveInput: ((interleaved: Float32Array, startFrame: number, channels: number) => void) | null = null
  private liveEnabled = false
  private liveRing = new LiveRing(1)
  /** Frames the output callback has played since begin() — the clock live blocks are placed on. */
  private outFrames = 0
  private outFrameAt = 0
  /** An external source (VST host bridge) feeds the live path; the device input stays out of it. */
  private extLive = false
  private extAlignProbe = false
  private livePendingIn: Float32Array[] = []
  private livePendingFrames = 0
  private livePendingStart = 0
  private liveStamps = new Map<number, number>() // input batch start frame -> performance.now()
  private liveBlocks = 0
  private liveRttSum = 0
  private liveRttMax = 0
  private liveDelta = 0
  private alignImpulses = 0
  private alignMaxErr = 0

  // Reused every device callback so a 192 kHz callback rate doesn't churn GC.
  private outScratch = new Float32Array(0)
  private outBuf: Buffer = Buffer.alloc(0)
  private silenceBuf: Buffer = Buffer.alloc(0)

  listDevices(): { devices: RtAudioDeviceInfo[]; defaultOutput: number } {
    const rt = this.rt ?? new RtAudio(RtAudioApi.WINDOWS_WASAPI)
    return { devices: rt.getDevices(), defaultOutput: rt.getDefaultOutputDevice() }
  }

  /** WASAPI recording (input) devices, independent of which backend the output stream opened on. */
  listInputDevices(): { devices: RtAudioDeviceInfo[]; defaultInput: number } {
    const rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI)
    try {
      const devices = rt.getDevices().filter((d) => d.inputChannels > 0)
      return { devices, defaultInput: rt.getDefaultInputDevice() }
    } finally {
      ;(rt as { dispose?: () => void }).dispose?.()
    }
  }

  /** Open a secondary WASAPI shared-mode recording stream (e.g. a virtual audio cable return). */
  openWasapiInput(
    deviceId: number | undefined,
    deviceName: string | undefined,
    sampleRate: number,
    blockFrames: number,
    onData: (interleaved: Float32Array, channels: number) => void,
    onError: (msg: string) => void
  ): { close(): void; deviceId: number; deviceName: string; sampleRate: number; channels: number } {
    const rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI)
    const devs = rt.getDevices().filter((d) => d.inputChannels > 0)
    let dev: RtAudioDeviceInfo | undefined
    if (deviceId != null && deviceId > 0) dev = devs.find((d) => d.id === deviceId)
    if (!dev && deviceName) {
      const q = deviceName.toLowerCase()
      dev = devs.find((d) => d.name.toLowerCase().includes(q))
    }
    if (!dev) {
      const def = rt.getDefaultInputDevice()
      dev = devs.find((d) => d.id === def) ?? devs[0]
    }
    if (!dev) {
      ;(rt as { dispose?: () => void }).dispose?.()
      throw new Error('no WASAPI recording device found')
    }
    const channels = Math.min(2, dev.inputChannels)
    // Open at the device's native mix rate (`preferredSampleRate`) so RtAudio's internal WASAPI capture
    // loop runs 1:1 without dropping sub-blocks; DriftRing resamples smoothly to the project rate.
    const openRate = dev.preferredSampleRate || sampleRate
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      try {
        if (rt.isStreamRunning()) rt.stop()
        if (rt.isStreamOpen()) rt.closeStream()
      } catch {
        /* ignore */
      } finally {
        ;(rt as { dispose?: () => void }).dispose?.()
      }
    }
    try {
      rt.openStream(
        null,
        { deviceId: dev.id, nChannels: channels, firstChannel: 0 },
        RtAudioFormat.RTAUDIO_FLOAT32,
        openRate,
        blockFrames || 512,
        'awaker-return',
        (buf: Buffer) => {
          const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
          onData(f, channels)
        },
        null,
        0,
        (_type, msg) => {
          if (BENIGN_RT.test(msg)) return
          onError(msg)
        }
      )
      rt.start()
      const actualRate = rt.getStreamSampleRate?.() || openRate
      return { close, deviceId: dev.id, deviceName: dev.name, sampleRate: actualRate, channels }
    } catch (err) {
      close()
      throw err
    }
  }

  /** Ordered open attempts. Env overrides: DAW_AUDIO_API, DAW_AUDIO_DEVICE. */
  private plans(cfg: AudioOutConfig): OpenPlan[] {
    const want = cfg.sampleRate
    const forceApi = (process.env['DAW_AUDIO_API'] || '').toLowerCase()
    const nameHint = process.env['DAW_AUDIO_DEVICE'] || ''

    const supports = (d: RtAudioDeviceInfo): boolean =>
      d.outputChannels >= CHANNELS && (d.sampleRates.length === 0 || d.sampleRates.includes(want))

    const asio: OpenPlan = {
      api: RtAudioApi.WINDOWS_ASIO,
      backend: 'ASIO',
      bufferFrames: cfg.blockFrames || 0, // 0 → driver's own buffer size
      flags: RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME,
      pick: (rt) => {
        const devs = rt.getDevices().filter(supports)
        const byName = nameHint ? devs.filter((d) => d.name.includes(nameHint)) : devs
        const zen = byName
          .filter((d) => ZEN_RE.test(d.name))
          .sort((a, b) => b.outputChannels - a.outputChannels)
        // Only take ASIO automatically for a recognised interface — a generic
        // "ASIO4ALL"-style driver as the system default would hijack output.
        return zen[0] ?? (nameHint && byName[0]) ?? null
      }
    }

    const wasapiExcl: OpenPlan = {
      api: RtAudioApi.WINDOWS_WASAPI,
      backend: 'WASAPI(excl)',
      bufferFrames: cfg.blockFrames || 512,
      flags: RtAudioStreamFlags.RTAUDIO_HOG_DEVICE | RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME,
      pick: (rt) => this.pickWasapi(rt, cfg.deviceId, nameHint)
    }

    const wasapiShared: OpenPlan = {
      api: RtAudioApi.WINDOWS_WASAPI,
      backend: 'WASAPI',
      bufferFrames: cfg.blockFrames || 512,
      flags: RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME,
      pick: (rt) => this.pickWasapi(rt, cfg.deviceId, nameHint)
    }

    if (forceApi === 'asio') return [asio]
    if (forceApi === 'wasapi' || forceApi === 'wasapi-excl') return [wasapiExcl]
    if (forceApi === 'wasapi-shared') return [wasapiShared]
    return [asio, wasapiExcl, wasapiShared]
  }

  private pickWasapi(rt: RtAudio, deviceId: number | undefined, nameHint: string): RtAudioDeviceInfo | null {
    const devs = rt.getDevices().filter((d) => d.outputChannels >= CHANNELS)
    if (deviceId != null) return devs.find((d) => d.id === deviceId) ?? null
    if (nameHint) {
      const m = devs.find((d) => d.name.includes(nameHint))
      if (m) return m
    }
    const def = rt.getDefaultOutputDevice()
    return devs.find((d) => d.id === def) ?? devs[0] ?? null
  }

  /**
   * Input stream params for `dev`: same device when it has inputs (mandatory for
   * ASIO — one driver, one client), else the system default input.
   */
  private pickInput(
    rt: RtAudio,
    dev: RtAudioDeviceInfo,
    want: number
  ): { deviceId: number; nChannels: number } | null {
    if (want <= 0) return null
    let d: RtAudioDeviceInfo | undefined = dev.inputChannels > 0 ? dev : undefined
    if (!d) {
      const def = rt.getDefaultInputDevice()
      d = rt.getDevices().find((x) => x.id === def && x.inputChannels > 0)
    }
    if (!d) return null
    return { deviceId: d.id, nChannels: Math.min(want, d.inputChannels) }
  }

  start(cfg: AudioOutConfig): AudioOutStatus {
    this.stop()
    this.sampleRate = cfg.sampleRate
    this.inputChannels = 0
    this.inputError = ''
    this.inputFrames = 0
    this.inputLive = false
    this.inputSynthetic = !!cfg.inputSynthetic
    this.synthKind = cfg.inputSynthetic === 'impulse' ? 'impulse' : 'tone'
    const wantIn = cfg.inputSynthetic ? 0 : Math.max(0, cfg.inputChannels ?? 0)

    const errors: string[] = []
    for (const plan of this.plans(cfg)) {
      let rt: RtAudio | null = null
      try {
        rt = new RtAudio(plan.api)
        // RtAudio falls back to another compiled API when the asked one is not in the build (the WASAPI-only
        // module): that is not ASIO, so the ASIO plan is skipped instead of running under the wrong name
        if (plan.api === RtAudioApi.WINDOWS_ASIO && !/asio/i.test(rt.getApi())) {
          errors.push('ASIO: not in this build (the ASIO add-on is not installed)')
          continue
        }
        const dev = plan.pick(rt)
        if (!dev) {
          errors.push(`${plan.backend}: no matching device`)
          continue
        }
        const inParams = this.pickInput(rt, dev, wantIn)
        const open = (inp: { deviceId: number; nChannels: number } | null): number =>
          rt!.openStream(
            { deviceId: dev.id, nChannels: CHANNELS, firstChannel: 0 },
            inp ? { deviceId: inp.deviceId, nChannels: inp.nChannels, firstChannel: 0 } : null,
            RtAudioFormat.RTAUDIO_FLOAT32,
            this.sampleRate,
            plan.bufferFrames,
            'gpudaw-out',
            inp ? (buf: Buffer) => this.onInputBlock(buf, inp.nChannels) : null,
            () => this.onFrame(),
            plan.flags,
            (_type, msg) => onRtMessage(msg)
          )
        let actual: number
        if (inParams) {
          try {
            actual = open(inParams)
            this.inputChannels = inParams.nChannels
          } catch (err) {
            // Duplex refused (no usable inputs / mixed devices) — keep playing output-only.
            this.inputError = `input open failed: ${(err as Error).message}`
            console.error('[audio-out]', this.inputError)
            try {
              rt.closeStream()
            } catch {
              /* ignore */
            }
            rt = new RtAudio(plan.api)
            actual = open(null)
          }
        } else {
          if (wantIn > 0) this.inputError = `${plan.backend}: device has no input channels`
          actual = open(null)
        }
        this.rt = rt
        this.backend = plan.backend
        this.deviceName = dev.name
        this.blockFrames = actual || plan.bufferFrames || 512
        const rate = rt.getStreamSampleRate?.() || this.sampleRate
        const lat = rt.getStreamLatency?.() ?? 0
        console.log(
          `[audio-out] ${plan.backend} · "${dev.name}" · ${rate} Hz · block ${this.blockFrames} · latency ${lat} fr`
        )
        if (rate !== this.sampleRate) {
          console.warn(`[audio-out] device rate ${rate} != project ${this.sampleRate} — check the interface`)
        }
        break
      } catch (err) {
        errors.push(`${plan.backend}: ${(err as Error).message}`)
        try {
          rt?.closeStream()
        } catch {
          /* ignore */
        }
      }
    }

    if (!this.rt) throw new Error(`no audio backend opened — ${errors.join(' ; ')}`)
    if (errors.length) console.log(`[audio-out] skipped: ${errors.join(' ; ')}`)

    // ~1 s ring, rounded to whole blocks.
    const unit = Math.max(this.blockFrames, 64)
    this.ringFrames = Math.ceil(this.sampleRate / unit) * unit * 2
    this.ring = new Float32Array(this.ringFrames * CHANNELS)
    this.silence = new Float32Array(this.blockFrames * CHANNELS)
    this.silenceBuf = Buffer.from(this.silence.buffer)
    this.outScratch = new Float32Array(this.blockFrames * CHANNELS)
    this.outBuf = Buffer.from(this.outScratch.buffer)
    this.writeFrame = 0
    this.readFrame = 0
    this.playedFrames = 0
    this.underrunFrames = 0
    this.gotFirstChunk = false

    if (cfg.inputSynthetic) this.inputChannels = 2 // synthetic test signal is stereo
    // Stream is open and accepting chunks into the ring, but the device is not
    // pulling yet — the renderer fills the initial look-ahead, then calls
    // begin(). This makes startup underrun-free.
    this.running = true
    return this.status()
  }

  /** Start the device pulling from the (now pre-filled) ring. */
  begin(): void {
    if (!this.rt || this.rt.isStreamRunning()) return
    this.inputFrames = 0
    this.inputLive = true
    this.resetLive()
    // A little silence in RtAudio's own queue so its first callbacks never stall.
    for (let i = 0; i < 3; i++) this.rt.write(this.silenceBuf)
    this.rt.start()
  }

  stop(): void {
    if (this.rt) {
      try {
        if (this.rt.isStreamRunning()) this.rt.stop()
        if (this.rt.isStreamOpen()) this.rt.closeStream()
      } catch (err) {
        console.error('[audio-out] stop error:', err)
      }
      this.rt = null
    }
    this.running = false
    this.backend = ''
  }

  /** Append an interleaved f32 stereo block from the renderer into the ring. */
  pushChunk(interleaved: Float32Array): void {
    if (!this.running || this.ringFrames === 0) return
    this.gotFirstChunk = true
    const frames = interleaved.length >> 1
    const free = this.ringFrames - (this.writeFrame - this.readFrame)
    const n = Math.min(frames, free)
    if (n <= 0) return
    // Bulk copy, split once at the ring wrap (beats a per-sample loop).
    const start = this.writeFrame % this.ringFrames
    const firstFrames = Math.min(n, this.ringFrames - start)
    this.ring.set(interleaved.subarray(0, firstFrames * CHANNELS), start * CHANNELS)
    if (firstFrames < n) {
      this.ring.set(interleaved.subarray(firstFrames * CHANNELS, n * CHANNELS), 0)
    }
    this.writeFrame += n
    // If n < frames the renderer got ahead of the ring; it paces on status so
    // this should be rare. Dropped rather than blocking the main thread.
  }

  status(): AudioOutStatus {
    return {
      running: this.running,
      sampleRate: this.sampleRate,
      blockFrames: this.blockFrames,
      playedFrames: this.playedFrames,
      bufferedFrames: Math.max(0, this.writeFrame - this.readFrame),
      underrunFrames: this.underrunFrames,
      streamLatencyFrames: this.rt?.getStreamLatency?.() ?? 0,
      deviceName: this.deviceName,
      backend: this.backend,
      inputChannels: this.inputChannels,
      inputError: this.inputError,
      inputFrames: this.inputFrames,
      live: {
        enabled: this.liveEnabled,
        blocks: this.liveBlocks,
        late: this.liveRing.late,
        tooFar: this.liveRing.tooFar,
        rttMeanMs: this.liveBlocks ? this.liveRttSum / this.liveBlocks : 0,
        rttMaxMs: this.liveRttMax,
        deltaFrames: this.liveDelta,
        alignImpulses: this.alignImpulses,
        alignMaxErrFrames: this.alignMaxErr
      }
    }
  }

  // ---- live (line-input) path ----------------------------------------------------

  setExternalLive(on: boolean): void {
    this.extLive = on
    this.livePendingIn = []
    this.livePendingFrames = 0
    this.alignImpulses = 0
    this.alignMaxErr = 0
  }
  setAlignProbe(on: boolean): void {
    this.extAlignProbe = on
  }
  /** Output frames played since begin(): the clock an external live source is paced against. */
  get outClock(): number {
    return this.outFrames
  }
  /** Sub-block interpolated output clock bounded to the current hardware block. */
  get smoothOutClock(): number {
    if (!this.running || this.outFrameAt <= 0) return this.outFrames
    const dt = Math.max(0, (performance.now() - this.outFrameAt) / 1000)
    const interp = Math.min(this.blockFrames, Math.floor(dt * this.sampleRate))
    return this.outFrames + interp
  }
  get isRunning(): boolean {
    return this.running
  }
  get rate(): number {
    return this.sampleRate
  }
  /** One block of an external live source (interleaved f32 stereo) captured at `start` on the output clock. */
  injectLive(f: Float32Array, start: number): void {
    this.liveIn(f, start, 2)
  }

  /** The renderer turns this on while it has live lanes; off = no per-callback cost. */
  setLiveEnabled(on: boolean): void {
    this.liveEnabled = on
    if (!on) this.resetLive()
  }

  private resetLive(): void {
    // 1 s of landing space: enough for any latency we would ever ask for, small enough to stay cache-warm
    this.liveRing = new LiveRing(Math.max(1024, this.sampleRate))
    this.outFrames = 0
    this.outFrameAt = performance.now()
    this.livePendingIn = []
    this.livePendingFrames = 0
    this.liveStamps.clear()
    this.liveBlocks = 0
    this.liveRttSum = 0
    this.liveRttMax = 0
    this.liveDelta = 0
    this.alignImpulses = 0
    this.alignMaxErr = 0
  }

  /**
   * A processed live block from the renderer. `outStart` is the output frame it belongs at,
   * `inStart` the input frame its first sample was captured at (for the round-trip stat).
   */
  pushLive(interleaved: Float32Array, outStart: number, inStart: number): void {
    if (!this.running || !this.liveEnabled) return
    this.liveRing.write(outStart, interleaved, this.outFrames)
    this.liveBlocks++
    this.liveDelta = outStart - inStart
    const t0 = this.liveStamps.get(inStart)
    if (t0 !== undefined) {
      const rtt = performance.now() - t0
      this.liveRttSum += rtt
      if (rtt > this.liveRttMax) this.liveRttMax = rtt
      this.liveStamps.delete(inStart)
    }
  }

  /** Batch device-sized input blocks to ~256 frames, then hand them to the renderer's live bus. */
  private liveIn(f: Float32Array, start: number, nCh: number): void {
    if (!this.liveEnabled || !this.onLiveInput) return
    if (this.livePendingFrames > 0 && start !== this.livePendingStart + this.livePendingFrames) {
      this.livePendingIn = []
      this.livePendingFrames = 0
    }
    if (this.livePendingFrames === 0) this.livePendingStart = start
    this.livePendingIn.push(f)
    this.livePendingFrames += f.length / nCh
    if (this.livePendingFrames < 256) return
    const out = new Float32Array(this.livePendingFrames * nCh)
    let o = 0
    for (const a of this.livePendingIn) {
      out.set(a, o)
      o += a.length
    }
    const s = this.livePendingStart
    this.livePendingIn = []
    this.livePendingFrames = 0
    this.liveStamps.set(s, performance.now())
    if (this.liveStamps.size > 256) this.liveStamps.delete(this.liveStamps.keys().next().value as number)
    this.onLiveInput(out, s, nCh)
  }

  /** Hardware input block (interleaved f32, `nCh` channels) → renderer. */
  private onInputBlock(buf: Buffer, nCh: number): void {
    if (!this.inputLive || !this.onInput) return
    const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    const start = this.inputFrames
    this.inputFrames += f.length / nCh
    if (!this.extLive) this.liveIn(f, start, nCh)
    this.onInput(f, start, nCh)
  }

  /** Deterministic stereo test input (L 220 Hz, R 330 Hz, amp 0.5) for regression runs. */
  private synthInput(frames: number): void {
    if (!this.inputLive || !this.onInput) return
    const f = new Float32Array(frames * 2)
    const start = this.inputFrames
    const w = (2 * Math.PI) / this.sampleRate
    for (let i = 0; i < frames; i++) {
      const t = start + i
      if (this.synthKind === 'impulse') {
        const hit = t % IMPULSE_PERIOD === 0 ? 0.5 : 0
        f[i * 2] = hit
        f[i * 2 + 1] = hit
      } else {
        f[i * 2] = 0.5 * Math.sin(w * 220 * t)
        f[i * 2 + 1] = 0.5 * Math.sin(w * 330 * t)
      }
    }
    this.inputFrames += frames
    if (!this.extLive) this.liveIn(f, start, 2)
    this.onInput(f, start, 2)
  }

  private onFrame(): void {
    if (!this.rt || !this.running) return
    const need = this.blockFrames
    const avail = this.writeFrame - this.readFrame
    if (this.inputSynthetic) this.synthInput(need)

    if (avail >= need) {
      // Bulk copy ring → scratch, split once at the wrap.
      const start = this.readFrame % this.ringFrames
      const firstFrames = Math.min(need, this.ringFrames - start)
      this.outScratch.set(
        this.ring.subarray(start * CHANNELS, (start + firstFrames) * CHANNELS),
        0
      )
      if (firstFrames < need) {
        this.outScratch.set(this.ring.subarray(0, (need - firstFrames) * CHANNELS), firstFrames * CHANNELS)
      }
      this.readFrame += need
      this.addLive(need)
      this.rt.write(this.outBuf)
    } else {
      // Emit silence, keep the clock moving. Only counts as an underrun once
      // real audio has started flowing (not during startup priming). Discard the
      // sub-block remainder so `bufferedFrames` reports honestly (≈0) during an
      // underrun instead of freezing at a stale positive value.
      if (this.gotFirstChunk) this.underrunFrames += need
      this.readFrame = this.writeFrame
      if (this.liveEnabled) {
        // nothing queued from the transport — the live path may still have something to say
        this.outScratch.fill(0)
        this.addLive(need)
        this.rt.write(this.outBuf)
      } else {
        this.rt.write(this.silenceBuf)
      }
    }
    this.playedFrames += need
    this.outFrames += need
    this.outFrameAt = performance.now()
  }

  /** Add the live blocks that fall in this output block (frames outFrames .. outFrames+need) onto outScratch. */
  private addLive(need: number): void {
    if (!this.liveEnabled) return
    // the synthetic-impulse self-test reads the live contribution on its own
    const probe = (this.synthKind === 'impulse' && this.inputSynthetic) || this.extAlignProbe ? new Float32Array(need * 2) : null
    const any = probe
      ? this.liveRing.take(this.outFrames, need, probe)
      : this.liveRing.take(this.outFrames, need, this.outScratch)
    if (probe && any) {
      for (let i = 0; i < need; i++) {
        // the test input is silent except the impulses and the path is bit-exact, so any non-zero sample is one
        if (Math.abs(probe[i * 2]) > 1e-9) {
          // output frame o carries input frame o - delta; impulses sit on multiples of IMPULSE_PERIOD
          const inFrame = this.outFrames + i - this.liveDelta
          const err = ((inFrame + IMPULSE_PERIOD / 2) % IMPULSE_PERIOD) - IMPULSE_PERIOD / 2
          this.alignImpulses++
          this.alignMaxErr = Math.max(this.alignMaxErr, Math.abs(err))
        }
      }
      for (let i = 0; i < need * 2; i++) this.outScratch[i] += probe[i]
    }
  }
}
