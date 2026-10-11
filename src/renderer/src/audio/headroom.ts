// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * "No red anywhere": the channel meters go red when a track's (or group's) own output peak passes 0 dBFS. Taking
 * every track fader down TOGETHER by the same amount keeps the balance and removes the red; a group whose sum
 * still passes 0 dBFS after that gets its own fader lowered by what is left. Pure, so it is unit-tested.
 */

export interface HeadroomPlan {
  /** dB every track fader goes down by (>= 0; 0 = nothing was over). */
  trackDropDb: number
  /** Extra dB for each group fader, same order as the input (>= 0). */
  groupExtraDb: number[]
  /** The loudest peak (dBFS) over all tracks / groups before and the predicted one after. */
  worstBeforeDb: number
  worstAfterDb: number
}

const up1 = (x: number): number => Math.ceil(x * 10 - 1e-9) / 10 // round UP to 0.1 dB: never leave a sliver of red
const finiteMax = (a: readonly number[]): number => a.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), -Infinity)

/**
 * @param trackPeaksDb post-fader peak of every track over the whole song (dBFS, -Infinity = silent)
 * @param groupPeaksDb post-fader peak of every group channel (dBFS)
 * @param marginDb how far under 0 dBFS the loudest peak must end up (default 0.5)
 */
export function planHeadroom(trackPeaksDb: readonly number[], groupPeaksDb: readonly number[], marginDb = 0.5): HeadroomPlan {
  const worstTrack = finiteMax(trackPeaksDb)
  const trackDropDb = worstTrack > -marginDb ? up1(worstTrack + marginDb) : 0
  const groupExtraDb = groupPeaksDb.map((p) => {
    if (!Number.isFinite(p)) return 0
    // the tracks' drop already lowers what feeds the group by the same amount (the sum scales with them)
    const after = p - trackDropDb
    return after > -marginDb ? up1(after + marginDb) : 0
  })
  const worstBefore = Math.max(worstTrack, finiteMax(groupPeaksDb))
  const worstAfter = Math.max(
    Number.isFinite(worstTrack) ? worstTrack - trackDropDb : -Infinity,
    ...groupPeaksDb.map((p, i) => (Number.isFinite(p) ? p - trackDropDb - groupExtraDb[i] : -Infinity))
  )
  return { trackDropDb, groupExtraDb, worstBeforeDb: worstBefore, worstAfterDb: worstAfter }
}
