// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findSkill, mergeSkills, normalizeSkillName, parseSkill, skillIndex } from '../src/main/skills'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

// ---- parsing
{
  const s = parseSkill('C:/x/skills/ai-mix/SKILL.md', '---\nname: ai-mix\ndescription: "Do the mix"\n---\n\n# Title\n\nbody line\n', 'app')
  check('front matter: name, description (quotes removed), body', !!s && s.name === 'ai-mix' && s.description === 'Do the mix' && s.body.startsWith('# Title') && s.source === 'app')
  const crlf = parseSkill('a/b/SKILL.md', '---\r\nname: x-y\r\ndescription: d\r\n---\r\nbody\r\n', 'user')
  check('CRLF files parse', !!crlf && crlf.name === 'x-y' && crlf.body === 'body')
  const bom = parseSkill('a/b/SKILL.md', '\uFEFF---\nname: bom\ndescription: d\n---\nbody', 'user')
  check('a BOM is tolerated (Windows editors)', !!bom && bom.name === 'bom')
  const bare = parseSkill('C:\\u\\skills\\my-tips.md', '# My tips\n\nuse less reverb\n', 'user')
  check('no front matter: the name comes from the file, the description from the text', !!bare && bare.name === 'my-tips' && bare.description === 'use less reverb')
  const folder = parseSkill('C:\\u\\skills\\drum-bus\\SKILL.md', 'just text', 'user')
  check('SKILL.md without a name: the folder is the name', !!folder && folder.name === 'drum-bus')
  check('an empty body is not a skill', parseSkill('a/SKILL.md', '---\nname: a\ndescription: b\n---\n   \n', 'app') === null)
  check('bounded: an enormous file is cut', parseSkill('a/SKILL.md', 'x'.repeat(100000), 'app')!.body.length === 24000)
  check('names are tidy: spaces and symbols become -', normalizeSkillName('  Drum Bus! ') === 'drum-bus' && normalizeSkillName('A_b') === 'a_b')
}

// ---- merging, finding, the index
{
  const app = [parseSkill('a/one/SKILL.md', 'one app', 'app')!, parseSkill('a/two/SKILL.md', 'two app', 'app')!]
  const user = [parseSkill('u/two/SKILL.md', 'two mine', 'user')!, parseSkill('u/three/SKILL.md', 'three mine', 'user')!]
  const m = mergeSkills(app, user)
  check('merge: the person\'s skill replaces the app\'s of the same name, new ones are added', m.map((s) => s.name).join() === 'one,two,three' && m[1].body === 'two mine' && m[1].source === 'user')
  check('find: case and _ / - do not matter', findSkill(m, 'ONE')?.name === 'one' && findSkill(parseAll(['ai-mix']), 'ai_mix')?.name === 'ai-mix')
  check('find: unknown / non-string → null', findSkill(m, 'nope') === null && findSkill(m, 3) === null)
  const idx = skillIndex(m)
  check('index: one line per skill, tells how to read one', idx.includes('skill_get') && idx.includes('- one:') && idx.includes('- three:') && skillIndex([]) === '')
}
function parseAll(names: string[]) {
  return names.map((n) => parseSkill(`x/${n}/SKILL.md`, `---\nname: ${n}\ndescription: d\n---\nbody`, 'app')!)
}

// ---- the skills that ship with the app
{
  const root = join(__dirname, '..', '..', '..', 'skills')
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const skills = dirs.map((d) => parseSkill(join(root, d, 'SKILL.md'), readFileSync(join(root, d, 'SKILL.md'), 'utf8'), 'app'))
  check('every shipped skill parses', skills.length >= 4 && skills.every((s) => !!s), `${dirs.join(', ')}`)
  const ok = skills.filter((s): s is NonNullable<typeof s> => !!s)
  check('names are unique and match their folder', new Set(ok.map((s) => s.name)).size === ok.length && ok.every((s, i) => s.name === dirs[i]))
  check('each has a one-line description of real length', ok.every((s) => s.description.length >= 20 && s.description.length <= 200))
  check('the three AI-mix stages are all in the ai-mix skill', ((): boolean => {
    const b = ok.find((s) => s.name === 'ai-mix')?.body ?? ''
    return ['-18', 'track_levels', 'stickOutDb', 'comp', 'spectrum_analyze', 'eq_apply', 'breakdown'].every((t) => b.includes(t))
  })())

  // every tool name a skill mentions (snake_case in the text) is a real tool of the app
  const mcp = readFileSync(join(__dirname, '..', '..', '..', 'src', 'main', 'mcp.ts'), 'utf8')
  const tools = new Set([...mcp.matchAll(/^\s+name: '([a-z_]+)',$/gm)].map((m) => m[1]))
  const mentioned = new Set<string>()
  for (const s of ok) for (const m of s.body.matchAll(/`([a-z]+_[a-z_]+)`/g)) mentioned.add(m[1])
  const unknown = [...mentioned].filter((t) => !tools.has(t))
  check('every tool a skill names exists', tools.size > 30 && unknown.length === 0, unknown.join(', '))
}

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
