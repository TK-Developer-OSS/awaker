// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

import type { DawApi } from '../../preload/index'

declare global {
  interface Window {
    daw: DawApi
  }
}

export {}
