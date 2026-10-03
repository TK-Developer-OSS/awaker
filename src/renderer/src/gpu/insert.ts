// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Minimal insert-effect contract for the GPU master chain (prototype).
 *
 * An insert transforms a planar stereo block **in place**: it reads and writes
 * `io.L` / `io.R` (blockFrames f32 each). Multiple compute passes may be added
 * to the shared encoder. Persistent state (delay lines, filter memory) lives in
 * GPU buffers the insert owns; `reset()` clears it at transport start.
 *
 * No parameter system, preset format, or discovery yet — one concrete effect
 * (reverb) wired straight in. Generalise later.
 */
export interface BlockIO {
  /** Planar stereo block, layout [L(blockFrames) | R(blockFrames)], read_write. */
  sig: GPUBuffer
  blockFrames: number
  /** Monotonic sample index since playback start (for circular delay indexing). */
  baseIndex: number
  sampleRate: number
}

export interface Insert {
  readonly name: string
  bypass: boolean
  process(enc: GPUCommandEncoder, io: BlockIO): void
  reset(): void
}
