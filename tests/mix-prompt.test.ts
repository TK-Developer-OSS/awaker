// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { buildMixPrompt, mixShownLine } from '../src/renderer/src/audio/mix-prompt'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

const full = buildMixPrompt({ targetName: 'pop', fromReference: false, measureOnly: false })
check('names the tools it relies on', ['spectrum_analyze', 'eq_apply', 'breakdown', 'tracks_list'].every((t) => full.includes(t)))
check('says the genre target is already set', full.includes('genre "pop"') && full.includes('already set'))
check('has a stop rule and a limit on how far a band may go', full.includes('6 measure-and-correct rounds') && full.includes('±9 dB'))
check('asks for the report in Japanese', full.includes('report in Japanese'))
check('does not tell it to leave anything unchanged', !full.includes('MEASURE ONLY'))
check('the channel that causes it is corrected, never the master for a region', full.includes('ALWAYS at the channel that causes it') && full.includes('NEVER use the master EQ to fix a region'))
check('the master EQ is a small last touch', full.includes('2 dB at most'))

const ref = buildMixPrompt({ targetName: 'Song A', fromReference: true, measureOnly: false })
check('reference: names the song, not a genre', ref.includes('reference song "Song A"') && !ref.includes('genre "'))

const only = buildMixPrompt({ targetName: 'rock', fromReference: false, measureOnly: true })
check('measure only: says not to change anything and does not mention applying', only.includes('MEASURE ONLY') && only.includes('do not change anything') && !only.includes('6 measure-and-correct rounds'))

check('shown line: genre', mixShownLine('ポップ', false, false) === 'AIミックス: ジャンル「ポップ」')

// ---- landing the loudness
const withLufs = buildMixPrompt({ targetName: 'pop', fromReference: false, measureOnly: false, targetLufs: -14 })
check('inline request: the last step lands the master with loudness_land at the target', withLufs.includes('loudness_land { targetLufs: -14 }') && withLufs.includes('Do not move the master fader any other way'))
const noLufs = buildMixPrompt({ targetName: 'pop', fromReference: false, measureOnly: false, targetLufs: null })
check('inline request: without a target the master fader is left alone', !noLufs.includes('loudness_land') && noLufs.includes('Do not change the master fader'))
const skillReq = buildMixPrompt({ targetName: 'pop', fromReference: false, measureOnly: false, targetLufs: -16 }, '# skill body')
check('skill request carries the target (-16 LUFS)', skillReq.includes('-16 LUFS integrated') && skillReq.includes('# skill body'))
const skillNo = buildMixPrompt({ targetName: 'pop', fromReference: false, measureOnly: false }, '# skill body')
check('skill request without a target says not to land the loudness', skillNo.includes('Do NOT land the loudness'))
check('shown line mentions the landing', mixShownLine('ポップ', false, false, -14).includes('-14 LUFS'))
check('inline request: headroom_fit (no red) comes before the landing, and says a ~10 dB drop is expected', withLufs.indexOf('headroom_fit') > 0 && withLufs.indexOf('headroom_fit') < withLufs.indexOf('loudness_land { targetLufs') && /10 dB/.test(withLufs))
check('skill request names stage 4 (red) before stage 5 (loudness)', skillReq.includes('headroom_fit (stage 4)') && skillReq.includes('(stage 5 of the skill)'))
check('shown line: reference + measure only', mixShownLine('Song A', true, true).includes('Song A') && mixShownLine('Song A', true, true).includes('測定のみ'))
check('shown line is short (the long prompt is not echoed)', mixShownLine('ポップ', false, false).length < 60)

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
