// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import {
  AI_BLOCKED_TOOLS,
  DEFAULT_AI_CONFIG,
  aiToolSpecs,
  buildClaudeArgs,
  claudeMcpConfig,
  isClaudeExecutableName,
  parseClaudeLine,
  checkEndpoint,
  OPERATING_GUIDE,
  SYSTEM_PROMPT,
  CLAUDE_APP_PROMPT,
  compactOldToolResults,
  coerceToolArgs,
  effectiveBaseUrl,
  explainApiError,
  compactToolCatalogue,
  extractTextToolCalls,
  isNoToolsError,
  isOutOfMemoryError,
  OLLAMA_GPU_LAYER_STEPS,
  ollamaChatUrl,
  parseOllamaResponse,
  toOllamaMessages,
  toPlainChat,
  withGeminiSignatures,
  isOpenAiKind,
  simplifySchema,
  clipToolResult,
  completionsUrl,
  parseCompletion,
  redactKey,
  runAgentTurn,
  sanitizeAiConfig,
  toOpenAiTools,
  trimHistory,
  type AgentIO,
  type ChatMessage
} from '../src/main/ai-core'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

// ---- config: nothing is built in, junk falls back
check('default: Claude Code started by the app, nothing filled in', DEFAULT_AI_CONFIG.backend === 'claude-app' && DEFAULT_AI_CONFIG.baseUrl === '' && DEFAULT_AI_CONFIG.model === '' && DEFAULT_AI_CONFIG.claudePath === '' && DEFAULT_AI_CONFIG.claudeModel === '')
check('sanitize: garbage → default', JSON.stringify(sanitizeAiConfig(42)) === JSON.stringify(DEFAULT_AI_CONFIG))
check('sanitize: unknown backend → default', sanitizeAiConfig({ backend: 'x' }).backend === 'claude-app')
check('sanitize: every backend is accepted', ['claude-app', 'claude-mcp', 'ollama', 'gemini', 'openai'].every((b) => sanitizeAiConfig({ backend: b }).backend === b))
const s = sanitizeAiConfig({ backend: 'openai', baseUrl: '  https://h/v1/  ', model: ' m ', apiKey: 'sk-LEAK' })
check('sanitize: trims, and never carries a key', s.baseUrl === 'https://h/v1/' && s.model === 'm' && !('apiKey' in s))
check('sanitize: over-long values are cut', sanitizeAiConfig({ baseUrl: 'a'.repeat(999) }).baseUrl.length === 300)
check('sanitize: the system prompt is kept (trimmed, newlines intact) and bounded', sanitizeAiConfig({ systemPrompt: '  line1\nline2  ' }).systemPrompt === 'line1\nline2' && sanitizeAiConfig({ systemPrompt: 'x'.repeat(20000) }).systemPrompt.length === 8000 && sanitizeAiConfig({}).systemPrompt === '' && sanitizeAiConfig({ systemPrompt: 5 }).systemPrompt === '')

// ---- launching the person's Claude Code
check('only a real claude executable may be launched', isClaudeExecutableName('claude') && isClaudeExecutableName('C:\\Users\\a\\claude.exe') && isClaudeExecutableName('/usr/local/bin/claude'))
check('other names are refused', !isClaudeExecutableName('claude.cmd') && !isClaudeExecutableName('evil.exe') && !isClaudeExecutableName('notclaude.exe') && !isClaudeExecutableName('claude.exe.bat') && !isClaudeExecutableName('C:\\claude\\run.exe'))
const args = buildClaudeArgs({ mcpConfigPath: 'C:/t/mcp.json', sessionId: null, model: '', blocked: ['screenshot', 'project_load_file'] })
const at = (flag: string): string => args[args.indexOf(flag) + 1]
check('args: headless, streaming JSON', args[0] === '-p' && at('--output-format') === 'stream-json' && args.includes('--verbose'))
check('args: only our MCP config', at('--mcp-config') === 'C:/t/mcp.json' && args.includes('--strict-mcp-config'))
check('args: every built-in tool is off', args.indexOf('--tools') >= 0 && at('--tools') === '')
check('args: only the app tools are allowed, the blocked ones are denied', at('--allowedTools') === 'mcp__awaker' && args.slice(args.indexOf('--disallowedTools') + 1).join() === 'mcp__awaker__screenshot,mcp__awaker__project_load_file')
check('args: no --resume / --model on a fresh, default run', !args.includes('--resume') && !args.includes('--model'))
const args2 = buildClaudeArgs({ mcpConfigPath: 'x', sessionId: 'abc-123', model: 'sonnet', blocked: [] })
const args3 = buildClaudeArgs({ mcpConfigPath: 'x', sessionId: null, model: '', blocked: [], prompt: 'MY PROMPT' })
check("args: the person's own prompt replaces the built-in one", args3[args3.indexOf('--append-system-prompt') + 1] === 'MY PROMPT' && args[args.indexOf('--append-system-prompt') + 1].includes('Awaker'))
const args4 = buildClaudeArgs({ mcpConfigPath: 'x', sessionId: null, model: '', blocked: [], prompt: '   ' })
check('args: a blank own prompt means the built-in one', args4[args4.indexOf('--append-system-prompt') + 1] === args[args.indexOf('--append-system-prompt') + 1])
check('args: continues the session and picks the model', args2[args2.indexOf('--resume') + 1] === 'abc-123' && args2[args2.indexOf('--model') + 1] === 'sonnet' && !args2.includes('--disallowedTools'))
const mc = JSON.parse(claudeMcpConfig('http://127.0.0.1:50000/mcp', 'tok')) as { mcpServers: { awaker: { type: string; url: string; headers: { Authorization: string } } } }
check('mcp config carries the private url + bearer token', mc.mcpServers.awaker.url === 'http://127.0.0.1:50000/mcp' && mc.mcpServers.awaker.headers.Authorization === 'Bearer tok' && mc.mcpServers.awaker.type === 'http')
check('stream: session id from the init line', parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1"}').sessionId === 's1')
const pl = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' こんにちは ' }, { type: 'tool_use', name: 'x', input: {} }, { type: 'text', text: '' }] } }))
check('stream: assistant text blocks only (tool_use and empty text skipped)', pl.texts.join('|') === 'こんにちは')
check('stream: success result', JSON.stringify(parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1"}').done) === '{"finalText":"ok"}')
check('stream: error result', parseClaudeLine('{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}').done?.error === 'error_max_turns')
check('stream: garbage is ignored', parseClaudeLine('not json').texts.length === 0 && parseClaudeLine('[1]').texts.length === 0)

// ---- OpenAI-compatible presets (Ollama / Gemini / other)
check('which backends are the OpenAI-compatible kind', isOpenAiKind('ollama') && isOpenAiKind('gemini') && isOpenAiKind('openai') && !isOpenAiKind('claude-app') && !isOpenAiKind('claude-mcp'))
check('ollama: preset address when the URL is empty', effectiveBaseUrl({ backend: 'ollama', baseUrl: '' }) === 'http://localhost:11434/v1')
check('gemini: preset address when the URL is empty', effectiveBaseUrl({ backend: 'gemini', baseUrl: '' }) === 'https://generativelanguage.googleapis.com/v1beta/openai')
check('a typed URL always wins over the preset', effectiveBaseUrl({ backend: 'ollama', baseUrl: 'http://192.168.1.5:11434/v1' }) === 'http://192.168.1.5:11434/v1')
check('other: no address built in', effectiveBaseUrl({ backend: 'openai', baseUrl: '' }) === '')
check('the preset addresses pass the endpoint check', checkEndpoint(effectiveBaseUrl({ backend: 'ollama', baseUrl: '' })).ok && checkEndpoint(effectiveBaseUrl({ backend: 'gemini', baseUrl: '' })).ok)
const ownerSchema = { type: 'object', properties: { owner: { description: 'Track id', anyOf: [{ type: 'number' }, { type: 'string', enum: ['master'] }] }, n: { type: 'number' } }, required: ['owner'], additionalProperties: false }
const simp = simplifySchema(ownerSchema) as { additionalProperties?: unknown; properties: { owner: { type: string; anyOf?: unknown; description: string }; n: { type: string } } }
check('simplify: additionalProperties dropped', !('additionalProperties' in simp))
check('simplify: a mixed union becomes a plain string and keeps its choices in the description', simp.properties.owner.type === 'string' && !('anyOf' in simp.properties.owner) && simp.properties.owner.description.includes('master'))
check('simplify: plain properties untouched', simp.properties.n.type === 'number')
check('coerce: "3" becomes 3 where the original allowed a number', coerceToolArgs(ownerSchema, { owner: '3' }).owner === 3)
check("coerce: 'master' stays", coerceToolArgs(ownerSchema, { owner: 'master' }).owner === 'master')
check('coerce: other keys untouched', coerceToolArgs(ownerSchema, { owner: 1, n: '7' }).n === '7')

// ---- tool calls written as text (small local models)
const known = new Set(['tracks_list', 'track_set'])
const fence = extractTextToolCalls('```json\n{"name":"tracks_list","arguments":{}}\n```', known)
check('text call: ```json fence', fence.calls.length === 1 && fence.calls[0].function.name === 'tracks_list' && fence.calls[0].function.arguments === '{}' && fence.rest === '')
const tag = extractTextToolCalls('見ます\n<tool_call>\n{"name":"track_set","arguments":{"track":1,"gainDb":-3}}\n</tool_call>', known)
check('text call: <tool_call> tag, prose kept', tag.calls.length === 1 && JSON.parse(tag.calls[0].function.arguments).gainDb === -3 && tag.rest === '見ます')
const bare = extractTextToolCalls('{"name":"tracks_list","parameters":{"a":1}}', known)
check('text call: bare JSON with "parameters"', bare.calls.length === 1 && bare.calls[0].function.arguments === '{"a":1}')
check('text call: an array makes several calls', extractTextToolCalls('[{"name":"tracks_list","arguments":{}},{"name":"track_set","arguments":{"track":2}}]', known).calls.length === 2)
check('text call: unknown tool names are ignored', extractTextToolCalls('```json\n{"name":"rm_rf","arguments":{}}\n```', known).calls.length === 0)
check('text call: JSON that is only shown, not a call, is left alone', extractTextToolCalls('例: {"gain": 3}', known).calls.length === 0)
check('text call: plain prose / null', extractTextToolCalls('こんにちは', known).calls.length === 0 && extractTextToolCalls(null, known).calls.length === 0)

// ---- Ollama native API + prompt-mode (no tool template)
check('ollama chat url', ollamaChatUrl('http://localhost:11434/v1') === 'http://localhost:11434/api/chat' && ollamaChatUrl('http://host.docker.internal:11434') === 'http://host.docker.internal:11434/api/chat' && ollamaChatUrl('nope') === '')
check('numCtx: default, clamp, rounding', sanitizeAiConfig({}).numCtx === 8192 && sanitizeAiConfig({ numCtx: 100 }).numCtx === 2048 && sanitizeAiConfig({ numCtx: 999999 }).numCtx === 32768 && sanitizeAiConfig({ numCtx: 'x' }).numCtx === 8192)
const hist: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tracks_list', arguments: '{"a":1}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'RESULT' }
]
const om = toOllamaMessages(hist) as { role: string; content: string; tool_name?: string; tool_calls?: { function: { arguments: unknown } }[] }[]
check('ollama messages: arguments become an object', typeof om[2].tool_calls?.[0].function.arguments === 'object' && (om[2].tool_calls?.[0].function.arguments as { a: number }).a === 1)
check('ollama messages: the tool result carries the tool name', om[3].role === 'tool' && om[3].tool_name === 'tracks_list')
const op = parseOllamaResponse({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'tracks_list', arguments: { x: 2 } } }] } })
check('ollama response: structured tool call', op.content === null && op.tool_calls?.[0].function.name === 'tracks_list' && op.tool_calls[0].function.arguments === '{"x":2}')
check('ollama response: plain text', parseOllamaResponse({ message: { content: 'hello' } }).content === 'hello')
let oerr = ''
try { parseOllamaResponse({ error: 'model not found' }) } catch (e) { oerr = (e as Error).message }
check('ollama response: error text surfaces', oerr === 'model not found')
check('no-tools error is recognised only for 400 + that text', isNoToolsError(400, '{"error":{"message":"x does not support tools"}}') && !isNoToolsError(500, 'does not support tools') && !isNoToolsError(400, 'bad request'))
check('OOM error is recognised (500 + cudaMalloc / unable to allocate)', isOutOfMemoryError(500, 'llama runner process has terminated: cudaMalloc failed: out of memory') && isOutOfMemoryError(500, 'unable to allocate CUDA0 buffer') && !isOutOfMemoryError(400, 'out of memory') && !isOutOfMemoryError(500, 'model not found'))
check('GPU layer steps go down and end at 0', OLLAMA_GPU_LAYER_STEPS.every((n, i, a) => i === 0 || n < a[i - 1]) && OLLAMA_GPU_LAYER_STEPS[OLLAMA_GPU_LAYER_STEPS.length - 1] === 0)
const cat = compactToolCatalogue([{ name: 'track_set', description: 'Set a track. More text.', inputSchema: { type: 'object', properties: { track: { type: 'number' }, mute: { type: 'boolean' } }, required: ['track'] } }])
check('catalogue: name, required vs optional params, first sentence', cat === '- track_set(track: number, mute?: boolean): Set a track.')
const pc2 = toPlainChat(hist, cat)
check('prompt mode: tools in the system prompt, no tool role left', pc2[0].role === 'system' && pc2[0].content.includes('track_set(') && pc2.every((m) => m.role !== ('tool' as string)))
check('prompt mode: the assistant call is written as JSON, the result comes back as a user line', pc2[2].content.includes('{"name": "tracks_list", "arguments": {"a":1}}') && pc2[3].role === 'user' && pc2[3].content.startsWith('Tool result (tracks_list)'))
check('prompt mode: a model\'s own JSON reply is read back as a call', extractTextToolCalls(pc2[2].content, new Set(['tracks_list'])).calls.length === 1)

// ---- Gemini 3 thought signatures
const sigResp = parseCompletion({ choices: [{ message: { content: null, tool_calls: [
  { id: 'a', type: 'function', function: { name: 'track_set', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG123' } } },
  { id: 'b', type: 'function', function: { name: 'tracks_list', arguments: '{}' } }
] } }] })
check('the thought signature is kept when parsing', JSON.stringify(sigResp.tool_calls?.[0].extra_content) === '{"google":{"thought_signature":"SIG123"}}' && sigResp.tool_calls?.[1].extra_content === undefined)
const sent = withGeminiSignatures([{ role: 'assistant', content: null, tool_calls: sigResp.tool_calls }])
const sc = (sent[0] as { tool_calls: { extra_content?: { google?: { thought_signature?: string } } }[] }).tool_calls
check('a real signature is sent back untouched', sc[0].extra_content?.google?.thought_signature === 'SIG123')
check('a call without one gets the documented placeholder', sc[1].extra_content?.google?.thought_signature === 'skip_thought_signature_validator')
check('the stored history is not modified', sigResp.tool_calls?.[1].extra_content === undefined)
check('other messages pass through', withGeminiSignatures([{ role: 'user', content: 'x' }])[0].role === 'user')

// ---- general working rules, step limit, compaction of old results
check('maxSteps: default, clamp, rounding', sanitizeAiConfig({}).maxSteps === 40 && sanitizeAiConfig({ maxSteps: 1 }).maxSteps === 4 && sanitizeAiConfig({ maxSteps: 9999 }).maxSteps === 200 && sanitizeAiConfig({ maxSteps: 12.6 }).maxSteps === 13)
check('every assistant prompt carries the operating guide', SYSTEM_PROMPT.includes(OPERATING_GUIDE) && CLAUDE_APP_PROMPT.includes(OPERATING_GUIDE))
check('the guide stays short (small models pay per token)', OPERATING_GUIDE.length < 700, String(OPERATING_GUIDE.length))
check('the guide: batch in one message, real ranges, put back, no unchecked claims, ask when unclear', /ONE message/.test(OPERATING_GUIDE) && /-60\.\.\+6/.test(OPERATING_GUIDE) && /put it back/.test(OPERATING_GUIDE) && /Never say it worked/.test(OPERATING_GUIDE) && /ask/.test(OPERATING_GUIDE))
check('no wave / animation recipe in the prompts any more', !/sin\(|frame/i.test(SYSTEM_PROMPT) && !/sin\(|frame/i.test(CLAUDE_APP_PROMPT))
{
  const h: ChatMessage[] = [{ role: 'user', content: 'go' }]
  for (let r = 0; r < 6; r++) {
    h.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${r}`, type: 'function', function: { name: 'track_set', arguments: '{}' } }] })
    h.push({ role: 'tool', tool_call_id: `c${r}`, content: `result-${r}-` + 'x'.repeat(400) })
  }
  compactOldToolResults(h, 2, 50)
  const tools = h.filter((m) => m.role === 'tool') as { content: string }[]
  check('old tool results are shortened, the last rounds stay whole', tools[0].content.length < 100 && tools[3].content.length < 100 && tools[4].content.length > 300 && tools[5].content.length > 300)
  check('compaction keeps the structure (same message count, ids intact)', h.length === 13 && (h[2] as { tool_call_id: string }).tool_call_id === 'c0')
}

// ---- API errors a person can act on
const e402 = explainApiError('HTTP 402 [{ "error": { "code": 402, "message": "Your prepayment credits are depleted.", "status": "RESOURCE_EXHAUSTED" } }]')
check('402 / depleted credits: says the balance is the problem and where to look', e402.includes('残高') && e402.includes('Options → AI') && e402.includes('HTTP 402'))
check('401: key problem', explainApiError('HTTP 401 invalid api key').includes('API キー'))
check('404: model or URL', explainApiError('HTTP 404 model not found').includes('モデル名'))
check('429 with quota text = quota; plain 429 = slow down', explainApiError('HTTP 429 quota exceeded for this project').includes('クォータ') && explainApiError('HTTP 429 slow down').includes('短時間'))
check('5xx: service side', explainApiError('HTTP 503 unavailable').includes('サービス側'))
check('a message that is not an HTTP error is left as it is', explainApiError('fetch failed') === 'fetch failed')
check('the raw detail is kept but bounded', explainApiError('HTTP 400 ' + 'x'.repeat(2000)).length < 700)

// ---- url + endpoint safety
check('completionsUrl appends', completionsUrl('https://h/v1/') === 'https://h/v1/chat/completions')
check('completionsUrl keeps a full url', completionsUrl('https://h/v1/chat/completions') === 'https://h/v1/chat/completions')
check('https anywhere is ok', checkEndpoint('https://api.example.com/v1').ok)
check('http localhost ok', checkEndpoint('http://localhost:11434/v1').ok)
check('http 127.0.0.1 ok', checkEndpoint('http://127.0.0.1:8080/v1').ok)
check('http LAN ok', checkEndpoint('http://192.168.1.20:8000/v1').ok && checkEndpoint('http://172.20.0.5/v1').ok && checkEndpoint('http://10.1.2.3/v1').ok)
check('http on the internet is refused', !checkEndpoint('http://api.example.com/v1').ok)
check('http 172.32 (not private) is refused', !checkEndpoint('http://172.32.0.1/v1').ok)
check('non-http scheme is refused', !checkEndpoint('file:///etc/passwd').ok && !checkEndpoint('ftp://h/').ok)
check('not a url is refused', !checkEndpoint('hello').ok)

// ---- secrets never reach the screen / log
check('redactKey', redactKey('401 for key sk-abc123 here', 'sk-abc123') === '401 for key *** here')
check('redactKey with no key is a no-op', redactKey('x', '') === 'x')

// ---- tools
const specs = [
  { name: 'tracks_list', description: 'd', inputSchema: { type: 'object' } },
  { name: 'project_save_file', description: 'd', inputSchema: { type: 'object' } },
  { name: 'screenshot', description: 'd', inputSchema: { type: 'object' } },
  { name: 'bounce', description: 'd', inputSchema: { type: 'object' } }
]
check('file-path / screenshot tools are not offered to the built-in agent', aiToolSpecs(specs).map((t) => t.name).join() === 'tracks_list,bounce')
check('blocked set covers every path-taking tool', ['chat_history', 'chat_type', 'project_save_file', 'project_load_file', 'dawproject_import', 'dawproject_export', 'midi_import', 'midi_export', 'track_add_wav'].every((n) => AI_BLOCKED_TOOLS.has(n)))
const oa = toOpenAiTools(specs.slice(0, 1)) as { type: string; function: { name: string } }[]
check('toOpenAiTools shape', oa[0].type === 'function' && oa[0].function.name === 'tracks_list')
check('clipToolResult', clipToolResult('x'.repeat(100), 10).startsWith('xxxxxxxxxx\n…(90 chars cut)') && clipToolResult('abc', 10) === 'abc')

// ---- response parsing
check('parse: plain text', parseCompletion({ choices: [{ message: { content: 'hi' } }] }).content === 'hi')
const pc = parseCompletion({ choices: [{ message: { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{"k":1}' } }, { function: { name: 'y', arguments: { z: 2 } } }] } }] })
check('parse: tool calls (string and object arguments, missing id)', pc.tool_calls?.length === 2 && pc.tool_calls[0].function.arguments === '{"k":1}' && pc.tool_calls[1].function.arguments === '{"z":2}' && pc.tool_calls[1].id === 'call_1')
let threw = ''
try { parseCompletion({ error: { message: 'bad key' } }) } catch (e) { threw = (e as Error).message }
check('parse: API error surfaces its message', threw === 'bad key')
threw = ''
try { parseCompletion('nope') } catch (e) { threw = (e as Error).message }
check('parse: non-object body throws', threw !== '')

// ---- agent loop with a scripted model
function scripted(replies: { content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }[]): AgentIO & { said: string[]; ran: string[]; seen: ChatMessage[][]; abort: boolean } {
  let i = 0
  const io = {
    said: [] as string[],
    ran: [] as string[],
    seen: [] as ChatMessage[][],
    abort: false,
    async complete(m: ChatMessage[]) {
      io.seen.push(m.slice())
      return replies[Math.min(i++, replies.length - 1)]
    },
    async runTool(name: string, args: Record<string, unknown>) {
      io.ran.push(`${name}:${JSON.stringify(args)}`)
      if (name === 'boom') throw new Error('kaboom')
      return `result of ${name}`
    },
    say: (t: string) => void io.said.push(t),
    aborted: () => io.abort
  }
  return io
}
const call = (id: string, name: string, args = '{}') => ({ id, type: 'function' as const, function: { name, arguments: args } })

async function agentTests(): Promise<void> {
{
  const io = scripted([{ content: '調べます', tool_calls: [call('1', 'tracks_list'), call('2', 'boom')] }, { content: 'おわり' }])
  const h: ChatMessage[] = []
  const r = await runAgentTurn(io, h, 'やって')
  check('agent: tool round then final answer', r === 'done' && io.said.join('|') === '調べます|おわり')
  check('agent: both tools ran, the failing one did not stop the turn', io.ran.length === 2)
  const toolMsgs = h.filter((m) => m.role === 'tool') as { content: string }[]
  check('agent: tool results (and errors) were fed back', toolMsgs.length === 2 && toolMsgs[0].content === 'result of tracks_list' && toolMsgs[1].content === 'error: kaboom')
  check('agent: system prompt is sent but not stored in history', io.seen[0][0].role === 'system' && h.every((m) => m.role !== 'system'))
  check('agent: the built-in prompt by default', (io.seen[0][0] as { content: string }).content.includes('Awaker DAW over GPU'))
}
{
  const io = scripted([{ content: 'ok' }])
  await runAgentTurn(io, [], 'q', 12, 'You are a terse mixing assistant.')
  check("agent: the person's own prompt is what is sent", (io.seen[0][0] as { content: string }).content === 'You are a terse mixing assistant.')
}
{
  const io = scripted([{ content: 'ok' }])
  await runAgentTurn(io, [], 'q', 12, '   ')
  check('agent: a blank own prompt falls back to the built-in one', (io.seen[0][0] as { content: string }).content.includes('Awaker DAW over GPU'))
}
{
  const io = scripted([{ content: null, tool_calls: [call('1', 'x', 'not json')] }, { content: 'ok' }])
  const h: ChatMessage[] = []
  await runAgentTurn(io, h, 'q')
  check('agent: bad JSON arguments become a tool error, not a crash', (h.find((m) => m.role === 'tool') as { content: string }).content.startsWith('error:'))
}
{
  const io = scripted([{ content: 'again', tool_calls: [call('1', 'x')] }])
  const r = await runAgentTurn(io, [], 'q', 3)
  check('agent: round limit stops a model that never finishes', r === 'round-limit' && io.ran.length === 3)
}
{
  const io = scripted([{ content: null, tool_calls: [call('1', 'x'), call('2', 'y')] }])
  io.runTool = async (n) => { io.ran.push(n); io.abort = true; return 'r' }
  const r = await runAgentTurn(io, [], 'q')
  check('agent: abort stops between tool calls', r === 'aborted' && io.ran.length === 1)
}

}

// ---- history bounds
{
  const h: ChatMessage[] = []
  for (let i = 0; i < 30; i++) {
    h.push({ role: 'user', content: `u${i}` }, { role: 'assistant', content: null, tool_calls: [call(`${i}`, 't')] }, { role: 'tool', tool_call_id: `${i}`, content: 'r' }, { role: 'assistant', content: `a${i}` })
  }
  trimHistory(h, 40)
  check('trimHistory keeps it bounded and starts on a user turn', h.length <= 40 && h[0].role === 'user')
}

void agentTests().then(() => {
  if (fails) { console.log(`${fails} FAILED`); process.exit(1) }
  console.log('ALL OK')
})
