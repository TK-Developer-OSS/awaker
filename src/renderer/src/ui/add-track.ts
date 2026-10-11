// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { listInstruments } from '../gpu/instrument'
import { EARLY_PRESET_NAMES } from '../gpu/instruments/earlysynth/presets'
import { FM_PRESET_NAMES } from '../gpu/instruments/fm-presets'
import { PRESETS as DRUM_PATTERNS } from '../midi/step-logic'
import { BAR_CHOICES, defaultBarsFor, followsDefault, inputChoices, parseInput, uniqueName } from './add-track-model'

/**
 * The Add Track panel: the single place to create a track. "＋ Add Track" opens it; the kind of track
 * and its details are decided here (name, instrument and preset / pattern, length, input channel…),
 * then Add creates it. The instrument and line-input buttons that used to sit in the toolbar live here.
 *
 * The panel only collects choices; creating the track is the host's job (`AddTrackHooks`).
 */

export interface InstrumentSpec {
  kind: string
  name: string
  /** FM-style instruments: a factory preset name. Drum machine: a pattern name. */
  preset?: string
  bars: number
  openEditor: boolean
}
export interface LineSpec {
  name: string
  ch: number
  stereo: boolean
  monitor: boolean
}
export interface AddTrackHooks {
  /** Titles of the tracks that exist, for unique default names. */
  existingNames(): string[]
  /** Native file picker, then one audio track per WAV. Resolves false if the user cancelled. */
  pickWavs(): Promise<boolean>
  addTone(): Promise<void>
  addInstrument(spec: InstrumentSpec): void
  addLine(spec: LineSpec): void
}

type TrackType = 'audio' | 'instrument' | 'line'

const TYPE_LABELS: Record<TrackType, string> = { audio: 'Audio', instrument: 'Instrument', line: 'Line input' }
const TYPE_HINTS: Record<TrackType, string> = {
  audio: 'Audio from WAV files, or a generated test tone.',
  instrument: 'A track played by a built-in GPU instrument: you write the notes (piano roll / step sequencer).',
  line: 'Live input from the audio interface, played through the track strip and inserts.'
}

let hooks: AddTrackHooks | null = null
let root: HTMLElement | null = null
// remembered for the session: the panel opens on what you used last
let lastType: TrackType = 'audio'
let lastKind = 'earlysynth'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el('div', 'at-field')
  const l = el('div', 'at-label')
  l.append(el('span', 'at-name', label))
  if (hint) l.append(el('span', 'at-hint', hint))
  row.append(l, control)
  return row
}

function select(id: string, options: { value: string; label: string }[], value?: string): HTMLSelectElement {
  const s = el('select')
  s.id = id
  for (const o of options) {
    const op = el('option', undefined, o.label)
    op.value = o.value
    s.append(op)
  }
  if (value !== undefined) s.value = value
  return s
}

function build(h: AddTrackHooks): HTMLElement {
  const r = el('div')
  r.id = 'addtrack'
  r.hidden = true
  const card = el('div', 'at-card')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Add Track')

  // ---- header + type switch
  const head = el('div', 'at-head')
  head.append(el('span', 'at-title', 'Add Track'))
  const types = el('div', 'at-types')
  for (const t of Object.keys(TYPE_LABELS) as TrackType[]) {
    const lab = el('label', 'at-type')
    const inp = el('input')
    inp.type = 'radio'
    inp.name = 'at-type'
    inp.value = t
    lab.append(inp, el('span', undefined, TYPE_LABELS[t]))
    types.append(lab)
  }
  head.append(types)
  const hint = el('div', 'at-typehint')

  // ---- audio form
  const audio = el('div', 'at-form')
  audio.dataset.type = 'audio'
  const audioSrc = el('div', 'at-choices')
  for (const [v, text] of [['wav', 'WAV file(s) — one track per file'], ['tone', 'GPU demo tone (6 s)']] as const) {
    const lab = el('label', 'at-choice')
    const inp = el('input')
    inp.type = 'radio'
    inp.name = 'at-audio-source'
    inp.value = v
    inp.checked = v === 'wav'
    lab.append(inp, el('span', undefined, text))
    audioSrc.append(lab)
  }
  audio.append(field('Source', audioSrc, 'Tracks are named from the file name.'))

  // ---- instrument form
  const inst = el('div', 'at-form')
  inst.dataset.type = 'instrument'
  const kinds = listInstruments()
  const kindSel = select('at-kind', kinds.map((k) => ({ value: k.kind, label: k.label })), kinds.some((k) => k.kind === lastKind) ? lastKind : kinds[0]?.kind)
  const nameInp = el('input')
  nameInp.type = 'text'
  nameInp.id = 'at-name'
  nameInp.maxLength = 48
  const presetSel = select('at-preset', [])
  const presetRow = field('Preset', presetSel, 'The starting sound; every setting can be changed afterwards.')
  const barsSel = select('at-bars', BAR_CHOICES.map((b) => ({ value: String(b), label: `${b} bar${b > 1 ? 's' : ''}` })))
  const barsRow = field('Length', barsSel, 'Length of the first clip (notes can run past it).')
  const openLab = el('label', 'at-choice')
  const openInp = el('input')
  openInp.type = 'checkbox'
  openInp.id = 'at-open'
  openInp.checked = true
  openLab.append(openInp, el('span', undefined, 'Open the editor after adding'))
  inst.append(field('Instrument', kindSel), field('Name', nameInp), presetRow, barsRow, field('', openLab))

  // ---- line form
  const line = el('div', 'at-form')
  line.dataset.type = 'line'
  const lineName = el('input')
  lineName.type = 'text'
  lineName.id = 'at-line-name'
  lineName.maxLength = 48
  const inSel = select('at-input', inputChoices(8))
  const monLab = el('label', 'at-choice')
  const monInp = el('input')
  monInp.type = 'checkbox'
  monInp.id = 'at-monitor'
  monInp.checked = true
  monLab.append(monInp, el('span', undefined, 'Monitor through the strip and inserts'))
  line.append(field('Name', lineName), field('Input', inSel, 'The audio interface input to take.'), field('', monLab))

  // ---- footer
  const foot = el('div', 'at-foot')
  const status = el('span', 'at-status')
  const cancel = el('button', undefined, 'Cancel')
  cancel.id = 'at-cancel'
  const add = el('button', 'at-add', 'Add')
  add.id = 'at-add'
  foot.append(status, cancel, add)

  card.append(head, hint, audio, inst, line, foot)
  r.append(card)
  document.body.appendChild(r)

  // ---- behaviour
  let kindDefaultName = ''
  const labelOf = (k: string): string => kinds.find((x) => x.kind === k)?.label ?? k
  const unique = (base: string): string => uniqueName(base, h.existingNames())

  /** Preset / pattern / length fields follow the chosen instrument. */
  const syncInstrument = (rename: boolean): void => {
    const k = kindSel.value
    lastKind = k
    let opts: string[] = []
    let label = 'Preset'
    if (k === 'earlysynth') opts = EARLY_PRESET_NAMES
    else if (k === 'fm') opts = FM_PRESET_NAMES
    else if (k === 'drums') {
      opts = DRUM_PATTERNS.map((p) => p.name)
      label = 'Pattern'
    }
    presetSel.replaceChildren(...opts.map((n) => Object.assign(el('option', undefined, n), { value: n })))
    if (k === 'earlysynth' || k === 'fm') presetSel.value = 'Pop Pluck'
    presetRow.hidden = opts.length === 0
    presetRow.querySelector('.at-name')!.textContent = label
    barsSel.value = String(defaultBarsFor(k))
    if (rename || followsDefault(nameInp.value, kindDefaultName)) {
      kindDefaultName = unique(labelOf(k))
      nameInp.value = kindDefaultName
    }
  }
  kindSel.addEventListener('change', () => syncInstrument(false))

  const current = (): TrackType => (r.querySelector<HTMLInputElement>('input[name="at-type"]:checked')?.value as TrackType) ?? 'audio'
  const showType = (t: TrackType): void => {
    lastType = t
    for (const f of r.querySelectorAll<HTMLElement>('.at-form')) f.hidden = f.dataset.type !== t
    hint.textContent = TYPE_HINTS[t]
    add.textContent = t === 'audio' ? 'Next…' : 'Add'
    status.textContent = ''
    if (t === 'line' && !lineName.value) lineName.value = unique('Line In')
  }
  for (const i of r.querySelectorAll<HTMLInputElement>('input[name="at-type"]')) i.addEventListener('change', () => showType(current()))
  audioSrc.addEventListener('change', () => {
    const wav = r.querySelector<HTMLInputElement>('input[name="at-audio-source"]:checked')?.value === 'wav'
    add.textContent = wav ? 'Choose files…' : 'Add'
  })
  const refreshAudioLabel = (): void => {
    audioSrc.dispatchEvent(new Event('change'))
  }
  for (const i of r.querySelectorAll<HTMLInputElement>('input[name="at-type"]'))
    i.addEventListener('change', () => {
      if (current() === 'audio') refreshAudioLabel()
    })

  const close = (): void => {
    r.hidden = true
  }
  const submit = async (): Promise<void> => {
    add.disabled = true
    status.textContent = ''
    try {
      const t = current()
      if (t === 'audio') {
        const src = r.querySelector<HTMLInputElement>('input[name="at-audio-source"]:checked')?.value
        if (src === 'tone') {
          close()
          await h.addTone()
        } else if (await h.pickWavs()) {
          close() // stay open when the picker was cancelled, so nothing is lost
        }
      } else if (t === 'instrument') {
        const k = kindSel.value
        close()
        h.addInstrument({
          kind: k,
          name: unique(nameInp.value.trim() || labelOf(k)),
          preset: presetRow.hidden ? undefined : presetSel.value,
          bars: Number(barsSel.value) || defaultBarsFor(k),
          openEditor: openInp.checked
        })
      } else {
        const inp = parseInput(inSel.value)
        if (!inp) {
          status.textContent = 'Pick an input.'
          return
        }
        close()
        h.addLine({ name: unique(lineName.value.trim() || 'Line In'), ch: inp.ch, stereo: inp.stereo, monitor: monInp.checked })
      }
    } catch (err) {
      status.textContent = `Could not add the track: ${(err as Error).message}`
      console.error('[add-track]', err)
    } finally {
      add.disabled = false
    }
  }
  add.addEventListener('click', () => void submit())
  cancel.addEventListener('click', close)
  r.addEventListener('pointerdown', (e) => {
    if (e.target === r) close()
  })
  // Enter in a text box adds; Escape closes (capture phase: the global shortcuts must not see these keys)
  r.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') {
      e.preventDefault()
      void submit()
    }
  })
  window.addEventListener(
    'keydown',
    (e) => {
      if (r.hidden || e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    },
    true
  )

  ;(r as HTMLElement & { prepare?: () => void }).prepare = () => {
    kindDefaultName = ''
    syncInstrument(true)
    lineName.value = unique('Line In')
    const radio = r.querySelector<HTMLInputElement>(`input[name="at-type"][value="${lastType}"]`)
    if (radio) radio.checked = true
    showType(lastType)
    if (lastType === 'audio') refreshAudioLabel()
  }
  return r
}

export function openAddTrack(): void {
  if (!hooks) return
  root ??= build(hooks)
  ;(root as HTMLElement & { prepare: () => void }).prepare()
  root.hidden = false
}

/** Wire the toolbar's "＋ Add Track" button to the panel. */
export function initAddTrack(h: AddTrackHooks): void {
  hooks = h
  document.getElementById('add-track')?.addEventListener('click', openAddTrack)
}
