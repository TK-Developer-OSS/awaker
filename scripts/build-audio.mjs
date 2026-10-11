// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

// Builds native/audio with MinGW-w64 (MSYS2 UCRT64 g++) — no MSVC, no CMake, no node-gyp: RtAudio + a Node-API
// layer whose functions are looked up in the host at run time (so it loads in Node and in Electron).
//
// TWO files come out, on purpose:
//   native/audio/build/awaker_audio.node       WASAPI only. No ASIO code in it. This is the one the app ships with.
//   native/audio/build/awaker_audio_asio.node  WASAPI + ASIO (through cwASIO). An optional add-on: when it is
//                                              present next to the app (see native/audio/index.js) the app uses it.
//
// Usage: node scripts/build-audio.mjs [--only=base|asio]
//   CXX / CC           compiler paths (default: MSYS2 ucrt64, then PATH)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'native', 'audio')
const out = join(dir, 'build')
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7)

function find(envName, exe) {
  if (process.env[envName]) return process.env[envName]
  const msys = join('C:\\msys64\\ucrt64\\bin', `${exe}.exe`)
  return existsSync(msys) ? msys : exe
}
const cxx = find('CXX', 'g++')
const cc = find('CC', 'gcc')
const env = { ...process.env, PATH: `${dirname(cxx)};${process.env.PATH ?? ''}` }

mkdirSync(join(out, 'obj'), { recursive: true })

function run(label, tool, args) {
  const r = spawnSync(tool, args, { cwd: dir, env, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`build-audio: ${label} failed (exit ${r.status})`)
    process.exit(r.status ?? 1)
  }
}

const incs = ['-Isrc/shim', '-Ivendor/rtaudio', '-Ivendor/cwasio', '-Ivendor/cwasio/asio', '-Ivendor/node-api']
const libs = ['-lole32', '-loleaut32', '-luuid', '-lwinmm', '-lksuser', '-lmfplat', '-lmfuuid', '-lwmcodecdspuuid']

function build(withAsio) {
  const outFile = join('build', withAsio ? 'awaker_audio_asio.node' : 'awaker_audio.node')
  const defs = ['-DNAPI_EXTERN=', '-DNAPI_VERSION=8', '-DNOMINMAX', '-DNDEBUG', '-D__WINDOWS_WASAPI__']
  if (withAsio) defs.push('-D__WINDOWS_ASIO__')
  const objs = []
  if (withAsio) {
    // C: cwASIO, only in the add-on
    for (const [src, obj] of [
      ['vendor/cwasio/cwASIO.c', 'cwASIO.o'],
      ['vendor/cwasio/asio/asio.c', 'asio_c.o']
    ]) {
      run(src, cc, ['-O2', '-std=gnu11', '-c', src, '-o', join('build', 'obj', obj), '-Ivendor/cwasio', '-Ivendor/cwasio/asio'])
      objs.push(join('build', 'obj', obj))
    }
  }
  const cpp = ['src/awaker_audio.cpp', 'vendor/rtaudio/RtAudio.cpp']
  if (withAsio) cpp.push('src/shim/asiodrivers.cpp')
  run(withAsio ? 'link (with ASIO)' : 'link (WASAPI only)', cxx, ['-O2', '-std=c++17', '-shared', '-static', ...defs, ...incs, ...cpp, ...objs, ...libs, '-o', outFile])
  console.log(`build-audio: ${join(dir, outFile)} (${statSync(join(dir, outFile)).size} bytes, ${withAsio ? 'WASAPI + ASIO via cwASIO' : 'WASAPI only'})`)
}

if (only !== 'asio') build(false)
if (only !== 'base') build(true)
