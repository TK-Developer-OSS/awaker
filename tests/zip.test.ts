// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { buildZip, listZip, readZipEntry, crc32 } from '../src/main/zip'

let fails = 0
const eq = (n: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', n, ok ? '' : `got ${JSON.stringify(a)} exp ${JSON.stringify(b)}`)
}
eq('crc32 of "123456789"', crc32(Buffer.from('123456789')), 0xcbf43926)
const xml = Buffer.from('<?xml version="1.0"?><Project version="1.0">' + 'あ'.repeat(500) + '</Project>')
const bin = Buffer.alloc(100000)
for (let i = 0; i < bin.length; i++) bin[i] = (i * 31) & 0xff
const z = buildZip([
  { name: 'project.xml', data: xml, deflate: true },
  { name: 'audio/001_日本語 kick.wav', data: bin },
  { name: 'empty.txt', data: Buffer.alloc(0) }
])
const es = listZip(z)
eq('names', es.map((e) => e.name), ['project.xml', 'audio/001_日本語 kick.wav', 'empty.txt'])
eq('xml round trip', readZipEntry(z, es[0]).equals(xml), true)
eq('bin round trip', readZipEntry(z, es[1]).equals(bin), true)
eq('empty round trip', readZipEntry(z, es[2]).length, 0)
eq('deflate shrank xml', es[0].compSize < es[0].size, true)

console.log(fails ? `${fails} FAILED` : 'ALL OK')
process.exit(fails ? 1 : 0)
