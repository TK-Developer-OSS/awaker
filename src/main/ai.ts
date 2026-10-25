// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { MCP_TOOL_SPECS, callTool, setOpsLogReader, setSkillsReader, setToolHook, startPrivateMcp, type McpDeps, type ToolCallRecord } from './mcp'
import { ensureUserSkillsDir, loadSkills } from './skills-store'
import { findSkill, skillIndex } from './skills'
import { RotatingLog } from './ai-log'
import {
  AI_BLOCKED_TOOLS,
  aiToolSpecs,
  buildClaudeArgs,
  CLAUDE_APP_PROMPT,
  SYSTEM_PROMPT,
  coerceToolArgs,
  diffProject,
  formatChanges,
  compactToolCatalogue,
  effectiveBaseUrl,
  explainApiError,
  isNoToolsError,
  isOutOfMemoryError,
  OLLAMA_GPU_LAYER_STEPS,
  ollamaChatUrl,
  parseOllamaResponse,
  toOllamaMessages,
  toPlainChat,
  withGeminiSignatures,
  extractTextToolCalls,
  clipToolResult,
  isOpenAiKind,
  type AiBackend,
  checkEndpoint,
  claudeMcpConfig,
  completionsUrl,
  isClaudeExecutableName,
  parseClaudeLine,
  parseCompletion,
  redactKey,
  runAgentTurn,
  sanitizeAiConfig,
  toOpenAiTools,
  trimHistory,
  type AiConfig,
  type ChatMessage
} from './ai-core'

/**
 * AI connection, Electron side. See ai-core.ts for the three backends.
 *
 * What is stored where — and what is deliberately NOT anywhere:
 *   - the settings (backend, URL, model, Claude Code path) are ordinary Options (renderer → `awaker-options.json`);
 *     main gets them with each message and keeps nothing.
 *   - an API key (Ollama / Gemini / other OpenAI-compatible; one per connection) is encrypted with the OS keystore
 *     (Electron safeStorage: DPAPI / Keychain / libsecret) into `awaker-ai-key-<connection>.bin` in the user-data folder. If the OS cannot encrypt, the key is NOT stored
 *     (use the AWAKER_AI_API_KEY environment variable) — there is no plaintext fallback. It is never sent to the
 *     renderer: the panel only learns whether one exists (`keyState`).
 *   - no default endpoint, no default key, no account of the developer's in the build.
 *   - the Claude Code backends store nothing: the person's own Claude Code uses its own login (their subscription).
 */

const KEY_FILE = (b: AiBackend): string => `awaker-ai-key-${b}.bin` // one key per connection (Ollama / Gemini / other)
const ENV_KEY = 'AWAKER_AI_API_KEY'
const REQUEST_TIMEOUT_MS = 300_000 // a local model may need to load first
const CLAUDE_TURN_TIMEOUT_MS = 20 * 60_000
const MAX_KEY_LEN = 400

const dir = (): string => app.getPath('userData')
const keyPath = (b: AiBackend): string => join(dir(), KEY_FILE(b))

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dir(), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

type KeyState = 'none' | 'saved' | 'env'

/** The key itself — main only. The environment variable wins over a saved key. */
async function loadKey(backend: AiBackend): Promise<{ key: string; state: KeyState }> {
  const env = process.env[ENV_KEY]?.trim()
  if (env) return { key: env, state: 'env' }
  try {
    const buf = await readFile(keyPath(backend))
    if (safeStorage.isEncryptionAvailable()) return { key: safeStorage.decryptString(buf), state: 'saved' }
  } catch {
    /* no key saved, or it cannot be decrypted (other user / machine) */
  }
  return { key: '', state: 'none' }
}

// ---- finding the person's Claude Code ------------------------------------------------------

const isFile = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * The Claude Code executable: the configured path, else `claude` on PATH, else the usual install places
 * (the native installer's ~/.local/bin, and the binary the VS Code extension ships).
 */
async function findClaude(configured: string): Promise<string | null> {
  if (configured) return isClaudeExecutableName(configured) && (await isFile(configured)) ? configured : null
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const d of (process.env['PATH'] ?? '').split(delimiter)) {
    if (d && (await isFile(join(d, exe)))) return join(d, exe)
  }
  const home = app.getPath('home')
  const local = join(home, '.local', 'bin', exe)
  if (await isFile(local)) return local
  try {
    const extDir = join(home, '.vscode', 'extensions')
    const names = (await readdir(extDir)).filter((n) => n.startsWith('anthropic.claude-code')).sort().reverse()
    for (const n of names) {
      const p = join(extDir, n, 'resources', 'native-binary', exe)
      if (await isFile(p)) return p
    }
  } catch {
    /* no VS Code extensions folder */
  }
  return null
}

// ---- state shared by the backends -----------------------------------------------------------

let busy = false
let abortCtl: AbortController | null = null
const history: ChatMessage[] = [] // openai backend conversation
let claudeSession: string | null = null // claude-app: session id to resume
const gpuLayers = new Map<string, number>() // Ollama: layers that fit on the GPU, learnt from out-of-memory errors
const promptModels = new Set<string>() // models that answered "does not support tools" this session
let privateMcp: { url: string; token: string; close(): void } | null = null

// Tool calls that are only looking (or chatting): counted in a turn but not written to the file log.
const NOISY_TOOLS = new Set(['state_get', 'project_get', 'tracks_list', 'chat_history', 'chat_read', 'logs', 'ui_query', 'wait', 'ops_log', 'screenshot', 'audio_devices', 'audio_inputs', 'return_status', 'live_info', 'instrument_presets', 'mix_target', 'skills_list', 'skill_get'])
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

export function initAi(deps: McpDeps): void {
  // ---- operation log: every executed tool call (any AI) + one summary per question to the built-in assistant
  const opsLog = new RotatingLog(join(dir(), 'logs'), 'ai-ops', 1_000_000, 5)
  let trace: ToolCallRecord[] | null = null
  setToolHook((r) => {
    if (r.origin === 'agent') trace?.push(r) // the turn's own calls only (not another client's, not the app's)
    if (NOISY_TOOLS.has(r.name) && r.ok) return
    let args = ''
    try {
      args = clip(JSON.stringify(r.args), 400)
    } catch {
      /* unprintable */
    }
    if (r.origin === 'internal') return
    void opsLog.append({ type: 'tool', time: new Date(r.t).toISOString(), origin: r.origin, name: r.name, args, ok: r.ok, ms: r.ms, ...(r.error ? { error: r.error } : {}) })
  })
  setOpsLogReader((limit, kind) =>
    opsLog.readRecent(limit, (e) => kind === 'all' || (typeof e === 'object' && e !== null && (e as { type?: unknown }).type === kind))
  )
  setSkillsReader(loadSkills)
  void ensureUserSkillsDir()
  /** The system prompt in force (the person's own, else the built-in one) + the index of the skills. */
  const promptWithSkills = async (own: string, builtIn: string): Promise<string> => (own.trim() || builtIn) + skillIndex(await loadSkills())
  const snapshot = async (): Promise<unknown | null> => {
    try {
      const out = await callTool('project_get', {}, deps, 'internal')
      const t = out.content[0]
      return !out.isError && t && t.type === 'text' ? (JSON.parse(t.text) as unknown) : null
    } catch {
      return null
    }
  }

  const toRenderer = (channel: string, ...a: unknown[]): void => {
    const w: BrowserWindow | null = deps.getWin()
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...a)
  }
  let shownSink: string[] | null = null // the replies of the turn in progress (for the log)
  const say = (t: string): void => {
    shownSink?.push(t)
    toRenderer('daw:ai:say', t)
  }
  const setBusy = (b: boolean): void => {
    busy = b
    toRenderer('daw:ai:busy', b)
  }

  app.on('will-quit', () => privateMcp?.close())

  const asBackend = (v: unknown): AiBackend => sanitizeAiConfig({ backend: v }).backend

  ipcMain.handle('daw:ai:get', async (_e, backend: unknown, claudePath: unknown) => {
    const found = await findClaude(typeof claudePath === 'string' ? claudePath.trim() : '')
    return {
      keyState: (await loadKey(asBackend(backend))).state,
      canStoreKey: safeStorage.isEncryptionAvailable(),
      envVar: ENV_KEY,
      busy,
      claudeFound: found,
      logPath: opsLog.currentPath,
      skillsDir: await ensureUserSkillsDir(),
      // what the app uses when the person's own prompt is empty (shown / loaded into the Options text area)
      defaultPrompt: asBackend(backend) === 'claude-app' ? CLAUDE_APP_PROMPT : asBackend(backend) === 'claude-mcp' ? '' : SYSTEM_PROMPT
    }
  })

  // key: a string to save, '' to delete. Write-only: nothing ever returns the key.
  ipcMain.handle('daw:ai:key', async (_e, backend: unknown, apiKey: unknown) => {
    try {
      if (typeof apiKey !== 'string') return { ok: false as const, error: 'bad request' }
      const b = asBackend(backend)
      if (!isOpenAiKind(b)) return { ok: false as const, error: 'this connection has no API key' }
      const k = apiKey.trim()
      if (k === '') {
        await rm(keyPath(b), { force: true })
        return { ok: true as const }
      }
      if (k.length > MAX_KEY_LEN || /[\r\n]/.test(k)) return { ok: false as const, error: 'API キーの形式が正しくありません' }
      if (!safeStorage.isEncryptionAvailable()) {
        return {
          ok: false as const,
          error: `この環境では OS の暗号化が使えないため、キーは保存しません。環境変数 ${ENV_KEY} に設定してください`
        }
      }
      await atomicWrite(keyPath(b), safeStorage.encryptString(k))
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: String((err as Error).message ?? err) }
    }
  })

  ipcMain.handle('daw:ai:ollamaModels', async (_e, baseUrl: unknown) => {
    try {
      const base = effectiveBaseUrl({ backend: 'ollama', baseUrl: typeof baseUrl === 'string' ? baseUrl.trim() : '' })
      const chk = checkEndpoint(base)
      if (!chk.ok) return { ok: false as const, error: chk.reason }
      const res = await fetch(`${new URL(base).origin}/api/tags`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` }
      const j = (await res.json()) as { models?: { name?: unknown; size?: unknown }[] }
      const models = (j.models ?? [])
        .filter((m) => typeof m.name === 'string')
        .map((m) => ({ name: String(m.name), sizeGB: Math.round((Number(m.size) || 0) / 1e8) / 10 }))
      return { ok: true as const, models }
    } catch (err) {
      return { ok: false as const, error: String((err as Error).message ?? err) }
    }
  })

  // a skill's text, for the renderer (the AI Mix request carries the skill it follows)
  ipcMain.handle('daw:skills:get', async (_e, name: unknown) => {
    const s = findSkill(await loadSkills(), name)
    return s ? { ok: true as const, name: s.name, body: s.body } : { ok: false as const, error: 'no such skill' }
  })

  ipcMain.handle('daw:ai:abort', () => {
    abortCtl?.abort()
  })
  ipcMain.handle('daw:ai:reset', () => {
    history.length = 0
    claudeSession = null
  })

  // ---- backend: the person's Claude Code, started by the app ---------------------------------
  async function runClaudeApp(text: string, cfg: AiConfig, ctl: AbortController): Promise<void> {
    const exe = await findClaude(cfg.claudePath)
    if (!exe) {
      say(
        cfg.claudePath
          ? '⚠ 指定された Claude Code が見つかりません（Options → AI の実行ファイルのパス）'
          : '⚠ Claude Code が見つかりません。インストールするか、Options → AI で claude の実行ファイルを指定してください'
      )
      return
    }
    privateMcp ??= await startPrivateMcp(deps)
    const cwd = join(dir(), 'agent') // neutral folder: the repo's own CLAUDE.md etc. must not leak into the assistant
    await mkdir(cwd, { recursive: true })
    const cfgPath = join(cwd, 'mcp.json')
    await writeFile(cfgPath, claudeMcpConfig(privateMcp.url, privateMcp.token))

    const args = buildClaudeArgs({
      mcpConfigPath: cfgPath,
      sessionId: claudeSession,
      model: cfg.claudeModel,
      blocked: [...AI_BLOCKED_TOOLS],
      prompt: await promptWithSkills(cfg.systemPrompt, CLAUDE_APP_PROMPT)
    })
    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    const child: ChildProcess = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const kill = (): void => {
      if (child.pid === undefined) return
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGTERM')
    }
    ctl.signal.addEventListener('abort', kill)
    const timer = setTimeout(() => ctl.abort(), CLAUDE_TURN_TIMEOUT_MS)

    let shown = 0
    let ended: { error?: string; finalText?: string } | null = null
    let errTail = ''
    let buf = ''
    const onLine = (line: string): void => {
      const r = parseClaudeLine(line)
      if (r.sessionId) claudeSession = r.sessionId
      for (const t of r.texts) {
        say(t)
        shown++
      }
      if (r.done) ended = r.done
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      errTail = (errTail + d).slice(-1500)
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(text)

    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        errTail += String(err.message)
        resolve(-1)
      })
      child.on('close', (c) => resolve(c))
    })
    clearTimeout(timer)
    ctl.signal.removeEventListener('abort', kill)
    if (buf.trim()) onLine(buf.trim())
    await rm(cfgPath, { force: true }) // it holds the private token
    const e = ended as { error?: string; finalText?: string } | null
    if (ctl.signal.aborted) return say('（中断しました）')
    if (e?.error) {
      if (/session|resume/i.test(e.error)) claudeSession = null // a stale session id: start fresh next time
      return say(`⚠ ${e.error}`)
    }
    if (!e) return say(`⚠ Claude Code が異常終了しました（code ${code}）${errTail.trim() ? '\n' + errTail.trim().slice(-600) : ''}`)
    if (!shown && e.finalText) say(e.finalText)
  }

  // ---- backend: OpenAI-compatible API ---------------------------------------------------------
  async function runOpenAi(text: string, cfg: AiConfig, ctl: AbortController): Promise<void> {
    const { key } = await loadKey(cfg.backend)
    const base = effectiveBaseUrl(cfg)
    if (!base) return say('⚠ Options → AI で接続先 URL を入力してください')
    if (!cfg.model) return say('⚠ Options → AI でモデル名を入力してください（Ollama なら `ollama list` に出る名前）')
    if (cfg.backend === 'gemini' && !key) return say('⚠ Gemini には API キーが必要です（Options → AI で保存）')
    const chk = checkEndpoint(base)
    if (!chk.ok) return say(`⚠ ${chk.reason}`)

    const specs = aiToolSpecs(MCP_TOOL_SPECS)
    const tools = toOpenAiTools(specs)
    const names = new Set(specs.map((x) => x.name))
    // a small local model has a small context: keep tool results short (Ollama defaults to a few thousand tokens)
    const maxResult = cfg.backend === 'ollama' ? 6000 : 24000
    const native = cfg.backend === 'ollama'
    const url = native ? ollamaChatUrl(base) : completionsUrl(base)
    const catalogue = compactToolCatalogue(specs)
    // Models whose template has no tools (the server answers 400 "does not support tools") get the tools in
    // the prompt instead; remembered for this session.
    let promptMode = promptModels.has(cfg.model)
    try {
      const outcome = await runAgentTurn(
        {
          async complete(messages) {
            const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
            try {
              for (let attempt = 0; attempt < 2 + OLLAMA_GPU_LAYER_STEPS.length; attempt++) {
                const sent = cfg.backend === 'gemini' ? withGeminiSignatures(messages) : messages
                const wire = promptMode ? toPlainChat(sent, catalogue) : native ? toOllamaMessages(sent) : sent
                const layers = gpuLayers.get(cfg.model)
                const body = native
                  ? {
                      model: cfg.model,
                      messages: wire,
                      stream: false,
                      options: { num_ctx: cfg.numCtx, ...(layers !== undefined ? { num_gpu: layers } : {}) },
                      ...(promptMode ? {} : { tools })
                    }
                  : { model: cfg.model, messages: wire, ...(promptMode ? {} : { tools, tool_choice: 'auto' }) }
                const res = await fetch(url, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
                  body: JSON.stringify(body),
                  signal: ctl.signal
                })
                const bodyText = await res.text()
                if (!res.ok) {
                  if (!promptMode && isNoToolsError(res.status, bodyText)) {
                    promptMode = true
                    promptModels.add(cfg.model)
                    say('（このモデルはツール呼び出し非対応のため、プロンプトで代用します）')
                    continue
                  }
                  if (native && isOutOfMemoryError(res.status, bodyText)) {
                    // the whole model does not fit next to Awaker (seen with Ollama in Docker / WSL2 even when free
                    // VRAM looks sufficient): put fewer layers on the GPU and try again, remember what worked
                    const cur = gpuLayers.get(cfg.model)
                    const next = OLLAMA_GPU_LAYER_STEPS.find((n) => cur === undefined || n < cur)
                    if (next !== undefined) {
                      gpuLayers.set(cfg.model, next)
                      say(`（VRAM に載り切らないため、GPU に載せる層を ${next} 層に減らして再試行します）`)
                      continue
                    }
                  }
                  throw new Error(`HTTP ${res.status} ${bodyText.slice(0, 300)}`)
                }
                const raw: unknown = JSON.parse(bodyText)
                const msg = native ? parseOllamaResponse(raw) : parseCompletion(raw)
                if (msg.tool_calls?.length) return msg
                // local models: the call written as text (```json …```) instead of a structured tool call
                const t = extractTextToolCalls(msg.content, names)
                return t.calls.length ? { content: t.rest || null, tool_calls: t.calls } : msg
              }
              throw new Error('model does not accept the request')
            } finally {
              clearTimeout(timer)
            }
          },
          async runTool(name, args) {
            if (!specs.some((s) => s.name === name)) throw new Error(`tool not available: ${name}`)
            const spec = specs.find((s) => s.name === name)!
            const out = await callTool(name, coerceToolArgs(spec.inputSchema, args), deps, 'agent')
            const t = out.content.map((c) => (c.type === 'text' ? c.text : '(image omitted)')).join('\n')
            if (out.isError) throw new Error(t)
            return clipToolResult(t, maxResult)
          },
          say,
          aborted: () => ctl.signal.aborted
        },
        history,
        text,
        cfg.maxSteps,
        await promptWithSkills(cfg.systemPrompt, SYSTEM_PROMPT)
      )
      if (outcome === 'aborted') say('（中断しました）')
      trimHistory(history)
    } catch (err) {
      say(`⚠ ${ctl.signal.aborted ? '中断またはタイムアウトしました' : explainApiError(redactKey(String((err as Error).message ?? err), key))}`)
    }
  }

  /** One chat line from the person → the selected built-in backend (the Claude-via-MCP backend never comes here). */
  ipcMain.handle('daw:ai:send', async (_e, text: unknown, rawCfg: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false as const, error: 'empty' }
    const cfg = sanitizeAiConfig(rawCfg)
    if (cfg.backend === 'claude-mcp') return { ok: false as const, error: 'external backend' }
    if (cfg.backend !== 'claude-app' && !isOpenAiKind(cfg.backend)) return { ok: false as const, error: 'unknown backend' }
    if (busy) return { ok: false as const, error: 'busy' }
    abortCtl = new AbortController()
    const ctl = abortCtl
    setBusy(true)
    // What the assistant claims is one thing; what changed is measured here: the project before and after the turn,
    // plus every tool call that went through `callTool`. Shown in the chat and written to the log.
    const before = await snapshot()
    const myTrace: ToolCallRecord[] = []
    trace = myTrace
    const replies: string[] = []
    shownSink = replies
    let result: { ok: boolean; error?: string } = { ok: true }
    try {
      if (cfg.backend === 'claude-app') await runClaudeApp(text.trim(), cfg, ctl)
      else await runOpenAi(text.trim(), cfg, ctl)
    } catch (err) {
      say(`⚠ ${String((err as Error).message ?? err)}`)
      result = { ok: false, error: String((err as Error).message ?? err) }
    } finally {
      trace = null
      shownSink = null
      abortCtl = null
      const after = await snapshot()
      const changes = before && after ? diffProject(before, after) : []
      const failed = myTrace.filter((r) => !r.ok).length
      if (before && after) say(formatChanges(changes, myTrace.length, failed, myTrace.map((r) => r.name)))
      else say('【実際に変わった設定】取得できませんでした（プロジェクトの状態を読めませんでした）')
      void opsLog.append({
        type: 'turn',
        time: new Date().toISOString(),
        backend: cfg.backend,
        model: cfg.backend === 'claude-app' ? cfg.claudeModel || 'default' : cfg.model,
        request: clip(text.trim(), 500),
        ...(cfg.systemPrompt ? { customPrompt: true } : {}),
        tools: myTrace.map((r) => ({ name: r.name, args: clip(JSON.stringify(r.args) ?? '', 300), ok: r.ok, ms: r.ms, ...(r.error ? { error: r.error } : {}) })),
        changes: changes.slice(0, 200).map((c) => ({ path: c.path, from: c.from, to: c.to })),
        changeCount: changes.length,
        replies: replies.map((r) => clip(r, 600)).slice(0, 20),
        ...(result.ok ? {} : { error: result.error })
      })
      setBusy(false)
    }
    return result
  })
}
