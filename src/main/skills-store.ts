// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { app } from 'electron'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeSkills, parseSkill, type Skill } from './skills'

/**
 * Where the skills come from: the ones the app ships (`skills/<name>/SKILL.md` in the repo, bundled into the
 * build as text, so a packaged app needs no loose files) and the person's own in `<user-data>/skills/` (a
 * `<name>/SKILL.md`, or a loose `<name>.md`). The person's wins when the names match; they are read on every
 * call, so an edit takes effect on the next question without a restart.
 */

const bundledRaw = import.meta.glob('../../skills/*/SKILL.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const MAX_USER_SKILLS = 50
const MAX_USER_FILE = 60_000

export const userSkillsDir = (): string => join(app.getPath('userData'), 'skills')

export function bundledSkills(): Skill[] {
  const out: Skill[] = []
  for (const [path, text] of Object.entries(bundledRaw).sort(([a], [b]) => a.localeCompare(b))) {
    const s = parseSkill(path, text, 'app')
    if (s) out.push(s)
  }
  return out
}

async function userSkills(): Promise<Skill[]> {
  const dir = userSkillsDir()
  const out: Skill[] = []
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return out
  }
  for (const n of names.sort().slice(0, MAX_USER_SKILLS)) {
    const full = join(dir, n)
    try {
      const st = await stat(full)
      const file = st.isDirectory() ? join(full, 'SKILL.md') : /\.md$/i.test(n) ? full : ''
      if (!file) continue
      const fst = st.isDirectory() ? await stat(file) : st
      if (fst.size > MAX_USER_FILE) continue
      const s = parseSkill(file, await readFile(file, 'utf8'), 'user')
      if (s) out.push(s)
    } catch {
      /* a folder without SKILL.md, an unreadable file: skip it */
    }
  }
  return out
}

export async function loadSkills(): Promise<Skill[]> {
  return mergeSkills(bundledSkills(), await userSkills())
}

/** Make the folder (so the person can see where to put theirs) — best effort. */
export async function ensureUserSkillsDir(): Promise<string> {
  const dir = userSkillsDir()
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    /* read-only profile: the folder is only a convenience */
  }
  return dir
}
