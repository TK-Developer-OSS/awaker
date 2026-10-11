// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

// Checks that EarlySynth still sounds exactly as it did when it was frozen.
//
//   npm run dev:mcp            (in one terminal: the app with its MCP server)
//   node scripts/golden-earlysynth.mjs            compare against tests/golden/earlysynth.json
//   node scripts/golden-earlysynth.mjs --update   rewrite the golden file (only when a change is intended)
//
// Every factory preset is rendered through the real GPU path (one note at two velocities) and its
// level figures (peak / RMS per channel, integrated loudness) are compared with the stored ones.
//
// WARNING: this REPLACES the project in the running app. Save first (Ctrl+S) or run it on a scratch
// session. Figures are deterministic on one machine / GPU; across GPUs allow the tolerance below.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL = process.env.AWAKER_MCP ?? 'http://127.0.0.1:7777/mcp'
const GOLDEN = process.env.AWAKER_GOLDEN ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'golden', 'earlysynth.json')
const TOLERANCE_DB = 0.05
const BASSES = new Set(['Punch Bass', 'Pluck Bass', 'Rubber Bass', 'Hollow Bass'])

let id = 0
async function call(tool, args = {}) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } })
  })
  const body = await res.json()
  if (body.error) throw new Error(JSON.stringify(body.error))
  if (body.result?.isError) throw new Error(body.result.content[0].text)
  const text = body.result.content.find((c) => c.type === 'text')?.text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const emptyProject = () =>
  call('project_load', {
    project: {
      version: 2,
      sampleRate: 96000,
      bpm: 120,
      sources: [],
      master: { gainDb: 0, inserts: [] },
      view: { framesPerPixel: 0, scrollFrames: 0, playhead: 0 },
      tracks: []
    }
  })

const round = (v) => Math.round(v * 1000) / 1000

async function measure() {
  const names = (await call('instrument_presets')).earlysynth
  const out = {}
  for (const name of names) {
    out[name] = {}
    for (const vel of [110, 40]) {
      await emptyProject()
      const { id: track } = await call('midi_track_add', {
        name,
        bpm: 120,
        instrument: 'earlysynth',
        notes: [{ start: 0, dur: 1, key: BASSES.has(name) ? 36 : 60, vel }]
      })
      await call('instrument_set', { track, params: { preset: name } })
      const r = await call('bounce', { seconds: 2.5 })
      out[name][`vel${vel}`] = {
        peakDb: r.peakDb.map(round),
        rmsDb: r.rmsDb.map(round),
        lufsIntegrated: round(r.lufsIntegrated)
      }
    }
    process.stdout.write('.')
  }
  process.stdout.write('\n')
  return out
}

const update = process.argv.includes('--update')
const now = await measure()

if (update) {
  mkdirSync(dirname(GOLDEN), { recursive: true })
  writeFileSync(GOLDEN, JSON.stringify({ tolerance: TOLERANCE_DB, presets: now }, null, 2) + '\n')
  console.log(`wrote ${GOLDEN} (${Object.keys(now).length} presets)`)
  process.exit(0)
}

const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
let bad = 0
for (const [name, byVel] of Object.entries(golden.presets)) {
  for (const [vk, g] of Object.entries(byVel)) {
    const m = now[name]?.[vk]
    if (!m) {
      console.log(`MISSING ${name} ${vk}`)
      bad++
      continue
    }
    const pairs = [...g.peakDb.map((v, i) => [v, m.peakDb[i], 'peak']), ...g.rmsDb.map((v, i) => [v, m.rmsDb[i], 'rms']), [g.lufsIntegrated, m.lufsIntegrated, 'lufs']]
    for (const [want, got, what] of pairs) {
      if (!(Math.abs(want - got) <= golden.tolerance)) {
        console.log(`MOVED ${name} ${vk} ${what}: ${want} -> ${got}`)
        bad++
      }
    }
  }
}
for (const name of Object.keys(now)) if (!golden.presets[name]) console.log(`NEW preset not in the golden file: ${name}`)
console.log(bad ? `${bad} figure(s) moved — EarlySynth no longer sounds as frozen` : `EarlySynth unchanged (${Object.keys(golden.presets).length} presets x 2 velocities, +-${golden.tolerance} dB)`)
process.exit(bad ? 1 : 0)
