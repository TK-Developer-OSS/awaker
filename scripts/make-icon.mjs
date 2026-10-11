// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

// A temporary app icon, drawn here (no image tooling, no dependency): a circle with an "A" in it.
// Writes build/icon.png (256 px, for the window / taskbar) and build/icon.ico (16–256 px, PNG-compressed
// images, embedded into the .exe by scripts/set-exe-icon.ps1).
//
// Usage: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'build')
mkdirSync(out, { recursive: true })

// ---- drawing: coverage by supersampling a signed-distance description ----------------------------
const DISC = [0x14, 0x1f, 0x33] // dark blue
const RING = [0x4a, 0x86, 0xd6]
const INK = [0xff, 0xff, 0xff]

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Colour of the icon at (x, y) in 0..1 unit square: [r, g, b, a] (a 0..1). */
function sample(x, y) {
  const d = Math.hypot(x - 0.5, y - 0.5)
  if (d > 0.47) return [0, 0, 0, 0]
  // the letter A: two legs and a crossbar
  const w = 0.055
  const legL = segDist(x, y, 0.5, 0.2, 0.3, 0.78)
  const legR = segDist(x, y, 0.5, 0.2, 0.7, 0.78)
  const bar = segDist(x, y, 0.37, 0.6, 0.63, 0.6)
  if (Math.min(legL, legR, bar) < w) return [...INK, 1]
  if (d > 0.41) return [...RING, 1]
  return [...DISC, 1]
}

function render(size) {
  const ss = 4
  const px = Buffer.alloc(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const c = sample((i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size)
          r += c[0] * c[3]
          g += c[1] * c[3]
          b += c[2] * c[3]
          a += c[3]
        }
      }
      const o = (j * size + i) * 4
      const n = ss * ss
      px[o] = a ? Math.round(r / a) : 0
      px[o + 1] = a ? Math.round(g / a) : 0
      px[o + 2] = a ? Math.round(b / a) : 0
      px[o + 3] = Math.round((a / n) * 255)
    }
  }
  return px
}

// ---- PNG ------------------------------------------------------------------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- ICO (PNG-compressed images) ---------------------------------------------------------------
const sizes = [16, 32, 48, 64, 128, 256]
const images = sizes.map((s) => ({ size: s, data: png(s, render(s)) }))
const head = Buffer.alloc(6)
head.writeUInt16LE(0, 0)
head.writeUInt16LE(1, 2) // icon
head.writeUInt16LE(images.length, 4)
let offset = 6 + images.length * 16
const dir = []
for (const im of images) {
  const e = Buffer.alloc(16)
  e[0] = im.size >= 256 ? 0 : im.size
  e[1] = im.size >= 256 ? 0 : im.size
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // bit count
  e.writeUInt32LE(im.data.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += im.data.length
  dir.push(e)
}
writeFileSync(join(out, 'icon.ico'), Buffer.concat([head, ...dir, ...images.map((i) => i.data)]))
writeFileSync(join(out, 'icon.png'), images[images.length - 1].data)
console.log(`icon: ${join(out, 'icon.png')} + ${join(out, 'icon.ico')}`)
