// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RotatingLog } from '../src/main/ai-log'
import { diffProject, formatChanges } from '../src/main/ai-core'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

// ---- what really changed ------------------------------------------------------------------------
const proj = (gain: number, extra: object = {}): unknown => ({
  version: 2,
  view: { playhead: 100, scrollFrames: 0 },
  master: { inserts: [{ kind: 'eq5', bypass: false, params: { bands: [{ freq: 80, gainDb: 0 }] } }] },
  tracks: [
    { title: '01_KickIn', mix: { gainDb: gain, pan: 0 }, strip: { params: { drive: 0.5 } } },
    { title: '02_Snare', mix: { gainDb: 0, pan: 0 }, strip: { params: { drive: 0.2 } } }
  ],
  ...extra
})

check('no change → no differences', diffProject(proj(0), proj(0)).length === 0)
const one = diffProject(proj(0), proj(-3))
check('one fader change is one entry, with the track name in the path', one.length === 1 && one[0].path === 'tracks[01_KickIn].mix.gainDb' && one[0].from === 0 && one[0].to === -3)
const ignored = diffProject(proj(0), { ...(proj(0) as object), view: { playhead: 99999, scrollFrames: 5 } })
check('view / playhead movement is not an edit', ignored.length === 0)
const nested = diffProject(proj(0), { ...(proj(0) as { master: object }), master: { inserts: [{ kind: 'eq5', bypass: false, params: { bands: [{ freq: 80, gainDb: -2 }] } }] } })
check('nested arrays by index: master insert band', nested.length === 1 && nested[0].path === 'master.inserts[0].params.bands[0].gainDb')
const added = diffProject(proj(0), { ...(proj(0) as { tracks: object[] }), tracks: [...(proj(0) as { tracks: object[] }).tracks, { title: '03_New', mix: { gainDb: 0 } }] })
check('an added track is one entry', added.length === 1 && added[0].path === 'tracks[03_New]' && added[0].to === '（追加）')
const removed = diffProject(proj(0), { ...(proj(0) as { tracks: object[] }), tracks: [(proj(0) as { tracks: object[] }).tracks[0]] })
check('a removed track is one entry', removed.length === 1 && removed[0].from === '（削除）')
let many = proj(0) as { tracks: { mix: { gainDb: number } }[] }
const big = { tracks: Array.from({ length: 300 }, (_, i) => ({ id: i, title: `t${i}`, v: 0 })) }
const bigAfter = { tracks: big.tracks.map((t) => ({ ...t, v: 1 })) }
check('the number of changes is capped', diffProject(big, bigAfter, 50).length === 50)
void many
const msg = formatChanges(one, 2, 1)
check('message says it was measured by the app', msg.includes('アプリが計測') && msg.includes('tracks[01_KickIn].mix.gainDb: 0 → -3') && msg.includes('ツール実行: 2 回（失敗 1 回）'))
check('message for no change is explicit', formatChanges([], 0, 0).includes('変更なし'))
const bd = formatChanges([], 5, 0, ['track_set', 'track_set', 'track_set', 'wait', 'tracks_list'])
check('the message breaks the tool calls down by name, most used first', bd.includes('ツール実行: 5 回（track_set 3、wait 1、tracks_list 1）'))

// removing a track from the middle must not make every later track look changed
const three = (names: string[]): unknown => ({ tracks: names.map((n) => ({ title: n, mix: { gainDb: 0 } })) })
const mid = diffProject(three(['a', 'b', 'c', 'd']), three(['a', 'c', 'd']))
check('removing a middle track is one change, not a cascade', mid.length === 1 && mid[0].path === 'tracks[b]' && mid[0].from === '（削除）')
const dupTitles = diffProject(three(['x', 'x']), { tracks: [{ title: 'x', mix: { gainDb: -1 } }, { title: 'x', mix: { gainDb: 0 } }] })
check('duplicate titles fall back to index matching', dupTitles.length === 1 && dupTitles[0].path.startsWith('tracks[0:x]'))

// ---- rotating log -------------------------------------------------------------------------------
async function logTests(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'awaker-log-'))
  try {
    const log = new RotatingLog(dir, 'ops', 300, 3) // tiny size so it rotates quickly
    for (let i = 0; i < 40; i++) await log.append({ type: i % 2 ? 'tool' : 'turn', n: i, pad: 'x'.repeat(40) })
    const files = readdirSync(dir).sort()
    check('current file + at most `keep` rotated ones', files.join() === 'ops.1.log,ops.2.log,ops.3.log,ops.log', files.join())
    check('the newest entry is in the current file', readFileSync(join(dir, 'ops.log'), 'utf8').includes('"n":39'))
    const total = files.reduce((s, f) => s + readFileSync(join(dir, f)).length, 0)
    check('disk use stays bounded', total <= 300 * 4 + 120, String(total))
    const recent = (await log.readRecent(5)) as { n: number }[]
    check('readRecent returns the newest, oldest first', recent.map((e) => e.n).join() === '35,36,37,38,39')
    const turns = (await log.readRecent(3, (e) => (e as { type: string }).type === 'turn')) as { n: number }[]
    check('readRecent can filter by kind', turns.map((e) => e.n).join() === '34,36,38')
    const across = (await log.readRecent(100)) as { n: number }[]
    check('it reads back across rotated files, and old ones are gone', across.length > 5 && across[across.length - 1].n === 39 && across[0].n > 0)
    // a torn / foreign line must not break reading
    const fs = await import('node:fs')
    fs.appendFileSync(join(dir, 'ops.log'), 'not json\n{"type":"tool","n":99}\n')
    const again = (await log.readRecent(2)) as { n: number }[]
    check('garbage lines are skipped', again.map((e) => e.n).join() === '39,99')
    // concurrent appends do not interleave a rotation
    const log2 = new RotatingLog(dir + '-b', 'ops', 200, 2)
    await Promise.all(Array.from({ length: 30 }, (_, i) => log2.append({ n: i, pad: 'y'.repeat(30) })))
    const all = (await log2.readRecent(100)) as { n: number }[]
    check('concurrent appends all land, in order', all.every((e, i) => i === 0 || e.n > all[i - 1].n) && all[all.length - 1].n === 29)
    rmSync(dir + '-b', { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

void logTests().then(() => {
  if (fails) {
    console.log(`${fails} FAILED`)
    process.exit(1)
  }
  console.log('ALL OK')
})
