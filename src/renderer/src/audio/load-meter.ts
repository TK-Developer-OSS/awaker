// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Real-time load of an audio path: time spent producing audio ÷ the audio's own duration.
 * 100 % = the path only just keeps up; above that it falls behind (dropouts). Averaged over
 * roughly the last second of audio so a single slow block shows but does not flicker.
 */
export class LoadMeter {
  private busyMs = 0
  private audioMs = 0
  private lastAt = 0

  /** One block: `busyMs` of work produced `audioMs` of audio. */
  add(busyMs: number, audioMs: number): void {
    // decay towards ~1 s of audio so old blocks fade out
    const keep = Math.max(0, 1 - audioMs / 1000)
    this.busyMs = this.busyMs * keep + busyMs
    this.audioMs = this.audioMs * keep + audioMs
    this.lastAt = performance.now()
  }

  /** 0..n (1 = 100 %); 0 when the path has been idle for a second. */
  get load(): number {
    if (performance.now() - this.lastAt > 1000 || this.audioMs <= 0) return 0
    return this.busyMs / this.audioMs
  }
}
