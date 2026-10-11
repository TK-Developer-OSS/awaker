// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { GENRES, longTermSpectrumPlanar } from '../audio/spectrum'
import { getMixTarget, setMixGenre, setMixReference } from '../audio/mix-target'
import { buildMixPrompt, mixShownLine } from '../audio/mix-prompt'
import { decodeWav } from '../wav'

/**
 * The AI Mix button's dialog: pick the genre (or a reference song) and start. The target is set here; the request
 * goes to whichever AI is selected in Options → AI, which measures with spectrum_analyze and corrects with
 * eq_apply (see audio/mix-prompt.ts for the instructions).
 */

const CSS = `
#ai-mix { position: fixed; z-index: 2050; width: 340px; padding: 12px 14px; display: flex; flex-direction: column; gap: 9px;
  background: #161a22; border: 1px solid #2a5a9e; border-radius: 8px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6); color: #e6e9ef;
  font: 12.5px system-ui, "Yu Gothic UI", sans-serif; }
#ai-mix[hidden] { display: none; }
#ai-mix h4 { margin: 0; font-size: 13px; letter-spacing: 0.04em; }
#ai-mix label { display: flex; flex-direction: column; gap: 3px; color: #aab2c0; }
#ai-mix select { background: #0b0d12; color: #e6e9ef; border: 1px solid #3a4150; border-radius: 4px; padding: 4px 6px; font: inherit; }
#ai-mix .am-ref { display: flex; align-items: center; gap: 8px; }
#ai-mix .am-ref span { color: #aab2c0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#ai-mix .am-check { flex-direction: row; align-items: center; gap: 6px; }
#ai-mix .am-check input[type=number] { width: 64px; background: #0b0d12; color: #e6e9ef; border: 1px solid #3a4150; border-radius: 4px; padding: 3px 6px; }
#ai-mix .am-note { color: #8a93a6; font-size: 11.5px; line-height: 1.5; }
#ai-mix .am-err { color: #ff6b6b; }
#ai-mix .am-row { display: flex; gap: 8px; justify-content: flex-end; }
#ai-mix button { background: #1b2740; color: #f2f4f8; border: 1px solid #2a5a9e; border-radius: 4px; padding: 5px 14px; font: inherit; cursor: pointer; }
#ai-mix button:hover:not(:disabled) { border-color: #4a86d6; }
#ai-mix button:disabled { opacity: 0.45; cursor: default; }
#ai-mix button.am-go { background: #2a5a9e; }
`

const REF = '__ref__'
const STORE = 'awaker.aimix.genre'
const STORE_LUFS = 'awaker.aimix.lufs' // '' = do not land the loudness, else the target in LUFS

export interface AiMixIo {
  /** Send `prompt` to the AI; `shown` is what the chat window displays for it. */
  send(prompt: string, shown: string): void
}

export function initAiMix(btn: HTMLElement, io: AiMixIo): void {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const box = document.createElement('div')
  box.id = 'ai-mix'
  box.hidden = true
  const title = document.createElement('h4')
  title.textContent = 'AI ミックス — 曲全体の平均スペクトルを目標に合わせる'

  const genreLab = document.createElement('label')
  genreLab.append('ジャンル（目標とする帯域バランス）')
  const sel = document.createElement('select')
  for (const g of GENRES) sel.append(new Option(g.label, g.id))
  sel.append(new Option('リファレンス曲（WAV）の平均スペクトルに合わせる', REF))
  genreLab.append(sel)

  const refRow = document.createElement('div')
  refRow.className = 'am-ref'
  const pick = document.createElement('button')
  pick.type = 'button'
  pick.textContent = '曲を選ぶ…'
  const refName = document.createElement('span')
  refRow.append(pick, refName)

  const measLab = document.createElement('label')
  measLab.className = 'am-check'
  const meas = document.createElement('input')
  meas.type = 'checkbox'
  measLab.append(meas, '測定だけ（何も変更せず、結果と対策案を説明）')

  // the last step: land the master at a loudness (the master fader is searched for; 1 = on)
  const lufsLab = document.createElement('label')
  lufsLab.className = 'am-check'
  const lufsOn = document.createElement('input')
  lufsOn.type = 'checkbox'
  lufsOn.checked = true
  const lufsNum = document.createElement('input')
  lufsNum.type = 'number'
  lufsNum.min = '-30'
  lufsNum.max = '-6'
  lufsNum.step = '0.5'
  lufsNum.value = '-14'
  lufsLab.append(lufsOn, '最後に、マスターを ', lufsNum, ' LUFS に着地させる')
  const readLufs = (): number | null => {
    if (!lufsOn.checked) return null
    const v = Number(lufsNum.value)
    return Number.isFinite(v) ? Math.max(-30, Math.min(-6, v)) : -14
  }

  const note = document.createElement('div')
  note.className = 'am-note'
  note.textContent =
    '曲全体を書き出して平均スペクトルを測り、目標との差が大きい帯域をグループ / ステム / マスターの EQ（eq5）で直します。測って直すを数回繰り返します。目安のジャンル曲線は典型的な形で、リファレンス曲のほうが正確です。'
  const err = document.createElement('div')
  err.className = 'am-err'

  const row = document.createElement('div')
  row.className = 'am-row'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = '閉じる'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'am-go'
  go.textContent = '開始'
  row.append(cancel, go)
  box.append(title, genreLab, refRow, measLab, lufsLab, note, err, row)
  document.body.append(box)

  let busy = false
  let ref: { name: string; levelDb: number[] } | null = null
  let analysing = false

  const refresh = (): void => {
    const isRef = sel.value === REF
    refRow.style.display = isRef ? '' : 'none'
    go.disabled = busy || analysing || (isRef && !ref)
    go.title = busy ? 'AI が実行中です' : ''
    refName.textContent = analysing ? '解析中…' : ref ? `${ref.name}` : '（未選択）'
  }
  window.daw.onAiBusy((b) => {
    busy = b
    refresh()
  })

  try {
    const sl = localStorage.getItem(STORE_LUFS)
    if (sl !== null) {
      lufsOn.checked = sl !== ''
      if (sl !== '' && Number.isFinite(Number(sl))) lufsNum.value = sl
    }
    const saved = localStorage.getItem(STORE)
    if (saved && [...sel.options].some((o) => o.value === saved && o.value !== REF)) sel.value = saved
  } catch {
    /* storage unavailable: the first genre stays */
  }
  const cur = getMixTarget()
  if (cur?.id.startsWith('genre:')) sel.value = cur.id.slice(6)

  sel.addEventListener('change', () => {
    err.textContent = ''
    refresh()
  })

  pick.addEventListener('click', () => {
    err.textContent = ''
    void (async () => {
      const paths = await window.daw.openAudioFiles()
      if (!paths || !paths.length) return
      analysing = true
      refresh()
      try {
        const f = await window.daw.readAudioFile(paths[0])
        const dec = decodeWav(f.bytes)
        const sp = longTermSpectrumPlanar(dec.channels, dec.sampleRate)
        if (sp.usedFrames === 0) throw new Error('この曲は無音です')
        const name = (paths[0].split(/[\\/]/).pop() ?? 'reference').replace(/\.[^.]+$/, '')
        ref = { name, levelDb: sp.levelDb }
        refName.textContent = name
      } catch (e) {
        ref = null
        err.textContent = `リファレンス曲を解析できません: ${(e as Error).message}（WAV のみ対応）`
      } finally {
        analysing = false
        refresh()
      }
    })()
  })

  const close = (): void => {
    box.hidden = true
  }
  cancel.addEventListener('click', close)
  window.addEventListener(
    'keydown',
    (e) => {
      if (!box.hidden && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    },
    true
  )
  document.addEventListener('pointerdown', (e) => {
    if (!box.hidden && !box.contains(e.target as Node) && e.target !== btn) close()
  })

  /** The request carries the app's `ai-mix` skill (the person's own copy if they made one); inline text if it is missing. */
  const start = async (req: Parameters<typeof buildMixPrompt>[0], shown: string): Promise<void> => {
    let skill: string | undefined
    try {
      const s = await window.daw.skillGet('ai-mix')
      if (s.ok) skill = s.body
    } catch {
      /* no skill: the built-in inline procedure is used */
    }
    io.send(buildMixPrompt(req, skill), shown)
  }

  go.addEventListener('click', () => {
    err.textContent = ''
    const measureOnly = meas.checked
    const targetLufs = readLufs()
    try {
      localStorage.setItem(STORE_LUFS, targetLufs === null ? '' : String(targetLufs))
    } catch {
      /* storage unavailable */
    }
    if (sel.value === REF) {
      if (!ref) return
      const t = setMixReference(ref.name, ref.levelDb)
      void start({ targetName: t.name, fromReference: true, measureOnly, targetLufs }, mixShownLine(t.name, measureOnly, true, targetLufs))
    } else {
      const t = setMixGenre(sel.value)
      if (!t) {
        err.textContent = 'ジャンルを設定できません'
        return
      }
      try {
        localStorage.setItem(STORE, sel.value)
      } catch {
        /* storage unavailable */
      }
      const label = GENRES.find((g) => g.id === sel.value)?.label ?? t.name
      void start({ targetName: t.name, fromReference: false, measureOnly, targetLufs }, mixShownLine(label, measureOnly, false, targetLufs))
    }
    close()
  })

  btn.addEventListener('click', () => {
    if (!box.hidden) return close()
    refresh()
    box.hidden = false
    const r = btn.getBoundingClientRect()
    const w = box.offsetWidth
    const h = box.offsetHeight
    box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`
    box.style.top = `${Math.max(8, r.top - h - 8)}px`
  })
  refresh()
}
