// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import {
  BAND_CENTERS,
  CORE_FIRST,
  CORE_LAST,
  GENRES,
  NUM_BANDS,
  SpectrumAccumulator,
  MASTER_EQ_LIMIT_DB,
  planEqBand,
  smoothAcrossBands,
  type EqBandState,
  buildReport,
  findRegions,
  frameSizeFor,
  genreShape,
  longTermSpectrumInterleaved,
  longTermSpectrumPlanar,
  neededStemGainDb,
  suggestFix,
  targetFromGenre,
  targetFromSpectrum,
  toShape,
  toleranceDb
} from '../src/renderer/src/audio/spectrum'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

// deterministic noise
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function white(n: number, amp: number, seed: number): Float32Array {
  const r = rng(seed)
  const o = new Float32Array(n)
  for (let i = 0; i < n; i++) o[i] = (r() * 2 - 1) * amp
  return o
}
function pink(n: number, amp: number, seed: number): Float32Array {
  const r = rng(seed)
  const o = new Float32Array(n)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * amp
    b6 = w * 0.115926
  }
  return o
}
const interleave = (l: Float32Array, r: Float32Array): Float32Array => {
  const o = new Float32Array(l.length * 2)
  for (let i = 0; i < l.length; i++) {
    o[i * 2] = l[i]
    o[i * 2 + 1] = r[i]
  }
  return o
}
const SR = 48000

// ---- frame size
check('frame size: about 6 Hz resolution, power of two', frameSizeFor(48000) === 8192 && frameSizeFor(96000) === 16384 && frameSizeFor(44100) === 8192)

// ---- a tone lands in its band with the right level
{
  const n = SR * 6
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR)
  const sp = longTermSpectrumInterleaved(interleave(s, s), SR)
  const b = BAND_CENTERS.indexOf(1000)
  check('1 kHz sine 0.5 → band level -9.0 dB (mean square 0.125)', near(sp.levelDb[b], -9.03, 0.15), `${sp.levelDb[b].toFixed(2)}`)
  const others = sp.levelDb.filter((_, i) => Math.abs(i - b) > 2)
  check('everything two bands away is >40 dB lower', Math.max(...others) < sp.levelDb[b] - 40, `${Math.max(...others).toFixed(1)}`)
  // one channel only: the mean of the channels is 3 dB lower
  const z = new Float32Array(n)
  const one = longTermSpectrumInterleaved(interleave(s, z), SR)
  check('a tone in the left channel only is 3 dB under (channels are averaged)', near(one.levelDb[b], sp.levelDb[b] - 3.01, 0.1))
}

// ---- noise: pink is flat in 1/3-octave bands, white rises 3 dB/octave
{
  const n = SR * 20
  const p = pink(n, 0.5, 1)
  const sp = longTermSpectrumInterleaved(interleave(p, p), SR)
  const core = sp.levelDb.slice(CORE_FIRST, CORE_LAST + 1)
  const mean = core.reduce((a, b) => a + b, 0) / core.length
  const maxDev = Math.max(...core.map((v) => Math.abs(v - mean)))
  check('pink noise: 100 Hz – 8 kHz bands within ±1.5 dB of each other', maxDev < 1.5, `max dev ${maxDev.toFixed(2)} dB`)
  const w = white(n, 0.3, 2)
  const sw = longTermSpectrumInterleaved(interleave(w, w), SR)
  const lo = sw.levelDb[BAND_CENTERS.indexOf(250)]
  const hi = sw.levelDb[BAND_CENTERS.indexOf(4000)]
  check('white noise: +12 dB over 4 octaves (3 dB per octave in 1/3-octave bands)', near(hi - lo, 12.04, 1), `${(hi - lo).toFixed(2)}`)
  // the whole level: mean square of uniform noise amp 0.3 = 0.03; summed over the bands up to 16 kHz (of 24 kHz)
  const total = 10 * Math.log10(sw.levelDb.reduce((a, v) => a + Math.pow(10, v / 10), 0))
  check('white noise: band energies add up to the signal power (within the covered range)', near(total, 10 * Math.log10(0.03 * (17800 - 28) / 24000), 0.6), `${total.toFixed(2)}`)
}

// ---- the average of a long song is sampled, not walked frame by frame
{
  const n = SR * 40
  const p = pink(n, 0.4, 3)
  const x = interleave(p, p)
  const all = longTermSpectrumInterleaved(x, SR, { maxFrames: 100000 })
  const few = longTermSpectrumInterleaved(x, SR, { maxFrames: 60 })
  let worst = 0
  for (let i = CORE_FIRST; i <= CORE_LAST; i++) worst = Math.max(worst, Math.abs(all.levelDb[i] - few.levelDb[i]))
  check('60 frames give the same average as all of them (within 1 dB in the core)', worst < 1, `${worst.toFixed(2)} dB, ${few.totalFrames} vs ${all.totalFrames} frames`)
}

// ---- streaming = all at once, whatever the block size
{
  const n = SR * 5
  const x = interleave(pink(n, 0.4, 7), pink(n, 0.4, 8))
  const whole = longTermSpectrumInterleaved(x, SR)
  const acc = new SpectrumAccumulator(SR, n)
  for (let at = 0; at < n; ) {
    const c = Math.min(1237, n - at) // an awkward block size
    acc.pushInterleaved(x.subarray(at * 2, (at + c) * 2), c)
    at += c
  }
  const streamed = acc.finish()
  check('streamed in odd blocks = the same average as all at once', whole.levelDb.every((v, i) => near(v, streamed.levelDb[i], 1e-6)) && whole.usedFrames === streamed.usedFrames)
}

// ---- silence does not pull the average down
{
  const half = SR * 6
  const sig = pink(half, 0.4, 4)
  const padded = new Float32Array(half * 2)
  padded.set(sig, 0)
  const a = longTermSpectrumInterleaved(interleave(sig, sig), SR)
  const b = longTermSpectrumInterleaved(interleave(padded, padded), SR)
  let worst = 0
  for (let i = CORE_FIRST; i <= CORE_LAST; i++) worst = Math.max(worst, Math.abs(a.levelDb[i] - b.levelDb[i]))
  check('6 s of signal + 6 s of silence = the same levels as the signal alone', worst < 0.3, `${worst.toFixed(2)} dB`)
  check('the silent frames were gated out', b.gatedOut > 0 && b.usedFrames < b.totalFrames)
  const empty = longTermSpectrumInterleaved(new Float32Array(SR * 2), SR)
  check('a silent file has no level (not NaN)', empty.usedFrames === 0 && empty.levelDb.every((v) => v === -200))
}

// ---- planar == interleaved; mono works; short file works
{
  const p = pink(SR * 3, 0.4, 5)
  const a = longTermSpectrumInterleaved(interleave(p, p), SR)
  const b = longTermSpectrumPlanar([p, p], SR)
  const c = longTermSpectrumPlanar([p], SR)
  check('planar stereo = interleaved', a.levelDb.every((v, i) => near(v, b.levelDb[i], 1e-9)))
  check('mono file = the same signal on both channels', a.levelDb.every((v, i) => near(v, c.levelDb[i], 1e-9)))
  const tiny = longTermSpectrumPlanar([white(1000, 0.2, 6)], SR)
  check('a file shorter than one frame still gives a spectrum', tiny.totalFrames === 1 && Number.isFinite(tiny.levelDb[10]))
}

// ---- shape, genres, tolerance
{
  const s = toShape(BAND_CENTERS.map((_, i) => -20 + i))
  const core = s.slice(CORE_FIRST, CORE_LAST + 1)
  check('shape is zero-mean over the core bands', near(core.reduce((a, b) => a + b, 0), 0, 1e-9))
  check('every genre has 28 finite bands and a zero-mean core', GENRES.every((g) => {
    const sh = genreShape(g)
    return sh.length === NUM_BANDS && sh.every(Number.isFinite) && near(sh.slice(CORE_FIRST, CORE_LAST + 1).reduce((a, b) => a + b, 0), 0, 1e-9)
  }))
  check('genre ids are unique and the lookup finds them', new Set(GENRES.map((g) => g.id)).size === GENRES.length && GENRES.every((g) => targetFromGenre(g.id)?.name === g.name))
  check('unknown genre → null', targetFromGenre('polka') === null)
  const edm = genreShape(GENRES.find((g) => g.id === 'edm')!)
  const jazz = genreShape(GENRES.find((g) => g.id === 'jazz')!)
  const i63 = BAND_CENTERS.indexOf(63)
  check('EDM carries more low end than jazz (sanity of the table)', edm[i63] > jazz[i63] + 3)
  const tol = toleranceDb()
  check('tolerance: ±2 dB in the core, ±3 dB outside, ±5 dB at 31.5 Hz', tol[CORE_FIRST] === 2 && tol[CORE_LAST] === 2 && tol[1] === 3 && tol[NUM_BANDS - 1] === 3 && tol[0] === 5)
}

// ---- regions and the EQ move that goes with them
{
  const tol = toleranceDb()
  const dev = new Array<number>(NUM_BANDS).fill(0)
  for (const f of [63, 80, 100]) dev[BAND_CENTERS.indexOf(f)] = 5
  const r = findRegions(dev, tol)
  check('one region for three adjacent loud bands', r.length === 1 && r[0].verdict === 'too much' && r[0].bands.length === 3)
  check('the region spans their edges (whole Hz)', near(r[0].fromHz, 63 / Math.pow(2, 1 / 6), 1) && near(r[0].toHz, 100 * Math.pow(2, 1 / 6), 1))
  check('the fix cuts (negative gain) as a peak between 63 and 100 Hz', r[0].fix.kind === 'peak' && r[0].fix.gainDb < 0 && r[0].fix.freq > 60 && r[0].fix.freq < 105)
  check('the fix is partial: 70 % of 5 dB = 3.5 dB', near(r[0].fix.gainDb, -3.5, 0.01), `${r[0].fix.gainDb}`)

  const within = new Array<number>(NUM_BANDS).fill(1.5)
  check('inside the tolerance there is no region', findRegions(within, tol).length === 0)

  const lows = new Array<number>(NUM_BANDS).fill(0)
  lows[0] = -6
  lows[1] = -6
  lows[2] = -5
  const lo = findRegions(lows, tol)
  check('a shortage that reaches the bottom is a low shelf (boost)', lo.length === 1 && lo[0].fix.kind === 'lowshelf' && lo[0].fix.gainDb > 0 && lo[0].verdict === 'too little')

  const air = new Array<number>(NUM_BANDS).fill(0)
  air[NUM_BANDS - 1] = 7
  air[NUM_BANDS - 2] = 6
  const hi = findRegions(air, tol)
  check('an excess that reaches the top is a high shelf (cut)', hi.length === 1 && hi[0].fix.kind === 'highshelf' && hi[0].fix.gainDb < 0)

  const sign = new Array<number>(NUM_BANDS).fill(0)
  sign[8] = 4
  sign[9] = -4
  check('opposite signs next to each other are two regions', findRegions(sign, tol).length === 2)

  const big = suggestFix([8, 9], 20, 24)
  check('the move is limited to ±6 dB', big.gainDb === -6)
  const narrow = suggestFix([10], 4, 4)
  const wide = suggestFix([6, 7, 8, 9, 10, 11, 12], 4, 4)
  check('a narrow region gets a higher Q than a wide one', narrow.q > wide.q, `${narrow.q} vs ${wide.q}`)
}

// ---- a single jagged band is not worth an EQ move
{
  const flat = new Array<number>(NUM_BANDS).fill(0)
  const spike = [...flat]
  spike[BAND_CENTERS.indexOf(1000)] = 4
  const sm = smoothAcrossBands(spike)
  check('smoothing: a one-band spike is halved and shared with its neighbours', near(sm[BAND_CENTERS.indexOf(1000)], 2, 1e-9) && near(sm[BAND_CENTERS.indexOf(800)], 1, 1e-9))
  check('smoothing: a flat curve stays flat, an even shift stays', smoothAcrossBands(flat).every((v) => v === 0) && smoothAcrossBands(flat.map(() => 3)).every((v) => near(v, 3, 1e-9)))
  const target = targetFromGenre('pop')!
  const level = target.shape.map((v, i) => -30 + v + (i === BAND_CENTERS.indexOf(1000) ? 3.5 : 0))
  const rep = buildReport({ levelDb: level, usedFrames: 10, totalFrames: 10, gatedOut: 0, seconds: 30 }, target)
  check('report: a lone 3.5 dB band does not become a region', rep.regions.length === 0, JSON.stringify(rep.regions))
  check('report: ...but it is still visible in the deviation numbers', rep.deviationDb[BAND_CENTERS.indexOf(1000)] > 2.5)
}

// ---- how much a part has to move so the whole moves
{
  check('a part that is all of the energy: the gain is the correction itself', neededStemGainDb(3, 1) === -3)
  check('boost when the mix is short', neededStemGainDb(-3, 1) === 3)
  const half = neededStemGainDb(1, 0.5)
  // 0.5*g + 0.5 = 10^(-0.1) → g = 0.5887 → -2.3 dB
  check('half of the energy needs more than the whole mix would', half !== null && near(half, -2.3, 0.26), `${half}`)
  check('a part with a tiny share is not the one to touch', neededStemGainDb(3, 0.02) === null)
  check('when even silencing it is not enough, the limit comes back', neededStemGainDb(6, 0.3) === -9)
}

// ---- which EQ band takes a correction
{
  const flat = (): EqBandState[] => [
    { freq: 80, gainDb: 0, q: 0.7 },
    { freq: 250, gainDb: 0, q: 1 },
    { freq: 1000, gainDb: 0, q: 1 },
    { freq: 4000, gainDb: 0, q: 1 },
    { freq: 12000, gainDb: 0, q: 0.7 }
  ]
  const lowShelf = planEqBand(flat(), { kind: 'lowshelf', freq: 90, gainDb: -3, q: 0.7 })
  check('low shelf = band 0, high shelf = band 4', lowShelf.index === 0 && lowShelf.band.gainDb === -3 && planEqBand(flat(), { kind: 'highshelf', freq: 9000, gainDb: 2, q: 0.7 }).index === 4)
  const p1 = planEqBand(flat(), { kind: 'peak', freq: 300, gainDb: -2, q: 1.2 })
  check('a peak goes to the free band nearest in frequency, set up for it', p1.index === 1 && p1.band.freq === 300 && p1.band.q === 1.2 && p1.band.gainDb === -2, JSON.stringify(p1))

  const bands = flat()
  bands[1] = { freq: 300, gainDb: -2, q: 1.2 }
  const again = planEqBand(bands, { kind: 'peak', freq: 330, gainDb: -1.5, q: 2 })
  check('a second correction near the same place ADDS to that band and keeps its place and width', again.index === 1 && again.band.gainDb === -3.5 && again.band.freq === 300 && again.band.q === 1.2, JSON.stringify(again))

  const far = planEqBand(bands, { kind: 'peak', freq: 3000, gainDb: 2, q: 1 })
  check('a peak elsewhere takes another free band, not the busy one', far.index === 3 || far.index === 2, JSON.stringify(far))

  const busy = flat()
  busy[1] = { freq: 200, gainDb: -1, q: 1 }
  busy[2] = { freq: 1000, gainDb: 1, q: 1 }
  busy[3] = { freq: 5000, gainDb: 1, q: 1 }
  const crowded = planEqBand(busy, { kind: 'peak', freq: 2000, gainDb: 1, q: 1 })
  check('all three peaks busy: the nearest one takes it (added)', (crowded.index === 2 || crowded.index === 3) && crowded.band.gainDb === 2, JSON.stringify(crowded))

  const edge = flat()
  edge[0] = { freq: 80, gainDb: -11, q: 0.7 }
  check('the total stays within ±12 dB', planEqBand(edge, { kind: 'lowshelf', freq: 80, gainDb: -6, q: 0.7 }).band.gainDb === -12)
  const mst = planEqBand(flat(), { kind: 'peak', freq: 300, gainDb: -6, q: 1 }, MASTER_EQ_LIMIT_DB)
  check('the master EQ is held to a few dB, and says so', mst.band.gainDb === -3 && mst.limited === true && planEqBand(flat(), { kind: 'peak', freq: 300, gainDb: -2, q: 1 }, MASTER_EQ_LIMIT_DB).limited === false)
  check('a free band is never set outside 20 Hz – 20 kHz / sane Q', (() => {
    const r = planEqBand(flat(), { kind: 'peak', freq: 5, gainDb: 1, q: 99 })
    return r.band.freq === 20 && r.band.q === 8
  })())
}

// ---- the whole report
{
  const target = targetFromGenre('pop')!
  // a song that is the pop shape plus 5 dB at 63 – 100 Hz
  const level = target.shape.map((v, i) => -30 + v + ([3, 4, 5].includes(i) ? 5 : 0))
  const measured = { levelDb: level, usedFrames: 100, totalFrames: 100, gatedOut: 0, seconds: 200 }
  const rep = buildReport(measured, target)
  check('report: one region, too much, around 63 – 100 Hz', rep.regions.length === 1 && rep.regions[0].verdict === 'too much' && rep.regions[0].centerHz > 55 && rep.regions[0].centerHz < 110, JSON.stringify(rep.regions[0]))
  check('report: a mix that matches the target says so', buildReport({ ...measured, levelDb: target.shape.map((v) => v - 25) }, target).summary === 'on target')
  check('report: this one is off', rep.summary !== 'on target' && rep.score.withinTolerancePct < 100 && rep.score.worst.db > 3)
  check('report: all arrays have one value per band', rep.measuredDb.length === NUM_BANDS && rep.deviationDb.length === NUM_BANDS && rep.targetDb.length === NUM_BANDS)

  // which part to touch: Bass carries the low end, Vocals the mids
  const bass = target.shape.map((_, i) => (i <= 10 ? -22 : -50))
  const vox = target.shape.map((_, i) => (i > 10 ? -24 : -45))
  const withParts = buildReport(measured, target, [
    { name: 'Vocals', owner: { kind: 'group', id: 1001 }, levelDb: vox },
    { name: 'Bass', owner: { kind: 'stem', tracks: [12] }, levelDb: bass }
  ])
  const p = withParts.regions[0].parts!
  check('parts: the bass is ranked first for the low-end excess', p[0].name === 'Bass' && p[0].shareDb > -1, JSON.stringify(p))
  check('parts: its gain is a cut', (p[0].gainDb ?? 0) < 0)
  check('parts: the vocal has a negligible share there (null gain)', p[1].gainDb === null)

  // a reference song: its own average becomes the target (loudness does not matter)
  const ref = targetFromSpectrum('Song A', level.map((v) => v + 17))
  const same = buildReport(measured, ref)
  check('reference: the same song against itself is on target at any loudness', same.summary === 'on target' && same.score.rmsDb === 0)
}

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
