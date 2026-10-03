// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { app, BrowserWindow, ipcMain, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { NativeAudioOut, type AudioOutConfig } from './audio-out'
import { startMcpServer, mcpLog, mcpRendererReset } from './mcp'

// 当面のテストベッド: `DAW_AUTOLOAD=<dir>` を指定すると、保存済みプロジェクトが無い
// 起動時にそのフォルダの WAV を全部トラックとして自動ロード。未設定 / 空なら無効。
const AUTOLOAD_DIR = process.env['DAW_AUTOLOAD'] ?? ''

// Main + preload are built as CJS by electron-vite (no "type": "module" in
// package.json), so __dirname is available directly. See docs/ARCHITECTURE.md.

// WebGPU is enabled by default in recent Chromium, but keep the unsafe flag as a
// belt-and-suspenders for older GPUs / driver combos on Windows. Do NOT force a
// specific backend (e.g. Vulkan) here — that breaks WebGPU on machines lacking it.
app.commandLine.appendSwitch('enable-unsafe-webgpu')
// The look-ahead pump runs on renderer timers + rAF. When the window is covered /
// unfocused Chromium would throttle them to ~1 Hz (→ underruns, frozen playhead);
// an audio app must keep full-rate timers regardless, and so must unattended MCP runs.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// Display name is "Awaker DAW over GPU" (package.json productName / window title),
// but pin the internal app name so userData stays a clean, stable
// %APPDATA%/awaker — independent of any later display-name tweak.
app.setName('awaker')

const audioOut = new NativeAudioOut()
let statusTimer: NodeJS.Timeout | null = null
let mainWin: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    // Fallback size if un-maximized; we start maximized (the mixer + full-height
    // left pane need the room).
    width: 1728,
    height: 1064,
    backgroundColor: '#0b0d12',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })

  mainWin = win
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
  })
  win.maximize()
  win.once('ready-to-show', () => win.show())

  // `DAW_SELFTEST` → headless smoke test. Value becomes `&mode=<value>`
  // (e.g. DAW_SELFTEST=resample exercises the GPU resampler).
  const st = process.env['DAW_SELFTEST']
  const q = st ? `?selftest${st === '1' || st === 'true' ? '' : `&mode=${encodeURIComponent(st)}`}` : ''
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + q)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { search: q })
  }

  buildMenu(win)

  if (!app.isPackaged) win.webContents.openDevTools({ mode: 'detach' })

  // Mirror renderer console warnings/errors to the terminal — the detached
  // DevTools is easy to miss, and GPU pipeline / WGSL failures only show there.
  win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) mcpRendererReset() // page (re)loading: its MCP tool table is gone
  })
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    mcpLog(level, message) // MCP `logs` tool keeps everything, not just warn/error
    if (level < 2) return // 0 = log, 1 = info/warn-ish; only surface warnings (2) + errors (3)
    const tag = level >= 3 ? '[renderer:error]' : '[renderer:warn]'
    const where = sourceId ? ` (${sourceId.split('/').pop()}:${line})` : ''
    console.log(`${tag}${where} ${message}`)
  })
}

/**
 * Application menu. The **Edit** items don't touch the DOM clipboard — they send
 * `daw:edit <op>` and the renderer decides (timeline op, or fall through to the
 * native field edit when a text input is focused).
 */
function buildMenu(win: BrowserWindow): void {
  const edit = (op: string): void => win.webContents.send('daw:edit', op)
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => edit('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => edit('redo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', visible: false, click: () => edit('redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => edit('cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => edit('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => edit('paste') },
        { label: 'Delete', accelerator: 'Delete', click: () => edit('delete') },
        { type: 'separator' },
        { label: 'Split at Playhead', accelerator: 'CmdOrCtrl+E', click: () => edit('split') },
        { label: 'Select All Clips', accelerator: 'CmdOrCtrl+A', click: () => edit('selectAll') },
        { label: 'Deselect', accelerator: 'CmdOrCtrl+Shift+A', click: () => edit('deselect') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// --- IPC: disk + audio device access live in main; renderer stays GPU + UI ----

// Pick one or more WAVs; returns just the paths. The renderer then pulls bytes
// one file at a time (`daw:readAudioFile`) so a big stem set isn't all held in
// memory / shipped over IPC at once.
ipcMain.handle('daw:openAudioFiles', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['wav'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths
})

ipcMain.handle('daw:readAudioFile', async (_e, path: string) => {
  if (typeof path !== 'string' || path.toLowerCase().slice(-4) !== '.wav') {
    throw new Error(`refusing to read non-wav path: ${path}`)
  }
  const buf = await readFile(path)
  return { path, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
})

// Test-bed auto-load: full paths of the .wav files in AUTOLOAD_DIR (sorted).
ipcMain.handle('daw:autoloadWavs', async () => {
  if (!AUTOLOAD_DIR) return []
  try {
    const names = await readdir(AUTOLOAD_DIR)
    return names
      .filter((n) => n.toLowerCase().endsWith('.wav'))
      .sort()
      .map((n) => join(AUTOLOAD_DIR, n))
  } catch (err) {
    console.error('[autoload] cannot read', AUTOLOAD_DIR, err)
    return []
  }
})

// --- IPC: project save / load --------------------------------------------------
// The canonical project file. `save` writes it; `load` (called on startup)
// restores it instead of the test-bed autoload. The dialog-based `export` /
// `import` also refresh the canonical file, so the app always relaunches into
// whatever project was last touched.
//
// Preferred location is the per-user app-data dir; but this dev box has shown
// access-denied on that path (the Chromium disk-cache errors), so we fall back
// to a file next to the app if userData isn't writable, and remember which one
// worked for the rest of the session.
const PROJECT_BASENAME = 'awaker-project.json'
// App renamed gpudaw → Awaker (2026-09-07). app.setName('awaker') pins userData
// to %APPDATA%/awaker; keep the pre-rename %APPDATA%/gpudaw/gpudaw-project.json as
// a read fallback so an old session still auto-restores. The next Save writes the
// new path.
const LEGACY_BASENAME = 'gpudaw-project.json'

function candidateProjectPaths(): string[] {
  const paths: string[] = []
  try {
    const ud = app.getPath('userData')
    paths.push(join(ud, PROJECT_BASENAME))
    paths.push(join(dirname(ud), 'gpudaw', LEGACY_BASENAME)) // pre-rename userData
  } catch {
    /* getPath can throw before app is ready / on odd installs */
  }
  try {
    paths.push(join(app.getPath('documents'), 'Awaker', PROJECT_BASENAME))
    paths.push(join(app.getPath('documents'), 'gpudaw', LEGACY_BASENAME))
  } catch {
    /* ignore */
  }
  // Last resort: alongside the app (repo root in dev, resources dir when packaged).
  paths.push(join(app.getAppPath(), PROJECT_BASENAME))
  paths.push(join(app.getAppPath(), LEGACY_BASENAME))
  return paths
}

/** The path a previous save/load in this session actually used. */
let resolvedProjectPath: string | null = null

async function writeCanonicalProject(data: unknown): Promise<string> {
  const json = JSON.stringify(data, null, 2)
  const tried = resolvedProjectPath ? [resolvedProjectPath] : candidateProjectPaths()
  let lastErr: unknown
  for (const p of tried) {
    try {
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, json, 'utf8')
      resolvedProjectPath = p
      return p
    } catch (err) {
      lastErr = err
      console.error('[project] could not write', p, '-', (err as Error)?.message ?? err)
    }
  }
  throw new Error(`no writable location (tried ${tried.length}): ${(lastErr as Error)?.message ?? lastErr}`)
}

async function readCanonicalProject(): Promise<unknown | null> {
  for (const p of resolvedProjectPath ? [resolvedProjectPath] : candidateProjectPaths()) {
    try {
      const data = JSON.parse(await readFile(p, 'utf8'))
      resolvedProjectPath = p
      return data
    } catch {
      /* try the next candidate */
    }
  }
  return null // nothing saved yet
}

ipcMain.handle('daw:project:load', async () => {
  const data = await readCanonicalProject()
  console.log('[project] load', resolvedProjectPath ?? '(none)', data ? 'ok' : 'empty')
  return data
})

ipcMain.handle('daw:project:save', async (_e, data: unknown) => {
  try {
    const path = await writeCanonicalProject(data)
    console.log('[project] saved', path)
    return { ok: true as const, path }
  } catch (err) {
    console.error('[project] save failed', err)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

ipcMain.handle('daw:project:export', async (_e, data: unknown) => {
  try {
    const res = await dialog.showSaveDialog({
      title: 'Save project',
      defaultPath: 'project.awaker.json',
      filters: [{ name: 'Awaker project', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, JSON.stringify(data, null, 2), 'utf8')
    await writeCanonicalProject(data).catch(() => {}) // best-effort: relaunch restores this one
    console.log('[project] exported', res.filePath)
    return { ok: true as const, path: res.filePath }
  } catch (err) {
    console.error('[project] export failed', err)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

ipcMain.handle('daw:project:import', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Open project',
    properties: ['openFile'],
    filters: [{ name: 'Awaker project', extensions: ['json'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  try {
    const data = JSON.parse(await readFile(res.filePaths[0], 'utf8'))
    await writeCanonicalProject(data).catch(() => {}) // relaunch restores this one
    return data
  } catch (err) {
    console.error('[project] import failed', err)
    return null
  }
})

ipcMain.handle('daw:audio:devices', () => audioOut.listDevices())

ipcMain.handle('daw:audio:start', (e, cfg: AudioOutConfig) => {
  const status = audioOut.start(cfg)
  const wc = e.sender
  statusTimer ??= setInterval(() => {
    if (wc.isDestroyed()) return
    wc.send('daw:audio:status', audioOut.status())
  }, 100)
  return status
})

ipcMain.handle('daw:audio:begin', () => audioOut.begin())

ipcMain.handle('daw:audio:stop', () => {
  audioOut.stop()
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
})

// Interleaved f32 stereo block from the renderer's GPGPU master readback.
ipcMain.on('daw:audio:chunk', (_e, buf: ArrayBuffer) => {
  audioOut.pushChunk(new Float32Array(buf))
})

// --- IPC: recording ---------------------------------------------------------------
// The native duplex callback fires every device block (can be 64 frames at 192 kHz);
// batch to ~8k frames so the renderer isn't flooded with tiny IPC messages.
const REC_BATCH_FRAMES = 8192
let recPending: Float32Array[] = []
let recPendingFrames = 0
let recPendingStart = 0
let recChannels = 0

function flushRec(): void {
  if (recPendingFrames === 0) return
  const out = new Float32Array(recPendingFrames * recChannels)
  let o = 0
  for (const a of recPending) {
    out.set(a, o)
    o += a.length
  }
  const startFrame = recPendingStart
  recPending = []
  recPendingFrames = 0
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('daw:rec:chunk', { startFrame, channels: recChannels, data: out.buffer })
  }
}

audioOut.onInput = (f, startFrame, channels) => {
  if (recPendingFrames === 0) {
    recPendingStart = startFrame
    recChannels = channels
  }
  recPending.push(f)
  recPendingFrames += f.length / channels
  if (recPendingFrames >= REC_BATCH_FRAMES) flushRec()
}

ipcMain.handle('daw:rec:flush', () => flushRec())

/** Minimal 32-bit float WAV (format 3) writer — recordings keep the pipeline's native precision. */
function floatWav(sampleRate: number, channels: number, data: Buffer): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(3, 20) // IEEE float
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * 4, 28)
  h.writeUInt16LE(channels * 4, 32)
  h.writeUInt16LE(32, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

function recordingsDir(): string {
  try {
    return join(app.getPath('userData'), 'recordings')
  } catch {
    return join(app.getPath('documents'), 'Awaker', 'recordings')
  }
}

ipcMain.handle(
  'daw:rec:writeWav',
  async (_e, name: string, sampleRate: number, channels: number, interleaved: ArrayBuffer) => {
    try {
      const safe = String(name).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'take'
      const dir = recordingsDir()
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${safe}.wav`)
      await writeFile(path, floatWav(sampleRate, channels, Buffer.from(interleaved)))
      console.log('[rec] wrote', path)
      return { ok: true as const, path }
    } catch (err) {
      console.error('[rec] writeWav failed', err)
      return { ok: false as const, error: String((err as Error)?.message ?? err) }
    }
  }
)

app.whenReady().then(() => {
  createWindow()
  if (process.env['DAW_MCP']) {
    startMcpServer(Number(process.env['DAW_MCP_PORT']) || 7777, {
      getWin: () => mainWin,
      listDevices: () => audioOut.listDevices()
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  audioOut.stop()
  if (process.platform !== 'darwin') app.quit()
})
