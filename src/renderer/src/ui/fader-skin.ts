// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { OptionSection, OptionValue } from './options-model'

/**
 * The fader cap's look, as an Options section. The cap is an SVG drawn from vector shapes
 * (`public/feder.svg` is the standard look, written out for the CSS fallback); this file builds the
 * same drawing from a few settings so the Options panel can switch it live:
 *
 *   corner  — how dark the four corners go (reads as rounder); none / soft / standard
 *   dim     — overall cap brightness; standard / dimmer / dimmest (easier on the eyes in long sessions)
 *   line    — thickness of the black index line across the middle; thin / standard / bold
 *
 * The standard values reproduce `public/feder.svg` exactly (tests/fader-skin.test.ts checks it), so
 * "standard" is served from the static file and only a changed look is injected as a data: URL.
 */

export interface FaderSkin {
  corner: 'none' | 'soft' | 'standard'
  dim: 'standard' | 'dimmer' | 'dimmest'
  line: 'thin' | 'standard' | 'bold'
}

export const DEFAULT_FADER_SKIN: FaderSkin = { corner: 'standard', dim: 'standard', line: 'standard' }

const CORNER = {
  none: null,
  soft: { r: 8, color: '#363636', o0: 0.6, o1: 0.25 },
  standard: { r: 9, color: '#303030', o0: 0.7, o1: 0.3 }
} as const
const DIM = { standard: 0, dimmer: 0.07, dimmest: 0.14 } as const
const LINE = { thin: 1.6, standard: 2.6, bold: 3.8 } as const

export function faderSvg(skin: FaderSkin): string {
  const corner = CORNER[skin.corner]
  const dim = DIM[skin.dim]
  const t = LINE[skin.line]
  const lineY = Math.round((27.9 - t / 2) * 100) / 100

  let corners = ''
  let cornerRects = ''
  if (corner) {
    const c = { tl: [2, 2.5], tr: [26, 2.5], bl: [2, 53.5], br: [26, 53.5] } as const
    for (const [k, [cx, cy]] of Object.entries(c)) {
      corners +=
        `<radialGradient id="c${k}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${corner.r}">` +
        `<stop offset="0" stop-color="${corner.color}" stop-opacity="${corner.o0}"/>` +
        `<stop offset="0.55" stop-color="${corner.color}" stop-opacity="${corner.o1}"/>` +
        `<stop offset="1" stop-color="${corner.color}" stop-opacity="0"/></radialGradient>`
      const x = cx < 14 ? cx : cx - corner.r
      const y = cy < 28 ? cy : cy - corner.r
      cornerRects += `<rect x="${x}" y="${y}" width="${corner.r}" height="${corner.r}" fill="url(#c${k})"/>`
    }
  }
  const dimRect = dim > 0 ? `<rect x="2" y="2.5" width="24" height="51" fill="#000" opacity="${dim}"/>` : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 56" width="28" height="56"><defs>` +
    `<linearGradient id="capTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f3ea"/><stop offset="1" stop-color="#e2e1d6"/></linearGradient>` +
    `<linearGradient id="capBottom" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9c8bd"/><stop offset="1" stop-color="#b3b2a7"/></linearGradient>` +
    `<linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.22"/><stop offset="0.14" stop-color="#000" stop-opacity="0"/><stop offset="0.86" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.26"/></linearGradient>` +
    corners +
    `<clipPath id="body"><rect x="2" y="2.5" width="24" height="51" rx="2.8"/></clipPath></defs>` +
    `<rect x="0.5" y="0.5" width="27" height="55" rx="3.8" fill="#2b2b28" stroke="#161614" stroke-width="1"/>` +
    `<g clip-path="url(#body)">` +
    `<rect x="2" y="2.5" width="24" height="25.5" fill="url(#capTop)"/><rect x="2" y="28" width="24" height="25.5" fill="url(#capBottom)"/>` +
    `<g fill="#8a8977" opacity="0.7"><rect x="2" y="7" width="24" height="0.9"/><rect x="2" y="12" width="24" height="0.9"/><rect x="2" y="17" width="24" height="0.9"/><rect x="2" y="22" width="24" height="0.9"/></g>` +
    `<g fill="#ffffff" opacity="0.55"><rect x="2" y="7.9" width="24" height="0.7"/><rect x="2" y="12.9" width="24" height="0.7"/><rect x="2" y="17.9" width="24" height="0.7"/><rect x="2" y="22.9" width="24" height="0.7"/></g>` +
    `<g fill="#6f6e5f" opacity="0.6"><rect x="2" y="33" width="24" height="0.9"/><rect x="2" y="38" width="24" height="0.9"/><rect x="2" y="43" width="24" height="0.9"/><rect x="2" y="48" width="24" height="0.9"/></g>` +
    `<g fill="#e8e7dc" opacity="0.45"><rect x="2" y="33.9" width="24" height="0.7"/><rect x="2" y="38.9" width="24" height="0.7"/><rect x="2" y="43.9" width="24" height="0.7"/><rect x="2" y="48.9" width="24" height="0.7"/></g>` +
    `<rect x="2" y="2.5" width="24" height="1.2" fill="#fff" opacity="0.6"/><rect x="2" y="52.3" width="24" height="1.2" fill="#fff" opacity="0.35"/>` +
    dimRect +
    cornerRects +
    `<rect x="2" y="2.5" width="24" height="51" fill="url(#edge)"/></g>` +
    `<rect x="2" y="${lineY}" width="24" height="${t}" fill="#050505"/>` +
    `<rect x="0.5" y="26.9" width="2" height="2" fill="#7c7c75"/><rect x="25.5" y="26.9" width="2" height="2" fill="#7c7c75"/></svg>`
  )
}

const isDefault = (s: FaderSkin): boolean => s.corner === 'standard' && s.dim === 'standard' && s.line === 'standard'

/** Put the skin in force: the standard look is the static file; anything else is injected as a data: URL. */
export function applyFaderSkin(skin: FaderSkin): void {
  const root = document.documentElement
  if (isDefault(skin)) root.style.removeProperty('--fader-cap')
  else root.style.setProperty('--fader-cap', `url("data:image/svg+xml;utf8,${encodeURIComponent(faderSvg(skin))}")`)
}

const asSkin = (v: Record<string, OptionValue>): FaderSkin => v as unknown as FaderSkin

export const faderOptions: OptionSection = {
  id: 'fader',
  title: 'Fader cap',
  description: 'How the fader caps look in the mixer. Changes show right away; OK keeps them.',
  fields: [
    {
      key: 'corner',
      type: 'choice',
      label: 'Corner shading',
      hint: 'Darker corners make the cap look rounder.',
      choices: [
        { value: 'none', label: 'None' },
        { value: 'soft', label: 'Soft' },
        { value: 'standard', label: 'Standard' }
      ]
    },
    {
      key: 'dim',
      type: 'choice',
      label: 'Cap brightness',
      hint: 'Dimmer caps are easier on the eyes over long sessions.',
      choices: [
        { value: 'standard', label: 'Standard' },
        { value: 'dimmer', label: 'Dimmer' },
        { value: 'dimmest', label: 'Dimmest' }
      ]
    },
    {
      key: 'line',
      type: 'choice',
      label: 'Index line',
      hint: 'The black line across the middle of the cap: how easy it is to read the position.',
      choices: [
        { value: 'thin', label: 'Thin' },
        { value: 'standard', label: 'Standard' },
        { value: 'bold', label: 'Bold' }
      ]
    }
  ],
  defaults: { ...DEFAULT_FADER_SKIN },
  apply: (v) => applyFaderSkin(asSkin(v)),
  preview(host, v) {
    host.replaceChildren()
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:14px;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:6px;width:fit-content'
    const skin = asSkin(v)
    const url = isDefault(skin) ? "url('/feder.svg')" : `url("data:image/svg+xml;utf8,${encodeURIComponent(faderSvg(skin))}")`
    for (let i = 0; i < 8; i++) {
      const cap = document.createElement('div')
      cap.style.cssText = `width:25px;height:50px;background:${url} center / 25px 50px no-repeat`
      row.appendChild(cap)
    }
    host.appendChild(row)
  }
}
