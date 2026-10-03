// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

// electron-vite builds three bundles:
//   main    -> out/main/index.js      (CJS, Electron main process, native audio I/O)
//   preload -> out/preload/index.js   (CJS, isolated bridge)
//   renderer-> out/renderer/*         (ESM, Chromium + WebGPU, all DAW logic)
//
// externalizeDepsPlugin keeps `dependencies` (e.g. audify's native .node) out of
// the bundle so they're require()'d at runtime.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve('src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve('src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    }
  }
})
