// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A JSON-Lines log that rotates by size: `<base>.log` is the current file; when the next line would push it past
 * `maxBytes` it becomes `<base>.1.log`, the old `.1` becomes `.2`, … and the one past `keep` is deleted. So the
 * disk use is bounded (about `maxBytes * (keep + 1)`) and the newest entries are always in `<base>.log`.
 *
 * No Electron here (the folder is passed in), so it is unit-tested in Node. Appends are serialised, so two
 * callers at once cannot interleave a rotation.
 */
export class RotatingLog {
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly base = 'ai-ops',
    private readonly maxBytes = 1_000_000,
    private readonly keep = 5
  ) {}

  get currentPath(): string {
    return join(this.dir, `${this.base}.log`)
  }

  /** Append one entry (an object, written as one line). Never throws: a log failure must not break the app. */
  append(entry: unknown): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        const line = JSON.stringify(entry) + '\n'
        await mkdir(this.dir, { recursive: true })
        let size = 0
        try {
          size = (await stat(this.currentPath)).size
        } catch {
          /* no file yet */
        }
        if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) await this.rotate()
        await appendFile(this.currentPath, line, 'utf8')
      } catch (err) {
        console.warn('[ai-log] could not write:', (err as Error).message)
      }
    }
    this.chain = this.chain.then(run, run)
    return this.chain
  }

  /**
   * The newest `limit` entries (oldest first), reading back through the rotated files. `filter` picks entries.
   * Lines that do not parse are skipped.
   */
  async readRecent(limit: number, filter?: (e: unknown) => boolean): Promise<unknown[]> {
    await this.chain // let a pending append land first
    const files = [this.currentPath, ...Array.from({ length: this.keep }, (_, i) => join(this.dir, `${this.base}.${i + 1}.log`))]
    const found: unknown[] = []
    for (const f of files) {
      let text = ''
      try {
        text = await readFile(f, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0 && found.length < limit; i--) {
        try {
          const e: unknown = JSON.parse(lines[i])
          if (!filter || filter(e)) found.push(e)
        } catch {
          /* a torn line */
        }
      }
      if (found.length >= limit) break
    }
    return found.reverse()
  }

  private async rotate(): Promise<void> {
    const f = (n: number): string => join(this.dir, `${this.base}.${n}.log`)
    await rm(f(this.keep), { force: true })
    for (let n = this.keep - 1; n >= 1; n--) {
      try {
        await rename(f(n), f(n + 1))
      } catch {
        /* that generation does not exist yet */
      }
    }
    try {
      await rename(this.currentPath, f(1))
    } catch {
      /* nothing to rotate */
    }
  }
}
