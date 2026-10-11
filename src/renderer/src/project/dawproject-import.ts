// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * DAWproject (https://github.com/bitwig/dawproject) → neutral import model.
 *
 * Cubase 14+ writes this open format (File > Export > DAWproject). main unzips the
 * container and hands us `project.xml` as text plus a map of archive path → file on
 * disk; this module turns the XML into plain data (tracks, mix, audio clips, MIDI
 * notes) with all positions in *seconds* / *beats*. main.ts then maps it onto the
 * project model. No DOM and no dependencies, so it also runs under plain Node.
 *
 * Scope: tempo (first value; tempo automation is ignored), time signature, audio +
 * note tracks, volume / pan / mute / solo, audio clips (offset, length, fades) and
 * MIDI notes. Plug-in state, automation and time-stretching are not imported and are
 * reported as warnings.
 */

// ---- tiny XML parser --------------------------------------------------------

export interface XEl {
  name: string
  attrs: Record<string, string>
  children: XEl[]
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const unent = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, g: string) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    return ENT[g] ?? m
  })

/** Parse well-formed XML into an element tree (text nodes are ignored). */
export function parseXml(src: string): XEl {
  const root: XEl = { name: '#root', attrs: {}, children: [] }
  const stack: XEl[] = [root]
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break
    i = lt
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4)
      i = e < 0 ? n : e + 3
    } else if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i + 2)
      i = e < 0 ? n : e + 2
    } else if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9)
      i = e < 0 ? n : e + 3
    } else if (src.startsWith('<!', i)) {
      const e = src.indexOf('>', i + 2)
      i = e < 0 ? n : e + 1
    } else if (src[i + 1] === '/') {
      const e = src.indexOf('>', i + 2)
      if (stack.length > 1) stack.pop()
      i = e < 0 ? n : e + 1
    } else {
      // start tag: name, attributes (quoted values may contain '>'), optional '/'
      let j = i + 1
      while (j < n && !/[\s/>]/.test(src[j])) j++
      const el: XEl = { name: src.slice(i + 1, j), attrs: {}, children: [] }
      let selfClose = false
      for (;;) {
        while (j < n && /\s/.test(src[j])) j++
        if (j >= n) break
        if (src[j] === '/') {
          selfClose = true
          j++
          continue
        }
        if (src[j] === '>') {
          j++
          break
        }
        let k = j
        while (k < n && !/[\s=/>]/.test(src[k])) k++
        const key = src.slice(j, k)
        j = k
        while (j < n && /\s/.test(src[j])) j++
        let val = ''
        if (src[j] === '=') {
          j++
          while (j < n && /\s/.test(src[j])) j++
          const q = src[j]
          if (q === '"' || q === "'") {
            const e = src.indexOf(q, j + 1)
            const end = e < 0 ? n : e
            val = src.slice(j + 1, end)
            j = end + 1
          } else {
            k = j
            while (k < n && !/[\s>]/.test(src[k])) k++
            val = src.slice(j, k)
            j = k
          }
        }
        if (key) el.attrs[key] = unent(val)
      }
      stack[stack.length - 1].children.push(el)
      if (!selfClose) stack.push(el)
      i = j
    }
  }
  return root.children[0] ?? root
}

const kids = (e: XEl, name: string): XEl[] => e.children.filter((c) => c.name === name)
const kid = (e: XEl, name: string): XEl | undefined => e.children.find((c) => c.name === name)
const num = (s: string | undefined, d: number): number => {
  if (s === undefined) return d
  const v = Number(s)
  return Number.isFinite(v) ? v : d
}

// ---- import model -----------------------------------------------------------

export interface ImpAudioClip {
  /** Archive path of the audio file (e.g. `audio/Kick.wav`). */
  file: string
  name: string
  startSec: number
  /** Where in the source file playback begins, in seconds. */
  srcOffsetSec: number
  lengthSec: number
  fadeInSec: number
  fadeOutSec: number
}

export interface ImpNote {
  /** Absolute position / duration in beats from the project start. */
  startBeats: number
  durBeats: number
  key: number
  /** 0..127 */
  vel: number
  channel: number
}

export interface ImpMidiClip {
  name: string
  startBeats: number
  lengthBeats: number
  notes: ImpNote[]
}

export interface ImpTrack {
  name: string
  kind: 'audio' | 'notes'
  gainDb: number
  /** -1..+1 */
  pan: number
  mute: boolean
  solo: boolean
  audioChannels: number
  audioClips: ImpAudioClip[]
  midiClips: ImpMidiClip[]
}

export interface DawImport {
  app: string
  bpm: number
  timeSig: { num: number; den: number }
  masterGainDb: number
  tracks: ImpTrack[]
  warnings: string[]
}

type Unit = 'beats' | 'seconds'
const unitOf = (s: string | undefined, d: Unit): Unit => (s === 'beats' || s === 'seconds' ? s : d)

/** linear → dB, with a floor so a fader at -inf maps to something finite. */
const linToDb = (v: number): number => (v <= 1e-5 ? -100 : 20 * Math.log10(v))

/** Read a Volume parameter as dB. */
function volumeDb(p: XEl | undefined, warn: (m: string) => void, who: string): number {
  if (!p) return 0
  const v = num(p.attrs.value, NaN)
  if (!Number.isFinite(v)) return 0
  switch (p.attrs.unit) {
    case 'linear':
      return linToDb(v)
    case 'decibel':
      return v
    case 'percent':
      return linToDb(v / 100)
    default:
      warn(`${who}: unsupported volume unit "${p.attrs.unit}", left at 0 dB`)
      return 0
  }
}

/** Read a Pan parameter as -1..+1. DAWproject pans are normalized 0..1 (0.5 = centre). */
function panValue(p: XEl | undefined): number {
  if (!p) return 0
  const v = num(p.attrs.value, NaN)
  if (!Number.isFinite(v)) return 0
  const mn = num(p.attrs.min, p.attrs.unit === 'normalized' || p.attrs.unit === undefined ? 0 : -1)
  const mx = num(p.attrs.max, 1)
  if (mx <= mn) return 0
  return Math.max(-1, Math.min(1, ((v - mn) / (mx - mn)) * 2 - 1))
}

/**
 * Convert DAWproject `project.xml` text into the neutral import model.
 * `warn`ings are collected on the result rather than thrown.
 */
export function parseDawproject(xml: string): DawImport {
  const root = parseXml(xml)
  if (root.name !== 'Project') throw new Error('not a DAWproject (root element is not <Project>)')

  const warnings: string[] = []
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m)
  }

  const app = kid(root, 'Application')?.attrs
  const transport = kid(root, 'Transport')
  const tempo = kid(transport ?? root, 'Tempo')
  let bpm = num(tempo?.attrs.value, 120)
  if (!(bpm > 0)) bpm = 120
  const ts = kid(transport ?? root, 'TimeSignature')
  const timeSig = { num: Math.max(1, num(ts?.attrs.numerator, 4) | 0), den: Math.max(1, num(ts?.attrs.denominator, 4) | 0) }

  const secPerBeat = 60 / bpm
  const toSec = (v: number, u: Unit): number => (u === 'beats' ? v * secPerBeat : v)
  const toBeats = (v: number, u: Unit): number => (u === 'beats' ? v : v / secPerBeat)

  // ---- structure: flatten the track tree, remember each track by id ----
  interface TrackInfo {
    id: string
    el: XEl
    track: ImpTrack
  }
  const byId = new Map<string, TrackInfo>()
  const order: TrackInfo[] = []
  let masterGainDb = 0

  const walk = (parent: XEl): void => {
    for (const t of kids(parent, 'Track')) {
      const ch = kid(t, 'Channel')
      const role = ch?.attrs.role ?? 'regular'
      const types = (t.attrs.contentType ?? '').split(/\s+/).filter(Boolean)
      const name = t.attrs.name || ch?.attrs.name || 'Track'
      const gainDb = volumeDb(kid(ch ?? t, 'Volume'), warn, name)
      if (role === 'master') {
        masterGainDb = gainDb
      } else if (role === 'regular' || role === undefined) {
        // An instrument track can declare both "audio" and "notes"; the clips decide below.
        const kind: ImpTrack['kind'] | null =
          types.includes('audio') || types.includes('notes') ? (types.includes('audio') ? 'audio' : 'notes') : null
        if (kind) {
          const info: TrackInfo = {
            id: t.attrs.id ?? '',
            el: t,
            track: {
              name,
              kind,
              gainDb,
              pan: panValue(kid(ch ?? t, 'Pan')),
              mute: kid(ch ?? t, 'Mute')?.attrs.value === 'true',
              solo: ch?.attrs.solo === 'true',
              audioChannels: Math.max(1, num(ch?.attrs.audioChannels, 2) | 0),
              audioClips: [],
              midiClips: []
            }
          }
          order.push(info)
          if (info.id) byId.set(info.id, info)
        } else if (types.includes('tracks')) {
          warn(`group track "${name}": its fader is not applied to the child tracks`)
        }
        if (ch && kid(ch, 'Devices')?.children.length) warn(`"${name}": plug-in devices are not imported`)
        if (ch && kid(ch, 'Sends')?.children.length) warn(`"${name}": sends are not imported`)
      } else if (role === 'effect' || role === 'submix' || role === 'vca') {
        warn(`${role} channel "${name}" is not imported`)
      }
      walk(t) // folder / group tracks hold child tracks
    }
  }
  const structure = kid(root, 'Structure')
  if (structure) walk(structure)

  // ---- arrangement: clips per track ----
  const sawAutomation = { v: false }
  const readClip = (info: TrackInfo, clip: XEl, laneUnit: Unit): void => {
    const time = num(clip.attrs.time, 0)
    const dur = num(clip.attrs.duration, 0)
    const startSec = toSec(time, laneUnit)
    const lengthSec = toSec(dur, laneUnit)
    const name = clip.attrs.name || info.track.name

    // content may be wrapped in <Warps> (time-mapped) — peel it
    let warps: XEl | undefined
    let content: XEl | undefined = clip.children.find((c) => ['Audio', 'Notes', 'Warps', 'Clips'].includes(c.name))
    if (content?.name === 'Warps') {
      warps = content
      content = content.children.find((c) => ['Audio', 'Notes'].includes(c.name))
    }
    if (!content) return

    if (content.name === 'Audio') {
      const file = kid(content, 'File')?.attrs.path
      if (!file) return
      // playStart is in the clip's content time; if warped, map through the warp points
      let srcOffsetSec: number
      let lengthOutSec = lengthSec
      const ps = num(clip.attrs.playStart, 0)
      if (warps) {
        const wu = unitOf(warps.attrs.contentTimeUnit, 'seconds')
        const tu = unitOf(warps.attrs.timeUnit, laneUnit)
        const pts = kids(warps, 'Warp').map((w) => ({ t: num(w.attrs.time, 0), c: num(w.attrs.contentTime, 0) }))
        if (pts.length >= 2) {
          const a = pts[0]
          const b = pts[pts.length - 1]
          const timeSpan = toSec(b.t - a.t, tu)
          const contSpan = toSec(b.c - a.c, wu)
          const rate = timeSpan > 0 ? contSpan / timeSpan : 1
          if (Math.abs(rate - 1) > 0.01) {
            warn(`"${name}": time-stretched clip (x${rate.toFixed(3)}) is placed unstretched`)
          }
          const cu = unitOf(clip.attrs.contentTimeUnit, tu)
          srcOffsetSec = toSec(a.c, wu) + (toSec(ps, cu) - toSec(a.t, tu)) * rate
        } else {
          srcOffsetSec = toSec(ps, unitOf(clip.attrs.contentTimeUnit, 'seconds'))
        }
      } else {
        srcOffsetSec = toSec(ps, unitOf(clip.attrs.contentTimeUnit, 'seconds'))
      }
      const fu = unitOf(clip.attrs.fadeTimeUnit, laneUnit)
      const audioDur = num(content.attrs.duration, 0)
      if (!(lengthOutSec > 0)) lengthOutSec = Math.max(0, audioDur - srcOffsetSec)
      info.track.audioClips.push({
        file,
        name,
        startSec,
        srcOffsetSec: Math.max(0, srcOffsetSec),
        lengthSec: lengthOutSec,
        fadeInSec: Math.max(0, toSec(num(clip.attrs.fadeInTime, 0), fu)),
        fadeOutSec: Math.max(0, toSec(num(clip.attrs.fadeOutTime, 0), fu))
      })
    } else if (content.name === 'Notes') {
      const cu = unitOf(clip.attrs.contentTimeUnit, laneUnit)
      const ps = num(clip.attrs.playStart, 0)
      const startBeats = toBeats(time, laneUnit)
      const notes: ImpNote[] = []
      for (const nt of kids(content, 'Note')) {
        const nStart = num(nt.attrs.time, 0) - ps
        notes.push({
          startBeats: startBeats + toBeats(nStart, cu),
          durBeats: Math.max(0, toBeats(num(nt.attrs.duration, 0), cu)),
          key: Math.max(0, Math.min(127, num(nt.attrs.key, 60) | 0)),
          vel: Math.max(1, Math.min(127, Math.round(num(nt.attrs.vel, 0.8) * 127))),
          channel: Math.max(0, Math.min(15, num(nt.attrs.channel, 0) | 0))
        })
      }
      info.track.midiClips.push({ name, startBeats, lengthBeats: toBeats(dur, laneUnit), notes })
    } else if (content.name === 'Clips') {
      warn(`"${name}": nested clips (comp) are not imported`)
    }
  }

  const walkLanes = (lanes: XEl, unit: Unit, trackInfo: TrackInfo | undefined): void => {
    const u = unitOf(lanes.attrs.timeUnit, unit)
    const tid = lanes.attrs.track
    const info = tid ? byId.get(tid) : trackInfo
    for (const c of lanes.children) {
      if (c.name === 'Lanes') walkLanes(c, u, info)
      else if (c.name === 'Clips' && info) {
        for (const clip of kids(c, 'Clip')) readClip(info, clip, unitOf(c.attrs.timeUnit, u))
      } else if (c.name === 'Points') {
        sawAutomation.v = true
      } else if (c.name === 'Notes' && info) {
        // notes directly on the lane (no clip): treat as one open-ended clip
        const notes = kids(c, 'Note').map((nt) => ({
          startBeats: toBeats(num(nt.attrs.time, 0), u),
          durBeats: Math.max(0, toBeats(num(nt.attrs.duration, 0), u)),
          key: Math.max(0, Math.min(127, num(nt.attrs.key, 60) | 0)),
          vel: Math.max(1, Math.min(127, Math.round(num(nt.attrs.vel, 0.8) * 127))),
          channel: Math.max(0, Math.min(15, num(nt.attrs.channel, 0) | 0))
        }))
        const end = notes.reduce((m, nn) => Math.max(m, nn.startBeats + nn.durBeats), 0)
        info.track.midiClips.push({ name: info.track.name, startBeats: 0, lengthBeats: end, notes })
      }
    }
  }
  const arr = kid(root, 'Arrangement')
  if (arr) {
    const top = kid(arr, 'Lanes')
    if (top) walkLanes(top, 'beats', undefined)
  }
  // Instrument tracks: notes but no audio clips → note track (declared types can be both).
  for (const o of order) {
    if (o.track.kind === 'audio' && o.track.midiClips.length > 0 && o.track.audioClips.length === 0) {
      o.track.kind = 'notes'
    }
  }
  if (sawAutomation.v) warn('automation lanes are not imported')

  return {
    app: [app?.name, app?.version].filter(Boolean).join(' '),
    bpm,
    timeSig,
    masterGainDb,
    tracks: order.map((o) => o.track),
    warnings
  }
}
