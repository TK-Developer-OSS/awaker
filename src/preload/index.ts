// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { contextBridge, ipcRenderer } from 'electron'

export interface OpenedAudio {
  path: string
  bytes: ArrayBuffer
}

export interface AudioOutConfig {
  sampleRate: number
  blockFrames: number
  deviceId?: number
  /** Record: input channels to open alongside the output (0 = none). */
  inputChannels?: number
  /** Record a deterministic built-in test signal instead of hardware input ('impulse' = click train for alignment tests). */
  inputSynthetic?: boolean | 'impulse'
}

export interface AudioOutStatus {
  running: boolean
  sampleRate: number
  blockFrames: number
  playedFrames: number
  bufferedFrames: number
  underrunFrames: number
  streamLatencyFrames: number
  deviceName: string
  /** Which native backend opened: "ASIO", "WASAPI(excl)", "WASAPI". */
  backend: string
  inputChannels: number
  inputError: string
  inputFrames: number
  /** Live (line-input) path: counters and timing. All zero while no live lane is active. */
  live: {
    enabled: boolean
    blocks: number
    late: number
    tooFar: number
    /** Input block arrival in main -> processed block back in main (ms): mean / max. */
    rttMeanMs: number
    rttMaxMs: number
    /** Frames between a block's input position and the output frame it was placed at. */
    deltaFrames: number
    /** Synthetic-impulse self-test: impulses seen at the output and the worst position error (frames). */
    alignImpulses: number
    alignMaxErrFrames: number
  }
}

export interface RecChunk {
  /** Input frame index of the first frame in `data` (since the device began pulling). */
  startFrame: number
  channels: number
  /** Interleaved f32. */
  data: ArrayBuffer
}

export interface AudioDeviceInfo {
  id: number
  name: string
  inputChannels: number
  outputChannels: number
  isDefaultOutput: number
  sampleRates: number[]
  preferredSampleRate: number
}

const api = {
  /** Native multi-select file picker → chosen WAV paths (bytes fetched separately). */
  openAudioFiles: (): Promise<string[] | null> => ipcRenderer.invoke('daw:openAudioFiles'),

  /** Read one WAV's raw bytes (decoded in the renderer). */
  readAudioFile: (path: string): Promise<OpenedAudio> => ipcRenderer.invoke('daw:readAudioFile', path),

  /** Test-bed: WAV paths to auto-load on startup (empty if disabled). */
  autoloadWavs: (): Promise<string[]> => ipcRenderer.invoke('daw:autoloadWavs'),

  /** Restore the last-saved project (canonical file), or null if none. */
  projectLoad: (): Promise<unknown | null> => ipcRenderer.invoke('daw:project:load'),

  /** Save the project to the canonical file (relaunch restores it). */
  projectSave: (
    data: unknown
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:project:save', data),

  /** Save-as via a native dialog; also refreshes the canonical file. */
  projectExport: (
    data: unknown
  ): Promise<{ ok: true; path: string } | { ok: false; error: string } | null> =>
    ipcRenderer.invoke('daw:project:export', data),

  /** Open a project file via a native dialog; also refreshes the canonical file. */
  projectImport: (): Promise<unknown | null> => ipcRenderer.invoke('daw:project:import'),

  /** Import a .dawproject (Cubase 14+): returns project.xml text + extracted WAV paths, null if cancelled. */
  dawprojectOpen: (
    path?: string
  ): Promise<
    | { ok: true; name: string; xml: string; files: Record<string, string>; skipped: string[] }
    | { ok: false; error: string }
    | null
  > => ipcRenderer.invoke('daw:dawproject:open', path),

  /** Import a Standard MIDI File (dialog or explicit path); null if cancelled. */
  midiOpen: (
    path?: string
  ): Promise<{ ok: true; name: string; bytes: ArrayBuffer } | { ok: false; error: string } | null> =>
    ipcRenderer.invoke('daw:midi:open', path),

  /** Save SMF bytes (dialog or explicit path); null if cancelled. */
  midiSave: (
    bytes: ArrayBuffer,
    defaultName: string,
    path?: string
  ): Promise<{ ok: true; path: string } | { ok: false; error: string } | null> =>
    ipcRenderer.invoke('daw:midi:save', bytes, defaultName, path),

  /** Header facts of a WAV on disk (no decoding). */
  wavInfo: (
    path: string
  ): Promise<
    { ok: true; channels: number; sampleRate: number; bitsPerSample: number; frames: number } | { ok: false; error: string }
  > => ipcRenderer.invoke('daw:wav:info', path),

  /** Write a .dawproject container (dialog or explicit path); null if cancelled. */
  dawprojectSave: (
    req: {
      projectXml: string
      metadataXml: string
      defaultName: string
      files: { name: string; path?: string; bytes?: ArrayBuffer }[]
    },
    path?: string
  ): Promise<{ ok: true; path: string } | { ok: false; error: string } | null> =>
    ipcRenderer.invoke('daw:dawproject:save', req, path),

  /** Read the options file (fixed name, user-data folder). `data` is null on the first run. */
  optionsLoad: (): Promise<{ ok: true; path: string; data: unknown; warning?: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:options:load'),

  /** Write the options file (atomic: temp file + rename). */
  optionsSave: (data: unknown): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:options:save', data),

  listAudioDevices: (): Promise<{ devices: AudioDeviceInfo[]; defaultOutput: number }> =>
    ipcRenderer.invoke('daw:audio:devices'),

  /** Open the native output stream. */
  audioStart: (cfg: AudioOutConfig): Promise<AudioOutStatus> => ipcRenderer.invoke('daw:audio:start', cfg),

  /** Start the device pulling, after the initial look-ahead has been sent. */
  audioBegin: (): Promise<void> => ipcRenderer.invoke('daw:audio:begin'),

  audioStop: (): Promise<void> => ipcRenderer.invoke('daw:audio:stop'),

  /** Send one interleaved f32 stereo block (structured-clone copy; ~32 KB). */
  audioChunk: (interleaved: ArrayBuffer): void => ipcRenderer.send('daw:audio:chunk', interleaved),

  /** Turn the main-side live path on / off (cheap when off). */
  liveEnable: (on: boolean): Promise<void> => ipcRenderer.invoke('daw:live:enable', on),

  /** A processed live block, to be mixed at output frame `outStart`; `inStart` = its input frame (for timing stats). */
  liveOut: (interleaved: ArrayBuffer, outStart: number, inStart: number): void =>
    ipcRenderer.send('daw:live:out', interleaved, outStart, inStart),

  /** Raw line input for the live bus, ~256 frames per message. */
  onLiveIn: (cb: (c: RecChunk) => void): (() => void) => {
    const listener = (_e: unknown, c: RecChunk): void => cb(c)
    ipcRenderer.on('daw:live:in', listener)
    return () => ipcRenderer.removeListener('daw:live:in', listener)
  },

  onAudioStatus: (cb: (s: AudioOutStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: AudioOutStatus): void => cb(s)
    ipcRenderer.on('daw:audio:status', listener)
    return () => ipcRenderer.removeListener('daw:audio:status', listener)
  },

  /** Recorded input blocks (batched) from the native duplex stream. */
  onRecChunk: (cb: (c: RecChunk) => void): (() => void) => {
    const listener = (_e: unknown, c: RecChunk): void => cb(c)
    ipcRenderer.on('daw:rec:chunk', listener)
    return () => ipcRenderer.removeListener('daw:rec:chunk', listener)
  },

  /** Push any batched input still held in main to the renderer (call before audioStop). */
  recFlush: (): Promise<void> => ipcRenderer.invoke('daw:rec:flush'),

  /** Write a finished take as a 32-bit float WAV; returns its path. */
  recWriteWav: (
    name: string,
    sampleRate: number,
    channels: number,
    interleaved: ArrayBuffer
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:rec:writeWav', name, sampleRate, channels, interleaved),

  /** MCP (DAW_MCP=1): main forwards tool calls here; the renderer answers with mcpReply. */
  onMcpCall: (cb: (c: { id: number; tool: string; args: Record<string, unknown> }) => void): void => {
    ipcRenderer.on('daw:mcp:call', (_e, c) => cb(c))
    ipcRenderer.send('daw:mcp:ready')
  },
  mcpReply: (id: number, ok: boolean, payload: unknown): void => ipcRenderer.send('daw:mcp:reply', id, ok, payload),
  /** The MCP server's connection URL ('' when MCP is off). */
  mcpUrl: (): Promise<string> => ipcRenderer.invoke('daw:mcp:url'),

  /**
   * AI connection (src/main/ai.ts). The settings are ordinary Options (renderer side); the OpenAI-compatible
   * API key is write-only from here: `aiSetKey` saves / deletes it (one per connection), nothing ever returns it.
   * `claudePath` probes where Claude Code would be found ('' = look in the usual places).
   */
  aiGet: (
    backend: string,
    claudePath?: string
  ): Promise<{
    keyState: 'none' | 'saved' | 'env'
    canStoreKey: boolean
    envVar: string
    busy: boolean
    claudeFound: string | null
    logPath: string
    defaultPrompt: string
    skillsDir: string
  }> =>
    ipcRenderer.invoke('daw:ai:get', backend, claudePath ?? ''),
  aiSetKey: (backend: string, apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:ai:key', backend, apiKey),
  /** Send one chat line to the built-in backend described by `cfg` (claude-app | openai). */
  aiSend: (
    text: string,
    cfg: { backend: string; baseUrl: string; model: string; claudePath: string; claudeModel: string; numCtx: number; maxSteps: number; systemPrompt: string }
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('daw:ai:send', text, cfg),
  /** Models installed in Ollama (for the picker in Options → AI). */
  aiOllamaModels: (
    baseUrl: string
  ): Promise<{ ok: true; models: { name: string; sizeGB: number }[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:ai:ollamaModels', baseUrl),
  /** The text of an app skill (SKILL.md) by name. */
  skillGet: (name: string): Promise<{ ok: true; name: string; body: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:skills:get', name),
  aiAbort: (): Promise<void> => ipcRenderer.invoke('daw:ai:abort'),
  aiReset: (): Promise<void> => ipcRenderer.invoke('daw:ai:reset'),
  onAiSay: (cb: (text: string) => void): void => {
    ipcRenderer.on('daw:ai:say', (_e, t: string) => cb(t))
  },
  onAiBusy: (cb: (busy: boolean) => void): void => {
    ipcRenderer.on('daw:ai:busy', (_e, b: boolean) => cb(b))
  },

  /** Stem export: ask for a folder (null = cancelled). */
  exportPickDir: (): Promise<string | null> => ipcRenderer.invoke('daw:export:pickDir'),
  /** Stem export: make sure the folder exists (empty = a new timestamped folder under Documents/Awaker/Stems). */
  exportOpenDir: (folder: string, label: string): Promise<{ ok: true; dir: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:export:openDir', folder, label),
  /** Mixdown: a save dialog for the file name → { dir, name } (null = cancelled). */
  exportSaveWav: (defaultName: string): Promise<{ dir: string; name: string } | null> => ipcRenderer.invoke('daw:export:saveWav', defaultName),
  /** Stem export: write one .wav into that folder (bare file name only). */
  exportWriteFile: (dir: string, name: string, bytes: ArrayBuffer): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('daw:export:writeFile', dir, name, bytes),

  /** File-menu commands (new/open/save/saveas/import-*, export-*). */
  onFileCommand: (cb: (op: string) => void): (() => void) => {
    const listener = (_e: unknown, op: string): void => cb(op)
    ipcRenderer.on('daw:file', listener)
    return () => ipcRenderer.removeListener('daw:file', listener)
  },

  /** Edit-menu commands (cut/copy/paste/delete/split/selectAll/deselect). */
  onEditCommand: (cb: (op: string) => void): (() => void) => {
    const listener = (_e: unknown, op: string): void => cb(op)
    ipcRenderer.on('daw:edit', listener)
    return () => ipcRenderer.removeListener('daw:edit', listener)
  }
}

contextBridge.exposeInMainWorld('daw', api)

export type DawApi = typeof api
