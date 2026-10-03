// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

// Claude Code / VSCode's integrated terminal exports ELECTRON_RUN_AS_NODE=1,
// which makes ANY Electron binary (including this project's) boot as plain Node
// with no `app` / `BrowserWindow`. Strip it before handing off to electron-vite
// so `npm run dev` / `npm run preview` work from any terminal.
//
// Usage: node scripts/run.mjs <dev|preview|build>
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

delete process.env.ELECTRON_RUN_AS_NODE

// `--mcp` (npm run dev:mcp) turns on the built-in MCP server (DAW_MCP_PORT, default 7777).
const args = process.argv.slice(2).filter((a) => {
  if (a === '--mcp') {
    process.env.DAW_MCP = '1'
    return false
  }
  return true
})

const here = dirname(fileURLToPath(import.meta.url))
const bin = resolve(here, '../node_modules/electron-vite/bin/electron-vite.js')
const res = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' })
process.exit(res.status ?? 1)
