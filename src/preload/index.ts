// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
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
  /** Record a deterministic built-in test signal instead of hardware input. */
  inputSynthetic?: boolean
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

  listAudioDevices: (): Promise<{ devices: AudioDeviceInfo[]; defaultOutput: number }> =>
    ipcRenderer.invoke('daw:audio:devices'),

  /** Open the native output stream. */
  audioStart: (cfg: AudioOutConfig): Promise<AudioOutStatus> => ipcRenderer.invoke('daw:audio:start', cfg),

  /** Start the device pulling, after the initial look-ahead has been sent. */
  audioBegin: (): Promise<void> => ipcRenderer.invoke('daw:audio:begin'),

  audioStop: (): Promise<void> => ipcRenderer.invoke('daw:audio:stop'),

  /** Send one interleaved f32 stereo block (structured-clone copy; ~32 KB). */
  audioChunk: (interleaved: ArrayBuffer): void => ipcRenderer.send('daw:audio:chunk', interleaved),

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

  /** Edit-menu commands (cut/copy/paste/delete/split/selectAll/deselect). */
  onEditCommand: (cb: (op: string) => void): (() => void) => {
    const listener = (_e: unknown, op: string): void => cb(op)
    ipcRenderer.on('daw:edit', listener)
    return () => ipcRenderer.removeListener('daw:edit', listener)
  }
}

contextBridge.exposeInMainWorld('daw', api)

export type DawApi = typeof api
