// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { faderSvg, faderOptions, DEFAULT_FADER_SKIN, type FaderSkin } from '../src/renderer/src/ui/fader-skin'
import { parseOptions } from '../src/renderer/src/ui/options-model'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${String(JSON.stringify(a)).slice(0, 200)}\n   exp ${String(JSON.stringify(b)).slice(0, 200)}`)
}

// formatting-insensitive form: no XML declaration, no comments, no whitespace between tags / inside tags
const norm = (svg: string): string =>
  svg
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()

// 1. "standard" is served from the static file, so the two must be the same drawing
const file = readFileSync(join(process.cwd(), 'src', 'renderer', 'public', 'feder.svg'), 'utf8')
eq('the standard skin is exactly public/feder.svg', norm(faderSvg(DEFAULT_FADER_SKIN)), norm(file))

// 2. every setting changes the drawing, and only what it should
const std = faderSvg(DEFAULT_FADER_SKIN)
const v = (p: Partial<FaderSkin>): string => faderSvg({ ...DEFAULT_FADER_SKIN, ...p })
eq('corner none removes the corner shading', [v({ corner: 'none' }).includes('radialGradient'), std.includes('radialGradient')], [false, true])
eq('corner soft differs from standard', v({ corner: 'soft' }) !== std, true)
eq('dim adds a darkening layer (more for dimmest)', [std.includes('fill="#000" opacity="0.07"'), v({ dim: 'dimmer' }).includes('opacity="0.07"'), v({ dim: 'dimmest' }).includes('opacity="0.14"')], [false, true, true])
eq('line thickness 1.6 / 2.6 / 3.8', [v({ line: 'thin' }).includes('height="1.6" fill="#050505"'), std.includes('height="2.6" fill="#050505"'), v({ line: 'bold' }).includes('height="3.8" fill="#050505"')], [true, true, true])
eq('the index line stays centred on the cap (y + height/2 = 27.9)', [['thin', 1.6], ['standard', 2.6], ['bold', 3.8]].every(([k, t]) => {
  const m = v({ line: k as FaderSkin['line'] }).match(/y="([\d.]+)" width="24" height="([\d.]+)" fill="#050505"/)
  return !!m && Math.abs(Number(m[1]) + Number(m[2]) / 2 - 27.9) < 0.01
}), true)

// 3. every combination is well-formed SVG with the same frame
let combos = 0
let ok = true
for (const corner of ['none', 'soft', 'standard'] as const)
  for (const dim of ['standard', 'dimmer', 'dimmest'] as const)
    for (const line of ['thin', 'standard', 'bold'] as const) {
      const s = faderSvg({ corner, dim, line })
      combos++
      const opens = (s.match(/<(?!\/|\?|!)[a-zA-Z]/g) ?? []).length
      const selfClosing = (s.match(/\/>/g) ?? []).length
      const closes = (s.match(/<\//g) ?? []).length
      if (!s.startsWith('<svg') || !s.endsWith('</svg>') || opens !== selfClosing + closes) ok = false
    }
eq(`all ${combos} combinations are balanced SVG`, ok, true)

// 4. the options section: defaults, and a stored value that is no longer valid
eq('section defaults = the standard skin', faderOptions.defaults, DEFAULT_FADER_SKIN)
eq('an old / invalid stored value falls back per field', parseOptions([faderOptions], { values: { fader: { corner: 'gone', dim: 'dimmer', line: 5 } } }).values.fader, { corner: 'standard', dim: 'dimmer', line: 'standard' })

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
