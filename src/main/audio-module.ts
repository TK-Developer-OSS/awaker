// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * The native audio module, behind the shape audio-out.ts uses (RtAudio + the enums). Two providers:
 *
 *   1. `native/audio` — the app's own module (RtAudio + cwASIO, built with `npm run build:audio`; no
 *      Steinberg code in it). Used whenever it has been built.
 *   2. `audify` — the npm package, only as a fallback when (1) is not built. Its Windows binary carries
 *      Steinberg's ASIO headers (see NOTICE), which is why (1) exists.
 *
 * `AWAKER_AUDIO_BACKEND=audify` forces (2); `=native` forbids the fallback.
 */

export type AudioModule = typeof import('audify')

let cached: AudioModule | null = null
let provider = ''

/** Which provider was loaded ('awaker-audio' | 'audify'); '' before the first load. */
export const audioProvider = (): string => provider

export function loadAudioModule(): AudioModule {
  if (cached) return cached
  const want = (process.env['AWAKER_AUDIO_BACKEND'] || '').toLowerCase()

  if (want !== 'audify') {
    const entry = join(app.getAppPath(), 'native', 'audio', 'index.js')
    if (existsSync(entry)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const m = require(entry) as AudioModule & { nativeFile?: () => string; compiledApis?: () => string[] }
        cached = m
        provider = 'awaker-audio'
        const apis = m.compiledApis?.() ?? []
        console.log(`[audio] using awaker-audio: ${basename(m.nativeFile?.() ?? '')} (${apis.join(' + ') || '?'})`)
        return cached
      } catch (err) {
        console.error('[audio] awaker-audio could not be loaded:', (err as Error).message)
        if (want === 'native') throw err
      }
    } else if (want === 'native') {
      throw new Error(`awaker-audio is missing (${entry})`)
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('audify') as AudioModule
    provider = 'audify'
    console.log('[audio] using the audify package (awaker-audio is not built: npm run build:audio)')
    return cached
  } catch (err) {
    throw new Error(
      `no audio module: awaker-audio is not built (npm run build:audio) and audify is not installed (${(err as Error).message})`
    )
  }
}
