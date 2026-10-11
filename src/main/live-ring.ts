// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Time-aligned landing strip for the live (line-input) path.
 *
 * The renderer processes each block of line input on the GPU and sends it back tagged with
 * the **output frame** it belongs at. This ring holds those blocks until the audio callback
 * reaches that frame, then adds them onto the pre-rendered playback block. Position is by
 * frame number, never by arrival time, so IPC / GPU jitter only decides whether a block is
 * on time, not where it lands. A block that missed its frame is dropped (the part still in
 * the future is kept), never slid.
 */
export class LiveRing {
  private readonly buf: Float32Array
  private readonly cap: number
  /** Blocks (or block parts) dropped because their frames had already been played. */
  late = 0
  /** Frames dropped for being later than the ring can hold (far in the future). */
  tooFar = 0
  written = 0

  constructor(capFrames: number) {
    this.cap = Math.max(4, capFrames | 0)
    this.buf = new Float32Array(this.cap * 2)
  }

  /**
   * Store interleaved stereo `data` so its first frame lands at output frame `startFrame`.
   * `now` is the next output frame the callback will play (everything before it is gone).
   * Returns the number of frames actually stored.
   */
  write(startFrame: number, data: Float32Array, now: number): number {
    const frames = data.length >> 1
    let skip = 0
    if (startFrame < now) {
      skip = Math.min(frames, Math.floor(now - startFrame))
      if (skip > 0) this.late++
    }
    let n = frames - skip
    if (n <= 0) return 0
    const first = startFrame + skip
    if (first + n > now + this.cap) {
      const keep = Math.max(0, Math.floor(now + this.cap - first))
      this.tooFar += n - keep
      n = keep
      if (n <= 0) return 0
    }
    for (let i = 0; i < n; i++) {
      const p = ((first + i) % this.cap) * 2
      this.buf[p] = data[(skip + i) * 2]
      this.buf[p + 1] = data[(skip + i) * 2 + 1]
    }
    this.written += n
    return n
  }

  /**
   * Add the frames [start, start+frames) into `dst` (interleaved stereo, `frames` long) and
   * clear them from the ring. Returns true if anything non-zero was added.
   */
  take(start: number, frames: number, dst: Float32Array): boolean {
    let any = false
    for (let i = 0; i < frames; i++) {
      const p = ((start + i) % this.cap) * 2
      const l = this.buf[p]
      const r = this.buf[p + 1]
      if (l !== 0 || r !== 0) {
        dst[i * 2] += l
        dst[i * 2 + 1] += r
        this.buf[p] = 0
        this.buf[p + 1] = 0
        any = true
      }
    }
    return any
  }

  clear(): void {
    this.buf.fill(0)
    this.late = 0
    this.tooFar = 0
    this.written = 0
  }
}
