// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { initGpu } from './gpu/device'
import { isSoftwareAdapter, type AdapterInfoLike } from './gpu/software-adapter'
import { GpuTrack } from './gpu/track'
import { WaveformRenderer, type PeakClip } from './gpu/waveform-renderer'
import { PlaybackScheduler } from './audio/scheduler'
import { LiveBus, LIVE_BLOCK, setLiveBlock, type LiveLane } from './audio/live-bus'
import { initOptions } from './ui/options'
import { initAddTrack } from './ui/add-track'
import { fmtFaderDb } from './ui/fader-text'
import { ensureMcpLamp } from './ui/mcp-guard'
import type { Take } from './audio/recorder'
import { registerMcpTools, type McpLane } from './mcp-tools'
import type { MixGroup, MixSource, LaneClip } from './gpu/master-bus'
import { ChannelStrip, defaultStripParams } from './gpu/channel-strip'
import {
  type AudioSource,
  type Clip,
  type FadeShape,
  FADE_SHAPE_CODE,
  makeClip,
  clipEnd,
  laneEnd,
  snapFrame,
  splitClip,
  trimClipLeft,
  trimClipRight,
  clampFades,
  registerSource,
  getSource,
  sourceList,
  retainSource,
  releaseSource,
  clearSourceRegistry
} from './edit/model'
import type { EditTool } from './state'
import type { Insert } from './gpu/insert'
import { ReverbInsert } from './gpu/effects/reverb'
import { DelayInsert } from './gpu/effects/delay'
import { Eq5Insert, type Eq5Band } from './gpu/effects/eq5'
import {
  TubeEqInsert,
  TUBEEQ_LOW_FREQS,
  TUBEEQ_HI_BOOST_FREQS,
  TUBEEQ_HI_ATTEN_FREQS
} from './gpu/effects/tubeeq'
import { AwakerInsert } from './gpu/effects/awaker'
import { BusCompInsert, BUSCOMP_RATIOS, BUSCOMP_ATTACKS_MS, BUSCOMP_RELEASES_MS } from './gpu/effects/buscomp'
import { MaximizerInsert } from './gpu/effects/maximizer'
import { McuSurface } from './control/mcu'
import { decodeWav, encodeWavFloat32, encodeWavPcm } from './wav'
import { moveSlot } from './audio/slot-move'
import { cleanStemName, groupStems, nullTest, resampleInterleaved, sanitizeStemExport, stemFileName, type StemExportSettings, type StemGroup } from './audio/stem-export'
import { getStemDefaults } from './ui/export-options'
import { SpectrumAccumulator, buildReport, type BucketLevels } from './audio/spectrum'
import { getMixTarget } from './audio/mix-target'
import { LevelMeter, suggestTrimDb } from './audio/levels'
import { askMixdownFormat } from './ui/mixdown-dialog'
import { TRACK_PALETTE, alignStemColors, lanePaint, normalizeColor, paletteColor, pickUnusedColor, pruneStemColors } from './ui/track-color'
import { parseDawproject } from './project/dawproject-import'
import {
  buildDawprojectXml,
  buildMetadataXml,
  type ExpAudioSource,
  type ExpTrack
} from './project/dawproject-export'
import {
  midiTracks,
  serializeMidi,
  restoreMidi,
  clearMidi,
  addMidiTrack,
  addMidiClip,
  addNote,
  onMidiChange,
  beatsToFrames,
  type MidiTrack,
  type SzMidiTrack
} from './midi/model'
import { makeInstrument, listInstruments, instrumentLabel, normalizeInstrumentKind, type InstrumentNote } from './gpu/instrument'
import { parseSmf, writeSmf } from './midi/smf'
import { createPianoRoll, type PianoRollApi } from './midi/piano-roll'
import { createStepGrid, type StepGridApi } from './midi/step-grid'
import { PRESETS, presetNotes } from './midi/step-logic'
import { DRUM_LANES, defaultDrumParams, type DrumParams } from './gpu/instruments/drums'
import { fmPreset, type FmParams } from './gpu/instruments/fm'
import { FM_PRESET_NAMES } from './gpu/instruments/fm-presets'
// EarlySynth: the frozen, independent copy of the first FM synth (own code, own shader)
import { earlyPreset } from './gpu/instruments/earlysynth/earlysynth'
import { EARLY_PRESET_NAMES } from './gpu/instruments/earlysynth/presets'
import './gpu/instruments/external' // registers the "none" instrument (external MIDI only)
import { MidiIo } from './midi/io'
import { defaultSynthParams, type SynthParams, type SynthWave } from './gpu/instruments/synth'
import { state, update, subscribe, type DawState } from './state'

// Route otherwise-swallowed failures (e.g. `void scheduler.start()` rejecting on
// a GPU pipeline error) to console.error so the main-process mirror shows them.
window.addEventListener('unhandledrejection', (e) =>
  console.error('[unhandledrejection]', (e.reason as Error)?.stack ?? e.reason)
)

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const gpuStatus = $('gpu-status')
const gpuLamp = $('gpu-lamp')
/**
 * The GPU lamp: green when WebGPU is up on a real GPU, dark ("off") when it runs in software (SwiftShader / WARP:
 * it works, but on the CPU), red when it failed or the render loop stopped; `title` has the details.
 */
const setGpuLamp = (state: 'ok' | 'off' | 'err', detail: string): void => {
  gpuLamp.className = `lamp ${state}`
  gpuLamp.title = detail
}
const clock = $('clock')
const clockBars = $('clock-bars')
const metricsEl = $('metrics')
const hint = $('hint')
const playBtn = $<HTMLButtonElement>('play')
const recBtn = $<HTMLButtonElement>('rec')
const srSelect = $<HTMLSelectElement>('sr')
const tracksEl = $('tracks')
const tracksScroll = $('tracks-scroll')
const playhead = $('playhead')
const gridEl = $('grid')
const rulerCanvas = $<HTMLCanvasElement>('ruler-canvas')
const rulerCtx = rulerCanvas.getContext('2d') as CanvasRenderingContext2D
const rulerTc = $('ruler-tc')
const stripsEl = $('strips')
const stripsScrollEl = $('strips-scroll')
const masterDbEl = $('master-db')
const masterPeakEl = $('master-peak')
const masterLufsEl = $('master-lufs')
const masterStripEl = $('master-strip')
const masterVuEl = document.querySelector('#master-strip .strip-vu > i') as HTMLElement

// Must match the CSS layout metrics in index.html (--lane-left / --lane-right).
const LANE_LEFT = 160
const LANE_RIGHT = 120
/** Meter envelope resolution: one peak value per this many seconds. */
const ENV_WINDOW_S = 0.02

interface LaneMix {
  gainDb: number
  pan: number // -1..+1
  mute: boolean
  solo: boolean
  rec: boolean
}

interface Strip {
  el: HTMLElement
  /** Classic insert-slot rack container (8 slots). */
  rackEl: HTMLElement
  fader: HTMLInputElement
  knobInd: HTMLElement // rotary pan indicator
  vu: HTMLElement // inner <i>
  db: HTMLElement
  peak: HTMLElement
  m: HTMLButtonElement
  s: HTMLButtonElement
  r: HTMLButtonElement
  /** Push a dB value into the strip fader + cap (used to mirror the detail pane). */
  setGain: (db: number) => void
  /** Push a pan value into the strip rotary indicator. */
  setPan: (pan: number) => void
}

/** One track = a lane of placed clips + its DOM lane + waveform renderer + channel strip. */
interface Lane {
  id: number
  /** Placed clips on this lane's timeline (each references an AudioSource). */
  clips: Clip[]
  renderer: WaveformRenderer
  el: HTMLElement
  canvas: HTMLCanvasElement
  /** 2D clip-chrome overlay (borders / selection / fades / handles). */
  fx: HTMLCanvasElement
  fxCtx: CanvasRenderingContext2D
  /** Waveform needs a GPU redraw (data changed). Cleared after drawing. */
  dirty: boolean
  mix: LaneMix
  /** Record routing when armed: hardware input channel (0-based) + mono/stereo-pair. */
  recIn: { ch: number; stereo: boolean }
  /** Mixer-pane DOM strip (fader / pan / M·S·R / meters). */
  strip: Strip
  /** Built-in GPU channel strip (trim / saturation / console EQ / comp). */
  dsp: ChannelStrip
  /** Per-track insert plugins (reverb / delay / 5-band EQ). */
  inserts: Insert[]
  /** Eased meter value (linear), updated per frame. */
  vu: number
  /** Max post-fader linear level seen since last reset (peak-hold readout). */
  peakHold: number
  /** Set on instrument lanes: the MIDI track that feeds a GPGPU instrument whose render is this lane's audio. */
  inst?: { midiTrackId: number; sig: string; timer: number }
  /** Set on line-input lanes: live input through this lane's strip + inserts (no clips). */
  live?: { monitor: boolean }
  /** Stem this track is exported with (tracks with the same name become one stem file). '' / absent = none. */
  stem?: string
  /** Group channel this track's output goes to (absent = straight to the master). */
  group?: number
  /** Track colour `#rrggbb`: the lane is painted with it, the waveform is dark grey on top. */
  color?: string
}

const dbToLin = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20))
const linToDb = (x: number): number => (x <= 1e-4 ? -Infinity : 20 * Math.log10(x))
const fmtLufs = (v: number): string => (!Number.isFinite(v) || v <= -70 ? '−∞' : v.toFixed(1))
const lanes: Lane[] = []

/**
 * Group channels (buses): the tracks routed to one are summed, run through the group's inserts, then its fader / pan
 * on the way into the master. Group ids live above the track ids (1001, 1002, …) so a single number names either one
 * (insert owners, selection, MCP).
 */
const GROUP_ID_BASE = 1000
interface Group {
  id: number
  name: string
  color: string
  mix: LaneMix
  inserts: Insert[]
  peakHold: number
  vu: number
  strip: Strip
}
const groups: Group[] = []
let nextGroupId = GROUP_ID_BASE + 1
const groupById = (id: unknown): Group | undefined => groups.find((g) => g.id === id)
let nextId = 1
let meterTextAt = 0 // last time the strip dB / peak numbers were written
let masterVu = 0
let masterPeakHold = 0

// ---- left-pane track detail (selected track / master) ------------------------
const trackDetailEl = $('track-detail')
let selectedId: number | 'master' | null = null
/**
 * Right-pane audio-list pick (transient, not persisted). A `src:` pick brightens
 * every clip of that source; a `clip:` pick brightens just that one clip.
 * Same string form as the drag payload / list-row key.
 */
let audioPick: string | null = null
/** Master-bus insert list, bound in boot() so the detail pane can edit it. */
let masterBusInserts: Insert[] | null = null
/** Master strip's insert-slot rack element, bound in boot(). */
let masterRackEl: HTMLElement | null = null
/** Live handles into the current detail view so the strip can mirror changes. */
let detailApi: {
  setGain: (db: number) => void
  setPan: (p: number) => void
  syncButtons: () => void
  vuEl: HTMLElement
} | null = null

/**
 * Shared-view redraw gate. The waveform canvases only depend on peak data + the
 * timeline transform (the playhead is a separate DOM overlay), so during steady
 * playback nothing needs re-rendering — we skip the per-frame lane draws
 * entirely until a pan/zoom/resize/track-load marks things dirty again.
 */
let viewDirty = true
/** Last transform signature the grid overlay was reconciled against. */
let gridSig = ''
/** Last signature the top ruler was drawn for (skip idle redraws). */
let rulerSig = ''
/** True while dragging on the ruler — suppresses the scheduler's playhead drive. */
let scrubbing = false

function fmtTime(frames: number): string {
  const s = frames / state.sampleRate
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(3).padStart(6, '0')}`
}

/** Playhead as bar.beat.sixteenth in the project's time signature (1-based), for the transport bar. */
function fmtBars(frames: number): string {
  const quarters = (frames / state.sampleRate) * (state.bpm / 60)
  const units = quarters * (state.timeSigDen / 4) // beats of the signature's own note value
  const num = Math.max(1, state.timeSigNum)
  const bar = Math.floor(units / num) + 1
  const inBar = units - (bar - 1) * num
  const beat = Math.floor(inBar)
  const sub = Math.max(1, Math.round(16 / Math.max(1, state.timeSigDen))) // sixteenths per beat
  return `${bar}.${beat + 1}.${Math.floor((inBar - beat) * sub) + 1}`
}

/** Usable width (CSS px) of the waveform column inside a lane. */
function waveViewportPx(): number {
  return Math.max(200, tracksScroll.clientWidth - LANE_LEFT - LANE_RIGHT)
}

// ---- time ruler (top pane) + aligned grid overlay (over the waveforms) -------

const RULER_DPR = Math.min(window.devicePixelRatio || 1, 2)
/** "Nice" major-tick intervals in seconds; the smallest that gives ≥ ~100 px. */
const RULER_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200]

/** Frame → x (CSS px) in the lane / ruler coordinate space (shared mapping). */
function frameToX(frame: number): number {
  return LANE_LEFT + (frame - state.scrollFrames) / state.framesPerPixel
}

/** m:ss (or m:ss.d when the tick step is sub-second). */
function fmtRuler(sec: number, step: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return step < 1 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${Math.round(s).toString().padStart(2, '0')}`
}

/** Pick the major-tick interval (s) for the current zoom. */
function rulerStep(): number {
  const target = 100 * (state.framesPerPixel / state.sampleRate) // ~100 px between majors
  return RULER_STEPS.find((s) => s >= target) ?? RULER_STEPS[RULER_STEPS.length - 1]
}

/** Redraw the top ruler: ticks, m:ss labels, and a playhead marker. */
function drawRuler(): void {
  const cssW = rulerCanvas.clientWidth
  const cssH = rulerCanvas.clientHeight
  const w = Math.max(1, Math.floor(cssW * RULER_DPR))
  const h = Math.max(1, Math.floor(cssH * RULER_DPR))
  if (rulerCanvas.width !== w) rulerCanvas.width = w
  if (rulerCanvas.height !== h) rulerCanvas.height = h
  const g = rulerCtx
  g.setTransform(RULER_DPR, 0, 0, RULER_DPR, 0, 0)
  g.clearRect(0, 0, cssW, cssH)
  g.fillStyle = '#0e1116'
  g.fillRect(0, 0, cssW, cssH)
  g.fillStyle = '#232833' // gutter divider (under the timecode readout)
  g.fillRect(LANE_LEFT - 1, 0, 1, cssH)

  const right = cssW - LANE_RIGHT
  if (state.totalFrames <= 0 || right <= LANE_LEFT) return

  const sr = state.sampleRate
  const step = rulerStep()
  const minor = step / (step >= 60 ? 4 : 5)
  const t0 = state.scrollFrames / sr
  const t1 = t0 + (right - LANE_LEFT) * (state.framesPerPixel / sr)
  g.font = '9px ui-monospace, Menlo, Consolas, monospace'
  g.textBaseline = 'alphabetic'

  for (let k = Math.max(0, Math.floor(t0 / minor)); k * minor <= t1 + minor; k++) {
    const t = k * minor
    const x = frameToX(t * sr)
    if (x < LANE_LEFT - 0.5 || x > right + 0.5) continue
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6
    const tickH = major ? 11 : 5
    g.fillStyle = major ? '#7d8697' : '#3a414f'
    g.fillRect(Math.round(x), cssH - tickH, 1, tickH)
    if (major) {
      g.fillStyle = '#9aa4b2'
      g.fillText(fmtRuler(t, step), Math.round(x) + 3, cssH - tickH - 2)
    }
  }

  const px = frameToX(state.playhead)
  if (px >= LANE_LEFT - 0.5 && px <= right + 0.5) {
    g.fillStyle = '#34d399'
    g.fillRect(Math.round(px), 0, 1, cssH)
    g.beginPath()
    g.moveTo(px - 4, 0)
    g.lineTo(px + 4, 0)
    g.lineTo(px, 6)
    g.closePath()
    g.fill()
  }
}

/** Reconcile the grid overlay's lines to the ruler's major ticks (pooled divs). */
function syncGrid(): void {
  const right = tracksScroll.clientWidth - LANE_RIGHT
  const xs: number[] = []
  if (state.totalFrames > 0 && right > LANE_LEFT) {
    const sr = state.sampleRate
    const step = rulerStep()
    const t1 = (state.scrollFrames + (right - LANE_LEFT) * state.framesPerPixel) / sr
    for (let k = Math.max(0, Math.floor(state.scrollFrames / sr / step)); k * step <= t1 + step; k++) {
      const x = frameToX(k * step * sr)
      if (x >= LANE_LEFT && x <= right) xs.push(x)
    }
  }
  const kids = gridEl.children
  for (let i = 0; i < xs.length; i++) {
    let line = kids[i] as HTMLElement | undefined
    if (!line) {
      line = document.createElement('i')
      line.className = 'major'
      gridEl.appendChild(line)
    }
    line.style.left = `${Math.round(xs[i])}px`
  }
  while (kids.length > xs.length) gridEl.removeChild(kids[kids.length - 1])
}

/** Control-surface feedback pump, bound in boot() (no-op until then). */
let mcuTick: () => void = () => {}

let anySolo = false
function refreshSolo(): void {
  anySolo = lanes.some((l) => l.mix.solo) || groups.some((g) => g.mix.solo)
}

/**
 * Vertical `top` for the *centre line* at a given fader value. Both the cap
 * (`.fader-cap`, `translateY(-50%)`) and the gauge ticks use this one mapping,
 * so a tick and the cap line up when their values match. The ±25px = half the
 * 50px cap, keeping the cap fully inside the column at both extremes.
 */
function faderTop(value: number, min: number, max: number): string {
  const p = 1 - (value - min) / (max - min) // 0 = top (max)
  return `calc(25px + ${p.toFixed(4)} * (100% - 50px))`
}

/**
 * Only let the fader move when the pointer actually grabs the cap. A pointerdown
 * on the empty rail is neutralised (`preventDefault` stops the native range from
 * jumping to the click) but still bubbles, so it reads as a track-select instead.
 */
function guardFaderRail(fader: HTMLInputElement, cap: HTMLElement): void {
  fader.addEventListener('pointerdown', (e) => {
    const c = cap.getBoundingClientRect()
    const pad = 8
    const onCap =
      e.clientY >= c.top - pad &&
      e.clientY <= c.bottom + pad &&
      e.clientX >= c.left - pad &&
      e.clientX <= c.right + pad
    if (!onCap) e.preventDefault()
  })
}

/**
 * A dB tick gauge, laid out as its own column immediately left of the fader
 * rail (see `.fader-scale`) so the cap can never cover it. Ticks use `faderTop`,
 * the same vertical mapping as the cap.
 */
function makeScale(min: number, max: number): HTMLElement {
  const el = document.createElement('div')
  el.className = 'fader-scale'
  const marks: Array<[number, boolean]> = [
    [6, true], [0, true], [-6, false], [-12, true], [-18, false],
    [-24, true], [-36, false], [-48, true], [-60, false]
  ]
  for (const [db, major] of marks) {
    if (db < min || db > max) continue
    const b = document.createElement('b')
    if (major) {
      b.className = 'major'
      b.textContent = db > 0 ? `+${db}` : String(db)
    }
    b.style.top = faderTop(db, min, max)
    el.appendChild(b)
  }
  return el
}

/** Build the channel strip DOM in the mix pane and wire its controls. */
/** The small colour picker that opens from a colour band: the 12 palette colours; closes on a pick / outside click / Esc. */
function openColorPopover(anchor: HTMLElement, current: string, onPick: (color: string) => void): void {
  document.getElementById('color-pop')?.remove()
  const pop = document.createElement('div')
  pop.id = 'color-pop'
  const cur = normalizeColor(current)
  for (const c of TRACK_PALETTE) {
    const b = document.createElement('button')
    b.style.background = c
    b.title = c
    if (c === cur) b.className = 'on'
    b.addEventListener('click', () => {
      onPick(c)
      close()
    })
    pop.append(b)
  }
  document.body.appendChild(pop)
  const r = anchor.getBoundingClientRect()
  const w = pop.offsetWidth
  const h = pop.offsetHeight
  pop.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`
  pop.style.top = `${Math.max(4, r.top - h - 6)}px`
  const onDoc = (e: Event): void => {
    if (!pop.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }
  function close(): void {
    pop.remove()
    document.removeEventListener('pointerdown', onDoc, true)
    document.removeEventListener('keydown', onKey, true)
  }
  document.addEventListener('pointerdown', onDoc, true)
  document.addEventListener('keydown', onKey, true)
}

function buildStrip(
  lane: { id: number; mix: LaneMix; peakHold: number; inserts: Insert[] },
  id: number,
  title: string,
  isGroup = false
): Strip {
  const el = document.createElement('div')
  el.className = isGroup ? 'strip group' : 'strip'
  el.innerHTML =
    `<div class="strip-head"><span class="n"></span><span class="t"></span></div>` +
    `<div class="strip-rack"></div>` +
    `<div class="strip-mid">` +
    `<div class="fader-wrap"><input class="strip-fader" type="range" min="-60" max="6" step="0.5" value="0" /></div>` +
    `<div class="strip-vu"><i></i></div></div>` +
    `<div class="strip-nums">` +
    `<div class="strip-db" title="fader (dB)">0.0</div>` +
    `<div class="strip-peak" title="peak — click to reset">−∞</div></div>` +
    `<div class="strip-btns">` +
    `<button class="m">M</button><button class="s">S</button>` +
    `<button class="r">R</button><div class="strip-knob" title="pan — drag, dbl-click = centre"><i></i></div>` +
    `</div>` +
    `<div class="strip-color" title="colour — click to change"></div>`
  ;(el.querySelector('.strip-head .n') as HTMLElement).textContent = String(id)
  const t = el.querySelector('.strip-head .t') as HTMLElement
  t.textContent = title
  t.title = title
  const faderWrap = el.querySelector('.fader-wrap') as HTMLElement
  // gauge is a sibling column left of the rail; the cap lives inside the rail column
  faderWrap.parentElement!.insertBefore(makeScale(-60, 6), faderWrap)
  const cap = document.createElement('div')
  cap.className = 'fader-cap'
  faderWrap.appendChild(cap)
  // track strips stay in front of the group strips (new tracks are inserted before the first group)
  const firstGroupStrip = isGroup ? null : stripsEl.querySelector('.strip.group')
  if (firstGroupStrip) stripsEl.insertBefore(el, firstGroupStrip)
  else stripsEl.appendChild(el)

  const knob = el.querySelector('.strip-knob') as HTMLElement
  const knobInd = knob.querySelector('i') as HTMLElement
  const strip: Strip = {
    el,
    rackEl: el.querySelector('.strip-rack') as HTMLElement,
    fader: el.querySelector('.strip-fader') as HTMLInputElement,
    knobInd,
    vu: el.querySelector('.strip-vu > i') as HTMLElement,
    db: el.querySelector('.strip-db') as HTMLElement,
    peak: el.querySelector('.strip-peak') as HTMLElement,
    m: el.querySelector('button.m') as HTMLButtonElement,
    s: el.querySelector('button.s') as HTMLButtonElement,
    r: el.querySelector('button.r') as HTMLButtonElement,
    setGain: (db) => {
      strip.fader.value = String(db)
      cap.style.top = faderTop(db, -60, 6)
    },
    setPan: (p) => {
      knobInd.style.transform = `rotate(${p * 135}deg)`
    }
  }

  const placeCap = (): void => {
    cap.style.top = faderTop(Number(strip.fader.value), -60, 6)
  }
  placeCap()
  guardFaderRail(strip.fader, cap) // empty rail = select the track, don't move the fader
  strip.fader.addEventListener('input', () => {
    lane.mix.gainDb = Number(strip.fader.value)
    placeCap()
    if (lane.id === selectedId) detailApi?.setGain(lane.mix.gainDb)
  })

  // Rotary pan: drag up/down. pan -1..+1 → indicator -135..+135°.
  const applyPan = (): void => {
    strip.knobInd.style.transform = `rotate(${lane.mix.pan * 135}deg)`
  }
  applyPan()
  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    knob.setPointerCapture(e.pointerId)
    const y0 = e.clientY
    const p0 = lane.mix.pan
    const move = (ev: PointerEvent): void => {
      lane.mix.pan = Math.max(-1, Math.min(1, p0 - (ev.clientY - y0) * 0.008))
      applyPan()
      if (lane.id === selectedId) detailApi?.setPan(lane.mix.pan)
    }
    const up = (): void => {
      knob.removeEventListener('pointermove', move)
      knob.removeEventListener('pointerup', up)
    }
    knob.addEventListener('pointermove', move)
    knob.addEventListener('pointerup', up)
  })
  knob.addEventListener('dblclick', () => {
    lane.mix.pan = 0
    applyPan()
    if (lane.id === selectedId) detailApi?.setPan(0)
  })

  strip.peak.addEventListener('click', () => {
    lane.peakHold = 0
    strip.peak.textContent = '−∞'
    strip.peak.classList.remove('over')
  })

  const toggle = (btn: HTMLButtonElement, key: 'mute' | 'solo' | 'rec'): void => {
    lane.mix[key] = !lane.mix[key]
    btn.classList.toggle('on', lane.mix[key])
    if (key === 'solo') refreshSolo()
    if (lane.id === selectedId) detailApi?.syncButtons()
  }
  strip.m.addEventListener('click', () => toggle(strip.m, 'mute'))
  strip.s.addEventListener('click', () => toggle(strip.s, 'solo'))
  strip.r.addEventListener('click', () => toggle(strip.r, 'rec'))
  // The colour band at the bottom: click it to pick the colour (a stem's tracks follow).
  const band = el.querySelector('.strip-color') as HTMLElement
  band.addEventListener('pointerdown', (e) => e.stopPropagation())
  band.addEventListener('click', (e) => {
    e.stopPropagation()
    const g = groupById(id)
    const l = lanes.find((x) => x.id === id)
    const current = g ? g.color : (l?.color ?? TRACK_PALETTE[0])
    openColorPopover(band, current, (c) => {
      if (g) {
        g.color = c
        applyGroupColor(g)
        for (const m of lanes) if (m.group === g.id) adoptGroupColor(m, g)
      } else if (l) {
        setLaneColor(l, c)
      }
      if (id === selectedId) renderDetail()
    })
  })
  // Touching anywhere on the strip selects the track (its controls still work).
  el.addEventListener('pointerdown', () => selectLane(id))
  fillRack(strip.rackEl, lane.inserts, id) // 8 empty insert slots
  return strip
}

function addLane(title: string): Lane {
  const id = nextId++
  const el = document.createElement('div')
  el.className = 'lane'
  // Static structure via innerHTML; text set below so a filename can't inject markup.
  el.innerHTML =
    `<div class="lane-left">` +
    `<div class="lane-name"><span class="lane-num"></span><span class="lane-title"></span></div>` +
    `<div class="lane-sub"></div></div>` +
    `<div class="lane-center"><canvas></canvas><canvas class="lane-fx"></canvas></div>` +
    `<div class="lane-right"></div>`
  ;(el.querySelector('.lane-num') as HTMLElement).textContent = String(id)
  ;(el.querySelector('.lane-title') as HTMLElement).textContent = title
  ;(el.querySelector('.lane-title') as HTMLElement).title = title // hover = full name
  tracksEl.appendChild(el)
  // Click anywhere on the lane selects the track (the centre also seeks — both fire).
  el.addEventListener('pointerdown', () => selectLane(id))

  const canvas = el.querySelector('.lane-center > canvas:not(.lane-fx)') as HTMLCanvasElement
  const fx = el.querySelector('canvas.lane-fx') as HTMLCanvasElement
  // strip is wired right after (its handlers close over `lane`), so start without it.
  const lane = {
    id,
    clips: [] as Clip[],
    renderer: new WaveformRenderer(canvas),
    el,
    canvas,
    fx,
    fxCtx: fx.getContext('2d') as CanvasRenderingContext2D,
    dirty: true,
    mix: { gainDb: 0, pan: 0, mute: false, solo: false, rec: false } as LaneMix,
    recIn: { ch: 0, stereo: false },
    dsp: new ChannelStrip(),
    inserts: [] as Insert[],
    vu: 0,
    peakHold: 0
  } as unknown as Lane
  lane.strip = buildStrip(lane, id, title)
  lane.color = paletteColor(id - 1)
  applyLaneColor(lane)
  lanes.push(lane)
  if (selectedId === null) selectLane(id) // first track added → open its detail
  return lane
}

const laneById = (id: number): Lane | undefined => lanes.find((l) => l.id === id)

// ---- audio sources + clips ------------------------------------------------

/** Read + decode a WAV, upload it to VRAM at project rate, register as a source. */
async function importWavSource(path: string, title?: string): Promise<AudioSource | null> {
  try {
    const file = await window.daw.readAudioFile(path)
    const decoded = decodeWav(file.bytes)
    const gpu = new GpuTrack()
    gpu.uploadChannels(decoded.channels, decoded.sampleRate, state.sampleRate)
    const src = registerSource({
      name: title || trackNameFromPath(path),
      path,
      kind: 'wav',
      gpu,
      envelope: computeEnvelope(decoded.channels, decoded.sampleRate)
    })
    renderAudioList()
    return src
  } catch (err) {
    console.error(`[load] skipped ${path}:`, err)
    return null
  }
}

/** Generate a GPU demo-tone source (no disk, no CPU sample array kept). */
function makeToneSource(seconds: number, name = 'Demo tone'): AudioSource {
  const gpu = new GpuTrack()
  gpu.generateTone(seconds, state.sampleRate)
  const src = registerSource({ name, path: null, kind: 'tone', toneSeconds: seconds, gpu, envelope: null })
  renderAudioList()
  return src
}

/** Place a full-length clip of `source` at `startFrame` on `lane`. */
function addClipToLane(lane: Lane, source: AudioSource, startFrame = 0, srcOffset = 0, lengthFrames?: number): Clip {
  const len = Math.max(1, (lengthFrames ?? source.gpu.totalFrames) - 0)
  const clip = makeClip({
    sourceId: source.id,
    name: source.name,
    startFrame,
    srcOffset,
    lengthFrames: Math.min(len, source.gpu.totalFrames - srcOffset)
  })
  retainSource(source.id)
  lane.clips.push(clip)
  lane.dirty = true
  renderAudioList()
  return clip
}

// ---- instrument lanes (MIDI track → GPGPU instrument → audio in VRAM) -------------

const midiTrackById = (id: number): MidiTrack | undefined => midiTracks.find((t) => t.id === id)

/** All of a MIDI track's notes as instrument notes in project frames (clips flattened). */
function instrumentNotes(mt: MidiTrack): InstrumentNote[] {
  const out: InstrumentNote[] = []
  const { bpm, sampleRate: sr } = state
  for (const c of mt.clips) {
    for (const n of c.notes) {
      const a = beatsToFrames(c.start + n.start, bpm, sr)
      out.push({
        startFrame: Math.round(a),
        endFrame: Math.round(a + beatsToFrames(n.dur, bpm, sr)),
        key: n.key,
        vel: n.vel
      })
    }
  }
  return out
}

/**
 * (Re)render an instrument lane's audio on the GPU into its source buffers. Skipped
 * when nothing that affects the sound changed (notes, instrument params, tempo, rate).
 */
function renderInstrumentLane(lane: Lane, force = false): void {
  if (!lane.inst) return
  const mt = midiTrackById(lane.inst.midiTrackId)
  const clip = lane.clips[0]
  const src = clip && getSource(clip.sourceId)
  if (!mt || !mt.instrument || !src) return
  const notes = instrumentNotes(mt)
  const sig = `${state.sampleRate}|${state.bpm}|${mt.instrument.kind}|${JSON.stringify(mt.instrument.params)}|${notes
    .map((n) => `${n.startFrame},${n.endFrame},${n.key},${n.vel}`)
    .join(';')}`
  if (!force && sig === lane.inst.sig) return
  const inst = makeInstrument(mt.instrument.kind, mt.instrument.params)
  if (!inst) return
  inst.render(notes, state.sampleRate, src.gpu)
  lane.inst.sig = sig
  clip.srcOffset = 0
  clip.lengthFrames = src.gpu.totalFrames
  clip.fadeIn = 0
  clip.fadeOut = 0
  lane.dirty = true
  refreshTotals()
}

/** Debounced re-render (knob drags / many edits arrive in bursts). */
function scheduleInstrumentRender(lane: Lane): void {
  if (!lane.inst) return
  clearTimeout(lane.inst.timer)
  lane.inst.timer = window.setTimeout(() => renderInstrumentLane(lane), 150)
}

const midiIo = new MidiIo()
let pianoRoll: PianoRollApi | null = null
function openPianoRoll(mt: MidiTrack, clipIndex = 0): void {
  if (!pianoRoll) pianoRoll = createPianoRoll(document.body)
  pianoRoll.open(mt, clipIndex)
}
let stepGrid: StepGridApi | null = null
/** Drum tracks open the step sequencer; everything else opens the piano roll. */
function openTrackEditor(mt: MidiTrack): void {
  if (mt.instrument?.kind === 'drums') {
    if (!stepGrid) stepGrid = createStepGrid(document.body, { openPianoRoll: (t) => openPianoRoll(t) })
    stepGrid.open(mt)
  } else {
    openPianoRoll(mt)
  }
}

// ---- line-input lanes ----------------------------------------------------------------

let schedulerRef: PlaybackScheduler | null = null
let liveBusRef: LiveBus | null = null
const LIVE_LAT_KEY = 'awaker.liveLatencyMs'
const LIVE_BLOCK_KEY = 'awaker.liveBlock'
const REC_OFF_KEY = 'awaker.recOffsetMs'
const readNum = (k: string, d: number): number => {
  try {
    const v = Number(localStorage.getItem(k))
    return Number.isFinite(v) && localStorage.getItem(k) !== null ? v : d
  } catch {
    return d
  }
}
const writeNum = (k: string, v: number): void => {
  try {
    localStorage.setItem(k, String(v))
  } catch {
    /* storage unavailable */
  }
}

const liveSub = (l: Lane): string => `line · ${l.recIn.stereo ? `In ${l.recIn.ch + 1}-${l.recIn.ch + 2}` : `In ${l.recIn.ch + 1}`}${l.live?.monitor ? '' : ' · monitor off'}`

/** A lane whose audio is live line input, run through the strip + inserts in real time. */
function addLiveLane(name = 'Line In', ch = 0, stereo = false): Lane {
  const lane = addLane(name)
  lane.live = { monitor: true }
  lane.recIn = { ch: Math.max(0, ch | 0), stereo }
  lane.el.classList.add('line')
  setLaneSub(lane, liveSub(lane))
  renderAudioList()
  if (selectedId === lane.id) renderDetail() // addLane selected it before `live` was set
  return lane
}

/** The live lanes as the live bus sees them (mute / solo folded into the fader gain, like playback). */
function liveLanes(): LiveLane[] {
  return lanes
    .filter((l) => l.live?.monitor)
    .map((l) => {
      const audible = !l.mix.mute && (!anySolo || l.mix.solo)
      return {
        id: l.id,
        ch: l.recIn.ch,
        stereo: l.recIn.stereo,
        mix: { gain: audible ? dbToLin(l.mix.gainDb) : 0, pan: l.mix.pan },
        strip: l.dsp,
        inserts: l.inserts
      }
    })
}

/** Detail-pane controls for a line-input track: channel, monitor, and the timing of the live path. */
function buildLiveSection(lane: Lane): HTMLElement {
  const sec = section('Line input')
  if (!lane.live) return sec
  const rowCss = 'display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:11px;color:var(--dim)'
  const inCss = 'flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 4px;font-size:11px'

  const chRow = document.createElement('label')
  chRow.style.cssText = rowCss
  chRow.append('Input')
  const sel = document.createElement('select')
  sel.style.cssText = inCss
  const add = (v: string, t: string): void => {
    const o = document.createElement('option')
    o.value = v
    o.textContent = t
    sel.appendChild(o)
  }
  for (let n = 0; n < 8; n++) add(`m${n}`, `In ${n + 1} (mono)`)
  for (let n = 0; n < 8; n += 2) add(`s${n}`, `In ${n + 1}-${n + 2} (stereo)`)
  sel.value = `${lane.recIn.stereo ? 's' : 'm'}${lane.recIn.ch}`
  sel.addEventListener('change', () => {
    lane.recIn = { ch: Number(sel.value.slice(1)), stereo: sel.value[0] === 's' }
    setLaneSub(lane, liveSub(lane))
  })
  chRow.appendChild(sel)
  sec.appendChild(chRow)

  const mon = document.createElement('label')
  mon.style.cssText = rowCss
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = lane.live.monitor
  cb.addEventListener('change', () => {
    if (lane.live) lane.live.monitor = cb.checked
    setLaneSub(lane, liveSub(lane))
  })
  mon.append(cb, 'Monitor through strip + inserts')
  sec.appendChild(mon)

  const num = (label: string, title: string, get: () => number, set: (v: number) => void): HTMLElement => {
    const row = document.createElement('label')
    row.style.cssText = rowCss
    row.title = title
    row.append(label)
    const i = document.createElement('input')
    i.type = 'number'
    i.step = '1'
    i.value = String(get())
    i.style.cssText = inCss
    i.addEventListener('change', () => set(Number(i.value) || 0))
    row.append(i, 'ms')
    return row
  }
  sec.appendChild(
    num('Live latency', 'Where the monitored sound lands relative to the input: GPU + IPC head-room. 0 = automatic (one block + 15 ms, widened by itself when blocks arrive late). Set a number to pin it.', () => liveBusRef?.latencyMs ?? 0, (v) => {
      if (liveBusRef) liveBusRef.latencyMs = Math.max(0, Math.min(200, v))
      writeNum(LIVE_LAT_KEY, v)
    })
  )
  // Block size: bigger = more headroom against late blocks (needed with heavy strips / several lanes), at the cost of latency
  const blkRow = document.createElement('label')
  blkRow.style.cssText = rowCss
  blkRow.title = 'Frames per live block. Larger blocks cope with heavier strips and more lanes but add latency (about one block). Applies at once when the monitor is on and the transport is stopped, otherwise at the next start.'
  blkRow.append('Block')
  const blkSel = document.createElement('select')
  blkSel.style.cssText = inCss
  for (const n of [512, 1024, 2048]) {
    const o = document.createElement('option')
    o.value = String(n)
    o.textContent = `${n} fr` + (n === 512 ? ' (lowest latency)' : n === 2048 ? ' (safest)' : '')
    blkSel.appendChild(o)
  }
  blkSel.value = String(LIVE_BLOCK)
  blkSel.addEventListener('change', () => {
    const n = Number(blkSel.value)
    writeNum(LIVE_BLOCK_KEY, n)
    const sch = schedulerRef
    if (sch?.monitorOn && !state.playing) {
      void sch.stopMonitor().then(() => {
        setLiveBlock(n)
        return sch.startMonitor()
      })
    } else {
      setLiveBlock(n)
    }
  })
  blkRow.appendChild(blkSel)
  sec.appendChild(blkRow)
  sec.appendChild(
    num('Rec offset', 'Extra shift of recorded takes (positive = earlier), added to the device latency the driver reports. Calibrate with a loopback cable.', () => schedulerRef?.recOffsetMs ?? 0, (v) => {
      if (schedulerRef) schedulerRef.recOffsetMs = Math.max(-200, Math.min(500, v))
      writeNum(REC_OFF_KEY, v)
    })
  )

  const stats = document.createElement('div')
  stats.style.cssText = 'font-size:10px;color:var(--dim);line-height:1.5;font-family:monospace;white-space:pre-wrap'
  sec.appendChild(stats)
  const refresh = (): void => {
    if (!stats.isConnected) return
    const info = schedulerRef?.liveInfo()
    if (!info || !info.active) {
      stats.textContent = 'idle — press Monitor (toolbar), Play or Rec'
    } else {
      const m = info.main
      const b = info.bus
      stats.textContent =
        `landing +${info.latencyMs.toFixed(1)} ms (${m?.deltaFrames ?? 0} fr)\n` +
        `round trip ${m ? m.rttMeanMs.toFixed(1) : '-'} ms (max ${m ? m.rttMaxMs.toFixed(1) : '-'})\n` +
        `GPU ${b ? b.procMeanMs.toFixed(1) : '-'} ms/block (max ${b ? b.procMaxMs.toFixed(1) : '-'})\n` +
        `blocks ${m?.blocks ?? 0} · late ${m?.late ?? 0} · dropped ${b?.dropped ?? 0}`
    }
    window.setTimeout(refresh, 500)
  }
  window.setTimeout(refresh, 100)
  return sec
}

const RETURN_DEV_KEY = 'awaker.returnInputDevice'
const RETURN_DELAY_KEY = 'awaker.returnDelayMs'

/**
 * Detail-pane controls for the secondary WASAPI return input (virtual audio cable return):
 * pick an input device, set manual delay compensation, start / stop, and watch ring fill + drift ratio.
 */
function buildReturnSection(lane: Lane): HTMLElement {
  const sec = section('Return input (WASAPI)')
  if (!lane.live) return sec
  const rowCss = 'display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:11px;color:var(--dim)'
  const inCss = 'flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 4px;font-size:11px'

  const devRow = document.createElement('label')
  devRow.style.cssText = rowCss
  devRow.append('Device')
  const sel = document.createElement('select')
  sel.style.cssText = inCss
  const none = document.createElement('option')
  none.value = ''
  none.textContent = '— choose input device —'
  sel.appendChild(none)
  let savedDev = ''
  try {
    savedDev = localStorage.getItem(RETURN_DEV_KEY) ?? ''
  } catch {
    /* storage unavailable */
  }
  void window.daw.listAudioInputs().then(({ devices, defaultInput }) => {
    for (const d of devices) {
      const o = document.createElement('option')
      o.value = String(d.id)
      o.textContent = `${d.name} (${d.inputChannels}ch)`
      sel.appendChild(o)
    }
    if (savedDev && devices.some((d) => String(d.id) === savedDev)) {
      sel.value = savedDev
    } else if (defaultInput && devices.some((d) => d.id === defaultInput)) {
      sel.value = String(defaultInput)
    }
  })
  sel.addEventListener('change', () => {
    try {
      localStorage.setItem(RETURN_DEV_KEY, sel.value)
    } catch {
      /* storage unavailable */
    }
  })
  devRow.appendChild(sel)
  sec.appendChild(devRow)

  const delayRow = document.createElement('label')
  delayRow.style.cssText = rowCss
  delayRow.title = 'Manual delay offset (ms) for virtual cable + buffer compensation on the return path.'
  delayRow.append('Return delay')
  const delayIn = document.createElement('input')
  delayIn.type = 'number'
  delayIn.step = '1'
  delayIn.value = String(readNum(RETURN_DELAY_KEY, 0))
  delayIn.style.cssText = inCss
  delayIn.addEventListener('change', () => {
    const v = Math.max(-100, Math.min(500, Number(delayIn.value) || 0))
    delayIn.value = String(v)
    writeNum(RETURN_DELAY_KEY, v)
    void window.daw.returnSetDelay(v)
  })
  delayRow.append(delayIn, 'ms')
  sec.appendChild(delayRow)

  const btns = document.createElement('div')
  btns.style.cssText = 'display:flex;gap:6px;margin:0 0 8px'
  const startBtn = document.createElement('button')
  startBtn.className = 'sat-mode'
  startBtn.style.cssText = 'flex:1'
  startBtn.textContent = 'Start return'
  const stopBtn = document.createElement('button')
  stopBtn.className = 'sat-mode'
  stopBtn.style.cssText = 'flex:1'
  stopBtn.textContent = 'Stop'
  btns.append(startBtn, stopBtn)
  sec.appendChild(btns)

  const stateRow = document.createElement('div')
  stateRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;margin:0 0 6px'
  const dot = document.createElement('span')
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--dim);flex:none'
  const stateText = document.createElement('span')
  stateText.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  stateRow.append(dot, stateText)
  sec.appendChild(stateRow)

  const stats = document.createElement('div')
  stats.style.cssText = 'font-size:10px;color:var(--dim);line-height:1.5;font-family:monospace;white-space:pre-wrap'
  sec.appendChild(stats)

  startBtn.addEventListener('click', () => {
    const id = Number(sel.value) || undefined
    const delayMs = Number(delayIn.value) || 0
    void window.daw.returnStart({ deviceId: id, delayMs })
  })
  stopBtn.addEventListener('click', () => {
    void window.daw.returnStop()
  })

  const refresh = (): void => {
    if (!stats.isConnected) return
    void window.daw.returnStatus().then((st) => {
      if (!st.running) {
        dot.style.background = st.error ? '#ef4444' : 'var(--dim)'
        stateText.textContent = st.error ? `Error: ${st.error}` : 'Disconnected'
        stats.textContent = 'idle — pick an input device and press Start return'
      } else {
        dot.style.background = '#22c55e'
        stateText.textContent = `${st.deviceName} (${st.sampleRate} Hz)`
        const fillPct = Math.round(st.fillRatio * 100)
        const sign = st.ppm >= 0 ? '+' : ''
        stats.textContent =
          `ring fill ${fillPct}% (${st.ringBufferedFrames}/${st.ringTargetFrames} fr)\n` +
          `drift ratio ${st.resampleRatio.toFixed(6)} (${sign}${st.ppm.toFixed(1)} ppm)\n` +
          `rx ${st.receivedFrames} fr · inj ${st.injectedFrames} fr · delay ${st.delayMs} ms\n` +
          `underrun ${st.underruns} · overrun ${st.overruns} · resync ${st.resyncs}`
      }
      window.setTimeout(refresh, 500)
    })
  }
  window.setTimeout(refresh, 100)
  return sec
}

const VST_PLUGIN_KEY = 'awaker.vstPlugin'

/**
 * Detail-pane controls for the VST host bridge (proof of concept, see main/vst-bridge.ts): pick a
 * plugin, wait for the out-of-process host, watch its timing. The host's sound enters the live path,
 * so it plays through this line-input track's strip + inserts.
 */
function buildVstSection(lane: Lane): HTMLElement {
  const sec = section('VST host (PoC)')
  if (!lane.live) return sec
  const rowCss = 'display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:11px;color:var(--dim)'
  const inCss = 'flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 4px;font-size:11px'

  const row = document.createElement('label')
  row.style.cssText = rowCss
  row.append('Plugin')
  const sel = document.createElement('select')
  sel.style.cssText = inCss
  const none = document.createElement('option')
  none.value = ''
  none.textContent = '— choose a .vst3 —'
  sel.appendChild(none)
  let saved = ''
  try {
    saved = localStorage.getItem(VST_PLUGIN_KEY) ?? ''
  } catch {
    /* storage unavailable */
  }
  void window.daw.vstScan().then((list) => {
    for (const p of list) {
      const o = document.createElement('option')
      o.value = p.path
      o.textContent = p.name
      sel.appendChild(o)
    }
    sel.value = list.some((p) => p.path === saved) ? saved : ''
  })
  sel.addEventListener('change', () => {
    try {
      localStorage.setItem(VST_PLUGIN_KEY, sel.value)
    } catch {
      /* storage unavailable */
    }
  })
  row.appendChild(sel)
  sec.appendChild(row)

  const btns = document.createElement('div')
  btns.style.cssText = 'display:flex;gap:6px;margin:0 0 8px'
  const listen = document.createElement('button')
  listen.className = 'sat-mode'
  listen.style.cssText = 'flex:1'
  listen.textContent = 'Listen for host'
  const stop = document.createElement('button')
  stop.className = 'sat-mode'
  stop.style.cssText = 'flex:1'
  stop.textContent = 'Stop'
  btns.append(listen, stop)
  sec.appendChild(btns)

  const state = document.createElement('div')
  state.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;margin:0 0 6px'
  const dot = document.createElement('span')
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--dim);flex:none'
  const stateText = document.createElement('span')
  stateText.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  state.append(dot, stateText)
  sec.appendChild(state)

  const args = document.createElement('div')
  args.style.cssText = 'font-size:10px;color:var(--dim);line-height:1.5;font-family:monospace;word-break:break-all;user-select:text;margin:0 0 6px'
  sec.appendChild(args)
  const stats = document.createElement('div')
  stats.style.cssText = 'font-size:10px;color:var(--dim);line-height:1.5;font-family:monospace;white-space:pre-wrap'
  sec.appendChild(stats)

  let hostArgs = ''
  let lastErr = ''
  listen.addEventListener('click', () => {
    lastErr = ''
    if (!sel.value) {
      lastErr = 'choose a plugin first'
      return
    }
    void window.daw
      .vstListen(sel.value)
      .then((r) => {
        hostArgs = `${r.port} ${r.token}`
        void window.daw.liveEnable(true) // the live path must be on to receive the host's blocks
      })
      .catch((err) => (lastErr = err instanceof Error ? err.message : String(err)))
  })
  stop.addEventListener('click', () => {
    hostArgs = ''
    lastErr = ''
    void window.daw.vstStop()
  })

  const COLOR = { off: 'var(--dim)', wait: 'var(--warn)', ready: 'var(--play)', bad: 'var(--rec)' }
  const refresh = async (): Promise<void> => {
    if (!sec.isConnected) return
    try {
      const s = (await window.daw.vstStatus()) as {
        listening: boolean
        connected: boolean
        ready: boolean
        message: string
        blocks: number
        rttMeanMs: number
        rttMaxMs: number
        budgetMs: number
        overBudgetBlocks: number
        resyncs: number
        eventsSent: number
        eventsLate: number
      }
      const name = (s.message || '').replace(/\s*\(.*$/, '').split(/[\\/]/).pop() ?? ''
      let c = COLOR.off
      let t = 'off'
      if (s.ready) {
        c = COLOR.ready
        t = `ready · ${name}`
      } else if (s.connected) {
        c = COLOR.wait
        t = 'host connected, loading the plugin…'
      } else if (s.listening) {
        c = COLOR.wait
        t = 'waiting for the host'
      } else if (lastErr || (s.message && !/^host disconnected/.test(s.message))) {
        c = COLOR.bad
        t = lastErr || s.message
      }
      dot.style.background = c
      stateText.textContent = t
      stateText.title = t
      args.textContent = s.listening && !s.ready && hostArgs ? `start the host with:  ${hostArgs}` : ''
      stats.textContent = s.ready
        ? `host round trip ${s.rttMeanMs.toFixed(2)} ms (max ${s.rttMaxMs.toFixed(1)}) / budget ${s.budgetMs.toFixed(1)} ms\n` +
          `blocks ${s.blocks} · over budget ${s.overBudgetBlocks} · resyncs ${s.resyncs}\n` +
          `midi events ${s.eventsSent} (late ${s.eventsLate})`
        : ''
    } catch {
      /* bridge not available */
    }
    window.setTimeout(() => void refresh(), 500)
  }
  window.setTimeout(() => void refresh(), 50)
  return sec
}

/** A new FM-synth track (default preset: a punchy pluck). */
function addFmTrack(kind: 'earlysynth' | 'fm' = 'earlysynth', name = kind === 'fm' ? 'FM Synth' : 'EarlySynth', presetName = 'Pop Pluck', bars = 4): Lane {
  const mt = addMidiTrack(name)
  const load = kind === 'fm' ? fmPreset : earlyPreset
  mt.instrument = { kind, params: load(presetName) ?? load('Pop Pluck') ?? {} }
  addMidiClip(mt, 0, bars * 4, name)
  return addInstrumentLane(mt)
}

/** A new Simple Synth track (the instrument the lane falls back to). */
function addSynthTrack(name = 'Simple Synth', bars = 4): Lane {
  const mt = addMidiTrack(name)
  mt.instrument = { kind: 'synth', params: defaultSynthParams() }
  addMidiClip(mt, 0, bars * 4, name)
  return addInstrumentLane(mt)
}

/** A new drum-machine track with a preset pattern (default: the basic beat, 2 bars). */
function addDrumTrack(name = 'Drums', presetName = 'Basic beat', bars = 2): Lane {
  const mt = addMidiTrack(name, 9) // MIDI channel 10, the General MIDI drum channel
  mt.instrument = { kind: 'drums', params: defaultDrumParams() }
  const clip = addMidiClip(mt, 0, bars * 4, name)
  const preset = PRESETS.find((p) => p.name.toLowerCase() === presetName.toLowerCase()) ?? PRESETS[0]
  for (const n of presetNotes(preset, DRUM_LANES, bars)) addNote(clip, n.start, n.dur, n.key, n.vel)
  clip.length = bars * 4
  return addInstrumentLane(mt)
}

/** Create the lane that plays `mt` through its instrument (default: the simple synth). */
function addInstrumentLane(mt: MidiTrack): Lane {
  if (!mt.instrument) mt.instrument = { kind: 'synth', params: defaultSynthParams() }
  const lane = addLane(mt.name)
  lane.inst = { midiTrackId: mt.id, sig: '', timer: 0 }
  lane.el.classList.add('instrument')
  lane.el.addEventListener('dblclick', () => openTrackEditor(mt))
  const src = registerSource({ name: mt.name, path: null, kind: 'inst', gpu: new GpuTrack(), envelope: null })
  const clip = makeClip({ sourceId: src.id, name: mt.name, lengthFrames: 256 })
  retainSource(src.id)
  lane.clips.push(clip)
  renderInstrumentLane(lane, true)
  setLaneSub(lane, `inst · ${instrumentLabel(mt.instrument.kind)}`)
  renderAudioList()
  if (selectedId === lane.id) renderDetail() // addLane selected it before `inst` was set
  return lane
}

/**
 * Replace a track's sound engine. The notes, the strip, the inserts and the fader stay; only the
 * instrument changes. Params of the engine being left are kept for this session, so switching back
 * brings the old sound back.
 */
function swapInstrument(lane: Lane, kind: string): void {
  const mt = lane.inst ? midiTrackById(lane.inst.midiTrackId) : undefined
  if (!mt || !mt.instrument || normalizeInstrumentKind(mt.instrument.kind) === kind) return
  const stash = (mt.stash ??= {})
  stash[normalizeInstrumentKind(mt.instrument.kind)] = mt.instrument.params
  const fresh = stash[kind] ?? makeInstrument(kind)?.params
  if (!fresh) return
  mt.instrument = { kind, params: fresh }
  setLaneSub(lane, `inst · ${instrumentLabel(kind)}`)
  renderInstrumentLane(lane, true)
  renderDetail()
}

/** "Instrument" picker at the top of an instrument track's detail. */
function buildInstrumentPicker(lane: Lane): HTMLElement {
  const sec = section('Instrument')
  const mt = lane.inst ? midiTrackById(lane.inst.midiTrackId) : undefined
  if (!mt?.instrument) return sec
  const row = document.createElement('label')
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:0 0 4px;font-size:11px;color:var(--dim)'
  row.append('Sound')
  const sel = document.createElement('select')
  sel.style.cssText = 'flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 4px;font-size:11px'
  for (const i of listInstruments()) {
    const o = document.createElement('option')
    o.value = i.kind
    o.textContent = i.label
    sel.appendChild(o)
  }
  sel.value = normalizeInstrumentKind(mt.instrument.kind)
  sel.addEventListener('change', () => swapInstrument(lane, sel.value))
  row.appendChild(sel)
  sec.appendChild(row)
  const hint = document.createElement('div')
  hint.style.cssText = 'font-size:10px;color:var(--dim);line-height:1.4'
  hint.textContent = 'Swap the sound; notes, strip, inserts and fader stay.'
  sec.appendChild(hint)
  return sec
}

/** Detail-pane controls for a track's MIDI ports: keyboard input (recording) and external output. */
function buildMidiIoSection(lane: Lane): HTMLElement {
  const mt = lane.inst ? midiTrackById(lane.inst.midiTrackId) : undefined
  const sec = section('MIDI I/O')
  if (!mt) return sec
  const rowCss = 'display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:11px;color:var(--dim)'
  const selCss = 'flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 4px;font-size:11px'

  const portSel = (label: string, ports: { id: string; name: string }[], cur: string | null, set: (v: string | null) => void): HTMLElement => {
    const row = document.createElement('label')
    row.style.cssText = rowCss
    row.append(label)
    const sel = document.createElement('select')
    sel.style.cssText = selCss
    const add = (v: string, text: string): void => {
      const o = document.createElement('option')
      o.value = v
      o.textContent = text
      sel.appendChild(o)
    }
    add('', 'none')
    for (const p of ports) add(p.id, p.name)
    if (cur && !ports.some((p) => p.id === cur)) add(cur, '(unplugged)')
    sel.value = cur ?? ''
    sel.addEventListener('change', () => set(sel.value || null))
    row.appendChild(sel)
    return row
  }

  sec.appendChild(portSel('In', midiIo.inputs(), mt.inId, (v) => (mt.inId = v)))
  sec.appendChild(portSel('Out', midiIo.outputs(), mt.outId, (v) => (mt.outId = v)))

  const chRow = document.createElement('label')
  chRow.style.cssText = rowCss
  chRow.append('Channel')
  const ch = document.createElement('select')
  ch.style.cssText = selCss
  for (let i = 0; i < 16; i++) {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = String(i + 1)
    ch.appendChild(o)
  }
  ch.value = String(mt.channel)
  ch.addEventListener('change', () => (mt.channel = Number(ch.value)))
  chRow.appendChild(ch)
  sec.appendChild(chRow)

  const dRow = document.createElement('label')
  dRow.style.cssText = rowCss
  dRow.title = 'Delay MIDI output to line an external synth up with the audio device latency'
  dRow.append('Out delay')
  const dl = document.createElement('input')
  dl.type = 'number'
  dl.step = '1'
  dl.min = '-200'
  dl.max = '500'
  dl.value = String(midiIo.outDelayMs)
  dl.style.cssText = selCss
  dl.addEventListener('change', () => midiIo.setOutDelay(Number(dl.value) || 0))
  dRow.append(dl, 'ms')
  sec.appendChild(dRow)

  const hint = document.createElement('div')
  hint.style.cssText = 'font-size:10px;color:var(--dim);line-height:1.4'
  hint.textContent = 'Arm the track (R) with an input set, then Rec to record notes. Output plays to the port while the transport runs.'
  sec.appendChild(hint)
  return sec
}

/** Detail-pane controls for a drum-machine track (kit tuning; the pattern is edited in the step grid). */
function buildDrumSection(lane: Lane, mt: MidiTrack): HTMLElement {
  const sec = section('Drum machine')
  const sp = mt.instrument?.params as DrumParams
  const touch = (): void => scheduleInstrumentRender(lane)
  const mkBtn = (label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'sat-mode'
    b.textContent = label
    b.style.cssText = 'width:100%;margin-bottom:6px'
    b.addEventListener('click', fn)
    return b
  }
  sec.appendChild(mkBtn('▦ Step sequencer…', () => openTrackEditor(mt)))
  sec.appendChild(mkBtn('♪ Piano roll…', () => openPianoRoll(mt)))
  const grid = document.createElement('div')
  grid.className = 'knob-grid'
  const k = (label: string, min: number, max: number, get: () => number, set: (v: number) => void, def: number, fmt: (v: number) => string): void => {
    grid.appendChild(
      makeKnob({
        min, max, value: get(), default: def, label, fmt,
        onInput: (v) => {
          set(v)
          touch()
        }
      })
    )
  }
  const x2 = (v: number): string => `${v.toFixed(2)}x`
  const pctf = (v: number): string => `${Math.round(v * 100)}%`
  k('Tune', 0.7, 1.4, () => sp.tune, (v) => (sp.tune = v), 1, x2)
  k('Kick len', 0.4, 2.5, () => sp.kickDecay, (v) => (sp.kickDecay = v), 1, x2)
  k('Punch', 0, 1, () => sp.kickPunch, (v) => (sp.kickPunch = v), 0.5, pctf)
  k('Snap', 0, 2, () => sp.snareSnap, (v) => (sp.snareSnap = v), 1, x2)
  k('Hat len', 0.4, 2.5, () => sp.hatDecay, (v) => (sp.hatDecay = v), 1, x2)
  k('Gain', 0, 2, () => sp.gain, (v) => (sp.gain = v), 1, x2)
  sec.appendChild(grid)
  return sec
}

/** Detail-pane controls for an FM track: preset + a few macros (full operator editing is via the params JSON / MCP). */
function buildFmSection(lane: Lane, mt: MidiTrack): HTMLElement {
  const early = !!mt.instrument && normalizeInstrumentKind(mt.instrument.kind) === 'earlysynth'
  const names = early ? EARLY_PRESET_NAMES : FM_PRESET_NAMES
  const load = early ? earlyPreset : fmPreset
  const sec = section(early ? 'EarlySynth' : 'FM synth')
  const sp = mt.instrument?.params as FmParams
  const touch = (): void => scheduleInstrumentRender(lane)

  const row = document.createElement('label')
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:11px;color:var(--dim)'
  row.append('Preset')
  const sel = document.createElement('select')
  sel.style.cssText = 'flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 4px;font-size:11px'
  for (const n of names) {
    const o = document.createElement('option')
    o.value = n
    o.textContent = n
    sel.appendChild(o)
  }
  sel.value = names.includes(sp.preset) ? sp.preset : names[0]
  sel.addEventListener('change', () => {
    const fresh = load(sel.value)
    if (!fresh || !mt.instrument) return
    mt.instrument.params = fresh // new preset = new values, macros reset
    renderInstrumentLane(lane)
    renderDetail()
  })
  row.appendChild(sel)
  sec.appendChild(row)

  const rollBtn = document.createElement('button')
  rollBtn.className = 'sat-mode'
  rollBtn.textContent = '♪ Piano roll…'
  rollBtn.style.cssText = 'width:100%;margin-bottom:10px'
  rollBtn.addEventListener('click', () => openPianoRoll(mt))
  sec.appendChild(rollBtn)

  const grid = document.createElement('div')
  grid.className = 'knob-grid'
  const k = (label: string, min: number, max: number, get: () => number, set: (v: number) => void, def: number, fmt: (v: number) => string): void => {
    grid.appendChild(
      makeKnob({
        min, max, value: get(), default: def, label, fmt,
        onInput: (v) => {
          set(v)
          touch()
        }
      })
    )
  }
  const x2 = (v: number): string => `${v.toFixed(2)}x`
  const pctf = (v: number): string => `${Math.round(v * 100)}%`
  k('Index', 0, 2.5, () => sp.index, (v) => (sp.index = v), 1, x2)
  k('Click', 0, 1, () => sp.click, (v) => (sp.click = v), sp.click, pctf)
  k('Punch', 0, 24, () => sp.pitchPunch, (v) => (sp.pitchPunch = v), sp.pitchPunch, (v) => `${v.toFixed(1)} st`)
  k('Atk x', 0.3, 4, () => sp.atkScale, (v) => (sp.atkScale = v), 1, x2)
  k('Rel x', 0.2, 4, () => sp.relScale, (v) => (sp.relScale = v), 1, x2)
  k('Gain', 0, 2, () => sp.gain, (v) => (sp.gain = v), 1, x2)
  sec.appendChild(grid)
  return sec
}

/** Detail-pane controls for an instrument lane's synth (edits re-render on the GPU). */
function buildSynthSection(lane: Lane): HTMLElement {
  const mt = lane.inst ? midiTrackById(lane.inst.midiTrackId) : undefined
  if (mt?.instrument?.kind === 'drums') return buildDrumSection(lane, mt)
  if (mt?.instrument && ['earlysynth', 'fm'].includes(normalizeInstrumentKind(mt.instrument.kind))) return buildFmSection(lane, mt)
  const sec = section('Synth')
  if (!mt || !mt.instrument || mt.instrument.kind !== 'synth') return sec
  const sp = mt.instrument.params as SynthParams
  const touch = (): void => scheduleInstrumentRender(lane)

  const rollBtn = document.createElement('button')
  rollBtn.className = 'sat-mode'
  rollBtn.textContent = '♪ Piano roll…'
  rollBtn.style.cssText = 'width:100%;margin-bottom:10px'
  rollBtn.addEventListener('click', () => openPianoRoll(mt))
  sec.appendChild(rollBtn)

  const waves = document.createElement('div')
  waves.className = 'td-btns'
  waves.style.marginBottom = '14px'
  const mk = (label: string, w: SynthWave): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'sat-mode'
    b.textContent = label
    b.classList.toggle('on', sp.wave === w)
    b.addEventListener('click', () => {
      sp.wave = w
      waves.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
      touch()
    })
    return b
  }
  waves.append(mk('Saw', 'saw'), mk('Sq', 'square'), mk('Tri', 'tri'), mk('Sine', 'sine'))
  sec.appendChild(waves)

  const grid = document.createElement('div')
  grid.className = 'knob-grid'
  const sec2 = (v: number): string => `${v.toFixed(2)} s`
  const k = (
    label: string,
    min: number,
    max: number,
    get: () => number,
    set: (v: number) => void,
    def: number,
    fmt: (v: number) => string
  ): void => {
    grid.appendChild(
      makeKnob({
        min,
        max,
        value: get(),
        default: def,
        label,
        fmt,
        onInput: (v) => {
          set(v)
          touch()
        }
      })
    )
  }
  const pctf = (v: number): string => `${Math.round(v * 100)}%`
  k('Detune', 0, 60, () => sp.detuneCents, (v) => (sp.detuneCents = v), 12, (v) => `${v.toFixed(0)} ct`)
  k('Sub', 0, 1, () => sp.sub, (v) => (sp.sub = v), 0.3, pctf)
  k('Spread', 0, 1, () => sp.spread, (v) => (sp.spread = v), 0.6, pctf)
  k('Width', 0.05, 0.95, () => sp.pw, (v) => (sp.pw = v), 0.5, pctf)
  k('Atk', 0, 1, () => sp.atk, (v) => (sp.atk = v), 0.01, sec2)
  k('Dec', 0, 2, () => sp.dec, (v) => (sp.dec = v), 0.2, sec2)
  k('Sus', 0, 1, () => sp.sus, (v) => (sp.sus = v), 0.7, pctf)
  k('Rel', 0, 3, () => sp.rel, (v) => (sp.rel = v), 0.25, sec2)
  // cutoff is musical on a log scale: knob 0..1 → 80 Hz .. 20 kHz
  const toHz = (x: number): number => 80 * Math.pow(250, x)
  const toKnob = (hz: number): number => Math.log(Math.max(80, hz) / 80) / Math.log(250)
  k('Cutoff', 0, 1, () => toKnob(sp.cutoffHz), (v) => (sp.cutoffHz = toHz(v)), toKnob(9000), (v) => {
    const hz = toHz(v)
    return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz.toFixed(0)} Hz`
  })
  k('Res', 0, 1, () => sp.res, (v) => (sp.res = v), 0.2, pctf)
  k('Gain', 0, 2, () => sp.gain, (v) => (sp.gain = v), 1, (v) => `${v.toFixed(2)}x`)
  sec.appendChild(grid)
  return sec
}

const clipGainLin = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20))

/** Resolve a lane's clips to render-ready descriptors for the master bus. */
function resolveLaneClips(lane: Lane): LaneClip[] {
  const out: LaneClip[] = []
  for (const c of lane.clips) {
    const s = getSource(c.sourceId)
    if (!s || !s.gpu.channels[0]) continue
    const chL = s.gpu.channels[0]
    const chR = s.gpu.channels[s.gpu.channelCount === 2 ? 1 : 0]
    out.push({
      srcL: chL,
      srcR: chR,
      channelCount: s.gpu.channelCount,
      srcTotalFrames: s.gpu.totalFrames,
      startFrame: c.startFrame,
      srcOffset: c.srcOffset,
      lengthFrames: c.lengthFrames,
      fadeIn: Math.min(c.fadeIn, c.lengthFrames),
      fadeOut: Math.min(c.fadeOut, c.lengthFrames),
      fadeInShape: FADE_SHAPE_CODE[c.fadeInShape],
      fadeOutShape: FADE_SHAPE_CODE[c.fadeOutShape],
      gain: clipGainLin(c.gainDb)
    })
  }
  return out
}

/** Is this clip the current right-pane pick (directly, or via its source)? */
function clipIsPicked(laneId: number, c: Clip): boolean {
  if (!audioPick) return false
  if (audioPick === `src:${c.sourceId}`) return true
  return audioPick === `clip:${laneId}:${c.id}`
}

/** Resolve a lane's clips to peak-draw descriptors for the waveform renderer. */
function resolvePeakClips(lane: Lane): PeakClip[] {
  const out: PeakClip[] = []
  for (const c of lane.clips) {
    const s = getSource(c.sourceId)
    if (!s) continue
    out.push({
      peakBuffer: s.gpu.peakBuffer,
      peakCount: s.gpu.peakCount,
      srcOffset: c.srcOffset,
      startFrame: c.startFrame,
      lengthFrames: c.lengthFrames,
      highlight: clipIsPicked(lane.id, c)
    })
  }
  return out
}

/** Set / clear the right-pane audio pick and repaint the affected waveforms. */
function pickAudio(key: string | null): void {
  const next = key === audioPick ? null : key // click the active row again = clear
  if (next === audioPick) return
  audioPick = next
  for (const l of lanes) l.dirty = true // waveforms carry the highlight flag
  renderAudioList() // refresh the row's .sel state
}

// ---- right pane: audio (source + clip) list ------------------------------

/** Seconds → "m:ss" for list rows. */
const fmtDur = (frames: number): string => {
  const s = Math.round(frames / state.sampleRate)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function alRow(label: string, meta: string, dragPayload: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'al-row'
  if (dragPayload === audioPick) row.classList.add('sel')
  row.draggable = true
  const n = document.createElement('span')
  n.className = 'al-name'
  n.textContent = label
  n.title = label
  const m = document.createElement('span')
  m.className = 'al-meta'
  m.textContent = meta
  row.append(n, m)
  row.addEventListener('click', () => pickAudio(dragPayload))
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/plain', dragPayload)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  })
  return row
}

/**
 * Rebuild the right-pane list. Clips first (that's what editing touches), then
 * the source pool below. An edit-selected clip row gets the `.sel` marker too.
 */
function renderAudioList(): void {
  const host = document.getElementById('audio-list')
  if (!host) return
  host.textContent = ''

  const secC = document.createElement('div')
  secC.className = 'al-section'
  let nClips = 0
  const rows: HTMLElement[] = []
  for (const lane of lanes) {
    if (lane.inst) continue // instrument lanes list their MIDI in the piano roll, not a rendered clip
    for (const c of lane.clips) {
      nClips++
      const src = getSource(c.sourceId)
      const row = alRow(
        c.name,
        `T${lane.id} · ${src?.name ?? '?'} · ${fmtDur(c.lengthFrames)}`,
        `clip:${lane.id}:${c.id}`
      )
      if (selClips.has(c.id)) row.classList.add('sel')
      rows.push(row)
    }
  }
  secC.innerHTML = `<h4>Clips · ${nClips}</h4>`
  for (const r of rows) secC.appendChild(r)
  host.appendChild(secC)

  const srcs = sourceList().filter((s) => s.kind !== 'inst')
  const secS = document.createElement('div')
  secS.className = 'al-section'
  secS.innerHTML = `<h4>Sources · ${srcs.length}</h4>`
  for (const s of srcs) {
    secS.appendChild(
      alRow(s.name, `${s.gpu.channelCount}ch · ${fmtDur(s.gpu.totalFrames)} · ×${s.refCount}`, `src:${s.id}`)
    )
  }
  host.appendChild(secS)
}

// ===== timeline clip editing (tools: select / split / range / erase) =========

/** Selected clip ids (edit selection; separate from the lane / detail selection). */
const selClips = new Set<number>()
/** Range selection on a single lane, or null. */
let rangeSel: { laneId: number; start: number; end: number } | null = null

/** Trim / fade hit zone at a clip edge, in CSS px. */
const HANDLE_PX = 7

const srcTotalOf = (c: Clip): number => getSource(c.sourceId)?.gpu.totalFrames ?? clipEnd(c) - c.startFrame + c.srcOffset

/** After a structural edit: recompute totals, refresh the list, force a redraw. */
function afterEdit(...dirty: Lane[]): void {
  for (const l of dirty) l.dirty = true
  refreshTotals()
  renderAudioList()
  viewDirty = true
}

interface ClipHit {
  clip: Clip
  zone: 'body' | 'trim-l' | 'trim-r' | 'fade-l' | 'fade-r'
}

/** What (if anything) is under the pointer in this lane's centre column. */
function hitTestClip(lane: Lane, clientX: number, clientY: number): ClipHit | null {
  const r = (lane.el.querySelector('.lane-center') as HTMLElement).getBoundingClientRect()
  const x = clientX - r.left
  const frame = state.scrollFrames + x * state.framesPerPixel
  const nearTop = clientY - r.top < r.height * 0.4
  // Iterate back-to-front so the topmost (last drawn) clip wins.
  for (let i = lane.clips.length - 1; i >= 0; i--) {
    const c = lane.clips[i]
    if (frame < c.startFrame || frame > clipEnd(c)) continue
    const xL = (c.startFrame - state.scrollFrames) / state.framesPerPixel
    const xR = (clipEnd(c) - state.scrollFrames) / state.framesPerPixel
    if (x - xL <= HANDLE_PX) return { clip: c, zone: nearTop ? 'fade-l' : 'trim-l' }
    if (xR - x <= HANDLE_PX) return { clip: c, zone: nearTop ? 'fade-r' : 'trim-r' }
    return { clip: c, zone: 'body' }
  }
  return null
}

/** Lane whose row contains client-Y (for cross-lane drag). */
function laneAtClientY(clientY: number): Lane | undefined {
  return lanes.find((l) => {
    const r = l.el.getBoundingClientRect()
    return clientY >= r.top && clientY < r.bottom
  })
}

function setSelection(ids: number[]): void {
  selClips.clear()
  for (const id of ids) selClips.add(id)
  viewDirty = true
}

// ---- undo / redo (snapshot of every lane's clip list) --------------------
// Sources are never freed on an edit (see releaseSource), so restoring a clip
// list is always safe — its buffers are still there.

interface EditSnapshot {
  lanes: { id: number; clips: Clip[] }[]
  sel: number[]
  range: { laneId: number; start: number; end: number } | null
}
const undoStack: EditSnapshot[] = []
const redoStack: EditSnapshot[] = []
const UNDO_LIMIT = 120

function snapshot(): EditSnapshot {
  return {
    lanes: lanes.map((l) => ({ id: l.id, clips: l.clips.map((c) => ({ ...c })) })),
    sel: [...selClips],
    range: rangeSel ? { ...rangeSel } : null
  }
}

/** Record the pre-edit state. Call once, BEFORE mutating clips in an op. */
function pushUndo(): void {
  undoStack.push(snapshot())
  if (undoStack.length > UNDO_LIMIT) undoStack.shift()
  redoStack.length = 0
}

function applySnapshot(s: EditSnapshot): void {
  for (const ls of s.lanes) {
    const lane = laneById(ls.id)
    if (lane) lane.clips = ls.clips.map((c) => ({ ...c }))
  }
  selClips.clear()
  for (const id of s.sel) selClips.add(id)
  rangeSel = s.range ? { ...s.range } : null
  for (const l of lanes) l.dirty = true
  refreshTotals()
  renderAudioList()
  viewDirty = true
}

function undo(): void {
  const s = undoStack.pop()
  if (!s) return
  redoStack.push(snapshot())
  applySnapshot(s)
}

function redo(): void {
  const s = redoStack.pop()
  if (!s) return
  undoStack.push(snapshot())
  applySnapshot(s)
}

/** Clear history — on project load / teardown (lane set changes wholesale). */
function resetHistory(): void {
  undoStack.length = 0
  redoStack.length = 0
}

/** Slip-clear [start,end) on a lane: whole clips vanish, straddlers get trimmed/split. */
function clearRange(lane: Lane, start: number, end: number): void {
  if (end <= start) return
  const next: Clip[] = []
  for (const c of lane.clips) {
    const cs = c.startFrame
    const ce = clipEnd(c)
    if (ce <= start || cs >= end) {
      next.push(c)
    } else if (cs >= start && ce <= end) {
      releaseSource(c.sourceId)
      selClips.delete(c.id)
    } else if (cs < start && ce > end) {
      const right = splitClip(c, end) // c → [cs,end)
      if (right) retainSource(right.sourceId)
      trimClipRight(c, start, srcTotalOf(c)) // c → [cs,start)
      next.push(c)
      if (right) next.push(right)
    } else if (cs < start) {
      trimClipRight(c, start, srcTotalOf(c))
      next.push(c)
    } else {
      trimClipLeft(c, end)
      next.push(c)
    }
  }
  lane.clips = next
}

/** Trailing "_NN" so re-splitting a piece doesn't stack suffixes. */
const clipBaseName = (name: string): string => name.replace(/_\d{2,}$/, '')

/** Next free "base_NN" across every lane's clips (2-digit, grows to 3+ if needed). */
function numberedClipName(base: string): string {
  const taken = new Set(lanes.flatMap((l) => l.clips.map((c) => c.name)))
  let n = 1
  while (taken.has(`${base}_${String(n).padStart(2, '0')}`)) n++
  return `${base}_${String(n).padStart(2, '0')}`
}

/** Renumber a clip and its freshly-split right piece as base_NN / base_NN+1. */
function numberSplitPair(left: Clip, right: Clip): void {
  const base = clipBaseName(left.name)
  left.name = numberedClipName(base)
  right.name = numberedClipName(base)
}

/** Split the clip under the scissors at `atFrame`; select the right-hand piece. */
function splitAt(lane: Lane, clip: Clip, atFrame: number): void {
  if (atFrame <= clip.startFrame || atFrame >= clipEnd(clip)) return
  pushUndo()
  const right = splitClip(clip, atFrame)
  if (!right) return
  retainSource(right.sourceId)
  numberSplitPair(clip, right)
  lane.clips.splice(lane.clips.indexOf(clip) + 1, 0, right)
  setSelection([right.id])
  afterEdit(lane)
}

/** Generic drag session: window-level move/up, auto-cleanup. */
function beginDrag(onMove: (e: PointerEvent) => void, onUp?: () => void): void {
  const move = (e: PointerEvent): void => onMove(e)
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onUp?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** pointerdown on the tracks area — routes to the active edit tool. */
function onEditPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  const laneEl = (e.target as HTMLElement).closest('.lane')
  const lane = lanes.find((l) => l.el === laneEl)
  if (!lane) return
  if (lane.inst) return // the rendered audio is not edited directly; double-click opens the notes
  const centerR = (lane.el.querySelector('.lane-center') as HTMLElement).getBoundingClientRect()
  if (e.clientX < centerR.left || e.clientX > centerR.right) return // left/right gutters
  const frameAt = (clientX: number): number => state.scrollFrames + (clientX - centerR.left) * state.framesPerPixel

  const tool = state.editTool
  const hit = hitTestClip(lane, e.clientX, e.clientY)

  if (tool === 'split') {
    e.stopPropagation()
    if (hit) splitAt(lane, hit.clip, snapFrame(frameAt(e.clientX)))
    return
  }

  if (tool === 'range') {
    e.stopPropagation()
    const a = snapFrame(frameAt(e.clientX))
    rangeSel = { laneId: lane.id, start: a, end: a }
    setSelection([])
    viewDirty = true
    beginDrag((ev) => {
      const b = snapFrame(frameAt(ev.clientX))
      rangeSel = { laneId: lane.id, start: Math.max(0, Math.min(a, b)), end: Math.max(a, b) }
      viewDirty = true
    })
    return
  }

  // ---- select tool -------------------------------------------------------
  if (!hit) {
    setSelection([]) // empty click: clear selection, let the seek handler run
    rangeSel = null
    return
  }
  e.stopPropagation()
  const c = hit.clip
  if (e.shiftKey) {
    if (selClips.has(c.id)) selClips.delete(c.id)
    else selClips.add(c.id)
    viewDirty = true
  } else if (!selClips.has(c.id)) {
    setSelection([c.id])
  }
  rangeSel = null

  // Undo is captured on the first actual move so a bare click doesn't add history.
  let armed = false
  const arm = (): void => {
    if (!armed) {
      pushUndo()
      armed = true
    }
  }

  if (hit.zone === 'trim-l' || hit.zone === 'trim-r') {
    beginDrag((ev) => {
      arm()
      const f = snapFrame(frameAt(ev.clientX))
      if (hit.zone === 'trim-l') trimClipLeft(c, f)
      else trimClipRight(c, f, srcTotalOf(c))
      lane.dirty = true
      viewDirty = true
    }, () => afterEdit(lane))
    return
  }

  if (hit.zone === 'fade-l' || hit.zone === 'fade-r') {
    beginDrag((ev) => {
      arm()
      const f = frameAt(ev.clientX)
      if (hit.zone === 'fade-l') c.fadeIn = Math.max(0, Math.round(f - c.startFrame))
      else c.fadeOut = Math.max(0, Math.round(clipEnd(c) - f))
      clampFades(c)
      viewDirty = true
    }, () => afterEdit(lane))
    return
  }

  // body drag = move (horizontal always; vertical → another lane when a single clip)
  const originX = e.clientX
  const originStart = new Map<number, number>()
  for (const l of lanes) for (const cc of l.clips) if (selClips.has(cc.id)) originStart.set(cc.id, cc.startFrame)
  const soloMove = selClips.size <= 1
  let movedToLane = lane
  beginDrag(
    (ev) => {
      arm()
      const rawDelta = (ev.clientX - originX) * state.framesPerPixel
      const snappedStart = snapFrame((originStart.get(c.id) ?? c.startFrame) + rawDelta)
      const delta = snappedStart - (originStart.get(c.id) ?? c.startFrame)
      for (const l of lanes)
        for (const cc of l.clips)
          if (originStart.has(cc.id)) cc.startFrame = Math.max(0, (originStart.get(cc.id) as number) + delta)
      if (soloMove) {
        const tgt = laneAtClientY(ev.clientY)
        if (tgt && tgt !== movedToLane) {
          const from = movedToLane
          from.clips.splice(from.clips.indexOf(c), 1)
          tgt.clips.push(c)
          from.dirty = true
          tgt.dirty = true
          movedToLane = tgt
        }
      }
      lane.dirty = true
      movedToLane.dirty = true
      viewDirty = true
    },
    () => afterEdit(lane, movedToLane)
  )
}

/** Delete key: drop selected clips, or clear the active range. */
function deleteSelection(): void {
  if (rangeSel) {
    const lane = laneById(rangeSel.laneId)
    if (lane && rangeSel.end > rangeSel.start) {
      pushUndo()
      clearRange(lane, rangeSel.start, rangeSel.end)
      afterEdit(lane)
    }
    rangeSel = null
    return
  }
  if (selClips.size === 0) return
  pushUndo()
  const touched: Lane[] = []
  for (const l of lanes) {
    const keep = l.clips.filter((c) => {
      if (!selClips.has(c.id)) return true
      releaseSource(c.sourceId)
      return false
    })
    if (keep.length !== l.clips.length) {
      l.clips = keep
      touched.push(l)
    }
  }
  selClips.clear()
  if (touched.length) afterEdit(...touched)
}

// ---- clipboard + Edit-menu operations -----------------------------------

interface ClipboardEntry {
  sourceId: number
  name: string
  /** Frames from the copied span's start to this piece's start. */
  offset: number
  srcOffset: number
  lengthFrames: number
  fadeIn: number
  fadeOut: number
  fadeInShape: FadeShape
  fadeOutShape: FadeShape
  gainDb: number
}
/** Timeline clipboard: pieces + the span they occupied (for overwrite paste). */
let clipboard: { span: number; entries: ClipboardEntry[] } | null = null

const allClipIds = (): number[] => lanes.flatMap((l) => l.clips.map((c) => c.id))

/** The lane a paste / single-lane copy targets: the selected track, else lane 0. */
function activeLane(): Lane | undefined {
  if (typeof selectedId === 'number') return laneById(selectedId)
  return lanes[0]
}

/** Snapshot the current selection (or active range) to the clipboard. */
function copySelection(): void {
  if (rangeSel) {
    const lane = laneById(rangeSel.laneId)
    if (!lane) return
    const { start, end } = rangeSel
    if (end <= start) return
    const entries: ClipboardEntry[] = []
    for (const c of lane.clips) {
      const a = Math.max(c.startFrame, start)
      const b = Math.min(clipEnd(c), end)
      if (b <= a) continue
      const head = a - c.startFrame
      entries.push({
        sourceId: c.sourceId,
        name: c.name,
        offset: a - start,
        srcOffset: c.srcOffset + head,
        lengthFrames: b - a,
        fadeIn: a === c.startFrame ? c.fadeIn : 0,
        fadeOut: b === clipEnd(c) ? c.fadeOut : 0,
        fadeInShape: c.fadeInShape,
        fadeOutShape: c.fadeOutShape,
        gainDb: c.gainDb
      })
    }
    if (entries.length) clipboard = { span: end - start, entries }
    return
  }
  // Selected whole clips (single lane: the one holding the first selected clip).
  const host = lanes.find((l) => l.clips.some((c) => selClips.has(c.id)))
  if (!host) return
  const picked = host.clips.filter((c) => selClips.has(c.id))
  const base = Math.min(...picked.map((c) => c.startFrame))
  const tail = Math.max(...picked.map(clipEnd))
  clipboard = {
    span: tail - base,
    entries: picked.map((c) => ({
      sourceId: c.sourceId,
      name: c.name,
      offset: c.startFrame - base,
      srcOffset: c.srcOffset,
      lengthFrames: c.lengthFrames,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
      fadeInShape: c.fadeInShape,
      fadeOutShape: c.fadeOutShape,
      gainDb: c.gainDb
    }))
  }
}

/** Overwrite-paste the clipboard at the playhead on the active lane. */
function pasteClipboard(): void {
  if (!clipboard) return
  const lane = activeLane()
  if (!lane) return
  pushUndo()
  const at = snapFrame(state.playhead)
  clearRange(lane, at, at + clipboard.span) // overwrite mode
  for (const e of clipboard.entries) {
    const clip = makeClip({
      sourceId: e.sourceId,
      name: e.name,
      startFrame: at + e.offset,
      srcOffset: e.srcOffset,
      lengthFrames: e.lengthFrames,
      fadeIn: e.fadeIn,
      fadeOut: e.fadeOut,
      fadeInShape: e.fadeInShape,
      fadeOutShape: e.fadeOutShape,
      gainDb: e.gainDb
    })
    retainSource(e.sourceId)
    lane.clips.push(clip)
  }
  lane.clips.sort((a, b) => a.startFrame - b.startFrame)
  afterEdit(lane)
}

/** Split any clip on `lane` that a cut frame falls strictly inside. Returns true if it cut. */
function separateClipsAt(lane: Lane, cutFrames: number[]): boolean {
  let did = false
  for (const a of [...new Set(cutFrames)].sort((x, y) => x - y)) {
    for (const c of [...lane.clips]) {
      if (a <= c.startFrame || a >= clipEnd(c)) continue
      const right = splitClip(c, a)
      if (!right) continue
      retainSource(right.sourceId)
      numberSplitPair(c, right)
      lane.clips.splice(lane.clips.indexOf(c) + 1, 0, right)
      did = true
    }
  }
  return did
}

/**
 * Split command (Edit ▸ Split / Ctrl+E):
 *  - with a Range active → "separate at selection": cut every clip on that lane
 *    at both range edges.
 *  - otherwise → cut at the playhead (selected clips, or any clip under it).
 */
function splitCmd(): void {
  if (rangeSel) {
    const lane = laneById(rangeSel.laneId)
    if (!lane) return
    const cuts = [rangeSel.start, rangeSel.end]
    if (!lane.clips.some((c) => cuts.some((a) => a > c.startFrame && a < clipEnd(c)))) return
    pushUndo()
    separateClipsAt(lane, cuts)
    afterEdit(lane)
    return
  }
  const at = state.playhead
  const hit = (c: Clip): boolean =>
    (selClips.size ? selClips.has(c.id) : true) && at > c.startFrame && at < clipEnd(c)
  const touched = lanes.filter((l) => l.clips.some(hit))
  if (!touched.length) return
  pushUndo()
  for (const lane of touched) separateClipsAt(lane, [at])
  afterEdit(...touched)
}

/** Route an Edit-menu / shortcut op — but let native field edits pass through. */
function runEditOp(op: string): void {
  const ae = document.activeElement as HTMLElement | null
  const inField = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
  if (inField && ['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo'].includes(op)) {
    document.execCommand(op === 'selectAll' ? 'selectAll' : op)
    return
  }
  switch (op) {
    case 'undo':
      undo()
      break
    case 'redo':
      redo()
      break
    case 'copy':
      copySelection()
      break
    case 'cut':
      copySelection()
      deleteSelection()
      break
    case 'paste':
      pasteClipboard()
      break
    case 'delete':
      deleteSelection()
      break
    case 'split':
      splitCmd()
      break
    case 'selectAll':
      rangeSel = null
      setSelection(allClipIds())
      break
    case 'deselect':
      rangeSel = null
      setSelection([])
      break
  }
}

/** Set the active edit tool + reflect it on the toolbar / cursor. */
function setTool(t: EditTool): void {
  update({ editTool: t })
  for (const b of document.querySelectorAll<HTMLButtonElement>('#toolbar .tool'))
    b.classList.toggle('on', b.dataset.tool === t)
  tracksEl.dataset.tool = t
  if (t !== 'range') rangeSel = null
  viewDirty = true
}

/**
 * An instrument lane shows its MIDI, not the audio the GPU renders from it: indigo background, one
 * block per MIDI clip, a bar per note (all clips share one pitch scale; drums are coloured per voice).
 */
function drawMidiClips(lane: Lane, g: CanvasRenderingContext2D, cssW: number, cssH: number, toX: (f: number) => number): void {
  g.fillStyle = '#14122a'
  g.fillRect(0, 0, cssW, cssH)
  const mt = lane.inst ? midiTrackById(lane.inst.midiTrackId) : undefined
  if (!mt) return
  const drums = mt.instrument?.kind === 'drums'
  const { bpm, sampleRate: sr } = state
  const sel = lane.id === selectedId
  const bf = (b: number): number => beatsToFrames(b, bpm, sr)

  let lo = 127
  let hi = 0
  for (const c of mt.clips) for (const n of c.notes) {
    if (n.key < lo) lo = n.key
    if (n.key > hi) hi = n.key
  }
  if (hi < lo) {
    lo = 60
    hi = 72
  }
  const span = Math.max(12, hi - lo + 1) // at least an octave, so a lone note does not fill the lane
  const top = (lo + hi) / 2 + span / 2 // key at the top edge
  const y0 = 13
  const rowH = (cssH - y0 - 2) / span

  for (const c of mt.clips) {
    const xL = toX(bf(c.start))
    const xR = toX(bf(c.start + c.length))
    if (xR < 0 || xL > cssW) continue
    g.fillStyle = sel ? 'rgba(139,123,255,0.22)' : 'rgba(139,123,255,0.13)'
    g.fillRect(xL, 0, xR - xL, cssH)
    for (const n of c.notes) {
      const x1 = toX(bf(c.start + n.start))
      const x2 = toX(bf(c.start + n.start + n.dur))
      if (x2 < 0 || x1 > cssW) continue
      const y = y0 + (top - n.key - 1) * rowH
      const a = 0.45 + 0.55 * (n.vel / 127)
      g.fillStyle = drums ? `hsla(${(n.key * 37) % 360},70%,66%,${a})` : `rgba(190,178,255,${a})`
      g.fillRect(x1, y, Math.max(1.5, x2 - x1 - 0.5), Math.max(1.5, rowH - 0.5))
    }
    g.strokeStyle = sel ? '#b9afff' : 'rgba(150,135,255,0.55)'
    g.strokeRect(Math.round(xL) + 0.5, 0.5, Math.max(1, Math.round(xR - xL) - 1), cssH - 1)
    const nameW = xR - xL - 8
    if (nameW > 12) {
      g.save()
      g.beginPath()
      g.rect(xL + 4, 0, nameW, 12)
      g.clip()
      g.fillStyle = sel ? '#ece9ff' : 'rgba(205,198,255,0.8)'
      g.font = '10px -apple-system, "Segoe UI", sans-serif'
      g.textBaseline = 'top'
      g.fillText(`${c.name}  ·  ${c.notes.length} notes`, xL + 5, 1)
      g.restore()
    }
  }
}

/** A line-input lane has no clips: an amber band says where it is live. */
function drawLiveLane(lane: Lane, g: CanvasRenderingContext2D, cssW: number, cssH: number): void {
  g.fillStyle = '#241a0c'
  g.fillRect(0, 0, cssW, cssH)
  g.fillStyle = 'rgba(255,180,84,0.10)'
  g.fillRect(0, 0, cssW, cssH)
  g.strokeStyle = 'rgba(255,180,84,0.35)'
  g.strokeRect(0.5, 0.5, cssW - 1, cssH - 1)
  g.fillStyle = 'rgba(255,200,130,0.85)'
  g.font = '11px -apple-system, "Segoe UI", sans-serif'
  g.textBaseline = 'middle'
  g.fillText(`LINE IN · ${lane.recIn.stereo ? `In ${lane.recIn.ch + 1}-${lane.recIn.ch + 2}` : `In ${lane.recIn.ch + 1}`} · live through strip + inserts${lane.live?.monitor ? '' : ' (monitor off)'}`, 10, cssH / 2)
}

/** Draw one lane's clip chrome (borders / selection / fades / handles / range). */
function drawLaneFx(lane: Lane): void {
  const g = lane.fxCtx
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const cssW = lane.fx.clientWidth
  const cssH = lane.fx.clientHeight
  const w = Math.max(1, Math.floor(cssW * dpr))
  const h = Math.max(1, Math.floor(cssH * dpr))
  if (lane.fx.width !== w) lane.fx.width = w
  if (lane.fx.height !== h) lane.fx.height = h
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, cssW, cssH)

  const fpp = state.framesPerPixel
  const toX = (f: number): number => (f - state.scrollFrames) / fpp

  if (lane.inst) drawMidiClips(lane, g, cssW, cssH, toX)
  else if (lane.live) drawLiveLane(lane, g, cssW, cssH)

  // (an instrument lane's rendered audio clip is an implementation detail, not drawn or edited)
  for (const c of lane.inst ? [] : lane.clips) {
    const xL = toX(c.startFrame)
    const xR = toX(clipEnd(c))
    if (xR < 0 || xL > cssW) continue
    const sel = selClips.has(c.id)

    if (sel) {
      g.fillStyle = 'rgba(255,255,255,0.16)'
      g.fillRect(xL, 0, xR - xL, cssH)
    }
    // fade ramps
    g.strokeStyle = sel ? 'rgba(255,255,255,0.95)' : 'rgba(25,28,34,0.6)'
    g.lineWidth = 1
    if (c.fadeIn > 0) {
      g.beginPath()
      g.moveTo(xL, cssH)
      g.lineTo(xL + c.fadeIn / fpp, 0)
      g.stroke()
    }
    if (c.fadeOut > 0) {
      g.beginPath()
      g.moveTo(xR - c.fadeOut / fpp, 0)
      g.lineTo(xR, cssH)
      g.stroke()
    }
    // outline
    g.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.28)' // no green frame: a faint dark edge, white when selected
    g.strokeRect(Math.round(xL) + 0.5, 0.5, Math.max(1, Math.round(xR - xL) - 1), cssH - 1)
    // name
    const nameW = xR - xL - 8
    if (nameW > 12) {
      g.save()
      g.beginPath()
      g.rect(xL + 4, 0, nameW, 13)
      g.clip()
      g.fillStyle = sel ? '#ffffff' : 'rgba(18,21,27,0.78)'
      g.font = '10px -apple-system, "Segoe UI", sans-serif'
      g.textBaseline = 'top'
      g.fillText(c.name, xL + 5, 2)
      g.restore()
    }
    // corner fade handles (only when selected)
    if (sel) {
      g.fillStyle = '#ffffff'
      g.fillRect(xL - 3, 0, 6, 6)
      g.fillRect(xR - 3, 0, 6, 6)
    }
  }

  if (rangeSel && rangeSel.laneId === lane.id) {
    const rx = toX(rangeSel.start)
    const rw = (rangeSel.end - rangeSel.start) / fpp
    g.fillStyle = 'rgba(90,170,255,0.16)'
    g.fillRect(rx, 0, rw, cssH)
    g.strokeStyle = 'rgba(90,170,255,0.7)'
    g.strokeRect(rx + 0.5, 0.5, Math.max(1, rw - 1), cssH - 1)
  }
}

/** Select a track, the master bus, or nothing; highlight + rebuild the detail pane. */
function selectLane(id: number | 'master' | null): void {
  if (id === selectedId) return
  selectedId = id
  for (const l of lanes) {
    l.el.classList.toggle('selected', l.id === id)
    l.strip.el.classList.toggle('selected', l.id === id) // mixer strip: highlight the fader area
  }
  for (const g of groups) g.strip.el.classList.toggle('selected', g.id === id)
  masterStripEl.classList.toggle('selected', id === 'master')
  renderDetail()
}

const pct = (v: number): string => `${Math.round(v * 100)}%`
const db1 = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`

/** Checkbox row: [checkbox][label]. */
function checkRow(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): void {
  const row = document.createElement('label')
  row.className = 'td-check'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = value
  cb.addEventListener('change', () => onChange(cb.checked))
  const sp = document.createElement('span')
  sp.textContent = label
  row.append(cb, sp)
  parent.appendChild(row)
}

/** Log-frequency rotary knob (20 Hz .. 20 kHz). */
function freqKnob(label: string, value: number, def: number, set: (f: number) => void): HTMLElement {
  const l2 = Math.log2
  return makeKnob({
    min: l2(20),
    max: l2(20000),
    value: l2(Math.max(20, value)),
    default: l2(Math.max(20, def)),
    label,
    fmt: (v) => {
      const f = 2 ** v
      return f >= 1000 ? `${(f / 1000).toFixed(2)}k` : `${f | 0}`
    },
    onInput: (v) => set(2 ** v)
  })
}

/** Rotary knob (vertical drag; double-click resets). Returns its cell element.
 * `bind` hands back a setter so an outside source (e.g. the mixer strip) can
 * push the knob to a new position without firing `onInput`. */
function makeKnob(o: {
  min: number
  max: number
  value: number
  default?: number
  label?: string
  fmt: (v: number) => string
  onInput: (v: number) => void
  onDown?: () => void
  bind?: (set: (v: number) => void) => void
}): HTMLElement {
  const cell = document.createElement('div')
  cell.className = 'knob-cell'
  if (o.label) {
    const lab = document.createElement('div')
    lab.className = 'knob-label'
    lab.textContent = o.label
    cell.appendChild(lab)
  }
  const knob = document.createElement('div')
  knob.className = 'knob'
  // scale ticks at the clock 2-hour marks inside the 270° sweep (8/10/12/2/4
  // o'clock), 12 o'clock as the centre major.
  for (const a of [-120, -60, 0, 60, 120]) {
    const tk = document.createElement('b')
    if (a === 0) tk.className = 'major'
    tk.style.transform = `rotate(${a}deg) translateY(-27px)`
    knob.appendChild(tk)
  }
  const ind = document.createElement('i')
  knob.appendChild(ind)
  const val = document.createElement('div')
  val.className = 'knob-val'
  cell.append(knob, val)

  let v = o.value
  const render = (): void => {
    const t = (v - o.min) / (o.max - o.min)
    ind.style.transform = `rotate(${(-135 + t * 270).toFixed(1)}deg)`
    val.textContent = o.fmt(v)
  }
  render()
  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    knob.setPointerCapture(e.pointerId)
    o.onDown?.()
    const y0 = e.clientY
    const v0 = v
    const span = o.max - o.min
    const move = (ev: PointerEvent): void => {
      v = Math.max(o.min, Math.min(o.max, v0 - ((ev.clientY - y0) / 140) * span))
      render()
      o.onInput(v)
    }
    const up = (): void => {
      knob.removeEventListener('pointermove', move)
      knob.removeEventListener('pointerup', up)
    }
    knob.addEventListener('pointermove', move)
    knob.addEventListener('pointerup', up)
  })
  knob.addEventListener('dblclick', () => {
    v = o.default ?? o.min
    render()
    o.onInput(v)
  })
  o.bind?.((nv) => {
    v = Math.max(o.min, Math.min(o.max, nv))
    render()
  })
  return cell
}

/** A titled detail-pane section container. */
function section(title: string): HTMLElement {
  const s = document.createElement('div')
  s.className = 'td-section'
  const h = document.createElement('h4')
  h.textContent = title
  s.appendChild(h)
  return s
}

/**
 * The insert plugins that can be dropped into a strip slot. The built-in channel
 * strip (`ChannelStrip`) is deliberately absent — it is part of the track, not a
 * plugin. `is()` maps a live instance back to its kind for the slot label.
 */
interface FxKind {
  label: string
  short: string
  make: () => Insert
  is: (fx: Insert) => boolean
  /** Only offered on the master bus (bus comp / maximizer). */
  masterOnly?: boolean
}
const FX_KINDS: FxKind[] = [
  { label: 'Reverb', short: 'Reverb', make: () => new ReverbInsert(), is: (fx) => fx instanceof ReverbInsert },
  { label: 'Delay', short: 'Delay', make: () => new DelayInsert(), is: (fx) => fx instanceof DelayInsert },
  { label: '5-band EQ', short: 'EQ-5', make: () => new Eq5Insert(), is: (fx) => fx instanceof Eq5Insert },
  { label: 'Tube EQ', short: 'TubeEQ', make: () => new TubeEqInsert(), is: (fx) => fx instanceof TubeEqInsert },
  { label: 'Awaker Enhancer', short: 'Awaker', make: () => new AwakerInsert(), is: (fx) => fx instanceof AwakerInsert },
  { label: 'Bus Comp', short: 'BusComp', make: () => new BusCompInsert(), is: (fx) => fx instanceof BusCompInsert, masterOnly: true },
  { label: 'Maximizer', short: 'Maxim', make: () => new MaximizerInsert(), is: (fx) => fx instanceof MaximizerInsert, masterOnly: true }
]
/** Fixed insert-slot count per strip (classic rack). */
const SLOT_COUNT = 8

function fxLabel(fx: Insert): string {
  return FX_KINDS.find((k) => k.is(fx))?.label ?? fx.name
}
function fxShort(fx: Insert): string {
  return FX_KINDS.find((k) => k.is(fx))?.short ?? fx.name
}

// ---- floating plugin windows ---------------------------------------------------
// Classic behaviour: normally a single un-pinned window is shown — opening
// another closes it. Pin (📌) a window and it stays put; later un-pinned opens
// only replace each other. Non-modal — the mixer / tracks stay interactive.

interface PlugWin {
  fx: Insert
  owner: number | 'master'
  el: HTMLElement
  pinned: boolean
}
const plugWins = new Map<Insert, PlugWin>()
let plugZ = 30
let plugCascade = 0

/** Live LUFS readout owned by an open Maximizer window (Momentary / Short-term / Integrated / Maximum value cells). */
let lufsReadout: {
  fx: Insert
  m: HTMLElement
  s: HTMLElement
  i: HTMLElement
  mx: HTMLElement
} | null = null

function raisePlugWin(w: PlugWin): void {
  w.el.style.zIndex = String(++plugZ)
}

function closePlugWin(fx: Insert): void {
  const w = plugWins.get(fx)
  if (!w) return
  w.el.remove()
  plugWins.delete(fx)
  if (lufsReadout?.fx === fx) lufsReadout = null
}

/** Drop every un-pinned window (called before opening a fresh one). */
function closeUnpinnedPlugWins(): void {
  for (const [fx, w] of plugWins) if (!w.pinned) closePlugWin(fx)
}

/** Drop all plugin windows (project reload / teardown). */
function closeAllPlugWins(): void {
  for (const w of plugWins.values()) w.el.remove()
  plugWins.clear()
  lufsReadout = null
}

/** Display name for a plugin-window owner: the track title, or "MASTER". */
function ownerLabel(owner: number | 'master'): string {
  if (owner === 'master') return 'MASTER'
  const grp = groupById(owner)
  if (grp) return grp.name
  const lane = lanes.find((l) => l.id === owner)
  return (lane?.el.querySelector('.lane-title') as HTMLElement | null)?.textContent || `Track ${owner}`
}

/** Open the floating editor for `fx`, or raise it if already open. */
function openPlugWin(fx: Insert, owner: number | 'master'): void {
  const open = plugWins.get(fx)
  if (open) {
    raisePlugWin(open)
    return
  }
  closeUnpinnedPlugWins() // default: one un-pinned window at a time

  const el = document.createElement('div')
  el.className = 'plug-win'
  const bar = document.createElement('div')
  bar.className = 'plug-win-bar'
  const nm = document.createElement('span')
  nm.className = 'pw-name'
  nm.textContent = `${fxLabel(fx)} - ${ownerLabel(owner)}`
  nm.title = nm.textContent
  const spacer = document.createElement('span')
  spacer.className = 'pw-spacer'
  const byp = document.createElement('button')
  byp.className = 'pw-byp'
  byp.textContent = '●'
  byp.title = 'bypass'
  byp.classList.toggle('on', fx.bypass)
  const pin = document.createElement('button')
  pin.className = 'pw-pin'
  pin.textContent = '📌'
  pin.title = 'pin — keep open when other plugins are opened'
  const close = document.createElement('button')
  close.className = 'pw-close'
  close.textContent = '×'
  close.title = 'close'
  bar.append(nm, spacer, byp, pin, close)
  const body = document.createElement('div')
  body.className = 'plug-win-body'
  const panel = document.createElement('div') // inset control panel (console-style)
  panel.className = 'plug-panel'
  // Reverb / Delay have few controls — give them a taller, airier panel.
  if (fx instanceof ReverbInsert || fx instanceof DelayInsert) panel.classList.add('plug-panel-tall')
  buildFxParams(panel, fx)
  body.appendChild(panel)
  el.append(bar, body)
  document.body.appendChild(el)

  const w: PlugWin = { fx, owner, el, pinned: false }
  plugWins.set(fx, w)

  byp.addEventListener('click', () => {
    fx.bypass = !fx.bypass
    byp.classList.toggle('on', fx.bypass)
    renderStripRack(w.owner)
    if (w.owner === selectedId) renderDetail()
  })
  pin.addEventListener('click', () => {
    w.pinned = !w.pinned
    el.classList.toggle('pinned', w.pinned)
    pin.classList.toggle('on', w.pinned)
  })
  close.addEventListener('click', () => closePlugWin(fx))

  // cascade placement, keeping the window on screen
  const bx = 140 + (plugCascade % 6) * 30
  const by = 96 + (plugCascade % 6) * 30
  plugCascade++
  el.style.left = `${bx}px`
  el.style.top = `${by}px`
  raisePlugWin(w)

  el.addEventListener('pointerdown', () => raisePlugWin(w))
  bar.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    bar.setPointerCapture(e.pointerId)
    raisePlugWin(w)
    const r = el.getBoundingClientRect()
    const dx = e.clientX - r.left
    const dy = e.clientY - r.top
    const move = (ev: PointerEvent): void => {
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 44, ev.clientX - dx))}px`
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 22, ev.clientY - dy))}px`
    }
    const up = (): void => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
  })
}

// ---- insert-slot rack (mixer strip + left detail pane) --------------------

let fxMenuEl: HTMLElement | null = null
function closeFxMenu(): void {
  if (!fxMenuEl) return
  fxMenuEl.remove()
  fxMenuEl = null
  window.removeEventListener('pointerdown', fxMenuDocDown, true)
}
function fxMenuDocDown(e: PointerEvent): void {
  if (fxMenuEl && !fxMenuEl.contains(e.target as Node)) closeFxMenu()
}

/** Pop menu anchored under `anchor`: pick a plugin kind, plus reorder / remove. */
function openFxMenu(
  anchor: HTMLElement,
  opts: {
    owner: number | 'master'
    onPick: (make: () => Insert) => void
    onUp?: () => void
    onDown?: () => void
    onRemove?: () => void
  }
): void {
  closeFxMenu()
  const menu = document.createElement('div')
  menu.className = 'fx-menu'
  for (const k of FX_KINDS) {
    if (k.masterOnly && opts.owner !== 'master') continue // bus comp / maximizer: master bus only
    const b = document.createElement('button')
    b.textContent = k.label
    b.addEventListener('click', () => {
      opts.onPick(k.make)
      closeFxMenu()
    })
    menu.appendChild(b)
  }
  const item = (label: string, cls: string, fn: () => void): void => {
    const b = document.createElement('button')
    if (cls) b.className = cls
    b.textContent = label
    b.addEventListener('click', () => {
      fn()
      closeFxMenu()
    })
    menu.appendChild(b)
  }
  if (opts.onUp || opts.onDown || opts.onRemove) {
    const sep = document.createElement('div')
    sep.className = 'fx-menu-sep'
    menu.appendChild(sep)
    if (opts.onUp) item('Move up', '', opts.onUp)
    if (opts.onDown) item('Move down', '', opts.onDown)
    if (opts.onRemove) item('Remove', 'rm', opts.onRemove)
  }
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  menu.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - mw - 6))}px`
  menu.style.top =
    r.bottom + 4 + mh > window.innerHeight
      ? `${Math.max(6, r.top - mh - 4)}px`
      : `${r.bottom + 4}px`
  fxMenuEl = menu
  window.setTimeout(() => window.addEventListener('pointerdown', fxMenuDocDown, true))
}

/**
 * Draw `SLOT_COUNT` insert slots into a strip rack from a packed `Insert[]`.
 * Filled slot: [bypass ●][name][▾ replace/remove], name-click edits it in the
 * left detail pane. Empty slot: click opens the plugin pick menu (appends).
 * `owner` is the lane id or 'master' — used to refresh both UIs after a change.
 */
/** Status line message from module-level code (bound to boot()'s flashStatus once it exists). */
let notify: (msg: string, isErr?: boolean) => void = () => {}

/** The insert being dragged between slots (set on dragstart, cleared on dragend). */
let slotDrag: { fx: Insert; list: Insert[]; owner: number | 'master' } | null = null

/** Drop the dragged insert at `to` of `list` (same rack: reorder; another rack: move it there). */
function dropSlot(list: Insert[], owner: number | 'master', to: number): void {
  const d = slotDrag
  slotDrag = null
  if (!d) return
  const from = d.list.indexOf(d.fx)
  const masterOnly = FX_KINDS.find((k) => k.is(d.fx))?.masterOnly
  if (d.list !== list && masterOnly && owner !== 'master') {
    notify(`${fxLabel(d.fx)} can only sit on the master bus`, true)
    return
  }
  if (d.list !== list && list.length >= SLOT_COUNT) {
    notify('that rack is full', true)
    return
  }
  if (!moveSlot(d.list, from, list, to, SLOT_COUNT)) return
  if (d.owner !== owner) closePlugWin(d.fx) // its floating window belonged to the other channel
  refreshInsertsUI(d.owner)
  if (d.owner !== owner) refreshInsertsUI(owner)
}

function fillRack(rackEl: HTMLElement, list: Insert[], owner: number | 'master'): void {
  rackEl.replaceChildren()
  for (let i = 0; i < SLOT_COUNT; i++) {
    const fx: Insert | undefined = list[i]
    const slot = document.createElement('div')
    slot.className = fx ? 'strip-slot filled' : 'strip-slot'
    // drag a plug-in to another slot (same rack = reorder; another channel's rack = move it there)
    slot.addEventListener('dragover', (e) => {
      if (!slotDrag) return
      e.preventDefault()
      slot.classList.add('drop')
    })
    slot.addEventListener('dragleave', () => slot.classList.remove('drop'))
    slot.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      slot.classList.remove('drop')
      dropSlot(list, owner, fx ? i : list.length)
    })
    if (fx) {
      slot.draggable = true
      slot.title = 'drag to move to another slot (or another channel)'
      slot.addEventListener('dragstart', (e) => {
        slotDrag = { fx, list, owner }
        e.dataTransfer?.setData('text/plain', fxShort(fx))
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        slot.classList.add('dragging')
      })
      slot.addEventListener('dragend', () => {
        slot.classList.remove('dragging')
        slotDrag = null
        document.querySelectorAll('.strip-slot.drop').forEach((x) => x.classList.remove('drop'))
      })
    }
    if (fx) {
      const byp = document.createElement('button')
      byp.className = 'slot-byp'
      byp.textContent = '●'
      byp.title = 'bypass'
      byp.classList.toggle('on', fx.bypass)
      byp.addEventListener('pointerdown', (e) => e.stopPropagation())
      byp.addEventListener('click', (e) => {
        e.stopPropagation()
        fx.bypass = !fx.bypass
        byp.classList.toggle('on', fx.bypass)
        if (owner === selectedId) renderDetail()
      })
      const nm = document.createElement('span')
      nm.className = 'slot-name'
      nm.textContent = fxShort(fx)
      nm.title = `${fxLabel(fx)} — click to open`
      nm.addEventListener('click', (e) => {
        e.stopPropagation()
        openPlugWin(fx, owner)
      })
      const car = document.createElement('button')
      car.className = 'slot-caret'
      car.textContent = '▾'
      car.title = 'reorder / replace / remove'
      car.addEventListener('pointerdown', (e) => e.stopPropagation())
      car.addEventListener('click', (e) => {
        e.stopPropagation()
        openFxMenu(car, {
          owner,
          onPick: (make) => {
            closePlugWin(fx) // the replaced instance is gone — drop its window
            list[i] = make()
            refreshInsertsUI(owner)
          },
          onUp:
            i > 0
              ? () => {
                  ;[list[i - 1], list[i]] = [list[i], list[i - 1]]
                  refreshInsertsUI(owner)
                }
              : undefined,
          onDown:
            i < list.length - 1
              ? () => {
                  ;[list[i + 1], list[i]] = [list[i], list[i + 1]]
                  refreshInsertsUI(owner)
                }
              : undefined,
          onRemove: () => {
            closePlugWin(fx)
            list.splice(i, 1)
            refreshInsertsUI(owner)
          }
        })
      })
      slot.append(byp, nm, car)
    } else {
      const num = document.createElement('span')
      num.className = 'slot-num'
      num.textContent = String(i + 1)
      const add = document.createElement('span')
      add.className = 'slot-add'
      add.textContent = '＋'
      slot.append(num, add)
      slot.addEventListener('click', (e) => {
        e.stopPropagation()
        openFxMenu(slot, {
          owner,
          onPick: (make) => {
            list.push(make())
            refreshInsertsUI(owner)
          }
        })
      })
    }
    rackEl.appendChild(slot)
  }
}

/** Redraw one strip's insert rack (lane id or 'master'). */
function renderStripRack(owner: number | 'master'): void {
  if (owner === 'master') {
    if (masterRackEl && masterBusInserts) fillRack(masterRackEl, masterBusInserts, 'master')
    return
  }
  const grp = groupById(owner)
  if (grp) {
    fillRack(grp.strip.rackEl, grp.inserts, owner)
    return
  }
  const lane = lanes.find((l) => l.id === owner)
  if (lane) fillRack(lane.strip.rackEl, lane.inserts, owner)
}

/** After an insert list changes, refresh the strip rack + (if shown) the detail pane. */
function refreshInsertsUI(owner: number | 'master'): void {
  renderStripRack(owner)
  if (owner === selectedId) renderDetail()
}

/** Parameter editor for one insert, appended to `body`. */
function buildFxParams(body: HTMLElement, fx: Insert): void {
  if (fx instanceof ReverbInsert) {
    // Rotary controls, matching the channel-strip / EQ / Awaker look.
    const p = fx.params
    p.dry = 1 - p.wet // adopt the single Dry↔Wet balance
    const grid = document.createElement('div')
    grid.className = 'knob-grid'
    grid.append(
      makeKnob({ min: 0, max: 1, value: p.roomSize, default: 0.72, label: 'Room', fmt: pct, onInput: (v) => (p.roomSize = v) }),
      makeKnob({ min: 0, max: 1, value: p.damp, default: 0.35, label: 'Damp', fmt: pct, onInput: (v) => (p.damp = v) }),
      makeKnob({
        min: 0, max: 1, value: p.wet, default: 0.32, label: 'Mix',
        fmt: (v) => `Wet ${Math.round(v * 100)}%`,
        onInput: (v) => {
          p.wet = v
          p.dry = 1 - v
        }
      })
    )
    body.appendChild(grid)
  } else if (fx instanceof DelayInsert) {
    const p = fx.params
    p.dry = 1 - p.wet
    const l2 = Math.log2
    const grid = document.createElement('div')
    grid.className = 'knob-grid'
    grid.append(
      makeKnob({
        min: l2(1), max: l2(1500), value: l2(Math.max(1, p.timeMs)), default: l2(300), label: 'Time',
        fmt: (v) => `${2 ** v | 0} ms`,
        onInput: (v) => (p.timeMs = 2 ** v)
      }),
      makeKnob({ min: 0, max: 0.98, value: p.feedback, default: 0.35, label: 'FB', fmt: pct, onInput: (v) => (p.feedback = v) }),
      makeKnob({ min: 0, max: 1, value: p.damp, default: 0.3, label: 'Damp', fmt: pct, onInput: (v) => (p.damp = v) }),
      makeKnob({
        min: 0, max: 1, value: p.wet, default: 0.25, label: 'Mix',
        fmt: (v) => `Wet ${Math.round(v * 100)}%`,
        onInput: (v) => {
          p.wet = v
          p.dry = 1 - v
        }
      })
    )
    body.appendChild(grid)
    checkRow(body, 'Ping-pong', p.pingpong, (v) => (p.pingpong = v))
  } else if (fx instanceof Eq5Insert) {
    // Rotary controls, matching the channel-strip EQ. Every band defaults to
    // 0 dB gain (a mathematical passthrough), so a fresh 5-band EQ is flat;
    // double-click any knob to return it to that default.
    const tags = ['LS', 'B2', 'B3', 'B4', 'HS']
    const fDef = [80, 250, 1000, 4000, 12000]
    const qDef = [0.7, 1, 1, 1, 0.7]
    fx.bands.forEach((b, k) => {
      const bx = document.createElement('div')
      bx.className = 'eq-band'
      const bh = document.createElement('div')
      bh.className = 'eq-band-h'
      bh.textContent = tags[k]
      bx.appendChild(bh)
      const grid = document.createElement('div')
      grid.className = 'knob-grid'
      grid.append(
        freqKnob('Freq', b.freq, fDef[k], (f) => (b.freq = f)),
        makeKnob({
          min: -18, max: 18, value: b.gainDb, default: 0, label: 'Gain',
          fmt: db1, onInput: (v) => (b.gainDb = v)
        }),
        makeKnob({
          min: 0.3, max: 8, value: b.q, default: qDef[k], label: 'Q',
          fmt: (v) => v.toFixed(2), onInput: (v) => (b.q = v)
        })
      )
      bx.appendChild(grid)
      body.appendChild(bx)
    })
  } else if (fx instanceof TubeEqInsert) {
    // Tube program EQ: 12AX7 buffer → passive program EQ → 12AX7 make-up.
    // Sections follow the real front panel: INPUT · LOW · HIGH BOOST ·
    // HIGH ATTEN · OUTPUT. Boost / Atten dials are 0..10 (0 = flat); the
    // frequency knobs step through the actual switch positions. Double-click
    // a knob to reset it.
    const p = fx.params
    const stepKnob = (
      label: string, arr: number[], cur: number, def: number, set: (f: number) => void
    ): HTMLElement => {
      const idx = (n: number): number => Math.max(0, arr.indexOf(n))
      return makeKnob({
        min: 0, max: arr.length - 1, value: idx(cur), default: idx(def), label,
        fmt: (v) => {
          const f = arr[Math.round(v)]
          return f >= 1000 ? `${f / 1000}k` : `${f}`
        },
        onInput: (v) => set(arr[Math.round(v)])
      })
    }
    const dial = (
      label: string, cur: number, def: number, set: (n: number) => void,
      fmt: (n: number) => string = (n) => n.toFixed(1)
    ): HTMLElement =>
      makeKnob({ min: 0, max: 10, value: cur, default: def, label, fmt, onInput: set })
    const band = (title: string, ...cells: HTMLElement[]): void => {
      const bx = document.createElement('div')
      bx.className = 'eq-band'
      const bh = document.createElement('div')
      bh.className = 'eq-band-h'
      bh.textContent = title
      bx.appendChild(bh)
      const grid = document.createElement('div')
      grid.className = 'knob-grid'
      grid.append(...cells)
      bx.appendChild(grid)
      body.appendChild(bx)
    }

    // A — INPUT (the 12AX7 buffer drive; "IN" bypass is the window title bar).
    // Defaults below are the user's saved master-bus sweet spot.
    band('INPUT',
      makeKnob({
        min: -12, max: 12, value: p.inputGainDb, default: -3.77, label: 'Gain',
        fmt: db1, onInput: (v) => (p.inputGainDb = v)
      })
    )
    // B — LOW FREQUENCY (Boost + Atten share one frequency switch)
    band('LOW',
      dial('Boost', p.lowBoost, 3.64, (n) => (p.lowBoost = n)),
      dial('Atten', p.lowAtten, 0, (n) => (p.lowAtten = n)),
      stepKnob('Freq', TUBEEQ_LOW_FREQS, p.lowFreq, 60, (f) => (p.lowFreq = f))
    )
    // C — HIGH FREQUENCY boost (Boost + Bandwidth + frequency switch)
    band('HIGH BOOST',
      dial('Boost', p.hiBoost, 0, (n) => (p.hiBoost = n)),
      dial('Bandw', p.bandwidth, 5, (n) => (p.bandwidth = n),
        (n) => (n <= 0.2 ? 'Sharp' : n >= 9.8 ? 'Broad' : n.toFixed(1))),
      stepKnob('Freq', TUBEEQ_HI_BOOST_FREQS, p.hiBoostFreq, 10000, (f) => (p.hiBoostFreq = f))
    )
    // D — HIGH ATTEN (Atten + its own ATTEN SEL frequency switch)
    band('HIGH ATTEN',
      dial('Atten', p.hiAtten, 3.79, (n) => (p.hiAtten = n)),
      stepKnob('Sel', TUBEEQ_HI_ATTEN_FREQS, p.hiAttenFreq, 10000, (f) => (p.hiAttenFreq = f))
    )
    // E — OUTPUT make-up / trim
    band('OUTPUT',
      makeKnob({
        min: -12, max: 12, value: p.outputVolDb, default: 0, label: 'Vol',
        fmt: db1, onInput: (v) => (p.outputVolDb = v)
      })
    )
  } else if (fx instanceof AwakerInsert) {
    // Silky HF exciter + transient lift. Air 0 & Punch 0 = passthrough.
    // Rotary knobs (matching the EQ / channel-strip look); double-click resets.
    const p = fx.params
    const l2 = Math.log2
    const grid = document.createElement('div')
    grid.className = 'knob-grid'
    grid.append(
      makeKnob({
        min: 0, max: 1, value: p.air, default: 0.4, label: 'Air',
        fmt: pct, onInput: (v) => (p.air = v)
      }),
      makeKnob({
        min: l2(1000), max: l2(12000), value: l2(Math.max(1000, p.freq)), default: l2(4000), label: 'Freq',
        fmt: (v) => {
          const f = 2 ** v
          return f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${f | 0}`
        },
        onInput: (v) => (p.freq = 2 ** v)
      }),
      makeKnob({
        min: 0, max: 1, value: p.tone, default: 0.5, label: 'Tone',
        fmt: pct, onInput: (v) => (p.tone = v)
      }),
      makeKnob({
        min: 0, max: 1, value: p.punch, default: 0.3, label: 'Punch',
        fmt: pct, onInput: (v) => (p.punch = v)
      }),
      makeKnob({
        min: 0, max: 1, value: p.amount, default: 0.8, label: 'Amount',
        fmt: pct, onInput: (v) => (p.amount = v)
      })
    )
    body.appendChild(grid)
  } else if (fx instanceof BusCompInsert) {
    // SL-G-bus-style master comp: stepped ratio / attack / release, plus a
    // Drive knob for the bright harmonic colour and a parallel-comp Mix.
    const p = fx.params
    const stepped = (
      label: string, arr: number[], cur: number, def: number, fmt: (n: number) => string, set: (n: number) => void
    ): HTMLElement => {
      const idx = (n: number): number => Math.max(0, arr.indexOf(n))
      return makeKnob({
        min: 0, max: arr.length - 1, value: idx(cur), default: idx(def), label,
        fmt: (v) => fmt(arr[Math.round(v)]),
        onInput: (v) => set(arr[Math.round(v)])
      })
    }
    const grid = document.createElement('div')
    grid.className = 'knob-grid'
    grid.append(
      makeKnob({
        min: -40, max: 0, value: p.threshDb, default: -14, label: 'Thresh',
        fmt: db1, onInput: (v) => (p.threshDb = v)
      }),
      stepped('Ratio', BUSCOMP_RATIOS, p.ratio, 4, (n) => `${n}:1`, (n) => (p.ratio = n)),
      stepped('Attack', BUSCOMP_ATTACKS_MS, p.attackMs, 10, (n) => `${n} ms`, (n) => (p.attackMs = n)),
      stepped('Release', BUSCOMP_RELEASES_MS, p.releaseMs, 300,
        (n) => (n < 0 ? 'Auto' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`),
        (n) => (p.releaseMs = n)),
      makeKnob({
        min: 0, max: 24, value: p.makeupDb, default: 3, label: 'Makeup',
        fmt: db1, onInput: (v) => (p.makeupDb = v)
      }),
      makeKnob({
        min: 0, max: 1, value: p.drive, default: 0.25, label: 'Drive',
        fmt: pct, onInput: (v) => (p.drive = v)
      }),
      makeKnob({
        min: 0, max: 1, value: p.mix, default: 1, label: 'Mix',
        fmt: pct, onInput: (v) => (p.mix = v)
      })
    )
    body.appendChild(grid)
  } else if (fx instanceof MaximizerInsert) {
    // Look-ahead brick-wall limiter + LUFS readout (fed from the master readback
    // in the scheduler; the maximizer is master-only and normally last, so it
    // reads as the output loudness).
    const p = fx.params
    const l2 = Math.log2
    const grid = document.createElement('div')
    grid.className = 'knob-grid'
    grid.append(
      makeKnob({
        min: 0, max: 24, value: p.gainDb, default: 0, label: 'Gain',
        fmt: db1, onInput: (v) => (p.gainDb = v)
      }),
      makeKnob({
        min: -3, max: 0, value: p.ceilingDb, default: -1, label: 'Ceiling',
        fmt: db1, onInput: (v) => (p.ceilingDb = v)
      }),
      makeKnob({
        min: l2(1), max: l2(1000), value: l2(Math.max(1, p.releaseMs)), default: l2(200), label: 'Release',
        fmt: (v) => `${2 ** v | 0} ms`, onInput: (v) => (p.releaseMs = 2 ** v)
      })
    )
    body.appendChild(grid)

    const meter = document.createElement('div')
    meter.className = 'lufs-meter'
    const row = (lab: string, strong = false): HTMLElement => {
      const r = document.createElement('div')
      r.className = strong ? 'lufs-row lufs-strong' : 'lufs-row'
      const l = document.createElement('span')
      l.className = 'll-lab'
      l.textContent = lab
      const v = document.createElement('span')
      v.className = 'll-val'
      v.textContent = '−∞'
      r.append(l, v)
      meter.appendChild(r)
      return v
    }
    const m = row('Momentary')
    const s = row('Short-term')
    const i = row('Integrated', true)
    const mx = row('Maximum')
    const title = document.createElement('div')
    title.className = 'lufs-title'
    title.textContent = 'LUFS'
    const approx = document.createElement('span')
    approx.className = 'lufs-approx'
    approx.textContent = ' · almost'
    approx.title = 'BS.1770-4 K-weighting + a provisional +2 dB trim — not yet checked against a certified reference'
    title.appendChild(approx)
    body.append(title, meter)
    lufsReadout = { fx, m, s, i, mx }
  }
}

/**
 * Left detail-pane insert section: a titled `Inserts · n/8` header (accent when
 * the track carries at least one insert) plus the same compact slot rack the
 * mixer strip uses. Params are edited in floating plugin windows — a filled
 * slot's name opens one. `list` is mutated in place; the scheduler reads it live.
 */
function buildDetailSlots(parent: HTMLElement, list: Insert[], owner: number | 'master'): void {
  const sec = section(`Inserts · ${list.length}/${SLOT_COUNT}`)
  sec.id = 'td-inserts'
  sec.classList.toggle('has-fx', list.length > 0)
  const rack = document.createElement('div')
  rack.className = 'strip-rack'
  sec.appendChild(rack)
  parent.appendChild(sec)
  fillRack(rack, list, owner)
}

/**
 * Rebuild the left-pane detail view for the selected track: fader / pan / mute /
 * solo, input (trim / HPF), saturation (one knob + drive/color mode),
 * console-style 4-band EQ, compressor, and the insert rack (editor behind the
 * mixer strip's slot rack).
 */
function renderDetail(): void {
  const paneScroll = trackDetailEl.parentElement as HTMLElement
  const savedScroll = paneScroll.scrollTop
  detailApi = null
  trackDetailEl.replaceChildren()

  // ---- master bus view: just an insert rack ----
  if (selectedId === 'master') {
    const mh = document.createElement('div')
    mh.id = 'td-head'
    const mt = document.createElement('span')
    mt.className = 't'
    mt.textContent = 'MASTER'
    mh.appendChild(mt)
    trackDetailEl.appendChild(mh)
    if (masterBusInserts) buildDetailSlots(trackDetailEl, masterBusInserts, 'master')
    paneScroll.scrollTop = savedScroll
    return
  }

  // ---- group channel view: name, its tracks, delete, and its insert rack ----
  const grp = typeof selectedId === 'number' ? groupById(selectedId) : undefined
  if (grp) {
    const gh = document.createElement('div')
    gh.id = 'td-head'
    const gn = document.createElement('span')
    gn.className = 'n'
    gn.textContent = `G${grp.id - GROUP_ID_BASE}`
    const gt = document.createElement('input')
    gt.type = 'text'
    gt.className = 'td-gname'
    gt.value = grp.name
    gt.maxLength = 40
    gt.addEventListener('keydown', (e) => e.stopPropagation())
    gt.addEventListener('change', () => {
      grp.name = cleanStemName(gt.value) || grp.name
      gt.value = grp.name
      ;(grp.strip.el.querySelector('.strip-head .t') as HTMLElement).textContent = grp.name
    })
    const del = document.createElement('button')
    del.textContent = 'Delete'
    del.title = 'Delete this group (its tracks go straight to the master)'
    del.addEventListener('click', () => removeGroup(grp.id))
    gh.append(gn, gt, del)
    trackDetailEl.appendChild(gh)
    const members = lanes.filter((l) => l.group === grp.id)
    const mem = document.createElement('div')
    mem.className = 'td-empty'
    mem.textContent = members.length
      ? `tracks: ${members.map((l) => (l.el.querySelector('.lane-title') as HTMLElement).textContent).join(', ')}`
      : 'no tracks routed here (pick Output on a track)'
    trackDetailEl.appendChild(mem)
    buildDetailSlots(trackDetailEl, grp.inserts, grp.id)
    // colour: the last thing in the pane
    const row = document.createElement('div')
    row.id = 'td-color'
    const lab = document.createElement('span')
    lab.className = 'lbl'
    lab.textContent = 'Color'
    row.append(lab)
    for (const c of TRACK_PALETTE) {
      const b = document.createElement('button')
      b.className = c === grp.color ? 'sw on' : 'sw'
      b.style.background = c
      b.title = `${c} — also the colour of the group's tracks that have no stem`
      b.addEventListener('click', () => {
        grp.color = c
        applyGroupColor(grp)
        for (const l of lanes) if (l.group === grp.id) adoptGroupColor(l, grp)
        renderDetail()
      })
      row.append(b)
    }
    trackDetailEl.appendChild(row)
    paneScroll.scrollTop = savedScroll
    return
  }

  const lane = typeof selectedId === 'number' ? (lanes.find((l) => l.id === selectedId) ?? null) : null

  if (!lane) {
    const empty = document.createElement('div')
    empty.className = 'td-empty'
    empty.textContent = 'select a track'
    trackDetailEl.appendChild(empty)
    return
  }

  const head = document.createElement('div')
  head.id = 'td-head'
  const hn = document.createElement('span')
  hn.className = 'n'
  hn.textContent = String(lane.id)
  const ht = document.createElement('span')
  ht.className = 't'
  const title = (lane.el.querySelector('.lane-title') as HTMLElement).textContent ?? ''
  ht.textContent = title
  ht.title = title
  head.append(hn, ht)
  trackDetailEl.appendChild(head)

  // ---- stem: tracks with the same name are exported together as one stem file ----
  {
    const row = document.createElement('div')
    row.id = 'td-stem'
    const lab = document.createElement('span')
    lab.textContent = 'Stem'
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.maxLength = 40
    inp.placeholder = '（なし）'
    inp.value = lane.stem ?? ''
    inp.setAttribute('list', 'stem-names')
    inp.title = 'Stem name — tracks with the same name are exported together (File → Export → Stems…)'
    const dl = document.createElement('datalist')
    dl.id = 'stem-names'
    for (const n of new Set(lanes.map((l) => l.stem ?? '').filter(Boolean))) {
      const o = document.createElement('option')
      o.value = n
      dl.append(o)
    }
    inp.addEventListener('change', () => {
      lane.stem = cleanStemName(inp.value)
      inp.value = lane.stem
      alignStem(lane) // the stem's tracks share one colour
      renderDetail()
    })
    inp.addEventListener('keydown', (e) => e.stopPropagation()) // typing a name must not trigger transport / edit keys
    row.append(lab, inp, dl)
    trackDetailEl.appendChild(row)
  }

  // ---- output: straight to the master, or into a group channel ----
  {
    const row = document.createElement('div')
    row.id = 'td-out'
    const lab = document.createElement('span')
    lab.textContent = 'Output'
    const sel = document.createElement('select')
    const addOpt = (value: string, text: string): void => {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      sel.append(o)
    }
    addOpt('', 'Master')
    for (const g of groups) addOpt(String(g.id), g.name)
    sel.value = lane.group !== undefined && groupById(lane.group) ? String(lane.group) : ''
    sel.addEventListener('change', () => {
      lane.group = sel.value ? Number(sel.value) : undefined
      adoptGroupColor(lane, lane.group !== undefined ? groupById(lane.group) : undefined)
      renderDetail()
    })
    row.append(lab, sel)
    trackDetailEl.appendChild(row)
  }

  // ---- insert plugins (slot rack at the top; params open in floating windows) ----
  buildDetailSlots(trackDetailEl, lane.inserts, lane.id)

  if (lane.inst) {
    trackDetailEl.appendChild(buildInstrumentPicker(lane))
    trackDetailEl.appendChild(buildSynthSection(lane))
    trackDetailEl.appendChild(buildMidiIoSection(lane))
  }
  if (lane.live) {
    trackDetailEl.appendChild(buildLiveSection(lane))
    trackDetailEl.appendChild(buildReturnSection(lane))
    trackDetailEl.appendChild(buildVstSection(lane))
  }

  const sp = lane.dsp.params

  // ---- channel: fader, with Input (Trim / HPF) + Pan + Mute/Solo stacked to its right ----
  const fSec = document.createElement('div')
  fSec.className = 'td-section td-channel'
  const fh = document.createElement('h4')
  fh.textContent = 'channel'
  fSec.appendChild(fh)

  const mid = document.createElement('div')
  mid.id = 'td-fader-mid'
  const wrap = document.createElement('div')
  wrap.className = 'fader-wrap'
  const fader = document.createElement('input')
  fader.className = 'strip-fader'
  fader.type = 'range'
  fader.min = '-60'
  fader.max = '6'
  fader.step = '0.5'
  const cap = document.createElement('div')
  cap.className = 'fader-cap'
  wrap.append(fader, cap)
  const vu = document.createElement('div')
  vu.className = 'strip-vu'
  const vuInner = document.createElement('i')
  vu.appendChild(vuInner)

  // side column beside the fader: Trim, HPF, Pan knobs then Mute / Solo, all vertical
  const side = document.createElement('div')
  side.className = 'td-fader-side'

  const trimKnob = makeKnob({
    min: -24, max: 24, value: sp.trimDb, default: 0, label: 'Trim',
    fmt: db1, onInput: (v) => (sp.trimDb = v)
  })
  const hpfKnob = makeKnob({
    min: 0, max: 300, value: sp.hpfHz, default: 0, label: 'HPF',
    fmt: (v) => (v >= 1 ? `${v | 0} Hz` : 'off'), onInput: (v) => (sp.hpfHz = v)
  })

  const panFmt = (p: number): string =>
    p === 0 ? 'C' : `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 100)}`
  let setPanKnob: (v: number) => void = () => {}
  const panCell = makeKnob({
    min: -1, max: 1, value: lane.mix.pan, default: 0, label: 'Pan',
    fmt: panFmt,
    onInput: (v) => {
      lane.mix.pan = v
      lane.strip.setPan(v)
    },
    bind: (set) => {
      setPanKnob = set
    }
  })

  const btns = document.createElement('div')
  btns.className = 'td-btns td-btns-vert'
  const mkBtn = (label: string, key: 'mute' | 'solo' | 'rec'): HTMLButtonElement => {
    const cls = key === 'mute' ? 'm' : key === 'solo' ? 's' : 'r'
    const b = document.createElement('button')
    b.className = cls
    b.textContent = label
    b.classList.toggle('on', lane.mix[key])
    b.addEventListener('click', () => {
      lane.mix[key] = !lane.mix[key]
      b.classList.toggle('on', lane.mix[key])
      lane.strip[cls].classList.toggle('on', lane.mix[key])
      if (key === 'solo') refreshSolo()
    })
    return b
  }
  const muteBtn = mkBtn('Mute', 'mute')
  const soloBtn = mkBtn('Solo', 'solo')
  const recBtn = mkBtn('Rec', 'rec')
  btns.append(muteBtn, soloBtn, recBtn)

  // Which hardware input feeds this track when armed (mono In 1..8 / stereo pairs).
  const recSel = document.createElement('select')
  recSel.className = 'rec-in'
  recSel.title = 'record input (when armed)'
  const recOpts: Array<{ v: string; t: string }> = []
  for (let i = 0; i < 8; i++) recOpts.push({ v: `m${i}`, t: `In ${i + 1}` })
  for (let i = 0; i < 8; i += 2) recOpts.push({ v: `s${i}`, t: `In ${i + 1}-${i + 2}` })
  for (const o of recOpts) {
    const op = document.createElement('option')
    op.value = o.v
    op.textContent = o.t
    recSel.appendChild(op)
  }
  recSel.value = `${lane.recIn.stereo ? 's' : 'm'}${lane.recIn.ch}`
  recSel.addEventListener('change', () => {
    lane.recIn = { ch: Number(recSel.value.slice(1)), stereo: recSel.value[0] === 's' }
  })
  btns.append(recSel)

  // Trim + HPF live in a bordered "Input" box
  const inBox = document.createElement('div')
  inBox.className = 'td-in-box'
  const inCap = document.createElement('span')
  inCap.className = 'td-in-cap'
  inCap.textContent = 'Input'
  inBox.append(inCap, trimKnob, hpfKnob)

  side.append(inBox, panCell, btns)

  mid.append(makeScale(-60, 6), wrap, vu, side)
  fSec.appendChild(mid)

  const dbOut = document.createElement('div')
  dbOut.className = 'td-db'
  fSec.appendChild(dbOut)
  trackDetailEl.appendChild(fSec)

  const setGain = (db: number): void => {
    fader.value = String(db)
    cap.style.top = faderTop(db, -60, 6)
    dbOut.textContent = db <= -60 ? '−∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
  }
  setGain(lane.mix.gainDb)
  guardFaderRail(fader, cap)
  fader.addEventListener('input', () => {
    lane.mix.gainDb = Number(fader.value)
    setGain(lane.mix.gainDb)
    lane.strip.setGain(lane.mix.gainDb)
  })

  // ---- EQ — analogue console style (LF / LMF / HMF / HF), rotary controls ----
  const eqSec = section('EQ — 4-band')
  eqSec.classList.toggle('fx-on', sp.eqOn)
  checkRow(eqSec, 'EQ in', sp.eqOn, (v) => {
    sp.eqOn = v
    eqSec.classList.toggle('fx-on', v)
  })
  const bandNames = ['LF', 'LMF', 'HMF', 'HF']
  const bandFreqDefaults = [100, 500, 3000, 9000]
  sp.eq.forEach((bnd, k) => {
    const bx = document.createElement('div')
    bx.className = 'eq-band'
    const bh = document.createElement('div')
    bh.className = 'eq-band-h'
    bh.textContent = bandNames[k]
    bx.appendChild(bh)
    if (k === 0 || k === 3) checkRow(bx, 'bell', !bnd.shelf, (v) => (bnd.shelf = !v))
    const grid = document.createElement('div')
    grid.className = 'knob-grid'
    grid.appendChild(freqKnob('Freq', bnd.freq, bandFreqDefaults[k], (f) => (bnd.freq = f)))
    grid.appendChild(
      makeKnob({
        min: -18,
        max: 18,
        value: bnd.gainDb,
        default: 0,
        label: 'Gain',
        fmt: db1,
        onInput: (v) => (bnd.gainDb = v)
      })
    )
    if (k === 1 || k === 2) {
      grid.appendChild(
        makeKnob({
          min: 0.4,
          max: 6,
          value: bnd.q,
          default: 1,
          label: 'Q',
          fmt: (v) => v.toFixed(2),
          onInput: (v) => (bnd.q = v)
        })
      )
    }
    bx.appendChild(grid)
    eqSec.appendChild(bx)
  })
  trackDetailEl.appendChild(eqSec)

  // ---- saturation: one knob, mode = drive (parallel multiband) | color (transformer + Class-A) ----
  const satSec = section('Saturation')
  satSec.classList.toggle('fx-on', sp.drive > 0.001)
  const modeRow = document.createElement('div')
  modeRow.className = 'td-btns'
  const mkMode = (label: string, m: 'drive' | 'color'): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'sat-mode'
    b.textContent = label
    b.classList.toggle('on', sp.satMode === m)
    b.addEventListener('click', () => {
      sp.satMode = m
      modeRow.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
    })
    return b
  }
  modeRow.append(mkMode('Drive', 'drive'), mkMode('Color', 'color'))
  modeRow.style.marginBottom = '14px' // gap between the mode buttons and the knob
  satSec.appendChild(modeRow)
  satSec.appendChild(
    makeKnob({
      min: 0,
      max: 1,
      value: sp.drive,
      default: 0,
      fmt: pct,
      onInput: (v) => {
        sp.drive = v
        lane.el.classList.toggle('sat-active', v > 0.001)
        satSec.classList.toggle('fx-on', v > 0.001)
      }
    })
  )
  trackDetailEl.insertBefore(satSec, eqSec) // Saturation sits above EQ

  // ---- compressor (stereo-linked), rotary controls ----
  const cp = sp.comp
  const cSec = section('Compressor')
  cSec.classList.toggle('fx-on', cp.on)
  checkRow(cSec, 'comp in', cp.on, (v) => {
    cp.on = v
    cSec.classList.toggle('fx-on', v)
  })
  const cGrid = document.createElement('div')
  cGrid.className = 'knob-grid'
  cGrid.append(
    makeKnob({
      min: -48, max: 0, value: cp.threshDb, default: -18, label: 'Thresh',
      fmt: db1, onInput: (v) => (cp.threshDb = v)
    }),
    makeKnob({
      min: 1, max: 20, value: cp.ratio, default: 2, label: 'Ratio',
      fmt: (v) => `${v.toFixed(1)}:1`, onInput: (v) => (cp.ratio = v)
    }),
    makeKnob({
      min: 0.1, max: 100, value: cp.attackMs, default: 12, label: 'Attack',
      fmt: (v) => `${v.toFixed(1)}ms`, onInput: (v) => (cp.attackMs = v)
    }),
    makeKnob({
      min: 5, max: 1000, value: cp.releaseMs, default: 120, label: 'Release',
      fmt: (v) => `${v | 0}ms`, onInput: (v) => (cp.releaseMs = v)
    }),
    makeKnob({
      min: 0, max: 24, value: cp.makeupDb, default: 0, label: 'Makeup',
      fmt: db1, onInput: (v) => (cp.makeupDb = v)
    })
  )
  cSec.appendChild(cGrid)
  trackDetailEl.appendChild(cSec)

  detailApi = {
    setGain,
    setPan: (p) => setPanKnob(p),
    syncButtons: () => {
      muteBtn.classList.toggle('on', lane.mix.mute)
      soloBtn.classList.toggle('on', lane.mix.solo)
      recBtn.classList.toggle('on', lane.mix.rec)
    },
    vuEl: vuInner
  }
  // ---- colour: the lane is painted with it (a stem's tracks share one colour); the last thing in the pane ----
  {
    const row = document.createElement('div')
    row.id = 'td-color'
    const lab = document.createElement('span')
    lab.className = 'lbl'
    lab.textContent = 'Color'
    row.append(lab)
    const cur = normalizeColor(lane.color) ?? TRACK_PALETTE[0]
    for (const c of TRACK_PALETTE) {
      const b = document.createElement('button')
      b.className = c === cur ? 'sw on' : 'sw'
      b.style.background = c
      b.title = lane.stem ? `${c} — applies to every track of stem "${lane.stem}"` : c
      b.addEventListener('click', () => {
        setLaneColor(lane, c)
        renderDetail()
      })
      row.append(b)
    }
    trackDetailEl.appendChild(row)
  }

  paneScroll.scrollTop = savedScroll
}

/** Resolve a lane's mix to a GPU MixSource, applying mute/solo. */
function laneToSource(l: Lane): MixSource {
  const grp = l.group !== undefined ? groupById(l.group) : undefined
  // soloing a group lets all of its tracks through
  const audible = !l.mix.mute && (!anySolo || l.mix.solo || !!grp?.mix.solo)
  const gi = grp ? groups.indexOf(grp) : -1
  return {
    clips: resolveLaneClips(l),
    mix: { gain: audible ? dbToLin(l.mix.gainDb) : 0, pan: l.mix.pan },
    strip: l.dsp,
    inserts: l.inserts,
    ...(gi >= 0 ? { group: gi } : {})
  }
}

/** Stem name -> colour: every track of a stem wears the same one. */
let stemColorTable: Record<string, string> = {}

/** Paint a lane (timeline row, waveform, mixer strip) in its track colour. */
function applyLaneColor(lane: Lane): void {
  const paint = lanePaint(lane.color ?? TRACK_PALETTE[0])
  lane.renderer.setColors(paint.bg, paint.wave, paint.fill)
  lane.el.style.setProperty('--track', paint.css)
  lane.strip.el.style.setProperty('--track', paint.css)
  lane.dirty = true
}

/**
 * A stem was chosen for `lane` (or a colour was picked on it): make every track of that stem the same colour.
 * Tracks without a stem keep their own colour.
 */
function alignStem(lane: Lane, recolor = false): void {
  const idx = lanes.indexOf(lane)
  if (idx < 0) return
  const r = alignStemColors(
    lanes.map((l) => ({ stem: l.stem ?? '', color: l.color ?? TRACK_PALETTE[0] })),
    stemColorTable,
    idx,
    recolor
  )
  stemColorTable = pruneStemColors(lanes.map((l) => l.stem ?? ''), r.stemColors)
  lanes.forEach((l, i) => {
    if (l.color !== r.colors[i]) {
      l.color = r.colors[i]
      applyLaneColor(l)
    }
  })
}

/** Colour a track by hand (a stem's tracks follow). */
function setLaneColor(lane: Lane, color: string): void {
  const c = normalizeColor(color)
  if (!c) return
  lane.color = c
  if (lane.stem) alignStem(lane, true)
  else applyLaneColor(lane)
}

function applyGroupColor(g: Group): void {
  g.strip.el.style.setProperty('--track', lanePaint(g.color).css)
}

/** A track routed into a group takes the group's colour (a stem's colour wins when it has one). */
function adoptGroupColor(lane: Lane, g: Group | undefined): void {
  if (!g || lane.stem) return
  if (lane.color !== g.color) {
    lane.color = g.color
    applyLaneColor(lane)
  }
}

/** Create a group channel (and its mixer strip). `id` is given when restoring a project. */
function addGroup(name: string, id?: number): Group {
  const gid = id !== undefined && !groupById(id) ? id : nextGroupId++
  if (gid >= nextGroupId) nextGroupId = gid + 1
  const g: Group = {
    id: gid,
    name,
    color: pickUnusedColor(groups.map((x) => x.color)), // a colour no other group has
    mix: { gainDb: 0, pan: 0, mute: false, solo: false, rec: false },
    inserts: [],
    peakHold: 0,
    vu: 0,
    strip: null as unknown as Strip
  }
  g.strip = buildStrip(g, gid, name, true)
  ;(g.strip.el.querySelector('.strip-head .n') as HTMLElement).textContent = `G${gid - GROUP_ID_BASE}`
  g.strip.r.style.display = 'none' // a bus is not armed for recording
  applyGroupColor(g)
  groups.push(g)
  return g
}

function removeGroup(id: number): void {
  const i = groups.findIndex((g) => g.id === id)
  if (i < 0) return
  closeAllPlugWins() // the group's insert windows
  for (const l of lanes) if (l.group === id) l.group = undefined
  groups[i].strip.el.remove()
  groups.splice(i, 1)
  refreshSolo()
  if (selectedId === id) selectLane(lanes.length ? lanes[0].id : null)
  else renderDetail()
}

/** A group channel as the GPU path takes it: fader / pan (mute / solo applied) + its inserts. */
function groupToMix(g: Group): MixGroup {
  const soloMember = lanes.some((l) => l.group === g.id && l.mix.solo)
  const audible = !g.mix.mute && (!anySolo || g.mix.solo || soloMember)
  return { mix: { gain: audible ? dbToLin(g.mix.gainDb) : 0, pan: g.mix.pan }, inserts: g.inserts }
}

/** Peak-per-window envelope from decoded (pre-resample) channels, indexed by time. */
function computeEnvelope(channels: Float32Array[], fileRate: number): Float32Array {
  const win = Math.max(1, Math.round(fileRate * ENV_WINDOW_S))
  const frames = channels[0].length
  const out = new Float32Array(Math.max(1, Math.ceil(frames / win)))
  for (const ch of channels) {
    for (let i = 0; i < frames; i++) {
      const a = Math.abs(ch[i])
      const b = (i / win) | 0
      if (a > out[b]) out[b] = a
    }
  }
  return out
}

function setLaneSub(lane: Lane, text: string): void {
  ;(lane.el.querySelector('.lane-sub') as HTMLElement).textContent = text
}

/** Filename → track title: drop the directory and the extension. */
function trackNameFromPath(path: string): string {
  return (path.split(/[/\\]/).pop() || 'wav').replace(/\.[^.]+$/, '')
}

/** True once the user has manually scrolled/zoomed — suppresses auto fit-to-fit. */
let userZoomed = false

/** Recompute transport length / track count from the lanes. */
function refreshTotals(): void {
  let total = 0
  for (const l of lanes) total = Math.max(total, laneEnd(l.clips))
  update({ totalFrames: total, trackCount: lanes.length })
}

/**
 * Scale the shared timeline so the whole project (0..totalFrames) exactly spans
 * the waveform column. This is what makes the playhead position meaningful: at
 * frame 0 it sits on the left edge of the wave, at totalFrames on the right.
 */
function fitToProject(): void {
  if (state.totalFrames <= 0) return
  update({
    framesPerPixel: Math.max(64, state.totalFrames / waveViewportPx()),
    scrollFrames: 0
  })
  userZoomed = false
}

/**
 * Import one WAV as an AudioSource (GPU resample to project rate as it lands) and
 * add a lane holding a single full-length clip of it. Shared by the Add-Track
 * flow, the test-bed autoload, and v1-project migration. Returns null on failure.
 */
async function addWavLane(path: string, title?: string): Promise<Lane | null> {
  const src = await importWavSource(path, title)
  if (!src) return null
  const lane = addLane(src.name)
  addClipToLane(lane, src)
  setLaneSub(lane, `${src.gpu.channelCount}ch · ${(state.sampleRate / 1000) | 0}k`)
  return lane
}

// ---- project persistence (save all settings / restore on relaunch) -----------

interface SzInsert {
  kind: string
  bypass: boolean
  params: unknown
}
interface SzSource {
  id: number
  name: string
  path: string | null
  kind: 'wav' | 'tone'
  toneSeconds?: number
}
interface SzClip {
  sourceId: number
  name: string
  startFrame: number
  srcOffset: number
  lengthFrames: number
  fadeIn: number
  fadeOut: number
  fadeInShape: FadeShape
  fadeOutShape: FadeShape
  gainDb: number
}
interface SzTrack {
  title: string
  /** v1 fields — read for migration, no longer written. */
  path?: string | null
  kind?: 'wav' | 'tone'
  toneSeconds?: number
  mix: LaneMix
  /** Record input routing (absent in older files → In 1 mono). */
  recIn?: { ch: number; stereo: boolean }
  strip: { bypass: boolean; params: unknown }
  inserts: SzInsert[]
  /** v2: placed clips (v1 files have none → migrated to one full-length clip). */
  clips?: SzClip[]
  /** Instrument lane: index into `midiTracks` of the track that feeds it (no clips are stored). */
  instrumentOf?: number
  /** Line-input lane (the input channel is `recIn`). */
  live?: { monitor: boolean }
  /** Stem name (absent = none). */
  stem?: string
  /** Output group id (absent = master). */
  group?: number
  /** Track colour `#rrggbb` (absent in older files: a palette colour by position). */
  color?: string
}
interface SzGroup {
  id: number
  name: string
  color?: string
  mix: LaneMix
  inserts: SzInsert[]
}
interface ProjectFile {
  version: number
  /** Group channels (absent in older files). */
  groups?: SzGroup[]
  /** Stem name -> colour (absent in older files). */
  stemColors?: Record<string, string>
  sampleRate: number
  bpm?: number
  timeSig?: { num: number; den: number }
  gridMode?: string
  sources?: SzSource[]
  master: { gainDb: number; inserts: SzInsert[] }
  /** MIDI tracks (absent in older files). */
  midiTracks?: SzMidiTrack[]
  view: { framesPerPixel: number; scrollFrames: number; playhead: number }
  tracks: SzTrack[]
}

/** Recursive plain-object merge: `patch` values win, arrays are replaced wholesale. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : (patch as T))
  }
  const out = { ...(base as Record<string, unknown>) }
  for (const [k, pv] of Object.entries(patch as Record<string, unknown>)) {
    const bv = out[k]
    out[k] =
      bv && typeof bv === 'object' && !Array.isArray(bv) ? deepMerge(bv, pv) : (pv as unknown)
  }
  return out as T
}

function serializeInsert(fx: Insert): SzInsert | null {
  if (fx instanceof ReverbInsert) return { kind: 'reverb', bypass: fx.bypass, params: { ...fx.params } }
  if (fx instanceof DelayInsert) return { kind: 'delay', bypass: fx.bypass, params: { ...fx.params } }
  if (fx instanceof Eq5Insert) {
    return { kind: 'eq5', bypass: fx.bypass, params: { bands: fx.bands.map((b) => ({ ...b })) } }
  }
  if (fx instanceof TubeEqInsert) return { kind: 'tubeeq', bypass: fx.bypass, params: { ...fx.params } }
  if (fx instanceof AwakerInsert) return { kind: 'awaker', bypass: fx.bypass, params: { ...fx.params } }
  if (fx instanceof BusCompInsert) return { kind: 'buscomp', bypass: fx.bypass, params: { ...fx.params } }
  if (fx instanceof MaximizerInsert) return { kind: 'maximizer', bypass: fx.bypass, params: { ...fx.params } }
  return null
}

function deserializeInsert(s: SzInsert): Insert | null {
  let fx: Insert | null = null
  if (s.kind === 'reverb') {
    const r = new ReverbInsert()
    Object.assign(r.params, s.params)
    fx = r
  } else if (s.kind === 'delay') {
    const d = new DelayInsert()
    Object.assign(d.params, s.params)
    fx = d
  } else if (s.kind === 'eq5') {
    const e = new Eq5Insert()
    const bands = (s.params as { bands?: Eq5Band[] } | undefined)?.bands
    if (Array.isArray(bands)) {
      e.bands = e.bands.map((def, i) => ({
        freq: Number(bands[i]?.freq ?? def.freq),
        gainDb: Number(bands[i]?.gainDb ?? def.gainDb),
        q: Number(bands[i]?.q ?? def.q)
      }))
    }
    fx = e
  } else if (s.kind === 'tubeeq') {
    const t = new TubeEqInsert()
    Object.assign(t.params, s.params)
    fx = t
  } else if (s.kind === 'awaker') {
    const a = new AwakerInsert()
    Object.assign(a.params, s.params)
    fx = a
  } else if (s.kind === 'buscomp') {
    const c = new BusCompInsert()
    Object.assign(c.params, s.params)
    fx = c
  } else if (s.kind === 'maximizer') {
    const mx = new MaximizerInsert()
    Object.assign(mx.params, s.params)
    fx = mx
  }
  if (fx) fx.bypass = !!s.bypass
  return fx
}

function applyStripParams(dsp: ChannelStrip, saved: SzTrack['strip'] | undefined): void {
  if (!saved) return
  dsp.bypass = !!saved.bypass
  dsp.params = deepMerge(defaultStripParams(), saved.params)
  // Pre-2026-09-07 projects have no `satMode` and their `drive` knob was the
  // parallel-multiband stage → pin those to 'drive' so they sound unchanged.
  // (New default is 'color', which only applies to freshly-added tracks.)
  const sv = saved.params
  if (sv && typeof sv === 'object' && !('satMode' in sv)) dsp.params.satMode = 'drive'
}

async function boot(): Promise<void> {
  try {
    const gpu = await initGpu()
    const label = `WebGPU ready · ${gpu.adapter.info?.vendor || 'adapter'} ${gpu.adapter.info?.architecture ?? ''}`.trim()
    const soft = isSoftwareAdapter(gpu.adapter.info as AdapterInfoLike | undefined, (gpu.adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter === true)
    if (soft) {
      setGpuLamp('off', `${label} — software rendering (no GPU in use): it works, but slowly`)
      console.warn(`[gpu] ${label} — software rendering (no GPU in use)`)
    } else {
      setGpuLamp('ok', label)
      console.log(`[gpu] ${label}`)
    }
  } catch (err) {
    const msg = `WebGPU failed: ${(err as Error).message}`
    gpuStatus.textContent = msg
    gpuStatus.className = 'err'
    setGpuLamp('err', msg)
    console.error(`[gpu] ${msg}`)
    return
  }

  const scheduler = new PlaybackScheduler(() => lanes.map(laneToSource))
  scheduler.getGroups = () => groups.map(groupToMix)
  window.daw.onAudioStatus((s) => scheduler.onStatus(s))
  window.daw.onRecChunk((c) => scheduler.onRecChunk(c))
  // live (line-input) path: its own small-block bus, fed by main's ~256-frame input batches
  schedulerRef = scheduler
  liveBusRef = scheduler.liveBus = new LiveBus(liveLanes, () => scheduler.masterBus.masterGain)
  liveBusRef.latencyMs = readNum(LIVE_LAT_KEY, 0)
  setLiveBlock(readNum(LIVE_BLOCK_KEY, LIVE_BLOCK))
  scheduler.recOffsetMs = readNum(REC_OFF_KEY, 0)
  window.daw.onLiveIn((c) => liveBusRef?.feed(c, state.sampleRate))
  masterBusInserts = scheduler.masterBus.inserts // detail pane + strip rack edit this list
  masterRackEl = $('master-rack')
  renderStripRack('master') // 8 empty master insert slots
  ;(masterStripEl.querySelector('.strip-head') as HTMLElement).addEventListener('pointerdown', () =>
    selectLane('master')
  )

  update({ sampleRate: Number(srSelect.value) }) // sync project SR with the UI default

  // ---- master fader (dB) --------------------------------------------------
  // Applied per track in MASTER_WGSL via masterBus.masterGain (linear). Step
  // change per rendered block — fine for a rarely-touched master trim.
  const masterEl = $<HTMLInputElement>('master')
  const masterVal = $('master-val')
  const masterWrap = document.querySelector('#master-strip .fader-wrap') as HTMLElement
  // same range / scale / gain mapping as a channel fader (-60..+6 dB, -60 = −∞)
  masterWrap.parentElement!.insertBefore(makeScale(-60, 6), masterWrap)
  const masterCap = document.createElement('div')
  masterCap.className = 'fader-cap'
  masterWrap.appendChild(masterCap)
  const syncMaster = (): void => {
    const dbv = Number(masterEl.value)
    scheduler.masterBus.masterGain = dbToLin(dbv)
    masterVal.textContent = dbv <= -60 ? '−∞ dB' : `${dbv > 0 ? '+' : ''}${dbv.toFixed(1)} dB`
    masterCap.style.top = faderTop(dbv, -60, 6)
  }
  syncMaster() // project default: -10.0 dB (headroom — the bus was clipping at -1)
  guardFaderRail(masterEl, masterCap)
  masterEl.addEventListener('input', syncMaster)
  masterPeakEl.addEventListener('click', () => {
    masterPeakHold = 0
    masterPeakEl.textContent = '−∞'
    masterPeakEl.classList.remove('over')
  })

  // ---- project save / load ---------------------------------------------------

  /** Briefly show a message in the gpu-status slot, then restore what was there. */
  let statusFlashTimer = 0
  let statusFlashSaved = { text: '', cls: '' }
  function flashStatus(msg: string, isErr = false): void {
    if (!statusFlashTimer) {
      // remember the real status only when not already flashing
      statusFlashSaved = { text: gpuStatus.textContent ?? '', cls: gpuStatus.className }
    }
    gpuStatus.textContent = msg
    gpuStatus.className = isErr ? 'err' : 'ok'
    clearTimeout(statusFlashTimer)
    statusFlashTimer = window.setTimeout(() => {
      statusFlashTimer = 0
      gpuStatus.textContent = statusFlashSaved.text
      gpuStatus.className = statusFlashSaved.cls
    }, 3200)
  }
  notify = flashStatus

  const szClip = (c: Clip): SzClip => ({
    sourceId: c.sourceId,
    name: c.name,
    startFrame: c.startFrame,
    srcOffset: c.srcOffset,
    lengthFrames: c.lengthFrames,
    fadeIn: c.fadeIn,
    fadeOut: c.fadeOut,
    fadeInShape: c.fadeInShape,
    fadeOutShape: c.fadeOutShape,
    gainDb: c.gainDb
  })

  /** Snapshot every setting: rate, tempo/grid, sources, tracks (clips + strip + inserts), master, view. */
  function serializeProject(): ProjectFile {
    return {
      version: 2,
      sampleRate: state.sampleRate,
      bpm: state.bpm,
      timeSig: { num: state.timeSigNum, den: state.timeSigDen },
      gridMode: state.gridMode,
      sources: sourceList()
        .filter((s) => s.kind !== 'inst')
        .map((s) => ({
          id: s.id,
          name: s.name,
          path: s.path,
          kind: s.kind as 'wav' | 'tone',
          toneSeconds: s.toneSeconds
        })),
      master: {
        gainDb: Number(masterEl.value),
        inserts: (masterBusInserts ?? [])
          .map(serializeInsert)
          .filter((x): x is SzInsert => x !== null)
      },
      midiTracks: serializeMidi(),
      stemColors: { ...stemColorTable },
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        mix: { ...g.mix },
        inserts: g.inserts.map(serializeInsert).filter((x): x is SzInsert => x !== null)
      })),
      view: {
        framesPerPixel: state.framesPerPixel,
        scrollFrames: state.scrollFrames,
        playhead: state.playhead
      },
      tracks: lanes.map((l) => ({
        title: (l.el.querySelector('.lane-title') as HTMLElement).textContent ?? '',
        mix: { ...l.mix },
        recIn: { ...l.recIn },
        strip: { bypass: l.dsp.bypass, params: structuredClone(l.dsp.params) },
        inserts: l.inserts.map(serializeInsert).filter((x): x is SzInsert => x !== null),
        clips: l.inst ? [] : l.clips.map(szClip),
        instrumentOf: l.inst ? midiTracks.findIndex((t) => t.id === l.inst?.midiTrackId) : undefined,
        live: l.live ? { monitor: l.live.monitor } : undefined,
        stem: l.stem ? l.stem : undefined,
        group: l.group !== undefined && groupById(l.group) ? l.group : undefined,
        color: l.color
      }))
    }
  }

  /** Replace the whole project with a saved snapshot (used on startup + Open). */
  async function restoreProject(p: ProjectFile): Promise<void> {
    if (state.playing) await scheduler.stop()

    closeAllPlugWins() // insert instances are about to be replaced

    // tear down current lanes (DOM) + all source VRAM buffers
    for (const l of lanes) {
      l.el.remove()
      l.strip.el.remove()
    }
    lanes.length = 0
    for (const g of groups) g.strip.el.remove()
    groups.length = 0
    nextGroupId = GROUP_ID_BASE + 1
    stemColorTable = {}
    nextId = 1
    selectedId = null
    audioPick = null
    selClips.clear()
    rangeSel = null
    resetHistory()
    anySolo = false
    masterStripEl.classList.remove('selected')
    clearSourceRegistry()
    clearMidi()

    const sr = Number(p.sampleRate) || state.sampleRate
    srSelect.value = String(sr)
    update({
      sampleRate: sr, // must precede uploadChannels (resample target)
      bpm: Number(p.bpm) > 0 ? Number(p.bpm) : 120,
      timeSigNum: Number(p.timeSig?.num) > 0 ? Number(p.timeSig?.num) : 4,
      timeSigDen: Number(p.timeSig?.den) > 0 ? Number(p.timeSig?.den) : 4,
      gridMode: (p.gridMode as DawState['gridMode']) || 'off'
    })

    // Rebuild sources: map each saved source id → a fresh AudioSource.
    const srcMap = new Map<number, AudioSource>()
    for (const ss of p.sources ?? []) {
      let src: AudioSource | null = null
      if (ss.kind === 'tone') src = makeToneSource(ss.toneSeconds ?? 6, ss.name || 'Demo tone')
      else if (ss.path) src = await importWavSource(ss.path, ss.name)
      if (src) srcMap.set(ss.id, src)
    }
    restoreMidi(p.midiTracks) // before the track loop: instrument lanes read it
    for (const [k, v] of Object.entries(p.stemColors ?? {})) {
      const c = normalizeColor(v)
      if (c && cleanStemName(k)) stemColorTable[cleanStemName(k)] = c
    }
    for (const sg of p.groups ?? []) {
      const g = addGroup(cleanStemName(sg.name) || 'Group', Number(sg.id) > GROUP_ID_BASE ? Number(sg.id) : undefined)
      const gc = normalizeColor(sg.color)
      if (gc) {
        g.color = gc
        applyGroupColor(g)
      }
      if (sg.mix) {
        g.mix.gainDb = Number(sg.mix.gainDb ?? 0)
        g.mix.pan = Number(sg.mix.pan ?? 0)
        g.mix.mute = !!sg.mix.mute
        g.mix.solo = !!sg.mix.solo
      }
      for (const si of sg.inserts ?? []) {
        const fx = deserializeInsert(si)
        if (fx) g.inserts.push(fx)
      }
      g.strip.setGain(g.mix.gainDb)
      g.strip.setPan(g.mix.pan)
      g.strip.m.classList.toggle('on', g.mix.mute)
      g.strip.s.classList.toggle('on', g.mix.solo)
      renderStripRack(g.id)
    }
    const v1 = !p.sources // pre-clip project: one full-length clip per track

    for (const t of p.tracks ?? []) {
      const imt = t.instrumentOf !== undefined && t.instrumentOf >= 0 ? midiTracks[t.instrumentOf] : undefined
      const lane = imt ? addInstrumentLane(imt) : addLane(t.title || 'Track')

      if (t.live) {
        lane.live = { monitor: t.live.monitor !== false }
        lane.el.classList.add('line')
      }
      if (imt) {
        // clips come from the instrument render, nothing to rebuild
      } else if (v1) {
        let src: AudioSource | null = null
        if (t.kind === 'tone') src = makeToneSource(t.toneSeconds ?? 6, t.title || 'Demo tone')
        else if (t.path) src = await importWavSource(t.path, t.title)
        if (src) {
          addClipToLane(lane, src)
          setLaneSub(lane, `${src.gpu.channelCount}ch · ${(sr / 1000) | 0}k`)
        }
      } else {
        for (const sc of t.clips ?? []) {
          const src = srcMap.get(sc.sourceId)
          if (!src) continue
          retainSource(src.id)
          lane.clips.push(
            makeClip({
              sourceId: src.id,
              name: sc.name || src.name,
              startFrame: sc.startFrame,
              srcOffset: sc.srcOffset,
              lengthFrames: sc.lengthFrames,
              fadeIn: sc.fadeIn,
              fadeOut: sc.fadeOut,
              fadeInShape: sc.fadeInShape,
              fadeOutShape: sc.fadeOutShape,
              gainDb: sc.gainDb
            })
          )
        }
        const s0 = lane.clips[0] && getSource(lane.clips[0].sourceId)
        if (s0) setLaneSub(lane, `${s0.gpu.channelCount}ch · ${(sr / 1000) | 0}k`)
      }

      if (t.mix) {
        lane.mix.gainDb = Number(t.mix.gainDb ?? 0)
        lane.mix.pan = Number(t.mix.pan ?? 0)
        lane.mix.mute = !!t.mix.mute
        lane.mix.solo = !!t.mix.solo
        lane.mix.rec = !!t.mix.rec
      }
      if (t.recIn) lane.recIn = { ch: Math.max(0, Number(t.recIn.ch) | 0), stereo: !!t.recIn.stereo }
      if (t.stem) lane.stem = cleanStemName(t.stem)
      if (t.group !== undefined && groupById(t.group)) lane.group = t.group
      {
        const tc = normalizeColor(t.color)
        if (tc) {
          lane.color = tc
          applyLaneColor(lane)
        }
      }
      if (lane.live) setLaneSub(lane, liveSub(lane))
      applyStripParams(lane.dsp, t.strip)
      lane.inserts.length = 0
      for (const si of t.inserts ?? []) {
        const fx = deserializeInsert(si)
        if (fx) lane.inserts.push(fx)
      }
      // reflect the restored mix into the channel strip DOM
      lane.strip.setGain(lane.mix.gainDb)
      lane.strip.setPan(lane.mix.pan)
      lane.strip.m.classList.toggle('on', lane.mix.mute)
      lane.strip.s.classList.toggle('on', lane.mix.solo)
      lane.strip.r.classList.toggle('on', lane.mix.rec)
      lane.el.classList.toggle('sat-active', lane.dsp.params.drive > 0.001)
      renderStripRack(lane.id)
      lane.dirty = true
    }
    refreshSolo()
    renderAudioList()

    // master gain + inserts
    const mg = Number(p.master?.gainDb ?? masterEl.value)
    masterEl.value = String(mg)
    syncMaster()
    if (masterBusInserts) {
      masterBusInserts.length = 0
      for (const si of p.master?.inserts ?? []) {
        const fx = deserializeInsert(si)
        if (fx) masterBusInserts.push(fx)
      }
    }
    renderStripRack('master')

    refreshTotals()

    // timeline view: honour the saved transform if it's sane, else fit
    const v = p.view
    if (v && Number(v.framesPerPixel) > 0) {
      update({
        framesPerPixel: Number(v.framesPerPixel),
        scrollFrames: Math.max(0, Number(v.scrollFrames) || 0),
        playhead: Math.max(0, Number(v.playhead) || 0)
      })
      userZoomed = true
    } else {
      fitToProject()
    }

    selectLane(lanes.length ? lanes[0].id : null)
    renderDetail() // selectLane no-ops if the id already matched — force a rebuild
    viewDirty = true
    void scheduler.warmup()
  }

  /** Build the snapshot, reporting a serialize failure distinctly from an IPC one. */
  function snapshotOrReport(): ProjectFile | null {
    try {
      return serializeProject()
    } catch (err) {
      console.error('[project] serialize failed', err)
      flashStatus(`save failed (serialize): ${(err as Error).message}`, true)
      return null
    }
  }
  async function doSave(): Promise<void> {
    const snap = snapshotOrReport()
    if (!snap) return
    try {
      if (typeof window.daw.projectSave !== 'function') {
        flashStatus('save failed: restart `npm run dev` (preload is stale)', true)
        return
      }
      const res = await window.daw.projectSave(snap)
      if (res.ok) flashStatus(`project saved · ${res.path}`)
      else flashStatus(`save failed: ${res.error}`, true)
    } catch (err) {
      console.error('[project] save IPC failed', err)
      flashStatus(`save failed: ${(err as Error).message}`, true)
    }
  }
  async function doSaveAs(): Promise<void> {
    const snap = snapshotOrReport()
    if (!snap) return
    try {
      const res = await window.daw.projectExport(snap)
      if (!res) return // dialog cancelled
      if (res.ok) flashStatus(`project saved · ${res.path}`)
      else flashStatus(`save failed: ${res.error}`, true)
    } catch (err) {
      console.error('[project] export IPC failed', err)
      flashStatus(`save failed: ${(err as Error).message}`, true)
    }
  }
  async function doOpen(): Promise<void> {
    try {
      const data = await window.daw.projectImport()
      if (!data) return
      await restoreProject(data as ProjectFile)
      flashStatus('project loaded')
    } catch (err) {
      console.error('[project] open failed', err)
      flashStatus(`open failed: ${(err as Error).message}`, true)
    }
  }
  $('proj-save').addEventListener('click', () => void doSave())
  $('proj-saveas').addEventListener('click', () => void doSaveAs())
  $('proj-open').addEventListener('click', () => void doOpen())

  /**
   * Import a DAWproject (Cubase 14+: File > Export > DAWproject). main unzips it and
   * extracts the WAVs; here the XML becomes an ordinary project snapshot that goes
   * through restoreProject, so everything downstream (save, undo reset, VRAM upload)
   * behaves as for a normal Open.
   */
  /** A note track whose notes are mostly on MIDI channel 10 (index 9) is a drum part. */
  const isDrumTrack = (clips: { notes: { channel: number }[] }[]): boolean => {
    const all = clips.flatMap((c) => c.notes)
    return all.length > 0 && all.filter((n) => n.channel === 9).length / all.length > 0.8
  }
  async function doImportDawproject(
    explicitPath?: string
  ): Promise<{ tracks: number; midiTracks: number; clips: number; warnings: string[] }> {
    const none = { tracks: 0, midiTracks: 0, clips: 0, warnings: [] as string[] }
    try {
      flashStatus('importing DAWproject…')
      const res = await window.daw.dawprojectOpen(explicitPath)
      if (!res) return none
      if (!res.ok) throw new Error(res.error)
      const imp = parseDawproject(res.xml)
      const sr = state.sampleRate
      const warnings = [...imp.warnings]
      for (const sk of res.skipped) warnings.push(`${sk}: only WAV audio is supported, skipped`)

      // one source per distinct audio file
      const sources: NonNullable<ProjectFile['sources']> = []
      const srcId = new Map<string, number>()
      const sourceFor = (file: string): number | null => {
        const have = srcId.get(file)
        if (have !== undefined) return have
        const path = res.files[file]
        if (!path) {
          warnings.push(`${file}: audio file missing or not WAV, clip skipped`)
          return null
        }
        const id = sources.length + 1
        // main prefixes extracted files with an index to keep names unique; it is not part of the name
        sources.push({ id, name: trackNameFromPath(path).replace(/^\d{3}_/, ''), path, kind: 'wav' })
        srcId.set(file, id)
        return id
      }

      const tracks: SzTrack[] = []
      const midi: SzMidiTrack[] = []
      for (const t of imp.tracks) {
        const mix = { gainDb: Math.max(-100, Math.min(12, t.gainDb)), pan: t.pan, mute: t.mute, solo: t.solo, rec: false }
        const strip = { bypass: false, params: defaultStripParams() }
        if (t.kind === 'notes') {
          // MIDI → instrument lane (simple GPU synth); the notes keep their MIDI identity
          midi.push({
            name: t.name,
            channel: Math.min(15, midi.length),
            mute: false, // the lane's mix carries mute / solo
            solo: false,
            outId: null,
            inId: null,
            instrument: isDrumTrack(t.midiClips)
              ? { kind: 'drums', params: defaultDrumParams() }
              : { kind: 'synth', params: defaultSynthParams() },
            clips: t.midiClips.map((c) => ({
              name: c.name,
              start: c.startBeats,
              length: Math.max(0.25, c.lengthBeats),
              notes: c.notes.map((n) => ({ start: n.startBeats - c.startBeats, dur: n.durBeats, key: n.key, vel: n.vel }))
            }))
          })
          tracks.push({ title: t.name, mix, strip, inserts: [], clips: [], instrumentOf: midi.length - 1 })
          continue
        }
        const clips: SzClip[] = []
        for (const c of t.audioClips) {
          const sid = sourceFor(c.file)
          if (sid === null) continue
          const len = Math.max(1, Math.round(c.lengthSec * sr))
          clips.push({
            sourceId: sid,
            name: c.name,
            startFrame: Math.max(0, Math.round(c.startSec * sr)),
            srcOffset: Math.max(0, Math.round(c.srcOffsetSec * sr)),
            lengthFrames: len,
            fadeIn: Math.min(len, Math.round(c.fadeInSec * sr)),
            fadeOut: Math.min(len, Math.round(c.fadeOutSec * sr)),
            fadeInShape: 'eqpow',
            fadeOutShape: 'eqpow',
            gainDb: 0
          })
        }
        tracks.push({ title: t.name, mix, strip, inserts: [], clips })
      }

      const snapshot: ProjectFile = {
        version: 2,
        sampleRate: sr,
        bpm: imp.bpm,
        timeSig: imp.timeSig,
        gridMode: state.gridMode,
        sources,
        master: { gainDb: Math.max(-100, Math.min(12, imp.masterGainDb)), inserts: [] },
        midiTracks: midi,
        view: { framesPerPixel: 0, scrollFrames: 0, playhead: 0 },
        tracks
      }
      await restoreProject(snapshot)
      const nClips = tracks.reduce((a, t) => a + (t.clips?.length ?? 0), 0)
      console.log('[dawproject]', imp.app, `${tracks.length} audio / ${midi.length} MIDI tracks, ${nClips} clips`, warnings)
      for (const w of warnings) console.warn('[dawproject] ', w)
      flashStatus(
        `DAWproject: ${tracks.length} audio + ${midi.length} MIDI tracks, ${nClips} clips` +
          (warnings.length ? ` · ${warnings.length} note(s) in console` : '')
      )
      return { tracks: tracks.length, midiTracks: midi.length, clips: nClips, warnings }
    } catch (err) {
      console.error('[dawproject] import failed', err)
      flashStatus(`DAWproject import failed: ${(err as Error).message}`, true)
      if (explicitPath) throw err // MCP callers want the error, the button just flashes it
      return none
    }
  }
  $('proj-import-dp').addEventListener('click', () => void doImportDawproject())

  /**
   * Export the project as a DAWproject. Audio sources are the original WAVs where they
   * exist (full quality, original rate); GPU-generated sources (demo tones) are rendered to
   * a float WAV. Instrument lanes export their MIDI — the receiving DAW supplies the sound.
   * Not exported: channel strip, inserts, per-clip gain, synth parameters.
   */
  async function doExportDawproject(explicitPath?: string): Promise<{ audioTracks: number; noteTracks: number; files: number; path?: string }> {
    const none = { audioTracks: 0, noteTracks: 0, files: 0 }
    try {
      if (lanes.length === 0) throw new Error('nothing to export')
      flashStatus('exporting DAWproject…')
      const sr = state.sampleRate
      const files: { name: string; path?: string; bytes?: ArrayBuffer }[] = []
      const sources: ExpAudioSource[] = []
      const fileOf = new Map<number, ExpAudioSource>()
      const sanitize = (s: string): string => s.replace(/[^\w .()-]+/g, '_').slice(0, 60) || 'audio'

      const sourceEntry = async (srcId: number): Promise<ExpAudioSource | null> => {
        const have = fileOf.get(srcId)
        if (have) return have
        const src = getSource(srcId)
        if (!src || src.kind === 'inst') return null
        const name = `audio/${String(files.length + 1).padStart(3, '0')}_${sanitize(src.name)}.wav`
        let entry: ExpAudioSource
        if (src.path) {
          const info = await window.daw.wavInfo(src.path)
          if (!info.ok) throw new Error(`${src.name}: ${info.error}`)
          files.push({ name, path: src.path })
          entry = { id: srcId, file: name, sampleRate: info.sampleRate, channels: Math.min(info.channels, 2), durationSec: info.frames / info.sampleRate }
        } else {
          const planar = await src.gpu.readChannels()
          files.push({ name, bytes: encodeWavFloat32(planar, sr) })
          entry = { id: srcId, file: name, sampleRate: sr, channels: planar.length, durationSec: src.gpu.totalFrames / sr }
        }
        sources.push(entry)
        fileOf.set(srcId, entry)
        return entry
      }

      const tracks: ExpTrack[] = []
      for (const l of lanes) {
        const title = (l.el.querySelector('.lane-title') as HTMLElement).textContent ?? 'Track'
        const base = { name: title, gainDb: l.mix.gainDb, pan: l.mix.pan, mute: l.mix.mute, solo: l.mix.solo, channels: 2 }
        const mt = l.inst ? midiTrackById(l.inst.midiTrackId) : undefined
        if (l.inst) {
          tracks.push({
            ...base,
            kind: 'notes',
            midiChannel: mt?.channel ?? 0,
            audioClips: [],
            midiClips: (mt?.clips ?? []).map((c) => ({
              name: c.name,
              startBeats: c.start,
              lengthBeats: c.length,
              notes: c.notes.map((n) => ({ start: n.start, dur: n.dur, key: n.key, vel: n.vel }))
            }))
          })
          continue
        }
        const audioClips = []
        for (const c of l.clips) {
          const e = await sourceEntry(c.sourceId)
          if (!e) continue
          audioClips.push({
            sourceId: c.sourceId,
            name: c.name,
            startSec: c.startFrame / sr,
            offsetSec: c.srcOffset / sr,
            lengthSec: c.lengthFrames / sr,
            fadeInSec: c.fadeIn / sr,
            fadeOutSec: c.fadeOut / sr
          })
        }
        const ch = audioClips.length ? (fileOf.get(audioClips[0].sourceId)?.channels ?? 2) : 2
        tracks.push({ ...base, kind: 'audio', channels: ch, audioClips, midiClips: [] })
      }

      const xml = buildDawprojectXml({
        bpm: state.bpm,
        timeSig: { num: state.timeSigNum, den: state.timeSigDen },
        masterGainDb: Number(masterEl.value),
        tracks,
        sources
      })
      const res = await window.daw.dawprojectSave(
        { projectXml: xml, metadataXml: buildMetadataXml('Awaker project'), defaultName: 'project', files },
        explicitPath
      )
      if (!res) return none
      if (!res.ok) throw new Error(res.error)
      const out = {
        audioTracks: tracks.filter((t) => t.kind === 'audio').length,
        noteTracks: tracks.filter((t) => t.kind === 'notes').length,
        files: files.length,
        path: res.path
      }
      flashStatus(`DAWproject exported: ${out.audioTracks} audio + ${out.noteTracks} MIDI tracks, ${out.files} files`)
      return out
    } catch (err) {
      console.error('[dawproject] export failed', err)
      flashStatus(`DAWproject export failed: ${(err as Error).message}`, true)
      if (explicitPath) throw err
      return none
    }
  }
  $('proj-export-dp').addEventListener('click', () => void doExportDawproject())

  /** Import a Standard MIDI File: each track with notes becomes an instrument track. */
  async function doImportMidi(explicitPath?: string): Promise<{ tracks: number; notes: number; bpm: number }> {
    const none = { tracks: 0, notes: 0, bpm: state.bpm }
    try {
      const res = await window.daw.midiOpen(explicitPath)
      if (!res) return none
      if (!res.ok) throw new Error(res.error)
      const smf = parseSmf(new Uint8Array(res.bytes))
      if (smf.tracks.length === 0) throw new Error('no notes in this MIDI file')
      // an empty project takes the file's tempo / meter; otherwise notes keep their beat positions
      if (lanes.length === 0) update({ bpm: Math.round(smf.bpm * 100) / 100, timeSigNum: smf.timeSig.num, timeSigDen: smf.timeSig.den })
      let notes = 0
      for (const t of smf.tracks) {
        const mt = addMidiTrack(t.name, t.channel)
        if (t.channel === 9) mt.instrument = { kind: 'drums', params: defaultDrumParams() } // GM channel 10
        const endBeats = t.notes.reduce((m, n) => Math.max(m, (n.tick + n.dur) / smf.ppq), 0)
        const clip = addMidiClip(mt, 0, Math.max(1, Math.ceil(endBeats)), t.name)
        for (const n of t.notes) addNote(clip, n.tick / smf.ppq, n.dur / smf.ppq, n.key, n.vel)
        notes += t.notes.length
        addInstrumentLane(mt)
      }
      refreshTotals()
      fitToProject()
      flashStatus(`MIDI: ${smf.tracks.length} tracks, ${notes} notes` + (smf.tempoChanges > 1 ? ' (tempo changes ignored)' : ''))
      return { tracks: smf.tracks.length, notes, bpm: state.bpm }
    } catch (err) {
      console.error('[midi] import failed', err)
      flashStatus(`MIDI import failed: ${(err as Error).message}`, true)
      if (explicitPath) throw err
      return none
    }
  }

  // ---- stems ----------------------------------------------------------------------------------
  const laneTitleOf = (l: Lane): string => (l.el.querySelector('.lane-title') as HTMLElement | null)?.textContent ?? `Track ${l.id}`
  const stemTracks = (): { id: number; title: string; stem: string }[] =>
    lanes.map((l) => ({ id: l.id, title: laneTitleOf(l), stem: l.stem ?? '' }))

  const groupSummary = (g: Group): unknown => ({
    id: g.id,
    name: g.name,
    mix: { ...g.mix },
    color: g.color,
    tracks: lanes.filter((l) => l.group === g.id).map((l) => ({ id: l.id, title: laneTitleOf(l) })),
    inserts: g.inserts.length
  })
  const listGroups = (): unknown => groups.map(groupSummary)

  function listStems(): { stems: { name: string; trackIds: number[]; tracks: string[] }[]; unassigned: { id: number; title: string }[] } {
    const all = stemTracks()
    return {
      stems: groupStems(all).map((g) => ({ name: g.name, color: stemColorTable[g.name] ?? null, trackIds: g.trackIds, tracks: g.trackTitles })),
      unassigned: all.filter((t) => !t.stem.trim()).map((t) => ({ id: t.id, title: t.title }))
    }
  }

  function setStem(trackId: number, stem: string): { id: number; title: string; stem: string; color: string | undefined } {
    const lane = laneById(trackId)
    if (!lane) throw new Error(`no track ${trackId}`)
    lane.stem = cleanStemName(stem)
    alignStem(lane) // the stem's tracks share one colour
    if (selectedId === lane.id) renderDetail()
    return { id: lane.id, title: laneTitleOf(lane), stem: lane.stem, color: lane.color }
  }

  interface StemRequest {
    /** Stem names to export (default: all). */
    stems?: string[]
    /** One file per track instead of per stem (a channel batch export). */
    perTrack?: boolean
    /** Also export every group channel (default: yes when no stem names are given). */
    includeGroups?: boolean
    folder?: string
    /** Check that the stems add up to the mix of the same tracks (default true when there are 2+ stems). */
    verify?: boolean
    startSeconds?: number
    seconds?: number
    settings?: Partial<StemExportSettings>
  }
  interface StemFile {
    stem: string
    /** true: the output of a group channel (bus), not a set of tracks summed straight to the master. */
    group?: boolean
    tracks: string[]
    path: string
    frames: number
    sampleRate: number
    bitDepth: number
    peakDb: number
    clamped: number
  }

  /**
   * Render each stem offline through the GPU path (strip + inserts + fader + pan of ITS tracks only), convert to the
   * requested rate / bit depth and write a WAV per stem. The sum of the stems is compared with a direct render of
   * the same tracks: that is the proof they add up.
   */
  async function exportStems(req: StemRequest = {}): Promise<{
    dir: string
    settings: StemExportSettings
    files: StemFile[]
    skipped: string[]
    verify?: { maxAbsDiff: number; snrDb: number | null; ok: boolean }
  }> {
    if (state.playing || scheduler.recording) throw new Error('stop the transport first')
    const settings = sanitizeStemExport(req.settings, getStemDefaults())
    const sr = state.sampleRate
    const outRate = settings.sampleRate || sr
    const grps = groups
    // what gets exported: stems by name (or one per track), plus the group channels (their bus output)
    type Item = StemGroup & { busId?: number }
    let items: Item[] = req.perTrack
      ? lanes
          .filter((l) => resolveLaneClips(l).length > 0)
          .map((l) => ({ name: laneTitleOf(l), trackIds: [l.id], trackTitles: [laneTitleOf(l)] }))
      : groupStems(stemTracks())
    const wantNames = req.stems && req.stems.length ? new Set(req.stems.map(cleanStemName)) : null
    if (req.includeGroups ?? !wantNames) {
      for (const g of grps) {
        const ids = lanes.filter((l) => l.group === g.id).map((l) => l.id)
        if (ids.length) items.push({ name: g.name, trackIds: ids, trackTitles: ids.map((i) => laneTitleOf(laneById(i)!)), busId: g.id })
      }
    }
    if (wantNames) {
      // a name that is both a stem and a group exports both; unknown names are an error
      const known = new Set([...items.map((g) => g.name), ...grps.map((g) => g.name)])
      for (const w of wantNames) if (!known.has(w)) throw new Error(`unknown stem / group: ${w} (known: ${[...known].join(', ') || 'none'})`)
      for (const g of grps) {
        if (!wantNames.has(g.name) || items.some((x) => x.busId === g.id)) continue
        const ids = lanes.filter((l) => l.group === g.id).map((l) => l.id)
        if (ids.length) items.push({ name: g.name, trackIds: ids, trackTitles: ids.map((i) => laneTitleOf(laneById(i)!)), busId: g.id })
      }
      items = items.filter((g) => wantNames.has(g.name))
    }
    // a group named like a stem, with the same tracks, IS that stem: export it once (as the bus output)
    const sameSet = (x: number[], y: number[]): boolean => x.length === y.length && x.every((v) => y.includes(v))
    items = items.filter(
      (it) => it.busId !== undefined || !items.some((o) => o.busId !== undefined && o.name === it.name && sameSet(o.trackIds, it.trackIds))
    )
    if (!items.length) throw new Error('nothing to export: give tracks a Stem name (Track detail → Stem), route tracks into a group, or use perTrack')

    const opened = await window.daw.exportOpenDir(req.folder ?? '', 'Mix')
    if (!opened.ok) throw new Error(`export folder: ${opened.error}`)
    const from = Math.round(Math.max(0, req.startSeconds ?? 0) * sr)
    const frames = req.seconds != null && req.seconds > 0 ? Math.round(req.seconds * sr) : null
    const toSource = (l: Lane): MixSource => {
      const s = laneToSource(l)
      return { ...s, strip: settings.process === 'dry' ? undefined : s.strip, inserts: settings.process === 'full' ? s.inserts : [] }
    }
    const used = new Set<string>()
    const files: StemFile[] = []
    const skipped: string[] = []
    let sum: Float32Array | null = null
    const members: Lane[] = []
    const db = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity)

    for (let gi = 0; gi < items.length; gi++) {
      const g = items[gi]
      const ls = g.trackIds.map((id) => laneById(id)).filter((l): l is Lane => !!l && resolveLaneClips(l).length > 0)
      if (!ls.length) {
        skipped.push(g.name)
        continue
      }
      flashStatus(`stem ${gi + 1}/${items.length}: ${g.name}…`)
      // a group channel exports as the OUTPUT of the bus: its tracks, then the group inserts, fader and pan
      const bus = g.busId !== undefined ? groupById(g.busId) : undefined
      const busMix: MixGroup | undefined = bus
        ? { ...groupToMix(bus), inserts: settings.process === 'full' ? bus.inserts : [] }
        : undefined
      const r = await scheduler.renderOffline(
        ls.map((l) => (busMix ? { ...toSource(l), group: 0 } : { ...toSource(l), group: undefined })),
        {
          startFrame: from,
          frames,
          tailSeconds: settings.tailSeconds,
          masterChain: settings.masterChain,
          groups: busMix ? [busMix] : []
        }
      )
      if (!busMix) {
        // the sum check covers the stems by name / per track; a bus output carries its own processing
        members.push(...ls)
        if (!sum) sum = new Float32Array(r.audio.length)
        for (let i = 0; i < r.audio.length && i < sum.length; i++) sum[i] += r.audio[i]
      }
      const data = outRate === sr ? r.audio : resampleInterleaved(r.audio, 2, sr, outRate)
      const enc = encodeWavPcm(data, 2, outRate, settings.bitDepth)
      const name = stemFileName('Mix', g.name, outRate, settings.bitDepth, used)
      const w = await window.daw.exportWriteFile(opened.dir, name, enc.bytes)
      if (!w.ok) throw new Error(`write ${name}: ${w.error}`)
      files.push({
        stem: g.name,
        ...(busMix ? { group: true } : {}),
        tracks: ls.map(laneTitleOf),
        path: w.path,
        frames: Math.floor(data.length / 2),
        sampleRate: outRate,
        bitDepth: settings.bitDepth,
        peakDb: Math.round(db(Math.max(r.peak[0], r.peak[1])) * 100) / 100,
        clamped: enc.clamped
      })
    }

    let verify: { maxAbsDiff: number; snrDb: number | null; ok: boolean } | undefined
    const doVerify = req.verify ?? files.length > 1
    if (doVerify && sum && members.length > 0) {
      flashStatus('stems: checking they add up…')
      const ref = await scheduler.renderOffline(members.map(toSource), {
        startFrame: from,
        frames,
        tailSeconds: settings.tailSeconds,
        masterChain: settings.masterChain
      })
      const t = nullTest(sum, ref.audio)
      verify = { maxAbsDiff: t.maxAbsDiff, snrDb: Number.isFinite(t.snrDb) ? Math.round(t.snrDb * 10) / 10 : null, ok: t.maxAbsDiff < 1e-4 }
    }
    flashStatus(`stems exported: ${files.length} file(s) → ${opened.dir}`)
    return { dir: opened.dir, settings, files, skipped, ...(verify ? { verify } : {}) }
  }

  /**
   * Average spectrum of the whole mix against the AI-mix target. `breakdown` also measures every part on its own
   * (each group channel, each stem that is not in a group, and the rest) so the report can say which part carries
   * the energy of a region and how much it would have to move. Renders are streamed through the analyser: no
   * copy of the audio is kept.
   */
  async function analyzeSpectrum(req: { scope?: string; startSeconds?: number; seconds?: number }): Promise<unknown> {
    if (state.playing || scheduler.recording) throw new Error('stop the transport first')
    const target = getMixTarget()
    if (!target) throw new Error('no target yet: call mix_target with a genre first (the AI Mix button sets one)')
    const sr = state.sampleRate
    const from = Math.round(Math.max(0, req.startSeconds ?? 0) * sr)
    const frames = req.seconds != null && req.seconds > 0 ? Math.round(req.seconds * sr) : null
    const expected = frames ?? Math.max(0, state.totalFrames - from)
    if (expected <= 0) throw new Error('nothing to analyse: the project has no audio')
    const breakdown = req.scope === 'breakdown'
    const t0 = performance.now()

    flashStatus('spectrum: the mix…')
    const accM = new SpectrumAccumulator(sr, expected)
    const m = await scheduler.renderMaster({ startFrame: from, frames, onBlock: (b, n) => accM.pushInterleaved(b, n) })
    const measured = accM.finish()
    if (measured.usedFrames === 0) throw new Error('the mix is silent (everything muted, or no audio in this range)')

    let parts: BucketLevels[] | undefined
    if (breakdown) {
      type Bucket = { name: string; owner: BucketLevels['owner']; ls: Lane[]; bus?: Group }
      const audible = lanes.filter((l) => resolveLaneClips(l).length > 0)
      const buckets: Bucket[] = []
      for (const g of groups) {
        const ls = audible.filter((l) => l.group === g.id)
        if (ls.length) buckets.push({ name: g.name, owner: { kind: 'group', id: g.id }, ls, bus: g })
      }
      const rest = audible.filter((l) => l.group === undefined || !groupById(l.group))
      for (const st of groupStems(rest.map((l) => ({ id: l.id, title: laneTitleOf(l), stem: l.stem ?? '' })))) {
        buckets.push({ name: st.name, owner: { kind: 'stem', tracks: st.trackIds }, ls: st.trackIds.map((id) => laneById(id)).filter((l): l is Lane => !!l) })
      }
      const loose = rest.filter((l) => !(l.stem ?? '').trim())
      if (loose.length > 0 && loose.length <= 32) {
        // not in a group or a stem: each track is its own part, so a correction can go to the track that causes it
        for (const l of loose) buckets.push({ name: laneTitleOf(l), owner: { kind: 'other', tracks: [l.id] }, ls: [l] })
      } else if (loose.length > 0) {
        buckets.push({ name: 'Other', owner: { kind: 'other', tracks: loose.map((l) => l.id) }, ls: loose })
      }

      parts = []
      for (let i = 0; i < buckets.length; i++) {
        const bk = buckets[i]
        flashStatus(`spectrum: ${bk.name} (${i + 1}/${buckets.length})…`)
        const acc = new SpectrumAccumulator(sr, expected)
        const bus = bk.bus ? groupToMix(bk.bus) : undefined
        await scheduler.renderOffline(
          bk.ls.map((l) => ({ ...laneToSource(l), group: bus ? 0 : undefined })),
          { startFrame: from, frames, tailSeconds: 0, masterChain: false, groups: bus ? [bus] : [], keepAudio: false, onBlock: (b, n) => acc.pushInterleaved(b, n) }
        )
        const sp = acc.finish()
        if (sp.usedFrames > 0) parts.push({ name: bk.name, owner: bk.owner, levelDb: sp.levelDb })
      }
    }
    flashStatus('spectrum: done')
    const db = (x: number): number => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -200)
    return {
      ...buildReport(measured, target, parts),
      scope: breakdown ? 'breakdown' : 'master',
      masterPeakDb: db(Math.max(m.peak[0], m.peak[1])),
      parts: parts?.map((p) => ({ name: p.name, owner: p.owner })),
      renderSeconds: Math.round((performance.now() - t0) / 100) / 10
    }
  }

  /**
   * Per-track level as it leaves the channel (strip + inserts + fader + pan, before any group / master): the RMS
   * of the playing stretches, the peak, the crest and how far the loudest moment sticks out — and the trim that
   * would bring the RMS to `targetDb`. Each track is rendered on its own and streamed through the meter.
   */
  async function trackLevels(req: { tracks?: number[]; targetDb?: number; startSeconds?: number; seconds?: number }): Promise<unknown> {
    if (state.playing || scheduler.recording) throw new Error('stop the transport first')
    const sr = state.sampleRate
    const target = req.targetDb !== undefined && Number.isFinite(req.targetDb) ? Math.max(-60, Math.min(0, req.targetDb)) : -18
    const from = Math.round(Math.max(0, req.startSeconds ?? 0) * sr)
    const frames = req.seconds != null && req.seconds > 0 ? Math.round(req.seconds * sr) : null
    const want = req.tracks && req.tracks.length ? new Set(req.tracks) : null
    const ls = lanes.filter((l) => resolveLaneClips(l).length > 0 && (!want || want.has(l.id)))
    if (!ls.length) throw new Error('no tracks with audio' + (want ? ' among the given ids' : ''))
    const t0 = performance.now()
    const out: unknown[] = []
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]
      flashStatus(`levels: ${laneTitleOf(l)} (${i + 1}/${ls.length})…`)
      const meter = new LevelMeter(sr)
      await scheduler.renderOffline([{ ...laneToSource(l), group: undefined }], {
        startFrame: from,
        frames,
        tailSeconds: 0,
        masterChain: false,
        groups: [],
        keepAudio: false,
        onBlock: (b, n) => meter.pushInterleaved(b, n)
      })
      const st = meter.finish()
      const p = l.dsp.params
      out.push({
        id: l.id,
        title: laneTitleOf(l),
        ...(st ?? { silent: true }),
        faderDb: l.mix.gainDb,
        muted: l.mix.mute,
        trimDb: p.trimDb,
        comp: { on: p.comp.on, threshDb: p.comp.threshDb, ratio: p.comp.ratio, attackMs: p.comp.attackMs, releaseMs: p.comp.releaseMs, makeupDb: p.comp.makeupDb },
        ...(st ? { suggestTrimDb: suggestTrimDb(p.trimDb, st.rmsDb, target) } : {})
      })
    }
    flashStatus('levels: done')
    return { targetDb: target, tracks: out, renderSeconds: Math.round((performance.now() - t0) / 100) / 10 }
  }

  /**
   * The whole mix as one WAV: the same render as a bounce (strips, inserts, groups, master chain + fader), then
   * the Options → Export rate / bit depth. Returns where it went and what was measured.
   */
  async function exportMixdown(req: { folder?: string; file?: { dir: string; name: string }; settings?: Record<string, unknown> } = {}): Promise<{
    path: string
    seconds: number
    sampleRate: number
    bitDepth: number
    peakDb: number
    rmsDb: number
    lufsIntegrated: number | null
    clippedFrames: number
    clamped: number
    renderSeconds: number
  }> {
    if (state.playing || scheduler.recording) throw new Error('stop the transport first')
    if (!lanes.some((l) => resolveLaneClips(l).length > 0)) throw new Error('nothing to export: the project has no audio')
    const settings = sanitizeStemExport(req.settings, getStemDefaults())
    const sr = state.sampleRate
    const outRate = settings.sampleRate || sr
    // a file the person named (File → Export → Mixdown…), or a folder + a generated name (MCP)
    let target = req.file
    if (!target) {
      const opened = await window.daw.exportOpenDir(req.folder ?? '', 'Mix')
      if (!opened.ok) throw new Error(`export folder: ${opened.error}`)
      target = { dir: opened.dir, name: stemFileName('Mix', 'Mixdown', outRate, settings.bitDepth, new Set()) }
    }
    flashStatus('mixdown: rendering…')
    const r = await scheduler.bounce(0, null, settings.tailSeconds, true)
    if (!r.audio) throw new Error('the render came back empty')
    flashStatus('mixdown: writing…')
    const data = outRate === sr ? r.audio : resampleInterleaved(r.audio, 2, sr, outRate)
    const enc = encodeWavPcm(data, 2, outRate, settings.bitDepth)
    const w = await window.daw.exportWriteFile(target.dir, target.name, enc.bytes)
    if (!w.ok) throw new Error(`write ${target.name}: ${w.error}`)
    const r1 = (x: number): number => Math.round(x * 10) / 10
    return {
      path: w.path,
      seconds: r1(r.seconds),
      sampleRate: outRate,
      bitDepth: settings.bitDepth,
      peakDb: r1(Math.max(r.peakDb[0], r.peakDb[1])),
      rmsDb: r1(Math.max(r.rmsDb[0], r.rmsDb[1])),
      lufsIntegrated: Number.isFinite(r.lufsIntegrated) ? r1(r.lufsIntegrated) : null,
      clippedFrames: r.clippedFrames,
      clamped: enc.clamped,
      renderSeconds: r1(r.renderMs / 1000)
    }
  }

  /** Each group channel's own output peak over the whole song (its tracks, then the group inserts and fader). */
  async function groupOutputPeaks(): Promise<{ id: number; name: string; peakDb: number }[]> {
    if (state.playing || scheduler.recording) throw new Error('stop the transport first')
    const out: { id: number; name: string; peakDb: number }[] = []
    for (const g of groups) {
      const ls = lanes.filter((l) => l.group === g.id && resolveLaneClips(l).length > 0)
      if (!ls.length) continue
      const r = await scheduler.renderOffline(
        ls.map((l) => ({ ...laneToSource(l), group: 0 })),
        { startFrame: 0, frames: null, tailSeconds: 0, masterChain: false, groups: [groupToMix(g)], keepAudio: false }
      )
      const pk = Math.max(r.peak[0], r.peak[1])
      out.push({ id: g.id, name: g.name, peakDb: pk > 0 ? Math.round(20 * Math.log10(pk) * 10) / 10 : -Infinity })
    }
    return out
  }

  /** File → Export → Mixdown…: pick a folder, write the mix, report what it measured. */
  async function doExportMixdownUi(): Promise<void> {
    try {
      if (!lanes.some((l) => resolveLaneClips(l).length > 0)) {
        flashStatus('nothing to export: the project has no audio', true)
        return
      }
      // 1) format (bit depth / sample rate / tail; the Options values are the start), 2) the file name
      const defaults = getStemDefaults()
      const choice = await askMixdownFormat(defaults, state.sampleRate)
      if (!choice) return
      const rate = (choice.sampleRate || state.sampleRate) / 1000
      const target = await window.daw.exportSaveWav(`Mixdown_${rate}k_${choice.bitDepth === 32 ? '32f' : choice.bitDepth}.wav`)
      if (!target) return
      const r = await exportMixdown({ file: target, settings: { ...choice } })
      const lufs = r.lufsIntegrated === null ? '' : ` · ${r.lufsIntegrated} LUFS`
      const warn = r.clippedFrames > 0 || r.clamped > 0 ? ` · ${r.clippedFrames} clipped frames (lower the master fader)` : ''
      flashStatus(`mixdown written: peak ${r.peakDb} dB${lufs}${warn} → ${r.path}`, r.clippedFrames > 0 || r.clamped > 0)
    } catch (err) {
      flashStatus(`mixdown failed: ${(err as Error).message}`, true)
    }
  }
  $('proj-export-mixdown').addEventListener('click', () => void doExportMixdownUi())

  /** File → Export → Stems…: pick a folder, run with the Options defaults, report. */
  async function doExportStemsUi(): Promise<void> {
    try {
      if (groupStems(stemTracks()).length === 0 && !lanes.some((l) => l.group !== undefined && groupById(l.group))) {
        flashStatus('nothing to export: type a Stem name on tracks (left pane) or route tracks into a group', true)
        return
      }
      const folder = await window.daw.exportPickDir()
      if (!folder) return
      const r = await exportStems({ folder })
      const v = r.verify ? ` · sum check ${r.verify.ok ? 'OK' : 'MISMATCH'}` : ''
      const clipped = r.files.reduce((n, f) => n + f.clamped, 0)
      const warn = clipped > 0 ? ` · ${clipped} samples clipped (use 32-bit float, or lower the faders)` : ''
      flashStatus(`stems exported: ${r.files.length} file(s)${v}${warn} → ${r.dir}`, (r.verify ? !r.verify.ok : false) || clipped > 0)
    } catch (err) {
      flashStatus(`stem export failed: ${(err as Error).message}`, true)
    }
  }
  $('proj-export-stems').addEventListener('click', () => void doExportStemsUi())
  $('add-group').addEventListener('click', () => {
    const g = addGroup(`Group ${groups.length + 1}`)
    selectLane(g.id)
    flashStatus(`${g.name} added: pick Output = ${g.name} on tracks to route them into it`)
  })

  /** Export all MIDI tracks as a format-1 SMF (480 ppq at the project tempo). */
  async function doExportMidi(explicitPath?: string): Promise<{ tracks: number; notes: number; path?: string }> {
    const none = { tracks: 0, notes: 0 }
    try {
      const PPQ = 480
      const tracks = midiTracks
        .filter((t) => t.clips.some((c) => c.notes.length > 0))
        .map((t) => ({
          name: t.name,
          channel: t.channel,
          notes: t.clips.flatMap((c) =>
            c.notes.map((n) => ({ tick: (c.start + n.start) * PPQ, dur: n.dur * PPQ, key: n.key, vel: n.vel }))
          )
        }))
      if (tracks.length === 0) {
        flashStatus('no MIDI notes to export', true)
        if (explicitPath) throw new Error('no MIDI notes to export')
        return none
      }
      const bytes = writeSmf(tracks, { ppq: PPQ, bpm: state.bpm, timeSig: { num: state.timeSigNum, den: state.timeSigDen } })
      const res = await window.daw.midiSave(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'project', explicitPath)
      if (!res) return none
      if (!res.ok) throw new Error(res.error)
      const notes = tracks.reduce((a, t) => a + t.notes.length, 0)
      flashStatus(`MIDI exported: ${tracks.length} tracks, ${notes} notes`)
      return { tracks: tracks.length, notes, path: res.path }
    } catch (err) {
      console.error('[midi] export failed', err)
      flashStatus(`MIDI export failed: ${(err as Error).message}`, true)
      if (explicitPath) throw err
      return none
    }
  }
  $('midi-import').addEventListener('click', () => void doImportMidi())
  $('midi-export').addEventListener('click', () => void doExportMidi())

  // Options: read the options file (fixed name, user-data folder), apply it, wire the toolbar button
  void initOptions((m, isErr) => flashStatus(m, isErr))
  ensureMcpLamp() // the MCP lamp is always there; dark unless the MCP server is on and working

  const monitorBtn = $('monitor-toggle')
  monitorBtn.addEventListener('click', () => {
    const on = !scheduler.monitorOn
    monitorBtn.classList.toggle('on', on)
    void (on ? scheduler.startMonitor() : scheduler.stopMonitor()).catch((err) => {
      monitorBtn.classList.remove('on')
      flashStatus(`monitor: ${(err as Error).message}`, true)
    })
  })
  // instrument lanes follow their MIDI data and the project tempo
  onMidiChange(() => lanes.forEach(scheduleInstrumentRender))
  let lastInstBpm = state.bpm
  subscribe((st) => {
    if (st.bpm !== lastInstBpm) {
      lastInstBpm = st.bpm
      lanes.forEach(scheduleInstrumentRender)
    }
  })

  // ---- File menu -----------------------------------------------------------
  /** Start from an empty project (project rate and tempo are kept). */
  async function doNew(): Promise<void> {
    if (lanes.length && !window.confirm('Start a new project? Unsaved changes to the current project are lost.')) return
    try {
      await restoreProject({
        version: 1,
        sampleRate: state.sampleRate,
        bpm: 120,
        timeSig: { num: 4, den: 4 },
        gridMode: 'off',
        sources: [],
        master: { gainDb: 0, inserts: [] },
        midiTracks: [],
        view: { framesPerPixel: 0, scrollFrames: 0, playhead: 0 },
        tracks: []
      })
      flashStatus('new project')
    } catch (err) {
      console.error('[project] new failed', err)
      flashStatus(`new project failed: ${(err as Error).message}`, true)
    }
  }
  $('proj-new').addEventListener('click', () => void doNew())
  {
    const fileBtn = $('filemenu-btn')
    const fileList = $('filemenu-list')
    const setFileMenu = (open: boolean): void => {
      fileList.hidden = !open
      fileBtn.setAttribute('aria-expanded', String(open))
    }
    fileBtn.addEventListener('click', () => setFileMenu(fileList.hidden))
    // choosing an item closes the menu (the item's own handler still runs)
    fileList.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) setFileMenu(false)
    })
    window.addEventListener('pointerdown', (e) => {
      if (!fileList.hidden && !(e.target as HTMLElement).closest('#filemenu')) setFileMenu(false)
    })
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && !fileList.hidden) {
          setFileMenu(false)
          fileBtn.focus()
          e.stopPropagation()
        }
      },
      true
    )
  }

  // The native File menu (main) triggers the same handlers as the in-window File menu.
  const FILE_OPS: Record<string, string> = {
    new: 'proj-new',
    open: 'proj-open',
    save: 'proj-save',
    saveas: 'proj-saveas',
    'import-dawproject': 'proj-import-dp',
    'import-midi': 'midi-import',
    'export-dawproject': 'proj-export-dp',
    'export-midi': 'midi-export',
    'export-stems': 'proj-export-stems',
    'export-mixdown': 'proj-export-mixdown'
  }
  window.daw.onFileCommand?.((op) => {
    const id = FILE_OPS[op]
    if (id) $(id).click()
  })

  // ---- add-track panel (ui/add-track.ts)--------------------------------------
  initAddTrack({
    existingNames: () => lanes.map((l) => (l.el.querySelector('.lane-title') as HTMLElement | null)?.textContent ?? ''),
    pickWavs: async () => {
      const paths = await window.daw.openAudioFiles()
      if (!paths || paths.length === 0) return false
      await loadFiles(paths)
      return true
    },
    addTone: async () => {
      if (state.playing) await scheduler.stop()
      const src = makeToneSource(6, 'Demo tone') // generated straight at project rate
      const lane = addLane(src.name)
      addClipToLane(lane, src)
      setLaneSub(lane, `${src.gpu.channelCount}ch · ${(state.sampleRate / 1000) | 0}k`)
      refreshTotals()
      fitToProject()
      void scheduler.warmup()
    },
    addInstrument: (spec) => {
      const lane =
        spec.kind === 'drums'
          ? addDrumTrack(spec.name, spec.preset, spec.bars)
          : spec.kind === 'fm' || spec.kind === 'earlysynth'
            ? addFmTrack(spec.kind, spec.name, spec.preset, spec.bars)
            : addSynthTrack(spec.name, spec.bars)
      refreshTotals()
      fitToProject()
      selectLane(lane.id)
      const mt = lane.inst ? midiTrackById(lane.inst.midiTrackId) : undefined
      if (mt && spec.openEditor) openTrackEditor(mt)
    },
    addLine: (spec) => {
      const lane = addLiveLane(spec.name, spec.ch, spec.stereo)
      if (lane.live) lane.live.monitor = spec.monitor
      setLaneSub(lane, liveSub(lane))
      refreshTotals()
      selectLane(lane.id)
      renderDetail()
    }
  })

  window.addEventListener('keydown', (e) => {
    // Ctrl/⌘ project shortcuts work regardless of focus.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 's') {
        e.preventDefault()
        void (e.shiftKey ? doSaveAs() : doSave())
        return
      }
      if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        void doNew()
        return
      }
      if (k === 'o' && !e.shiftKey) {
        e.preventDefault()
        void doOpen()
        return
      }
    }
    // Don't hijack keys while typing in a field / on a slider.
    const t = e.target as HTMLElement | null
    const tag = t?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) {
      // A checkbox / radio / slider has no use for Space of its own while you work a strip (it would toggle
      // the box instead of play / stop), so Space still reaches the transport — except inside a dialog.
      const type = (t as HTMLInputElement).type
      const plain = tag === 'INPUT' && ['checkbox', 'radio', 'range', 'button'].includes(type)
      if (!(plain && e.code === 'Space' && !t?.closest('#addtrack, #options, #pianoroll, #stepgrid'))) return
    }
    if (e.repeat) return
    if (e.code === 'Space') {
      e.preventDefault() // else a focused button gets clicked / page scrolls
      togglePlay()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void scheduler.seek(0) // to song head (jumps playback too if playing)
    } else if (e.key === 'Backspace') {
      // Delete has a menu accelerator; Backspace is a laptop-friendly alias.
      e.preventDefault()
      runEditOp('delete')
    } else if (e.key === '1') setTool('select')
    else if (e.key === '2') setTool('split')
    else if (e.key === '3') setTool('range')
  })

  // Space is activation on keyup for a focused checkbox / radio: swallow it where keydown went to the transport.
  window.addEventListener('keyup', (e) => {
    const t = e.target as HTMLElement | null
    if (e.code !== 'Space' || t?.tagName !== 'INPUT' || t.closest('#addtrack, #options, #pianoroll, #stepgrid')) return
    if (['checkbox', 'radio'].includes((t as HTMLInputElement).type)) e.preventDefault()
  })

  // ---- edit tools: palette + pointer routing on the tracks area ----
  for (const b of document.querySelectorAll<HTMLButtonElement>('#toolbar .tool'))
    b.addEventListener('click', () => setTool(b.dataset.tool as EditTool))
  setTool(state.editTool) // seed the toolbar + #tracks[data-tool]
  // Bubbles before the tracksScroll seek handler; the select tool only
  // stopPropagation()s when it actually grabs a clip, so empty clicks still seek.
  tracksEl.addEventListener('pointerdown', onEditPointerDown)
  // Edit menu / accelerators (Cut·Copy·Paste·Delete·Split·Select All) from main.
  window.daw.onEditCommand?.(runEditOp)

  // One track per WAV path, loaded sequentially so a big stem set doesn't spike
  // memory. Progress shows in the gpu-status slot (frame() owns #metrics).
  async function loadFiles(paths: string[]): Promise<void> {
    if (!paths.length) return
    if (state.playing) await scheduler.stop()
    const prevStatus = gpuStatus.textContent
    let made = 0
    for (let i = 0; i < paths.length; i++) {
      if (paths.length > 1) gpuStatus.textContent = `loading ${i + 1}/${paths.length}…`
      if (await addWavLane(paths[i])) made++
    }
    gpuStatus.textContent = prevStatus
    if (!made) return
    refreshTotals()
    fitToProject()
    void scheduler.warmup()
  }

  // ---- recording ---------------------------------------------------------
  /** Test hook (MCP / regression): record a built-in signal instead of hardware input. */
  let recSynthetic = false

  scheduler.onRecNotice = (msg) => flashStatus(`rec: ${msg}`, true)

  /** Finished takes → WAV on disk, AudioSource + clip on the armed lane (one undo step). */
  let commitPromise: Promise<void> = Promise.resolve()
  scheduler.onTakes = (takes: Take[]) => {
    commitPromise = (async () => {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      pushUndo()
      let wrote = 0
      for (const t of takes) {
        const lane = laneById(t.laneId)
        if (!lane) {
          for (const b of t.gpu.channels) b.destroy()
          continue
        }
        const title = (lane.el.querySelector('.lane-title') as HTMLElement).textContent ?? 'Track'
        const name = `${title}_${stamp}`
        const n = t.planar.length
        const inter = new Float32Array(t.frames * n)
        for (let c = 0; c < n; c++) for (let i = 0; i < t.frames; i++) inter[i * n + c] = t.planar[c][i]
        const res = await window.daw.recWriteWav(`${name}_T${lane.id}`, state.sampleRate, n, inter.buffer as ArrayBuffer)
        if (!res.ok) flashStatus(`take not saved to disk: ${res.error}`, true)
        const src = registerSource({
          name,
          path: res.ok ? res.path : null,
          kind: 'wav',
          gpu: t.gpu,
          envelope: computeEnvelope(t.planar, state.sampleRate)
        })
        // t.startFrame is already latency-compensated; t.skip = head frames before the timeline origin
        clearRange(lane, t.startFrame, t.startFrame + t.frames - (t.skip ?? 0)) // new take replaces what it overlaps
        addClipToLane(lane, src, t.startFrame, t.skip ?? 0)
        setLaneSub(lane, `${n}ch · ${(state.sampleRate / 1000) | 0}k · rec`)
        lane.dirty = true
        wrote++
      }
      refreshTotals()
      viewDirty = true
      renderAudioList()
      if (wrote) flashStatus(`recorded ${wrote} take${wrote > 1 ? 's' : ''}`)
    })()
  }

  /** Start recording every armed track from the playhead (stop with Stop / the Rec button). */
  async function startRecording(synthetic: boolean): Promise<void> {
    if (state.playing) throw new Error('stop transport first')
    const armed = lanes.filter((l) => l.mix.rec)
    // instrument lanes record MIDI (from their input port), not audio
    const armedAudio = armed.filter((l) => !l.inst)
    const armedMidi = armed
      .map((l) => (l.inst ? midiTrackById(l.inst.midiTrackId) : undefined))
      .filter((t): t is MidiTrack => !!t && !!t.inId)
    if (!armedAudio.length && !armedMidi.length) {
      flashStatus('arm a track first (R button; an instrument track also needs a MIDI input)', true)
      throw new Error('no track is armed (set rec on a track first)')
    }
    const targets = armedAudio.map((l) => ({ laneId: l.id, ch: l.recIn.ch, stereo: l.recIn.stereo }))
    // MIDI-only take: a synthetic take with no targets just keeps the transport running
    await scheduler.startRecord(state.playhead, targets, { synthetic: targets.length === 0 ? true : synthetic })
    if (scheduler.recording && armedMidi.length) midiIo.startRecording(armedMidi, () => scheduler.currentFrame())
  }
  /** Arm-driven record toggle: starts at the playhead, Stop (or this again) commits the takes. */
  function toggleRecord(): void {
    if (scheduler.recording) {
      void scheduler.stop()
      return
    }
    if (state.playing) return // can't punch in mid-play; stop first
    void startRecording(recSynthetic).catch(() => {})
  }
  recBtn.addEventListener('click', toggleRecord)

  // MIDI ports for instrument tracks (external output + keyboard recording)
  void midiIo.init()
  midiIo.onPortsChange(() => {
    const sel = typeof selectedId === 'number' ? laneById(selectedId) : undefined
    if (sel?.inst) renderDetail()
  })
  midiIo.startPump(
    () => scheduler.currentFrame(),
    (mt) => {
      const l = lanes.find((x) => x.inst?.midiTrackId === mt.id)
      return !l || (!l.mix.mute && (!anySolo || l.mix.solo))
    }
  )

  // ---- MCP tool handlers (dev/regression; the server itself is opt-in in main) ----
  registerMcpTools({
    lanes: lanes as unknown as McpLane[],
    scheduler,
    serializeProject,
    restoreProject: (p) => restoreProject(p as ProjectFile),
    importDawproject: (path) => doImportDawproject(path),
    importMidi: (path) => doImportMidi(path),
    addLiveLane: (name, ch, stereo) => {
      const lane = addLiveLane(name, ch, stereo)
      refreshTotals()
      return lane as unknown as McpLane
    },
    monitor: async (action, synthetic, latencyMs) => {
      if (latencyMs !== undefined && liveBusRef) liveBusRef.latencyMs = latencyMs
      if (action === 'start') scheduler.liveSynthetic = synthetic // stop must not change the input source
      if (action === 'start') await scheduler.startMonitor()
      else await scheduler.stopMonitor()
      monitorBtn.classList.toggle('on', scheduler.monitorOn)
      return scheduler.liveInfo()
    },
    liveInfo: () => ({ ...scheduler.liveInfo(), inputChannels: scheduler.inputChannels, inputError: scheduler.inputError }),
    exportDawproject: (path) => doExportDawproject(path),
    addDrumTrack: (name, preset, bars, bpm) => {
      if (bpm && bpm > 0) update({ bpm })
      const lane = addDrumTrack(name, preset, bars)
      refreshTotals()
      return lane as unknown as McpLane
    },
    pianoRoll: (cmd) => {
      const mt = cmd.track !== undefined ? midiTracks[cmd.track] : undefined
      if (cmd.action === 'open') {
        if (!mt) throw new Error(`no MIDI track at index ${cmd.track}`)
        openPianoRoll(mt, cmd.clip ?? 0)
      } else if (!pianoRoll) {
        throw new Error('piano roll was never opened')
      } else if (cmd.action === 'pointer') {
        pianoRoll.pointer(cmd.kind ?? 'down', cmd.x ?? 0, cmd.y ?? 0, { shift: cmd.shift, alt: cmd.alt, button: cmd.button })
      } else if (cmd.action === 'key') {
        pianoRoll.key(cmd.key ?? '', { ctrl: cmd.ctrl })
      } else if (cmd.action === 'close') {
        pianoRoll.close()
      }
      return pianoRoll ? pianoRoll.info() : null
    },
    exportMidi: (path) => doExportMidi(path),
    groupsList: () => listGroups(),
    groupAdd: (name, tracks) => {
      const g = addGroup(cleanStemName(name) || `Group ${groups.length + 1}`)
      for (const t of tracks) {
        const l = laneById(t)
        if (l) {
          l.group = g.id
          adoptGroupColor(l, g)
        }
      }
      refreshSolo()
      renderDetail()
      return groupSummary(g)
    },
    groupSet: (id, patch) => {
      const g = groupById(id)
      if (!g) throw new Error(`no group ${id} (groups: ${groups.map((x) => x.id).join(', ') || 'none'})`)
      if (patch.name !== undefined) {
        g.name = cleanStemName(patch.name) || g.name
        ;(g.strip.el.querySelector('.strip-head .t') as HTMLElement).textContent = g.name
      }
      if (patch.color !== undefined) {
        const c = normalizeColor(patch.color)
        if (!c) throw new Error('color must be #rrggbb, #rgb or a palette number 0-11')
        g.color = c
        applyGroupColor(g)
        for (const l of lanes) if (l.group === g.id) adoptGroupColor(l, g)
      }
      if (patch.gainDb !== undefined) g.mix.gainDb = patch.gainDb
      if (patch.pan !== undefined) g.mix.pan = patch.pan
      if (patch.mute !== undefined) g.mix.mute = patch.mute
      if (patch.solo !== undefined) g.mix.solo = patch.solo
      if (patch.tracks) {
        const want = new Set(patch.tracks)
        for (const l of lanes) {
          if (want.has(l.id)) l.group = g.id
          else if (l.group === g.id) l.group = undefined
        }
      }
      g.strip.setGain(g.mix.gainDb)
      g.strip.setPan(g.mix.pan)
      g.strip.m.classList.toggle('on', g.mix.mute)
      g.strip.s.classList.toggle('on', g.mix.solo)
      refreshSolo()
      renderDetail()
      return groupSummary(g)
    },
    groupRemove: (id) => {
      if (!groupById(id)) throw new Error(`no group ${id}`)
      removeGroup(id)
      return { removed: id }
    },
    routeTrack: (track, group) => {
      const l = laneById(track)
      if (!l) throw new Error(`no track ${track}`)
      if (group !== null && !groupById(group)) throw new Error(`no group ${group} (groups: ${groups.map((x) => x.id).join(', ') || 'none'})`)
      l.group = group ?? undefined
      adoptGroupColor(l, group !== null ? groupById(group) : undefined)
      renderDetail()
    },
    groupInserts: (id) => groupById(id)?.inserts ?? null,
    setTrackColor: (track, color) => {
      const l = laneById(track)
      if (!l) throw new Error(`no track ${track}`)
      const c = normalizeColor(color)
      if (!c) throw new Error('color must be #rrggbb, #rgb or a palette number 0-11')
      setLaneColor(l, c)
      if (selectedId === l.id) renderDetail()
      return { id: l.id, color: l.color, stem: l.stem ?? '', stemTracksFollow: !!l.stem }
    },
    groupStripEl: (id) => groupById(id)?.strip.el ?? null,
    stemsList: () => listStems(),
    stemSet: (track, stem) => setStem(track, stem),
    stemsExport: (req) => exportStems(req),
    analyzeSpectrum: (req) => analyzeSpectrum(req),
    trackLevels: (req) => trackLevels(req),
    mixdownExport: (req) => exportMixdown(req),
    groupOutputPeaks: () => groupOutputPeaks(),
    midiTrackSet: (laneId, patch) => {
      const lane = laneById(laneId)
      const mt = lane?.inst ? midiTrackById(lane.inst.midiTrackId) : undefined
      if (!lane || !mt) throw new Error(`track ${laneId} is not an instrument track`)
      const ports = midiIo.outputs()
      if (patch.out !== undefined) {
        if (/^(none|off|)$/i.test(patch.out.trim())) mt.outId = null
        else {
          const want = patch.out.trim().toLowerCase()
          const p = ports.find((x) => x.name.toLowerCase() === want) ?? ports.find((x) => x.name.toLowerCase().includes(want))
          if (!p) throw new Error(`no MIDI output port matching "${patch.out}" (ports: ${ports.map((x) => x.name).join(', ') || 'none'})`)
          mt.outId = p.id
        }
      }
      if (patch.channel !== undefined) mt.channel = Math.max(1, Math.min(16, Math.round(patch.channel))) - 1
      if (patch.outDelayMs !== undefined) midiIo.setOutDelay(patch.outDelayMs)
      if (selectedId === lane.id) renderDetail()
      return {
        track: laneId,
        out: ports.find((x) => x.id === mt.outId)?.name ?? null,
        channel: mt.channel + 1,
        outDelayMs: midiIo.outDelayMs,
        ports: ports.map((x) => x.name)
      }
    },
    addInstrumentTrack: (name, notes, bpm, kind) => {
      if (bpm && bpm > 0) update({ bpm })
      const mt = addMidiTrack(name)
      if (kind === 'drums') mt.instrument = { kind: 'drums', params: defaultDrumParams() }
      else if (kind === 'earlysynth') mt.instrument = { kind: 'earlysynth', params: earlyPreset('Pop Pluck') ?? {} }
      else if (kind === 'fm') mt.instrument = { kind: 'fm', params: fmPreset('Pop Pluck') ?? {} }
      else if (kind === 'none') mt.instrument = { kind: 'none', params: {} }
      const end = notes.reduce((m, n) => Math.max(m, n.start + n.dur), 4)
      const clip = addMidiClip(mt, 0, Math.ceil(end), name)
      for (const n of notes) addNote(clip, n.start, n.dur, n.key, n.vel ?? 100)
      const lane = addInstrumentLane(mt)
      refreshTotals()
      return lane as unknown as McpLane
    },
    swapInstrument: (laneId, kind) => {
      const lane = laneById(laneId)
      if (!lane?.inst) throw new Error(`track ${laneId} is not an instrument track`)
      const k = normalizeInstrumentKind(kind)
      if (!listInstruments().some((i) => i.kind === k)) throw new Error(`unknown instrument "${kind}" (${listInstruments().map((i) => i.kind).join(' | ')})`)
      swapInstrument(lane, k)
      const mt = midiTrackById(lane.inst.midiTrackId)
      return mt?.instrument?.kind ?? k
    },
    setInstrumentParams: (laneId, patch) => {
      const lane = laneById(laneId)
      const mt = lane?.inst ? midiTrackById(lane.inst.midiTrackId) : undefined
      if (!lane || !mt || !mt.instrument) throw new Error(`track ${laneId} is not an instrument track`)
      // { preset: 'Bell' } loads a factory preset first; the other keys then override it
      const presetName = typeof patch['preset'] === 'string' ? String(patch['preset']) : ''
      const ikind = normalizeInstrumentKind(mt.instrument.kind)
      if ((ikind === 'earlysynth' || ikind === 'fm') && presetName) {
        const fresh = (ikind === 'fm' ? fmPreset : earlyPreset)(presetName)
        if (!fresh) throw new Error(`unknown FM preset "${presetName}" (see instrument_presets)`)
        mt.instrument.params = fresh
      }
      Object.assign(mt.instrument.params, patch)
      renderInstrumentLane(lane)
      if (selectedId === lane.id) renderDetail()
      return mt.instrument.params
    },
    addWavLane: async (path, title) => ((await addWavLane(path, title)) as unknown as McpLane | null),
    addToneLane: (seconds, title) => {
      const src = makeToneSource(seconds, title || 'Demo tone')
      const l = addLane(src.name)
      addClipToLane(l, src)
      setLaneSub(l, `${src.gpu.channelCount}ch · ${(state.sampleRate / 1000) | 0}k`)
      refreshTotals()
      fitToProject()
      void scheduler.warmup()
      return l as unknown as McpLane
    },
    syncLaneUI: (l) => {
      const ln = l as unknown as Lane
      ln.strip.setGain(ln.mix.gainDb)
      ln.strip.setPan(ln.mix.pan)
      ln.strip.m.classList.toggle('on', ln.mix.mute)
      ln.strip.s.classList.toggle('on', ln.mix.solo)
      ln.strip.r.classList.toggle('on', ln.mix.rec)
      refreshSolo()
      if (ln.id === selectedId) renderDetail()
    },
    setLaneTitle: (l, title) => {
      const ln = l as unknown as Lane
      const t = ln.el.querySelector('.lane-title') as HTMLElement
      t.textContent = title
      t.title = title
      ln.strip.el.querySelector('.strip-head .t')!.textContent = title
    },
    applyStrip: (l, bypass, patch) => {
      const ln = l as unknown as Lane
      if (bypass !== undefined) ln.dsp.bypass = bypass
      if (patch && typeof patch === 'object') ln.dsp.params = deepMerge(ln.dsp.params, patch)
      ln.el.classList.toggle('sat-active', ln.dsp.params.drive > 0.001)
      if (ln.id === selectedId) renderDetail()
    },
    masterInserts: () => masterBusInserts ?? [],
    makeInsert: (kind, params, bypass) => deserializeInsert({ kind, bypass, params }),
    insertKind: (fx) => serializeInsert(fx)?.kind ?? 'unknown',
    insertParams: (fx) => serializeInsert(fx)?.params ?? null,
    refreshInserts: (owner, fx) => {
      if (fx) closePlugWin(fx)
      refreshInsertsUI(owner)
    },
    slotCount: SLOT_COUNT,
    getMasterGainDb: () => Number(masterEl.value),
    setMasterGainDb: (db) => {
      masterEl.value = String(db)
      syncMaster()
    },
    startRecording,
    takesSettled: () => commitPromise,
    gpuStatus: () => gpuLamp.title
  })

  // ---- transport ---------------------------------------------------------
  function togglePlay(): void {
    if (state.playing) void scheduler.stop()
    else if (state.trackCount) void scheduler.start(state.playhead >= state.totalFrames ? 0 : state.playhead)
  }
  playBtn.addEventListener('click', togglePlay)

  // Transport bar: go to start / rewind / forward move by whole bars (Shift = four bars)
  const barFrames = (): number => (60 / state.bpm) * (4 / state.timeSigDen) * state.timeSigNum * state.sampleRate
  const goTo = (frame: number): void => {
    const f = Math.max(0, Math.min(state.totalFrames, frame))
    if (state.playing) void scheduler.seek(f)
    else update({ playhead: f })
  }
  $('tp-start').addEventListener('click', () => goTo(0))
  $('tp-rew').addEventListener('click', (e) => {
    const bar = barFrames()
    goTo((Math.ceil(state.playhead / bar - 1e-6) - (e.shiftKey ? 4 : 1)) * bar) // previous bar line
  })
  $('tp-ff').addEventListener('click', (e) => {
    const bar = barFrames()
    goTo((Math.floor(state.playhead / bar + 1e-6) + (e.shiftKey ? 4 : 1)) * bar) // next bar line
  })
  $('stop').addEventListener('click', () => {
    void scheduler.stop()
    update({ playhead: 0 })
  })

  // ---- external control surface (P1-Nano class, MCU mode) ------------------
  const activeLane = (): Lane | null =>
    lanes.find((l) => l.id === selectedId) ?? null
  const mcu = new McuSurface({
    track: () => {
      const l = activeLane()
      if (!l) return null
      return {
        index: lanes.indexOf(l),
        count: lanes.length,
        name: (l.el.querySelector('.lane-title') as HTMLElement).textContent ?? '',
        gainDb: l.mix.gainDb,
        pan: l.mix.pan,
        mute: l.mix.mute,
        solo: l.mix.solo,
        rec: l.mix.rec
      }
    },
    setGainDb: (db) => {
      const l = activeLane()
      if (!l) return
      l.strip.fader.value = String(Math.round(db * 10) / 10)
      l.strip.fader.dispatchEvent(new Event('input')) // same path as dragging the on-screen fader
    },
    setPan: (p) => {
      const l = activeLane()
      if (!l) return
      l.mix.pan = Math.max(-1, Math.min(1, p))
      l.strip.setPan(l.mix.pan)
      if (l.id === selectedId) detailApi?.setPan(l.mix.pan)
    },
    jog: (ticks) => {
      // one detent = a quarter beat at the project tempo (a 16th note)
      const step = (60 / state.bpm / 4) * state.sampleRate
      const to = Math.max(0, Math.min(state.totalFrames, state.playhead + ticks * step))
      if (state.playing) void scheduler.seek(to)
      else update({ playhead: to })
    },
    masterDb: () => Number(masterEl.value),
    setMasterDb: (db) => {
      masterEl.value = String(Math.round(db * 10) / 10)
      masterEl.dispatchEvent(new Event('input')) // same path as the on-screen master fader
    },
    bank: (delta) => {
      if (!lanes.length) return
      const i = Math.max(0, Math.min(lanes.length - 1, Math.max(0, lanes.findIndex((l) => l.id === selectedId)) + delta))
      selectLane(lanes[i].id)
    },
    toggle: (what) => {
      const l = activeLane()
      if (l) (what === 'mute' ? l.strip.m : what === 'solo' ? l.strip.s : l.strip.r).click()
    },
    transport: (cmd) => {
      if (cmd === 'play') togglePlay()
      else if (cmd === 'stop') $('stop').click()
      else if (cmd === 'record') recBtn.click()
      else if (!state.playing)
        update({ playhead: cmd === 'rew' ? 0 : state.totalFrames })
    },
    timeSec: () => state.playhead / state.sampleRate,
    playing: () => state.playing
  })
  void mcu.start()
  mcuTick = () => mcu.tick()

  srSelect.addEventListener('change', () => {
    // Project rate is fixed once tracks exist (the select is disabled then);
    // this only applies while the project is empty.
    update({ sampleRate: Number(srSelect.value) })
  })

  // ---- timeline navigation (shared across all lanes) --------------------
  // Plain wheel = native vertical scroll of the lane list.
  // Shift+wheel = scroll the timeline. Ctrl/⌘+wheel = zoom around the cursor.
  tracksScroll.addEventListener(
    'wheel',
    (e) => {
      if (!state.totalFrames) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = tracksScroll.getBoundingClientRect()
        const px = e.clientX - rect.left - LANE_LEFT
        const anchorFrame = state.scrollFrames + px * state.framesPerPixel
        const next = Math.min(1 << 20, Math.max(16, state.framesPerPixel * (e.deltaY > 0 ? 1.2 : 1 / 1.2)))
        update({ framesPerPixel: next, scrollFrames: Math.max(0, anchorFrame - px * next) })
        userZoomed = true
      } else if (e.shiftKey) {
        e.preventDefault()
        update({ scrollFrames: Math.max(0, state.scrollFrames + e.deltaY * state.framesPerPixel) })
        userZoomed = true
      }
    },
    { passive: false }
  )

  tracksScroll.addEventListener('pointerdown', (e) => {
    if (!state.totalFrames) return
    const rect = tracksScroll.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (x < LANE_LEFT || x > LANE_LEFT + waveViewportPx()) return
    const frame = state.scrollFrames + (x - LANE_LEFT) * state.framesPerPixel
    void scheduler.seek(Math.max(0, Math.min(state.totalFrames, frame))) // click = locate (jumps playback too)
  })

  // ---- drag a row from the right-pane audio list onto a lane → place a clip ----
  const laneFrameAtClientX = (clientX: number): number => {
    const rect = tracksScroll.getBoundingClientRect()
    const x = clientX - rect.left - LANE_LEFT
    return Math.max(0, snapFrame(state.scrollFrames + x * state.framesPerPixel))
  }
  tracksEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('text/plain')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  })
  tracksEl.addEventListener('drop', (e) => {
    const payload = e.dataTransfer?.getData('text/plain') ?? ''
    if (!payload) return
    e.preventDefault()
    const laneEl = (e.target as HTMLElement).closest('.lane')
    const lane = lanes.find((l) => l.el === laneEl)
    if (!lane) return
    const at = laneFrameAtClientX(e.clientX)
    if (payload.startsWith('src:')) {
      const src = getSource(Number(payload.slice(4)))
      if (src) addClipToLane(lane, src, at)
    } else if (payload.startsWith('clip:')) {
      const [, lid, cid] = payload.split(':')
      const from = laneById(Number(lid))?.clips.find((c) => c.id === Number(cid))
      const src = from && getSource(from.sourceId)
      if (from && src) addClipToLane(lane, src, at, from.srcOffset, from.lengthFrames)
    }
    refreshTotals()
    lane.dirty = true
  })

  // ---- top ruler = quick transport: click / drag to locate. Preview the
  // playhead while dragging (scrubbing suppresses the scheduler's drive), then
  // commit the real seek on release — if playing, it jumps playback to there.
  const rulerFrameAt = (clientX: number): number => {
    const rect = rulerCanvas.getBoundingClientRect()
    const x = Math.max(LANE_LEFT, clientX - rect.left)
    const frame = state.scrollFrames + (x - LANE_LEFT) * state.framesPerPixel
    return Math.max(0, Math.min(state.totalFrames, frame))
  }
  rulerCanvas.addEventListener('pointerdown', (e) => {
    if (!state.totalFrames || e.button !== 0) return
    rulerCanvas.setPointerCapture(e.pointerId)
    scrubbing = true
    update({ playhead: rulerFrameAt(e.clientX) })
    const move = (ev: PointerEvent): void => update({ playhead: rulerFrameAt(ev.clientX) })
    const up = (ev: PointerEvent): void => {
      rulerCanvas.removeEventListener('pointermove', move)
      rulerCanvas.removeEventListener('pointerup', up)
      scrubbing = false
      void scheduler.seek(rulerFrameAt(ev.clientX))
    }
    rulerCanvas.addEventListener('pointermove', move)
    rulerCanvas.addEventListener('pointerup', up)
  })

  let pv = { fpp: -1, scroll: -1, total: -1, tc: -1 }
  subscribe((s) => {
    playBtn.title = s.playing ? 'Pause (Space)' : 'Play (Space)'
    playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play')
    playBtn.classList.toggle('playing', s.playing)
    playBtn.disabled = s.trackCount === 0
    recBtn.disabled = s.trackCount === 0
    recBtn.classList.toggle('recording', scheduler.recording)
    recBtn.setAttribute('aria-label', scheduler.recording ? 'Recording' : 'Record')
    srSelect.disabled = s.playing || s.trackCount > 0 // project rate locks once a track exists
    hint.hidden = s.trackCount > 0
    // Any timeline-transform or track-count change needs a waveform redraw.
    if (
      s.framesPerPixel !== pv.fpp ||
      s.scrollFrames !== pv.scroll ||
      s.totalFrames !== pv.total ||
      s.trackCount !== pv.tc
    ) {
      viewDirty = true
      pv = { fpp: s.framesPerPixel, scroll: s.scrollFrames, total: s.totalFrames, tc: s.trackCount }
    }
  })

  // Vertical scroll of the lane list brings different lanes on-screen → redraw.
  tracksScroll.addEventListener('scroll', () => {
    viewDirty = true
  })

  // Keep the timeline fitted to the window unless the user has zoomed/scrolled.
  let resizeRaf = 0
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf)
    resizeRaf = requestAnimationFrame(() => {
      if (!userZoomed) fitToProject()
      viewDirty = true // canvas backing size may have changed even if zoom held
    })
  })

  // Headless self-test: `?selftest` adds a tone track, plays it, and logs the
  // GPGPU→native-output metrics to the console. Used by the dev smoke test.
  // `?selftest&mode=resample` builds the tone at 48 kHz and forces it through
  // the GPU resampler (→ project rate) to exercise that path headlessly.
  if (location.search.includes('selftest')) {
    const mode = new URLSearchParams(location.search).get('mode') ?? ''
    const lane = addLane('selftest')
    let src: AudioSource
    if (mode === 'resample') {
      const srcRate = 48000
      const seconds = 4
      const n = srcRate * seconds
      const mk = (det: number): Float32Array => {
        const a = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          const t = i / srcRate
          const env = Math.min(1, Math.min(t, seconds - t) / 0.1)
          a[i] = 0.5 * env * Math.sin(2 * Math.PI * 220 * det * t)
        }
        return a
      }
      console.log(`[selftest] 48k tone → GPU resample → ${state.sampleRate}Hz`)
      const gpu = new GpuTrack()
      gpu.uploadChannels([mk(0.997), mk(1.003)], srcRate, state.sampleRate)
      src = registerSource({ name: 'selftest', path: null, kind: 'tone', gpu, envelope: null })
      setLaneSub(lane, `48k → ${(state.sampleRate / 1000) | 0}k (resampled)`)
    } else {
      console.log('[selftest] 4s tone on a new track')
      src = makeToneSource(4, 'selftest')
      setLaneSub(lane, 'selftest tone')
    }
    addClipToLane(lane, src)
    refreshTotals()
    fitToProject()
    void scheduler.warmup()
    void scheduler.start(0)
    const t = setInterval(() => {
      const m = scheduler.metrics()
      console.log(
        `[selftest] playhead=${state.playhead | 0} buffer=${m.bufferedMs.toFixed(0)}ms underrun=${m.underrunFrames}${m.tailing ? ' tail' : ''}`
      )
      if (!state.playing && !m.tailing) {
        clearInterval(t)
        console.log('[selftest] done')
      }
    }, 250)
  } else {
    // Startup: if a project was ever saved, relaunch straight into it. Only when
    // there's none do we fall back to the test-bed autoload.
    void (async () => {
      const saved = await window.daw.projectLoad()
      if (saved && typeof saved === 'object') {
        try {
          await restoreProject(saved as ProjectFile)
          flashStatus('project restored')
          return
        } catch (err) {
          console.error('[project] restore failed — falling back to autoload', err)
        }
      }
      const paths = await window.daw.autoloadWavs()
      if (paths.length) await loadFiles(paths)
    })()
  }

  function frame(): void {
    if (state.playing && !scrubbing) update({ playhead: scheduler.currentFrame() })
    if (midiIo.recording && !scheduler.recording) {
      const n = midiIo.finishRecording(state.playhead)
      if (n > 0) flashStatus(`recorded ${n} MIDI note${n > 1 ? 's' : ''}`)
    }

    // The waveform canvases only depend on peak data + the timeline transform, so
    // redraw a lane only when it (or the shared view) is dirty AND it's actually
    // on screen. At 100 tracks this is the difference between 0 and 100 GPU
    // submits per frame during playback. The playhead is a DOM overlay, updated
    // below every frame regardless.
    if (viewDirty || lanes.some((l) => l.dirty)) {
      const top = tracksScroll.scrollTop
      const bottom = top + tracksScroll.clientHeight
      try {
        for (const lane of lanes) {
          const y = lane.el.offsetTop
          const onScreen = y + lane.el.offsetHeight >= top && y <= bottom
          if (!onScreen) continue
          if (viewDirty || lane.dirty) {
            lane.renderer.draw(lane.inst ? [] : resolvePeakClips(lane), state)
            drawLaneFx(lane)
            lane.dirty = false
          }
        }
      } catch (err) {
        gpuStatus.textContent = `render stopped: ${(err as Error).message}`
        gpuStatus.className = 'err'
        setGpuLamp('err', `render stopped: ${(err as Error).message}`)
        return // stop the loop; a device loss needs a full reload
      }
      viewDirty = false
    }

    const waveX = (state.playhead - state.scrollFrames) / state.framesPerPixel
    playhead.style.left = `${LANE_LEFT + waveX}px`
    playhead.style.opacity =
      state.totalFrames > 0 && waveX >= -0.5 && waveX <= waveViewportPx() + 0.5 ? '1' : '0'
    clock.textContent = fmtTime(state.playhead)
    clockBars.textContent = fmtBars(state.playhead)
    mcuTick()

    // Top ruler + grid overlay. Both are cheap DOM/2D work; skip when nothing
    // that affects them changed (the grid also ignores playhead moves).
    const xf = `${state.framesPerPixel}|${state.scrollFrames}|${state.totalFrames}|${tracksScroll.clientWidth}`
    const rs = `${xf}|${Math.round(state.playhead)}`
    if (rs !== rulerSig) {
      rulerSig = rs
      drawRuler()
      rulerTc.textContent = fmtTime(state.playhead)
    }
    if (xf !== gridSig) {
      gridSig = xf
      syncGrid()
    }

    // ---- channel-strip meters (real post-fader output of each channel, measured on the GPU) ----
    const sL = stripsScrollEl.scrollLeft
    const sR = sL + stripsScrollEl.clientWidth
    const now = performance.now()
    const writeText = now - meterTextAt >= 1000 // dB / peak numbers refresh ~1 Hz
    if (writeText) meterTextAt = now
    const mtr = scheduler.metrics() // read once per frame: channel meters, then the master strip below
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li]
      // the real channel output: after the strip, the inserts, the fader and the pan (measured on the GPU,
      // for the block being played; mute / solo are already in it)
      // a line-input lane is metered by the live bus (its own block path), playing or not
      const post = lane.live ? (liveBusRef?.peakOf(lane.id) ?? 0) : state.playing ? mtr.trackPeaks[li] || 0 : 0
      lane.vu += (post - lane.vu) * (post > lane.vu ? 0.55 : 0.09) // fast attack, slow release
      if (post > lane.peakHold) lane.peakHold = post

      // Mirror the meter into the left-pane detail fader (any scroll position).
      if (lane.id === selectedId && detailApi) {
        const dn = Math.max(0, Math.min(1, (linToDb(lane.vu) + 54) / 54))
        detailApi.vuEl.style.height = `${(1 - dn) * 100}%`
      }

      const x = lane.strip.el.offsetLeft
      if (x + lane.strip.el.offsetWidth < sL || x > sR) continue // off-screen strip

      // The bar has a fixed colour scale; shrink the dark cover to reveal it.
      const norm = Math.max(0, Math.min(1, (linToDb(lane.vu) + 54) / 54))
      lane.strip.vu.style.height = `${(1 - norm) * 100}%`

      // left number = the fader's value (always, playing or not; follows the fader at once, also when it is
      // moved by MCP / the AI). The level is the bar next to it; the right number is the peak.
      const faderText = fmtFaderDb(lane.mix.gainDb)
      if (lane.strip.db.textContent !== faderText) lane.strip.db.textContent = faderText

      if (writeText) {
        const pk = linToDb(lane.peakHold)
        lane.strip.peak.textContent = pk === -Infinity ? '−∞' : pk.toFixed(1)
        lane.strip.peak.classList.toggle('over', pk > 0)
      }
    }

    // group channels: their own post-fader output, measured on the GPU like the tracks'
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      const post = state.playing ? mtr.groupPeaks[gi] || 0 : 0
      g.vu += (post - g.vu) * (post > g.vu ? 0.55 : 0.09)
      if (post > g.peakHold) g.peakHold = post
      const norm = Math.max(0, Math.min(1, (linToDb(g.vu) + 54) / 54))
      g.strip.vu.style.height = `${(1 - norm) * 100}%`
      const ft = fmtFaderDb(g.mix.gainDb)
      if (g.strip.db.textContent !== ft) g.strip.db.textContent = ft
      if (writeText) {
        const pk = linToDb(g.peakHold)
        g.strip.peak.textContent = pk === -Infinity ? '−∞' : pk.toFixed(1)
        g.strip.peak.classList.toggle('over', pk > 0)
      }
    }

    const m = mtr

    // ---- master strip meter (peak of the readback block, post master-gain; the line-input path adds
    // onto the output after that readback, so its own peak is taken into account too) ----
    const masterNow = Math.max(m.masterPeak, liveBusRef?.outPeak() ?? 0)
    masterVu += (masterNow - masterVu) * (masterNow > masterVu ? 0.55 : 0.09)
    if (masterNow > masterPeakHold) masterPeakHold = masterNow
    const mnorm = Math.max(0, Math.min(1, (linToDb(masterVu) + 54) / 54))
    masterVuEl.style.height = `${(1 - mnorm) * 100}%`
    if (writeText) {
      const mdb = linToDb(masterNow)
      masterDbEl.textContent = mdb === -Infinity ? '−∞' : mdb.toFixed(1)
      const mpk = linToDb(masterPeakHold)
      masterPeakEl.textContent = mpk === -Infinity ? '−∞' : mpk.toFixed(1)
      masterPeakEl.classList.toggle('over', mpk > 0)
    }

    // ---- LUFS (K-weighted master readback): master strip = Short-term ----
    masterLufsEl.textContent = fmtLufs(m.lufsS)
    if (lufsReadout) {
      lufsReadout.m.textContent = fmtLufs(m.lufsM)
      lufsReadout.s.textContent = fmtLufs(m.lufsS)
      lufsReadout.i.textContent = fmtLufs(m.lufsI)
      lufsReadout.mx.textContent = fmtLufs(m.lufsMax)
    }

    if (state.playing || m.tailing) {
      const warn = m.underrunFrames > 0 || m.bufferedMs < 20
      const tail = m.tailing ? ' · <span class="warn">tail</span>' : ''
      const be = m.backend ? `${m.backend} · ` : ''
      metricsEl.innerHTML = `${be}buffer <span class="${warn ? 'warn' : ''}">${m.bufferedMs.toFixed(0)}ms</span> · underrun ${m.underrunFrames}${tail}`
    } else {
      metricsEl.textContent = ''
    }

    requestAnimationFrame(frame)
  }
  frame()
}

void boot()
