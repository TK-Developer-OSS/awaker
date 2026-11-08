// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Debug monitor window: what the audio paths are doing right now (output buffer, live path, return input,
 * load) and the dropout events, refreshed once a second from the main process. The same lines go to the
 * session log file (shown at the top), so a glitch can be read back afterwards.
 */

interface Snapshot {
  out: {
    backend: string
    sampleRate: number
    bufferedFrames: number
    underrunFrames: number
    live: { enabled: boolean; blocks: number; late: number; tooFar: number; rttMeanMs: number; rttMaxMs: number }
  }
  ret: {
    mode: string
    deviceName: string
    ringBufferedFrames: number
    ringTargetFrames: number
    ppm: number
    overruns: number
    underruns: number
    resyncs: number
    receivedFrames: number
    injectedFrames: number
  }
  win: Record<string, number | string>
  events: string[]
  file: string
}

const r1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1)

export function createDebugMonitor(host: HTMLElement): { setVisible(on: boolean): void; update(s: Snapshot): void; setFile(f: string): void } {
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;right:16px;top:56px;width:440px;max-height:70vh;overflow:auto;z-index:50;display:none;' +
    'background:var(--panel,#16181d);border:1px solid var(--line,#333);border-radius:6px;padding:8px 10px;' +
    'font:11px/1.45 ui-monospace,Consolas,monospace;color:var(--text,#ddd);box-shadow:0 6px 24px rgba(0,0,0,.45)'
  const head = document.createElement('div')
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-weight:700'
  head.textContent = 'Debug monitor'
  const close = document.createElement('button')
  close.textContent = '×'
  close.style.cssText = 'background:none;border:none;color:inherit;font-size:14px;cursor:pointer'
  close.addEventListener('click', () => void window.daw.debugSet(false))
  head.appendChild(close)
  const file = document.createElement('div')
  file.style.cssText = 'color:var(--dim,#888);word-break:break-all;margin-bottom:6px'
  const body = document.createElement('pre')
  body.style.cssText = 'margin:0;white-space:pre-wrap'
  const evHead = document.createElement('div')
  evHead.textContent = 'Events (dropouts)'
  evHead.style.cssText = 'margin-top:8px;font-weight:700'
  const ev = document.createElement('pre')
  ev.style.cssText = 'margin:0;white-space:pre-wrap;color:#ffb454'
  el.append(head, file, body, evHead, ev)
  host.appendChild(el)

  return {
    setVisible(on) {
      el.style.display = on ? 'block' : 'none'
    },
    setFile(f) {
      file.textContent = `log: ${f}`
    },
    update(s) {
      const sr = s.out.sampleRate || 96000
      const o = s.out
      const r = s.ret
      const w = s.win
      const lines = [
        `output   ${o.backend || '-'}  buffer ${r1((o.bufferedFrames / sr) * 1000)} ms  underrun ${o.underrunFrames} frames`,
        `live     ${o.live.enabled ? 'on' : 'off'}  blocks ${o.live.blocks}  late ${o.live.late}  too far ${o.live.tooFar}`,
        `         rtt ${r1(o.live.rttMeanMs)} / max ${r1(o.live.rttMaxMs)} ms`,
        `live bus block ${w['liveBlock'] ?? '-'}  latency ${w['liveLatencyMs'] ?? '-'} ms  proc ${w['liveProcMs'] ?? '-'} / max ${w['liveProcMaxMs'] ?? '-'} ms  dropped ${w['liveDropped'] ?? '-'}`,
        `return   ${r.mode}${r.mode !== 'off' ? `  ${r.deviceName}` : ''}`,
        r.mode !== 'off'
          ? `         ring ${r.ringBufferedFrames}/${r.ringTargetFrames}  ppm ${r.ppm}  over ${r.overruns}  under ${r.underruns}  resync ${r.resyncs}`
          : '',
        `load     CPU ${w['cpuPct'] ?? '-'}%  GPU ${w['gpuPct'] ?? '-'}%  Live ${w['livePct'] ?? '-'}%`,
        `playback ${w['playing'] ? 'playing' : 'stopped'}  at ${w['playheadS'] ?? '-'} s`
      ]
      body.textContent = lines.filter(Boolean).join('\n')
      ev.textContent = s.events.length ? s.events.slice(-30).reverse().join('\n') : '(none)'
      this.setFile(s.file)
    }
  }
}
