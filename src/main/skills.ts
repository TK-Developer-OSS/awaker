// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * App skills, minus Electron (so it is unit-tested in Node): the parsing, merging and the index that goes into
 * the assistant's system prompt.
 *
 * A skill is a `SKILL.md` — a short front matter (`name`, `description`) and then the instructions. The app
 * ships some (`skills/<name>/SKILL.md`, bundled into the build); the person can add or override them in the
 * `skills` folder of the user-data folder (same name = theirs wins). The assistant sees only the index
 * (name + one line) and reads a skill with `skill_get` when the job calls for it, so a small model's context
 * is not spent on instructions it does not need — and every backend (Claude Code, Gemini, Ollama…) gets the
 * same detailed instructions, because they are delivered by a tool, not by a vendor feature.
 */

export type SkillSource = 'app' | 'user'

export interface Skill {
  name: string
  description: string
  body: string
  source: SkillSource
}

export const MAX_SKILL_CHARS = 24000
const MAX_DESCRIPTION = 200

/** `ai-mix`, `stems-groups`… letters, digits, `-` and `_`; anything else becomes `-`. */
export function normalizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function unquote(v: string): string {
  const t = v.trim()
  return t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'")) ? t.slice(1, -1) : t
}

/**
 * One SKILL.md → a skill. `path` gives the fallback name (the folder, or the file name). Returns null for a file
 * with no instructions or no usable name.
 */
export function parseSkill(path: string, text: string, source: SkillSource): Skill | null {
  const src = text.replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(src)
  const front: Record<string, string> = {}
  let body = src
  if (m) {
    body = m[2]
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line)
      if (kv) front[kv[1].toLowerCase()] = unquote(kv[2])
    }
  }
  body = body.trim()
  if (!body) return null
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const file = parts[parts.length - 1] ?? ''
  const fallback = /^skill\.md$/i.test(file) ? (parts[parts.length - 2] ?? '') : file.replace(/\.md$/i, '')
  const name = normalizeSkillName(front['name'] || fallback)
  if (!name) return null
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) ?? body.split(/\r?\n/)[0]
  const description = (front['description'] || firstLine.replace(/^#+\s*/, '')).replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION)
  return { name, description, body: body.slice(0, MAX_SKILL_CHARS), source }
}

/** The person's skills replace the app's of the same name; new names are added after the app's. */
export function mergeSkills(app: readonly Skill[], user: readonly Skill[]): Skill[] {
  const out = new Map<string, Skill>()
  for (const s of app) out.set(s.name, s)
  for (const s of user) out.set(s.name, s)
  return [...out.values()]
}

/** A skill by name — case, `_` / `-` and spaces do not matter. */
export function findSkill(skills: readonly Skill[], name: unknown): Skill | null {
  if (typeof name !== 'string') return null
  const n = normalizeSkillName(name.replace(/_/g, '-'))
  return skills.find((s) => normalizeSkillName(s.name.replace(/_/g, '-')) === n) ?? null
}

/** The few lines that go into the system prompt: what skills exist and when to read one. */
export function skillIndex(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return (
    '\n\nSkills — detailed, tested instructions for specific jobs. Before you start a job that one of them covers, ' +
    'call skill_get { name } and follow it exactly (skills_list shows them again):\n' +
    lines.join('\n')
  )
}
