// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * MCU-protocol control surface driver for a P1-Nano-class surface (MCU mode).
 * Web MIDI (Chromium) — control surface only; audio device I/O stays in main.
 *
 * Nano has one motorised fader → it follows the *active track* (bank buttons
 * move the active track). Feedback: fader position, 7-seg timecode, LCD track
 * name, track-number display, SEL/MUTE/SOLO/REC LEDs, transport LEDs.
 */

export interface McuTrackInfo {
  index: number // 0-based
  count: number
  name: string
  gainDb: number
  /** -1..+1 */
  pan: number
  mute: boolean
  solo: boolean
  rec: boolean
}

export interface McuHost {
  track(): McuTrackInfo | null
  setGainDb(db: number): void
  bank(delta: number): void
  toggle(what: 'mute' | 'solo' | 'rec'): void
  transport(cmd: 'play' | 'stop' | 'record' | 'rew' | 'ff'): void
  /** Playhead in seconds. */
  timeSec(): number
  playing(): boolean
  /** V-Pot: set the active track's pan (-1..+1). */
  setPan(pan: number): void
  /** Jog wheel: move the playhead by signed ticks. */
  jog(ticks: number): void
  /** Master fader (surfaces that have one: pitch bend on channel 9). */
  masterDb(): number
  setMasterDb(db: number): void
}

/**
 * MCU relative encoders (V-Pot CC 0x10.., jog CC 0x3C): bits 0-5 = tick count,
 * bit 6 = direction (0 = clockwise / positive, 1 = counter-clockwise / negative).
 */
export function decodeRelative(v: number): number {
  const n = v & 0x3f
  return v & 0x40 ? -n : n
}

/** V-Pot ring LED byte for a pan position: mode 0 (single dot) | position 1..11 (6 = centre). */
export function panRing(pan: number): number {
  const pos = 1 + Math.round(((Math.max(-1, Math.min(1, pan)) + 1) / 2) * 10)
  return pos
}

const FADER_MIN_DB = -60
const FADER_MAX_DB = 6
const UNITY_POS = 0.75 // fader travel at 0 dB
const CURVE = 1.6

export function posToDb(pos: number): number {
  if (pos >= UNITY_POS) return ((pos - UNITY_POS) / (1 - UNITY_POS)) * FADER_MAX_DB
  const p = pos / UNITY_POS
  return p <= 0 ? FADER_MIN_DB : FADER_MIN_DB * Math.pow(1 - p, CURVE)
}

export function dbToPos(db: number): number {
  if (db >= 0) return UNITY_POS + (Math.min(db, FADER_MAX_DB) / FADER_MAX_DB) * (1 - UNITY_POS)
  if (db <= FADER_MIN_DB) return 0
  // db and FADER_MIN_DB are both negative here, so the ratio is positive (the old `-db / min` was negative → NaN)
  return UNITY_POS * (1 - Math.pow(db / FADER_MIN_DB, 1 / CURVE))
}

// Note numbers (ch 1) for the strip-0 / transport buttons we use.
const N_REC = 0x00
const N_SOLO = 0x08
const N_MUTE = 0x10
const N_SELECT = 0x18
const N_BANK_L = 0x2e
const N_BANK_R = 0x2f
const N_REW = 0x5b
const N_FF = 0x5c
const N_STOP = 0x5d
const N_PLAY = 0x5e
const N_RECORD = 0x5f
const N_FADER_TOUCH = 0x68
const N_VPOT_PUSH = 0x20 // strip-0 V-Pot switch
const PAN_PER_TICK = 0.04 // one detent = 4 % of the pan range

/** 7-segment glyph byte for MCU displays (ASCII & 0x3F, bit 6 = decimal point). */
const seg = (ch: string, dot = false): number => (ch.charCodeAt(0) & 0x3f) | (dot ? 0x40 : 0)

export class McuSurface {
  private outs: MIDIOutput[] = []
  private touched = false
  private lastPb = -1
  private lastMaster = -1
  private masterTouched = false
  private lastRing = -1
  private lastTc = ''
  private lastAssign = ''
  private lastLcd = ''
  private led = new Map<number, number>()
  portName = ''

  constructor(private host: McuHost) {}

  async start(): Promise<void> {
    if (!navigator.requestMIDIAccess) return
    let access: MIDIAccess
    try {
      access = await navigator.requestMIDIAccess({ sysex: true })
    } catch (err) {
      console.warn('[mcu] MIDI access denied', err)
      return
    }
    const attach = (): void => {
      const isNano = (p: MIDIPort): boolean => /p1-?nano|platform ?nano|icon/i.test(p.name ?? '')
      let found = false
      for (const inp of access.inputs.values()) {
        if (!isNano(inp)) continue
        inp.onmidimessage = (e) => this.onMessage(e.data as Uint8Array)
        found = true
      }
      // The Nano exposes several ports (port 1 + "MIDIIN2..4"); which one carries MCU
      // depends on its mode, so feed back to all of them.
      this.outs = [...access.outputs.values()].filter(isNano)
      this.portName = found ? this.outs.map((o) => o.name).join(', ') : ''
      console.log('[mcu] inputs:', [...access.inputs.values()].map((p) => p.name), 'outputs:', [...access.outputs.values()].map((p) => p.name))
      if (this.outs.length) {
        this.lastPb = -1
        this.lastTc = this.lastAssign = this.lastLcd = ''
        this.led.clear()
        console.log(`[mcu] connected: ${this.portName}`)
      }
    }
    attach()
    access.onstatechange = attach // hot-plug
  }

  private send(data: number[]): void {
    for (const o of this.outs) {
      try {
        o.send(data)
      } catch {
        /* port vanished mid-send */
      }
    }
  }

  private onMessage(d: Uint8Array): void {
    console.log('[mcu] in', [...d].map((b) => b.toString(16)).join(' '))
    const st = d[0] & 0xf0
    if (st === 0xe0 && (d[0] & 0x0f) === 8) {
      // Master fader (ch 9 pitch bend)
      const v = (d[2] << 7) | d[1]
      this.lastMaster = v
      this.host.setMasterDb(posToDb(v / 16383))
      return
    }
    if (st === 0xb0 && d[1] === 0x10) {
      // V-Pot 1: pan of the active track
      const t = this.host.track()
      if (t) this.host.setPan(Math.max(-1, Math.min(1, t.pan + decodeRelative(d[2]) * PAN_PER_TICK)))
      return
    }
    if (st === 0xb0 && d[1] === 0x3c) {
      // Jog wheel
      this.host.jog(decodeRelative(d[2]))
      return
    }
    if (st === 0xe0 && (d[0] & 0x0f) === 0) {
      // Fader (ch 1 pitch bend, 14-bit). Only act while touched, or if the touch
      // note never arrives (older firmware) — a motor echo would otherwise loop.
      const v = (d[2] << 7) | d[1]
      this.lastPb = v
      this.host.setGainDb(posToDb(v / 16383))
      return
    }
    if (st !== 0x90 && st !== 0x80) return
    const down = st === 0x90 && d[2] > 0
    const n = d[1]
    if (n === N_FADER_TOUCH) {
      this.touched = down
      return
    }
    if (n === N_FADER_TOUCH + 8) {
      this.masterTouched = down // master fader touch (note 0x70)
      return
    }
    if (n === N_VPOT_PUSH && down) {
      this.host.setPan(0) // press = centre
      return
    }
    if (!down) return
    switch (n) {
      case N_REC: this.host.toggle('rec'); break
      case N_SOLO: this.host.toggle('solo'); break
      case N_MUTE: this.host.toggle('mute'); break
      case N_SELECT: break
      case N_BANK_L: this.host.bank(-1); break
      case N_BANK_R: this.host.bank(1); break
      case N_REW: this.host.transport('rew'); break
      case N_FF: this.host.transport('ff'); break
      case N_STOP: this.host.transport('stop'); break
      case N_PLAY: this.host.transport('play'); break
      case N_RECORD: this.host.transport('record'); break
    }
  }

  private setLed(note: number, on: boolean): void {
    const v = on ? 0x7f : 0
    if (this.led.get(note) === v) return
    this.led.set(note, v)
    this.send([0x90, note, v])
  }

  /** Call every UI frame; only sends on change. */
  tick(): void {
    if (!this.outs.length) return
    const t = this.host.track()

    // Motor fader follows the active track (not while the hand is on it).
    if (t && !this.touched) {
      const pb = Math.round(dbToPos(t.gainDb) * 16383)
      if (Math.abs(pb - this.lastPb) > 8) {
        this.lastPb = pb
        this.send([0xe0, pb & 0x7f, pb >> 7])
      }
    }

    // Master fader motor + V-Pot ring.
    if (!this.masterTouched) {
      const pb = Math.round(dbToPos(this.host.masterDb()) * 16383)
      if (Math.abs(pb - this.lastMaster) > 8) {
        this.lastMaster = pb
        this.send([0xe8, pb & 0x7f, pb >> 7])
      }
    }
    const ring = t ? panRing(t.pan) : 0
    if (ring !== this.lastRing) {
      this.lastRing = ring
      this.send([0xb0, 0x30, ring]) // V-Pot 1 ring: single-dot mode, position 1..11
    }

    // 7-seg timecode, same value as the window clock (m:ss.mmm): 10 digits,
    // CC 0x49 (leftmost) .. 0x40. Layout: [2 blank][min 3][sec 2][ms 3], dots after min / sec.
    const totalMs = Math.round(this.host.timeSec() * 1000)
    const m = Math.floor(totalMs / 60000)
    const sec = Math.floor(totalMs / 1000) % 60
    const ms = totalMs % 1000
    const tc =
      '  ' +
      String(Math.min(m, 999)).padStart(3, ' ') +
      String(sec).padStart(2, '0') +
      String(ms).padStart(3, '0')
    // Diagnostic: DevTools `__mcuTest = true` shows 1234567890 (CC 0x49 → 0x40) to read the digit order.
    const test = (globalThis as { __mcuTest?: boolean }).__mcuTest === true
    const tcKey = test ? 'TEST' : tc
    if (tcKey !== this.lastTc) {
      this.lastTc = tcKey
      const digits = test ? '1234567890' : tc // 10 positions
      for (let i = 0; i < 10; i++) {
        // dots after the minutes / seconds digits
        const dot = i === 4 || i === 6
        this.send([0xb0, 0x49 - i, seg(digits[i], dot)])
      }
    }

    // Assignment 2-digit display = active track number (CC 0x4B left, 0x4A right).
    const num = t ? String(Math.min(t.index + 1, 99)).padStart(2, ' ') : '  '
    if (num !== this.lastAssign) {
      this.lastAssign = num
      this.send([0xb0, 0x4b, seg(num[0])])
      this.send([0xb0, 0x4a, seg(num[1])])
    }

    // LCD (SysEx 0x12): top line = name, bottom = gain / state. 7 chars per strip.
    const lcdSig = t ? `${t.name}|${t.gainDb.toFixed(1)}|${t.index}/${t.count}` : ''
    if (lcdSig !== this.lastLcd) {
      this.lastLcd = lcdSig
      const top = (t ? t.name : '').slice(0, 7).padEnd(7, ' ')
      const bot = (t ? (t.gainDb <= FADER_MIN_DB ? '-inf' : t.gainDb.toFixed(1)) : '').slice(0, 7).padEnd(7, ' ')
      const bytes = (txt: string): number[] => [...txt].map((c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 0x3f))
      this.send([0xf0, 0x00, 0x00, 0x66, 0x14, 0x12, 0x00, ...bytes(top), 0xf7])
      this.send([0xf0, 0x00, 0x00, 0x66, 0x14, 0x12, 0x38, ...bytes(bot), 0xf7])
    }

    // LEDs
    this.setLed(N_SELECT, !!t)
    this.setLed(N_MUTE, !!t?.mute)
    this.setLed(N_SOLO, !!t?.solo)
    this.setLed(N_REC, !!t?.rec)
    this.setLed(N_PLAY, this.host.playing())
    this.setLed(N_STOP, !this.host.playing())
  }
}
