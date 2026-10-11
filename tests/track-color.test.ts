// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import {
  TRACK_PALETTE,
  WAVE_INK,
  alignStemColors,
  lanePaint,
  normalizeColor,
  paletteColor,
  pickUnusedColor,
  parseColor,
  pruneStemColors
} from '../src/renderer/src/ui/track-color'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

// ---- palette + parsing
check('twelve palette colours, all valid and distinct', TRACK_PALETTE.length === 12 && new Set(TRACK_PALETTE).size === 12 && TRACK_PALETTE.every((c) => parseColor(c) !== null))
check('palette wraps around (also for negative numbers)', paletteColor(12) === TRACK_PALETTE[0] && paletteColor(13) === TRACK_PALETTE[1] && paletteColor(-1) === TRACK_PALETTE[11])
const p = parseColor('#ff8000')
check('parse #rrggbb', !!p && p[0] === 1 && Math.abs(p[1] - 128 / 255) < 1e-9 && p[2] === 0)
check('parse #rgb', JSON.stringify(parseColor('#f80')) === JSON.stringify(parseColor('#ff8800')))
check('junk is not a colour', parseColor('red') === null && parseColor('#12') === null && parseColor('#gggggg') === null && parseColor(5) === null && parseColor(null) === null)
check('normalize: hex, short hex, palette number', normalizeColor('#F80') === '#ff8800' && normalizeColor('#E5736A') === '#e5736a' && normalizeColor(2) === TRACK_PALETTE[2])
check('normalize: palette number given as text', normalizeColor('5') === TRACK_PALETTE[5] && normalizeColor(' 11 ') === TRACK_PALETTE[11] && normalizeColor('12') === TRACK_PALETTE[0])
check('normalize: junk -> null', normalizeColor('blue') === null && normalizeColor(undefined) === null && normalizeColor(NaN) === null)

// ---- painting: the colour is the base, the wave is a dark grey
const paint = lanePaint('#4fc3f7')
const base = parseColor('#4fc3f7')!
check('lane background is the track colour, a little darker', paint.bg.every((v, i) => v <= base[i] * 0.75 && v >= base[i] * 0.65))
check('wave ink is a dark grey (equal-ish channels, dark)', Math.max(...paint.wave) < 0.25 && Math.max(...paint.wave) - Math.min(...paint.wave) < 0.06 && JSON.stringify(paint.wave) === JSON.stringify([...WAVE_INK]))
const avg = (v: readonly number[]): number => v.reduce((x, y) => x + y, 0) / v.length
check('the wave stays clearly darker than every lane colour (average brightness: under 55 %)', TRACK_PALETTE.every((c) => avg(lanePaint(c).bg) > 0.3 && avg(lanePaint(c).wave) < avg(lanePaint(c).bg) * 0.55))
check('a picked clip gets a pale tint of the colour', paint.fill.every((v, i) => v >= base[i]) && paint.fill[0] > 0.7)
check('css accent is the normalised colour', paint.css === '#4fc3f7' && lanePaint('nonsense').css === TRACK_PALETTE[0])

// ---- stems share one colour
const T = (stem: string, color: string): { stem: string; color: string } => ({ stem, color })
{
  // a track joins an existing stem: it takes the stem's colour
  const tr = [T('Drums', '#e5736a'), T('Drums', '#e5736a'), T('Drums', '#4fc3f7'), T('', '#9ccc65')]
  const r = alignStemColors(tr, { Drums: '#e5736a' }, 2)
  check('joining a stem takes the stem colour', r.colors[2] === '#e5736a' && r.colors[3] === '#9ccc65' && r.colors[0] === '#e5736a')
}
{
  // the first track of a new stem gives it its colour; the next one adopts it
  let tr = [T('Bass', '#9a86e8'), T('', '#4fc3f7')]
  let r = alignStemColors(tr, {}, 0)
  check('a new stem takes the colour of its first track', r.stemColors['Bass'] === '#9a86e8' && r.colors[0] === '#9a86e8')
  tr = [T('Bass', '#9a86e8'), T('Bass', '#4fc3f7')]
  r = alignStemColors(tr, r.stemColors, 1)
  check('the second track of the stem adopts it', r.colors[1] === '#9a86e8')
}
{
  // picking a colour on a track of a stem recolours the whole stem
  const tr = [T('Drums', '#e5736a'), T('Drums', '#e5736a'), T('Gtr', '#4db6ac')]
  tr[0] = T('Drums', '#ec7fa6')
  const r = alignStemColors(tr, { Drums: '#e5736a', Gtr: '#4db6ac' }, 0, true)
  check('recolour: every track of that stem follows, other stems are untouched', r.colors[0] === '#ec7fa6' && r.colors[1] === '#ec7fa6' && r.colors[2] === '#4db6ac' && r.stemColors['Drums'] === '#ec7fa6' && r.stemColors['Gtr'] === '#4db6ac')
}
{
  const tr = [T('', '#e5736a'), T('Drums', '#4fc3f7')]
  const r = alignStemColors(tr, {}, 0)
  check('a track without a stem keeps its own colour', r.colors[0] === '#e5736a' && r.colors[1] === '#4fc3f7')
  check('the input is not mutated', tr[0].color === '#e5736a')
  const r2 = alignStemColors(tr, {}, 9)
  check('an index out of range changes nothing', r2.colors.join() === '#e5736a,#4fc3f7')
}
{
  const t = pruneStemColors(['Drums', ' ', ''], { Drums: '#111111', Old: '#222222' })
  check('unused stem colours are dropped', Object.keys(t).join() === 'Drums')
}

// ---- a colour for a new group / stem that is not in use yet
{
  const picked: string[] = []
  for (let i = 0; i < 12; i++) picked.push(pickUnusedColor(picked))
  check('twelve picks are twelve different colours', new Set(picked).size === 12)
  check('the first picks are far apart on the hue circle', picked[0] !== picked[1] && picked[1] !== picked[2])
  check('an already used colour is skipped', pickUnusedColor([picked[0]]) !== picked[0])
  check('after all twelve, it still returns a palette colour', TRACK_PALETTE.includes(pickUnusedColor(picked)))
  check('colours in other notations count as used', pickUnusedColor([picked[0].toUpperCase()]) !== picked[0])
}

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
