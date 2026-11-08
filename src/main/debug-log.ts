// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Session log file: everything the main process prints, the window's warnings / errors / tagged info,
 * and — while the debug monitor is on — a stats line per second plus an event line whenever a dropout
 * counter goes up. One file per start in `<userData>/logs`, the newest KEEP kept. Writes are batched
 * (every 500 ms) so logging never blocks the audio path; quitting flushes synchronously.
 */
const KEEP = 20

const stamp = (d = new Date()): string => {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export class DebugLog {
  readonly file: string
  private pending: string[] = []
  private timer: NodeJS.Timeout | null = null
  private ready: Promise<void>

  constructor(dir: string) {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    this.file = join(dir, `awaker-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.log`)
    this.ready = this.prepare(dir)
    this.timer = setInterval(() => void this.flush(), 500)
  }

  private async prepare(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true })
      const old = (await readdir(dir)).filter((f) => /^awaker-\d{8}-\d{6}\.log$/.test(f)).sort()
      for (const f of old.slice(0, Math.max(0, old.length - (KEEP - 1)))) await rm(join(dir, f), { force: true })
    } catch {
      /* logging must never take the app down */
    }
  }

  /** One line: `HH:MM:SS.mmm [tag] text`. */
  line(tag: string, text: string): void {
    this.pending.push(`${stamp()} [${tag}] ${text.replace(/\r?\n/g, '\n    ')}\n`)
    if (this.pending.length > 5000) this.pending.splice(0, this.pending.length - 5000) // runaway: keep the newest
  }

  async flush(): Promise<void> {
    if (!this.pending.length) return
    const chunk = this.pending.join('')
    this.pending = []
    try {
      await this.ready
      await appendFile(this.file, chunk, 'utf8')
    } catch {
      /* disk full / no access: drop rather than block */
    }
  }

  /** On quit: write what is left, synchronously. */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.pending.length) return
    try {
      appendFileSync(this.file, this.pending.join(''), 'utf8')
    } catch {
      /* ignore */
    }
    this.pending = []
  }
}

/** Counters whose increase is a dropout worth an EVENT line. Paths are dotted keys into the stats object. */
export const DROPOUT_COUNTERS = [
  'out.underrunFrames',
  'out.live.late',
  'out.live.tooFar',
  'ret.underruns',
  'ret.overruns',
  'ret.resyncs',
  'win.live.dropped'
] as const

export function pick(obj: unknown, path: string): number {
  let v: unknown = obj
  for (const k of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
