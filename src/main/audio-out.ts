// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import {
  RtAudio,
  RtAudioApi,
  RtAudioFormat,
  RtAudioStreamFlags,
  type RtAudioDeviceInfo
} from 'audify'

/**
 * Native stereo output. Backend order, best first:
 *   1. **ASIO** on an Antelope / Zen Go driver (exclusive, native rate, ~24-bit).
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
  /** Record from a built-in test signal instead of hardware (regression / no interface). */
  inputSynthetic?: boolean
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
  private inputLive = false // false until begin(); input before that is discarded

  // Reused every device callback so a 192 kHz callback rate doesn't churn GC.
  private outScratch = new Float32Array(0)
  private outBuf: Buffer = Buffer.alloc(0)
  private silenceBuf: Buffer = Buffer.alloc(0)

  listDevices(): { devices: RtAudioDeviceInfo[]; defaultOutput: number } {
    const rt = this.rt ?? new RtAudio(RtAudioApi.WINDOWS_WASAPI)
    return { devices: rt.getDevices(), defaultOutput: rt.getDefaultOutputDevice() }
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
    const wantIn = cfg.inputSynthetic ? 0 : Math.max(0, cfg.inputChannels ?? 0)

    const errors: string[] = []
    for (const plan of this.plans(cfg)) {
      let rt: RtAudio | null = null
      try {
        rt = new RtAudio(plan.api)
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
      inputFrames: this.inputFrames
    }
  }

  /** Hardware input block (interleaved f32, `nCh` channels) → renderer. */
  private onInputBlock(buf: Buffer, nCh: number): void {
    if (!this.inputLive || !this.onInput) return
    const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    const start = this.inputFrames
    this.inputFrames += f.length / nCh
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
      f[i * 2] = 0.5 * Math.sin(w * 220 * t)
      f[i * 2 + 1] = 0.5 * Math.sin(w * 330 * t)
    }
    this.inputFrames += frames
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
      this.rt.write(this.outBuf)
    } else {
      // Emit silence, keep the clock moving. Only counts as an underrun once
      // real audio has started flowing (not during startup priming). Discard the
      // sub-block remainder so `bufferedFrames` reports honestly (≈0) during an
      // underrun instead of freezing at a stale positive value.
      if (this.gotFirstChunk) this.underrunFrames += need
      this.readFrame = this.writeFrame
      this.rt.write(this.silenceBuf)
    }
    this.playedFrames += need
  }
}
