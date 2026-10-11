// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Long-term average spectrum of a whole song, and what to do about its difference from a target.
 * Pure (no DOM, no GPU), so it is unit-tested in Node (tests/spectrum.test.ts).
 *
 * Used by the AI mix: the app measures the render of the mix (what a bounce / stem export gives back, i.e. the
 * same transient CPU copy those already make), the AI reads the numbers and moves faders / EQs, and measures again.
 * The numbers are the app's own measurement — the AI never has to guess the balance by "listening".
 *
 * Bands are 1/3 octaves, 31.5 Hz – 16 kHz (28). A band's level is the mean-square energy of the song in that band
 * (dB re full scale, both channels averaged). For comparing balance only the SHAPE matters, so the shape is the
 * level minus its mean over the core bands (100 Hz – 8 kHz): loudness drops out.
 */

export const BAND_CENTERS: readonly number[] = [
  31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
  10000, 12500, 16000
]
export const NUM_BANDS = BAND_CENTERS.length
/** First / last band (inclusive) of the core range 100 Hz – 8 kHz: the shape is normalised on it. */
export const CORE_FIRST = 5
export const CORE_LAST = 24

const HALF_THIRD = Math.pow(2, 1 / 6)
export const bandLow = (i: number): number => BAND_CENTERS[i] / HALF_THIRD
export const bandHigh = (i: number): number => BAND_CENTERS[i] * HALF_THIRD

const toDb = (energy: number): number => (energy > 1e-20 ? 10 * Math.log10(energy) : -200)
const round = (x: number, step: number): number => Number((Math.round(x / step) * step).toFixed(6))

// ---- FFT ---------------------------------------------------------------------------------------

function makeFft(n: number): (re: Float64Array, im: Float64Array) => void {
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n)
    sin[i] = Math.sin((-2 * Math.PI * i) / n)
  }
  const bits = Math.log2(n)
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j
          const b = a + half
          const wr = cos[k]
          const wi = sin[k]
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}

// ---- the average spectrum ----------------------------------------------------------------------

export interface LongTermSpectrum {
  /** Band energy (dB re full scale, mean of the channels) of the song, per band. -200 where there is nothing. */
  levelDb: number[]
  /** Frames the average is made of / frames looked at / frames the silence gate removed. */
  usedFrames: number
  totalFrames: number
  gatedOut: number
  seconds: number
}

export interface SpectrumOptions {
  /** At most about this many analysis frames, spread evenly over the song (long songs are sampled). Default 500. */
  maxFrames?: number
}

/** Analysis frame length: about 6 Hz resolution, a power of two. */
export function frameSizeFor(sampleRate: number): number {
  let n = 4096
  while (n < sampleRate / 6 && n < 65536) n <<= 1
  return n
}

/**
 * The long-term average spectrum, fed block by block (so a render does not have to be kept in memory): Hann frames
 * (50 % overlap, every `stride`-th one so a long song is sampled evenly), one complex FFT per frame for both
 * channels (left real / right imaginary), band energies, then a power average over the frames that are not silence
 * (absolute gate -70 dBFS, then -30 dB under the mean of what passed).
 *
 * `totalFrames` is the length that will be pushed (it decides the stride); pushing more or less still works.
 */
export class SpectrumAccumulator {
  private readonly n: number
  private readonly hop: number
  private readonly fft: (re: Float64Array, im: Float64Array) => void
  private readonly win: Float64Array
  private readonly binBand: Int16Array
  private readonly norm: number
  private readonly stride: number
  private readonly ringL: Float32Array
  private readonly ringR: Float32Array
  private readonly re: Float64Array
  private readonly im: Float64Array
  private written = 0 // samples pushed so far
  private readonly bandsPerFrame: Float64Array[] = []
  private readonly frameMs: number[] = []

  constructor(
    private readonly sampleRate: number,
    totalFrames: number,
    opts: SpectrumOptions = {}
  ) {
    this.n = frameSizeFor(sampleRate)
    this.hop = this.n / 2
    this.fft = makeFft(this.n)
    this.win = new Float64Array(this.n)
    let sumW2 = 0
    for (let i = 0; i < this.n; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n)
      sumW2 += this.win[i] * this.win[i]
    }
    this.norm = 1 / (this.n * sumW2)
    // bin -> band (the band whose edges contain the bin frequency)
    this.binBand = new Int16Array(this.n / 2 + 1).fill(-1)
    for (let k = 1; k <= this.n / 2; k++) {
      const f = (k * sampleRate) / this.n
      for (let b = 0; b < NUM_BANDS; b++) {
        if (f >= bandLow(b) && f < bandHigh(b)) {
          this.binBand[k] = b
          break
        }
      }
    }
    const positions = Math.max(1, Math.floor((totalFrames - this.n) / this.hop) + 1)
    this.stride = Math.max(1, Math.ceil(positions / Math.max(1, opts.maxFrames ?? 500)))
    this.ringL = new Float32Array(this.n)
    this.ringR = new Float32Array(this.n)
    this.re = new Float64Array(this.n)
    this.im = new Float64Array(this.n)
  }

  /** `count` frames of interleaved stereo. */
  pushInterleaved(block: Float32Array, count: number): void {
    for (let i = 0; i < count; i++) this.push1(block[i * 2], block[i * 2 + 1])
  }

  /** `count` frames of planar channels (`r` may be the same array as `l` for mono). */
  pushPlanar(l: Float32Array, r: Float32Array, count: number): void {
    for (let i = 0; i < count; i++) this.push1(l[i], r[i])
  }

  private push1(l: number, r: number): void {
    const at = this.written % this.n
    this.ringL[at] = l
    this.ringR[at] = r
    this.written++
    if (this.written >= this.n && (this.written - this.n) % this.hop === 0) {
      const p = (this.written - this.n) / this.hop
      if (p % this.stride === 0) this.analyze(this.written % this.n)
    }
  }

  /** Analyse the frame whose oldest sample is at ring position `from`. */
  private analyze(from: number): void {
    const { n, win, re, im, ringL, ringR } = this
    for (let i = 0; i < n; i++) {
      const at = (from + i) % n
      re[i] = ringL[at] * win[i]
      im[i] = ringR[at] * win[i]
    }
    this.fft(re, im)
    const bands = new Float64Array(NUM_BANDS)
    let total = 0
    for (let k = 1; k < n / 2; k++) {
      // |XL|^2 + |XR|^2 from the packed transform, both channels averaged -> mean square per bin
      const a = re[k] * re[k] + im[k] * im[k]
      const c = re[n - k] * re[n - k] + im[n - k] * im[n - k]
      const e = ((a + c) / 2) * this.norm
      total += e
      const b = this.binBand[k]
      if (b >= 0) bands[b] += e
    }
    this.bandsPerFrame.push(bands)
    this.frameMs.push(total)
  }

  finish(): LongTermSpectrum {
    // a file shorter than one frame: analyse what there is, zero-padded (the ring is still in write order)
    if (this.bandsPerFrame.length === 0 && this.written > 0) this.analyze(0)
    const ABS_GATE = 1e-7 // -70 dBFS mean square
    let sumPass = 0
    let nPass = 0
    for (const t of this.frameMs) {
      if (t >= ABS_GATE) {
        sumPass += t
        nPass++
      }
    }
    const relGate = nPass > 0 ? (sumPass / nPass) * 1e-3 : 0 // 30 dB under the mean of what passed
    const acc = new Float64Array(NUM_BANDS)
    let used = 0
    for (let f = 0; f < this.bandsPerFrame.length; f++) {
      if (this.frameMs[f] < ABS_GATE || this.frameMs[f] < relGate) continue
      for (let b = 0; b < NUM_BANDS; b++) acc[b] += this.bandsPerFrame[f][b]
      used++
    }
    const levelDb: number[] = []
    for (let b = 0; b < NUM_BANDS; b++) levelDb.push(used > 0 ? toDb(acc[b] / used) : -200)
    return {
      levelDb,
      usedFrames: used,
      totalFrames: this.bandsPerFrame.length,
      gatedOut: this.bandsPerFrame.length - used,
      seconds: this.written / this.sampleRate
    }
  }
}

/** Interleaved stereo, all at once. */
export function longTermSpectrumInterleaved(audio: Float32Array, sampleRate: number, opts?: SpectrumOptions): LongTermSpectrum {
  const frames = Math.floor(audio.length / 2)
  const acc = new SpectrumAccumulator(sampleRate, frames, opts)
  acc.pushInterleaved(audio, frames)
  return acc.finish()
}

/** Planar channels (a decoded file): mono uses the same channel twice. */
export function longTermSpectrumPlanar(channels: Float32Array[], sampleRate: number, opts?: SpectrumOptions): LongTermSpectrum {
  const l = channels[0]
  const r = channels[1] ?? channels[0]
  const frames = Math.min(l.length, r.length)
  const acc = new SpectrumAccumulator(sampleRate, frames, opts)
  acc.pushPlanar(l, r, frames)
  return acc.finish()
}

// ---- shape, targets ----------------------------------------------------------------------------

/** Level minus its mean over the core bands: the balance without the loudness. */
export function toShape(levelDb: readonly number[]): number[] {
  let sum = 0
  for (let i = CORE_FIRST; i <= CORE_LAST; i++) sum += levelDb[i]
  const mean = sum / (CORE_LAST - CORE_FIRST + 1)
  return levelDb.map((v) => v - mean)
}

/** Octave anchors of a genre curve: 31.5, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k (dB, relative; made zero-mean). */
const ANCHOR_HZ = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export interface Genre {
  id: string
  /** Shown in the dialog. */
  label: string
  /** What the AI is told. */
  name: string
  anchors: number[]
}

/**
 * Typical long-term balance per genre — a starting point, not a measurement of any product. They are the usual
 * textbook shapes (a gentle downward tilt, more or less sub / low-mid / presence / air by genre). A reference song
 * is the accurate target; these are for when there is none.
 */
export const GENRES: readonly Genre[] = [
  { id: 'pop', label: 'ポップ', name: 'pop', anchors: [-5, 1, 1.5, 0, -1.5, -3, -4.5, -6.5, -9.5, -15] },
  { id: 'rock', label: 'ロック', name: 'rock', anchors: [-8, -1, 1, 0.5, -0.5, -2.5, -3.5, -5.5, -9, -15] },
  { id: 'metal', label: 'メタル', name: 'metal', anchors: [-7, 0, 1, 0, 0, -1.5, -2, -4, -7, -13] },
  { id: 'edm', label: 'EDM / ダンス', name: 'EDM / dance', anchors: [0, 3, 2, -0.5, -2.5, -4, -5.5, -7, -9.5, -14] },
  { id: 'hiphop', label: 'ヒップホップ', name: 'hip-hop', anchors: [-1, 3.5, 2, -0.5, -2.5, -4, -5.5, -7.5, -10.5, -16] },
  { id: 'rnb', label: 'R&B / ソウル', name: 'R&B / soul', anchors: [-3, 2.5, 2, 0, -1.5, -3, -4.5, -7, -10, -16] },
  { id: 'jazz', label: 'ジャズ', name: 'jazz', anchors: [-9, -2, 0.5, 0.5, -0.5, -2.5, -4.5, -7, -11, -18] },
  { id: 'acoustic', label: 'アコースティック / フォーク', name: 'acoustic / folk', anchors: [-9, -2, 0.5, 0.5, -0.5, -2.5, -4, -6, -9.5, -16] },
  { id: 'classical', label: 'クラシック', name: 'classical', anchors: [-12, -4, -0.5, 0.5, -0.5, -3, -5.5, -8.5, -13, -20] }
]

/** A genre curve on the 28 bands (linear in log frequency between anchors), zero-mean over the core. */
export function genreShape(g: Genre): number[] {
  const out: number[] = []
  for (const c of BAND_CENTERS) {
    const x = Math.log2(c / ANCHOR_HZ[0])
    const i = Math.min(ANCHOR_HZ.length - 2, Math.max(0, Math.floor(x)))
    const t = x - i
    out.push(g.anchors[i] * (1 - t) + g.anchors[i + 1] * t)
  }
  return toShape(out)
}

/**
 * Allowed deviation per band: tighter in the core, looser at the extremes where songs differ most (and the lowest
 * band, which holds only one or two analysis bins).
 */
export function toleranceDb(): number[] {
  return BAND_CENTERS.map((_, i) => (i >= CORE_FIRST && i <= CORE_LAST ? 2 : i === 0 ? 5 : 3))
}

/**
 * A band's deviation blended with its neighbours (1-2-1). A mix is judged on stretches of the spectrum, not on a
 * single third-octave ripple: this keeps one jagged band from being "fixed" with a narrow cut that is only noise.
 */
export function smoothAcrossBands(v: readonly number[]): number[] {
  return v.map((x, i) => {
    const l = i > 0 ? v[i - 1] : undefined
    const r = i < v.length - 1 ? v[i + 1] : undefined
    let sum = 2 * x
    let w = 2
    if (l !== undefined) {
      sum += l
      w += 1
    }
    if (r !== undefined) {
      sum += r
      w += 1
    }
    return sum / w
  })
}

export interface Target {
  /** 'genre:<id>' or 'reference'. */
  id: string
  name: string
  shape: number[]
}

export const targetFromGenre = (id: string): Target | null => {
  const g = GENRES.find((x) => x.id === id)
  return g ? { id: `genre:${g.id}`, name: g.name, shape: genreShape(g) } : null
}

/** A reference song's own average spectrum as the target (its shape; its loudness does not matter). */
export const targetFromSpectrum = (name: string, levelDb: readonly number[]): Target => ({ id: 'reference', name, shape: toShape(levelDb) })

// ---- the difference ----------------------------------------------------------------------------

export interface EqFix {
  kind: 'lowshelf' | 'peak' | 'highshelf'
  freq: number
  gainDb: number
  q: number
}

export interface Region {
  fromHz: number
  toHz: number
  centerHz: number
  /** Mean / largest deviation inside the region (measured - target, dB). */
  meanDb: number
  peakDb: number
  verdict: 'too much' | 'too little'
  /** Band indices. */
  bands: number[]
  /** A single EQ move that would bring the region about `amount` of the way to the target. */
  fix: EqFix
}

export const REGION_GAIN_LIMIT_DB = 6

/** Contiguous bands (same sign) that are outside their tolerance. */
export function findRegions(deviation: readonly number[], tolerance: readonly number[], amount = 0.7): Region[] {
  const out: Region[] = []
  let i = 0
  while (i < deviation.length) {
    const d = deviation[i]
    if (Math.abs(d) <= tolerance[i]) {
      i++
      continue
    }
    const sign = Math.sign(d)
    const bands = [i]
    let j = i + 1
    while (j < deviation.length && Math.sign(deviation[j]) === sign && Math.abs(deviation[j]) > tolerance[j]) bands.push(j++)
    i = j
    const devs = bands.map((b) => deviation[b])
    const mean = devs.reduce((a, b) => a + b, 0) / devs.length
    const peak = devs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
    const fromHz = bandLow(bands[0])
    const toHz = bandHigh(bands[bands.length - 1])
    // centre: weighted by how far out each band is
    let wsum = 0
    let lsum = 0
    for (const b of bands) {
      const w = Math.abs(deviation[b])
      wsum += w
      lsum += w * Math.log2(BAND_CENTERS[b])
    }
    const centerHz = Math.pow(2, lsum / wsum)
    out.push({
      fromHz: round(fromHz, 1),
      toHz: round(toHz, 1),
      centerHz: round(centerHz, 1),
      meanDb: round(mean, 0.1),
      peakDb: round(peak, 0.1),
      verdict: mean > 0 ? 'too much' : 'too little',
      bands,
      fix: suggestFix(bands, mean, peak, amount)
    })
  }
  return out
}

/** The EQ move for one region: a shelf when it reaches an end of the range, otherwise a peak sized to its width. */
export function suggestFix(bands: readonly number[], meanDb: number, peakDb: number, amount = 0.7): EqFix {
  const lo = bands[0]
  const hi = bands[bands.length - 1]
  const raw = -amount * 0.5 * (meanDb + peakDb)
  const gainDb = round(Math.max(-REGION_GAIN_LIMIT_DB, Math.min(REGION_GAIN_LIMIT_DB, raw)), 0.5)
  const wide = bands.length >= 2
  if (lo === 0 && wide) return { kind: 'lowshelf', freq: round(bandHigh(hi), 1), gainDb, q: 0.7 }
  if (hi === NUM_BANDS - 1 && wide) return { kind: 'highshelf', freq: round(bandLow(lo), 1), gainDb, q: 0.7 }
  const from = bandLow(lo)
  const to = bandHigh(hi)
  const centre = Math.sqrt(from * to)
  const q = Math.max(0.6, Math.min(3, centre / (to - from)))
  return { kind: 'peak', freq: round(centre, 1), gainDb, q: round(q, 0.1) }
}

/**
 * The gain a stem alone would need so the mix changes by `-deviationDb` in a region, given the stem's share of the
 * energy there (0..1, power): share*g + (1-share) = 10^(-dev/10). null = the stem hardly contributes; a value that
 * cannot be reached (even silencing the stem is not enough) comes back as the limit.
 */
export function neededStemGainDb(deviationDb: number, share: number, limitDb = 9): number | null {
  if (!(share >= 0.05)) return null
  const want = Math.pow(10, -deviationDb / 10)
  const g = (want - (1 - share)) / share
  if (g <= 0) return -limitDb
  return round(Math.max(-limitDb, Math.min(limitDb, 10 * Math.log10(g))), 0.5)
}

// ---- the report the AI reads -------------------------------------------------------------------

/** One part of the mix measured on its own (a group channel, a stem, or the tracks that belong to neither). */
export interface BucketLevels {
  name: string
  /** What an EQ move on this part is applied to. */
  owner: { kind: 'group'; id: number } | { kind: 'stem'; tracks: number[] } | { kind: 'other'; tracks: number[] }
  levelDb: number[]
}

export interface RegionCulprit {
  name: string
  owner: BucketLevels['owner']
  /** Its share of the energy in this region, in dB under the sum of all parts (0 = it is everything). */
  shareDb: number
  /** The gain an EQ band on this part would need at the region's centre to fix the region alone (null = too small a share). */
  gainDb: number | null
}

export interface ReportRegion extends Omit<Region, 'bands'> {
  parts?: RegionCulprit[]
}

export interface AnalysisReport {
  target: { id: string; name: string }
  seconds: number
  analyzedFrames: number
  bandsHz: number[]
  measuredDb: number[]
  targetDb: number[]
  deviationDb: number[]
  toleranceDb: number[]
  score: { rmsDb: number; withinTolerancePct: number; worst: { hz: number; db: number } }
  summary: 'on target' | 'close' | 'off target'
  regions: ReportRegion[]
}

const r1 = (xs: readonly number[]): number[] => xs.map((x) => round(x, 0.1))

export function buildReport(measured: LongTermSpectrum, target: Target, parts?: BucketLevels[]): AnalysisReport {
  const shape = toShape(measured.levelDb)
  const tol = toleranceDb()
  const dev = shape.map((v, i) => v - target.shape[i])
  let sq = 0
  let within = 0
  let worst = 0
  for (let i = 0; i < NUM_BANDS; i++) {
    sq += dev[i] * dev[i]
    if (Math.abs(dev[i]) <= tol[i]) within++
    if (Math.abs(dev[i]) > Math.abs(dev[worst])) worst = i
  }
  const rms = Math.sqrt(sq / NUM_BANDS)
  const pct = Math.round((100 * within) / NUM_BANDS)
  // regions are judged on the smoothed deviation: single-band ripples are not worth an EQ move
  const regions = findRegions(smoothAcrossBands(dev), tol)
  const reportRegions: ReportRegion[] = regions.map(({ bands, ...r }) => {
    if (!parts || parts.length === 0) return r
    // each part's share of the energy in this region, against the sum of all the parts
    const energy = (levels: readonly number[]): number => bands.reduce((a, b) => a + Math.pow(10, levels[b] / 10), 0)
    const total = parts.reduce((a, p) => a + energy(p.levelDb), 0)
    const culprits: RegionCulprit[] = parts
      .map((p) => {
        const share = total > 0 ? energy(p.levelDb) / total : 0
        return {
          name: p.name,
          owner: p.owner,
          shareDb: round(toDb(share), 0.1),
          gainDb: neededStemGainDb(r.meanDb, share),
          share
        }
      })
      .sort((a, b) => b.share - a.share)
      .slice(0, 4)
      .map(({ share: _share, ...c }) => c)
    return { ...r, parts: culprits }
  })
  const summary = rms <= 1.5 && pct >= 85 ? 'on target' : rms <= 3 ? 'close' : 'off target'
  return {
    target: { id: target.id, name: target.name },
    seconds: round(measured.seconds, 0.1),
    analyzedFrames: measured.usedFrames,
    bandsHz: [...BAND_CENTERS],
    measuredDb: r1(shape),
    targetDb: r1(target.shape),
    deviationDb: r1(dev),
    toleranceDb: tol,
    score: { rmsDb: round(rms, 0.1), withinTolerancePct: pct, worst: { hz: BAND_CENTERS[worst], db: round(dev[worst], 0.1) } },
    summary,
    regions: reportRegions
  }
}

// ---- applying a correction to a 5-band EQ ------------------------------------------------------

export interface EqBandState {
  freq: number
  gainDb: number
  q: number
}

export const EQ_GAIN_LIMIT_DB = 12
/** The master EQ is a finishing touch: one band never goes further than this. */
export const MASTER_EQ_LIMIT_DB = 3

/**
 * Which of the 5 fixed bands (low shelf, 3 peaks, high shelf) takes a correction, and what it becomes. The gain is
 * ADDED to what the band already has (a correction is incremental: measure, correct, measure again). A peak goes to
 * a band that is already working within half an octave, else to a free band (0 dB), else to the nearest one.
 */
export function planEqBand(
  bands: readonly EqBandState[],
  fix: EqFix,
  /** Total a band may reach (default ±12 dB; the master EQ is held to a few dB). */
  limitDb = EQ_GAIN_LIMIT_DB
): { index: number; band: EqBandState; limited: boolean } {
  const oct = (hz: number): number => Math.log2(Math.max(1, hz))
  let index: number
  if (fix.kind === 'lowshelf') index = 0
  else if (fix.kind === 'highshelf') index = 4
  else {
    const peaks = [1, 2, 3]
    const active = peaks
      .filter((i) => bands[i].gainDb !== 0 && Math.abs(oct(bands[i].freq) - oct(fix.freq)) <= 0.5)
      .sort((a, b) => Math.abs(oct(bands[a].freq) - oct(fix.freq)) - Math.abs(oct(bands[b].freq) - oct(fix.freq)))
    const free = peaks.filter((i) => bands[i].gainDb === 0).sort((a, b) => Math.abs(oct(bands[a].freq) - oct(fix.freq)) - Math.abs(oct(bands[b].freq) - oct(fix.freq)))
    const nearest = [...peaks].sort((a, b) => Math.abs(oct(bands[a].freq) - oct(fix.freq)) - Math.abs(oct(bands[b].freq) - oct(fix.freq)))
    index = active[0] ?? free[0] ?? nearest[0]
  }
  const cur = bands[index]
  const inUse = cur.gainDb !== 0
  const wanted = cur.gainDb + fix.gainDb
  const gainDb = round(Math.max(-limitDb, Math.min(limitDb, wanted)), 0.1)
  return {
    index,
    limited: Math.abs(wanted) > limitDb + 1e-9,
    // a band that is already doing a job keeps its place and width; a free one is set up for this correction
    band: inUse ? { freq: cur.freq, gainDb, q: cur.q } : { freq: Math.max(20, Math.min(20000, fix.freq)), gainDb, q: Math.max(0.3, Math.min(8, fix.q)) }
  }
}
