// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { PlaybackScheduler } from './audio/scheduler'
import type { Clip } from './edit/model'
import type { ChannelStrip } from './gpu/channel-strip'
import type { Insert } from './gpu/insert'
import { state, update } from './state'

/**
 * Renderer half of the built-in MCP server (see src/main/mcp.ts). The tool specs
 * (names / schemas) live in main; this file holds the handlers. They drive the
 * same code paths the UI does — via the `McpCtx` that main.ts hands over — so a
 * regression run exercises the real app, not a parallel model of it.
 */

export interface McpLane {
  id: number
  clips: Clip[]
  mix: { gainDb: number; pan: number; mute: boolean; solo: boolean; rec: boolean }
  recIn: { ch: number; stereo: boolean }
  dsp: ChannelStrip
  inserts: Insert[]
  el: HTMLElement
}

export type Owner = number | 'master'

export interface McpCtx {
  lanes: McpLane[]
  scheduler: PlaybackScheduler
  serializeProject(): unknown
  restoreProject(p: unknown): Promise<void>
  addWavLane(path: string, title?: string): Promise<McpLane | null>
  addToneLane(seconds: number, title?: string): McpLane
  /** Reflect lane.mix / title / strip into the DOM (strip, detail pane, solo state). */
  syncLaneUI(lane: McpLane): void
  setLaneTitle(lane: McpLane, title: string): void
  applyStrip(lane: McpLane, bypass: boolean | undefined, patch: unknown): void
  masterInserts(): Insert[]
  makeInsert(kind: string, params: unknown, bypass: boolean): Insert | null
  insertKind(fx: Insert): string
  insertParams(fx: Insert): unknown
  /** Close a floating plugin window (if open) and redraw the rack / detail pane. */
  refreshInserts(owner: Owner, closeFx?: Insert): void
  slotCount: number
  getMasterGainDb(): number
  setMasterGainDb(db: number): void
  startRecording(synthetic: boolean): Promise<void>
  /** Resolves once the previous recording's takes are committed (clips on the lanes). */
  takesSettled(): Promise<void>
  gpuStatus(): string
}

type Args = Record<string, unknown>
type Tool = (a: Args) => Promise<unknown> | unknown

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const finite = (v: unknown, name: string): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`)
  return n
}

export function registerMcpTools(ctx: McpCtx): void {
  const lane = (id: unknown): McpLane => {
    const l = ctx.lanes.find((x) => x.id === Number(id))
    if (!l) throw new Error(`no track with id ${String(id)} (ids: ${ctx.lanes.map((x) => x.id).join(', ') || 'none'})`)
    return l
  }
  const insertList = (owner: unknown): { list: Insert[]; owner: Owner } => {
    if (owner === 'master') return { list: ctx.masterInserts(), owner: 'master' }
    return { list: lane(owner).inserts, owner: Number(owner) }
  }
  const fxAt = (list: Insert[], index: unknown): Insert => {
    const i = finite(index, 'index')
    const fx = list[i]
    if (!fx) throw new Error(`no insert at index ${i} (have ${list.length})`)
    return fx
  }

  const laneSummary = (l: McpLane): unknown => ({
    id: l.id,
    title: (l.el.querySelector('.lane-title') as HTMLElement | null)?.textContent ?? '',
    mix: { ...l.mix },
    recIn: { ...l.recIn },
    strip: { bypass: l.dsp.bypass, params: structuredClone(l.dsp.params) },
    clips: l.clips.map((c) => ({
      id: c.id,
      name: c.name,
      sourceId: c.sourceId,
      startFrame: c.startFrame,
      lengthFrames: c.lengthFrames,
      srcOffset: c.srcOffset,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
      gainDb: c.gainDb
    })),
    inserts: l.inserts.map((fx, index) => ({ index, kind: ctx.insertKind(fx), bypass: fx.bypass }))
  })

  const tools: Record<string, Tool> = {
    state_get: () => {
      const m = ctx.scheduler.metrics()
      return {
        playing: state.playing,
        recording: ctx.scheduler.recording,
        playheadFrame: Math.round(state.playhead),
        playheadSeconds: state.playhead / state.sampleRate,
        sampleRate: state.sampleRate,
        bpm: state.bpm,
        timeSig: `${state.timeSigNum}/${state.timeSigDen}`,
        totalFrames: state.totalFrames,
        totalSeconds: state.totalFrames / state.sampleRate,
        tracks: ctx.lanes.length,
        masterGainDb: ctx.getMasterGainDb(),
        gpu: ctx.gpuStatus(),
        audio: {
          backend: m.backend,
          device: m.deviceName,
          inputChannels: ctx.scheduler.inputChannels,
          inputError: ctx.scheduler.inputError,
          underrunFrames: m.underrunFrames,
          bufferedMs: m.bufferedMs
        },
        meters: {
          masterPeak: m.masterPeak,
          lufsMomentary: m.lufsM,
          lufsShortTerm: m.lufsS,
          lufsIntegrated: m.lufsI,
          lufsMaxShortTerm: m.lufsMax
        }
      }
    },

    project_get: () => ctx.serializeProject(),

    project_load: async (a) => {
      if (state.playing) await ctx.scheduler.stop()
      await ctx.restoreProject(a['project'])
      return { tracks: ctx.lanes.length }
    },

    tracks_list: () => ctx.lanes.map(laneSummary),

    track_add_tone: async (a) => {
      if (state.playing) await ctx.scheduler.stop()
      const l = ctx.addToneLane(Number(a['seconds']) > 0 ? Number(a['seconds']) : 6, a['title'] ? String(a['title']) : undefined)
      return laneSummary(l)
    },

    track_add_wav: async (a) => {
      if (state.playing) await ctx.scheduler.stop()
      const l = await ctx.addWavLane(String(a['path'] ?? ''), a['title'] ? String(a['title']) : undefined)
      if (!l) throw new Error('could not load that WAV (see logs)')
      return laneSummary(l)
    },

    track_set: (a) => {
      const l = lane(a['track'])
      if (a['gainDb'] !== undefined) l.mix.gainDb = Math.max(-60, Math.min(6, finite(a['gainDb'], 'gainDb')))
      if (a['pan'] !== undefined) l.mix.pan = Math.max(-1, Math.min(1, finite(a['pan'], 'pan')))
      if (a['mute'] !== undefined) l.mix.mute = !!a['mute']
      if (a['solo'] !== undefined) l.mix.solo = !!a['solo']
      if (a['rec'] !== undefined) l.mix.rec = !!a['rec']
      const ri = a['recIn'] as { ch?: unknown; stereo?: unknown } | undefined
      if (ri) l.recIn = { ch: Math.max(0, finite(ri.ch, 'recIn.ch') | 0), stereo: !!ri.stereo }
      if (a['title'] !== undefined) ctx.setLaneTitle(l, String(a['title']))
      ctx.syncLaneUI(l)
      return laneSummary(l)
    },

    strip_set: (a) => {
      const l = lane(a['track'])
      ctx.applyStrip(l, a['bypass'] === undefined ? undefined : !!a['bypass'], a['params'])
      return laneSummary(l)
    },

    insert_add: (a) => {
      const { list, owner } = insertList(a['owner'])
      const kind = String(a['kind'])
      if (list.length >= ctx.slotCount) throw new Error(`rack full (${ctx.slotCount} slots)`)
      if ((kind === 'buscomp' || kind === 'maximizer') && owner !== 'master') throw new Error(`${kind} is master-only`)
      const fx = ctx.makeInsert(kind, a['params'] ?? {}, !!a['bypass'])
      if (!fx) throw new Error(`unknown insert kind: ${kind}`)
      list.push(fx)
      ctx.refreshInserts(owner)
      return { index: list.length - 1, kind, params: ctx.insertParams(fx) }
    },

    insert_set: (a) => {
      const { list, owner } = insertList(a['owner'])
      const fx = fxAt(list, a['index'])
      const patch = a['params'] as Record<string, unknown> | undefined
      if (patch) {
        if (ctx.insertKind(fx) === 'eq5') {
          const bands = (fx as unknown as { bands: Array<Record<string, number>> }).bands
          const pb = patch['bands'] as Array<Record<string, number>> | undefined
          if (!Array.isArray(pb)) throw new Error('eq5 params: { bands: [{freq,gainDb,q} x5] }')
          pb.forEach((b, i) => {
            if (bands[i]) Object.assign(bands[i], b)
          })
        } else {
          const params = (fx as unknown as { params: Record<string, unknown> }).params
          for (const k of Object.keys(patch)) {
            if (!(k in params)) throw new Error(`unknown param "${k}" — valid: ${Object.keys(params).join(', ')}`)
          }
          Object.assign(params, patch)
        }
      }
      if (a['bypass'] !== undefined) fx.bypass = !!a['bypass']
      ctx.refreshInserts(owner, fx)
      return { index: finite(a['index'], 'index'), kind: ctx.insertKind(fx), bypass: fx.bypass, params: ctx.insertParams(fx) }
    },

    insert_remove: (a) => {
      const { list, owner } = insertList(a['owner'])
      const fx = fxAt(list, a['index'])
      list.splice(finite(a['index'], 'index'), 1)
      ctx.refreshInserts(owner, fx)
      return { removed: ctx.insertKind(fx), remaining: list.length }
    },

    master_set: (a) => {
      ctx.setMasterGainDb(Math.max(-60, Math.min(6, finite(a['gainDb'], 'gainDb'))))
      return { masterGainDb: ctx.getMasterGainDb() }
    },

    transport: async (a) => {
      const sr = state.sampleRate
      const pos = (): number | null =>
        a['frame'] !== undefined ? finite(a['frame'], 'frame') : a['seconds'] !== undefined ? finite(a['seconds'], 'seconds') * sr : null
      switch (String(a['action'])) {
        case 'play': {
          if (ctx.scheduler.recording) throw new Error('recording — use record_stop')
          const p = pos()
          if (p !== null && !state.playing) update({ playhead: Math.max(0, p) })
          if (!state.playing) await ctx.scheduler.start(state.playhead >= state.totalFrames ? 0 : state.playhead)
          break
        }
        case 'stop':
        case 'record_stop':
          await ctx.scheduler.stop()
          await ctx.takesSettled()
          break
        case 'seek': {
          const p = pos()
          if (p === null) throw new Error('seek needs seconds or frame')
          await ctx.scheduler.seek(p)
          break
        }
        case 'record_start': {
          if (state.playing) throw new Error('stop transport first')
          const p = pos()
          if (p !== null) update({ playhead: Math.max(0, p) })
          await ctx.startRecording(!!a['synthetic'])
          if (!ctx.scheduler.recording) throw new Error(`recording did not start (${ctx.scheduler.inputError || 'see logs'})`)
          break
        }
        default:
          throw new Error('action must be play | stop | seek | record_start | record_stop')
      }
      return { playing: state.playing, recording: ctx.scheduler.recording, playheadFrame: Math.round(state.playhead) }
    },

    wait: async (a) => {
      await sleep(Math.max(0, Math.min(60000, finite(a['ms'], 'ms'))))
      return { waited: true }
    },

    bounce: async (a) => {
      const sr = state.sampleRate
      const startFrame = a['startSeconds'] !== undefined ? finite(a['startSeconds'], 'startSeconds') * sr : 0
      const seconds = a['seconds'] !== undefined ? finite(a['seconds'], 'seconds') : null
      const tail = a['tailSeconds'] !== undefined ? finite(a['tailSeconds'], 'tailSeconds') : 0
      const save = !!a['save']
      const r = await ctx.scheduler.bounce(startFrame, seconds, tail, save)
      const { audio, ...stats } = r
      let wav: string | undefined
      if (save && audio) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const res = await window.daw.recWriteWav(`bounce_${stamp}`, sr, 2, audio.buffer as ArrayBuffer)
        wav = res.ok ? res.path : `write failed: ${res.error}`
      }
      return { ...stats, wav }
    },

    ui_query: (a) => {
      const els = [...document.querySelectorAll<HTMLElement>(String(a['selector']))].slice(0, 50)
      return els.map((e) => {
        const r = e.getBoundingClientRect()
        return {
          tag: e.tagName.toLowerCase(),
          id: e.id || undefined,
          class: e.className && typeof e.className === 'string' ? e.className : undefined,
          text: (e.textContent ?? '').trim().slice(0, 120),
          value: (e as HTMLInputElement).value,
          disabled: (e as HTMLButtonElement).disabled || undefined,
          hidden: e.hidden || undefined,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        }
      })
    },

    ui_click: (a) => {
      const els = document.querySelectorAll<HTMLElement>(String(a['selector']))
      const e = els[Number(a['index']) || 0]
      if (!e) throw new Error(`no element for selector (${els.length} matches)`)
      e.click()
      return { clicked: true, matches: els.length }
    }
  }

  window.daw.onMcpCall(({ id, tool, args }) => {
    void (async () => {
      try {
        const fn = tools[tool]
        if (!fn) throw new Error(`unknown renderer tool: ${tool}`)
        window.daw.mcpReply(id, true, await fn(args ?? {}))
      } catch (err) {
        window.daw.mcpReply(id, false, (err as Error).message ?? String(err))
      }
    })()
  })
}
