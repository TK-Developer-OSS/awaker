// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * Minimal ZIP reader for `.dawproject` containers (stored + deflate, no zip64,
 * no encryption). Zero dependencies; Node's zlib does the inflate.
 */

export interface ZipEntry {
  name: string
  method: number
  compSize: number
  size: number
  localOffset: number
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

export function listZip(buf: Buffer): ZipEntry[] {
  // End-of-central-directory record: scan back over a possible comment (<= 64 KiB).
  const minPos = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)')

  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff = buf.readUInt32LE(eocd + 16)
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    throw new Error('zip64 archives are not supported')
  }

  const out: ZipEntry[] = []
  let p = cdOff
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('corrupt zip directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    // bit 11 = UTF-8 names; otherwise the legacy code page, which is ASCII for our files.
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    out.push({ name, method, compSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** Decompress one entry. `maxBytes` guards against zip bombs. */
export function readZipEntry(buf: Buffer, e: ZipEntry, maxBytes = 4 * 1024 * 1024 * 1024): Buffer {
  if (e.size > maxBytes) throw new Error(`zip entry too large: ${e.name}`)
  const p = e.localOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) throw new Error(`corrupt local header: ${e.name}`)
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + e.compSize)
  if (e.method === 0) return Buffer.from(raw)
  if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) })
  throw new Error(`unsupported zip compression method ${e.method}: ${e.name}`)
}

/**
 * A safe, flat file name for an entry extracted to disk. Directory parts and
 * anything that could escape the target folder (`..`, drive letters, separators)
 * are stripped so a hostile archive cannot write outside it.
 */
export function safeBaseName(entryName: string): string {
  const base = entryName.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_')
  return cleaned.length > 0 ? cleaned : '_'
}

// ---- writer ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipInput {
  name: string
  data: Buffer
  /** Deflate (text) or store (already-dense audio). */
  deflate?: boolean
}

/** Build a plain (non-zip64) archive; throws if it would not fit. */
export function buildZip(entries: ZipInput[]): Buffer {
  const d = new Date()
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const method = e.deflate ? 8 : 0
    const body = e.deflate ? deflateRawSync(e.data) : e.data
    if (e.data.length >= 0xffffffff || body.length >= 0xffffffff || offset >= 0xffffffff) {
      throw new Error('archive too large for the zip format used (4 GB limit)')
    }
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(LOC_SIG, 0)
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0x800, 6) // UTF-8 names
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(dosTime, 10)
    lh.writeUInt16LE(dosDate, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    parts.push(lh, name, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(CEN_SIG, 0)
    ch.writeUInt16LE(20, 4) // version made by
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(dosTime, 12)
    ch.writeUInt16LE(dosDate, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, eocd])
}
