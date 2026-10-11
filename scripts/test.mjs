// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

// Runs the pure-logic tests in tests/*.test.ts under plain Node: each file is bundled with
// esbuild (it ships with Vite, so no extra dependency) and executed. These cover the parts
// that need no GPU / no hardware: SMF + DAWproject import/export, zip, piano-roll math,
// MIDI I/O scheduling, MCU value decoding. Exit code is non-zero if any test fails.

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.cache', 'awaker-tests')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const files = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.ts'))
let failed = 0
for (const f of files) {
  const out = join(outDir, f.replace(/\.ts$/, '.cjs'))
  await build({ entryPoints: [join(root, 'tests', f)], bundle: true, platform: 'node', outfile: out, logLevel: 'error' })
  console.log(`\n== ${f}`)
  const r = spawnSync(process.execPath, [out], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}
console.log(failed ? `\n${failed} test file(s) FAILED` : `\nall ${files.length} test files passed`)
process.exit(failed ? 1 : 0)
