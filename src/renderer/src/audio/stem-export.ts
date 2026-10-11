// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { RESAMPLE_PHASES, RESAMPLE_TAPS, polyphaseCoeffs } from '../gpu/resample-gpu'

/**
 * Stem export: the pure parts (no DOM, no GPU) so they are unit-tested in Node.
 *
 * A STEM is a name a track carries (`lane.stem`). Tracks with the same stem name are exported together as one
 * stereo file: the sum of those tracks as they sound at the channel output (strip + inserts + fader + pan),
 * rendered offline through the same GPU path as the master. The master chain is NOT in it by default (what a
 * standard channel export gives); the Options say what is included.
 */

/** What the channel's own processing contributes. Default: everything (strip + inserts). */
export type StemProcess = 'full' | 'noInserts' | 'dry'

export interface StemExportSettings {
  /** 16 / 24 = integer PCM, 32 = IEEE float. */
  bitDepth: 16 | 24 | 32
  /** 0 = the project's rate. */
  sampleRate: number
  /** full = strip + inserts, noInserts = strip only, dry = fader + pan only. */
  process: StemProcess
  /** Run the render through the master chain (and the master fader). Default false = like a standard channel export. */
  masterChain: boolean
  /** Extra seconds after the last clip (reverb / delay tails). */
  tailSeconds: number
}

export const DEFAULT_STEM_EXPORT: StemExportSettings = {
  bitDepth: 24,
  sampleRate: 0,
  process: 'full',
  masterChain: false,
  tailSeconds: 0
}

export const STEM_SAMPLE_RATES = [0, 44100, 48000, 88200, 96000] as const

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Settings from untrusted input (Options file / MCP arguments): anything off falls back to the default. */
export function sanitizeStemExport(raw: unknown, base: StemExportSettings = DEFAULT_STEM_EXPORT): StemExportSettings {
  const r = isRecord(raw) ? raw : {}
  const bd = Number(r['bitDepth'])
  const sr = Number(r['sampleRate'])
  const tail = Number(r['tailSeconds'])
  const proc = r['process']
  return {
    bitDepth: bd === 16 || bd === 24 || bd === 32 ? bd : base.bitDepth,
    sampleRate: (STEM_SAMPLE_RATES as readonly number[]).includes(sr) ? sr : base.sampleRate,
    process: proc === 'full' || proc === 'noInserts' || proc === 'dry' ? proc : base.process,
    masterChain: typeof r['masterChain'] === 'boolean' ? r['masterChain'] : base.masterChain,
    tailSeconds: Number.isFinite(tail) ? Math.min(60, Math.max(0, tail)) : base.tailSeconds
  }
}

// ---- grouping -----------------------------------------------------------------------------------

export interface StemTrack {
  id: number
  title: string
  stem: string
}

export interface StemGroup {
  name: string
  trackIds: number[]
  trackTitles: string[]
}

/** The stems of a project in first-seen order. Tracks without a stem are not part of any stem. */
export function groupStems(tracks: readonly StemTrack[]): StemGroup[] {
  const map = new Map<string, StemGroup>()
  for (const t of tracks) {
    const name = t.stem.trim()
    if (!name) continue
    let g = map.get(name)
    if (!g) map.set(name, (g = { name, trackIds: [], trackTitles: [] }))
    g.trackIds.push(t.id)
    g.trackTitles.push(t.title)
  }
  return [...map.values()]
}

/** A stem name as typed by a person or an AI: trimmed, one line, bounded. */
export function cleanStemName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40) : ''
}

/** File name part: no path separators or characters Windows refuses. */
export function safeFilePart(s: string): string {
  const t = s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 60)
  return t || 'stem'
}

export function stemFileName(project: string, stem: string, rate: number, bitDepth: number, used: Set<string>): string {
  const base = `${safeFilePart(project)}_${safeFilePart(stem)}_${rate / 1000}k_${bitDepth === 32 ? '32f' : bitDepth}`
  let name = `${base}.wav`
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.wav`
  used.add(name.toLowerCase())
  return name
}

// ---- sample-rate conversion ---------------------------------------------------------------------

/**
 * Resample interleaved stereo (any channel count) from `fromRate` to `toRate` with the same windowed-sinc
 * polyphase filter the importer uses (`polyphaseCoeffs`), linearly interpolating between phases so the
 * timing error stays far below 24-bit. Exact ratios such as 96k → 48k need no interpolation.
 */
export function resampleInterleaved(src: Float32Array, channels: number, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return src
  const inFrames = Math.floor(src.length / channels)
  const outFrames = Math.max(1, Math.round((inFrames * toRate) / fromRate))
  const out = new Float32Array(outFrames * channels)
  const table = polyphaseCoeffs(fromRate, toRate)
  const taps = RESAMPLE_TAPS
  const phases = RESAMPLE_PHASES
  const half = taps / 2 - 1
  const step = fromRate / toRate
  const acc = new Float64Array(channels)
  for (let j = 0; j < outFrames; j++) {
    const pos = j * step
    const base = Math.floor(pos)
    const frac = pos - base
    const pf = frac * phases
    let p0 = Math.floor(pf)
    const w1 = pf - p0
    let b0 = base
    let b1 = base
    let p1 = p0 + 1
    if (p1 >= phases) {
      p1 = 0
      b1 = base + 1
    }
    const exact = w1 < 1e-9
    acc.fill(0)
    for (let k = 0; k < taps; k++) {
      const i0 = b0 - half + k
      const c0 = table[p0 * taps + k] * (exact ? 1 : 1 - w1)
      if (i0 >= 0 && i0 < inFrames) for (let c = 0; c < channels; c++) acc[c] += src[i0 * channels + c] * c0
      if (!exact) {
        const i1 = b1 - half + k
        const c1 = table[p1 * taps + k] * w1
        if (i1 >= 0 && i1 < inFrames) for (let c = 0; c < channels; c++) acc[c] += src[i1 * channels + c] * c1
      }
    }
    for (let c = 0; c < channels; c++) out[j * channels + c] = acc[c]
    void p0
    p0 = p0 + 0
  }
  return out
}

// ---- verification -------------------------------------------------------------------------------

/** Compare the sum of the stems with a direct render of the same tracks: the stems must add up to the mix. */
export function nullTest(sumOfStems: Float32Array, reference: Float32Array): { maxAbsDiff: number; snrDb: number } {
  const n = Math.min(sumOfStems.length, reference.length)
  let maxD = 0
  let sig = 0
  let err = 0
  for (let i = 0; i < n; i++) {
    const d = sumOfStems[i] - reference[i]
    const a = d < 0 ? -d : d
    if (a > maxD) maxD = a
    sig += reference[i] * reference[i]
    err += d * d
  }
  return { maxAbsDiff: maxD, snrDb: err > 0 && sig > 0 ? 10 * Math.log10(sig / err) : Infinity }
}
