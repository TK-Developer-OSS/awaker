// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { fmtFaderDb } from '../src/renderer/src/ui/fader-text'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = a === b
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `got ${String(a)} expected ${String(b)}`)
}

eq('unity', fmtFaderDb(0), '0.0')
eq('lowered', fmtFaderDb(-2), '-2.0')
eq('half steps', fmtFaderDb(-12.5), '-12.5')
eq('boosted gets a plus sign', fmtFaderDb(3), '+3.0')
eq('bottom of the rail is -inf', fmtFaderDb(-60), '\u2212\u221e')
eq('below the rail is -inf', fmtFaderDb(-80), '\u2212\u221e')
eq('-Infinity / NaN do not print garbage', fmtFaderDb(-Infinity) + fmtFaderDb(NaN), '\u2212\u221e\u2212\u221e')
eq('just above the bottom is a number', fmtFaderDb(-59.5), '-59.5')

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
