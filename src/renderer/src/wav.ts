// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
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
