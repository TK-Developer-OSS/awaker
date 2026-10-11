// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { state } from '../state'
import { DRUM_LANES, drumVoiceOfKey, type DrumLane } from '../gpu/instruments/drums'
import { addMidiClip, addNote, framesToBeats, midiChanged, removeNote, type MidiClip, type MidiTrack } from './model'
import {
  PRESETS,
  STEPS_PER_BAR,
  STEP_BEATS,
  VEL_ACCENT,
  VEL_GHOST,
  VEL_NORMAL,
  findCell,
  laneRow,
  presetNotes
} from './step-logic'

/**
 * Step sequencer overlay for a drum-machine track: one row per drum voice, 16 steps per
 * bar, one bar page at a time. Click = hit, Shift+click = accent, right-click = ghost note.
 * It edits the same MIDI clip as the piano roll, so both views always agree. Presets
 * replace the whole clip.
 */

export interface StepGridApi {
  open(track: MidiTrack): void
  close(): void
  isOpen(): boolean
}

export function createStepGrid(host: HTMLElement, hooks: { openPianoRoll: (t: MidiTrack) => void }): StepGridApi {
  const root = document.createElement('div')
  root.id = 'stepgrid'
  root.hidden = true
  root.innerHTML =
    `<div class="sg-card">` +
    `<div class="sg-head">` +
    `<span class="sg-title"></span>` +
    `<label>Bars <select class="sg-bars"><option>1</option><option>2</option><option>4</option><option>8</option></select></label>` +
    `<span class="sg-page"><button class="sg-prev" title="Previous bar">◀</button><span class="sg-pg"></span><button class="sg-next" title="Next bar">▶</button></span>` +
    `<label>Preset <select class="sg-preset"></select></label><button class="sg-load" title="Replace this pattern with the preset">Load</button>` +
    `<button class="sg-clear" title="Remove every hit">Clear</button>` +
    `<button class="sg-roll" title="Edit the same notes in the piano roll">Piano roll…</button>` +
    `<span class="sg-hint">click = hit · Shift+click = accent · right-click = ghost</span>` +
    `<button class="sg-close" title="Close (Esc)">✕</button>` +
    `</div><div class="sg-body"></div></div>`
  host.appendChild(root)

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T
  const body = q<HTMLElement>('.sg-body')
  const barsSel = q<HTMLSelectElement>('.sg-bars')
  const presetSel = q<HTMLSelectElement>('.sg-preset')
  const pgEl = q<HTMLElement>('.sg-pg')

  for (const p of PRESETS) {
    const o = document.createElement('option')
    o.textContent = p.name
    presetSel.appendChild(o)
  }

  let track: MidiTrack | null = null
  let clip: MidiClip | null = null
  let page = 0
  let raf = 0
  const cells = new Map<string, HTMLElement>() // `${key}:${stepInPage}`

  const bars = (): number => Number(barsSel.value) || 1
  const sameLane = (lane: DrumLane) => (key: number): boolean => drumVoiceOfKey(key) === lane.voice

  function build(): void {
    body.replaceChildren()
    cells.clear()
    for (const lane of DRUM_LANES) {
      const row = document.createElement('div')
      row.className = 'sg-row'
      const name = document.createElement('span')
      name.className = 'sg-name'
      name.textContent = lane.name
      row.appendChild(name)
      for (let s = 0; s < STEPS_PER_BAR; s++) {
        const c = document.createElement('div')
        c.className = 'sg-cell' + (s % 4 === 0 ? ' beat' : '')
        c.dataset.lane = String(lane.key)
        c.dataset.step = String(s)
        const hit = (wanted: number): void => toggle(lane, page * STEPS_PER_BAR + s, wanted)
        c.addEventListener('click', (e) => hit(e.shiftKey ? VEL_ACCENT : VEL_NORMAL))
        c.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          hit(VEL_GHOST)
        })
        row.appendChild(c)
        cells.set(`${lane.key}:${s}`, c)
      }
      body.appendChild(row)
    }
  }

  /** Set a cell to `wanted` velocity, or clear it if it already has exactly that. */
  function toggle(lane: DrumLane, step: number, wanted: number): void {
    if (!clip) return
    const have = findCell(clip.notes, sameLane(lane), step)
    if (have) {
      if (have.vel === wanted) removeNote(clip, have.id)
      else {
        have.vel = wanted
        midiChanged()
      }
    } else {
      addNote(clip, step * STEP_BEATS, STEP_BEATS, lane.key, wanted)
    }
    refresh()
  }

  function refresh(): void {
    if (!clip) return
    pgEl.textContent = `bar ${page + 1} / ${bars()}`
    const total = bars() * STEPS_PER_BAR
    for (const lane of DRUM_LANES) {
      const row = laneRow(clip.notes, sameLane(lane), total)
      for (let s = 0; s < STEPS_PER_BAR; s++) {
        const v = row[page * STEPS_PER_BAR + s]
        const c = cells.get(`${lane.key}:${s}`)
        if (!c) continue
        c.classList.toggle('on', v > 0 && v < VEL_ACCENT && v > VEL_GHOST)
        c.classList.toggle('acc', v >= VEL_ACCENT)
        c.classList.toggle('ghost', v > 0 && v <= VEL_GHOST)
      }
    }
  }

  function frame(): void {
    if (root.hidden) return
    if (clip) {
      const beat = framesToBeats(state.playhead, state.bpm, state.sampleRate) - clip.start
      const step = Math.floor(beat / STEP_BEATS)
      const inPage = step >= page * STEPS_PER_BAR && step < (page + 1) * STEPS_PER_BAR ? step - page * STEPS_PER_BAR : -1
      for (const [k, c] of cells) c.classList.toggle('ph', Number(k.split(':')[1]) === inPage && state.playing)
    }
    raf = requestAnimationFrame(frame)
  }

  function setBars(n: number): void {
    barsSel.value = String(n)
    if (clip) {
      const end = clip.notes.reduce((m, x) => Math.max(m, x.start + x.dur), 0)
      clip.length = Math.max(n * 4, Math.ceil(end))
    }
    page = Math.min(page, n - 1)
    refresh()
    midiChanged()
  }

  function open(t: MidiTrack): void {
    track = t
    if (t.clips.length === 0) addMidiClip(t, 0, 4, t.name)
    clip = t.clips[0]
    q<HTMLElement>('.sg-title').textContent = `Step sequencer — ${t.name}`
    const b = [1, 2, 4, 8].find((x) => x * 4 >= clip!.length) ?? 8
    barsSel.value = String(b)
    page = 0
    build()
    refresh()
    root.hidden = false
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(frame)
  }

  function close(): void {
    root.hidden = true
    cancelAnimationFrame(raf)
    if (track) midiChanged()
  }

  barsSel.addEventListener('change', () => setBars(bars()))
  q<HTMLButtonElement>('.sg-prev').addEventListener('click', () => {
    page = Math.max(0, page - 1)
    refresh()
  })
  q<HTMLButtonElement>('.sg-next').addEventListener('click', () => {
    page = Math.min(bars() - 1, page + 1)
    refresh()
  })
  q<HTMLButtonElement>('.sg-load').addEventListener('click', () => {
    if (!clip) return
    const preset = PRESETS[presetSel.selectedIndex] ?? PRESETS[0]
    clip.notes.length = 0
    clip.length = bars() * 4
    for (const n of presetNotes(preset, DRUM_LANES, bars())) addNote(clip, n.start, n.dur, n.key, n.vel)
    clip.length = bars() * 4
    refresh()
    midiChanged()
  })
  q<HTMLButtonElement>('.sg-clear').addEventListener('click', () => {
    if (!clip) return
    clip.notes.length = 0
    refresh()
    midiChanged()
  })
  q<HTMLButtonElement>('.sg-roll').addEventListener('click', () => {
    if (!track) return
    const t = track
    close()
    hooks.openPianoRoll(t)
  })
  q<HTMLButtonElement>('.sg-close').addEventListener('click', close)
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) close()
  })
  window.addEventListener(
    'keydown',
    (e) => {
      if (!root.hidden && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    },
    true
  )

  return { open, close, isOpen: () => !root.hidden }
}
