// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Neutral model → DAWproject `project.xml` (https://github.com/bitwig/dawproject).
 * Pure string building, no DOM: the file picking / zipping lives in main, the model is
 * assembled in main.ts. Output is validated against the published Project.xsd in tests.
 *
 * What is written: tempo, time signature, audio tracks (clips with source offset, length
 * and fades; volume / pan / mute / solo) and note tracks (instrument lanes export their
 * MIDI, not the synth audio — the receiving DAW supplies the sound), plus the master
 * volume. Not written: channel strip, inserts, per-clip gain, instrument params.
 */

export interface ExpAudioSource {
  id: number
  /** Path inside the archive, e.g. `audio/001_kick.wav`. */
  file: string
  sampleRate: number
  channels: number
  durationSec: number
}

export interface ExpAudioClip {
  sourceId: number
  name: string
  startSec: number
  offsetSec: number
  lengthSec: number
  fadeInSec: number
  fadeOutSec: number
}

export interface ExpMidiClip {
  name: string
  startBeats: number
  lengthBeats: number
  notes: { start: number; dur: number; key: number; vel: number }[]
}

export interface ExpTrack {
  kind: 'audio' | 'notes'
  name: string
  gainDb: number
  /** -1..+1 */
  pan: number
  mute: boolean
  solo: boolean
  channels: number
  /** MIDI channel 0..15 written on the notes (a drum part is channel 9 = General MIDI channel 10). */
  midiChannel?: number
  audioClips: ExpAudioClip[]
  midiClips: ExpMidiClip[]
}

export interface ExpProject {
  bpm: number
  timeSig: { num: number; den: number }
  masterGainDb: number
  tracks: ExpTrack[]
  sources: ExpAudioSource[]
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const f = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '0')
// DAWproject volume is linear (1.0 = unity); floor at -100 dB so silence stays finite
const dbToLin = (db: number): number => (db <= -100 ? 0 : Math.pow(10, db / 20))

export function buildDawprojectXml(p: ExpProject): string {
  let n = 0
  const id = (): string => `id${n++}`
  const bySource = new Map(p.sources.map((s) => [s.id, s]))
  const beatsPerSec = p.bpm / 60
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<Project version="1.0">']
  out.push('  <Application name="Awaker DAW over GPU" version="0.0.1"/>')
  out.push('  <Transport>')
  out.push(`    <Tempo max="999" min="20" unit="bpm" value="${f(p.bpm)}" id="${id()}" name="Tempo"/>`)
  out.push(`    <TimeSignature denominator="${p.timeSig.den}" numerator="${p.timeSig.num}" id="${id()}"/>`)
  out.push('  </Transport>')

  // ---- structure ----
  const masterTrackId = id()
  const masterChannelId = id()
  const trackIds: string[] = []
  out.push('  <Structure>')
  for (const t of p.tracks) {
    const tid = id()
    trackIds.push(tid)
    const pan = (Math.max(-1, Math.min(1, t.pan)) + 1) / 2
    out.push(`    <Track contentType="${t.kind}" loaded="true" id="${tid}" name="${esc(t.name)}">`)
    out.push(
      `      <Channel audioChannels="${Math.max(1, t.channels)}" destination="${masterChannelId}" role="regular" solo="${t.solo}" id="${id()}">`
    )
    out.push(`        <Mute value="${t.mute}" id="${id()}" name="Mute"/>`)
    out.push(`        <Pan max="1.0" min="0.0" unit="normalized" value="${f(pan)}" id="${id()}" name="Pan"/>`)
    out.push(`        <Volume max="2.0" min="0.0" unit="linear" value="${f(dbToLin(t.gainDb))}" id="${id()}" name="Volume"/>`)
    out.push('      </Channel>')
    out.push('    </Track>')
  }
  // contentType is optional and "audio mixer" is not in the schema's enumeration — leave it off
  out.push(`    <Track loaded="true" id="${masterTrackId}" name="Master">`)
  out.push(`      <Channel audioChannels="2" role="master" id="${masterChannelId}">`)
  out.push(`        <Volume max="2.0" min="0.0" unit="linear" value="${f(dbToLin(p.masterGainDb))}" id="${id()}" name="Volume"/>`)
  out.push('      </Channel>')
  out.push('    </Track>')
  out.push('  </Structure>')

  // ---- arrangement (positions in beats; audio content offsets in seconds) ----
  out.push(`  <Arrangement id="${id()}">`)
  out.push(`    <Lanes timeUnit="beats" id="${id()}">`)
  p.tracks.forEach((t, i) => {
    out.push(`      <Lanes track="${trackIds[i]}" id="${id()}">`)
    out.push(`        <Clips id="${id()}">`)
    if (t.kind === 'audio') {
      for (const c of t.audioClips) {
        const src = bySource.get(c.sourceId)
        if (!src) continue
        out.push(
          `          <Clip time="${f(c.startSec * beatsPerSec)}" duration="${f(c.lengthSec * beatsPerSec)}" contentTimeUnit="seconds" playStart="${f(c.offsetSec)}" fadeTimeUnit="seconds" fadeInTime="${f(c.fadeInSec)}" fadeOutTime="${f(c.fadeOutSec)}" name="${esc(c.name)}">`
        )
        out.push(
          `            <Audio algorithm="raw" channels="${src.channels}" duration="${f(src.durationSec)}" sampleRate="${src.sampleRate}" id="${id()}">`
        )
        out.push(`              <File path="${esc(src.file)}"/>`)
        out.push('            </Audio>')
        out.push('          </Clip>')
      }
    } else {
      for (const c of t.midiClips) {
        out.push(
          `          <Clip time="${f(c.startBeats)}" duration="${f(c.lengthBeats)}" contentTimeUnit="beats" playStart="0.0" name="${esc(c.name)}">`
        )
        out.push(`            <Notes id="${id()}">`)
        for (const nt of c.notes) {
          out.push(
            `              <Note time="${f(nt.start)}" duration="${f(nt.dur)}" channel="${Math.max(0, Math.min(15, t.midiChannel ?? 0))}" key="${nt.key | 0}" vel="${f(nt.vel / 127)}" rel="${f(nt.vel / 127)}"/>`
          )
        }
        out.push('            </Notes>')
        out.push('          </Clip>')
      }
    }
    out.push('        </Clips>')
    out.push('      </Lanes>')
  })
  out.push('    </Lanes>')
  out.push('  </Arrangement>')
  out.push('</Project>')
  return out.join('\n')
}

/** Minimal metadata.xml (the container expects one next to project.xml). */
export function buildMetadataXml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<MetaData>\n  <Title>${esc(title)}</Title>\n  <Comment>Exported from Awaker DAW over GPU</Comment>\n</MetaData>`
}
