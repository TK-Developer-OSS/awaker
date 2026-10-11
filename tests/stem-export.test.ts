// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import {
  DEFAULT_STEM_EXPORT,
  cleanStemName,
  groupStems,
  nullTest,
  resampleInterleaved,
  safeFilePart,
  sanitizeStemExport,
  stemFileName
} from '../src/renderer/src/audio/stem-export'
import { decodeWav, encodeWavPcm } from '../src/renderer/src/wav'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

// ---- settings: Cubase-like defaults, junk falls back
check('defaults: 24-bit, project rate, strip + inserts through, master chain out, no tail',
  DEFAULT_STEM_EXPORT.bitDepth === 24 && DEFAULT_STEM_EXPORT.sampleRate === 0 && DEFAULT_STEM_EXPORT.process === 'full' && DEFAULT_STEM_EXPORT.masterChain === false && DEFAULT_STEM_EXPORT.tailSeconds === 0)
const s1 = sanitizeStemExport({ bitDepth: 16, sampleRate: 48000, process: 'dry', masterChain: true, tailSeconds: 3 })
check('settings are accepted', s1.bitDepth === 16 && s1.sampleRate === 48000 && s1.process === 'dry' && s1.masterChain === true && s1.tailSeconds === 3)
const s2 = sanitizeStemExport({ bitDepth: 20, sampleRate: 12345, process: 'x', masterChain: 'yes', tailSeconds: -5 })
check('junk falls back field by field', s2.bitDepth === 24 && s2.sampleRate === 0 && s2.process === 'full' && s2.masterChain === false && s2.tailSeconds === 0)
check('tail is capped', sanitizeStemExport({ tailSeconds: 9999 }).tailSeconds === 60)
check('a non-object gives the defaults', JSON.stringify(sanitizeStemExport(42)) === JSON.stringify(DEFAULT_STEM_EXPORT))

// ---- grouping + names
const tracks = [
  { id: 1, title: 'Kick', stem: 'Drums' },
  { id: 2, title: 'Snare', stem: 'Drums' },
  { id: 3, title: 'Bass', stem: 'Bass' },
  { id: 4, title: 'Click', stem: '' },
  { id: 5, title: 'Hat', stem: ' Drums ' }
]
const g = groupStems(tracks)
check('stems in first-seen order, trimmed, unassigned tracks left out', g.length === 2 && g[0].name === 'Drums' && g[0].trackIds.join() === '1,2,5' && g[1].name === 'Bass' && g[1].trackIds.join() === '3')
check('stem names are one bounded line', cleanStemName('  Dr\nums  ') === 'Dr ums' && cleanStemName('x'.repeat(100)).length === 40 && cleanStemName(5) === '')
check('file parts are safe', safeFilePart('a/b\\c:d*e?') === 'a_b_c_d_e_' && safeFilePart('..hidden') === 'hidden' && safeFilePart('') === 'stem')
const used = new Set<string>()
const f1 = stemFileName('My Song', 'Drums', 48000, 24, used)
const f2 = stemFileName('My Song', 'drums', 48000, 24, used)
check('file name carries project, stem, rate, depth', f1 === 'My Song_Drums_48k_24.wav')
check('a clashing name gets a suffix (case-insensitive)', f2 === 'My Song_drums_48k_24_2.wav')
check('float depth is named 32f', stemFileName('p', 's', 96000, 32, new Set()) === 'p_s_96k_32f.wav')

// ---- PCM encoder
const sig = new Float32Array(2 * 64)
for (let i = 0; i < 64; i++) { sig[i * 2] = Math.sin(i / 5) * 0.8; sig[i * 2 + 1] = -Math.sin(i / 7) * 0.5 }
const w24 = encodeWavPcm(sig, 2, 48000, 24)
const d24 = decodeWav(w24.bytes)
let e24 = 0
for (let i = 0; i < 64; i++) e24 = Math.max(e24, Math.abs(d24.channels[0][i] - sig[i * 2]), Math.abs(d24.channels[1][i] - sig[i * 2 + 1]))
check('24-bit: header says PCM, 48 kHz, 2 ch, 24 bit', d24.sampleRate === 48000 && d24.channels.length === 2 && new DataView(w24.bytes).getUint16(34, true) === 24 && new DataView(w24.bytes).getUint16(20, true) === 1)
check('24-bit: round trip within one 24-bit step', e24 <= 1 / 8388607, String(e24))
check('24-bit: file size = 44 + frames*2*3', w24.bytes.byteLength === 44 + 64 * 2 * 3)
const w32 = encodeWavPcm(sig, 2, 96000, 32)
const d32 = decodeWav(w32.bytes)
check('32-bit float: exact round trip', d32.channels[0][10] === sig[20] && d32.channels[1][10] === sig[21] && new DataView(w32.bytes).getUint16(20, true) === 3)
const hot = new Float32Array([1.5, -1.5, 0.25, 0])
const wh = encodeWavPcm(hot, 2, 48000, 24)
check('24-bit: over-range samples are clamped and counted', wh.clamped === 2 && decodeWav(wh.bytes).channels[0][0] > 0.9999)
const w16a = encodeWavPcm(sig, 2, 44100, 16)
const w16b = encodeWavPcm(sig, 2, 44100, 16)
check('16-bit: dithered but deterministic', new Uint8Array(w16a.bytes).every((b, i) => b === new Uint8Array(w16b.bytes)[i]))
let e16 = 0
const d16 = decodeWav(w16a.bytes)
for (let i = 0; i < 64; i++) e16 = Math.max(e16, Math.abs(d16.channels[0][i] - sig[i * 2]))
check('16-bit: error within about two LSB (TPDF)', e16 < 3 / 32768, String(e16))

// ---- resampler
function sine(frames: number, rate: number, hz: number, amp = 0.5): Float32Array {
  const o = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) { const v = amp * Math.sin((2 * Math.PI * hz * i) / rate); o[i * 2] = v; o[i * 2 + 1] = -v }
  return o
}
function rmsErr(a: Float32Array, rate: number, hz: number, amp: number, skip: number): number {
  let e = 0, n = 0
  for (let j = skip; j < a.length / 2 - skip; j++) {
    const ref = amp * Math.sin((2 * Math.PI * hz * j) / rate)
    e += (a[j * 2] - ref) ** 2
    n++
  }
  return Math.sqrt(e / n)
}
const src96 = sine(9600, 96000, 1000)
const d48 = resampleInterleaved(src96, 2, 96000, 48000)
check('96k -> 48k: half the frames', d48.length / 2 === 4800)
check('96k -> 48k: a 1 kHz tone survives (error below -100 dB)', rmsErr(d48, 48000, 1000, 0.5, 100) < 3e-6, String(rmsErr(d48, 48000, 1000, 0.5, 100)))
const d441 = resampleInterleaved(src96, 2, 96000, 44100)
check('96k -> 44.1k: length is round(frames * ratio)', d441.length / 2 === Math.round(9600 * 44100 / 96000))
check('96k -> 44.1k (interpolated phases): error below -100 dB', rmsErr(d441, 44100, 1000, 0.5, 100) < 3e-6, String(rmsErr(d441, 44100, 1000, 0.5, 100)))
const hi = resampleInterleaved(sine(9600, 96000, 30000), 2, 96000, 48000)
let hiMax = 0
for (let j = 200; j < 4600; j++) hiMax = Math.max(hiMax, Math.abs(hi[j * 2]))
check('96k -> 48k: a 30 kHz tone (above the new Nyquist) is removed', hiMax < 0.01, String(hiMax))
check('same rate returns the input untouched', resampleInterleaved(src96, 2, 96000, 96000) === src96)

// ---- null test
const ref = sine(1000, 48000, 440)
const sum = Float32Array.from(ref, (x) => x + 1e-7)
const nt = nullTest(sum, ref)
check('null test: tiny difference is reported', nt.maxAbsDiff < 2e-7 && nt.snrDb > 100)
check('null test: identical = infinite SNR', nullTest(ref, ref).snrDb === Infinity)

if (fails) { console.log(`${fails} FAILED`); process.exit(1) }
console.log('ALL OK')
