// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import {
  defaultValues,
  isDefault,
  isFieldVisible,
  normalizeField,
  parseOptions,
  serializeOptions,
  type OptionField,
  type OptionSection,
  type OptionValue,
  type OptionValues
} from './options-model'
import { faderOptions } from './fader-skin'
import { aiOptions } from './ai-options'
import { exportOptions } from './export-options'

/**
 * The Options panel and its file. Sections are registered below (one line each); the panel is built
 * from them. Everything lives in ONE file with a fixed name in the user-data folder
 * (`awaker-options.json`, written by main): it is read and applied at every start, edits show up
 * live while the panel is open, **OK** writes the file, **Cancel** puts back what was saved.
 *
 * To add options for a new feature: write an `OptionSection` (see fader-skin.ts) and add it to
 * `SECTIONS`. Nothing else here changes.
 */

const SECTIONS: OptionSection[] = [faderOptions, aiOptions, exportOptions]

type Flash = (msg: string, isErr?: boolean) => void

let flash: Flash = () => {}
let saved: OptionValues = defaultValues(SECTIONS) // what is in the file (or the defaults when there is none)
let working: OptionValues = defaultValues(SECTIONS) // what the panel currently shows
let extra: Record<string, unknown> = {} // sections of other versions: kept so a save does not drop them
let filePath = ''
let root: HTMLElement | null = null

const clone = (v: OptionValues): OptionValues => JSON.parse(JSON.stringify(v)) as OptionValues

function applyAll(values: OptionValues): void {
  for (const s of SECTIONS) {
    try {
      s.apply(values[s.id])
    } catch (err) {
      console.error(`[options] ${s.id}: apply failed`, err)
    }
  }
}

/** Read the options file and put it in force. Call once at start-up; a missing / broken file = defaults. */
export async function initOptions(flashStatus: Flash): Promise<void> {
  flash = flashStatus
  try {
    const res = await window.daw.optionsLoad()
    if (res.ok) {
      filePath = res.path
      const parsed = parseOptions(SECTIONS, res.data)
      saved = parsed.values
      extra = parsed.extra
      if (res.warning) flash(`options: ${res.warning}`, true)
    } else {
      flash(`options not loaded: ${res.error}`, true)
    }
  } catch (err) {
    console.error('[options] load failed', err)
  }
  working = clone(saved)
  applyAll(saved)
  document.getElementById('options-btn')?.addEventListener('click', openOptions)
}

// ---- the panel ----------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function fieldRow(sec: OptionSection, f: OptionField, onChange: () => void): HTMLElement {
  const row = el('div', 'op-field')
  const label = el('div', 'op-label')
  label.append(el('span', 'op-name', f.label))
  if (f.hint) label.append(el('span', 'op-hint', f.hint))
  row.append(label)
  const ctl = el('div', 'op-control')
  const name = `${sec.id}.${f.key}`
  const cur = working[sec.id][f.key]
  const set = (v: OptionValue): void => {
    working[sec.id][f.key] = normalizeField(f, v, sec.defaults[f.key])
    onChange()
  }
  if (f.type === 'choice') {
    for (const c of f.choices) {
      const lab = el('label', 'op-choice')
      const inp = el('input')
      inp.type = 'radio'
      inp.name = name
      inp.value = c.value
      inp.checked = cur === c.value
      inp.addEventListener('change', () => inp.checked && set(c.value))
      lab.append(inp, el('span', undefined, c.label))
      ctl.append(lab)
    }
  } else if (f.type === 'number') {
    const inp = el('input')
    inp.type = 'number'
    inp.name = name
    inp.min = String(f.min)
    inp.max = String(f.max)
    if (f.step) inp.step = String(f.step)
    inp.value = String(cur)
    inp.addEventListener('change', () => set(Number(inp.value)))
    ctl.append(inp)
    if (f.unit) ctl.append(el('span', 'op-unit', f.unit))
  } else if (f.type === 'text' && f.multiline) {
    const ta = el('textarea')
    ta.name = name
    ta.className = 'op-text op-area'
    ta.rows = f.rows ?? 8
    ta.maxLength = f.maxLength
    ta.spellcheck = false
    if (f.placeholder) ta.placeholder = f.placeholder
    ta.value = String(cur)
    ta.addEventListener('input', () => set(ta.value))
    ctl.append(ta)
  } else if (f.type === 'text') {
    const inp = el('input')
    inp.type = 'text'
    inp.name = name
    inp.className = 'op-text'
    inp.maxLength = f.maxLength
    inp.spellcheck = false
    inp.autocomplete = 'off'
    if (f.placeholder) inp.placeholder = f.placeholder
    inp.value = String(cur)
    inp.addEventListener('input', () => set(inp.value))
    ctl.append(inp)
  } else {
    const lab = el('label', 'op-choice')
    const inp = el('input')
    inp.type = 'checkbox'
    inp.name = name
    inp.checked = cur === true
    inp.addEventListener('change', () => set(inp.checked))
    lab.append(inp, el('span', undefined, 'On'))
    ctl.append(lab)
  }
  row.append(ctl)
  return row
}

function build(): HTMLElement {
  const r = el('div')
  r.id = 'options'
  r.hidden = true
  const card = el('div', 'op-card')
  const head = el('div', 'op-head')
  head.append(el('span', 'op-title', 'Options'))
  card.append(head)
  const body = el('div', 'op-body')
  card.append(body)
  const foot = el('div', 'op-foot')
  const where = el('span', 'op-where')
  const reset = el('button', undefined, 'Reset to defaults')
  reset.id = 'options-reset'
  const cancel = el('button', undefined, 'Cancel')
  cancel.id = 'options-cancel'
  const ok = el('button', 'op-ok', 'OK')
  ok.id = 'options-ok'
  foot.append(where, reset, cancel, ok)
  card.append(foot)
  r.append(card)
  document.body.appendChild(r)

  const render = (): void => {
    body.replaceChildren()
    for (const sec of SECTIONS) {
      const s = el('section', 'op-sec')
      s.dataset.section = sec.id
      const h = el('h3')
      h.append(sec.title)
      if (!isDefault(sec, working[sec.id])) h.append(el('span', 'op-mod', ' · changed'))
      s.append(h)
      if (sec.description) s.append(el('p', 'op-desc', sec.description))
      const preview = el('div', 'op-preview')
      const rows: { f: OptionField; row: HTMLElement }[] = []
      const showRows = (): void => {
        for (const r of rows) r.row.hidden = !isFieldVisible(r.f, working[sec.id])
      }
      const refresh = (): void => {
        sec.apply(working[sec.id]) // live: the real UI behind the panel changes as you choose
        showRows()
        sec.preview?.(preview, working[sec.id])
        h.querySelector('.op-mod')?.remove()
        if (!isDefault(sec, working[sec.id])) h.append(el('span', 'op-mod', ' · changed'))
      }
      const host = sec.box ? el('div', 'op-box') : s
      if (sec.box) host.style.height = `${sec.box.height}px`
      for (const f of sec.fields) {
        const row = fieldRow(sec, f, refresh)
        rows.push({ f, row })
        host.append(row)
      }
      showRows()
      if (sec.preview) {
        host.append(preview)
        sec.preview(preview, working[sec.id])
      }
      if (sec.box) s.append(host)
      body.append(s)
    }
    where.textContent = filePath ? `Saved to ${filePath}` : 'Saved to the user-data folder'
  }

  const close = (keep: boolean): void => {
    if (!keep) {
      working = clone(saved)
      applyAll(saved) // back to what the file says
    }
    r.hidden = true
  }
  ok.addEventListener('click', async () => {
    ok.disabled = true
    try {
      const res = await window.daw.optionsSave(serializeOptions(working, extra))
      if (res.ok) {
        saved = clone(working)
        filePath = res.path
        close(true)
        flash('options saved')
      } else {
        where.textContent = `Could not save: ${res.error}`
        flash(`options not saved: ${res.error}`, true)
      }
    } finally {
      ok.disabled = false
    }
  })
  cancel.addEventListener('click', () => close(false))
  reset.addEventListener('click', () => {
    working = defaultValues(SECTIONS)
    applyAll(working)
    render()
  })
  r.addEventListener('pointerdown', (e) => {
    if (e.target === r) close(false)
  })
  window.addEventListener(
    'keydown',
    (e) => {
      if (r.hidden || e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close(false)
    },
    true
  )
  ;(r as HTMLElement & { renderOptions?: () => void }).renderOptions = render
  return r
}

export function openOptions(): void {
  root ??= build()
  working = clone(saved)
  ;(root as HTMLElement & { renderOptions: () => void }).renderOptions()
  root.hidden = false
}
