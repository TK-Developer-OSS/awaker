// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { aiLabel, aiOptions, resolveAiConfig } from '../src/renderer/src/ui/ai-options'
import { isFieldVisible } from '../src/renderer/src/ui/options-model'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

const base = { ...aiOptions.defaults }
const v = {
  ...base,
  ollamaUrl: 'http://box:11434',
  ollamaModel: 'qwen3:4b',
  geminiModel: 'gemini-3.5-flash-lite',
  openaiUrl: 'https://x.example/v1',
  openaiModel: 'some-model'
}

// each service keeps its own URL / model: switching never carries a name over
const o = resolveAiConfig({ ...v, backend: 'ollama' })
check('ollama: its own URL and model', o.baseUrl === 'http://box:11434' && o.model === 'qwen3:4b')
const g = resolveAiConfig({ ...v, backend: 'gemini' })
check('gemini: its own model, no URL typed (preset is used)', g.model === 'gemini-3.5-flash-lite' && g.baseUrl === '')
const x = resolveAiConfig({ ...v, backend: 'openai' })
check('openai-compatible: its own URL and model', x.baseUrl === 'https://x.example/v1' && x.model === 'some-model')
const c = resolveAiConfig({ ...v, backend: 'claude-app', claudeModel: 'sonnet' })
check('claude: no URL / model of any service leaks in', c.baseUrl === '' && c.model === '' && c.claudeModel === 'sonnet')
check('gemini has a usable default model, the others start empty', aiOptions.defaults['geminiModel'] === 'gemini-3.5-flash-lite' && aiOptions.defaults['ollamaModel'] === '' && aiOptions.defaults['openaiModel'] === '')

// which fields show for which service
const shown = (backend: string): string[] =>
  aiOptions.fields.filter((f) => isFieldVisible(f, { ...base, backend })).map((f) => f.key).filter((k) => k !== 'backend')
check('claude-app shows path + model + its prompt', shown('claude-app').join() === 'claudePath,claudeModel,promptClaudeApp')
check('claude-mcp shows nothing', shown('claude-mcp').length === 0)
check('ollama shows url, model, its prompt, steps, context', shown('ollama').join() === 'ollamaUrl,ollamaModel,promptOllama,maxSteps,numCtx')
check('gemini shows its model, its prompt and the step limit', shown('gemini').join() === 'geminiModel,promptGemini,maxSteps')
check('openai-compatible shows url, model, its prompt, step limit', shown('openai').join() === 'openaiUrl,openaiModel,promptOpenai,maxSteps')

// one system prompt per service, empty = the built-in one
const withPrompts = { ...v, promptClaudeApp: 'CLAUDE', promptOllama: 'OLLAMA', promptGemini: 'GEMINI', promptOpenai: 'OPENAI' }
check('prompt: each service takes its own', resolveAiConfig({ ...withPrompts, backend: 'ollama' }).systemPrompt === 'OLLAMA' && resolveAiConfig({ ...withPrompts, backend: 'gemini' }).systemPrompt === 'GEMINI' && resolveAiConfig({ ...withPrompts, backend: 'openai' }).systemPrompt === 'OPENAI' && resolveAiConfig({ ...withPrompts, backend: 'claude-app' }).systemPrompt === 'CLAUDE')
check('prompt: the external Claude Code has none', resolveAiConfig({ ...withPrompts, backend: 'claude-mcp' }).systemPrompt === '')
check('prompt: empty by default (= the built-in one)', resolveAiConfig({ ...v, backend: 'gemini' }).systemPrompt === '')
const pf = aiOptions.fields.filter((f) => f.key.startsWith('prompt'))
check('prompt: four multi-line fields, each with the room for a real prompt', pf.length === 4 && pf.every((f) => f.type === 'text' && f.multiline === true && f.maxLength >= 4000))

// the label next to the chat window
check('label: ollama', aiLabel(o) === 'Ollama · qwen3:4b')
check('label: gemini', aiLabel(g) === 'Gemini · gemini-3.5-flash-lite')
check('label: other', aiLabel(x) === 'OpenAI 互換 · some-model')
check('label: claude shows the model or "default"', aiLabel(c) === 'Claude Code · sonnet' && aiLabel(resolveAiConfig({ ...v, backend: 'claude-app' })).includes('既定'))

if (fails) { console.log(`${fails} FAILED`); process.exit(1) }
console.log('ALL OK')
