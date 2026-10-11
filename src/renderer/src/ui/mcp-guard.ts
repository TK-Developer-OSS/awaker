// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * While the built-in MCP server is driving the app, show a red glowing "MCP" indicator and put a translucent
 * grey mask over the whole window so a human can't click or type into a run that is in progress.
 * Only exists in MCP mode (created by the first `onMcpCall` registration). The mask stays up for a short
 * linger after the last call, so a script that fires calls back to back doesn't make it flicker.
 */

import { aiLabel, getAiConfig, onAiConfig } from './ai-options'
import { initAiMix } from './ai-mix'

const LINGER_MS = 4000

const CSS = `
#mcp-ind {
  cursor: pointer;
  position: relative; z-index: 2001; flex: none; display: inline-flex; align-items: center; gap: 6px;
  font: 700 12px/1.4 system-ui, sans-serif; letter-spacing: 0.08em; color: #8a93a6; user-select: none;
}
#mcp-ind i { width: 10px; height: 10px; border-radius: 50%; background: #4a1c1c; border: 1px solid #8a3a3a; }
#mcp-ind.on { color: #ff4d4d; text-shadow: 0 0 6px #ff4d4d; }
#mcp-ind.on i { background: #ff4d4d; border-color: #ff4d4d; box-shadow: 0 0 8px #ff4d4d; }
#mcp-mask {
  position: fixed; inset: 0; z-index: 2000; background: rgba(30, 34, 42, 0.68); cursor: not-allowed;
  opacity: 0; pointer-events: none; transition: opacity 110ms ease-out; /* quick fade: a hard flash is tiring */
}
#mcp-mask.show { opacity: 1; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) { #mcp-mask { transition: none; } }
/* a quick glowing frame over whatever MCP just touched; sits above the mask so it shows through it */
.mcp-flash {
  position: fixed; z-index: 2001; box-sizing: border-box; pointer-events: none; border-radius: 4px;
  border: 2px solid #2a5a9e; background: rgba(70, 140, 235, 0.2); box-shadow: 0 0 16px 3px rgba(70, 140, 235, 0.8);
  animation: mcp-flash 750ms ease-out forwards;
}
@keyframes mcp-flash { 0% { opacity: 1; } 55% { opacity: 0.9; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .mcp-flash { animation-duration: 1ms; animation-delay: 400ms; } }
#mcp-log {
  position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); z-index: 2002;
  width: min(760px, 92vw); background: rgba(14, 16, 22, 0.96); border: 1px solid #2a5a9e; border-radius: 8px;
  box-shadow: 0 0 24px rgba(70, 140, 235, 0.5); color: #f2f4f8; font: 12px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
  user-select: none;
}
#mcp-log[hidden] { display: none; }
#mcp-log .ml-head { display: flex; justify-content: space-between; align-items: center; padding: 7px 12px; border-bottom: 1px solid #1f2c44; color: #f2f4f8; font-weight: 700; letter-spacing: 0.06em; }
#mcp-log .ml-close { background: transparent; border: 0; color: #f2f4f8; font: 16px/1 system-ui, sans-serif; cursor: pointer; padding: 0 2px; }
#mcp-log .ml-close:hover { color: #fff; }
#mcp-log .ml-svc { margin-left: auto; margin-right: 12px; color: #aab2c0; font-weight: 400; letter-spacing: 0; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#mcp-log .ml-body { min-height: calc(10 * 1.5em + 9px); box-sizing: content-box; padding: 6px 12px 8px; display: flex; flex-direction: column; gap: 1px; }
#mcp-log .ml-row { display: flex; gap: 10px; white-space: nowrap; overflow: hidden; }
#mcp-log .ml-st { flex: none; width: 14px; color: #ffb454; }
#mcp-log .ml-row.ok .ml-st { color: #4cc38a; }
#mcp-log .ml-row.err .ml-st { color: #ff6b6b; }
#mcp-log .ml-tool { flex: none; color: #ffffff; min-width: 150px; }
#mcp-log .ml-args { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #d4d9e2; }
#mcp-log .ml-chat { border-top: 1px solid #1f2c44; padding: 6px 12px; display: flex; flex-direction: column; gap: 3px; max-height: 150px; overflow-y: auto; user-select: text; }
#mcp-log .ml-chat:empty { display: none; }
#mcp-log .ml-msg { max-width: 82%; padding: 3px 9px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; font-family: system-ui, "Yu Gothic UI", sans-serif; font-size: 12.5px; }
#mcp-log .ml-msg.ai { align-self: flex-start; background: #1b2740; color: #f2f4f8; }
#mcp-log .ml-msg.you { align-self: flex-end; background: #2b2f38; color: #f2f4f8; }
#mcp-log .ml-input { display: flex; gap: 6px; padding: 7px 12px; border-top: 1px solid #1f2c44; }
#mcp-log .ml-input input { flex: 1; min-width: 0; background: #0b0d12; color: #e6e9ef; border: 1px solid #3a4150; border-radius: 4px; padding: 5px 8px; font: 12.5px system-ui, "Yu Gothic UI", sans-serif; }
#mcp-log .ml-input input:focus { outline: none; border-color: #b8731f; box-shadow: 0 0 0 1px #b8731f; }
#mcp-log .ml-input button { background: #1b2740; color: #f2f4f8; border: 1px solid #2a5a9e; border-radius: 4px; padding: 4px 14px; font: 12px system-ui, sans-serif; cursor: pointer; }
#mcp-log .ml-input button:hover { border-color: #4a86d6; }
#mcp-log .ml-ms { flex: none; width: 70px; text-align: right; color: #aab2c0; }
`

export interface LogRow {
  el: HTMLElement
  t0: number
}

const MAX_ROWS = 14

/** One-line summary of a tool's arguments (long values like a whole project are cut). */
function briefArgs(args: unknown): string {
  let s = ''
  try {
    s = JSON.stringify(args) ?? ''
  } catch {
    s = String(args)
  }
  return s === '{}' ? '' : s.length > 160 ? `${s.slice(0, 160)}…` : s
}

export interface McpGuard {
  /** A tool call started; returns the handle for `leave`. */
  enter(tool: string, args: unknown): LogRow
  /** A tool call finished (the mask and log stay for the linger time). */
  leave(row: LogRow, ok: boolean, note?: string): void
  /** Flash a glowing frame over these elements (what a tool call just touched). */
  flash(els: Iterable<HTMLElement | null | undefined>): void
  /** Claude writes a line into the chat. */
  say(text: string): void
  /** Test hook: the last chat lines, oldest first. */
  history(limit: number): { who: 'ai' | 'you'; text: string }[]
  /** Test hook: type a line into the chat and press Enter, as the person would. */
  type(text: string): void
  /** Send a request to the AI as if typed; the chat shows `shown` (default: the text itself). */
  send(text: string, shown?: string): void
  /** The human's queued chat lines; waits up to `waitMs` for one if none are queued. */
  take(waitMs: number): Promise<string[]>
}

/** The MCP lamp, created once and always shown (dark when MCP is off or idle). */
export function ensureMcpLamp(): HTMLElement {
  const have = document.getElementById('mcp-ind')
  if (have) return have
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  const ind = document.createElement('div')
  ind.id = 'mcp-ind'
  ind.append(document.createElement('i'), 'MCP')
  ind.title = 'MCP is off (start with npm run dev:mcp)'
  // in the top bar's normal flow, right next to the GPU lamp, so it never covers anything
  const gpu = document.getElementById('gpu-lamp')
  if (gpu) gpu.before(ind)
  else document.body.append(ind)
  return ind
}

export function initMcpGuard(): McpGuard {
  const ind = ensureMcpLamp()
  ind.title = 'MCP server is running. Click to open / close the log and chat'
  const mask = document.createElement('div')
  mask.id = 'mcp-mask'
  document.body.append(mask)
  const log = document.createElement('div')
  log.id = 'mcp-log'
  log.hidden = true
  const head = document.createElement('div')
  head.className = 'ml-head'
  const headText = document.createElement('span')
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'ml-close'
  closeBtn.textContent = '×'
  closeBtn.title = 'Close (the MCP lamp opens it again)'
  closeBtn.setAttribute('aria-label', 'Close the MCP log')
  const svc = document.createElement('span')
  svc.className = 'ml-svc'
  svc.title = 'Options → AI で変更'
  onAiConfig((c) => {
    svc.textContent = aiLabel(c)
  })
  head.append(headText, svc, closeBtn)
  const body = document.createElement('div')
  body.className = 'ml-body'
  const chat = document.createElement('div')
  chat.className = 'ml-chat'
  const inputRow = document.createElement('form')
  inputRow.className = 'ml-input'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'AI へのメッセージ（Enter で送信）'
  input.setAttribute('aria-label', 'Message to the AI')
  const send = document.createElement('button')
  send.type = 'submit'
  send.textContent = '送信'
  inputRow.append(input, send)
  log.append(head, body, chat, inputRow)
  document.body.append(log)

  // ---- chat: Claude writes with `say`, reads the human's lines with `take`
  const lines: { who: 'ai' | 'you'; text: string }[] = []
  const addMsg = (who: 'ai' | 'you', text: string): void => {
    lines.push({ who, text })
    if (lines.length > 200) lines.shift()
    const m = document.createElement('div')
    m.className = `ml-msg ${who}`
    m.textContent = text
    chat.append(m)
    while (chat.childElementCount > 40) chat.firstElementChild?.remove()
    chat.scrollTop = chat.scrollHeight
  }
  const queue: string[] = []
  let wake: (() => void) | null = null
  // Options → AI picks who answers: an external Claude Code (reads the queue via chat_read), or the agent
  // the app starts itself (Claude Code / an OpenAI-compatible API), which answers through main.
  const sendLine = (text: string, shown?: string): void => {
    addMsg('you', shown ?? text)
    if (getAiConfig().backend === 'claude-mcp') {
      queue.push(text)
      wake?.()
    } else {
      void window.daw.aiSend(text, getAiConfig())
    }
  }
  inputRow.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    sendLine(text)
  })
  window.daw.onAiSay((t) => addMsg('ai', t))

  const aiBtn = document.getElementById('ai-btn')
  // the connection URL, right of the AI button; click copies it
  void window.daw.mcpUrl?.().then((url) => {
    if (!url || !aiBtn) return
    const u = document.createElement('span')
    u.id = 'mcp-url'
    u.textContent = url
    u.title = 'MCP server URL (click to copy)'
    u.addEventListener('click', () => void navigator.clipboard?.writeText(url).catch(() => undefined))
    aiBtn.after(u)
  })
  aiBtn?.classList.remove('off')
  if (aiBtn) aiBtn.title = 'AI log / chat'
  let pinned = false // the log / chat window stays open after MCP goes quiet, until the person closes it

  let inflight = 0
  let timer = 0
  let active = false
  const refresh = (): void => {
    mask.classList.toggle('show', active)
    log.hidden = !(active || pinned)
    aiBtn?.setAttribute('aria-pressed', String(!log.hidden))
    headText.textContent = active ? '● MCP が操作中 — 画面はロックされています' : '○ MCP ログ / チャット（待機中）'
    ind.classList.toggle('on', active)
  }
  const set = (on: boolean): void => {
    active = on
    if (on) pinned = true // first activity opens the window; it then stays
    refresh()
  }
  closeBtn.addEventListener('click', () => {
    pinned = false
    refresh()
  })
  // the AI button (far right of the transport bar) and the MCP lamp both open / close the log + chat on their own
  const toggleWindow = (): void => {
    pinned = !log.hidden ? false : true
    refresh()
    if (!log.hidden) input.focus()
  }
  ind.addEventListener('click', toggleWindow)
  aiBtn?.addEventListener('click', toggleWindow)
  // AI Mix (right end of the AI buttons): genre / reference dialog; its request goes through the same chat path
  const mixBtn = document.getElementById('ai-mix-btn')
  if (mixBtn) {
    mixBtn.classList.remove('off')
    mixBtn.title = 'AI Mix — match the average spectrum of the song to a genre or a reference song'
    initAiMix(mixBtn, {
      send: (prompt, shown) => {
        pinned = true
        refresh()
        sendLine(prompt, shown)
      }
    })
  }
  // The mask eats the pointer; this keeps the keyboard out too (Space = play, Delete, shortcuts…).
  const eat = (e: Event): void => {
    if (!active) return
    if ((e.target as HTMLElement | null)?.closest?.('#mcp-log')) return // the chat box stays usable
    e.preventDefault()
    e.stopPropagation()
  }
  for (const t of ['keydown', 'keyup', 'keypress']) window.addEventListener(t, eat, true)
  for (const t of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'wheel']) mask.addEventListener(t, eat)

  return {
    flash(els) {
      for (const el of els) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
        const f = document.createElement('div')
        f.className = 'mcp-flash'
        f.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`
        f.addEventListener('animationend', () => f.remove())
        document.body.append(f)
        window.setTimeout(() => f.remove(), 1200) // safety net if animations are off
      }
    },
    say(text) {
      addMsg('ai', text)
    },
    history(limit) {
      return lines.slice(-Math.max(1, limit))
    },
    type(text) {
      input.value = text
      inputRow.requestSubmit()
    },
    send(text, shown) {
      sendLine(text, shown)
    },
    async take(waitMs) {
      if (!queue.length && waitMs > 0) {
        await new Promise<void>((res) => {
          const t = window.setTimeout(res, waitMs)
          wake = () => {
            window.clearTimeout(t)
            res()
          }
        })
        wake = null
        // let a human finish a quick burst of lines
        if (queue.length) await new Promise((r) => window.setTimeout(r, 400))
      }
      return queue.splice(0, queue.length)
    },
    enter(tool, args) {
      inflight++
      window.clearTimeout(timer)
      set(true)
      const el = document.createElement('div')
      el.className = 'ml-row'
      for (const [cls, text] of [['ml-st', '▶'], ['ml-tool', tool], ['ml-args', briefArgs(args)], ['ml-ms', '']] as const) {
        const c = document.createElement('span')
        c.className = cls
        c.textContent = text
        el.append(c)
      }
      body.append(el)
      while (body.childElementCount > MAX_ROWS) body.firstElementChild?.remove()
      return { el, t0: performance.now() }
    },
    leave(row, ok, note) {
      row.el.classList.add(ok ? 'ok' : 'err')
      row.el.querySelector('.ml-st')!.textContent = ok ? '✓' : '✗'
      const ms = Math.round(performance.now() - row.t0)
      row.el.querySelector('.ml-ms')!.textContent = `${ms} ms`
      if (!ok && note) row.el.querySelector('.ml-args')!.textContent = note
      inflight = Math.max(0, inflight - 1)
      if (inflight > 0) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => set(false), LINGER_MS)
    }
  }
}
