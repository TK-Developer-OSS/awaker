// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/** The parts of GPUAdapterInfo this check reads (kept loose: browsers differ in what they fill in). */
export interface AdapterInfoLike {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
  isFallbackAdapter?: boolean
}

/**
 * True when WebGPU runs on the CPU (SwiftShader / WARP / a "fallback adapter") instead of a real GPU.
 * It still works — every pass runs — but slowly, so the GPU lamp stays dark in that case.
 */
export function isSoftwareAdapter(info: AdapterInfoLike | undefined | null, adapterFallbackFlag = false): boolean {
  if (adapterFallbackFlag || info?.isFallbackAdapter) return true
  if (!info) return false
  const text = `${info.vendor ?? ''} ${info.architecture ?? ''} ${info.device ?? ''} ${info.description ?? ''}`.toLowerCase()
  if (/swiftshader|\bwarp\b|llvmpipe|software|basic render driver|microsoft basic/.test(text)) return true
  // Chrome's own software device reports vendor "google" with no real GPU vendor in it
  return (info.vendor ?? '').toLowerCase() === 'google' && !/nvidia|amd|intel|apple|qualcomm|arm/.test(text)
}
