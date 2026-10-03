// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { ipcMain, type BrowserWindow } from 'electron'

/**
 * Built-in MCP server (dev / regression aid) — lets an AI drive the *running* app:
 * edit the project, move faders / plugin params, transport + record, render an
 * offline bounce and read level / LUFS stats, take screenshots, read the console.
 *
 * Opt-in: only starts when `DAW_MCP=1` (npm run dev:mcp). Hand-rolled MCP over
 * "Streamable HTTP" (plain JSON responses; no SSE) so there is no new dependency.
 * Bound to 127.0.0.1 only. A browser tab can't reach it: requests carrying an
 * `Origin` header are refused and the body must be `application/json` (a
 * cross-site form can't send that without a CORS preflight).
 *
 * Most tools run in the renderer (that's where the project + GPU live): main
 * forwards `{tool,args}` over IPC and awaits the reply. Tools marked `main`
 * run here (screenshot, console log, project file I/O, device list, reload).
 */

interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  where: 'renderer' | 'main'
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const num = (description: string): Record<string, unknown> => ({ type: 'number', description })
const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
const bool = (description: string): Record<string, unknown> => ({ type: 'boolean', description })
const owner = {
  description: "Track id (number, from tracks_list) or 'master'",
  anyOf: [{ type: 'number' }, { type: 'string', enum: ['master'] }]
}
const INSERT_KINDS = ['reverb', 'delay', 'eq5', 'tubeeq', 'awaker', 'buscomp', 'maximizer']

const TOOLS: ToolSpec[] = [
  {
    name: 'state_get',
    where: 'renderer',
    description:
      'Transport / engine snapshot: playing, recording, playhead, sample rate, bpm, track count, audio backend + input info, live meters (master peak, LUFS M/S/I).',
    inputSchema: obj({})
  },
  {
    name: 'project_get',
    where: 'renderer',
    description:
      'The full project snapshot exactly as Save writes it (all faders, pans, strips, every insert plugin param, clips, sources, master).',
    inputSchema: obj({})
  },
  {
    name: 'project_load',
    where: 'renderer',
    description: 'Replace the whole project with a snapshot object (same shape as project_get).',
    inputSchema: obj({ project: { type: 'object' } }, ['project'])
  },
  {
    name: 'project_save_file',
    where: 'main',
    description: 'Write the current project JSON to an absolute file path.',
    inputSchema: obj({ path: str('absolute .json path') }, ['path'])
  },
  {
    name: 'project_load_file',
    where: 'main',
    description: 'Load a project JSON file from an absolute path (replaces the current project).',
    inputSchema: obj({ path: str('absolute .json path') }, ['path'])
  },
  {
    name: 'tracks_list',
    where: 'renderer',
    description: 'Compact per-track summary: id, title, mix, record routing, clips, inserts (kind + bypass).',
    inputSchema: obj({})
  },
  {
    name: 'track_add_tone',
    where: 'renderer',
    description: 'Add a track holding a generated GPU test chord (stereo).',
    inputSchema: obj({ seconds: num('length, default 6'), title: str('track title') })
  },
  {
    name: 'track_add_wav',
    where: 'renderer',
    description: 'Add a track from a WAV file path (resampled to the project rate on the GPU).',
    inputSchema: obj({ path: str('absolute .wav path'), title: str('track title') }, ['path'])
  },
  {
    name: 'track_set',
    where: 'renderer',
    description:
      'Set channel fader / pan / mute / solo / rec-arm / record input routing / title. Only given fields change.',
    inputSchema: obj(
      {
        track: num('track id'),
        gainDb: num('-60..+6 (-60 = -inf)'),
        pan: num('-1..+1'),
        mute: bool(''),
        solo: bool(''),
        rec: bool('arm for recording'),
        recIn: obj({ ch: num('0-based input channel'), stereo: bool('record ch and ch+1 as a pair') }, ['ch']),
        title: str('')
      },
      ['track']
    )
  },
  {
    name: 'strip_set',
    where: 'renderer',
    description:
      'Built-in channel strip: bypass and/or a partial params object, deep-merged (trimDb, drive, satMode, hpfHz, eqOn, eq[4], comp{...}).',
    inputSchema: obj({ track: num('track id'), bypass: bool(''), params: { type: 'object' } }, ['track'])
  },
  {
    name: 'insert_add',
    where: 'renderer',
    description: `Append an insert plugin (${INSERT_KINDS.join(' | ')}; buscomp / maximizer are master-only).`,
    inputSchema: obj(
      {
        owner,
        kind: { type: 'string', enum: INSERT_KINDS },
        params: { type: 'object', description: 'initial param overrides (eq5: {bands:[...]})' },
        bypass: bool('')
      },
      ['owner', 'kind']
    )
  },
  {
    name: 'insert_set',
    where: 'renderer',
    description: 'Change an insert plugin: partial params (merged) and/or bypass. index = slot position in the rack.',
    inputSchema: obj(
      { owner, index: num('0-based index in the insert list'), params: { type: 'object' }, bypass: bool('') },
      ['owner', 'index']
    )
  },
  {
    name: 'insert_remove',
    where: 'renderer',
    description: 'Remove an insert plugin.',
    inputSchema: obj({ owner, index: num('0-based') }, ['owner', 'index'])
  },
  {
    name: 'master_set',
    where: 'renderer',
    description: 'Master fader in dB (-60..+6).',
    inputSchema: obj({ gainDb: num('dB') }, ['gainDb'])
  },
  {
    name: 'transport',
    where: 'renderer',
    description:
      'play | stop | seek | record_start | record_stop. record_start records every rec-armed track from the playhead; set synthetic=true to record a deterministic built-in test signal (L 220 Hz, R 330 Hz, 0.5 amp) with no hardware. record_stop commits the takes as clips.',
    inputSchema: obj(
      {
        action: { type: 'string', enum: ['play', 'stop', 'seek', 'record_start', 'record_stop'] },
        seconds: num('seek / start position in seconds'),
        frame: num('seek / start position in frames (overrides seconds)'),
        synthetic: bool('record_start: use the built-in test signal instead of the audio interface')
      },
      ['action']
    )
  },
  {
    name: 'wait',
    where: 'renderer',
    description: 'Sleep (max 60 s) — e.g. let a recording run, or let playback progress.',
    inputSchema: obj({ ms: num('milliseconds') }, ['ms'])
  },
  {
    name: 'bounce',
    where: 'renderer',
    description:
      'Offline render of the master through the whole GPU path (no audio device, transport must be stopped) and return stats: peak/RMS dB per channel, DC, clipped frames, LUFS integrated + max short-term, a 0.5 s loudness contour. The core regression primitive: set up, bounce, compare numbers.',
    inputSchema: obj({
      startSeconds: num('default 0'),
      seconds: num('length; default = up to the last clip end'),
      tailSeconds: num('extra render past the last clip (reverb / delay tails); default 0'),
      save: bool('also write the render as a 32-bit float WAV and return its path')
    })
  },
  {
    name: 'ui_query',
    where: 'renderer',
    description: 'Inspect DOM elements by CSS selector: text, value, classes, bounding box, disabled. Max 50 matches.',
    inputSchema: obj({ selector: str('CSS selector') }, ['selector'])
  },
  {
    name: 'ui_click',
    where: 'renderer',
    description: 'Click the first element matching a CSS selector (buttons, tabs, menu rows).',
    inputSchema: obj({ selector: str('CSS selector'), index: num('which match, default 0') }, ['selector'])
  },
  {
    name: 'screenshot',
    where: 'main',
    description: 'PNG screenshot of the app window.',
    inputSchema: obj({ maxWidth: num('downscale to this width (default 1400)') })
  },
  {
    name: 'logs',
    where: 'main',
    description: 'Recent renderer console output (ring buffer, newest last). Filter by level and/or substring.',
    inputSchema: obj({
      level: { type: 'string', enum: ['all', 'warn', 'error'], description: 'default all' },
      contains: str('substring filter'),
      limit: num('max lines, default 100'),
      clear: bool('clear the buffer after reading')
    })
  },
  {
    name: 'audio_devices',
    where: 'main',
    description: 'Native audio devices (RtAudio / WASAPI view): ids, channel counts, sample rates.',
    inputSchema: obj({})
  },
  {
    name: 'app_reload',
    where: 'main',
    description: 'Reload the renderer (fresh JS state; restores the last saved project).',
    inputSchema: obj({})
  }
]

// ---- console ring buffer ----------------------------------------------------------

interface LogLine {
  t: number
  level: 'log' | 'info' | 'warn' | 'error'
  msg: string
}
const LOG_MAX = 1000
const logs: LogLine[] = []
const LEVELS: LogLine['level'][] = ['log', 'info', 'warn', 'error']

/** Feed from `webContents 'console-message'` (levels 0..3). */
export function mcpLog(level: number, message: string): void {
  logs.push({ t: Date.now(), level: LEVELS[Math.min(3, Math.max(0, level))], msg: message })
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX)
}

// ---- renderer bridge --------------------------------------------------------------

let rendererReady = false
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

ipcMain.on('daw:mcp:ready', () => {
  rendererReady = true
})
ipcMain.on('daw:mcp:reply', (_e, id: number, ok: boolean, payload: unknown) => {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  clearTimeout(p.timer)
  if (ok) p.resolve(payload)
  else p.reject(new Error(String(payload)))
})

/** The renderer page reloaded — its tool table is gone until it re-announces. */
export function mcpRendererReset(): void {
  rendererReady = false
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error('renderer reloaded'))
    pending.delete(id)
  }
}

async function callRenderer(win: BrowserWindow | null, tool: string, args: unknown): Promise<unknown> {
  if (!win || win.isDestroyed()) throw new Error('no app window')
  const t0 = Date.now()
  while (!rendererReady) {
    if (Date.now() - t0 > 30000) throw new Error('renderer not ready (still booting / WebGPU failed?)')
    await new Promise((r) => setTimeout(r, 100))
  }
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`tool ${tool} timed out`))
    }, 180000)
    pending.set(id, { resolve, reject, timer })
    win.webContents.send('daw:mcp:call', { id, tool, args })
  })
}

// ---- server ------------------------------------------------------------------------

export interface McpDeps {
  getWin: () => BrowserWindow | null
  listDevices: () => unknown
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
interface ToolOut {
  content: Content[]
  isError?: boolean
}

/** JSON can't carry -Infinity / NaN (levels of silence) — render them as strings. */
function jsonSafe(_k: string, v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity'
  return v
}
const text = (v: unknown): ToolOut => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, jsonSafe, 2) }]
})

async function runMainTool(name: string, args: Record<string, unknown>, deps: McpDeps): Promise<ToolOut> {
  const win = deps.getWin()
  switch (name) {
    case 'screenshot': {
      if (!win || win.isDestroyed()) throw new Error('no app window')
      let img = await win.webContents.capturePage()
      const maxW = Number(args['maxWidth']) || 1400
      if (img.getSize().width > maxW) img = img.resize({ width: maxW })
      return { content: [{ type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }] }
    }
    case 'logs': {
      const level = String(args['level'] ?? 'all')
      const contains = args['contains'] ? String(args['contains']) : ''
      const limit = Math.max(1, Number(args['limit']) || 100)
      let out = logs.filter((l) =>
        level === 'all' ? true : level === 'warn' ? l.level === 'warn' || l.level === 'error' : l.level === 'error'
      )
      if (contains) out = out.filter((l) => l.msg.includes(contains))
      out = out.slice(-limit)
      if (args['clear']) logs.length = 0
      return text(
        out.map((l) => `${new Date(l.t).toISOString().slice(11, 23)} [${l.level}] ${l.msg}`).join('\n') ||
          '(no log lines)'
      )
    }
    case 'audio_devices':
      return text(deps.listDevices())
    case 'app_reload':
      win?.webContents.reload()
      return text('reloading')
    case 'project_save_file': {
      const path = String(args['path'] ?? '')
      if (!path.toLowerCase().endsWith('.json')) throw new Error('path must end in .json')
      const proj = await callRenderer(win, 'project_get', {})
      await writeFile(path, JSON.stringify(proj, null, 2), 'utf8')
      return text({ saved: path })
    }
    case 'project_load_file': {
      const path = String(args['path'] ?? '')
      if (!path.toLowerCase().endsWith('.json')) throw new Error('path must end in .json')
      const proj = JSON.parse(await readFile(path, 'utf8'))
      return text(await callRenderer(win, 'project_load', { project: proj }))
    }
  }
  throw new Error(`unknown main tool ${name}`)
}

async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps): Promise<ToolOut> {
  const spec = TOOLS.find((t) => t.name === name)
  if (!spec) throw new Error(`unknown tool: ${name}`)
  try {
    if (spec.where === 'main') return await runMainTool(name, args, deps)
    return text(await callRenderer(deps.getWin(), name, args))
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true }
  }
}

interface RpcReq {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

async function handleRpc(req: RpcReq, deps: McpDeps): Promise<unknown | null> {
  const ok = (result: unknown): unknown => ({ jsonrpc: '2.0', id: req.id, result })
  const fail = (code: number, message: string): unknown => ({ jsonrpc: '2.0', id: req.id, error: { code, message } })
  if (req.id === undefined) return null // notification
  switch (req.method) {
    case 'initialize':
      return ok({
        protocolVersion: String(req.params?.['protocolVersion'] ?? '2025-03-26'),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'awaker-daw', version: '0.0.1' },
        instructions:
          'Drives the running Awaker DAW. Regression pattern: project_load → set params (track_set / strip_set / insert_set / master_set) → bounce → compare stats. Use screenshot / ui_* for UI checks and logs for console errors.'
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const name = String(req.params?.['name'] ?? '')
      const args = (req.params?.['arguments'] as Record<string, unknown> | undefined) ?? {}
      return ok(await callTool(name, args, deps))
    }
    default:
      return fail(-32601, `method not found: ${req.method}`)
  }
}

function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function startMcpServer(port: number, deps: McpDeps): Server {
  const server = createServer(async (req, res) => {
    const send = (code: number, body?: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body, jsonSafe))
    }
    try {
      const host = (req.headers.host ?? '').toLowerCase()
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'bad host' })
      if (req.headers.origin) return send(403, { error: 'browser origins are not allowed' })
      if (req.url !== '/mcp') return send(404, { error: 'POST /mcp' })
      if (req.method !== 'POST') return send(405, { error: 'POST only' })
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return send(415, { error: 'content-type must be application/json' })
      }
      const msg = JSON.parse(await readBody(req)) as RpcReq | RpcReq[]
      if (Array.isArray(msg)) {
        const outs = (await Promise.all(msg.map((m) => handleRpc(m, deps)))).filter((o) => o !== null)
        return outs.length ? send(200, outs) : send(202)
      }
      const out = await handleRpc(msg, deps)
      return out === null ? send(202) : send(200, out)
    } catch (err) {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: String((err as Error).message) } })
    }
  })
  server.listen(port, '127.0.0.1', () => console.log(`[mcp] listening on http://127.0.0.1:${port}/mcp`))
  server.on('error', (err) => console.error('[mcp] server error:', err))
  return server
}
