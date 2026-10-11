// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { BAR_CHOICES, defaultBarsFor, followsDefault, inputChoices, parseInput, uniqueName } from '../src/renderer/src/ui/add-track-model'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}

eq('free name is kept', uniqueName('Drums', ['Bass', 'Keys']), 'Drums')
eq('a taken name gets 2', uniqueName('Drums', ['Drums']), 'Drums 2')
eq('and then 3', uniqueName('Drums', ['Drums', 'Drums 2']), 'Drums 3')
eq('a gap is filled', uniqueName('Drums', ['Drums', 'Drums 3']), 'Drums 2')
eq('case does not matter', uniqueName('drums', ['DRUMS']), 'drums 2')
eq('blank becomes Track', uniqueName('   ', []), 'Track')
eq('surrounding spaces are trimmed', uniqueName('  Pad  ', []), 'Pad')

eq('blank follows the instrument choice', followsDefault('', 'Drums'), true)
eq('the untouched auto name follows it', followsDefault('Drums', 'Drums'), true)
eq('a name the user typed does not', followsDefault('My kit', 'Drums'), false)

eq('drums start with 2 bars', defaultBarsFor('drums'), 2)
eq('synths start with 4 bars', [defaultBarsFor('synth'), defaultBarsFor('earlysynth'), defaultBarsFor('fm')], [4, 4, 4])
eq('the bar choices include both defaults', [BAR_CHOICES.includes(2), BAR_CHOICES.includes(4)], [true, true])

const ch = inputChoices(8)
eq('8 mono + 4 stereo pairs', [ch.length, ch.filter((c) => c.value[0] === 'm').length, ch.filter((c) => c.value[0] === 's').length], [12, 8, 4])
eq('first choices', ch.slice(0, 2).map((c) => c.label), ['In 1 (mono)', 'In 2 (mono)'])
eq('stereo pairs are 1-2, 3-4, 5-6, 7-8', ch.filter((c) => c.value[0] === 's').map((c) => c.label), ['In 1-2 (stereo)', 'In 3-4 (stereo)', 'In 5-6 (stereo)', 'In 7-8 (stereo)'])
eq('2 inputs: one pair', inputChoices(2).filter((c) => c.value[0] === 's').length, 1)
eq('an odd count has no half pair', inputChoices(3).filter((c) => c.value[0] === 's').map((c) => c.value), ['s0'])

eq('parse mono', parseInput('m3'), { ch: 3, stereo: false })
eq('parse stereo', parseInput('s2'), { ch: 2, stereo: true })
eq('parse junk', [parseInput(''), parseInput('x1'), parseInput('m'), parseInput('m-1')], [null, null, null, null])
eq('every offered choice parses', ch.every((c) => parseInput(c.value) !== null), true)

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
