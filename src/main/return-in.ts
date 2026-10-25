// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Secondary return audio input (WASAPI shared mode, or a synthetic test generator).
 *
 * Reads a recording endpoint (such as the recording side of a virtual audio cable fed by a
 * standalone instrument) on its own clock, absorbs clock drift in a ring buffer by nudging a
 * fractional resampler within ±500 ppm, and hands 512-frame stereo blocks to the live path
 * (`injectLive`) tagged on the primary output clock (`outClock`).
 */

export const RETURN_BLOCK = 512
const LEAD_BLOCKS = 2
const MAX_PPM = 500
const IMPULSE_PERIOD = 4800

export interface WasapiInputHandle {
  close(): void
  deviceId: number
  deviceName: string
  sampleRate: number
  channels: number
}

export interface ReturnInDeps {
  clock(): number
  running(): boolean
  rate(): number
  inject(block: Float32Array, start: number): void
  setExternal(on: boolean): void
  setAlignProbe?(on: boolean): void
  openWasapiInput?(
    deviceId: number | undefined,
    deviceName: string | undefined,
    sampleRate: number,
    blockFrames: number,
    onData: (interleaved: Float32Array, channels: number) => void,
    onError: (msg: string) => void
  ): WasapiInputHandle
}

export interface ReturnInStartConfig {
  deviceId?: number
  deviceName?: string
  delayMs?: number
  synthetic?: boolean | 'sine' | 'impulse'
  driftPpm?: number
}

export interface ReturnInStatus {
  running: boolean
  mode: 'off' | 'wasapi' | 'synthetic'
  deviceId: number
  deviceName: string
  sampleRate: number
  outputSampleRate: number
  channels: number
  delayMs: number
  offsetFrames: number
  receivedFrames: number
  injectedFrames: number
  injectedBlocks: number
  ringBufferedFrames: number
  ringTargetFrames: number
  ringCapacityFrames: number
  fillRatio: number
  smoothFillFrames: number
  resampleRatio: number
  ppm: number
  underruns: number
  overruns: number
  resyncs: number
  clockDeltaFrames: number
  peakL: number
  peakR: number
  error: string
}

export class DriftRing {
  readonly cap: number
  readonly target: number
  private readonly buf: Float32Array
  private writePos = 0
  private readPos = 0
  private phase = 0
  private lastL = 0
  private lastR = 0
  smoothFill = 0
  integPpm = 0
  ppm = 0
  lastRatio = 1
  underruns = 0
  overruns = 0

  constructor(capFrames = 16384, targetFrames = 4096) {
    this.cap = Math.max(1024, capFrames | 0)
    this.target = Math.max(256, Math.min(this.cap >> 1, targetFrames | 0))
    this.buf = new Float32Array(this.cap * 2)
    this.reset()
  }

  get available(): number {
    return Math.max(0, this.writePos - this.readPos - this.phase)
  }

  get fillRatio(): number {
    return this.target > 0 ? this.available / this.target : 0
  }

  reset(extraLead = 0): void {
    this.buf.fill(0)
    this.writePos = this.target + Math.max(0, extraLead | 0)
    this.readPos = 0
    this.phase = 0
    this.lastL = 0
    this.lastR = 0
    this.smoothFill = this.target
    this.integPpm = 0
    this.ppm = 0
    this.lastRatio = 1
    this.underruns = 0
    this.overruns = 0
  }

  push(interleaved: Float32Array, channels: number, pulling = true): void {
    const ch = Math.max(1, channels | 0)
    const frames = Math.floor(interleaved.length / ch)
    if (frames <= 0) return

    if (pulling) {
      const used = this.writePos - this.readPos
      const free = this.cap - 2 - used
      if (frames > free) {
        const drop = frames - Math.max(0, free)
        this.readPos += drop
        this.overruns += drop
      }
    }

    for (let i = 0; i < frames; i++) {
      const p = ((this.writePos + i) % this.cap) * 2
      const l = interleaved[i * ch]
      const r = ch > 1 ? interleaved[i * ch + 1] : l
      this.buf[p] = l
      this.buf[p + 1] = r
    }
    this.writePos += frames

    if (!pulling) {
      if (this.writePos - this.readPos > this.target) {
        this.readPos = this.writePos - this.target
        this.phase = 0
      }
      this.smoothFill = this.available
    }
  }

  pull(outFrames: number, outSampleRate: number, dst: Float32Array, nominalRatio = 1): number {
    const avail = this.available
    this.smoothFill += 0.05 * (avail - this.smoothFill)
    const scale = Math.max(256, this.target * 0.25)
    const err = (this.smoothFill - this.target) / scale
    const dt = outFrames / Math.max(1, outSampleRate)
    this.integPpm = Math.max(-MAX_PPM, Math.min(MAX_PPM, this.integPpm + err * 15 * dt))
    this.ppm = Math.max(-MAX_PPM, Math.min(MAX_PPM, err * 350 + this.integPpm))
    const ratio = nominalRatio * (1 + this.ppm * 1e-6)
    this.lastRatio = ratio

    const needIn = outFrames * ratio + 1
    if (this.available < needIn) {
      this.underruns++
      const pad = Math.max(Math.ceil(needIn - this.available) + 16, this.target - Math.floor(this.available))
      for (let i = 0; i < pad; i++) {
        const p = ((this.writePos + i) % this.cap) * 2
        this.buf[p] = this.lastL
        this.buf[p + 1] = this.lastR
      }
      this.writePos += pad
    }

    for (let i = 0; i < outFrames; i++) {
      const p0 = (this.readPos % this.cap) * 2
      const p1 = ((this.readPos + 1) % this.cap) * 2
      const f = this.phase
      const l = this.buf[p0] + f * (this.buf[p1] - this.buf[p0])
      const r = this.buf[p0 + 1] + f * (this.buf[p1 + 1] - this.buf[p0 + 1])
      dst[i * 2] = l
      dst[i * 2 + 1] = r
      this.lastL = l
      this.lastR = r
      this.phase += ratio
      const adv = Math.floor(this.phase)
      this.readPos += adv
      this.phase -= adv
    }
    return ratio
  }
}


export class ReturnIn {
  private handle: WasapiInputHandle | null = null
  private mode: 'off' | 'wasapi' | 'synthetic' = 'off'
  private synthKind: 'sine' | 'impulse' = 'sine'
  private driftPpm = 0
  private deviceId = 0
  private deviceName = ''
  private inRate = 96000
  private channels = 2
  private delayMs = 0
  private error = ''

  private ring = new DriftRing(16384, 4096)
  private receivedFrames = 0
  private lastLogFrames = 0
  private injectedFrames = 0
  private injectedBlocks = 0
  private produced = 0
  private anchorFrame = 0
  private maxAlignErrFrames = 0
  private anchored = false
  private resyncs = 0
  private peakL = 0
  private peakR = 0

  private pumpTimer: NodeJS.Timeout | null = null
  private synthTimer: NodeJS.Timeout | null = null
  private logTimer: NodeJS.Timeout | null = null
  private synthStartMs = 0
  private synthGenerated = 0
  private synthFrameBase = 0

  constructor(private readonly deps: ReturnInDeps) {}

  start(cfg: ReturnInStartConfig = {}): ReturnInStatus {
    this.stop()
    if (cfg.delayMs !== undefined && Number.isFinite(cfg.delayMs)) {
      this.delayMs = Math.max(-100, Math.min(500, Number(cfg.delayMs)))
    }
    this.error = ''
    this.receivedFrames = 0
    this.lastLogFrames = 0
    this.injectedFrames = 0
    this.injectedBlocks = 0
    this.produced = 0
    this.anchorFrame = 0
    this.maxAlignErrFrames = 0
    this.anchored = false
    this.resyncs = 0
    this.peakL = 0
    this.peakR = 0

    const outRate = this.deps.rate() || 96000
    if (cfg.synthetic) {
      this.mode = 'synthetic'
      this.synthKind = cfg.synthetic === 'impulse' ? 'impulse' : 'sine'
      this.driftPpm = Number.isFinite(cfg.driftPpm) ? Math.max(-450, Math.min(450, Number(cfg.driftPpm))) : 0
      this.inRate = outRate
      this.channels = 2
      this.deviceId = -1
      this.deviceName =
        this.synthKind === 'impulse'
          ? 'Synthetic return (impulse)'
          : `Synthetic return (sine${this.driftPpm ? ` ${this.driftPpm > 0 ? '+' : ''}${this.driftPpm} ppm` : ''})`
      const cap = Math.max(8192, Math.round(this.inRate * 0.25))
      const target = Math.max(1024, Math.round(this.inRate * 0.045))
      this.ring = new DriftRing(cap, target)
      this.deps.setExternal(true)
      this.deps.setAlignProbe?.(this.synthKind === 'impulse')
      this.synthStartMs = performance.now()
      this.synthGenerated = 0
      this.synthFrameBase = 0
      this.synthTimer = setInterval(() => this.tickSynthetic(), 4)
    } else {
      if (!this.deps.openWasapiInput) {
        this.error = 'WASAPI input opener is not configured'
        return this.status()
      }
      try {
        const h = this.deps.openWasapiInput(
          cfg.deviceId,
          cfg.deviceName,
          outRate,
          RETURN_BLOCK,
          (f, ch) => this.feedInput(f, ch),
          (msg) => {
            this.error = msg
            console.error('[return-in] error:', msg)
          }
        )
        this.handle = h
        this.mode = 'wasapi'
        this.deviceId = h.deviceId
        this.deviceName = h.deviceName
        this.inRate = h.sampleRate || outRate
        this.channels = h.channels
        const cap = Math.max(8192, Math.round(this.inRate * 0.25))
        const target = Math.max(1024, Math.round(this.inRate * 0.045))
        this.ring = new DriftRing(cap, target)
        this.deps.setExternal(true)
        this.deps.setAlignProbe?.(false)
        console.log(`[return-in] opened WASAPI "${this.deviceName}" (id ${this.deviceId}) @ ${this.inRate} Hz, ${this.channels} ch`)
      } catch (err) {
        this.error = (err as Error).message || String(err)
        console.error('[return-in] open failed:', this.error)
        return this.status()
      }
    }

    this.pumpTimer = setInterval(() => this.pump(), 2)
    this.logTimer = setInterval(() => {
      const rx = this.receivedFrames
      const delta = rx - this.lastLogFrames
      this.lastLogFrames = rx
      console.log(
        `[return-in] frames=${rx} (+${delta}/s) injected=${this.injectedFrames} ring=${Math.round(this.ring.available)}/${this.ring.target} (${Math.round(this.ring.fillRatio * 100)}%) ratio=${this.ring.lastRatio.toFixed(6)} (${this.ring.ppm >= 0 ? '+' : ''}${this.ring.ppm.toFixed(1)} ppm)`
      )
    }, 1000)

    return this.status()
  }

  stop(): ReturnInStatus {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer)
      this.pumpTimer = null
    }
    if (this.synthTimer) {
      clearInterval(this.synthTimer)
      this.synthTimer = null
    }
    if (this.logTimer) {
      clearInterval(this.logTimer)
      this.logTimer = null
    }
    if (this.handle) {
      try {
        this.handle.close()
      } catch {
        /* ignore */
      }
      this.handle = null
    }
    if (this.mode !== 'off') {
      this.deps.setExternal(false)
      this.deps.setAlignProbe?.(false)
    }
    this.mode = 'off'
    this.anchored = false
    return this.status()
  }

  setDelayMs(ms: number): ReturnInStatus {
    if (Number.isFinite(ms)) {
      const prevOffset = this.offsetFrames()
      this.delayMs = Math.max(-100, Math.min(500, Number(ms)))
      const nextOffset = this.offsetFrames()
      if (this.anchored) {
        this.produced += nextOffset - prevOffset
        this.anchorFrame += nextOffset - prevOffset
      }
    }
    return this.status()
  }

  offsetFrames(): number {
    return Math.round((this.delayMs * (this.deps.rate() || 96000)) / 1000)
  }

  feedInput(interleaved: Float32Array, channels = 2): void {
    const ch = Math.max(1, channels | 0)
    const frames = Math.floor(interleaved.length / ch)
    if (frames <= 0) return
    let pl = 0
    let pr = 0
    for (let i = 0; i < frames; i++) {
      const l = Math.abs(interleaved[i * ch])
      const r = ch > 1 ? Math.abs(interleaved[i * ch + 1]) : l
      if (l > pl) pl = l
      if (r > pr) pr = r
    }
    this.peakL = Math.max(pl, this.peakL * 0.95)
    this.peakR = Math.max(pr, this.peakR * 0.95)
    this.receivedFrames += frames
    this.ring.push(interleaved, ch, this.deps.running())
  }

  private tickSynthetic(): void {
    if (this.mode !== 'synthetic') return
    if (this.synthKind === 'impulse' && !this.anchored) return
    const elapsedSec = Math.max(0, (performance.now() - this.synthStartMs) / 1000)
    const driftedRate = this.inRate * (1 + this.driftPpm * 1e-6)
    const want = Math.floor(elapsedSec * driftedRate)
    const n = want - this.synthGenerated
    if (n < 128) return
    const frames = Math.min(n, 4096)
    const buf = new Float32Array(frames * 2)
    const w = (2 * Math.PI) / this.inRate
    const base = this.synthFrameBase + this.synthGenerated
    for (let i = 0; i < frames; i++) {
      const t = base + i
      if (this.synthKind === 'impulse') {
        const v = t % IMPULSE_PERIOD === 0 ? 0.5 : 0
        buf[i * 2] = v
        buf[i * 2 + 1] = v
      } else {
        buf[i * 2] = 0.5 * Math.sin(w * 440 * t)
        buf[i * 2 + 1] = 0.5 * Math.sin(w * 660 * t)
      }
    }
    this.synthGenerated += frames
    this.feedInput(buf, 2)
  }

  pump(): void {
    if (this.mode === 'off' || !this.deps.running()) {
      this.anchored = false
      return
    }
    const outRate = this.deps.rate() || 96000
    const clock = this.deps.clock() + this.offsetFrames()
    const lead = LEAD_BLOCKS * RETURN_BLOCK

    if (!this.anchored || this.produced > clock + lead + 16 * RETURN_BLOCK || this.produced < clock - 16 * RETURN_BLOCK) {
      if (this.anchored) this.resyncs++
      this.produced = clock
      this.anchorFrame = clock - this.injectedFrames
      this.anchored = true
      if (this.mode === 'synthetic' && this.synthKind === 'impulse') {
        this.ring.reset(0)
        this.ring.pull(this.ring.target, outRate, new Float32Array(this.ring.target * 2), 1)
        this.ring.ppm = 0
        this.ring.integPpm = 0
        this.synthStartMs = performance.now()
        this.synthGenerated = 0
        this.synthFrameBase = clock
      } else {
        // Pre-include `lead` so after the initial lead blocks are pulled at t=0, available === target.
        this.ring.reset(lead)
        this.synthStartMs = performance.now()
        this.synthGenerated = 0
      }
    }

    const nominalRatio = this.inRate / outRate
    while (this.produced < clock + lead) {
      const expected = this.anchorFrame + this.injectedFrames
      const err = Math.abs(this.produced - expected)
      if (err > this.maxAlignErrFrames) this.maxAlignErrFrames = err

      if (this.mode === 'synthetic' && this.synthKind === 'impulse') {
        const inBuf = new Float32Array(RETURN_BLOCK * 2)
        for (let i = 0; i < RETURN_BLOCK; i++) {
          const t = this.produced + i
          const v = t % IMPULSE_PERIOD === 0 ? 0.5 : 0
          inBuf[i * 2] = v
          inBuf[i * 2 + 1] = v
        }
        this.feedInput(inBuf, 2)
        const out = new Float32Array(RETURN_BLOCK * 2)
        this.ring.pull(RETURN_BLOCK, outRate, out, 1)
        this.ring.ppm = 0
        this.ring.integPpm = 0
        this.ring.lastRatio = 1
        this.deps.inject(out, this.produced)
      } else {
        const out = new Float32Array(RETURN_BLOCK * 2)
        this.ring.pull(RETURN_BLOCK, outRate, out, nominalRatio)
        this.deps.inject(out, this.produced)
      }
      this.produced += RETURN_BLOCK
      this.injectedFrames += RETURN_BLOCK
      this.injectedBlocks++
    }
  }

  status(): ReturnInStatus {
    const outRate = this.deps.rate() || 96000
    const offsetFrames = this.offsetFrames()
    const clock = this.deps.running() ? this.deps.clock() + offsetFrames : 0
    return {
      running: this.mode !== 'off',
      mode: this.mode,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      sampleRate: this.inRate,
      outputSampleRate: outRate,
      channels: this.channels,
      delayMs: this.delayMs,
      offsetFrames,
      receivedFrames: this.receivedFrames,
      injectedFrames: this.injectedFrames,
      injectedBlocks: this.injectedBlocks,
      ringBufferedFrames: Math.round(this.ring.available),
      ringTargetFrames: this.ring.target,
      ringCapacityFrames: this.ring.cap,
      fillRatio: Math.round(this.ring.fillRatio * 1000) / 1000,
      smoothFillFrames: Math.round(this.ring.smoothFill),
      resampleRatio: Math.round(this.ring.lastRatio * 1e6) / 1e6,
      ppm: Math.round(this.ring.ppm * 10) / 10,
      underruns: this.ring.underruns,
      overruns: this.ring.overruns,
      resyncs: this.resyncs,
      clockDeltaFrames: this.anchored && this.deps.running() ? this.produced - clock : 0,
      peakL: Math.round(this.peakL * 1000) / 1000,
      peakR: Math.round(this.peakR * 1000) / 1000,
      error: this.error
    }
  }
}
