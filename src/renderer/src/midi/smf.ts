// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Standard MIDI File (SMF) reader / writer. Pure and dependency-free so it runs under
 * plain Node for tests. Notes only (plus track names, tempo and time signature):
 * controllers, pitch bend, program changes and sysex are skipped on read and not
 * written. Format 0 files are split into one track per channel; SMPTE time division
 * is rejected.
 */

export interface SmfNote {
  /** Start / duration in ticks. */
  tick: number
  dur: number
  key: number
  vel: number
  channel: number
}

export interface SmfTrack {
  name: string
  channel: number
  notes: SmfNote[]
}

export interface SmfData {
  ppq: number
  /** First tempo in the file (BPM); `tempoChanges` counts the rest. */
  bpm: number
  tempoChanges: number
  timeSig: { num: number; den: number }
  tracks: SmfTrack[]
}

class Reader {
  pos = 0
  constructor(readonly b: Uint8Array) {}
  get eof(): boolean {
    return this.pos >= this.b.length
  }
  u8(): number {
    if (this.pos >= this.b.length) throw new Error('unexpected end of MIDI data')
    return this.b[this.pos++]
  }
  u16(): number {
    return (this.u8() << 8) | this.u8()
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0
  }
  vlq(): number {
    let v = 0
    for (let i = 0; i < 4; i++) {
      const c = this.u8()
      v = (v << 7) | (c & 0x7f)
      if (!(c & 0x80)) return v >>> 0
    }
    throw new Error('bad variable-length quantity')
  }
  text(n: number): string {
    const s = this.b.subarray(this.pos, this.pos + n)
    this.pos += n
    return new TextDecoder('utf-8', { fatal: false }).decode(s)
  }
}

export function parseSmf(bytes: Uint8Array): SmfData {
  const r = new Reader(bytes)
  if (r.text(4) !== 'MThd') throw new Error('not a MIDI file (no MThd header)')
  const hlen = r.u32()
  const format = r.u16()
  const ntrks = r.u16()
  const division = r.u16()
  if (hlen > 6) r.pos += hlen - 6
  if (division & 0x8000) throw new Error('SMPTE time division is not supported')
  const ppq = division || 480
  if (format > 1 && ntrks > 1) throw new Error('format 2 (independent sequences) is not supported')

  let bpm = 0
  let tempoChanges = 0
  let timeSig = { num: 4, den: 4 }
  let haveSig = false
  const out: SmfTrack[] = []

  for (let t = 0; t < ntrks && !r.eof; t++) {
    const id = r.text(4)
    const len = r.u32()
    const end = Math.min(r.pos + len, bytes.length)
    if (id !== 'MTrk') {
      r.pos = end
      continue
    }
    let tick = 0
    let running = 0
    let name = ''
    const open = new Map<number, { tick: number; vel: number }[]>() // (channel<<8|key) → stack
    const notes: SmfNote[] = []
    while (r.pos < end) {
      tick += r.vlq()
      let st = r.u8()
      if (st < 0x80) {
        // running status: this byte is the first data byte
        if (!running) throw new Error('running status without a previous status byte')
        r.pos--
        st = running
      } else if (st < 0xf0) {
        running = st
      }
      if (st === 0xff) {
        const type = r.u8()
        const mlen = r.vlq()
        const mend = r.pos + mlen
        if (type === 0x03 && !name) name = r.text(mlen)
        else if (type === 0x51 && mlen === 3) {
          const us = (r.u8() << 16) | (r.u8() << 8) | r.u8()
          if (us > 0) {
            tempoChanges++
            if (!bpm) bpm = 60_000_000 / us
          }
        } else if (type === 0x58 && mlen >= 2) {
          const num = r.u8()
          const den = 1 << r.u8()
          if (!haveSig) {
            haveSig = true
            timeSig = { num: Math.max(1, num), den: Math.max(1, den) }
          }
        }
        r.pos = mend
        if (type === 0x2f) break
      } else if (st === 0xf0 || st === 0xf7) {
        r.pos += r.vlq()
      } else {
        const hi = st & 0xf0
        const ch = st & 0x0f
        if (hi === 0xc0 || hi === 0xd0) {
          r.u8()
        } else {
          const a = r.u8()
          const b = r.u8()
          if (hi === 0x90 && b > 0) {
            const k = (ch << 8) | a
            const stack = open.get(k) ?? []
            stack.push({ tick, vel: b })
            open.set(k, stack)
          } else if (hi === 0x80 || hi === 0x90) {
            const k = (ch << 8) | a
            const on = open.get(k)?.shift()
            if (on) notes.push({ tick: on.tick, dur: Math.max(1, tick - on.tick), key: a, vel: on.vel, channel: ch })
          }
        }
      }
    }
    // notes still sounding at the end of the track
    for (const [k, stack] of open) {
      for (const on of stack) {
        notes.push({ tick: on.tick, dur: Math.max(1, tick - on.tick), key: k & 0xff, vel: on.vel, channel: k >> 8 })
      }
    }
    r.pos = end
    if (notes.length === 0) continue
    notes.sort((a, b) => a.tick - b.tick || a.key - b.key)
    // one MIDI channel per track: split a multi-channel track (format 0 files)
    const chans = [...new Set(notes.map((n) => n.channel))].sort((a, b) => a - b)
    for (const c of chans) {
      out.push({
        name: chans.length > 1 ? `${name || 'Track'} ch${c + 1}` : name || `Track ${out.length + 1}`,
        channel: c,
        notes: notes.filter((n) => n.channel === c)
      })
    }
  }
  return { ppq, bpm: bpm || 120, tempoChanges, timeSig, tracks: out }
}

// ---- writer -----------------------------------------------------------------

const vlq = (v: number): number[] => {
  let n = Math.max(0, Math.floor(v)) >>> 0
  const out = [n & 0x7f]
  while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80)
  return out
}
const be16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff]
const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0x7f)

function chunk(id: string, body: number[]): number[] {
  return [...ascii(id), ...be32(body.length), ...body]
}

export interface SmfOutTrack {
  name: string
  channel: number
  /** Notes in ticks at `ppq`. */
  notes: { tick: number; dur: number; key: number; vel: number }[]
}

/** Write a format-1 file: a conductor track (tempo, time signature) + one track per input. */
export function writeSmf(
  tracks: SmfOutTrack[],
  opts: { ppq?: number; bpm: number; timeSig: { num: number; den: number } }
): Uint8Array {
  const ppq = opts.ppq ?? 480
  const us = Math.round(60_000_000 / Math.max(1, opts.bpm))
  const dd = Math.max(0, Math.round(Math.log2(Math.max(1, opts.timeSig.den))))

  const conductor: number[] = [
    0x00, 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff,
    0x00, 0xff, 0x58, 0x04, opts.timeSig.num & 0xff, dd, 24, 8,
    0x00, 0xff, 0x2f, 0x00
  ]
  const chunks: number[][] = [chunk('MTrk', conductor)]

  for (const t of tracks) {
    const ch = Math.max(0, Math.min(15, t.channel | 0))
    const name = ascii(t.name || 'Track')
    const body: number[] = [0x00, 0xff, 0x03, ...vlq(name.length), ...name]
    // note-on / note-off events, offs before ons at the same tick so repeats re-trigger
    const ev: { tick: number; order: number; bytes: number[] }[] = []
    for (const n of t.notes) {
      const key = Math.max(0, Math.min(127, n.key | 0))
      const start = Math.max(0, Math.round(n.tick))
      const stop = start + Math.max(1, Math.round(n.dur))
      ev.push({ tick: start, order: 1, bytes: [0x90 | ch, key, Math.max(1, Math.min(127, n.vel | 0))] })
      ev.push({ tick: stop, order: 0, bytes: [0x80 | ch, key, 0] })
    }
    ev.sort((a, b) => a.tick - b.tick || a.order - b.order)
    let last = 0
    for (const e of ev) {
      body.push(...vlq(e.tick - last), ...e.bytes)
      last = e.tick
    }
    body.push(0x00, 0xff, 0x2f, 0x00)
    chunks.push(chunk('MTrk', body))
  }

  const header = chunk('MThd', [...be16(1), ...be16(chunks.length), ...be16(ppq)])
  return Uint8Array.from([...header, ...chunks.flat()])
}
