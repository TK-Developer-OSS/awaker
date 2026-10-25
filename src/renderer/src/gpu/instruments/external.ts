// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { registerInstrument, type Instrument, type InstrumentNote } from '../instrument'
import type { GpuTrack } from '../track'

/**
 * "None" instrument: the track keeps its notes, piano roll and MIDI output but makes no
 * sound of its own, for driving an external synth. It renders silence (a fresh buffer is
 * zero-filled by WebGPU) so the lane, strip and inserts behave like any other instrument
 * lane; the length just covers the notes so the transport sees the same extent.
 */
export class ExternalInstrument implements Instrument {
  readonly kind = 'none'
  params: object = {}

  tailSeconds(): number {
    return 0
  }

  render(notes: InstrumentNote[], _sr: number, out: GpuTrack): void {
    let lastEnd = 0
    for (const n of notes) lastEnd = Math.max(lastEnd, n.endFrame)
    out.prepare(Math.max(256, lastEnd), 2)
    out.computePeaks()
  }
}

registerInstrument('none', 'None (external MIDI)', () => new ExternalInstrument())
