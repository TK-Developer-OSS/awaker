// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)
//
// Awaker's audio I/O module: the RtAudio class the app uses (the same shape as audify's), on top of the
// native module built by scripts/build-audio.mjs (RtAudio + cwASIO + Node-API, built with MinGW).
'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Two native files can exist:
 *   awaker_audio.node       WASAPI only — ships with the app, contains no ASIO code.
 *   awaker_audio_asio.node  the optional ASIO add-on (WASAPI + ASIO through cwASIO). Put it in the SAME FOLDER as
 *                           awaker_audio.node (native/audio/build), or next to Awaker.exe, and the app uses it;
 *                           take it away and the app is WASAPI only again.
 * AWAKER_AUDIO_NODE=<file> names one explicitly (tests, debugging).
 */
const BASE = 'awaker_audio.node'
const ADDON = 'awaker_audio_asio.node'

function candidates() {
  const here = path.join(__dirname, 'build')
  const exeDir = process.execPath ? path.dirname(process.execPath) : ''
  const res = process.resourcesPath || ''
  return [
    process.env.AWAKER_AUDIO_NODE || '',
    path.join(here, ADDON),
    exeDir ? path.join(exeDir, ADDON) : '',
    res ? path.join(res, ADDON) : '',
    path.join(here, BASE),
    res ? path.join(res, BASE) : ''
  ].filter(Boolean)
}

function findNative() {
  const list = candidates()
  for (const c of list) {
    if (!fs.existsSync(c)) continue
    try {
      return { mod: require(c), file: c }
    } catch (err) {
      // a damaged / foreign add-on must not take the whole audio away: go on to the next candidate
      if (c === process.env.AWAKER_AUDIO_NODE) throw err
    }
  }
  throw new Error(
    'awaker-audio: the native module is not built (looked for ' + list.join(', ') + '). Build it with: npm run build:audio'
  )
}

const found = findNative()
const native = found.mod

const RtAudioApi = {
  UNSPECIFIED: 0,
  MACOSX_CORE: 1,
  LINUX_ALSA: 2,
  UNIX_JACK: 3,
  LINUX_PULSE: 4,
  LINUX_OSS: 5,
  WINDOWS_ASIO: 6,
  WINDOWS_WASAPI: 7,
  WINDOWS_DS: 8,
  RTAUDIO_DUMMY: 9
}

const RtAudioFormat = {
  RTAUDIO_SINT8: 0x1,
  RTAUDIO_SINT16: 0x2,
  RTAUDIO_SINT24: 0x4,
  RTAUDIO_SINT32: 0x8,
  RTAUDIO_FLOAT32: 0x10,
  RTAUDIO_FLOAT64: 0x20
}

const RtAudioStreamFlags = {
  RTAUDIO_NONINTERLEAVED: 0x1,
  RTAUDIO_MINIMIZE_LATENCY: 0x2,
  RTAUDIO_HOG_DEVICE: 0x4,
  RTAUDIO_SCHEDULE_REALTIME: 0x8,
  RTAUDIO_ALSA_USE_DEFAULT: 0x10,
  RTAUDIO_JACK_DONT_CONNECT: 0x20
}

const RtAudioErrorType = {
  WARNING: 0,
  DEBUG_WARNING: 1,
  UNSPECIFIED: 2,
  NO_DEVICES_FOUND: 3,
  INVALID_DEVICE: 4,
  MEMORY_ERROR: 5,
  INVALID_PARAMETER: 6,
  INVALID_USE: 7,
  DRIVER_ERROR: 8,
  SYSTEM_ERROR: 9,
  THREAD_ERROR: 10
}

// An RtAudio object that is dropped without closing its stream is cleaned up when it is collected.
const registry = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((h) => {
  try {
    native.destroy(h)
  } catch {
    /* already gone */
  }
}) : null

class RtAudio {
  constructor(api) {
    this._h = native.create(api === undefined ? RtAudioApi.UNSPECIFIED : api)
    if (registry) registry.register(this, this._h, this)
  }

  openStream(outputParameters, inputParameters, format, sampleRate, frameSize, streamName, inputCallback, frameOutputCallback, flags, errorCallback) {
    return native.openStream(
      this._h,
      outputParameters || null,
      inputParameters || null,
      format,
      sampleRate,
      frameSize,
      streamName || 'awaker',
      inputCallback || null,
      frameOutputCallback || null,
      flags || 0,
      errorCallback || null
    )
  }
  closeStream() {
    native.closeStream(this._h)
  }
  isStreamOpen() {
    return native.isStreamOpen(this._h)
  }
  start() {
    native.start(this._h)
  }
  stop() {
    native.stop(this._h)
  }
  isStreamRunning() {
    return native.isStreamRunning(this._h)
  }
  write(pcm) {
    native.write(this._h, pcm)
  }
  clearOutputQueue() {
    native.clearOutputQueue(this._h)
  }
  getApi() {
    return native.getApi(this._h)
  }
  getStreamLatency() {
    return native.getStreamLatency(this._h)
  }
  getStreamSampleRate() {
    return native.getStreamSampleRate(this._h)
  }
  getDevices() {
    return native.getDevices(this._h)
  }
  getDefaultInputDevice() {
    return native.getDefaultInputDevice(this._h)
  }
  getDefaultOutputDevice() {
    return native.getDefaultOutputDevice(this._h)
  }
  setInputCallback(cb) {
    native.setInputCallback(this._h, cb || null)
  }
  setFrameOutputCallback(cb) {
    native.setFrameOutputCallback(this._h, cb || null)
  }
  get streamTime() {
    return native.getStreamTime(this._h)
  }
  set streamTime(v) {
    native.setStreamTime(this._h, v)
  }
  get outputVolume() {
    return native.getOutputVolume(this._h)
  }
  set outputVolume(v) {
    native.setOutputVolume(this._h, v)
  }
  /** Release everything now (otherwise it happens when the object is collected). */
  dispose() {
    if (this._h) {
      if (registry) registry.unregister(this)
      native.destroy(this._h)
      this._h = 0
    }
  }
}

/** Names of the audio APIs this build contains (e.g. ["asio", "wasapi"]). */
function compiledApis() {
  return native.compiledApis()
}

/** Which native file was loaded (e.g. to show whether the ASIO add-on is in use). */
function nativeFile() {
  return found.file
}

module.exports = { RtAudio, RtAudioApi, RtAudioFormat, RtAudioStreamFlags, RtAudioErrorType, compiledApis, nativeFile }
