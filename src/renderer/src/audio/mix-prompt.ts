// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * The request the AI Mix button sends to the assistant. The system prompt stays the person's / the app's; this is
 * the one message that says what to do now and in which order, using the measuring tools (the AI cannot hear).
 */

export interface MixRequest {
  /** Target name as the AI should see it ("pop", or the reference song's name). */
  targetName: string
  /** The target is the average spectrum of a song the person picked (not a genre's typical shape). */
  fromReference: boolean
  /** Only measure and explain; change nothing. */
  measureOnly: boolean
  /** Land the master at this integrated loudness (LUFS) as the last step; null = leave the loudness alone. */
  targetLufs?: number | null
}

const lufsOf = (r: MixRequest): number | null => (typeof r.targetLufs === 'number' && Number.isFinite(r.targetLufs) ? r.targetLufs : null)

export function buildMixPrompt(r: MixRequest, skill?: string): string {
  if (skill && skill.trim()) return withSkill(r, skill.trim())
  return buildInlinePrompt(r)
}

/** The request when the app's `ai-mix` skill is at hand: the goal in two lines, then the skill itself. */
function withSkill(r: MixRequest, skill: string): string {
  const target = r.fromReference
    ? `the average spectrum of the reference song "${r.targetName}" (already set as the target)`
    : `the typical long-term balance of the genre "${r.targetName}" (already set as the target)`
  const head = [
    `AI MIX. Goal: bring every track to a working level of about -18 dBFS RMS, tame what still sticks out with the channel-strip compressors, and make the AVERAGE spectrum of the whole song match ${target}.`,
    'You cannot hear the audio: work from the numbers the tools return. Reply in Japanese.'
  ]
  const lufs = lufsOf(r)
  head.push(
    lufs === null
      ? 'Do NOT land the loudness (no loudness_land): leave the master fader as it is.'
      : `Last step: land the master at ${lufs} LUFS integrated with loudness_land { targetLufs: ${lufs} } (stage 5 of the skill).`
  )
  head.push(
    'Before that, remove every red with headroom_fit (stage 4): it lowers ALL track faders together. The -18 dB per track is only a starting point — lowering everything by about 10 dB or more is expected; do not compensate with trims.'
  )
  if (r.measureOnly) head.push('MEASURE ONLY — do not change anything: follow the skill\'s "測定だけを頼まれたとき" section.')
  return `${head.join('\n')}\n\nFollow this skill exactly (it is the app\'s "ai-mix" skill; steps, tools and limits are all in it):\n\n${skill}`
}

function buildInlinePrompt(r: MixRequest): string {
  const target = r.fromReference
    ? `the average spectrum of the reference song "${r.targetName}" (already set as the target)`
    : `the typical long-term balance of the genre "${r.targetName}" (already set as the target)`
  const head = `AI MIX. Goal: make the AVERAGE spectrum of the whole song (its long-term balance over the entire song, not a single moment) match ${target}. You cannot hear the audio, so work from the measurements of the tools below, not from guesses.`
  if (r.measureOnly) {
    return [
      head,
      'MEASURE ONLY — do not change anything.',
      '1. Call spectrum_analyze with scope "breakdown".',
      '2. Explain in Japanese: the summary and score, which frequency regions are too much / too little (in Hz and dB), and which group / stem carries each of them (parts) — and what you WOULD do (eq_apply moves with numbers).',
      'Remind the person that this is the song\'s average spectrum against a typical shape, not a verdict of the music itself.'
    ].join('\n')
  }
  return [
    head,
    'Procedure:',
    '1. tracks_list and groups_list to see what exists (do not touch muted tracks, instruments or the arrangement).',
    '2. spectrum_analyze with scope "breakdown": it returns the deviation per band, the regions out of tolerance, each with a ready `fix` (kind, freq, gainDb, q) and `parts` (which group / stem holds that energy, with the gainDb that part alone would need).',
    '3. Fix the largest region first, ALWAYS at the channel that causes it: the first entry of parts (a group channel, a stem\'s tracks, or a single track) with eq_apply — owner = its group id or track id, or tracks [ids] for a stem — using the fix kind / freq / q and the part\'s gainDb (do not exceed the region fix by more than 2 dB). When several parts share a region, correct the biggest one or two, not all of them. NEVER use the master EQ to fix a region.',
    '4. After one to three corrections measure again (spectrum_analyze, scope "master" is enough unless you need new parts). Corrections add up: only correct what is still out of tolerance.',
    '5. Stop when the summary is "on target", or when every remaining region is within 1 dB of its tolerance, or after 6 measure-and-correct rounds. Never push one band beyond ±9 dB in total, and do not chase the last dB.',
    '6. The master EQ (owner "master") is only for a last, gentle touch after the channels are done and only when a wide, even tilt remains: 2 dB at most. Do not add dynamics or other plug-ins.',
    '7. Then call headroom_fit once: it lowers ALL track faders together until no track or group peaks over 0 dBFS (no red). Lowering everything by about 10 dB or more is expected (the -18 dB per track is only a starting point); do not compensate with trims.',
    lufsOf(r) === null
      ? '8. Do not change the master fader.'
      : `8. Last: call loudness_land { targetLufs: ${lufsOf(r)} } once (it moves the master fader by measuring and re-measuring) and report startLufs → endLufs. Do not move the master fader any other way.`,
    'Finish with a short report in Japanese: score before and after (rmsDb and withinTolerancePct), each correction you made (channel, kind, Hz, dB), what is still off and why. Say plainly that these are measurements of the average spectrum against a target shape, not a listening judgement.'
  ].join('\n')
}

/** The line shown in the chat for the request (the long prompt itself is not). */
export function mixShownLine(label: string, measureOnly: boolean, fromReference: boolean, targetLufs: number | null = null): string {
  const lufs = targetLufs !== null && !measureOnly ? ` → ${targetLufs} LUFS に着地` : ''
  return `AIミックス: ${fromReference ? 'リファレンス曲「' + label + '」の平均スペクトルに合わせる' : 'ジャンル「' + label + '」'}${lufs}${measureOnly ? '（測定のみ・調整しない）' : ''}`
}
