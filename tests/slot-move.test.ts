// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { moveSlot } from '../src/renderer/src/audio/slot-move'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}
const j = (a: string[]): string => a.join('')

{
  const a = ['A', 'B', 'C', 'D']
  check('same rack: move the first one to the third place', moveSlot(a, 0, a, 2, 8) && j(a) === 'BCAD', j(a))
  check('same rack: move the last one to the front', moveSlot(a, 3, a, 0, 8) && j(a) === 'DBCA', j(a))
  check('same rack: dropping on itself changes nothing', !moveSlot(a, 1, a, 1, 8) && j(a) === 'DBCA')
  check('same rack: dropping on an empty slot = to the end', moveSlot(a, 0, a, 7, 8) && j(a) === 'BCAD', j(a))
  check('same rack: nothing is lost or doubled', [...a].sort().join('') === 'ABCD')
  check('a bad source index is refused', !moveSlot(a, 9, a, 0, 8) && !moveSlot(a, -1, a, 0, 8))
}
{
  const x = ['A', 'B']
  const y = ['P']
  check('other rack: inserted at the drop position', moveSlot(x, 0, y, 0, 8) && j(x) === 'B' && j(y) === 'AP', `${j(x)} ${j(y)}`)
  check('other rack: an empty slot appends', moveSlot(x, 0, y, 5, 8) && j(x) === '' && j(y) === 'ABP' || j(y) === 'APB', `${j(x)} ${j(y)}`)
  const full = ['1', '2', '3']
  const src = ['Z']
  check('other rack: a full rack refuses and nothing moves', !moveSlot(src, 0, full, 0, 3) && j(src) === 'Z' && j(full) === '123')
}

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
