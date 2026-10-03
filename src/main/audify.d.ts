// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

// Local types for `audify`, wired in via tsconfig `paths` ("audify" -> here) so
// the shipped index.d.ts is bypassed for typechecking. The real module is still
// what require("audify") loads at runtime. Only what gpudaw uses.
//
// Why bypass: audify's own d.ts declares its enums as un-exported
// `declare const enum`s (not importable) and types openStream's format/flags as
// those enums, which a plain number can't satisfy.

export const RtAudioApi: {
  UNSPECIFIED: number
  WINDOWS_ASIO: number
  WINDOWS_WASAPI: number
  WINDOWS_DS: number
  RTAUDIO_DUMMY: number
}
export const RtAudioFormat: {
  RTAUDIO_SINT8: number
  RTAUDIO_SINT16: number
  RTAUDIO_SINT24: number
  RTAUDIO_SINT32: number
  RTAUDIO_FLOAT32: number
  RTAUDIO_FLOAT64: number
}
export const RtAudioStreamFlags: {
  RTAUDIO_NONINTERLEAVED: number
  RTAUDIO_MINIMIZE_LATENCY: number
  RTAUDIO_HOG_DEVICE: number
  RTAUDIO_SCHEDULE_REALTIME: number
}

export interface RtAudioDeviceInfo {
  id: number
  name: string
  outputChannels: number
  inputChannels: number
  duplexChannels: number
  isDefaultOutput: number
  isDefaultInput: number
  sampleRates: number[]
  preferredSampleRate: number
  nativeFormats: number
}

export interface RtAudioStreamParameters {
  deviceId?: number
  nChannels: number
  firstChannel?: number
}

export class RtAudio {
  constructor(api?: number)
  outputVolume: number
  streamTime: number
  openStream(
    outputParameters: RtAudioStreamParameters | null,
    inputParameters: RtAudioStreamParameters | null,
    format: number,
    sampleRate: number,
    frameSize: number,
    streamName: string,
    inputCallback: ((inputData: Buffer) => void) | null,
    frameOutputCallback: (() => void) | null,
    flags?: number,
    errorCallback?: ((type: number, msg: string) => void) | null
  ): number
  closeStream(): void
  isStreamOpen(): boolean
  start(): void
  stop(): void
  isStreamRunning(): boolean
  write(pcm: Buffer): void
  clearOutputQueue(): void
  getApi(): string
  getStreamLatency(): number
  getStreamSampleRate(): number
  getDevices(): RtAudioDeviceInfo[]
  getDefaultInputDevice(): number
  getDefaultOutputDevice(): number
  setInputCallback(callback: ((inputData: Buffer) => void) | null): void
  setFrameOutputCallback(callback: (() => void) | null): void
}
