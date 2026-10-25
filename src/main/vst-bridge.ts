// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'

/**
 * VST host bridge (proof of concept). A separate host process loads a VST3 instrument and
 * connects to this server on 127.0.0.1; we send it MIDI and block lengths, it returns audio.
 * The returned blocks go onto the live path (the same one the line input uses), so the
 * instrument runs through the track's strip + inserts and out the device like any live source.
 *
 * Pacing: the host is **pulled** ahead of the device clock — one 512-frame block in flight,
 * a new one requested while produced < output clock + lead. Both ends count frames on the
 * output clock, so a late block can never be misplaced (the live ring drops it). The host
 * runs in its own process: a crashing plugin takes down the host, not the app.
 *
 * Wire format (little endian): u32 length (of type + payload), u8 type, payload.
 *   host → app : 1 HELLO utf8 token | 2 READY u8 ok, utf8 message | 3 AUDIO u32 seq, u32 frames, f32 L/R interleaved
 *   app → host : 10 INIT u32 sampleRate, u32 block, utf8 plugin path | 11 RENDER u32 seq, u32 frames, u32 n,
 *                n × (u32 offset, u8 status, u8 d1, u8 d2, u8 0) | 12 BYE
 */

export const VST_BLOCK = 512
/** Blocks produced ahead of the output clock. */
const LEAD_BLOCKS = 1

const T_HELLO = 1
const T_READY = 2
const T_AUDIO = 3
const T_INIT = 10
const T_RENDER = 11
const T_BYE = 12

/** What the bridge needs from the audio engine. */
export interface VstBridgeDeps {
  /** Output frames played since the stream began. */
  clock(): number
  running(): boolean
  rate(): number
  /** One interleaved stereo block captured at `start` on the output clock. */
  inject(block: Float32Array, start: number): void
  setExternal(on: boolean): void
}

export interface MidiEv {
  /** Wall-clock time in ms since the epoch (performance.timeOrigin + performance.now()). */
  t: number
  st: number
  d1: number
  d2: number
}

interface Pending {
  frame: number
  st: number
  d1: number
  d2: number
}

const nowMs = (): number => performance.timeOrigin + performance.now()

export class VstBridge {
  private server: Server | null = null
  private sock: Socket | null = null
  private token = ''
  private plugin = ''
  private buf: Buffer = Buffer.alloc(0)
  private ready = false
  private message = ''
  private timer: NodeJS.Timeout | null = null
  private seq = 0
  private inflight: { seq: number; start: number; t0: number } | null = null
  private produced = 0
  private pending: Pending[] = []
  private resyncs = 0
  private blocks = 0
  private rttSum = 0
  private rttMax = 0
  private lateEvents = 0
  private sentEvents = 0
  private overBudget = 0

  constructor(private readonly deps: VstBridgeDeps) {}

  /** Listen for the host. Returns what to start it with. */
  listen(plugin: string): Promise<{ port: number; token: string; sampleRate: number; block: number }> {
    this.stop()
    this.token = randomBytes(12).toString('hex')
    this.plugin = plugin
    return new Promise((resolve, reject) => {
      const srv = createServer((s) => this.accept(s))
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (!addr || typeof addr === 'string') return reject(new Error('no port'))
        this.server = srv
        resolve({ port: addr.port, token: this.token, sampleRate: this.deps.rate(), block: VST_BLOCK })
      })
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      this.sock?.write(this.frame(T_BYE, Buffer.alloc(0)))
    } catch {
      /* gone */
    }
    this.sock?.destroy()
    this.sock = null
    this.server?.close()
    this.server = null
    this.ready = false
    this.inflight = null
    this.pending = []
    this.deps.setExternal(false)
  }

  /** MIDI with wall-clock times (the app's MIDI pump stamps events ~150 ms ahead). */
  midi(events: MidiEv[]): void {
    if (!this.ready) return
    const sr = this.deps.rate()
    const clock = this.deps.clock()
    const now = nowMs()
    for (const e of events) {
      const frame = clock + Math.round(((e.t - now) * sr) / 1000)
      this.pending.push({ frame, st: e.st & 0xff, d1: e.d1 & 0x7f, d2: e.d2 & 0x7f })
    }
    this.pending.sort((a, b) => a.frame - b.frame)
  }

  status(): Record<string, unknown> {
    return {
      listening: !!this.server,
      connected: !!this.sock,
      ready: this.ready,
      message: this.message,
      plugin: this.plugin,
      blocks: this.blocks,
      rttMeanMs: this.blocks ? this.rttSum / this.blocks : 0,
      rttMaxMs: this.rttMax,
      overBudgetBlocks: this.overBudget,
      budgetMs: ((VST_BLOCK / (this.deps.rate() || 96000)) * 1000),
      resyncs: this.resyncs,
      eventsSent: this.sentEvents,
      eventsLate: this.lateEvents,
      queuedEvents: this.pending.length,
      producedAheadFrames: this.produced - this.deps.clock()
    }
  }

  // ---- connection ---------------------------------------------------------------

  private frame(type: number, payload: Buffer): Buffer {
    const h = Buffer.alloc(5)
    h.writeUInt32LE(payload.length + 1, 0)
    h.writeUInt8(type, 4)
    return Buffer.concat([h, payload])
  }

  private accept(s: Socket): void {
    if (this.sock) {
      s.destroy() // one host at a time
      return
    }
    this.sock = s
    this.buf = Buffer.alloc(0)
    s.setNoDelay(true)
    s.on('data', (d) => this.onData(d))
    s.on('close', () => {
      if (this.sock === s) {
        this.sock = null
        this.ready = false
        this.inflight = null
        this.deps.setExternal(false)
        this.message = this.message || 'host disconnected'
      }
    })
    s.on('error', () => s.destroy())
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    for (;;) {
      if (this.buf.length < 5) return
      const len = this.buf.readUInt32LE(0)
      if (len < 1 || len > 8 * 1024 * 1024) {
        this.sock?.destroy()
        return
      }
      if (this.buf.length < 4 + len) return
      const type = this.buf.readUInt8(4)
      const payload = this.buf.subarray(5, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      this.onFrame(type, payload)
    }
  }

  private onFrame(type: number, p: Buffer): void {
    if (type === T_HELLO) {
      if (p.toString('utf8') !== this.token) {
        this.sock?.destroy()
        return
      }
      const init = Buffer.alloc(8)
      init.writeUInt32LE(this.deps.rate(), 0)
      init.writeUInt32LE(VST_BLOCK, 4)
      this.sock?.write(this.frame(T_INIT, Buffer.concat([init, Buffer.from(this.plugin, 'utf8')])))
    } else if (type === T_READY) {
      const ok = p.readUInt8(0) === 1
      this.message = p.subarray(1).toString('utf8')
      if (!ok) return
      this.ready = true
      this.produced = this.deps.clock()
      this.blocks = this.rttSum = this.rttMax = this.lateEvents = this.sentEvents = this.overBudget = this.resyncs = 0
      this.deps.setExternal(true)
      if (!this.timer) this.timer = setInterval(() => this.pump(), 1)
    } else if (type === T_AUDIO) {
      const inflight = this.inflight
      if (!inflight || p.readUInt32LE(0) !== inflight.seq) return
      const frames = p.readUInt32LE(4)
      const raw = p.subarray(8, 8 + frames * 8)
      if (raw.length === frames * 8) {
        const f = new Float32Array(frames * 2)
        Buffer.from(f.buffer).set(raw)
        this.deps.inject(f, inflight.start)
      }
      const rtt = performance.now() - inflight.t0
      this.blocks++
      this.rttSum += rtt
      if (rtt > this.rttMax) this.rttMax = rtt
      if (rtt > (VST_BLOCK / this.deps.rate()) * 1000) this.overBudget++
      this.produced = inflight.start + frames
      this.inflight = null
      this.pump()
    }
  }

  /** Ask for the next block if the host is idle and we are behind the lead. */
  private pump(): void {
    if (!this.ready || this.inflight || !this.sock || !this.deps.running()) return
    const clock = this.deps.clock()
    const lead = LEAD_BLOCKS * VST_BLOCK
    // the stream restarted (clock went back) or we fell far behind: re-anchor on the clock
    if (this.produced > clock + lead + 8 * VST_BLOCK || this.produced < clock - 4 * VST_BLOCK) {
      this.produced = clock
      this.resyncs++
    }
    if (this.produced >= clock + lead) return
    const start = this.produced
    const end = start + VST_BLOCK
    const evs: Pending[] = []
    while (this.pending.length && this.pending[0].frame < end) evs.push(this.pending.shift() as Pending)
    const head = Buffer.alloc(12 + evs.length * 8)
    this.seq = (this.seq + 1) >>> 0
    head.writeUInt32LE(this.seq, 0)
    head.writeUInt32LE(VST_BLOCK, 4)
    head.writeUInt32LE(evs.length, 8)
    evs.forEach((e, i) => {
      if (e.frame < start) this.lateEvents++
      const o = 12 + i * 8
      head.writeUInt32LE(Math.max(0, e.frame - start), o)
      head.writeUInt8(e.st, o + 4)
      head.writeUInt8(e.d1, o + 5)
      head.writeUInt8(e.d2, o + 6)
    })
    this.sentEvents += evs.length
    this.inflight = { seq: this.seq, start, t0: performance.now() }
    this.sock.write(this.frame(T_RENDER, head))
  }
}
