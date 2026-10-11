// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { app, BrowserWindow, ipcMain, dialog, Menu, session, type MenuItemConstructorOptions } from 'electron'
import { readFile, readdir, writeFile, mkdir, rm, rename, open as fsOpen, stat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { NativeAudioOut, type AudioOutConfig } from './audio-out'
import { startMcpServer, mcpLog, mcpRendererReset } from './mcp'
import { initAi } from './ai'
import { buildZip, listZip, readZipEntry, safeBaseName, type ZipInput } from './zip'
import { parseWavInfo } from './wavinfo'

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

/** The app icon (a temporary one): beside the app when packaged, in build/ when running from the repo. */
function appIconPath(): string | undefined {
  const p = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(p) ? p : undefined
}

function createWindow(): void {
  const win = new BrowserWindow({
    icon: appIconPath(),
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

  // DevTools stays closed unless asked for (DAW_DEVTOOLS=1, or View → Toggle DevTools): people do not use it,
  // and everything it would show is also available without it — warnings / errors go to the terminal below,
  // and the MCP `logs` tool keeps the whole console.
  if (!app.isPackaged && process.env['DAW_DEVTOOLS']) win.webContents.openDevTools({ mode: 'detach' })

  // Mirror renderer console warnings/errors to the terminal — GPU pipeline / WGSL failures show up there.
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
  const file = (op: string): void => win.webContents.send('daw:file', op)
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => file('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => file('open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => file('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => file('saveas') },
        { type: 'separator' },
        {
          label: 'Import',
          submenu: [
            { label: 'DAWproject…', click: () => file('import-dawproject') },
            { label: 'MIDI file…', click: () => file('import-midi') }
          ]
        },
        {
          label: 'Export',
          submenu: [
            { label: 'DAWproject…', click: () => file('export-dawproject') },
            { label: 'MIDI file…', click: () => file('export-midi') },
            { label: 'Stems…', click: () => file('export-stems') },
            { label: 'Mixdown…', click: () => file('export-mixdown') }
          ]
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
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

/**
 * Open a `.dawproject` (Cubase 14+, Bitwig, Studio One…). The container is unzipped
 * here (Node zlib): `project.xml` goes back as text, every `.wav` is extracted to a
 * per-import folder under userData so the normal path-based source loader can read
 * it, and `files` maps archive path → extracted path. Parsing happens in the renderer.
 */
ipcMain.handle('daw:dawproject:open', async (_e, explicitPath?: string) => {
  try {
    let filePath = typeof explicitPath === 'string' && explicitPath ? explicitPath : ''
    if (!filePath) {
      const res = await dialog.showOpenDialog({
        title: 'Import DAWproject',
        properties: ['openFile'],
        filters: [{ name: 'DAWproject', extensions: ['dawproject'] }]
      })
      if (res.canceled || res.filePaths.length === 0) return null
      filePath = res.filePaths[0]
    }
    const zip = await readFile(filePath)
    const entries = listZip(zip)
    const projEntry = entries.find((en) => en.name === 'project.xml')
    if (!projEntry) throw new Error('project.xml not found in the archive')
    const xml = readZipEntry(zip, projEntry, 256 * 1024 * 1024).toString('utf8')

    const stem = safeBaseName(filePath).replace(/\.[^.]*$/, '') || 'project'
    const outDir = join(app.getPath('userData'), 'dawproject', stem)
    await rm(outDir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: true })

    const files: Record<string, string> = {}
    const skipped: string[] = []
    let n = 0
    for (const en of entries) {
      if (en.name.endsWith('/') || en.name === 'project.xml' || en.name === 'metadata.xml') continue
      if (!en.name.toLowerCase().endsWith('.wav')) {
        if (/\.(flac|mp3|ogg|aif|aiff|m4a)$/i.test(en.name)) skipped.push(en.name)
        continue
      }
      const dest = join(outDir, `${String(++n).padStart(3, '0')}_${safeBaseName(en.name)}`)
      await writeFile(dest, readZipEntry(zip, en))
      files[en.name] = dest
    }
    console.log('[dawproject] imported', filePath, `(${Object.keys(files).length} wav)`)
    return { ok: true as const, name: stem, xml, files, skipped }
  } catch (err) {
    console.error('[dawproject] import failed', err)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

/** Open a Standard MIDI File (dialog, or an explicit path for tests / MCP). */
ipcMain.handle('daw:midi:open', async (_e, explicitPath?: string) => {
  try {
    let filePath = typeof explicitPath === 'string' && explicitPath ? explicitPath : ''
    if (!filePath) {
      const res = await dialog.showOpenDialog({
        title: 'Import MIDI file',
        properties: ['openFile'],
        filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }]
      })
      if (res.canceled || res.filePaths.length === 0) return null
      filePath = res.filePaths[0]
    }
    if (!/\.midi?$/i.test(filePath)) throw new Error('not a .mid file')
    const buf = await readFile(filePath)
    if (buf.length > 64 * 1024 * 1024) throw new Error('MIDI file too large')
    return {
      ok: true as const,
      name: safeBaseName(filePath).replace(/\.[^.]*$/, ''),
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
  } catch (err) {
    console.error('[midi] open failed', err)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

/** Save Standard MIDI File bytes (dialog, or an explicit path for tests / MCP). */
ipcMain.handle('daw:midi:save', async (_e, bytes: ArrayBuffer, defaultName: string, explicitPath?: string) => {
  try {
    let filePath = typeof explicitPath === 'string' && explicitPath ? explicitPath : ''
    if (!filePath) {
      const res = await dialog.showSaveDialog({
        title: 'Export MIDI file',
        defaultPath: `${safeBaseName(String(defaultName || 'project'))}.mid`,
        filters: [{ name: 'MIDI', extensions: ['mid'] }]
      })
      if (res.canceled || !res.filePath) return null
      filePath = res.filePath
    }
    if (!/\.midi?$/i.test(filePath)) throw new Error('path must end in .mid')
    await writeFile(filePath, Buffer.from(bytes))
    return { ok: true as const, path: filePath }
  } catch (err) {
    console.error('[midi] save failed', err)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

/** Header facts (channels / rate / frames) of a WAV on disk, without decoding it. */
ipcMain.handle('daw:wav:info', async (_e, path: string) => {
  try {
    if (typeof path !== 'string' || !/\.wav$/i.test(path)) throw new Error('not a .wav path')
    const size = (await stat(path)).size
    const fh = await fsOpen(path, 'r')
    try {
      const head = Buffer.alloc(Math.min(size, 4 * 1024 * 1024))
      await fh.read(head, 0, head.length, 0)
      const info = parseWavInfo(head, size)
      if (!info) throw new Error('unreadable WAV header')
      return { ok: true as const, ...info }
    } finally {
      await fh.close()
    }
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

interface DawprojectSaveReq {
  projectXml: string
  metadataXml: string
  defaultName: string
  /** `audio/…` entries: a file on disk, or bytes the renderer rendered. */
  files: { name: string; path?: string; bytes?: ArrayBuffer }[]
}

/** Write a .dawproject (zip: project.xml + metadata.xml + audio/…). */
ipcMain.handle('daw:dawproject:save', async (_e, req: DawprojectSaveReq, explicitPath?: string) => {
  try {
    let filePath = typeof explicitPath === 'string' && explicitPath ? explicitPath : ''
    if (!filePath) {
      const res = await dialog.showSaveDialog({
        title: 'Export DAWproject',
        defaultPath: `${safeBaseName(String(req.defaultName || 'project'))}.dawproject`,
        filters: [{ name: 'DAWproject', extensions: ['dawproject'] }]
      })
      if (res.canceled || !res.filePath) return null
      filePath = res.filePath
    }
    if (!/\.dawproject$/i.test(filePath)) throw new Error('path must end in .dawproject')
    const entries: ZipInput[] = [
      { name: 'project.xml', data: Buffer.from(req.projectXml, 'utf8'), deflate: true },
      { name: 'metadata.xml', data: Buffer.from(req.metadataXml, 'utf8'), deflate: true }
    ]
    for (const f of req.files) {
      if (!/^audio\/[^/\\]+\.wav$/i.test(f.name) || f.name.includes('..')) throw new Error(`bad archive name: ${f.name}`)
      let data: Buffer
      if (f.path) {
        if (!/\.wav$/i.test(f.path)) throw new Error(`not a .wav: ${f.path}`)
        if ((await stat(f.path)).size > 1.5 * 1024 * 1024 * 1024) throw new Error(`file too large to export: ${f.path}`)
        data = await readFile(f.path)
      } else if (f.bytes) {
        data = Buffer.from(f.bytes)
      } else {
        throw new Error(`no data for ${f.name}`)
      }
      entries.push({ name: f.name, data })
    }
    await writeFile(filePath, buildZip(entries))
    console.log('[dawproject] exported', filePath, `(${req.files.length} audio files)`)
    return { ok: true as const, path: filePath }
  } catch (err) {
    console.error('[dawproject] export failed', err)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

// ---- options file -----------------------------------------------------------------------------
// One JSON file with a fixed name in the user-data folder. The renderer owns the contents (see
// renderer/src/ui/options-model.ts); main only reads and writes it. Written to a temp file first and
// renamed over the real one, so a crash mid-write can never leave a half-written options file.
const OPTIONS_FILE = 'awaker-options.json'
const optionsPath = (): string => join(app.getPath('userData'), OPTIONS_FILE)

ipcMain.handle('daw:options:load', async () => {
  const path = optionsPath()
  try {
    const text = await readFile(path, 'utf8')
    try {
      // a UTF-8 BOM (Windows editors / PowerShell add one) must not make the file "unreadable"
      return { ok: true as const, path, data: JSON.parse(text.replace(/^﻿/, '')) as unknown }
    } catch {
      console.warn('[options] unreadable, using defaults:', path)
      return { ok: true as const, path, data: null, warning: 'the options file is unreadable — defaults are used until you press OK' }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true as const, path, data: null } // first run
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

ipcMain.handle('daw:options:save', async (_e, data: unknown) => {
  const path = optionsPath()
  try {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('options must be an object')
    const text = JSON.stringify(data, null, 2)
    if (text.length > 256 * 1024) throw new Error('options file would be too large')
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, text + '\n', 'utf8')
    await rename(tmp, path)
    console.log('[options] saved', path)
    return { ok: true as const, path }
  } catch (err) {
    console.error('[options] save failed', err)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
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

// --- IPC: live (line-input) path ----------------------------------------------------
// Input goes to the renderer's live bus in ~256-frame batches (the recording path below batches
// ~8k frames, far too coarse for monitoring); processed blocks come back tagged with the output
// frame they belong at and are placed by frame number (see live-ring.ts).
audioOut.onLiveInput = (f, startFrame, channels) => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('daw:live:in', { startFrame, channels, data: f.buffer })
  }
}
ipcMain.on('daw:live:out', (_e, buf: ArrayBuffer, outStart: number, inStart: number) => {
  audioOut.pushLive(new Float32Array(buf), outStart, inStart)
})
ipcMain.handle('daw:live:enable', (_e, on: boolean) => {
  audioOut.setLiveEnabled(!!on)
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

// ---- stem export: folder + file writes (the renderer renders; only main touches the disk) -----------
ipcMain.handle('daw:export:pickDir', async () => {
  const res = await dialog.showOpenDialog({ title: 'Export stems to…', properties: ['openDirectory', 'createDirectory'] })
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
})

// Mixdown: the person names the file (a save dialog). Returns the folder and the bare file name, or null.
ipcMain.handle('daw:export:saveWav', async (_e, defaultName: unknown) => {
  const base = join(app.getPath('documents'), 'Awaker')
  await mkdir(base, { recursive: true }).catch(() => undefined)
  const name = String(defaultName ?? 'Mixdown.wav').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 120) || 'Mixdown.wav'
  const opts = {
    title: 'Save the mixdown as…',
    defaultPath: join(base, name),
    filters: [{ name: 'WAV audio', extensions: ['wav'] }]
  }
  const res = mainWin && !mainWin.isDestroyed() ? await dialog.showSaveDialog(mainWin, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  const p = /\.wav$/i.test(res.filePath) ? res.filePath : `${res.filePath}.wav`
  return { dir: dirname(p), name: basename(p) }
})

ipcMain.handle('daw:export:openDir', async (_e, folder: unknown, label: unknown) => {
  try {
    let dir = typeof folder === 'string' ? folder.trim() : ''
    if (!dir) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const safe = String(label ?? 'Awaker').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'Awaker'
      dir = join(app.getPath('documents'), 'Awaker', 'Stems', `${safe}_${stamp}`)
    }
    await mkdir(dir, { recursive: true })
    return { ok: true as const, dir }
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

ipcMain.handle('daw:export:writeFile', async (_e, dir: unknown, name: unknown, bytes: ArrayBuffer) => {
  try {
    const n = String(name ?? '')
    // a bare .wav file name only: no separators, no traversal, nothing but audio files from here
    if (!/^[^\\/:*?"<>|\x00-\x1f]+\.wav$/i.test(n) || n.startsWith('.')) throw new Error('bad file name')
    const path = join(String(dir ?? ''), n)
    await writeFile(path, Buffer.from(bytes))
    console.log('[export] wrote', path)
    return { ok: true as const, path }
  } catch (err) {
    console.error('[export] write failed', err)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
})

app.whenReady().then(() => {
  // Web MIDI (control surface, e.g. P1-Nano class). Sysex is needed for its LCD.
  const midiPerms = new Set(['midi', 'midiSysex'])
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(midiPerms.has(perm)))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => midiPerms.has(perm))
  createWindow()
  // AI connection (OpenAI-compatible backend; the Claude Code backend needs nothing here). Always registered:
  // it does nothing until the person picks that backend in the AI panel.
  initAi({ getWin: () => mainWin, listDevices: () => audioOut.listDevices() })
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
