// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { OptionField, OptionSection, OptionValue } from './options-model'

/**
 * Options → AI: which AI answers the chat window, and what it needs. The chat window and the AI button are
 * unchanged; this is only the connection setting. The values are ordinary Options (`awaker-options.json`,
 * nothing secret). Nothing about any account is built in.
 *
 *   claude-app — the app starts the person's own Claude Code in the background (their login / subscription).
 *   claude-mcp — the person runs Claude Code themselves and connects it to the app's MCP server.
 *   ollama / gemini / openai — an OpenAI-compatible API (Ollama here; Google's OpenAI-compatible Gemini
 *                endpoint; or any other server that speaks the protocol). URL / model are typed in (a preset
 *                address is used when the URL is left empty). The API key is NOT an Option: it is write-only
 *                here, goes to main, and is stored encrypted by the OS keystore (one per connection).
 */

export type AiBackend = 'claude-app' | 'claude-mcp' | 'ollama' | 'gemini' | 'openai'

export interface AiConfig {
  backend: AiBackend
  baseUrl: string
  model: string
  claudePath: string
  claudeModel: string
  numCtx: number
  maxSteps: number
  /** The person's own system prompt for the selected service. Empty = the app's built-in one. */
  systemPrompt: string
}

const BACKENDS: AiBackend[] = ['claude-app', 'claude-mcp', 'ollama', 'gemini', 'openai']
/** The Options values (one URL / model per service, so switching service never carries a name over). */
const OPTION_DEFAULTS: Record<string, OptionValue> = {
  backend: 'claude-app',
  claudePath: '',
  claudeModel: '',
  ollamaUrl: '',
  ollamaModel: '',
  geminiModel: 'gemini-3.5-flash-lite',
  openaiUrl: '',
  openaiModel: '',
  numCtx: 8192,
  maxSteps: 40,
  // one system prompt per service (empty = the built-in one); switching service never carries a prompt over
  promptClaudeApp: '',
  promptOllama: '',
  promptGemini: '',
  promptOpenai: ''
}
const DEFAULTS: AiConfig = { backend: 'claude-app', baseUrl: '', model: '', claudePath: '', claudeModel: '', numCtx: 8192, maxSteps: 40, systemPrompt: '' }

/** The Options key that holds the system prompt of a service (claude-mcp has none: the external Claude Code brings its own). */
export const PROMPT_KEY: Partial<Record<AiBackend, string>> = {
  'claude-app': 'promptClaudeApp',
  ollama: 'promptOllama',
  gemini: 'promptGemini',
  openai: 'promptOpenai'
}
export const MAX_SYSTEM_PROMPT = 8000

/** Same table as src/main/ai-core.ts (the renderer cannot import main code). Public addresses, not accounts. */
const PRESET_URL: Partial<Record<AiBackend, string>> = {
  ollama: 'http://localhost:11434/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai'
}
const KEY_BACKENDS: AiBackend[] = ['gemini', 'openai'] // a local Ollama needs none

let current: AiConfig = { ...DEFAULTS }
const listeners = new Set<(c: AiConfig) => void>()

export const getAiConfig = (): AiConfig => current

/** Short "service · model" text for the chat window header. */
export function aiLabel(c: AiConfig): string {
  switch (c.backend) {
    case 'claude-app':
      return `Claude Code · ${c.claudeModel || '既定モデル'}`
    case 'claude-mcp':
      return 'Claude Code（外部 MCP）'
    case 'ollama':
      return `Ollama · ${c.model || '（モデル未設定）'}`
    case 'gemini':
      return `Gemini · ${c.model || '（モデル未設定）'}`
    default:
      return `OpenAI 互換 · ${c.model || '（モデル未設定）'}`
  }
}

/** Called now and on every change (live while Options is open, and at start-up). */
export function onAiConfig(cb: (c: AiConfig) => void): void {
  listeners.add(cb)
  cb(current)
}

/** The Options values → the single connection main uses: URL / model of the selected service only. */
export function resolveAiConfig(v: Record<string, OptionValue>): AiConfig {
  const b = BACKENDS.find((x) => x === v['backend']) ?? DEFAULTS.backend
  const t = (k: string): string => String(v[k] ?? '')
  return {
    backend: b,
    baseUrl: b === 'ollama' ? t('ollamaUrl') : b === 'openai' ? t('openaiUrl') : '',
    model: b === 'ollama' ? t('ollamaModel') : b === 'gemini' ? t('geminiModel') : b === 'openai' ? t('openaiModel') : '',
    claudePath: t('claudePath'),
    claudeModel: t('claudeModel'),
    numCtx: typeof v['numCtx'] === 'number' ? v['numCtx'] : DEFAULTS.numCtx,
    maxSteps: typeof v['maxSteps'] === 'number' ? v['maxSteps'] : DEFAULTS.maxSteps,
    systemPrompt: PROMPT_KEY[b] ? t(PROMPT_KEY[b]!) : ''
  }
}

// ---- the extra panel under the fields (what was found, the key, stop) -----------------------

const CSS = `
#options .ai-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); font-size: 12px; }
#options .ai-panel .ai-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#options .ai-panel input[type=password] { flex: 1; min-width: 160px; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 3px 8px; }
#options .ai-panel .ai-note { color: var(--dim); }
#options .ai-panel .ai-warn { color: #ffb454; }
#options .ai-panel .ai-ok { color: #4cc38a; }
#options .ai-panel .ai-err { color: #ff6b6b; }
#options .ai-panel code { background: #0b0d12; border: 1px solid var(--line); border-radius: 3px; padding: 1px 5px; user-select: all; word-break: break-all; }
`

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

let panel: HTMLElement | null = null
let updatePanel: (c: AiConfig) => void = () => {}

function buildPanel(): HTMLElement {
  if (!document.getElementById('ai-options-style')) {
    const st = document.createElement('style')
    st.id = 'ai-options-style'
    st.textContent = CSS
    document.head.appendChild(st)
  }
  const root = el('div', 'ai-panel')
  const info = el('div', 'ai-note')
  const keyBox = el('div')
  keyBox.style.cssText = 'display:flex;flex-direction:column;gap:6px'
  const keyRow = el('div', 'ai-row')
  const keyIn = el('input')
  keyIn.type = 'password'
  keyIn.autocomplete = 'off'
  keyIn.placeholder = 'API キー（保存したら画面には出ません）'
  const keySave = el('button', undefined, 'キーを保存')
  keySave.type = 'button'
  const keyDel = el('button', undefined, '保存したキーを削除')
  keyDel.type = 'button'
  keyRow.append(keyIn, keySave, keyDel)
  const keyState = el('div', 'ai-note')
  const warn = el('div', 'ai-warn')
  keyBox.append(keyRow, keyState, warn)
  const modelsRow = el('div', 'ai-row')
  const promptRow = el('div', 'ai-row')
  const promptLoad = el('button', undefined, '既定の文面を入力欄に読み込む')
  promptLoad.type = 'button'
  const promptNote = el('span', 'ai-note')
  promptRow.append(promptLoad, promptNote)
  const stopRow = el('div', 'ai-row')
  const stop = el('button', undefined, '実行中の AI を中断')
  stop.type = 'button'
  const reset = el('button', undefined, '会話をリセット')
  reset.type = 'button'
  stopRow.append(stop, reset)
  const logNote = el('div', 'ai-note')
  root.append(info, modelsRow, keyBox, promptRow, stopRow, logNote)

  let busy = false
  stop.disabled = true
  window.daw.onAiBusy((b) => {
    busy = b
    stop.disabled = !b
  })
  stop.addEventListener('click', () => {
    if (busy) void window.daw.aiAbort()
  })
  reset.addEventListener('click', () => void window.daw.aiReset())
  promptLoad.addEventListener('click', () => {
    const key = PROMPT_KEY[current.backend]
    if (!key) return
    void window.daw.aiGet(current.backend, current.claudePath).then((s) => {
      const ta = document.querySelector<HTMLTextAreaElement>(`#options textarea[name="ai.${key}"]`)
      if (!ta || !s.defaultPrompt) return
      ta.value = s.defaultPrompt
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
  })

  let seq = 0
  const show = (cls: string, text: string, to: HTMLElement): void => {
    to.className = cls
    to.textContent = text
  }
  const refreshKey = async (c: AiConfig): Promise<void> => {
    const s = await window.daw.aiGet(c.backend, c.claudePath)
    keyIn.disabled = !s.canStoreKey
    keyDel.style.display = s.keyState === 'saved' ? '' : 'none'
    const need = c.backend === 'gemini' ? '（Gemini には必須）' : '（ローカルのサーバーなど、キー不要なら空のままで可）'
    show(
      'ai-note',
      s.keyState === 'env'
        ? `API キー: 環境変数 ${s.envVar} を使用中`
        : s.keyState === 'saved'
          ? 'API キー: 保存済み（OS の鍵保管で暗号化。この接続先だけに使います）'
          : s.canStoreKey
            ? `API キー: 未設定${need}`
            : `API キー: 未設定（この環境では暗号化保存できません。環境変数 ${s.envVar} を使ってください）`,
      keyState
    )
  }
  const showModels = async (c: AiConfig): Promise<void> => {
    modelsRow.replaceChildren()
    if (c.backend !== 'ollama') return
    const r = await window.daw.aiOllamaModels(c.baseUrl)
    if (current.backend !== 'ollama') return
    if (!r.ok) {
      modelsRow.append(el('span', 'ai-err', `Ollama に接続できません（${r.error}）。起動しているか、URL を確認してください`))
      return
    }
    modelsRow.append(el('span', 'ai-note', 'インストール済み（クリックで入力）:'))
    for (const m of r.models) {
      const b = el('button', undefined, `${m.name}  ${m.sizeGB} GB`)
      b.type = 'button'
      b.addEventListener('click', () => {
        const inp = document.querySelector<HTMLInputElement>('#options input[name="ai.ollamaModel"]')
        if (!inp) return
        inp.value = m.name
        inp.dispatchEvent(new Event('input', { bubbles: true }))
      })
      modelsRow.append(b)
    }
    if (!r.models.length) modelsRow.append(el('span', 'ai-warn', 'モデルが入っていません（ollama pull <モデル名>）'))
  }
  updatePanel = (c) => {
    void showModels(c)
    const hasPrompt = !!PROMPT_KEY[c.backend]
    promptRow.style.display = hasPrompt ? '' : 'none'
    promptNote.textContent = c.systemPrompt
      ? 'この接続先は、あなたのシステムプロンプトで動いています（空欄に戻すと既定に戻ります）'
      : '空欄の間はアプリの既定のプロンプトを使います'
    const needsKey = KEY_BACKENDS.includes(c.backend)
    keyBox.style.display = needsKey ? 'flex' : 'none'
    const remote = c.backend === 'gemini' || (c.backend === 'openai' && !/^https?:\/\/(localhost|127\.|192\.168\.|10\.)/i.test(c.baseUrl))
    warn.textContent = remote
      ? '送信されるもの: 会話の文面と、プロジェクトの内容（トラック名・設定値・測定結果）が、この接続先のサーバーへ送られます。音声データは送りません。'
      : ''
    const mine = ++seq
    void window.daw.aiGet(c.backend, c.claudePath).then((s) => {
      if (mine !== seq) return
      logNote.textContent = `操作ログ: ${s.logPath}（1 MB ごとに世代交代・5 世代。AI も ops_log ツールで読み返せます）。スキル（AI への詳しい手順書）: アプリ同梱のものに加えて、${s.skillsDir} に <名前>/SKILL.md を置くと、同じ名前のものはあなたのものが優先されます。AI は skills_list / skill_get で読みます`
      if (c.backend === 'claude-app') {
        show(
          s.claudeFound ? 'ai-ok' : 'ai-err',
          s.claudeFound
            ? `Claude Code: ${s.claudeFound} を使います（ログインはその Claude Code のあなたのアカウント。アプリは何も保存しません）`
            : 'Claude Code が見つかりません。インストールするか、上の「Claude Code のパス」に claude の実行ファイルを指定してください',
          info
        )
      } else if (c.backend === 'claude-mcp') {
        info.className = 'ai-note'
        info.replaceChildren(
          'アプリ側の準備: ',
          el('code', undefined, 'npm run dev:mcp'),
          ' で起動 → 自分の Claude Code で ',
          el('code', undefined, 'claude mcp add --transport http awaker http://127.0.0.1:7777/mcp'),
          '。チャット欄の文字は、その Claude Code が chat_read で読みます。'
        )
      } else if (c.backend === 'ollama') {
        show('ai-note', `Ollama: ${c.baseUrl || PRESET_URL.ollama} に接続します。モデル名は ollama list に出るもの。ツール対応（ollama show で capabilities に tools）の 7B 前後・q4 が目安。コンテキスト長は下の設定でアプリから指定します。Awaker と同じ GPU で動かすと VRAM を取り合うので、GPU に余裕があるか別マシンの Ollama 向けです（同居なら Gemini などのクラウドが無難）。ツール非対応のモデルはプロンプトで代用します。`, info)
      } else if (c.backend === 'gemini') {
        show('ai-note', `Gemini: ${c.baseUrl || PRESET_URL.gemini} に接続します（OpenAI 互換のエンドポイント）。モデル名の例: gemini-3.5-flash-lite`, info)
      } else {
        show('ai-note', 'OpenAI 互換のサーバー（LM Studio / llama.cpp / vLLM / OpenRouter / 自前など）の URL とモデル名を入力します。インターネット上は https のみ、localhost / LAN は http 可。', info)
      }
    })
    if (needsKey) void refreshKey(c)
  }
  const setKey = async (k: string, done: string): Promise<void> => {
    const r = await window.daw.aiSetKey(current.backend, k)
    if (!r.ok) return show('ai-err', r.error, keyState)
    keyIn.value = ''
    await refreshKey(current)
    keyState.textContent += `  — ${done}`
  }
  keySave.addEventListener('click', () => {
    if (keyIn.value.trim()) void setKey(keyIn.value, '保存しました')
  })
  keyDel.addEventListener('click', () => void setKey('', '削除しました'))
  return root
}

export const aiOptions: OptionSection = {
  id: 'ai',
  title: 'AI',
  description:
    'チャット窓（右上の AI ボタン）に答える AI の接続設定です。アカウント情報はこのアプリに含まれません — Claude Code は自分のログイン、それ以外は自分で入れる URL / キーを使います。',
  fields: [
    {
      key: 'backend',
      type: 'choice',
      label: '接続先',
      choices: [
        { value: 'claude-app', label: 'Claude Code（アプリ内で起動）' },
        { value: 'claude-mcp', label: 'Claude Code（外部から MCP 接続）' },
        { value: 'ollama', label: 'Ollama（ローカル）' },
        { value: 'gemini', label: 'Gemini' },
        { value: 'openai', label: 'OpenAI 互換（その他・自前）' }
      ]
    },
    {
      key: 'claudePath',
      type: 'text',
      showWhen: { key: 'backend', in: ['claude-app'] },
      label: 'Claude Code のパス',
      hint: '空欄 = 自動で探す',
      placeholder: 'C:\\…\\claude.exe',
      maxLength: 400
    },
    {
      key: 'claudeModel',
      type: 'text',
      showWhen: { key: 'backend', in: ['claude-app'] },
      label: 'Claude のモデル',
      hint: '空欄 = Claude Code の既定（例: sonnet / opus）',
      maxLength: 80
    },
    {
      key: 'ollamaUrl',
      type: 'text',
      showWhen: { key: 'backend', in: ['ollama'] },
      label: '接続先 URL',
      hint: '空欄 = http://localhost:11434（別ホストの Ollama ならここ）',
      maxLength: 300
    },
    {
      key: 'ollamaModel',
      type: 'text',
      showWhen: { key: 'backend', in: ['ollama'] },
      label: 'モデル名',
      hint: '下の「インストール済み」から選べます。ツール対応のもの',
      maxLength: 120
    },
    {
      key: 'geminiModel',
      type: 'text',
      showWhen: { key: 'backend', in: ['gemini'] },
      label: 'モデル名',
      hint: 'Google のモデル名（例: gemini-3.5-flash-lite）',
      maxLength: 120
    },
    {
      key: 'openaiUrl',
      type: 'text',
      showWhen: { key: 'backend', in: ['openai'] },
      label: '接続先 URL',
      hint: '必須（例: https://…/v1）。localhost / LAN は http 可',
      maxLength: 300
    },
    {
      key: 'openaiModel',
      type: 'text',
      showWhen: { key: 'backend', in: ['openai'] },
      label: 'モデル名',
      hint: '必須',
      maxLength: 120
    },
    ...(
      [
        ['promptClaudeApp', 'claude-app', 'Claude Code'],
        ['promptOllama', 'ollama', 'Ollama'],
        ['promptGemini', 'gemini', 'Gemini'],
        ['promptOpenai', 'openai', 'OpenAI 互換']
      ] as const
    ).map(
      ([key, backend, name]): OptionField => ({
        key,
        type: 'text',
        multiline: true,
        rows: 9,
        showWhen: { key: 'backend', in: [backend] },
        label: `システムプロンプト（${name}）`,
        hint: `空欄 = アプリの既定。入れると、この接続先ではこの文面が既定の代わりに使われます（上限 ${MAX_SYSTEM_PROMPT} 文字）。下の「既定の文面を入力欄に読み込む」で既定から編集できます`,
        placeholder: '（空欄 = アプリの既定のプロンプト）',
        maxLength: MAX_SYSTEM_PROMPT
      })
    ),
    {
      key: 'maxSteps',
      type: 'number',
      showWhen: { key: 'backend', in: ['ollama', 'gemini', 'openai'] },
      label: '最大ステップ数',
      hint: '1 回の質問で AI がツールを呼べる回数（動きをつけるときは 1 フレームが 1 ステップ）',
      min: 4,
      max: 200,
      step: 1,
      unit: '回'
    },
    {
      key: 'numCtx',
      type: 'number',
      showWhen: { key: 'backend', in: ['ollama'] },
      label: 'コンテキスト長',
      hint: '小さいほど VRAM を使わない。ツール定義だけで約 3000 トークン。Awaker と同居なら 8192 が目安',
      min: 2048,
      max: 32768,
      step: 1024,
      unit: 'tokens'
    }
  ],
  box: { height: 460 },
  defaults: { ...OPTION_DEFAULTS },
  apply(values) {
    current = resolveAiConfig(values)
    for (const cb of listeners) cb(current)
  },
  preview(host, values) {
    panel ??= buildPanel()
    host.replaceChildren(panel)
    updatePanel(resolveAiConfig(values))
  }
}
