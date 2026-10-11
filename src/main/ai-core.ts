// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * The AI connection, minus Electron: config checking, the OpenAI-compatible request shape, the Claude Code
 * launcher's arguments + output parser, and the tool-calling agent loop with its I/O injected — so it is
 * unit-tested in Node (tests/ai-core.test.ts).
 *
 * Backends (picked in Options → AI):
 *   'claude-app' — the app starts the person's own Claude Code (`claude -p`, headless) as a child process and
 *                  gives it the app's tools through a private MCP server. It uses whatever login that Claude Code
 *                  already has (their subscription); the app never sees or stores any Claude credential.
 *   'claude-mcp' — nothing runs here. A Claude Code the person started themselves connects to the MCP server.
 *   'ollama' | 'gemini' | 'openai' — the app talks to an OpenAI-compatible `/chat/completions` endpoint
 *                  (Ollama on this machine; Google's OpenAI-compatible Gemini endpoint; or any other server that
 *                  speaks the protocol: LM Studio, llama.cpp, vLLM, OpenRouter, a home-grown one…). The three
 *                  differ only in the pre-filled address; URL, model and API key are always the person's own.
 *                  No key is ever built in.
 */

export type AiBackend = 'claude-app' | 'claude-mcp' | 'ollama' | 'gemini' | 'openai'
export const AI_BACKENDS: readonly AiBackend[] = ['claude-app', 'claude-mcp', 'ollama', 'gemini', 'openai']

/** The backends that speak the OpenAI-compatible protocol (the app itself is the agent). */
export const isOpenAiKind = (b: AiBackend): boolean => b === 'ollama' || b === 'gemini' || b === 'openai'

/** Pre-filled addresses (public, documented ones — not accounts). The person can always type their own. */
export const PRESET_BASE_URL: Partial<Record<AiBackend, string>> = {
  ollama: 'http://localhost:11434/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai'
}

/** The URL actually used: what the person typed, else the preset's address. */
export function effectiveBaseUrl(c: Pick<AiConfig, 'backend' | 'baseUrl'>): string {
  return c.baseUrl || PRESET_BASE_URL[c.backend] || ''
}

export interface AiConfig {
  backend: AiBackend
  /** OpenAI-compatible base URL, e.g. `https://host/v1` or a local server. Empty until the person enters one. */
  baseUrl: string
  /** OpenAI-compatible model name. */
  model: string
  /** claude-app: path to the Claude Code executable. Empty = look for it (PATH, the usual install places). */
  claudePath: string
  /** claude-app: model for Claude Code (`sonnet`, `opus`, a full id…). Empty = Claude Code's own default. */
  claudeModel: string
  /** ollama: context size (tokens) the app asks for. Smaller = less VRAM next to Awaker. */
  numCtx: number
  /** API backends: how many model calls one question may take (an animation is one call per frame). */
  maxSteps: number
  /** The person's own system prompt for this connection. Empty = the app's built-in one. */
  systemPrompt: string
}

export const DEFAULT_AI_CONFIG: AiConfig = { backend: 'claude-app', baseUrl: '', model: '', claudePath: '', claudeModel: '', numCtx: 8192, maxSteps: 40, systemPrompt: '' }

/** Longest custom system prompt taken (characters). */
export const MAX_SYSTEM_PROMPT = 8000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** A config from untrusted input (options file / IPC): anything off falls back to the default for that field. */
export function sanitizeAiConfig(raw: unknown): AiConfig {
  const r = isRecord(raw) ? raw : {}
  const backend = AI_BACKENDS.find((b) => b === r['backend']) ?? DEFAULT_AI_CONFIG.backend
  return {
    backend,
    baseUrl: str(r['baseUrl'], 300),
    model: str(r['model'], 120),
    claudePath: str(r['claudePath'], 400),
    claudeModel: str(r['claudeModel'], 80),
    numCtx:
      typeof r['numCtx'] === 'number' && Number.isFinite(r['numCtx'])
        ? Math.min(32768, Math.max(2048, Math.round(r['numCtx'] / 256) * 256))
        : DEFAULT_AI_CONFIG.numCtx,
    maxSteps:
      typeof r['maxSteps'] === 'number' && Number.isFinite(r['maxSteps'])
        ? Math.min(200, Math.max(4, Math.round(r['maxSteps'])))
        : DEFAULT_AI_CONFIG.maxSteps,
    systemPrompt: str(r['systemPrompt'], MAX_SYSTEM_PROMPT)
  }
}

/** Only an executable that is really called `claude` may be launched (the path comes from a settings field). */
export function isClaudeExecutableName(path: string): boolean {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return /^claude(\.exe)?$/i.test(base)
}

/** `https://host/v1` → `https://host/v1/chat/completions` (already complete URLs are kept). */
export function completionsUrl(baseUrl: string): string {
  const u = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/.test(u) ? u : `${u}/chat/completions`
}

/**
 * The key travels in an Authorization header, so plain http is only accepted for this machine and private
 * networks (a local model server); anything on the open internet must be https.
 */
export function checkEndpoint(baseUrl: string): { ok: true } | { ok: false; reason: string } {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return { ok: false, reason: 'URL が正しくありません' }
  }
  if (u.protocol === 'https:') return { ok: true }
  if (u.protocol !== 'http:') return { ok: false, reason: 'http または https の URL を指定してください' }
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const priv =
    h === 'localhost' ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith('.local')
  return priv ? { ok: true } : { ok: false, reason: 'インターネット上の接続先は https が必要です（API キーが平文で流れるため）' }
}

/** Remove the key from any text that is about to be shown or logged. */
export function redactKey(text: string, key: string): string {
  if (!key) return text
  return text.split(key).join('***')
}

// ---- tools -----------------------------------------------------------------------------------

export interface ToolSpecLite {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Tools the built-in agent may NOT use. They take file paths (an outside model could make the app read or
 * overwrite files), return screenshots / console text, or restart the page; the person's own Claude Code keeps
 * the full set (it is their own session on their own machine).
 */
export const AI_BLOCKED_TOOLS = new Set([
  'project_save_file',
  'project_load_file',
  'dawproject_export',
  'dawproject_import',
  'midi_import',
  'midi_export',
  'track_add_wav',
  'screenshot',
  'logs',
  'app_reload',
  'chat_read',
  'chat_say',
  'chat_type',
  'chat_history'
])

export function aiToolSpecs<T extends ToolSpecLite>(all: readonly T[]): T[] {
  return all.filter((t) => !AI_BLOCKED_TOOLS.has(t.name))
}

/**
 * Tool schemas for OpenAI-compatible servers. Not every server takes full JSON Schema — Gemini's endpoint
 * rejects `additionalProperties` and unions — so: drop `additionalProperties`, and collapse a union
 * (`anyOf`) to one plain type (`string` if its members mix types), keeping the choices in the description.
 * `coerceToolArgs` undoes the collapse on the way back.
 */
export function simplifySchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(simplifySchema)
  if (!isRecord(schema)) return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue
    if (k === 'anyOf' && Array.isArray(v)) continue
    out[k] = simplifySchema(v)
  }
  if (Array.isArray(schema['anyOf'])) {
    const members = (schema['anyOf'] as unknown[]).filter(isRecord)
    const types = new Set(members.map((m) => m['type']))
    out['type'] = types.size === 1 ? [...types][0] : 'string'
    const note = members.map((m) => (Array.isArray(m['enum']) ? (m['enum'] as unknown[]).join('|') : String(m['type']))).join(' or ')
    out['description'] = [out['description'], `(${note})`].filter(Boolean).join(' ')
  }
  return out
}

/** A model that was shown a collapsed union may answer "3" for a number: turn it back where the original allowed one. */
export function coerceToolArgs(schema: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const props = isRecord(schema['properties']) ? schema['properties'] : {}
  const out = { ...args }
  for (const [k, v] of Object.entries(out)) {
    const p = props[k]
    if (!isRecord(p) || !Array.isArray(p['anyOf'])) continue
    const takesNumber = (p['anyOf'] as unknown[]).some((m) => isRecord(m) && m['type'] === 'number')
    if (takesNumber && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v)
  }
  return out
}

export function toOpenAiTools(specs: readonly ToolSpecLite[]): unknown[] {
  return specs.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: simplifySchema(t.inputSchema) }
  }))
}

/** Tool output is bounded before it goes back to the model (a whole project JSON can be huge). */
export function clipToolResult(text: string, max = 24000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max} chars cut)`
}

// ---- agent loop ------------------------------------------------------------------------------

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  /**
   * Vendor extras that must go back unchanged. Gemini 3 puts its `thought_signature` here
   * (`extra_content.google.thought_signature`) and rejects the next request (400) if a function call comes back without it.
   */
  extra_content?: Record<string, unknown>
}
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface AgentIO {
  /** One model call: the conversation so far → the assistant message. */
  complete(messages: ChatMessage[]): Promise<{ content: string | null; tool_calls?: ToolCall[] }>
  /** Run a tool; returns the text to give back to the model. Throw to report an error to it. */
  runTool(name: string, args: Record<string, unknown>): Promise<string>
  /** Show a line in the chat. */
  say(text: string): void
  aborted(): boolean
}

/**
 * Short, general working rules for every assistant prompt (kept small on purpose: a small local model pays for
 * every token). No special tool for repeated / many-track changes: ordinary tool calls, several in one message.
 */
export const OPERATING_GUIDE =
  'Many values at once (several tracks): send them as several tool calls in ONE message, not one per message. ' +
  'Stay inside the real ranges (channel fader -60..+6 dB, pan -1..+1) and report the values you really set. ' +
  'If you change something only to try it, put it back and say so. ' +
  'Never say it worked without looking at the tool results; if a call failed, say so. ' +
  'If the request is unclear in a way that matters, ask, or say which default you chose.'

export const SYSTEM_PROMPT =
  'You operate "Awaker DAW over GPU", a GPU-based DAW, through the provided tools. ' +
  'Typical flow: tracks_list / state_get to look → change faders, pans, strip and insert parameters → bounce to read the loudness numbers. ' +
  'Prefer small, reversible changes and tell the person what you changed. Answer in the language the person writes in, briefly. ' +
  'You cannot hear audio; judge only from the numbers the tools return, and say so when it matters. ' +
  OPERATING_GUIDE

/**
 * Run one user turn: call the model; while it asks for tools, run them and feed the results back (at most
 * `maxRounds` rounds); show its final text. `history` is the running conversation (without the system prompt)
 * and is extended in place. Returns when the model answers without tool calls, on abort, or at the round limit.
 */
export async function runAgentTurn(
  io: AgentIO,
  history: ChatMessage[],
  userText: string,
  maxRounds = 12,
  /** The person's own system prompt; empty / absent = the built-in one. */
  systemPrompt = ''
): Promise<'done' | 'aborted' | 'round-limit'> {
  const system = systemPrompt.trim() || SYSTEM_PROMPT
  history.push({ role: 'user', content: userText })
  for (let round = 0; round < maxRounds; round++) {
    if (io.aborted()) return 'aborted'
    compactOldToolResults(history)
    const msg = await io.complete([{ role: 'system', content: system }, ...history])
    if (io.aborted()) return 'aborted'
    const calls = msg.tool_calls ?? []
    history.push({ role: 'assistant', content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) })
    if (msg.content && msg.content.trim()) io.say(msg.content.trim())
    if (!calls.length) return 'done'
    for (const c of calls) {
      if (io.aborted()) return 'aborted'
      let out: string
      try {
        const parsed: unknown = c.function.arguments.trim() ? JSON.parse(c.function.arguments) : {}
        if (!isRecord(parsed)) throw new Error('arguments must be a JSON object')
        out = await io.runTool(c.function.name, parsed)
      } catch (err) {
        out = `error: ${(err as Error).message}`
      }
      history.push({ role: 'tool', tool_call_id: c.id, content: clipToolResult(out) })
    }
  }
  io.say('（ツールの呼び出し回数が上限に達したので、ここで止めました）')
  return 'round-limit'
}

/**
 * Mid-turn: tool results of older rounds shrink to a short stub so a long animation (dozens of frames x dozens
 * of calls) does not fill the context. The last `keepRounds` assistant rounds stay complete.
 */
export function compactOldToolResults(history: ChatMessage[], keepRounds = 3, stub = 160): void {
  let rounds = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'assistant') rounds++
    // `rounds` = how many assistant rounds are NEWER than this message (its own assistant message comes before it)
    if (rounds >= keepRounds && m.role === 'tool' && m.content.length > stub) {
      history[i] = { ...m, content: `${m.content.slice(0, stub)}…(shortened)` }
    }
  }
}

/** Keep the conversation bounded: drop the oldest turns, never splitting an assistant/tool group. */
export function trimHistory(history: ChatMessage[], maxMessages = 60): void {
  if (history.length <= maxMessages) return
  let cut = history.length - maxMessages
  while (cut < history.length && history[cut].role !== 'user') cut++
  history.splice(0, cut)
}

/** The assistant message out of a raw `/chat/completions` response body. */
export function parseCompletion(body: unknown): { content: string | null; tool_calls?: ToolCall[] } {
  if (!isRecord(body)) throw new Error('unexpected response (not JSON object)')
  if (isRecord(body['error'])) throw new Error(String(body['error']['message'] ?? 'API error'))
  const choices = body['choices']
  const first = Array.isArray(choices) ? (choices[0] as unknown) : undefined
  const message = isRecord(first) ? first['message'] : undefined
  if (!isRecord(message)) throw new Error('unexpected response (no choices[0].message)')
  const content = typeof message['content'] === 'string' ? message['content'] : null
  const rawCalls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as unknown[]) : []
  const tool_calls: ToolCall[] = []
  for (const c of rawCalls) {
    if (!isRecord(c) || !isRecord(c['function'])) continue
    const fn = c['function']
    tool_calls.push({
      id: typeof c['id'] === 'string' && c['id'] ? c['id'] : `call_${tool_calls.length}`,
      type: 'function',
      function: {
        name: String(fn['name'] ?? ''),
        // some servers return the arguments already parsed
        arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn['arguments'] ?? {})
      },
      ...(isRecord(c['extra_content']) ? { extra_content: c['extra_content'] } : {})
    })
  }
  return { content, ...(tool_calls.length ? { tool_calls } : {}) }
}

// ---- Claude Code launcher (backend 'claude-app') ----------------------------------------------

export const MCP_SERVER_NAME = 'awaker'

/** The MCP config handed to `claude --mcp-config` (a temp file in the user-data folder: it holds the token). */
export function claudeMcpConfig(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } })
}

export const CLAUDE_APP_PROMPT =
  'You are running inside "Awaker DAW over GPU", a GPU-based DAW, as its built-in assistant. The person talks to you in the chat window of the app. ' +
  `Your only tools are the DAW's MCP tools (mcp__${MCP_SERVER_NAME}__*); you have no file or shell access here. ` +
  'Typical flow: tracks_list / state_get to look → change faders, pans, strip and insert parameters → bounce to read loudness numbers. ' +
  'Prefer small, reversible changes and say what you changed. Reply in the language the person writes in, briefly. ' +
  'You cannot hear audio; judge only from the numbers the tools return, and say so when it matters. ' +
  OPERATING_GUIDE

/**
 * Arguments for one headless turn. The prompt itself goes in on stdin (a variadic option such as --allowedTools
 * would swallow a positional argument). Built-in tools are all switched off; only this app's MCP tools are allowed,
 * minus the ones that take file paths. `sessionId` continues the conversation of the previous turn.
 */
export function buildClaudeArgs(o: {
  mcpConfigPath: string
  sessionId: string | null
  model: string
  blocked: readonly string[]
  /** The person's own system prompt; empty / absent = the built-in one. */
  prompt?: string
}): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', o.mcpConfigPath,
    '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', `mcp__${MCP_SERVER_NAME}`,
    '--permission-mode', 'default',
    '--setting-sources', 'user',
    '--append-system-prompt', o.prompt?.trim() || CLAUDE_APP_PROMPT
  ]
  if (o.blocked.length) args.push('--disallowedTools', ...o.blocked.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`))
  if (o.model) args.push('--model', o.model)
  if (o.sessionId) args.push('--resume', o.sessionId)
  return args
}

export interface ClaudeLine {
  sessionId?: string
  /** Assistant text to show (one entry per text block). */
  texts: string[]
  /** The run ended: ok, or with this error text. */
  done?: { error?: string; finalText?: string }
}

/** One line of `--output-format stream-json`. Unknown / unparsable lines give an empty result. */
export function parseClaudeLine(line: string): ClaudeLine {
  const out: ClaudeLine = { texts: [] }
  let j: unknown
  try {
    j = JSON.parse(line)
  } catch {
    return out
  }
  if (!isRecord(j)) return out
  if (typeof j['session_id'] === 'string') out.sessionId = j['session_id']
  if (j['type'] === 'assistant' && isRecord(j['message']) && Array.isArray(j['message']['content'])) {
    for (const b of j['message']['content'] as unknown[]) {
      if (isRecord(b) && b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim()) out.texts.push(b['text'].trim())
    }
  }
  if (j['type'] === 'result') {
    const isErr = j['is_error'] === true || (typeof j['subtype'] === 'string' && j['subtype'] !== 'success')
    const text = typeof j['result'] === 'string' ? j['result'] : ''
    out.done = isErr ? { error: text || String(j['subtype'] ?? 'error') } : { finalText: text }
  }
  return out
}

/**
 * Small local models often have no (or a poor) native tool-calling template: they pick the right tool but write
 * the call as TEXT — a ```json fence, <tool_call>…</tool_call>, or a bare JSON object / array with
 * `name` + `arguments` (or `parameters`). When the server returned no structured tool calls, look for those.
 * Only names the app really offers are accepted, so ordinary prose / JSON the model merely shows is left alone.
 */
export function extractTextToolCalls(
  content: string | null,
  known: ReadonlySet<string>
): { calls: ToolCall[]; rest: string } {
  const none = { calls: [] as ToolCall[], rest: content ?? '' }
  if (!content || !content.trim()) return none
  const chunks: { text: string; whole: string }[] = []
  for (const m of content.matchAll(/```(?:json|tool_call|tool)?\s*([\s\S]*?)```/gi)) chunks.push({ text: m[1], whole: m[0] })
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) chunks.push({ text: m[1], whole: m[0] })
  if (!chunks.length && /^[\s]*[[{]/.test(content)) chunks.push({ text: content.trim(), whole: content })
  const calls: ToolCall[] = []
  let rest = content
  for (const ch of chunks) {
    let j: unknown
    try {
      j = JSON.parse(ch.text.trim())
    } catch {
      continue
    }
    const items = Array.isArray(j) ? j : [j]
    const found: ToolCall[] = []
    for (const it of items) {
      if (!isRecord(it)) continue
      const name = typeof it['name'] === 'string' ? it['name'] : isRecord(it['function']) ? String(it['function']['name'] ?? '') : ''
      if (!known.has(name)) continue
      const rawArgs = it['arguments'] ?? it['parameters'] ?? (isRecord(it['function']) ? it['function']['arguments'] : undefined) ?? {}
      found.push({
        id: `text_call_${calls.length + found.length}`,
        type: 'function',
        function: { name, arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs) }
      })
    }
    if (found.length) {
      calls.push(...found)
      rest = rest.replace(ch.whole, '')
    }
  }
  return { calls, rest: rest.trim() }
}

// ---- Ollama's native API (/api/chat): lets the app set the context size -----------------------
// The OpenAI-compatible door of Ollama cannot take `num_ctx`, and a model's own default context can be so
// large that its KV cache no longer fits next to Awaker in an 8 GB card ("failed to allocate buffer for kv cache").

/** `http://localhost:11434/v1` → `http://localhost:11434/api/chat` */
export function ollamaChatUrl(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/api/chat`
  } catch {
    return ''
  }
}

/** Our messages in Ollama's shape: tool-call arguments are objects, tool results carry the tool's name. */
export function toOllamaMessages(messages: readonly ChatMessage[]): unknown[] {
  const names = new Map<string, string>()
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => {
        names.set(c.id, c.function.name)
        let args: unknown = {}
        try {
          args = JSON.parse(c.function.arguments || '{}')
        } catch {
          /* keep {} */
        }
        return { function: { name: c.function.name, arguments: args } }
      })
      return { role: 'assistant', content: m.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) }
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: names.get(m.tool_call_id) ?? '' }
    return { role: m.role, content: m.content }
  })
}

/** The assistant message out of a raw `/api/chat` (non-streaming) response body. */
export function parseOllamaResponse(body: unknown): { content: string | null; tool_calls?: ToolCall[] } {
  if (!isRecord(body)) throw new Error('unexpected response (not JSON object)')
  if (typeof body['error'] === 'string') throw new Error(body['error'])
  const message = body['message']
  if (!isRecord(message)) throw new Error('unexpected response (no message)')
  const content = typeof message['content'] === 'string' && message['content'] !== '' ? message['content'] : null
  const tool_calls: ToolCall[] = []
  for (const c of Array.isArray(message['tool_calls']) ? (message['tool_calls'] as unknown[]) : []) {
    if (!isRecord(c) || !isRecord(c['function'])) continue
    const fn = c['function']
    const a = fn['arguments']
    tool_calls.push({
      id: `ollama_call_${tool_calls.length}`,
      type: 'function',
      function: { name: String(fn['name'] ?? ''), arguments: typeof a === 'string' ? a : JSON.stringify(a ?? {}) }
    })
  }
  return { content, ...(tool_calls.length ? { tool_calls } : {}) }
}

// ---- models with no tool-calling template (the server answers 400 "does not support tools") ----
// Instead of the `tools` parameter, the tools go into the system prompt in a compact form and the model is asked
// to answer a tool call as one JSON object; `extractTextToolCalls` reads it back.

/** One line per tool: `name(a: number, b?: string): first sentence`. */
export function compactToolCatalogue(specs: readonly ToolSpecLite[]): string {
  return specs
    .map((t) => {
      const props = isRecord(t.inputSchema['properties']) ? (t.inputSchema['properties'] as Record<string, unknown>) : {}
      const req = new Set(Array.isArray(t.inputSchema['required']) ? (t.inputSchema['required'] as string[]) : [])
      const params = Object.entries(props)
        .map(([k, v]) => {
          const p = isRecord(v) ? v : {}
          const ty = typeof p['type'] === 'string' ? p['type'] : Array.isArray(p['anyOf']) ? 'number|string' : 'any'
          return `${k}${req.has(k) ? '' : '?'}: ${ty}`
        })
        .join(', ')
      const first = t.description.split(/(?<=[.。])\s/)[0].slice(0, 110)
      return `- ${t.name}(${params}): ${first}`
    })
    .join('\n')
}

export const PROMPT_TOOL_RULES =
  'You can use these tools. To call one, reply with ONLY one JSON object and nothing else: ' +
  '{"name": "<tool name>", "arguments": { ... }}. One call per message. ' +
  'You will then receive the result; when you have what you need, answer in plain text (no JSON).'

/** Plain chat messages for a model without tool support: tools in the system prompt, results as user lines. */
export function toPlainChat(
  messages: readonly ChatMessage[],
  catalogue: string
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const names = new Map<string, string>()
  const out: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
  for (const m of messages) {
    if (m.role === 'system') out.push({ role: 'system', content: `${m.content}\n\n${PROMPT_TOOL_RULES}\n\nTools:\n${catalogue}` })
    else if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => {
        names.set(c.id, c.function.name)
        return `{"name": "${c.function.name}", "arguments": ${c.function.arguments || '{}'}}`
      })
      out.push({ role: 'assistant', content: [m.content ?? '', ...calls].filter(Boolean).join('\n') })
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: `Tool result (${names.get(m.tool_call_id) ?? 'tool'}):\n${m.content}` })
    }
  }
  return out
}

/** Does this HTTP error mean "the model has no tool-calling template"? */
export const isNoToolsError = (status: number, bodyText: string): boolean =>
  status === 400 && /does not support tools/i.test(bodyText)

/** The server could not allocate GPU memory for the model / its context (Ollama answers 500 with cudaMalloc …). */
export const isOutOfMemoryError = (status: number, bodyText: string): boolean =>
  status === 500 && /out of memory|cudaMalloc failed|unable to allocate/i.test(bodyText)

/** Ollama: how many layers to try on the GPU, in turn, after an out-of-memory error (0 = all on the CPU). */
export const OLLAMA_GPU_LAYER_STEPS: readonly number[] = [24, 16, 8, 0]

/** Gemini accepts this documented placeholder where a call has no real thought signature (e.g. history from elsewhere). */
export const GEMINI_DUMMY_SIGNATURE = 'skip_thought_signature_validator'

/**
 * Gemini 3: every function call we send back must carry a thought signature. Real ones are kept by
 * `parseCompletion` (`extra_content`); a call that has none (a text-extracted one, an old history) gets the
 * documented placeholder so the request is not rejected. Returns new objects; the history is left alone.
 */
export function withGeminiSignatures(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.tool_calls?.length) return m
    return {
      ...m,
      tool_calls: m.tool_calls.map((c) => {
        const g = isRecord(c.extra_content) && isRecord(c.extra_content['google']) ? c.extra_content['google'] : null
        if (g && typeof g['thought_signature'] === 'string' && g['thought_signature']) return c
        return { ...c, extra_content: { ...(c.extra_content ?? {}), google: { thought_signature: GEMINI_DUMMY_SIGNATURE } } }
      })
    }
  })
}

// ---- what really changed (measured by the app, not reported by the AI) -------------------------

export interface Change {
  path: string
  from: unknown
  to: unknown
}

/** Project fields that move on their own (view, playhead…) and are not edits. */
const VOLATILE_TOP = new Set(['view'])

/** How an element of an array is told apart across two snapshots: its `id`, else its `title` / `name`. */
const keyOf = (v: unknown): string | null => {
  if (!isRecord(v)) return null
  if (typeof v['id'] === 'number' || typeof v['id'] === 'string') return `id:${String(v['id'])}`
  if (typeof v['title'] === 'string') return `title:${v['title']}`
  if (typeof v['name'] === 'string') return `name:${v['name']}`
  return null
}
const labelOf = (v: Record<string, unknown>): string => {
  const nm = typeof v['title'] === 'string' ? v['title'] : typeof v['name'] === 'string' ? v['name'] : ''
  const id = typeof v['id'] === 'number' || typeof v['id'] === 'string' ? String(v['id']) : ''
  return id && nm ? `${id}:${nm}` : id || nm
}
const uniqueKeys = (a: readonly unknown[]): boolean => {
  const ks = a.map(keyOf)
  return ks.every((k) => k !== null) && new Set(ks).size === ks.length
}

/**
 * Deep difference of two project snapshots (`project_get`). Arrays of objects that have an `id` (tracks, clips,
 * sources) are matched by id — with the title in the path so it reads as "tracks[1:01_KickIn].mix.gainDb" — others
 * by index. Added / removed items are one change each. Stops after `limit` changes.
 */
export function diffProject(before: unknown, after: unknown, limit = 200): Change[] {
  const out: Change[] = []
  const walk = (a: unknown, b: unknown, path: string, top: boolean): void => {
    if (out.length >= limit || a === b) return
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length + b.length > 0 && uniqueKeys(a) && uniqueKeys(b)) {
        const ma = new Map(a.map((x) => [keyOf(x)!, x as Record<string, unknown>]))
        const mb = new Map(b.map((x) => [keyOf(x)!, x as Record<string, unknown>]))
        for (const k of new Set([...ma.keys(), ...mb.keys()])) {
          const xa = ma.get(k)
          const xb = mb.get(k)
          const p = `${path}[${labelOf((xb ?? xa)!)}]`
          if (xa === undefined) out.push({ path: p, from: undefined, to: '（追加）' })
          else if (xb === undefined) out.push({ path: p, from: '（削除）', to: undefined })
          else walk(xa, xb, p, false)
        }
      } else {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (i >= a.length) out.push({ path: `${path}[${i}]`, from: undefined, to: '（追加）' })
          else if (i >= b.length) out.push({ path: `${path}[${i}]`, from: '（削除）', to: undefined })
          else walk(a[i], b[i], `${path}[${i}${isRecord(a[i]) && labelOf(a[i] as Record<string, unknown>) ? ':' + labelOf(a[i] as Record<string, unknown>) : ''}]`, false)
        }
      }
      return
    }
    if (isRecord(a) && isRecord(b)) {
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (top && VOLATILE_TOP.has(k)) continue
        walk(a[k], b[k], path ? `${path}.${k}` : k, false)
      }
      return
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, from: a, to: b })
  }
  walk(before, after, '', true)
  return out
}

const fmtValue = (v: unknown): string => {
  if (v === undefined) return '（なし）'
  if (typeof v === 'number') return String(Math.round(v * 10000) / 10000)
  if (typeof v === 'string') return v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`
  const j = JSON.stringify(v)
  return j.length > 60 ? `${j.slice(0, 60)}…` : j
}

/** The chat message for a turn: measured changes, or a clear "no change". */
export function formatChanges(changes: readonly Change[], toolCount: number, failed: number, toolNames: readonly string[] = []): string {
  const head = '【実際に変わった設定】（アプリが計測した結果です。AI の説明ではありません）'
  const counts = new Map<string, number>()
  for (const n of toolNames) counts.set(n, (counts.get(n) ?? 0) + 1)
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([n, c]) => `${n} ${c}`)
    .join('、')
  const tools = `ツール実行: ${toolCount} 回${failed ? `（失敗 ${failed} 回）` : ''}${breakdown ? `（${breakdown}）` : ''}`
  if (!changes.length) return `${head}\n変更なし\n${tools}`
  const shown = changes.slice(0, 40).map((c) => ` ${c.path}: ${fmtValue(c.from)} → ${fmtValue(c.to)}`)
  const more = changes.length > 40 ? [` …ほか ${changes.length - 40} 件`] : []
  return [head, ...shown, ...more, tools].join('\n')
}

/**
 * An API error as a person can act on it. The raw text (often a JSON array from the service) is kept short after
 * the explanation. `err` is the message the request code threw (`HTTP <status> <body>`).
 */
export function explainApiError(err: string): string {
  const m = /^HTTP (\d{3})\s*([\s\S]*)$/.exec(err.trim())
  if (!m) return err
  const status = Number(m[1])
  const body = m[2]
  const detail = body.replace(/\s+/g, ' ').slice(0, 220)
  const quota = /credit|billing|prepay|quota|insufficient|RESOURCE_EXHAUSTED|exceeded your current/i.test(body)
  let why: string
  if (status === 402 || (quota && status !== 429)) why = 'API の残高・利用枠が足りません（課金やクレジットの状態を、そのサービスの管理画面で確認してください）'
  else if (status === 429) why = quota ? 'API の利用枠（クォータ）が上限です。時間をおくか、プランを確認してください' : '短時間に呼び出しすぎました。少し待ってからもう一度試してください'
  else if (status === 401 || status === 403) why = 'API キーが正しくないか、このモデルを使う権限がありません（Options → AI でキーを保存し直してください）'
  else if (status === 404) why = 'モデル名か接続先 URL が違うようです（Options → AI を確認してください）'
  else if (status === 400) why = 'リクエストが受け付けられませんでした（モデルがツール呼び出しに対応していない、入力が長すぎる、などの可能性）'
  else if (status >= 500) why = 'サービス側の一時的な不具合のようです。少し待ってからもう一度試してください'
  else why = `API がエラー（HTTP ${status}）を返しました`
  return `${why}。別の接続先は Options → AI で選べます。\n（詳細: HTTP ${status} ${detail}）`
}
