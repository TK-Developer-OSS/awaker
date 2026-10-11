// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { StemExportSettings } from '../audio/stem-export'

/**
 * File → Export → Mixdown…: choose the bit depth and sample rate (and the tail) before the file name is asked
 * for. The Options → Export values are the starting point; what is chosen here is for this export only.
 */

export interface MixdownChoice {
  bitDepth: 16 | 24 | 32
  sampleRate: number
  tailSeconds: number
}

const CSS = `
#mixdown-dlg { position: fixed; inset: 0; z-index: 2150; display: flex; align-items: center; justify-content: center; background: rgba(5, 7, 11, 0.55); }
#mixdown-dlg[hidden] { display: none; }
#mixdown-dlg .md-card { width: 380px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; background: #161a22; border: 1px solid #2a5a9e;
  border-radius: 8px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); color: #e6e9ef; font: 13px system-ui, "Yu Gothic UI", sans-serif; }
#mixdown-dlg h4 { margin: 0; font-size: 14px; }
#mixdown-dlg .md-row { display: flex; flex-direction: column; gap: 6px; }
#mixdown-dlg .md-row > span { color: #aab2c0; }
#mixdown-dlg .md-opts { display: flex; gap: 6px; flex-wrap: wrap; }
#mixdown-dlg label.md-opt { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 1px solid #3a4150; border-radius: 4px; background: #0b0d12; cursor: pointer; }
#mixdown-dlg label.md-opt:has(input:checked) { border-color: #4a86d6; background: #17304a; }
#mixdown-dlg input[type=number] { width: 80px; background: #0b0d12; color: #e6e9ef; border: 1px solid #3a4150; border-radius: 4px; padding: 4px 6px; }
#mixdown-dlg .md-note { color: #8a93a6; font-size: 11.5px; line-height: 1.5; }
#mixdown-dlg .md-foot { display: flex; gap: 8px; justify-content: flex-end; }
#mixdown-dlg button { background: #1b2740; color: #f2f4f8; border: 1px solid #2a5a9e; border-radius: 4px; padding: 6px 14px; font: inherit; cursor: pointer; }
#mixdown-dlg button:hover { border-color: #4a86d6; }
#mixdown-dlg button.md-go { background: #2a5a9e; }
`

const BITS: { value: 16 | 24 | 32; label: string }[] = [
  { value: 24, label: '24-bit' },
  { value: 32, label: '32-bit float' },
  { value: 16, label: '16-bit（ディザ付き）' }
]
const RATES: { value: number; label: string }[] = [
  { value: 0, label: 'プロジェクトと同じ' },
  { value: 44100, label: '44.1 kHz' },
  { value: 48000, label: '48 kHz' },
  { value: 88200, label: '88.2 kHz' },
  { value: 96000, label: '96 kHz' }
]

/** Ask for the format. Resolves with the choice, or null when cancelled. */
export function askMixdownFormat(defaults: StemExportSettings, projectRate: number): Promise<MixdownChoice | null> {
  if (!document.getElementById('mixdown-dlg-style')) {
    const st = document.createElement('style')
    st.id = 'mixdown-dlg-style'
    st.textContent = CSS
    document.head.appendChild(st)
  }
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.id = 'mixdown-dlg'
    const card = document.createElement('div')
    card.className = 'md-card'
    const title = document.createElement('h4')
    title.textContent = 'Mixdown — 書き出す形式'

    const group = (label: string, name: string, opts: { value: number; label: string }[], cur: number): HTMLElement => {
      const row = document.createElement('div')
      row.className = 'md-row'
      const cap = document.createElement('span')
      cap.textContent = label
      const box = document.createElement('div')
      box.className = 'md-opts'
      for (const o of opts) {
        const lab = document.createElement('label')
        lab.className = 'md-opt'
        const inp = document.createElement('input')
        inp.type = 'radio'
        inp.name = name
        inp.value = String(o.value)
        inp.checked = o.value === cur
        lab.append(inp, o.label)
        box.append(lab)
      }
      row.append(cap, box)
      return row
    }
    const bitsRow = group('ビット深度', 'md-bits', BITS, defaults.bitDepth)
    const rateRow = group('サンプルレート', 'md-rate', RATES, defaults.sampleRate)

    const tailRow = document.createElement('div')
    tailRow.className = 'md-row'
    const tailCap = document.createElement('span')
    tailCap.textContent = '最後のクリップのあとに足す秒数（リバーブ / ディレイの余韻）'
    const tail = document.createElement('input')
    tail.type = 'number'
    tail.min = '0'
    tail.max = '60'
    tail.step = '0.5'
    tail.value = String(defaults.tailSeconds)
    tailRow.append(tailCap, tail)

    const note = document.createElement('div')
    note.className = 'md-note'
    note.textContent = `プロジェクトのレートは ${projectRate / 1000} kHz です。マスターのチェーンとフェーダーを通した、聴こえているとおりのミックスを 1 本の WAV に書き出します。次にファイル名を決めます。`

    const foot = document.createElement('div')
    foot.className = 'md-foot'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'キャンセル'
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'md-go'
    go.textContent = 'ファイル名を決める…'
    foot.append(cancel, go)

    card.append(title, bitsRow, rateRow, tailRow, note, foot)
    root.append(card)
    document.body.append(root)

    const done = (v: MixdownChoice | null): void => {
      window.removeEventListener('keydown', onKey, true)
      root.remove()
      resolve(v)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        done(null)
      } else if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault()
        e.stopPropagation()
        go.click()
      }
    }
    window.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', () => done(null))
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) done(null)
    })
    go.addEventListener('click', () => {
      const pick = (name: string): number => Number((root.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value ?? 0)
      const bd = pick('md-bits')
      const t = Number(tail.value)
      done({
        bitDepth: bd === 16 || bd === 32 ? bd : 24,
        sampleRate: pick('md-rate'),
        tailSeconds: Number.isFinite(t) ? Math.max(0, Math.min(60, t)) : 0
      })
    })
    go.focus()
  })
}
