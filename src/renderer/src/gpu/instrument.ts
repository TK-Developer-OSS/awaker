// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { GpuTrack } from './track'

/**
 * GPGPU instrument contract. An instrument turns a note list into audio **directly
 * in VRAM** (no CPU sample array): `render()` writes the planar stereo output of the
 * given `GpuTrack`, which then plays like any audio source (strip, inserts, mix).
 *
 * Rendering is "render-ahead" over the whole note list today. Implementations should
 * be stateless per frame where they can (see the synth: closed-form voices), so the
 * same kernels can later be driven block-by-block for live playing.
 *
 * To add an instrument: implement `Instrument`, register a factory with
 * `registerInstrument`, and give it a params object that is plain JSON (it is saved
 * in the project as-is).
 */

export interface InstrumentNote {
  /** Note-on / note-off, in project frames from the start of the render. */
  startFrame: number
  endFrame: number
  /** MIDI key 0..127 */
  key: number
  /** MIDI velocity 1..127 */
  vel: number
}

export interface Instrument {
  readonly kind: string
  /** Plain-JSON parameters (saved with the project). */
  params: object
  /** Seconds the output rings on after the last note-off (release / reverb tail). */
  tailSeconds(): number
  /** Render `notes` into `out` (replaces its content, sets its length). */
  render(notes: InstrumentNote[], sampleRate: number, out: GpuTrack): void
}

export type InstrumentFactory = (params?: object) => Instrument

export const INSTRUMENT_KINDS: Record<string, { label: string; make: InstrumentFactory }> = {}

export function registerInstrument(kind: string, label: string, make: InstrumentFactory): void {
  INSTRUMENT_KINDS[kind] = { label, make }
}

/** Older saved kind names that now live under another name (none at the moment). */
const KIND_ALIASES: Record<string, string> = {}

export function normalizeInstrumentKind(kind: string): string {
  return KIND_ALIASES[kind] ?? kind
}

export function makeInstrument(kind: string, params?: object): Instrument | null {
  return INSTRUMENT_KINDS[normalizeInstrumentKind(kind)]?.make(params) ?? null
}

/** Registered instruments for a picker: [kind, label], in registration order. */
export function listInstruments(): { kind: string; label: string }[] {
  return Object.entries(INSTRUMENT_KINDS).map(([kind, v]) => ({ kind, label: v.label }))
}

export const instrumentLabel = (kind: string): string => INSTRUMENT_KINDS[normalizeInstrumentKind(kind)]?.label ?? kind
