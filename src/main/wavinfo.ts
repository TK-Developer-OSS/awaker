// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/** Header facts of a RIFF/WAVE file, read without decoding the samples. */
export interface WavInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** Sample frames per channel. */
  frames: number
}

/**
 * Scan the chunks of a WAV held in `head` (the first part of the file) for `fmt ` and the
 * `data` chunk header. `fileSize` is the whole file's length: the data chunk's declared size
 * is clamped to what is really there (some writers leave 0 / 0xFFFFFFFF while streaming).
 */
export function parseWavInfo(head: Uint8Array, fileSize: number): WavInfo | null {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const tag = (o: number): string => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
  if (head.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let pos = 12
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null
  while (pos + 8 <= head.length) {
    const id = tag(pos)
    const size = dv.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ' && body + 16 <= head.length) {
      fmt = { channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!fmt || fmt.channels < 1 || fmt.bits < 8) return null
      const avail = Math.max(0, fileSize - body)
      const bytes = size === 0 || size > avail ? avail : size
      return {
        channels: fmt.channels,
        sampleRate: fmt.sampleRate,
        bitsPerSample: fmt.bits,
        frames: Math.floor(bytes / (fmt.channels * (fmt.bits / 8)))
      }
    }
    pos = body + size + (size & 1)
  }
  return null
}
