// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { GpuTrack } from '../gpu/track'
import { state } from '../state'

/**
 * Non-destructive clip / region model.
 *
 * The audio *truth* still lives in VRAM (`GpuTrack` planar f32 channels) — an
 * `AudioSource` owns one such buffer + its full-length peak pyramid. A `Clip`
 * merely references a sub-range of a source and places it on a lane's timeline.
 * Splitting a clip creates a second `Clip` sharing the same source (no buffer
 * copy); fades are applied at playback time in `CLIPGATHER_WGSL`.
 */

export type FadeShape = 'lin' | 'eqpow' | 'log'

export const FADE_SHAPE_CODE: Record<FadeShape, number> = { lin: 0, eqpow: 1, log: 2 }

/** An imported / generated audio buffer in VRAM. Shared by any number of clips. */
export interface AudioSource {
  id: number
  name: string
  /** Source WAV path (null for a generated tone). */
  path: string | null
  kind: 'wav' | 'tone'
  /** Tone length in seconds (only when kind === 'tone'). */
  toneSeconds?: number
  /** VRAM sample buffers + full-length peak pyramid. */
  gpu: GpuTrack
  /** Peak-per-window envelope of the whole source (for the cheap strip meters). */
  envelope: Float32Array | null
  /** Number of clips currently referencing this source. */
  refCount: number
}

/** One placed region on a lane's timeline. */
export interface Clip {
  id: number
  sourceId: number
  name: string
  /** Timeline position of the clip's head, in project frames. */
  startFrame: number
  /** First source frame the clip plays from. */
  srcOffset: number
  lengthFrames: number
  /** Fade lengths in frames (0 = none). Always <= lengthFrames. */
  fadeIn: number
  fadeOut: number
  fadeInShape: FadeShape
  fadeOutShape: FadeShape
  /** Per-clip gain in dB (0 = unity). */
  gainDb: number
}

// ---- source registry --------------------------------------------------------

const sources = new Map<number, AudioSource>()
let nextSourceId = 1
let nextClipId = 1

export function sourceList(): AudioSource[] {
  return [...sources.values()]
}

export function getSource(id: number): AudioSource | undefined {
  return sources.get(id)
}

/** Register a freshly-built source (refCount starts at 0). Returns it. */
export function registerSource(s: Omit<AudioSource, 'id' | 'refCount'>): AudioSource {
  const full: AudioSource = { ...s, id: nextSourceId++, refCount: 0 }
  sources.set(full.id, full)
  return full
}

export function retainSource(id: number): void {
  const s = sources.get(id)
  if (s) s.refCount++
}

/**
 * Drop one reference. Does NOT free the VRAM buffers even at 0 — undo/redo can
 * bring the clip back, and the buffer set per session is bounded by distinct
 * imports. Freeing is an explicit user action ("remove unused source" →
 * `destroySource`) or project teardown (`clearSourceRegistry`).
 */
export function releaseSource(id: number): void {
  const s = sources.get(id)
  if (s) s.refCount = Math.max(0, s.refCount - 1)
}

/** Force-destroy a source regardless of refCount (project teardown). */
export function destroySource(id: number): void {
  const s = sources.get(id)
  if (!s) return
  for (const b of s.gpu.channels) b.destroy()
  s.gpu.peakBuffer?.destroy()
  sources.delete(id)
}

export function clearSourceRegistry(): void {
  for (const id of [...sources.keys()]) destroySource(id)
  nextSourceId = 1
  nextClipId = 1
}

// ---- clip helpers ---------------------------------------------------------

export function makeClip(p: {
  sourceId: number
  name: string
  startFrame?: number
  srcOffset?: number
  lengthFrames: number
  fadeIn?: number
  fadeOut?: number
  fadeInShape?: FadeShape
  fadeOutShape?: FadeShape
  gainDb?: number
}): Clip {
  return {
    id: nextClipId++,
    sourceId: p.sourceId,
    name: p.name,
    startFrame: Math.max(0, Math.round(p.startFrame ?? 0)),
    srcOffset: Math.max(0, Math.round(p.srcOffset ?? 0)),
    lengthFrames: Math.max(1, Math.round(p.lengthFrames)),
    fadeIn: Math.max(0, Math.round(p.fadeIn ?? 0)),
    fadeOut: Math.max(0, Math.round(p.fadeOut ?? 0)),
    fadeInShape: p.fadeInShape ?? 'eqpow',
    fadeOutShape: p.fadeOutShape ?? 'eqpow',
    gainDb: p.gainDb ?? 0
  }
}

export const clipEnd = (c: Clip): number => c.startFrame + c.lengthFrames

/** Clamp a clip's fades so each fits and the two together don't exceed length. */
export function clampFades(c: Clip): void {
  c.fadeIn = Math.max(0, Math.min(Math.round(c.fadeIn), c.lengthFrames))
  c.fadeOut = Math.max(0, Math.min(Math.round(c.fadeOut), c.lengthFrames))
  const over = c.fadeIn + c.fadeOut - c.lengthFrames
  if (over > 0) c.fadeOut = Math.max(0, c.fadeOut - over)
}

/**
 * Split `c` at absolute timeline frame `at`. `c` is mutated into the left part;
 * the freshly-made right part is returned (null if `at` isn't strictly inside).
 * The new cut faces carry no fade.
 */
export function splitClip(c: Clip, at: number): Clip | null {
  const a = Math.round(at)
  if (a <= c.startFrame || a >= clipEnd(c)) return null
  const leftLen = a - c.startFrame
  const right = makeClip({
    sourceId: c.sourceId,
    name: c.name,
    startFrame: a,
    srcOffset: c.srcOffset + leftLen,
    lengthFrames: c.lengthFrames - leftLen,
    fadeIn: 0,
    fadeOut: Math.min(c.fadeOut, c.lengthFrames - leftLen),
    fadeInShape: c.fadeInShape,
    fadeOutShape: c.fadeOutShape,
    gainDb: c.gainDb
  })
  c.lengthFrames = leftLen
  c.fadeOut = 0
  clampFades(c)
  return right
}

/**
 * Drag the clip's left edge to timeline frame `at`, keeping the source content
 * fixed under the cursor. Clamps to the source head and a 1-frame minimum.
 */
export function trimClipLeft(c: Clip, at: number): void {
  const minStart = c.startFrame - c.srcOffset // can't expose before source frame 0
  const maxStart = clipEnd(c) - 1
  const ns = Math.max(minStart, Math.min(maxStart, Math.round(at)))
  const delta = ns - c.startFrame
  c.startFrame = ns
  c.srcOffset += delta
  c.lengthFrames -= delta
  clampFades(c)
}

/** Drag the clip's right edge to timeline frame `at`. Clamps to the source tail. */
export function trimClipRight(c: Clip, at: number, srcTotalFrames: number): void {
  const maxEnd = c.startFrame + (srcTotalFrames - c.srcOffset)
  const ne = Math.max(c.startFrame + 1, Math.min(maxEnd, Math.round(at)))
  c.lengthFrames = ne - c.startFrame
  clampFades(c)
}

/** Transport end for one lane's clips (0 when empty). */
export function laneEnd(clips: Clip[]): number {
  let m = 0
  for (const c of clips) m = Math.max(m, clipEnd(c))
  return m
}

// ---- musical grid / snap -------------------------------------------------

/** Frames per beat at the current tempo + project rate. */
export function framesPerBeat(): number {
  return (state.sampleRate * 60) / Math.max(1, state.bpm)
}

/** Grid step in frames for the current `state.gridMode` (0 = no grid). */
export function gridStepFrames(): number {
  const beat = framesPerBeat()
  switch (state.gridMode) {
    case 'off':
      return 0
    case 'bar':
      return beat * state.timeSigNum * (4 / state.timeSigDen)
    case '1/4':
      return beat
    case '1/8':
      return beat / 2
    case '1/16':
      return beat / 4
    case '1/32':
      return beat / 8
    case '1/64':
      return beat / 16
    case '1/4T':
      return (beat * 2) / 3
    case '1/8T':
      return beat / 3
    case '1/16T':
      return beat / 6
  }
}

/** Snap a frame position to the current grid (identity when grid is off). */
export function snapFrame(frame: number): number {
  const step = gridStepFrames()
  if (step <= 0) return Math.round(frame)
  return Math.round(Math.round(frame / step) * step)
}
