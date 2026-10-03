// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { initGpu } from './gpu/device'
import { GpuTrack } from './gpu/track'
import { WaveformRenderer, type PeakClip } from './gpu/waveform-renderer'
import { PlaybackScheduler } from './audio/scheduler'
import type { Take } from './audio/recorder'
import { registerMcpTools, type McpLane } from './mcp-tools'
import type { MixSource, LaneClip } from './gpu/master-bus'
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
import { decodeWav } from './wav'
import { state, update, subscribe, type DawState } from './state'

// Route otherwise-swallowed failures (e.g. `void scheduler.start()` rejecting on
// a GPU pipeline error) to console.error so the main-process mirror shows them.
window.addEventListener('unhandledrejection', (e) =>
  console.error('[unhandledrejection]', (e.reason as Error)?.stack ?? e.reason)
)

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const gpuStatus = $('gpu-status')
const clock = $('clock')
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
  /** Cubase-style insert-slot rack container (8 slots). */
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
}

const dbToLin = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20))
const linToDb = (x: number): number => (x <= 1e-4 ? -Infinity : 20 * Math.log10(x))
const fmtLufs = (v: number): string => (!Number.isFinite(v) || v <= -70 ? '−∞' : v.toFixed(1))
const lanes: Lane[] = []
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

let anySolo = false
function refreshSolo(): void {
  anySolo = lanes.some((l) => l.mix.solo)
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
function buildStrip(lane: Lane, id: number, title: string): Strip {
  const el = document.createElement('div')
  el.className = 'strip'
  el.innerHTML =
    `<div class="strip-head"><span class="n"></span><span class="t"></span></div>` +
    `<div class="strip-rack"></div>` +
    `<div class="strip-mid">` +
    `<div class="fader-wrap"><input class="strip-fader" type="range" min="-60" max="6" step="0.5" value="0" /></div>` +
    `<div class="strip-vu"><i></i></div></div>` +
    `<div class="strip-nums">` +
    `<div class="strip-db" title="level">−∞</div>` +
    `<div class="strip-peak" title="peak — click to reset">−∞</div></div>` +
    `<div class="strip-btns">` +
    `<button class="m">M</button><button class="s">S</button>` +
    `<button class="r">R</button><div class="strip-knob" title="pan — drag, dbl-click = centre"><i></i></div>` +
    `</div>`
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
  stripsEl.appendChild(el)

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

/** Cheap pre-fader meter level: the source envelope under the playhead. */
function laneMeterLevel(lane: Lane, playheadFrame: number): number {
  for (const c of lane.clips) {
    if (playheadFrame < c.startFrame || playheadFrame >= clipEnd(c)) continue
    const s = getSource(c.sourceId)
    if (!s?.envelope) continue
    const srcFrame = c.srcOffset + (playheadFrame - c.startFrame)
    const idx = Math.floor(srcFrame / state.sampleRate / ENV_WINDOW_S)
    return s.envelope[idx] || 0
  }
  return 0
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

  const srcs = sourceList()
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

  for (const c of lane.clips) {
    const xL = toX(c.startFrame)
    const xR = toX(clipEnd(c))
    if (xR < 0 || xL > cssW) continue
    const sel = selClips.has(c.id)

    if (sel) {
      g.fillStyle = 'rgba(120,220,180,0.10)'
      g.fillRect(xL, 0, xR - xL, cssH)
    }
    // fade ramps
    g.strokeStyle = sel ? 'rgba(160,245,210,0.95)' : 'rgba(150,220,190,0.55)'
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
    g.strokeStyle = sel ? '#8ef0c8' : 'rgba(120,200,170,0.5)'
    g.strokeRect(Math.round(xL) + 0.5, 0.5, Math.max(1, Math.round(xR - xL) - 1), cssH - 1)
    // name
    const nameW = xR - xL - 8
    if (nameW > 12) {
      g.save()
      g.beginPath()
      g.rect(xL + 4, 0, nameW, 13)
      g.clip()
      g.fillStyle = sel ? '#e6fff5' : 'rgba(205,235,222,0.72)'
      g.font = '10px -apple-system, "Segoe UI", sans-serif'
      g.textBaseline = 'top'
      g.fillText(c.name, xL + 5, 2)
      g.restore()
    }
    // corner fade handles (only when selected)
    if (sel) {
      g.fillStyle = '#8ef0c8'
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
/** Fixed insert-slot count per strip (Cubase-style rack). */
const SLOT_COUNT = 8

function fxLabel(fx: Insert): string {
  return FX_KINDS.find((k) => k.is(fx))?.label ?? fx.name
}
function fxShort(fx: Insert): string {
  return FX_KINDS.find((k) => k.is(fx))?.short ?? fx.name
}

// ---- floating plugin windows ---------------------------------------------------
// Pro Tools behaviour: normally a single un-pinned window is shown — opening
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
  const panel = document.createElement('div') // inset control panel (Cubase-style)
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
function fillRack(rackEl: HTMLElement, list: Insert[], owner: number | 'master'): void {
  rackEl.replaceChildren()
  for (let i = 0; i < SLOT_COUNT; i++) {
    const fx: Insert | undefined = list[i]
    const slot = document.createElement('div')
    slot.className = fx ? 'strip-slot filled' : 'strip-slot'
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
    // Pultec EQP-1A homage: 12AX7 buffer → passive program EQ → 12AX7 make-up.
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
    // SSL-G-bus-style master comp: stepped ratio / attack / release, plus a
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

  // ---- insert plugins (slot rack at the top; params open in floating windows) ----
  buildDetailSlots(trackDetailEl, lane.inserts, lane.id)

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
  paneScroll.scrollTop = savedScroll
}

/** Resolve a lane's mix to a GPU MixSource, applying mute/solo. */
function laneToSource(l: Lane): MixSource {
  const audible = !l.mix.mute && (!anySolo || l.mix.solo)
  return {
    clips: resolveLaneClips(l),
    mix: { gain: audible ? dbToLin(l.mix.gainDb) : 0, pan: l.mix.pan },
    strip: l.dsp,
    inserts: l.inserts
  }
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
}
interface ProjectFile {
  version: number
  sampleRate: number
  bpm?: number
  timeSig?: { num: number; den: number }
  gridMode?: string
  sources?: SzSource[]
  master: { gainDb: number; inserts: SzInsert[] }
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
    gpuStatus.textContent = label
    gpuStatus.className = 'ok'
    console.log(`[gpu] ${label}`)
  } catch (err) {
    const msg = `WebGPU failed: ${(err as Error).message}`
    gpuStatus.textContent = msg
    gpuStatus.className = 'err'
    console.error(`[gpu] ${msg}`)
    return
  }

  const scheduler = new PlaybackScheduler(() => lanes.map(laneToSource))
  window.daw.onAudioStatus((s) => scheduler.onStatus(s))
  window.daw.onRecChunk((c) => scheduler.onRecChunk(c))
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
      sources: sourceList().map((s) => ({
        id: s.id,
        name: s.name,
        path: s.path,
        kind: s.kind,
        toneSeconds: s.toneSeconds
      })),
      master: {
        gainDb: Number(masterEl.value),
        inserts: (masterBusInserts ?? [])
          .map(serializeInsert)
          .filter((x): x is SzInsert => x !== null)
      },
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
        clips: l.clips.map(szClip)
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
    nextId = 1
    selectedId = null
    audioPick = null
    selClips.clear()
    rangeSel = null
    resetHistory()
    anySolo = false
    masterStripEl.classList.remove('selected')
    clearSourceRegistry()

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
    const v1 = !p.sources // pre-clip project: one full-length clip per track

    for (const t of p.tracks ?? []) {
      const lane = addLane(t.title || 'Track')

      if (v1) {
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

  // ---- add-track wizard ----------------------------------------------------
  const wizard = $('wizard')
  const openWizard = (): void => {
    wizard.hidden = false
  }
  const closeWizard = (): void => {
    wizard.hidden = true
  }
  $('add-track').addEventListener('click', openWizard)
  $('wiz-cancel').addEventListener('click', closeWizard)
  wizard.addEventListener('click', (e) => {
    if (e.target === wizard) closeWizard()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !wizard.hidden) {
      closeWizard()
      return
    }
    // Ctrl/⌘+S saves the project regardless of focus.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      void doSave()
      return
    }
    // Don't hijack keys while typing in a field / on a slider.
    const t = e.target as HTMLElement | null
    const tag = t?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
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

  // ---- edit tools: palette + pointer routing on the tracks area ----
  for (const b of document.querySelectorAll<HTMLButtonElement>('#toolbar .tool'))
    b.addEventListener('click', () => setTool(b.dataset.tool as EditTool))
  setTool(state.editTool) // seed the toolbar + #tracks[data-tool]
  // Bubbles before the tracksScroll seek handler; the select tool only
  // stopPropagation()s when it actually grabs a clip, so empty clicks still seek.
  tracksEl.addEventListener('pointerdown', onEditPointerDown)
  // Edit menu / accelerators (Cut·Copy·Paste·Delete·Split·Select All) from main.
  window.daw.onEditCommand?.(runEditOp)

  $('wiz-tone').addEventListener('click', async () => {
    closeWizard()
    if (state.playing) await scheduler.stop()
    const src = makeToneSource(6, 'Demo tone') // generated straight at project rate
    const lane = addLane(src.name)
    addClipToLane(lane, src)
    setLaneSub(lane, `${src.gpu.channelCount}ch · ${(state.sampleRate / 1000) | 0}k`)
    refreshTotals()
    fitToProject()
    void scheduler.warmup()
  })

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

  $('wiz-wav').addEventListener('click', async () => {
    const paths = await window.daw.openAudioFiles()
    if (!paths || paths.length === 0) return
    closeWizard()
    await loadFiles(paths)
  })

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
        clearRange(lane, t.startFrame, t.startFrame + t.frames) // new take replaces what it overlaps
        addClipToLane(lane, src, t.startFrame)
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
    if (!armed.length) {
      flashStatus('arm a track first (R button)', true)
      throw new Error('no track is armed (set rec on a track first)')
    }
    const targets = armed.map((l) => ({ laneId: l.id, ch: l.recIn.ch, stereo: l.recIn.stereo }))
    await scheduler.startRecord(state.playhead, targets, { synthetic })
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

  // ---- MCP tool handlers (dev/regression; the server itself is opt-in in main) ----
  registerMcpTools({
    lanes: lanes as unknown as McpLane[],
    scheduler,
    serializeProject,
    restoreProject: (p) => restoreProject(p as ProjectFile),
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
    gpuStatus: () => gpuStatus.textContent ?? ''
  })

  // ---- transport ---------------------------------------------------------
  function togglePlay(): void {
    if (state.playing) void scheduler.stop()
    else if (state.trackCount) void scheduler.start(state.playhead >= state.totalFrames ? 0 : state.playhead)
  }
  playBtn.addEventListener('click', togglePlay)
  $('stop').addEventListener('click', () => {
    void scheduler.stop()
    update({ playhead: 0 })
  })

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
    playBtn.textContent = s.playing ? '❚❚ Pause' : '▶ Play'
    playBtn.classList.toggle('playing', s.playing)
    playBtn.disabled = s.trackCount === 0
    recBtn.disabled = s.trackCount === 0
    recBtn.classList.toggle('recording', scheduler.recording)
    recBtn.textContent = scheduler.recording ? '● Recording…' : '● Rec'
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
            lane.renderer.draw(resolvePeakClips(lane), state)
            drawLaneFx(lane)
            lane.dirty = false
          }
        }
      } catch (err) {
        gpuStatus.textContent = `render stopped: ${(err as Error).message}`
        gpuStatus.className = 'err'
        return // stop the loop; a device loss needs a full reload
      }
      viewDirty = false
    }

    const waveX = (state.playhead - state.scrollFrames) / state.framesPerPixel
    playhead.style.left = `${LANE_LEFT + waveX}px`
    playhead.style.opacity =
      state.totalFrames > 0 && waveX >= -0.5 && waveX <= waveViewportPx() + 0.5 ? '1' : '0'
    clock.textContent = fmtTime(state.playhead)

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

    // ---- channel-strip meters (post-fader, from the source envelope) ----
    const sL = stripsScrollEl.scrollLeft
    const sR = sL + stripsScrollEl.clientWidth
    const now = performance.now()
    const writeText = now - meterTextAt >= 1000 // dB / peak numbers refresh ~1 Hz
    if (writeText) meterTextAt = now
    for (const lane of lanes) {
      const raw = state.playing ? laneMeterLevel(lane, state.playhead) : 0
      const audible = !lane.mix.mute && (!anySolo || lane.mix.solo)
      const post = audible ? raw * dbToLin(lane.mix.gainDb) : 0
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

      if (writeText) {
        const db = linToDb(post)
        lane.strip.db.textContent = db === -Infinity ? '−∞' : db.toFixed(1)
        const pk = linToDb(lane.peakHold)
        lane.strip.peak.textContent = pk === -Infinity ? '−∞' : pk.toFixed(1)
        lane.strip.peak.classList.toggle('over', pk > 0)
      }
    }

    const m = scheduler.metrics()

    // ---- master strip meter (peak of the readback block, post master-gain) ----
    masterVu += (m.masterPeak - masterVu) * (m.masterPeak > masterVu ? 0.55 : 0.09)
    if (m.masterPeak > masterPeakHold) masterPeakHold = m.masterPeak
    const mnorm = Math.max(0, Math.min(1, (linToDb(masterVu) + 54) / 54))
    masterVuEl.style.height = `${(1 - mnorm) * 100}%`
    if (writeText) {
      const mdb = linToDb(m.masterPeak)
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
