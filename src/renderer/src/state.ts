// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Tiny observable app state. The renderer is intentionally framework-free so the
 * GPU/audio code stays the centre of gravity. If the UI grows, swap this for a
 * real signals lib without touching the GPU layer.
 *
 * This holds only transport + shared-timeline view state. The track list itself
 * (GpuTrack + its DOM lane + waveform renderer) is managed imperatively in
 * `main.ts`; `trackCount` is mirrored here just so the UI can react to empty vs
 * non-empty.
 */
/** Snap / grid resolution. Musical values need `bpm` + `timeSig*`. */
export type GridMode =
  | 'off'
  | 'bar'
  | '1/4'
  | '1/8'
  | '1/16'
  | '1/32'
  | '1/64'
  | '1/4T'
  | '1/8T'
  | '1/16T'

/**
 * Timeline edit tool. Tools only *select / mark* — operations (cut / copy /
 * paste / delete / split-at-playhead) are separate commands (Edit menu + keys).
 * `split` is the one tool that acts on click, by its nature.
 */
export type EditTool = 'select' | 'split' | 'range'

export interface DawState {
  /** Fixed project sample rate. Files are resampled to this on load. */
  sampleRate: number
  /** Number of tracks currently in the project. */
  trackCount: number
  /** Longest track length in frames (transport end). */
  totalFrames: number
  /** Transport position in frames. */
  playhead: number
  playing: boolean
  /** Horizontal zoom: frames per CSS pixel (shared across all lanes). */
  framesPerPixel: number
  /** Left edge of the view in frames (shared across all lanes). */
  scrollFrames: number
  /** Tempo (beats per minute) — drives the musical ruler + snap grid. */
  bpm: number
  /** Time signature numerator (beats per bar). */
  timeSigNum: number
  /** Time signature denominator (note value that gets the beat). */
  timeSigDen: number
  /** Snap / grid resolution for editing. */
  gridMode: GridMode
  /** Active timeline edit tool. */
  editTool: EditTool
}

type Listener = (s: DawState) => void

export const state: DawState = {
  sampleRate: 96000, // fixed project rate (default); loaded files are resampled to it
  trackCount: 0,
  totalFrames: 0,
  playhead: 0,
  playing: false,
  framesPerPixel: 512,
  scrollFrames: 0,
  bpm: 120,
  timeSigNum: 4,
  timeSigDen: 4,
  gridMode: 'off',
  editTool: 'select'
}

const listeners = new Set<Listener>()

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

export function update(patch: Partial<DawState>): void {
  Object.assign(state, patch)
  for (const fn of listeners) fn(state)
}
