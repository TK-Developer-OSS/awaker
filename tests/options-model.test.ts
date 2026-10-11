// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import {
  defaultValues,
  isDefault,
  isFieldVisible,
  normalizeField,
  parseOptions,
  serializeOptions,
  OPTIONS_FILE_VERSION,
  type OptionSection
} from '../src/renderer/src/ui/options-model'

let fails = 0
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`)
}

const noop = (): void => {}
const demo: OptionSection = {
  id: 'demo',
  title: 'Demo',
  fields: [
    { key: 'style', type: 'choice', label: 'Style', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'size', type: 'number', label: 'Size', min: 0, max: 10, step: 1 },
    { key: 'on', type: 'toggle', label: 'On' }
  ],
  defaults: { style: 'a', size: 4, on: false },
  apply: noop
}
const other: OptionSection = {
  id: 'other',
  title: 'Other',
  fields: [{ key: 'x', type: 'toggle', label: 'X' }],
  defaults: { x: true },
  apply: noop
}
const sections = [demo, other]

eq('defaults of every section', defaultValues(sections), { demo: { style: 'a', size: 4, on: false }, other: { x: true } })

// ---- one field
const [fChoice, fNum, fToggle] = demo.fields
eq('choice: valid value is kept', normalizeField(fChoice, 'b', 'a'), 'b')
eq('choice: a value no longer in the list falls back', normalizeField(fChoice, 'zzz', 'a'), 'a')
eq('choice: wrong type falls back', normalizeField(fChoice, 3, 'a'), 'a')
eq('number: in range is kept', normalizeField(fNum, 7, 4), 7)
eq('number: clamped to the range', [normalizeField(fNum, 99, 4), normalizeField(fNum, -5, 4)], [10, 0])
eq('number: snapped to the step', normalizeField(fNum, 6.4, 4), 6)
eq('number: NaN / string falls back', [normalizeField(fNum, NaN, 4), normalizeField(fNum, '7', 4)], [4, 4])
eq('toggle: boolean only', [normalizeField(fToggle, true, false), normalizeField(fToggle, 'yes', false)], [true, false])

// ---- whole file
{
  const { values, extra } = parseOptions(sections, { version: 1, values: { demo: { style: 'b', size: 9, on: true, stale: 1 } } })
  eq('a saved section round-trips', values.demo, { style: 'b', size: 9, on: true })
  eq('a section missing from the file gets defaults', values.other, { x: true })
  eq('no unknown sections', extra, {})
}
{
  const { values } = parseOptions(sections, { values: { demo: { style: 'nope', size: 'big' } } })
  eq('bad values are replaced field by field (the rest of the section is kept)', values.demo, { style: 'a', size: 4, on: false })
}
for (const [what, junk] of [['null', null], ['a string', 'x'], ['an array', []], ['an empty object', {}], ['values is not an object', { values: 5 }]] as const) {
  eq(`unreadable file (${what}) = all defaults`, parseOptions(sections, junk).values, defaultValues(sections))
}
{
  const { values, extra } = parseOptions(sections, { version: 99, values: { demo: { style: 'b' }, fromTheFuture: { y: 1 } } })
  eq('a section this build does not know is kept aside…', extra, { fromTheFuture: { y: 1 } })
  const out = serializeOptions(values, extra)
  eq('…and written back on save, so nothing is lost', out.values['fromTheFuture'], { y: 1 })
  eq('the file carries the current version', out.version, OPTIONS_FILE_VERSION)
}
{
  const saved = serializeOptions({ demo: { style: 'b', size: 2, on: true }, other: { x: false } })
  const text = JSON.stringify(saved)
  eq('save → text → load gives the same values', parseOptions(sections, JSON.parse(text)).values, saved.values)
}

eq('isDefault: untouched', isDefault(demo, { style: 'a', size: 4, on: false }), true)
eq('isDefault: one field changed', isDefault(demo, { style: 'b', size: 4, on: false }), false)

// text fields: trimmed, cut to maxLength, non-strings fall back
const txt = { key: 't', type: 'text' as const, label: 'T', maxLength: 5 }
eq('text: trimmed and cut', normalizeField(txt, '  abcdefgh ', 'd'), 'abcde')
eq('text: non-string -> default', normalizeField(txt, 42, 'd'), 'd')
eq('text: empty string is a valid value', normalizeField(txt, '', 'd'), '')

// fields that show only for some values of another field
const shown = { key: 'p', type: 'text' as const, label: 'P', maxLength: 5, showWhen: { key: 'mode', in: ['a', 'b'] } }
eq('showWhen: matches', isFieldVisible(shown, { mode: 'a' }), true)
eq('showWhen: no match', isFieldVisible(shown, { mode: 'c' }), false)
eq('showWhen: absent means always shown', isFieldVisible({ key: 'q', type: 'toggle', label: 'Q' }, {}), true)

console.log(fails === 0 ? 'ALL OK' : `${fails} FAILED`)
process.exit(fails ? 1 : 0)
