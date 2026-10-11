// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

// Portable Windows build (no installer, no extra dependency): the Electron runtime from node_modules, the built
// app (out/), and the app's own audio module (native/audio: RtAudio + cwASIO; no Steinberg code, no audify). Result: dist/Awaker-<version>-win32-x64/ (+ a .zip next to it).
//
// Usage: node scripts/package.mjs [--skip-build] [--no-zip]
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

delete process.env.ELECTRON_RUN_AS_NODE
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (process.platform !== 'win32') {
  console.error('package: this script builds the Windows portable build (win32 only for now)')
  process.exit(1)
}

if (!args.has('--skip-build')) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'run.mjs'), 'build'], { stdio: 'inherit', cwd: root })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
for (const need of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
  if (!existsSync(join(root, need))) {
    console.error(`package: ${need} is missing — run the build first`)
    process.exit(1)
  }
}

const name = `Awaker-${pkg.version}-win32-x64`
const distRoot = join(root, 'dist')
const dir = join(distRoot, name)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

// 1. the Electron runtime, renamed
const electronDist = join(root, 'node_modules', 'electron', 'dist')
cpSync(electronDist, dir, { recursive: true })
renameSync(join(dir, 'electron.exe'), join(dir, 'Awaker.exe'))
rmSync(join(dir, 'resources', 'default_app.asar'), { force: true })

// the (temporary) icon: the window / taskbar icon file, and the one inside the .exe
const icoPath = join(root, 'build', 'icon.ico')
const pngPath = join(root, 'build', 'icon.png')
if (!existsSync(icoPath) || !existsSync(pngPath)) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
cpSync(pngPath, join(dir, 'resources', 'icon.png'))
{
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'set-exe-icon.ps1'), '-Exe', join(dir, 'Awaker.exe'), '-Ico', icoPath],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) {
    console.error('package: could not put the icon into Awaker.exe')
    process.exit(r.status ?? 1)
  }
}
// what Explorer / Task Manager show for the file: name, description, version, company, copyright
{
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'set-exe-version.ps1'),
      '-Exe', join(dir, 'Awaker.exe'),
      '-ProductName', pkg.productName,
      '-Description', `${pkg.productName} — GPU-based DAW (development preview)`,
      '-Version', pkg.version,
      '-Company', 'TK',
      '-Copyright', 'Copyright 2026 TK. Apache License 2.0',
      '-Comments', 'https://x.com/TK_Developer',
      '-OriginalName', 'Awaker.exe'
    ],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) {
    console.error('package: could not set the version information of Awaker.exe')
    process.exit(r.status ?? 1)
  }
}

// 2. the app: package.json (runtime fields only), the build, the runtime modules
const app = join(dir, 'resources', 'app')
mkdirSync(app, { recursive: true })
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName,
      version: pkg.version,
      description: pkg.description,
      main: pkg.main,
      author: pkg.author,
      license: pkg.license
    },
    null,
    2
  )
)
cpSync(join(root, 'out'), join(app, 'out'), { recursive: true })

// the app's own audio module. The main package gets the WASAPI-only build: no ASIO code in it. The ASIO side is a
// separate add-on file (see below) that a person puts in the same folder on purpose.
const nativeSrc = join(root, 'native', 'audio')
const nativeBin = join(nativeSrc, 'build', 'awaker_audio.node')
const addonBin = join(nativeSrc, 'build', 'awaker_audio_asio.node')
if (!existsSync(nativeBin)) {
  console.error('package: native/audio/build/awaker_audio.node is missing — run: npm run build:audio')
  process.exit(1)
}
{
  // a guard, not a hope: the file that goes into the main package must have no ASIO host code and no SDK text
  const raw = readFileSync(nativeBin)
  const ascii = raw.toString('latin1')
  const utf16 = raw.toString('utf16le')
  const bad = []
  if (/Steinberg/.test(ascii)) bad.push('Steinberg SDK text')
  if (/cwASIO/.test(ascii)) bad.push('cwASIO')
  if (/RtApiAsio/.test(ascii)) bad.push('the RtAudio ASIO backend')
  if (/SOFTWARE\\ASIO/.test(ascii) || /SOFTWARE\\ASIO/.test(utf16)) bad.push('the ASIO driver registry path')
  if (bad.length) {
    console.error(`package: awaker_audio.node contains ${bad.join(', ')} — refusing to put it in the main package (build it with: npm run build:audio)`)
    process.exit(1)
  }
}
const nativeDst = join(app, 'native', 'audio')
mkdirSync(join(nativeDst, 'build'), { recursive: true })
cpSync(join(nativeSrc, 'index.js'), join(nativeDst, 'index.js'))
cpSync(nativeBin, join(nativeDst, 'build', 'awaker_audio.node'))
{
  const to = join(nativeDst, 'licenses', 'rtaudio-LICENSE.txt')
  mkdirSync(dirname(to), { recursive: true })
  cpSync(join(nativeSrc, 'vendor', 'rtaudio', 'LICENSE'), to)
}

// 3. notices
const ver = (m) => JSON.parse(readFileSync(join(root, 'node_modules', m, 'package.json'), 'utf8')).version
cpSync(join(root, 'LICENSE'), join(dir, 'LICENSE'))
cpSync(join(root, 'NOTICE'), join(dir, 'NOTICE'))
writeFileSync(
  join(dir, 'THIRD_PARTY_NOTICES.txt'),
  [
    `${pkg.productName} ${pkg.version} — TK (https://x.com/TK_Developer), Apache License 2.0`,
    '',
    'Third-party components',
    '',
    `Electron ${ver('electron')} (MIT) and Chromium: see LICENSE.electron and LICENSES.chromium.html in this folder.`,
    'RtAudio (Copyright (c) 2001-2023 Gary P. Scavone, MIT-style licence): resources/app/native/audio/licenses/rtaudio-LICENSE.txt',
    'Audio output in this package is WASAPI only. ASIO support is a separate, optional add-on file (awaker_audio_asio.node)',
    'with its own notices; it is not part of this package.',
    'ASIO is a trademark of Steinberg Media Technologies GmbH.',
    ''
  ].join('\n')
)
// Electron's own licence file arrives as "LICENSE": keep it under its own name next to ours
if (existsSync(join(electronDist, 'LICENSE'))) cpSync(join(electronDist, 'LICENSE'), join(dir, 'LICENSE.electron'))

writeFileSync(
  join(dir, 'README.txt'),
  [
    `${pkg.productName} ${pkg.version} (development preview, Windows x64)`,
    'TK — https://x.com/TK_Developer — Apache License 2.0',
    '',
    'Run Awaker.exe. Needs a GPU with WebGPU support. Audio output is WASAPI.',
    'ASIO: an optional add-on file (awaker_audio_asio.node, downloaded separately) switches ASIO on when it is placed',
    'in the same folder as Awaker.exe (or in resources\\app\\native\\audio\\build). Remove it to go back to WASAPI only.',
    'Your settings and the last project are kept in %APPDATA%\\awaker. Delete that folder to start fresh.',
    'The AI features need an AI connection of your own (Options -> AI); nothing is built in.',
    'Development preview: file formats and UI may change without notice.',
    ''
  ].join('\n')
)

// 4. zip (Windows 10+ ships bsdtar)
if (!args.has('--no-zip')) {
  const zip = join(distRoot, `${name}.zip`)
  rmSync(zip, { force: true })
  // the Windows bsdtar by full path: a GNU tar earlier on PATH (Git for Windows) reads "C:" as a host name
  const tar = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe')
  const r = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', distRoot, name], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('package: zipping failed (tar.exe)')
    process.exit(r.status ?? 1)
  }
  console.log(`package: ${zip}`)
}
console.log(`package: ${dir}`)

// 5. the ASIO add-on: ONE file plus its notices, as its own small package
if (existsSync(addonBin)) {
  const addonText = readFileSync(addonBin).toString('latin1')
  if (/Steinberg/.test(addonText)) {
    console.error('package: the ASIO add-on contains Steinberg SDK text — not packaging it')
    process.exit(1)
  }
  const addonName = `Awaker-ASIO-addon-${pkg.version}-win32-x64`
  const adir = join(distRoot, addonName)
  rmSync(adir, { recursive: true, force: true })
  mkdirSync(adir, { recursive: true })
  cpSync(addonBin, join(adir, 'awaker_audio_asio.node'))
  cpSync(join(nativeSrc, 'vendor', 'cwasio', 'LICENSE'), join(adir, 'cwASIO-LICENSE.txt'))
  cpSync(join(nativeSrc, 'vendor', 'rtaudio', 'LICENSE'), join(adir, 'RtAudio-LICENSE.txt'))
  writeFileSync(
    join(adir, 'README.txt'),
    [
      `${pkg.productName} — ASIO add-on ${pkg.version} (Windows x64)`,
      'TK — https://x.com/TK_Developer',
      '',
      'What it is: awaker_audio_asio.node is the audio module of Awaker with ASIO switched on (WASAPI + ASIO).',
      'The Awaker package itself is WASAPI only; this file is optional. Downloading it and combining it with',
      'Awaker (placing it next to Awaker.exe) is your own responsibility.',
      '',
      'Install: copy awaker_audio_asio.node into the SAME FOLDER as Awaker.exe (or into',
      'resources\\app\\native\\audio\\build next to awaker_audio.node), then start Awaker. The log shows',
      '"using awaker-audio: awaker_audio_asio.node (asio + wasapi)". Awaker takes ASIO first when a pro-audio',
      'interface driver is installed, and WASAPI otherwise.',
      'Remove: delete the file. Awaker is WASAPI only again.',
      '',
      'What is inside: RtAudio (MIT-style, RtAudio-LICENSE.txt) and cwASIO (MIT, cwASIO-LICENSE.txt), an independent',
      'implementation of the ASIO driver API. No code from Steinberg\'s ASIO SDK is included.',
      'ASIO is a trademark of Steinberg Media Technologies GmbH. This add-on is provided as is,',
      'without warranty. Awaker itself is under the Apache License 2.0.',
      ''
    ].join('\n')
  )
  if (!args.has('--no-zip')) {
    const azip = join(distRoot, `${addonName}.zip`)
    rmSync(azip, { force: true })
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    const r = spawnSync(tar, ['-a', '-c', '-f', azip, '-C', distRoot, addonName], { stdio: 'inherit' })
    if (r.status !== 0) {
      console.error('package: zipping the add-on failed (tar.exe)')
      process.exit(r.status ?? 1)
    }
    console.log(`package: ${azip}`)
  }
} else {
  console.log('package: no ASIO add-on built (npm run build:audio makes awaker_audio_asio.node)')
}
