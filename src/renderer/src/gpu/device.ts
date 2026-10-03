// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/** Single shared WebGPU device for the whole renderer. */
export interface Gpu {
  adapter: GPUAdapter
  device: GPUDevice
  /** Canvas presentation format, resolved once. */
  format: GPUTextureFormat
}

let cached: Gpu | null = null

export async function initGpu(): Promise<Gpu> {
  if (cached) return cached
  if (!('gpu' in navigator)) {
    throw new Error('navigator.gpu is undefined — WebGPU unavailable in this Electron/Chromium build')
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('requestAdapter() returned null (no compatible GPU)')

  const device = await adapter.requestDevice({
    label: 'gpudaw-device',
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize
    }
  })

  device.lost.then((info) => {
    // `reason === 'destroyed'` is the normal teardown / HMR-reload path — ignore.
    if (info.reason === 'destroyed') return
    // Otherwise surface loudly; the whole engine needs a rebuild after a loss.
    console.error('[gpu] device lost:', info.reason, info.message)
    if (cached?.device === device) cached = null
  })

  cached = { adapter, device, format: navigator.gpu.getPreferredCanvasFormat() }
  return cached
}

export function getGpu(): Gpu {
  if (!cached) throw new Error('initGpu() has not completed yet')
  return cached
}
