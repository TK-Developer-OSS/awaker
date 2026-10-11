// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Step-sequencer math for the drum machine: preset patterns and the mapping between a
 * step grid and the clip's MIDI notes. Pure (no DOM / GPU) so it is unit-tested.
 *
 * A step is a 16th note (0.25 beat). A drum "lane" is identified by its MIDI key; notes
 * that use an alias key for the same voice (e.g. pedal hat 44 for closed hat 42) count as
 * the same lane when reading, and are normalised to the lane's key when written.
 */

export const STEP_BEATS = 0.25
export const STEPS_PER_BAR = 16
export const VEL_NORMAL = 100
export const VEL_ACCENT = 127
export const VEL_GHOST = 55

export interface StepNote {
  id: number
  start: number
  dur: number
  key: number
  vel: number
}

/** Pattern text per lane name: `x` hit, `X` accent, `o` ghost, `.` rest (16 chars = one bar). */
export type PatternText = Record<string, string>

export interface Preset {
  name: string
  lanes: PatternText
}

export const PRESETS: Preset[] = [
  {
    name: 'Basic beat',
    lanes: {
      Kick: 'x.......x.x.....',
      Snare: '....x.......x...',
      Clap: '....x.......x...',
      'Closed Hat': 'x.x.x.x.x.x.x.x.',
      'Open Hat': '......x.......x.'
    }
  },
  {
    name: 'Four on the floor',
    lanes: {
      Kick: 'x...x...x...x...',
      Clap: '....x.......x...',
      'Closed Hat': '.x.x.x.x.x.x.x.x',
      'Open Hat': '..x...x...x...x.'
    }
  },
  {
    name: 'Trap',
    lanes: {
      Kick: 'x..x..x...x...x.',
      Snare: '........x.......',
      Clap: '........x.......',
      'Closed Hat': 'x.xxx.x.x.xxxxxx',
      'Open Hat': '...........x....'
    }
  },
  {
    name: 'Latin percussion',
    lanes: {
      Clave: 'x..x..x...x.x...',
      Cowbell: 'x.x.x.x.x.x.x.x.',
      'Bongo Hi': '.x.x..x..x.x..x.',
      'Bongo Lo': 'x...x.....x.x...',
      'Conga Mute': '..x...x.x...x.x.',
      'Conga Open': '....x.......x...',
      'Conga Low': 'x.......x..x....',
      'Guiro Short': 'x.......x.......',
      'Guiro Long': '..............x.'
    }
  },
  {
    name: 'Djembe groove',
    lanes: {
      'Djembe Bass': 'x.......x..x....',
      'Djembe Tone': '..x...x...x...x.',
      'Djembe Slap': '....x.......x...',
      'Guiro Short': 'x.x.x.x.x.x.x.x.',
      'Conga Mute': '.x...x...x...x..'
    }
  }
]

const VELS: Record<string, number> = { x: VEL_NORMAL, X: VEL_ACCENT, o: VEL_GHOST }

export interface LaneRef {
  voice: number
  key: number
  name: string
}

/**
 * Expand a preset into notes for `bars` bars (the one-bar pattern repeats). Lanes the
 * kit does not have are ignored. Starts are in beats from the clip start.
 */
export function presetNotes(preset: Preset, lanes: LaneRef[], bars: number): { start: number; dur: number; key: number; vel: number }[] {
  const out: { start: number; dur: number; key: number; vel: number }[] = []
  for (const [laneName, text] of Object.entries(preset.lanes)) {
    const lane = lanes.find((l) => l.name === laneName)
    if (!lane) continue
    for (let bar = 0; bar < bars; bar++) {
      for (let s = 0; s < Math.min(STEPS_PER_BAR, text.length); s++) {
        const v = VELS[text[s]]
        if (v) out.push({ start: (bar * STEPS_PER_BAR + s) * STEP_BEATS, dur: STEP_BEATS, key: lane.key, vel: v })
      }
    }
  }
  return out
}

/** Step index of a note start (nearest), or -1 when it does not sit on the grid within a half step. */
export function stepOf(start: number): number {
  const s = Math.round(start / STEP_BEATS)
  return Math.abs(start - s * STEP_BEATS) <= STEP_BEATS / 2 + 1e-9 ? s : -1
}

/** The note on a lane at a step (any key that maps to the lane's voice), if there is one. */
export function findCell(notes: StepNote[], sameLane: (key: number) => boolean, step: number): StepNote | undefined {
  return notes.find((n) => sameLane(n.key) && stepOf(n.start) === step)
}

/** Velocity per step (0 = empty) for one lane over `steps` steps. */
export function laneRow(notes: StepNote[], sameLane: (key: number) => boolean, steps: number): number[] {
  const row = new Array<number>(steps).fill(0)
  for (const n of notes) {
    if (!sameLane(n.key)) continue
    const s = stepOf(n.start)
    if (s >= 0 && s < steps) row[s] = Math.max(row[s], n.vel)
  }
  return row
}

/** Cycle for plain click: empty → normal → empty (accent / ghost come from modifier clicks). */
export function nextVel(current: number, wanted: number): number {
  return current === wanted ? 0 : wanted
}
