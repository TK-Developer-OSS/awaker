// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

// the tests run bundled from node_modules/.cache/awaker-tests: the repo root is three levels up
const root = join(__dirname, '..', '..', '..')
const dir = join(root, 'native', 'audio')
const bin = join(dir, 'build', 'awaker_audio.node') // WASAPI only
const addon = join(dir, 'build', 'awaker_audio_asio.node') // the optional ASIO add-on

// the source tree: what the module is made of, and what it must not contain
const rt = readFileSync(join(dir, 'vendor', 'rtaudio', 'RtAudio.cpp'), 'utf8')
check('RtAudio source is vendored with its licence', rt.length > 300000 && existsSync(join(dir, 'vendor', 'rtaudio', 'LICENSE')))
check('cwASIO source is vendored with its MIT licence', existsSync(join(dir, 'vendor', 'cwasio', 'cwASIO.c')) && /MIT License/.test(readFileSync(join(dir, 'vendor', 'cwasio', 'LICENSE'), 'utf8')))
const shim = ['asio.h', 'asiosys.h', 'asiodrivers.h', 'asiodrivers.cpp', 'iasiothiscallresolver.h'].map((f) => readFileSync(join(dir, 'src', 'shim', f), 'utf8')).join('\n')
check('the shim has no Steinberg SDK text (it is ours, on top of cwASIO)', !/Steinberg Audio Stream|\(c\) 19\d\d/i.test(shim))
check('no Steinberg SDK files in native/audio', !existsSync(join(dir, 'vendor', 'asio')) && !existsSync(join(dir, 'vendor', 'rtaudio', 'include', 'asio.h')))

if (!existsSync(bin)) {
  console.log('skip the native checks: awaker_audio.node is not built (npm run build:audio)')
} else {
  const raw = readFileSync(bin)
  const text = raw.toString('latin1')
  check('the main (WASAPI-only) binary carries no Steinberg SDK text', !/Steinberg/.test(text))
  check('the main binary has no ASIO host code: no cwASIO, no RtAudio ASIO backend, no driver registry path',
    !/cwASIO/.test(text) && !/RtApiAsio/.test(text) && !/SOFTWARE\\ASIO/.test(text) && !/SOFTWARE\\ASIO/.test(raw.toString('utf16le')))
  if (existsSync(addon)) {
    const at = readFileSync(addon).toString('latin1')
    check('the ASIO add-on has the ASIO backend and still no Steinberg SDK text', /RtApiAsio/.test(at) && /cwASIO/.test(at) && !/Steinberg/.test(at))
  } else {
    console.log('skip the add-on checks: awaker_audio_asio.node is not built')
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const a = require(join(dir, 'index.js')) as {
    RtAudio: new (api?: number) => {
      getDevices(): { id: number; name: string; outputChannels: number; inputChannels: number; sampleRates: number[] }[]
      getDefaultOutputDevice(): number
      write(b: Buffer): void
      isStreamOpen(): boolean
      isStreamRunning(): boolean
      outputVolume: number
      dispose(): void
    }
    RtAudioApi: Record<string, number>
    RtAudioFormat: Record<string, number>
    compiledApis(): string[]
  }
  const apis = a.compiledApis()
  // index.js prefers the add-on when it is there: the compiled APIs say which one this process got
  const expected = existsSync(addon) ? 'asio,wasapi' : 'wasapi'
  check(`compiled APIs of the loaded module: ${expected}`, apis.slice().sort().join() === expected, apis.join())
  check('the enums match audify values the app relies on', a.RtAudioApi.WINDOWS_ASIO === 6 && a.RtAudioApi.WINDOWS_WASAPI === 7 && a.RtAudioFormat.RTAUDIO_FLOAT32 === 0x10)

  const rtw = new a.RtAudio(a.RtAudioApi.WINDOWS_WASAPI)
  const devs = rtw.getDevices()
  check('WASAPI devices come back as plain objects with the fields the app reads', devs.every((d) => typeof d.id === 'number' && typeof d.name === 'string' && Array.isArray(d.sampleRates)), `${devs.length} device(s)`)
  check('a stream is not open before openStream', !rtw.isStreamOpen() && !rtw.isStreamRunning())
  let wrongSize = ''
  try {
    rtw.write(Buffer.alloc(10))
  } catch (e) {
    wrongSize = (e as Error).message
  }
  check('write() of a wrong size is rejected', /Invalid size/.test(wrongSize), wrongSize)
  let badVolume = ''
  try {
    rtw.outputVolume = 2
  } catch (e) {
    badVolume = (e as Error).message
  }
  check('a volume out of 0..1 is rejected', /Invalid volume/.test(badVolume), badVolume)
  rtw.outputVolume = 0.5
  check('volume is kept', rtw.outputVolume === 0.5)
  rtw.dispose()
  let afterDispose = ''
  try {
    rtw.isStreamOpen()
  } catch (e) {
    afterDispose = (e as Error).message
  }
  check('a disposed object is refused', /invalid|destroyed|handle/i.test(afterDispose), afterDispose)

  const rta = new a.RtAudio(a.RtAudioApi.WINDOWS_ASIO)
  if (existsSync(addon)) {
    const asio = rta.getDevices()
    check('ASIO drivers are enumerated through cwASIO (the list may be empty on a machine without drivers)', Array.isArray(asio), `${asio.length} driver(s)`)
  } else {
    // the WASAPI-only module answers an ASIO request with WASAPI: the app must be able to tell (getApi)
    check('without the add-on an ASIO request is NOT ASIO (getApi tells)', !/asio/i.test(rta.getApi()), rta.getApi())
  }
  rta.dispose()
}

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
