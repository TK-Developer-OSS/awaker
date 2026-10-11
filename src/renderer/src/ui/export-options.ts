// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import {
  DEFAULT_STEM_EXPORT,
  sanitizeStemExport,
  type StemExportSettings
} from '../audio/stem-export'
import type { OptionSection, OptionValue } from './options-model'

/**
 * Options → Export: what a stem export does unless a caller says otherwise (File → Export → Stems…, the
 * `stems_export` MCP tool / the assistant). Defaults follow a standard channel export: 24-bit WAV at the
 * project's rate, the channel's own strip + inserts in, the master chain out.
 */

let current: StemExportSettings = { ...DEFAULT_STEM_EXPORT }

export const getStemDefaults = (): StemExportSettings => current

const toSettings = (v: Record<string, OptionValue>): StemExportSettings =>
  sanitizeStemExport({
    bitDepth: Number(v['bitDepth']),
    sampleRate: Number(v['sampleRate']),
    process: v['process'],
    masterChain: v['masterChain'] === 'include',
    tailSeconds: v['tailSeconds']
  })

export const exportOptions: OptionSection = {
  id: 'export',
  title: 'Export（ステム書き出し）',
  description:
    'File → Export → Stems… / Mixdown… と、AI（stems_export / mixdown_export）の書き出しの既定値です（Mixdown はビット深度・レート・テイル秒数だけを使います）。既定は一般的なチャンネル書き出しと同じ: 24-bit WAV・プロジェクトのレート・チャンネルのストリップとインサートを通す・マスターのチェーンは通さない。',
  fields: [
    {
      key: 'bitDepth',
      type: 'choice',
      label: 'ビット深度',
      choices: [
        { value: '24', label: '24-bit' },
        { value: '32', label: '32-bit float' },
        { value: '16', label: '16-bit（ディザ付き）' }
      ]
    },
    {
      key: 'sampleRate',
      type: 'choice',
      label: 'サンプルレート',
      choices: [
        { value: '0', label: 'プロジェクトと同じ' },
        { value: '48000', label: '48 kHz' },
        { value: '44100', label: '44.1 kHz' },
        { value: '96000', label: '96 kHz' }
      ]
    },
    {
      key: 'process',
      type: 'choice',
      label: 'チャンネルの処理',
      hint: 'インサートなどを通さない書き出し（素の音）も選べる',
      choices: [
        { value: 'full', label: 'ストリップ + インサートを通す' },
        { value: 'noInserts', label: 'インサートを通さない' },
        { value: 'dry', label: 'ストリップも通さない' }
      ]
    },
    {
      key: 'masterChain',
      type: 'choice',
      label: 'マスターの処理',
      hint: '含める = マスターのフェーダーとインサート（EQ / コンプ / マキシマイザー）も通す',
      choices: [
        { value: 'exclude', label: '含めない（一般的なチャンネル書き出しと同じ）' },
        { value: 'include', label: '含める' }
      ]
    },
    {
      key: 'tailSeconds',
      type: 'number',
      label: '末尾の余韻',
      hint: 'リバーブ / ディレイの尾を切らないための追加秒数',
      min: 0,
      max: 60,
      step: 0.5,
      unit: '秒'
    }
  ],
  defaults: {
    bitDepth: String(DEFAULT_STEM_EXPORT.bitDepth),
    sampleRate: String(DEFAULT_STEM_EXPORT.sampleRate),
    process: DEFAULT_STEM_EXPORT.process,
    masterChain: DEFAULT_STEM_EXPORT.masterChain ? 'include' : 'exclude',
    tailSeconds: DEFAULT_STEM_EXPORT.tailSeconds
  },
  apply(values) {
    current = toSettings(values)
  }
}
