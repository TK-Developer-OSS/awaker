// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Minimal WAV decoder (PCM 8/16/24/32-bit int + 32-bit float, any channel count).
 * Runs once on the CPU purely to get raw samples; everything after this lives on
 * the GPU. Returns **planar** channels (one Float32Array per channel) — that's
 * the layout the GPU wants (coalesced per-channel access).
 */
export interface DecodedAudio {
  sampleRate: number
  frames: number
  /** channels[c][frame], range roughly [-1, 1]. 1 entry (mono) or 2 (stereo+). */
  channels: Float32Array[]
}

export function decodeWav(bytes: ArrayBuffer): DecodedAudio {
  const view = new DataView(bytes)
  const tag = (o: number): string =>
    String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file')

  let offset = 12
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= view.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true)
      }
    } else if (id === 'data') {
      dataOffset = body
      dataLength = size
    }
    offset = body + size + (size & 1) // chunks are word-aligned
  }

  if (!fmt || dataOffset < 0) throw new Error('Missing fmt or data chunk')

  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt
  const bytesPerSample = bitsPerSample / 8
  const frames = Math.floor(dataLength / (bytesPerSample * channels))

  // Phase 0 keeps at most 2 channels (stereo master). Extra channels are dropped.
  const outCh = Math.min(channels, 2)
  const out: Float32Array[] = Array.from({ length: outCh }, () => new Float32Array(frames))

  const readSample = (pos: number): number => {
    if (audioFormat === 3 && bitsPerSample === 32) return view.getFloat32(pos, true)
    if (bitsPerSample === 16) return view.getInt16(pos, true) / 32768
    if (bitsPerSample === 32) return view.getInt32(pos, true) / 2147483648
    if (bitsPerSample === 24) {
      const b0 = view.getUint8(pos)
      const b1 = view.getUint8(pos + 1)
      const b2 = view.getUint8(pos + 2)
      let v = b0 | (b1 << 8) | (b2 << 16)
      if (v & 0x800000) v |= ~0xffffff
      return v / 8388608
    }
    if (bitsPerSample === 8) return (view.getUint8(pos) - 128) / 128
    throw new Error(`Unsupported bit depth: ${bitsPerSample}`)
  }

  for (let f = 0; f < frames; f++) {
    const base = dataOffset + f * channels * bytesPerSample
    for (let c = 0; c < outCh; c++) {
      out[c][f] = readSample(base + c * bytesPerSample)
    }
  }

  return { sampleRate, frames, channels: out }
}

/**
 * Encode planar float32 channels as a 32-bit-float WAV (RIFF format tag 3). No integer
 * conversion, so the samples round-trip exactly (used to export GPU-rendered sources).
 */
export function encodeWavFloat32(planar: Float32Array[], sampleRate: number): ArrayBuffer {
  const ch = planar.length
  const frames = planar[0]?.length ?? 0
  const dataBytes = frames * ch * 4
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 3, true) // IEEE float
  v.setUint16(22, ch, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * ch * 4, true)
  v.setUint16(32, ch * 4, true)
  v.setUint16(34, 32, true)
  str(36, 'data')
  v.setUint32(40, dataBytes, true)
  let o = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      v.setFloat32(o, planar[c][i], true)
      o += 4
    }
  }
  return buf
}

/**
 * Encode INTERLEAVED float samples as a WAV: 16 / 24-bit integer PCM or 32-bit float. Integer output is
 * clamped to full scale (the number of clamped samples is returned: any > 0 means the export clipped) and
 * 16-bit gets TPDF dither (24-bit does not need it). Like every float → int conversion, this lives here only.
 */
export function encodeWavPcm(
  interleaved: Float32Array,
  channels: number,
  sampleRate: number,
  bitDepth: 16 | 24 | 32
): { bytes: ArrayBuffer; clamped: number } {
  const bytesPer = bitDepth / 8
  const frames = Math.floor(interleaved.length / channels)
  const dataBytes = frames * channels * bytesPer
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const str = (o: number, t: string): void => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, bitDepth === 32 ? 3 : 1, true) // 3 = IEEE float, 1 = PCM
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * channels * bytesPer, true)
  v.setUint16(32, channels * bytesPer, true)
  v.setUint16(34, bitDepth, true)
  str(36, 'data')
  v.setUint32(40, dataBytes, true)
  let o = 44
  let clamped = 0
  const n = frames * channels
  if (bitDepth === 32) {
    for (let i = 0; i < n; i++, o += 4) v.setFloat32(o, interleaved[i], true)
  } else if (bitDepth === 24) {
    for (let i = 0; i < n; i++, o += 3) {
      let x = Math.round(interleaved[i] * 8388607)
      if (x > 8388607) (x = 8388607), clamped++
      else if (x < -8388608) (x = -8388608), clamped++
      v.setUint8(o, x & 0xff)
      v.setUint8(o + 1, (x >> 8) & 0xff)
      v.setUint8(o + 2, (x >> 16) & 0xff)
    }
  } else {
    let seed = 0x12345678
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0 // deterministic: the same export is byte-identical
      return (seed >>> 0) / 4294967296
    }
    for (let i = 0; i < n; i++, o += 2) {
      const d = (rnd() - rnd()) / 32768 // TPDF, +-1 LSB
      let x = Math.round((interleaved[i] + d) * 32767)
      if (x > 32767) (x = 32767), clamped++
      else if (x < -32768) (x = -32768), clamped++
      v.setInt16(o, x, true)
    }
  }
  return { bytes: buf, clamped }
}
