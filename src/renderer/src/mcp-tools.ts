// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import type { PlaybackScheduler } from './audio/scheduler'
import { FM_PRESET_NAMES } from './gpu/instruments/fm-presets'
import { EARLY_PRESET_NAMES } from './gpu/instruments/earlysynth/presets'
import { PRESETS as DRUM_PATTERNS } from './midi/step-logic'
import { initMcpGuard } from './ui/mcp-guard'
import { genreChoices, getMixTarget, setMixGenre } from './audio/mix-target'
import { landLoudness } from './audio/loudness-land'
import { planHeadroom } from './audio/headroom'
import { MASTER_EQ_LIMIT_DB, planEqBand, type EqBandState, type EqFix } from './audio/spectrum'
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
  strip: { el: HTMLElement }
  /** Group channel this track feeds (absent = master). */
  group?: number
  /** Track colour `#rrggbb`. */
  color?: string
}

export type Owner = number | 'master'

export interface McpCtx {
  lanes: McpLane[]
  scheduler: PlaybackScheduler
  serializeProject(): unknown
  restoreProject(p: unknown): Promise<void>
  importDawproject(path: string): Promise<{ tracks: number; midiTracks: number; clips: number; warnings: string[] }>
  pianoRoll(cmd: {
    action: 'open' | 'pointer' | 'key' | 'close' | 'info'
    track?: number
    clip?: number
    kind?: 'down' | 'move' | 'up'
    x?: number
    y?: number
    shift?: boolean
    alt?: boolean
    button?: number
    key?: string
    ctrl?: boolean
  }): unknown
  addDrumTrack(name: string, preset: string, bars: number, bpm?: number): McpLane
  exportDawproject(path: string): Promise<{ audioTracks: number; noteTracks: number; files: number; path?: string }>
  addLiveLane(name: string, ch: number, stereo: boolean): McpLane
  monitor(action: 'start' | 'stop', synthetic: boolean | 'impulse', latencyMs?: number): Promise<unknown>
  liveInfo(): unknown
  importMidi(path: string): Promise<{ tracks: number; notes: number; bpm: number }>
  exportMidi(path: string): Promise<{ tracks: number; notes: number; path?: string }>
  groupsList(): unknown
  groupAdd(name: string, tracks: number[]): unknown
  groupSet(
    id: number,
    patch: { name?: string; gainDb?: number; pan?: number; mute?: boolean; solo?: boolean; tracks?: number[]; color?: string }
  ): unknown
  groupRemove(id: number): unknown
  routeTrack(track: number, group: number | null): void
  groupInserts(id: number): Insert[] | null
  groupStripEl(id: number): HTMLElement | null
  setTrackColor(track: number, color: unknown): unknown
  stemsList(): unknown
  stemSet(track: number, stem: string): unknown
  stemsExport(req: {
    stems?: string[]
    perTrack?: boolean
    includeGroups?: boolean
    folder?: string
    verify?: boolean
    startSeconds?: number
    seconds?: number
    settings?: Record<string, unknown>
  }): Promise<unknown>
  /** Each group channel's own output peak over the whole song. */
  groupOutputPeaks(): Promise<{ id: number; name: string; peakDb: number }[]>
  /** The whole mix as one WAV through the master chain + fader. */
  mixdownExport(req: { folder?: string; settings?: Record<string, unknown> }): Promise<unknown>
  /** Per-track output level / peak / crest / stick-out, and the trim that would bring the level to targetDb. */
  trackLevels(req: { tracks?: number[]; targetDb?: number; startSeconds?: number; seconds?: number }): Promise<unknown>
  /** Average spectrum of the mix (and, for scope 'breakdown', of each part) against the AI-mix target. */
  analyzeSpectrum(req: { scope?: string; startSeconds?: number; seconds?: number }): Promise<unknown>
  addInstrumentTrack(name: string, notes: { start: number; dur: number; key: number; vel?: number }[], bpm?: number, kind?: string): McpLane
  setInstrumentParams(laneId: number, patch: Record<string, unknown>): unknown
  swapInstrument(laneId: number, kind: string): string
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
  /** Glow the track (lane row + channel strip) or the master strip a call just acted on. */
  const flashTarget = (a: Record<string, unknown>, tool: string): void => {
    const t = tool === 'master_set' ? 'master' : (a['track'] ?? a['owner'])
    if (t === 'master') guard.flash([document.getElementById('master-strip')])
    else if (typeof a['group'] === 'number' && tool.startsWith('group_')) guard.flash([ctx.groupStripEl(a['group'] as number)])
    else if (typeof t === 'number' && t > 1000) guard.flash([ctx.groupStripEl(t)])
    else if (typeof t === 'number') {
      const l = ctx.lanes.find((x) => x.id === t)
      if (l) guard.flash([l.el, l.strip.el])
    }
  }
  const guard = initMcpGuard() // red lamp + grey mask + log / chat window while the server drives the app
  const lane = (id: unknown): McpLane => {
    const l = ctx.lanes.find((x) => x.id === Number(id))
    if (!l) throw new Error(`no track with id ${String(id)} (ids: ${ctx.lanes.map((x) => x.id).join(', ') || 'none'})`)
    return l
  }
  const insertList = (owner: unknown): { list: Insert[]; owner: Owner } => {
    if (owner === 'master') return { list: ctx.masterInserts(), owner: 'master' }
    const g = ctx.groupInserts(Number(owner))
    if (g) return { list: g, owner: Number(owner) }
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
    group: l.group ?? null,
    color: l.color ?? null,
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
      if (a['group'] !== undefined) {
        const gid = finite(a['group'], 'group')
        ctx.routeTrack(l.id, gid > 0 ? gid : null)
      }
      if (a['color'] !== undefined) ctx.setTrackColor(l.id, a['color'])
      ctx.syncLaneUI(l)
      return laneSummary(l)
    },

    groups_list: () => ctx.groupsList(),

    group_add: (a) => {
      const tracks = Array.isArray(a['tracks']) ? (a['tracks'] as unknown[]).map((x) => finite(x, 'tracks[]')) : []
      for (const t of tracks) lane(t) // unknown ids fail before anything is created
      return ctx.groupAdd(String(a['name'] ?? 'Group'), tracks)
    },

    group_set: (a) => {
      const patch: { name?: string; gainDb?: number; pan?: number; mute?: boolean; solo?: boolean; tracks?: number[]; color?: string } = {}
      if (a['name'] !== undefined) patch.name = String(a['name'])
      if (a['color'] !== undefined) patch.color = String(a['color'])
      if (a['gainDb'] !== undefined) patch.gainDb = Math.max(-60, Math.min(6, finite(a['gainDb'], 'gainDb')))
      if (a['pan'] !== undefined) patch.pan = Math.max(-1, Math.min(1, finite(a['pan'], 'pan')))
      if (a['mute'] !== undefined) patch.mute = !!a['mute']
      if (a['solo'] !== undefined) patch.solo = !!a['solo']
      if (Array.isArray(a['tracks'])) {
        patch.tracks = (a['tracks'] as unknown[]).map((x) => finite(x, 'tracks[]'))
        for (const t of patch.tracks) lane(t)
      }
      return ctx.groupSet(finite(a['group'], 'group'), patch)
    },

    group_remove: (a) => ctx.groupRemove(finite(a['group'], 'group')),

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

    dawproject_import: async (a) => ctx.importDawproject(String(a['path'])),

    pianoroll: (a) =>
      ctx.pianoRoll({
        action: String(a['action']) as 'open' | 'pointer' | 'key' | 'close' | 'info',
        track: a['track'] === undefined ? undefined : finite(a['track'], 'track'),
        clip: a['clip'] === undefined ? undefined : finite(a['clip'], 'clip'),
        kind: a['kind'] as 'down' | 'move' | 'up' | undefined,
        x: a['x'] === undefined ? undefined : finite(a['x'], 'x'),
        y: a['y'] === undefined ? undefined : finite(a['y'], 'y'),
        shift: !!a['shift'],
        alt: !!a['alt'],
        button: a['button'] === undefined ? undefined : finite(a['button'], 'button'),
        key: a['key'] === undefined ? undefined : String(a['key']),
        ctrl: !!a['ctrl']
      }),

    drum_pattern_add: (a) => {
      const lane = ctx.addDrumTrack(
        String(a['name'] ?? 'Drums'),
        String(a['preset'] ?? 'Basic beat'),
        Math.max(1, Math.min(8, Math.round(a['bars'] === undefined ? 2 : finite(a['bars'], 'bars')))),
        a['bpm'] === undefined ? undefined : finite(a['bpm'], 'bpm')
      )
      return { id: lane.id }
    },

    dawproject_export: async (a) => ctx.exportDawproject(String(a['path'])),

    instrument_presets: () => ({ earlysynth: EARLY_PRESET_NAMES, fm: FM_PRESET_NAMES, drumPatterns: DRUM_PATTERNS.map((p) => p.name) }),

    live_lane_add: (a) => {
      const lane = ctx.addLiveLane(String(a['name'] ?? 'Line In'), a['ch'] === undefined ? 0 : finite(a['ch'], 'ch'), !!a['stereo'])
      return { id: lane.id }
    },

    monitor: async (a) => {
      const syn = String(a['synthetic'] ?? 'off')
      return ctx.monitor(
        String(a['action']) === 'stop' ? 'stop' : 'start',
        syn === 'impulse' ? 'impulse' : syn === 'tone' || syn === 'true' ? true : false,
        a['latencyMs'] === undefined ? undefined : finite(a['latencyMs'], 'latencyMs')
      )
    },

    live_info: () => ctx.liveInfo(),

    midi_import: async (a) => ctx.importMidi(String(a['path'])),

    midi_export: async (a) => ctx.exportMidi(String(a['path'])),

    stems_list: () => ctx.stemsList(),

    stem_set: (a) => ctx.stemSet(finite(a['track'], 'track'), String(a['stem'] ?? '')),

    stems_export: async (a) => {
      const settings: Record<string, unknown> = {}
      for (const k of ['bitDepth', 'sampleRate', 'process', 'masterChain', 'tailSeconds']) if (a[k] !== undefined) settings[k] = a[k]
      return ctx.stemsExport({
        stems: Array.isArray(a['stems']) ? (a['stems'] as unknown[]).map(String) : undefined,
        perTrack: a['perTrack'] === true,
        includeGroups: typeof a['includeGroups'] === 'boolean' ? (a['includeGroups'] as boolean) : undefined,
        folder: typeof a['folder'] === 'string' ? (a['folder'] as string) : undefined,
        verify: typeof a['verify'] === 'boolean' ? (a['verify'] as boolean) : undefined,
        startSeconds: a['startSeconds'] === undefined ? undefined : finite(a['startSeconds'], 'startSeconds'),
        seconds: a['seconds'] === undefined ? undefined : finite(a['seconds'], 'seconds'),
        settings
      })
    },

    mix_target: () => {
      const t = getMixTarget()
      return { target: t ? { id: t.id, name: t.name } : null, genres: genreChoices().map((g) => ({ id: g.id, name: g.name })) }
    },

    mix_target_set: (a) => {
      const id = String(a['genre'] ?? '')
      const t = setMixGenre(id)
      if (!t) throw new Error(`unknown genre "${id}" (${genreChoices().map((g) => g.id).join(' | ')})`)
      return { target: { id: t.id, name: t.name } }
    },

    spectrum_analyze: async (a) => {
      if (state.playing) await ctx.scheduler.stop()
      const scope = a['scope'] === undefined ? 'master' : String(a['scope'])
      if (scope !== 'master' && scope !== 'breakdown') throw new Error('scope must be "master" or "breakdown"')
      return ctx.analyzeSpectrum({
        scope,
        startSeconds: a['startSeconds'] === undefined ? undefined : finite(a['startSeconds'], 'startSeconds'),
        seconds: a['seconds'] === undefined ? undefined : finite(a['seconds'], 'seconds')
      })
    },

    mixdown_export: async (a) => {
      if (state.playing) await ctx.scheduler.stop()
      const settings: Record<string, unknown> = {}
      for (const k of ['bitDepth', 'sampleRate', 'tailSeconds']) if (a[k] !== undefined) settings[k] = a[k]
      return ctx.mixdownExport({ folder: typeof a['folder'] === 'string' ? (a['folder'] as string) : undefined, settings })
    },

    headroom_fit: async (a) => {
      if (state.playing) await ctx.scheduler.stop()
      const margin = a['marginDb'] === undefined ? 0.5 : Math.max(0, Math.min(6, finite(a['marginDb'], 'marginDb')))
      const t0 = performance.now()
      type TrackRow = { id: number; title: string; peakDb?: number }
      const measure = async (): Promise<{ tracks: TrackRow[]; groups: { id: number; name: string; peakDb: number }[] }> => {
        const lv = (await ctx.trackLevels({})) as { tracks: TrackRow[] }
        return { tracks: lv.tracks, groups: await ctx.groupOutputPeaks() }
      }
      const before = await measure()
      const plan = planHeadroom(
        before.tracks.map((t) => t.peakDb ?? -Infinity),
        before.groups.map((g) => g.peakDb),
        margin
      )
      const groupExtra: Record<string, number> = {}
      if (plan.trackDropDb > 0) {
        for (const l of ctx.lanes) {
          l.mix.gainDb = Math.max(-60, Math.round((l.mix.gainDb - plan.trackDropDb) * 10) / 10)
          ctx.syncLaneUI(l)
        }
      }
      const groupNow = new Map((ctx.groupsList() as { id: number; mix: { gainDb: number } }[]).map((g) => [g.id, g.mix.gainDb]))
      before.groups.forEach((g, i) => {
        const extra = plan.groupExtraDb[i]
        if (extra > 0) {
          const now = groupNow.get(g.id) ?? 0
          ctx.groupSet(g.id, { gainDb: Math.max(-60, Math.round((now - extra) * 10) / 10) })
          groupExtra[g.name] = extra
        }
      })
      const after = plan.trackDropDb > 0 || Object.keys(groupExtra).length > 0 ? await measure() : before
      const worst = (m: typeof before): number =>
        Math.max(...m.tracks.map((t) => t.peakDb ?? -Infinity), ...m.groups.map((g) => g.peakDb))
      const r1 = (x: number): number | null => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)
      const still = [
        ...after.tracks.filter((t) => (t.peakDb ?? -Infinity) > 0).map((t) => `${t.title}: ${t.peakDb} dBFS`),
        ...after.groups.filter((g) => g.peakDb > 0).map((g) => `group ${g.name}: ${g.peakDb} dBFS`)
      ]
      return {
        marginDb: margin,
        dropDb: plan.trackDropDb,
        groupExtraDb: groupExtra,
        worstBeforeDb: r1(worst(before)),
        worstAfterDb: r1(worst(after)),
        stillOver: still,
        tracksMeasured: before.tracks.length,
        groupsMeasured: before.groups.length,
        renderSeconds: Math.round((performance.now() - t0) / 100) / 10
      }
    },

    loudness_land: async (a) => {
      if (state.playing) await ctx.scheduler.stop()
      const target = a['targetLufs'] === undefined ? -14 : Math.max(-30, Math.min(-6, finite(a['targetLufs'], 'targetLufs')))
      const tolerance = a['toleranceLu'] === undefined ? 0.3 : Math.max(0.05, Math.min(3, finite(a['toleranceLu'], 'toleranceLu')))
      const maxIterations = a['maxIterations'] === undefined ? 8 : Math.max(1, Math.min(16, Math.round(finite(a['maxIterations'], 'maxIterations'))))
      const startDb = ctx.getMasterGainDb()
      const renders = new Map<number, { peakDb: number; clipped: number; rmsDb: number }>()
      const t0 = performance.now()
      const r = await landLoudness(
        startDb,
        async (g) => {
          ctx.setMasterGainDb(g)
          const b = await ctx.scheduler.bounce(0, null, 0, false)
          renders.set(g, { peakDb: Math.round(Math.max(b.peakDb[0], b.peakDb[1]) * 10) / 10, clipped: b.clippedFrames, rmsDb: Math.round(Math.max(b.rmsDb[0], b.rmsDb[1]) * 10) / 10 })
          return b.lufsIntegrated
        },
        { target, tolerance, maxIterations, quantizeDb: 0.5 } // the master fader moves in 0.5 dB steps
      )
      ctx.setMasterGainDb(r.gainDb) // the best step, not necessarily the last one rendered
      const fin = renders.get(r.gainDb)
      const r1 = (x: number): number => Math.round(x * 10) / 10
      return {
        reached: r.reached,
        reason: r.reason,
        targetLufs: target,
        startDb: r1(startDb),
        endDb: r1(r.gainDb),
        startLufs: r.steps.length ? r1(r.steps[0].lufs) : null,
        endLufs: Number.isFinite(r.lufs) ? r1(r.lufs) : null,
        steps: r.steps.map((s) => ({ faderDb: r1(s.gainDb), lufs: r1(s.lufs) })),
        peakDb: fin?.peakDb ?? null,
        rmsDb: fin?.rmsDb ?? null,
        clippedFrames: fin?.clipped ?? null,
        renderSeconds: Math.round((performance.now() - t0) / 100) / 10
      }
    },

    track_levels: async (a) => {
      if (state.playing) await ctx.scheduler.stop()
      return ctx.trackLevels({
        tracks: Array.isArray(a['tracks']) ? (a['tracks'] as unknown[]).map((x) => finite(x, 'tracks[]')) : undefined,
        targetDb: a['targetDb'] === undefined ? undefined : finite(a['targetDb'], 'targetDb'),
        startSeconds: a['startSeconds'] === undefined ? undefined : finite(a['startSeconds'], 'startSeconds'),
        seconds: a['seconds'] === undefined ? undefined : finite(a['seconds'], 'seconds')
      })
    },

    eq_apply: (a) => {
      const kind = String(a['kind'])
      if (kind !== 'lowshelf' && kind !== 'peak' && kind !== 'highshelf') throw new Error('kind must be lowshelf | peak | highshelf')
      const fix: EqFix = {
        kind,
        freq: Math.max(20, Math.min(20000, finite(a['freq'], 'freq'))),
        gainDb: Math.max(-12, Math.min(12, finite(a['gainDb'], 'gainDb'))),
        q: a['q'] === undefined ? (kind === 'peak' ? 1 : 0.7) : Math.max(0.3, Math.min(8, finite(a['q'], 'q')))
      }
      const targets: unknown[] = Array.isArray(a['tracks']) && (a['tracks'] as unknown[]).length ? (a['tracks'] as unknown[]) : [a['owner']]
      if (targets.length === 1 && (targets[0] === undefined || targets[0] === null)) throw new Error('give owner (track id, group id or "master") or tracks [ids]')
      const out: unknown[] = []
      for (const t of targets) {
        const { list, owner } = insertList(typeof t === 'string' && t !== 'master' ? Number(t) : t)
        let fx = list.find((x) => ctx.insertKind(x) === 'eq5')
        let created = false
        if (!fx) {
          if (list.length >= ctx.slotCount) throw new Error(`rack full (${ctx.slotCount} slots) on ${String(owner)}: no room for an EQ`)
          const made = ctx.makeInsert('eq5', {}, false)
          if (!made) throw new Error('could not create an eq5 insert')
          list.push(made)
          fx = made
          created = true
        }
        const bands = (fx as unknown as { bands: EqBandState[] }).bands
        // the master EQ is for a final touch, not for fixing the mix: a few dB at most
        const plan = planEqBand(bands, fix, owner === 'master' ? MASTER_EQ_LIMIT_DB : undefined)
        Object.assign(bands[plan.index], plan.band)
        ctx.refreshInserts(owner, fx)
        out.push({
          owner,
          insertIndex: list.indexOf(fx),
          createdEq: created,
          band: plan.index,
          ...plan.band,
          ...(plan.limited ? { note: owner === 'master' ? `the master EQ is limited to ±${MASTER_EQ_LIMIT_DB} dB per band: correct the channel that causes it instead` : 'limited to ±12 dB' } : {})
        })
      }
      return { applied: out }
    },

    midi_track_add: (a) => {
      const raw = Array.isArray(a['notes']) ? (a['notes'] as Record<string, unknown>[]) : []
      const notes = raw.map((n) => ({
        start: finite(n['start'], 'note.start'),
        dur: finite(n['dur'], 'note.dur'),
        key: finite(n['key'], 'note.key'),
        vel: n['vel'] === undefined ? 100 : finite(n['vel'], 'note.vel')
      }))
      const lane = ctx.addInstrumentTrack(
        String(a['name'] ?? 'Synth'),
        notes,
        a['bpm'] === undefined ? undefined : finite(a['bpm'], 'bpm'),
        a['instrument'] === undefined ? undefined : String(a['instrument'])
      )
      return { id: lane.id, notes: notes.length }
    },

    instrument_swap: (a) => ({ kind: ctx.swapInstrument(finite(a['track'], 'track'), String(a['kind'])) }),

    instrument_set: (a) => ({ params: ctx.setInstrumentParams(finite(a['track'], 'track'), (a['params'] ?? {}) as Record<string, unknown>) }),

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

    chat_say: (a) => {
      guard.say(String(a['text'] ?? ''))
      return { shown: true }
    },

    chat_type: (a) => {
      guard.type(String(a['text'] ?? ''))
      return { typed: true }
    },

    chat_history: (a) => ({ lines: guard.history(Math.min(100, Number(a['limit']) || 10)) }),

    chat_read: async (a) => {
      const waitMs = Math.max(0, Math.min(50000, (Number(a['waitSeconds']) || 0) * 1000))
      const messages = await guard.take(waitMs)
      return { messages }
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
          bg: getComputedStyle(e).backgroundImage.slice(0, 60),
          bgLength: getComputedStyle(e).backgroundImage.length,
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
      const row = guard.enter(tool, args)
      try {
        const fn = tools[tool]
        if (!fn) throw new Error(`unknown renderer tool: ${tool}`)
        const out = await fn(args ?? {})
        window.daw.mcpReply(id, true, out)
        guard.leave(row, true)
        flashTarget(args ?? {}, tool)
      } catch (err) {
        const msg = (err as Error).message ?? String(err)
        window.daw.mcpReply(id, false, msg)
        guard.leave(row, false, msg)
      }
    })()
  })
}
