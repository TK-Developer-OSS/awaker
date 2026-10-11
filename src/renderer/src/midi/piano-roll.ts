// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { state } from '../state'
import { drumNameOfKey } from '../gpu/instruments/drums'
import {
  addMidiClip,
  addNote,
  framesToBeats,
  midiChanged,
  removeNote,
  type MidiClip,
  type MidiTrack
} from './model'
import {
  beatToX,
  gridBeats,
  gridLineStep,
  hitTest,
  keyToY,
  moveNotes,
  noteRect,
  notesInRect,
  resizeNotes,
  snapFloor,
  xToBeat,
  yToKey,
  type Origin,
  type RollView
} from './roll-logic'

/**
 * Piano roll overlay for one MIDI track's clip. Canvas-drawn; every pointer action
 * goes through `pointer()` so the DOM listeners and the MCP test hook share the exact
 * same code path.
 *
 * Mouse: click empty = new note (drag to set its length) · drag note = move ·
 * drag a note's right edge = resize · Shift+click = add to selection · Shift+drag
 * on empty = box select · right-click (or Alt+click) = delete · drag in the velocity
 * strip = set velocity. Keys: Delete/Backspace remove selection, Ctrl+A select all,
 * Esc close. Wheel = scroll pitch, Shift+wheel = scroll time, Ctrl+wheel = zoom time.
 */

const KEYS_W = 54
const RULER_H = 20
const VEL_H = 64

const BLACK = new Set([1, 3, 6, 8, 10])
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const keyName = (k: number): string => `${NAMES[k % 12]}${Math.floor(k / 12) - 1}`

interface DragOp {
  kind: 'move' | 'resize' | 'marquee' | 'velocity'
  grabbedId: number
  startX: number
  startY: number
  origins: Origin[]
  /** marquee: selection before the drag (Shift keeps it). */
  base?: Set<number>
}

export interface PianoRollApi {
  open(track: MidiTrack, clipIndex?: number): void
  close(): void
  isOpen(): boolean
  /** Drive the roll without a mouse (used by the MCP test hook). */
  pointer(kind: 'down' | 'move' | 'up', x: number, y: number, mods?: { shift?: boolean; alt?: boolean; button?: number }): void
  key(k: string, mods?: { ctrl?: boolean }): void
  /** Layout + state for tests. */
  info(): { open: boolean; notes: number; selected: number[]; view: RollView; keysW: number; rulerH: number; velH: number; canvas: { w: number; h: number } }
}

export function createPianoRoll(host: HTMLElement): PianoRollApi {
  const root = document.createElement('div')
  root.id = 'pianoroll'
  root.hidden = true
  root.innerHTML =
    `<div class="pr-card">` +
    `<div class="pr-head">` +
    `<span class="pr-title"></span>` +
    `<label>Clip <select class="pr-clip"></select></label>` +
    `<label>Snap <select class="pr-snap">` +
    `<option>1/4</option><option>1/8</option><option selected>1/16</option><option>1/32</option>` +
    `<option>1/8T</option><option>1/16T</option><option>off</option></select></label>` +
    `<button class="pr-zi" title="Zoom in (time)">＋</button><button class="pr-zo" title="Zoom out (time)">－</button>` +
    `<button class="pr-del" title="Delete selected (Del)">Delete</button>` +
    `<span class="pr-hint">click = add · drag = move · edge = resize · Shift = multi · right-click = delete</span>` +
    `<button class="pr-close" title="Close (Esc)">✕</button>` +
    `</div><div class="pr-body"><canvas></canvas></div></div>`
  host.appendChild(root)

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T
  const canvas = q<HTMLCanvasElement>('canvas')
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  const titleEl = q<HTMLElement>('.pr-title')
  const clipSel = q<HTMLSelectElement>('.pr-clip')
  const snapSel = q<HTMLSelectElement>('.pr-snap')

  let track: MidiTrack | null = null
  let clip: MidiClip | null = null
  let selected = new Set<number>()
  let drag: DragOp | null = null
  let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null
  let lastDur = 0.25
  let raf = 0
  let cw = 0
  let ch = 0
  const view: RollView = { pxPerBeat: 64, rowH: 14, scrollBeats: 0, topKey: 84 }

  const noteAreaH = (): number => ch - RULER_H - VEL_H
  const grid = (): number => gridBeats(snapSel.value)

  // ---- note-area coordinates: x/y here are canvas pixels; the note area starts at (KEYS_W, RULER_H)
  const toArea = (x: number, y: number): { ax: number; ay: number } => ({ ax: x - KEYS_W, ay: y - RULER_H })
  const notes = (): MidiClip['notes'] => clip?.notes ?? []

  function clampView(): void {
    // keep key 127 reachable at the top and key 0 at the bottom
    view.topKey = Math.min(127.99, Math.max(noteAreaH() / view.rowH - 1, view.topKey))
    view.scrollBeats = Math.max(0, view.scrollBeats)
  }

  // ---- drawing ------------------------------------------------------------------
  function draw(): void {
    if (!clip) return
    const W = cw
    const H = ch
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0b0d12'
    ctx.fillRect(0, 0, W, H)

    const nh = noteAreaH()
    // pitch rows
    ctx.save()
    ctx.beginPath()
    ctx.rect(KEYS_W, RULER_H, W - KEYS_W, nh)
    ctx.clip()
    ctx.translate(KEYS_W, RULER_H)
    const k0 = Math.min(127, Math.ceil(view.topKey))
    const k1 = Math.max(0, Math.floor(view.topKey - nh / view.rowH))
    for (let k = k0; k >= k1; k--) {
      const y = keyToY(view, k)
      ctx.fillStyle = BLACK.has(k % 12) ? '#0e1118' : '#12151c'
      ctx.fillRect(0, y, W - KEYS_W, view.rowH)
      if (k % 12 === 0) {
        ctx.fillStyle = '#232833'
        ctx.fillRect(0, y + view.rowH - 1, W - KEYS_W, 1)
      }
    }
    // vertical grid
    const step = gridLineStep(view.pxPerBeat)
    const b0 = Math.floor(view.scrollBeats / step) * step
    const b1 = view.scrollBeats + (W - KEYS_W) / view.pxPerBeat
    for (let b = b0; b <= b1; b += step) {
      const x = beatToX(view, b)
      const isBar = Math.abs(b / state.timeSigNum - Math.round(b / state.timeSigNum)) < 1e-6
      const isBeat = Math.abs(b - Math.round(b)) < 1e-6
      ctx.fillStyle = isBar ? '#3a4254' : isBeat ? '#2a3140' : '#1a1f29'
      ctx.fillRect(Math.round(x), 0, 1, nh)
    }
    // notes
    for (const n of notes()) {
      const r = noteRect(view, n)
      if (r.x + r.w < 0 || r.x > W || r.y + r.h < 0 || r.y > nh) continue
      const sel = selected.has(n.id)
      const lum = 0.55 + 0.45 * (n.vel / 127)
      ctx.fillStyle = sel ? '#7fd1ff' : `rgb(${Math.round(30 * lum)},${Math.round(200 * lum)},${Math.round(140 * lum)})`
      ctx.fillRect(r.x, r.y + 1, r.w, r.h - 2)
      ctx.strokeStyle = sel ? '#ffffff' : '#04231b'
      ctx.strokeRect(r.x + 0.5, r.y + 1.5, r.w - 1, r.h - 3)
    }
    // marquee
    if (marquee) {
      ctx.strokeStyle = '#4da3ff'
      ctx.fillStyle = 'rgba(77,163,255,0.15)'
      const x = Math.min(marquee.x0, marquee.x1) - KEYS_W
      const y = Math.min(marquee.y0, marquee.y1) - RULER_H
      const w = Math.abs(marquee.x1 - marquee.x0)
      const h = Math.abs(marquee.y1 - marquee.y0)
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x + 0.5, y + 0.5, w, h)
    }
    // playhead
    const ph = framesToBeats(state.playhead, state.bpm, state.sampleRate) - clip.start
    const px = beatToX(view, ph)
    if (px >= 0 && px <= W) {
      ctx.fillStyle = '#37d67a'
      ctx.fillRect(Math.round(px), 0, 1, nh)
    }
    ctx.restore()

    // keyboard strip
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, RULER_H, KEYS_W, nh)
    ctx.clip()
    for (let k = k0; k >= k1; k--) {
      const y = RULER_H + keyToY(view, k)
      ctx.fillStyle = BLACK.has(k % 12) ? '#1b202b' : '#cfd5e1'
      ctx.fillRect(0, y, KEYS_W - 1, view.rowH - 1)
      const dn = track?.instrument?.kind === 'drums' ? drumNameOfKey(k) : null
      if (dn) {
        ctx.fillStyle = '#34d399'
        ctx.font = '9px sans-serif'
        ctx.fillText(dn.slice(0, 9), 3, y + view.rowH - 4)
      } else if (k % 12 === 0 || view.rowH >= 16) {
        ctx.fillStyle = BLACK.has(k % 12) ? '#7d8697' : '#243044'
        ctx.font = '9px sans-serif'
        ctx.fillText(keyName(k), 4, y + view.rowH - 4)
      }
    }
    ctx.restore()

    // ruler
    ctx.fillStyle = '#12151c'
    ctx.fillRect(0, 0, W, RULER_H)
    ctx.fillStyle = '#7d8697'
    ctx.font = '10px sans-serif'
    const rstep = Math.max(step, view.pxPerBeat * state.timeSigNum >= 40 ? state.timeSigNum : 1)
    for (let b = Math.floor(view.scrollBeats / rstep) * rstep; b <= b1; b += rstep) {
      const x = KEYS_W + beatToX(view, b)
      if (x < KEYS_W) continue
      ctx.fillStyle = '#3a4254'
      ctx.fillRect(Math.round(x), 4, 1, RULER_H - 4)
      ctx.fillStyle = '#7d8697'
      ctx.fillText(`${Math.floor(b / state.timeSigNum) + 1}.${(Math.floor(b) % state.timeSigNum) + 1}`, x + 3, 13)
    }

    // velocity strip
    const vy = RULER_H + nh
    ctx.fillStyle = '#0e1118'
    ctx.fillRect(0, vy, W, VEL_H)
    ctx.fillStyle = '#232833'
    ctx.fillRect(0, vy, W, 1)
    ctx.fillStyle = '#7d8697'
    ctx.font = '9px sans-serif'
    ctx.fillText('VEL', 8, vy + 14)
    for (const n of notes()) {
      const x = KEYS_W + beatToX(view, n.start)
      if (x < KEYS_W || x > W) continue
      const h = (n.vel / 127) * (VEL_H - 8)
      ctx.fillStyle = selected.has(n.id) ? '#7fd1ff' : '#34d399'
      ctx.fillRect(Math.round(x), vy + VEL_H - 4 - h, 3, h)
    }
    ctx.fillStyle = '#232833'
    ctx.fillRect(KEYS_W - 1, 0, 1, H)
  }

  function frame(): void {
    if (root.hidden) return
    draw()
    raf = requestAnimationFrame(frame)
  }

  // ---- editing ------------------------------------------------------------------
  const originsOf = (ids: Iterable<number>): Origin[] => {
    const set = new Set(ids)
    return notes()
      .filter((n) => set.has(n.id))
      .map((n) => ({ id: n.id, start: n.start, dur: n.dur, key: n.key }))
  }
  const growClip = (): void => {
    if (!clip) return
    let end = 0
    for (const n of clip.notes) end = Math.max(end, n.start + n.dur)
    if (end > clip.length) clip.length = Math.ceil(end)
  }

  function pointer(
    kind: 'down' | 'move' | 'up',
    x: number,
    y: number,
    mods: { shift?: boolean; alt?: boolean; button?: number } = {}
  ): void {
    if (!clip) return
    const { ax, ay } = toArea(x, y)
    const inVel = y >= RULER_H + noteAreaH()
    const inRuler = y < RULER_H
    const inNotes = !inVel && !inRuler && x >= KEYS_W

    if (kind === 'down') {
      if (inVel) {
        // nearest note start within 6 px
        let best: { id: number; d: number } | null = null
        for (const n of notes()) {
          const d = Math.abs(KEYS_W + beatToX(view, n.start) - x)
          if (d <= 6 && (!best || d < best.d)) best = { id: n.id, d }
        }
        if (!best) return
        selected = new Set([best.id])
        drag = { kind: 'velocity', grabbedId: best.id, startX: x, startY: y, origins: [] }
        setVelocity(best.id, y)
        return
      }
      if (!inNotes) return
      const hit = hitTest(view, notes(), ax, ay)
      if ((mods.button === 2 || mods.alt) && hit) {
        removeNote(clip, hit.id)
        selected.delete(hit.id)
        return
      }
      if (hit) {
        if (mods.shift) {
          if (selected.has(hit.id)) selected.delete(hit.id)
          else selected.add(hit.id)
          return
        }
        if (!selected.has(hit.id)) selected = new Set([hit.id])
        drag = {
          kind: hit.zone === 'right' ? 'resize' : 'move',
          grabbedId: hit.id,
          startX: x,
          startY: y,
          origins: originsOf(selected)
        }
        return
      }
      if (mods.shift) {
        drag = { kind: 'marquee', grabbedId: -1, startX: x, startY: y, origins: [], base: new Set(selected) }
        marquee = { x0: x, y0: y, x1: x, y1: y }
        return
      }
      // click on empty space: new note, then drag to size it
      const key = Math.max(0, Math.min(127, yToKey(view, ay)))
      const start = Math.max(0, snapFloor(xToBeat(view, ax), grid()))
      const clickBeat = xToBeat(view, ax)
      const n = addNote(clip, start, grid() || lastDur, key, 100)
      selected = new Set([n.id])
      // Dragging sets the end to the pointer: measure the drag from where the click landed
      // inside its grid cell, not from the note's initial length.
      drag = {
        kind: 'resize',
        grabbedId: n.id,
        startX: x,
        startY: y,
        origins: [{ id: n.id, start: n.start, dur: Math.max(0, clickBeat - n.start), key: n.key }]
      }
      return
    }

    if (kind === 'move' && drag && clip) {
      const dxBeats = (x - drag.startX) / view.pxPerBeat
      if (drag.kind === 'move') {
        const m = moveNotes(drag.origins, drag.grabbedId, dxBeats, -Math.round((y - drag.startY) / view.rowH), grid())
        for (const n of clip.notes) {
          const to = m.get(n.id)
          if (to) {
            n.start = to.start
            n.key = to.key
          }
        }
        growClip()
        midiChanged()
      } else if (drag.kind === 'resize') {
        const r = resizeNotes(drag.origins, drag.grabbedId, dxBeats, grid())
        for (const n of clip.notes) {
          const d = r.get(n.id)
          if (d !== undefined) n.dur = d
        }
        growClip()
        midiChanged()
      } else if (drag.kind === 'marquee' && marquee) {
        marquee.x1 = x
        marquee.y1 = y
        const inside = notesInRect(
          view,
          notes(),
          Math.min(marquee.x0, marquee.x1) - KEYS_W,
          Math.min(marquee.y0, marquee.y1) - RULER_H,
          Math.max(marquee.x0, marquee.x1) - KEYS_W,
          Math.max(marquee.y0, marquee.y1) - RULER_H
        )
        selected = new Set([...(drag.base ?? []), ...inside])
      } else if (drag.kind === 'velocity') {
        setVelocity(drag.grabbedId, y)
      }
      return
    }

    if (kind === 'up') {
      if (drag?.kind === 'resize') {
        const n = notes().find((nn) => nn.id === drag?.grabbedId)
        if (n) lastDur = n.dur // the next click-created note starts at the last length used
      }
      drag = null
      marquee = null
    }
  }

  function setVelocity(id: number, y: number): void {
    const n = notes().find((nn) => nn.id === id)
    if (!n) return
    const t = 1 - (y - (RULER_H + noteAreaH()) - 4) / (VEL_H - 8)
    n.vel = Math.max(1, Math.min(127, Math.round(t * 127)))
    midiChanged()
  }

  function deleteSelected(): void {
    if (!clip) return
    for (const id of [...selected]) removeNote(clip, id)
    selected.clear()
  }

  function key(k: string, mods: { ctrl?: boolean } = {}): void {
    if (root.hidden) return
    if (k === 'Delete' || k === 'Backspace') deleteSelected()
    else if (k === 'Escape') close()
    else if ((k === 'a' || k === 'A') && mods.ctrl) selected = new Set(notes().map((n) => n.id))
  }

  // ---- lifecycle ----------------------------------------------------------------
  function resize(): void {
    const body = q<HTMLElement>('.pr-body')
    const dpr = window.devicePixelRatio || 1
    cw = Math.max(200, body.clientWidth)
    ch = Math.max(160, body.clientHeight)
    canvas.width = Math.round(cw * dpr)
    canvas.height = Math.round(ch * dpr)
    canvas.style.width = `${cw}px`
    canvas.style.height = `${ch}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    clampView()
  }

  function fillClipSelect(idx: number): void {
    if (!track) return
    clipSel.replaceChildren()
    track.clips.forEach((c, i) => {
      const o = document.createElement('option')
      o.value = String(i)
      o.textContent = `${i + 1}: ${c.name} (${c.notes.length})`
      clipSel.appendChild(o)
    })
    clipSel.value = String(idx)
  }

  function open(t: MidiTrack, clipIndex = 0): void {
    track = t
    if (t.clips.length === 0) addMidiClip(t, 0, 4, t.name)
    const idx = Math.max(0, Math.min(t.clips.length - 1, clipIndex))
    clip = t.clips[idx]
    selected = new Set()
    drag = null
    marquee = null
    titleEl.textContent = `Piano roll — ${t.name}`
    fillClipSelect(idx)
    root.hidden = false
    resize()
    // centre the view on the notes (or middle C)
    const ks = clip.notes.map((n) => n.key)
    const mid = ks.length ? (Math.min(...ks) + Math.max(...ks)) / 2 : 60
    view.topKey = Math.min(127, mid + noteAreaH() / view.rowH / 2)
    view.scrollBeats = 0
    clampView()
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(frame)
  }

  function close(): void {
    root.hidden = true
    cancelAnimationFrame(raf)
    drag = null
    marquee = null
    if (track) midiChanged() // final re-render with everything that was edited
  }

  clipSel.addEventListener('change', () => {
    if (!track) return
    clip = track.clips[Number(clipSel.value)] ?? clip
    selected = new Set()
  })
  q<HTMLButtonElement>('.pr-close').addEventListener('click', close)
  q<HTMLButtonElement>('.pr-del').addEventListener('click', deleteSelected)
  const zoom = (f: number): void => {
    const center = xToBeat(view, (cw - KEYS_W) / 2)
    view.pxPerBeat = Math.max(8, Math.min(600, view.pxPerBeat * f))
    view.scrollBeats = Math.max(0, center - (cw - KEYS_W) / 2 / view.pxPerBeat)
  }
  q<HTMLButtonElement>('.pr-zi').addEventListener('click', () => zoom(1.5))
  q<HTMLButtonElement>('.pr-zo').addEventListener('click', () => zoom(1 / 1.5))
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) close() // click on the dimmed backdrop
  })

  const local = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId)
    const p = local(e)
    pointer('down', p.x, p.y, { shift: e.shiftKey, alt: e.altKey, button: e.button })
  })
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e)
    pointer('move', p.x, p.y)
  })
  canvas.addEventListener('pointerup', (e) => {
    const p = local(e)
    pointer('up', p.x, p.y)
  })
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      if (e.ctrlKey) {
        const p = local(e)
        const before = xToBeat(view, p.x - KEYS_W)
        view.pxPerBeat = Math.max(8, Math.min(600, view.pxPerBeat * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
        view.scrollBeats = Math.max(0, before - (p.x - KEYS_W) / view.pxPerBeat)
      } else if (e.shiftKey) {
        view.scrollBeats = Math.max(0, view.scrollBeats + (e.deltaY / view.pxPerBeat) * 1.2)
      } else {
        view.topKey += e.deltaY / view.rowH
        clampView()
      }
    },
    { passive: false }
  )
  // Capture phase on window: keys handled here must not also reach the global shortcuts
  // (Delete would otherwise remove the selected timeline clip underneath).
  window.addEventListener(
    'keydown',
    (e) => {
      if (root.hidden) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'SELECT' || tag === 'INPUT') return
      if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape' || ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        e.stopPropagation()
        key(e.key, { ctrl: e.ctrlKey || e.metaKey })
      }
    },
    true
  )
  window.addEventListener('resize', () => {
    if (!root.hidden) resize()
  })

  return {
    open,
    close,
    isOpen: () => !root.hidden,
    pointer,
    key,
    info: () => ({
      open: !root.hidden,
      notes: notes().length,
      selected: [...selected],
      view: { ...view },
      keysW: KEYS_W,
      rulerH: RULER_H,
      velH: VEL_H,
      canvas: { w: cw, h: ch }
    })
  }
}
