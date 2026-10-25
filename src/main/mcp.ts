// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { findSkill, type Skill } from './skills'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { ipcMain, type BrowserWindow } from 'electron'

/**
 * Built-in MCP server (dev / regression aid) — lets an AI drive the *running* app:
 * edit the project, move faders / plugin params, transport + record, render an
 * offline bounce and read level / LUFS stats, take screenshots, read the console.
 *
 * Opt-in: only starts when `DAW_MCP=1` (npm run dev:mcp). Hand-rolled MCP over
 * "Streamable HTTP" (plain JSON responses; no SSE) so there is no new dependency.
 * Bound to 127.0.0.1 only. A browser tab can't reach it: requests carrying an
 * `Origin` header are refused and the body must be `application/json` (a
 * cross-site form can't send that without a CORS preflight).
 *
 * Most tools run in the renderer (that's where the project + GPU live): main
 * forwards `{tool,args}` over IPC and awaits the reply. Tools marked `main`
 * run here (screenshot, console log, project file I/O, device list, reload).
 */

interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  where: 'renderer' | 'main'
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const num = (description: string): Record<string, unknown> => ({ type: 'number', description })
const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
const bool = (description: string): Record<string, unknown> => ({ type: 'boolean', description })
const owner = {
  description: "Track id (number, from tracks_list), group channel id (number, from groups_list; 1001 and up) or 'master'",
  anyOf: [{ type: 'number' }, { type: 'string', enum: ['master'] }]
}
const INSERT_KINDS = ['reverb', 'delay', 'eq5', 'tubeeq', 'awaker', 'buscomp', 'maximizer']

const TOOLS: ToolSpec[] = [
  {
    name: 'state_get',
    where: 'renderer',
    description:
      'Transport / engine snapshot: playing, recording, playhead, sample rate, bpm, track count, audio backend + input info, live meters (master peak, LUFS M/S/I).',
    inputSchema: obj({})
  },
  {
    name: 'project_get',
    where: 'renderer',
    description:
      'The full project snapshot exactly as Save writes it (all faders, pans, strips, every insert plugin param, clips, sources, master).',
    inputSchema: obj({})
  },
  {
    name: 'project_load',
    where: 'renderer',
    description: 'Replace the whole project with a snapshot object (same shape as project_get).',
    inputSchema: obj({ project: { type: 'object' } }, ['project'])
  },
  {
    name: 'project_save_file',
    where: 'main',
    description: 'Write the current project JSON to an absolute file path.',
    inputSchema: obj({ path: str('absolute .json path') }, ['path'])
  },
  {
    name: 'project_load_file',
    where: 'main',
    description: 'Load a project JSON file from an absolute path (replaces the current project).',
    inputSchema: obj({ path: str('absolute .json path') }, ['path'])
  },
  {
    name: 'drum_pattern_add',
    where: 'renderer',
    description:
      'Add a drum-machine track with a preset pattern. preset: "Basic beat" | "Four on the floor" | "Trap" | "Latin percussion" | "Djembe groove". bars 1-8 (default 2). The kit has kick, snare, clap, hats, toms, rim, cowbell, clave, cymbal, djembe, guiro, bongo and conga voices; edit hits with midi notes (keys: kick 36, snare 38, clap 39, closed hat 42, open hat 46, ...).',
    inputSchema: obj({ name: str('track name'), preset: str('preset name'), bars: { type: 'number' }, bpm: { type: 'number' } })
  },
  {
    name: 'dawproject_export',
    where: 'renderer',
    description:
      'Export the project as a .dawproject file to an absolute path (audio tracks + clips as WAV, instrument lanes as MIDI notes, volume / pan / mute / solo, tempo, time signature).',
    inputSchema: obj({ path: str('absolute .dawproject path') }, ['path'])
  },
  {
    name: 'dawproject_import',
    where: 'renderer',
    description:
      'Import a .dawproject file (Cubase 14+ File > Export > DAWproject) from an absolute path; replaces the current project. Returns track / clip counts.',
    inputSchema: obj({ path: str('absolute .dawproject path') }, ['path'])
  },
  {
    name: 'pianoroll',
    where: 'renderer',
    description:
      'Drive the piano roll overlay like a mouse (test hook). action: open {track = MIDI track index, clip?} | pointer {kind: down|move|up, x, y in canvas pixels, shift?, alt?, button?} | key {key: Delete|Escape|a, ctrl?} | close | info (layout: keysW, rulerH, velH, canvas size, view, selection).',
    inputSchema: obj(
      {
        action: str('open | pointer | key | close | info'),
        track: { type: 'number' },
        clip: { type: 'number' },
        kind: str('down | move | up'),
        x: { type: 'number' },
        y: { type: 'number' },
        shift: { type: 'boolean' },
        alt: { type: 'boolean' },
        button: { type: 'number' },
        key: str('key name'),
        ctrl: { type: 'boolean' }
      },
      ['action']
    )
  },
  {
    name: 'instrument_presets',
    where: 'renderer',
    description:
      'List factory presets: FM synth presets (load with instrument_set {track, params: {preset: "Bell"}} — other keys in params then override it) and drum-machine pattern presets (for drum_pattern_add). FM params: ops[4] {ratio, fine, fixedHz, level, velSens, atk, dec, sus, rel}, mod[i][j] (op j modulates op i, j>i), out[4], feedback {op, amount}, index, click, pitchPunch, pitchTime, atkScale, relScale, gain.',
    inputSchema: obj({})
  },
  {
    name: 'live_lane_add',
    where: 'renderer',
    description: 'Add a line-input track: live input from the audio interface through the track\'s strip + inserts. ch = first input channel (0-based), stereo = take ch and ch+1.',
    inputSchema: obj({ name: str('track name'), ch: { type: 'number' }, stereo: { type: 'boolean' } })
  },
  {
    name: 'monitor',
    where: 'renderer',
    description:
      'Start / stop the live monitor session (device kept open, line-input tracks processed in real time while the transport is stopped). synthetic: "impulse" = a click every 4800 frames on both channels instead of hardware input (time-alignment test: see live_info.main.alignMaxErrFrames), "tone" = stereo tones, "off" = hardware.',
    inputSchema: obj({ action: str('start | stop'), synthetic: str('off | tone | impulse'), latencyMs: { type: 'number' }, block: num('live block size in frames: 256 | 512 | 1024 | 2048 | 4096 (stops the session first; measuring)') }, ['action'])
  },
  {
    name: 'live_info',
    where: 'renderer',
    description: 'Timing and health of the live path: landing latency, round trip, GPU time per block, late / dropped blocks, synthetic-impulse alignment error (frames).',
    inputSchema: obj({})
  },
  {
    name: 'midi_import',
    where: 'renderer',
    description: 'Import a Standard MIDI File (.mid) from an absolute path: each track with notes becomes an instrument track.',
    inputSchema: obj({ path: str('absolute .mid path') }, ['path'])
  },
  {
    name: 'midi_export',
    where: 'renderer',
    description: 'Export all MIDI tracks as a Standard MIDI File (format 1) to an absolute .mid path.',
    inputSchema: obj({ path: str('absolute .mid path') }, ['path'])
  },
  {
    name: 'midi_track_set',
    where: 'renderer',
    description:
      'Route an instrument / MIDI track to the outside: `out` = the name (or part of it) of a MIDI output port, or "none"; `channel` 1-16; `outDelayMs` = the app-wide MIDI output delay in ms (negative = send MIDI earlier, to line up an external instrument whose audio comes back late). Returns the resulting settings and the ports found.',
    inputSchema: obj({ track: num('track id (the instrument lane)'), out: str('output port name or part of it, or "none"'), channel: num('MIDI channel 1-16'), outDelayMs: num('app-wide MIDI out delay, ms (-200..500)') }, ['track'])
  },
  {
    name: 'midi_track_add',
    where: 'renderer',
    description:
      'Add an instrument track (MIDI notes played by the built-in GPU synth). notes: [{start, dur, key, vel?}] with start/dur in beats from the project start, key = MIDI note number. Optional bpm sets the project tempo first.',
    inputSchema: obj(
      {
        name: str('track name'),
        bpm: { type: 'number' },
        instrument: str('synth (default) | drums | earlysynth | fm | none (no sound, external MIDI only)'),
        notes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { start: { type: 'number' }, dur: { type: 'number' }, key: { type: 'number' }, vel: { type: 'number' } },
            required: ['start', 'dur', 'key']
          }
        }
      },
      ['notes']
    )
  },
  {
    name: 'instrument_swap',
    where: 'renderer',
    description:
      'Replace the sound engine of an instrument track (kind: synth | earlysynth | drums). Notes, strip, inserts and fader are kept; the params of the engine being left are remembered for this session so swapping back restores them.',
    inputSchema: obj({ track: { type: 'number' }, kind: str('synth | earlysynth | drums') }, ['track', 'kind'])
  },
  {
    name: 'instrument_set',
    where: 'renderer',
    description:
      'Merge params into an instrument track and re-render it on the GPU. Synth params: wave (saw|square|tri|sine), detuneCents, sub, spread, pw, atk, dec, sus, rel, cutoffHz, res, gain. `track` is the lane id.',
    inputSchema: obj({ track: { type: 'number' }, params: { type: 'object' } }, ['track', 'params'])
  },
  {
    name: 'tracks_list',
    where: 'renderer',
    description: 'Compact per-track summary: id, title, mix, record routing, clips, inserts (kind + bypass).',
    inputSchema: obj({})
  },
  {
    name: 'track_add_tone',
    where: 'renderer',
    description: 'Add a track holding a generated GPU test chord (stereo).',
    inputSchema: obj({ seconds: num('length, default 6'), title: str('track title') })
  },
  {
    name: 'track_add_wav',
    where: 'renderer',
    description: 'Add a track from a WAV file path (resampled to the project rate on the GPU).',
    inputSchema: obj({ path: str('absolute .wav path'), title: str('track title') }, ['path'])
  },
  {
    name: 'track_set',
    where: 'renderer',
    description:
      'Set channel fader / pan / mute / solo / rec-arm / record input routing / title. Only given fields change.',
    inputSchema: obj(
      {
        track: num('track id'),
        gainDb: num('-60..+6 (-60 = -inf)'),
        pan: num('-1..+1'),
        mute: bool(''),
        solo: bool(''),
        rec: bool('arm for recording'),
        recIn: obj({ ch: num('0-based input channel'), stereo: bool('record ch and ch+1 as a pair') }, ['ch']),
        title: str(''),
        group: num('route this track into the group channel with this id (groups_list); 0 = straight to the master'),
        color: str('track colour: "#rrggbb" (or "#rgb"), or a palette number "0".."11". The lane is painted in it and the waveform is dark grey on top. A track that has a stem recolours every track of that stem.')
      },
      ['track']
    )
  },
  {
    name: 'strip_set',
    where: 'renderer',
    description:
      'Built-in channel strip: bypass and/or a partial params object, deep-merged (trimDb, drive, satMode, hpfHz, eqOn, eq[4], comp{...}).',
    inputSchema: obj({ track: num('track id'), bypass: bool(''), params: { type: 'object' } }, ['track'])
  },
  {
    name: 'insert_add',
    where: 'renderer',
    description: `Append an insert plugin (${INSERT_KINDS.join(' | ')}; buscomp / maximizer are master-only).`,
    inputSchema: obj(
      {
        owner,
        kind: { type: 'string', enum: INSERT_KINDS },
        params: { type: 'object', description: 'initial param overrides (eq5: {bands:[...]})' },
        bypass: bool('')
      },
      ['owner', 'kind']
    )
  },
  {
    name: 'insert_set',
    where: 'renderer',
    description: 'Change an insert plugin: partial params (merged) and/or bypass. index = slot position in the rack.',
    inputSchema: obj(
      { owner, index: num('0-based index in the insert list'), params: { type: 'object' }, bypass: bool('') },
      ['owner', 'index']
    )
  },
  {
    name: 'insert_remove',
    where: 'renderer',
    description: 'Remove an insert plugin.',
    inputSchema: obj({ owner, index: num('0-based') }, ['owner', 'index'])
  },
  {
    name: 'master_set',
    where: 'renderer',
    description: 'Master fader in dB (-60..+6).',
    inputSchema: obj({ gainDb: num('dB') }, ['gainDb'])
  },
  {
    name: 'transport',
    where: 'renderer',
    description:
      'play | stop | seek | record_start | record_stop. record_start records every rec-armed track from the playhead; set synthetic=true to record a deterministic built-in test signal (L 220 Hz, R 330 Hz, 0.5 amp) with no hardware. record_stop commits the takes as clips.',
    inputSchema: obj(
      {
        action: { type: 'string', enum: ['play', 'stop', 'seek', 'record_start', 'record_stop'] },
        seconds: num('seek / start position in seconds'),
        frame: num('seek / start position in frames (overrides seconds)'),
        synthetic: bool('record_start: use the built-in test signal instead of the audio interface')
      },
      ['action']
    )
  },
  {
    name: 'groups_list',
    where: 'renderer',
    description:
      'List the group channels (buses): id (1001 and up), name, fader / pan / mute / solo, the tracks routed to it and its inserts. A group sums the tracks routed to it, runs the sum through its own inserts and fader, then adds it to the master. Use it for "turn the drums down" (one fader) instead of changing every track.',
    inputSchema: obj({})
  },
  {
    name: 'group_add',
    where: 'renderer',
    description: 'Create a group channel (bus). Optionally route tracks into it right away (tracks = track ids).',
    inputSchema: obj({
      name: str('group name, e.g. "Drums"'),
      tracks: { type: 'array', items: { type: 'number' }, description: 'track ids to route into the new group' }
    })
  },
  {
    name: 'group_set',
    where: 'renderer',
    description:
      'Change a group channel: name, fader (gainDb -60..+6), pan (-1..+1), mute, solo, and which tracks feed it (tracks = the full list of track ids routed into it; a track can be in one group). Only given fields change. Group inserts use insert_add / insert_set / insert_remove with owner = the group id.',
    inputSchema: obj(
      {
        group: num('group id from groups_list'),
        name: str(''),
        gainDb: num('-60..+6 (-60 = -inf)'),
        pan: num('-1..+1'),
        mute: bool(''),
        solo: bool(''),
        color: str('group colour "#rrggbb" or palette number "0".."11"; the group\'s tracks that have no stem take it'),
        tracks: { type: 'array', items: { type: 'number' }, description: 'the complete list of track ids routed into this group' }
      },
      ['group']
    )
  },
  {
    name: 'group_remove',
    where: 'renderer',
    description: 'Delete a group channel. Its tracks go straight to the master again.',
    inputSchema: obj({ group: num('group id') }, ['group'])
  },
  {
    name: 'stems_list',
    where: 'renderer',
    description:
      'List the stems of the project: a stem is a name tracks carry; tracks with the same name are exported together as one file. Returns the stems with their tracks, and the tracks that have no stem.',
    inputSchema: obj({})
  },
  {
    name: 'stem_set',
    where: 'renderer',
    description:
      'Put a track into a stem (give it a stem name; an empty name takes it out). To make a "Drums" stem, call this for each drum track with stem "Drums". Decide membership from the track names and say which tracks you chose.',
    inputSchema: obj({ track: num('track id'), stem: str('stem name, e.g. "Drums"; empty string = none') }, ['track', 'stem'])
  },
  {
    name: 'stems_export',
    where: 'renderer',
    description:
      'Export stems as WAV files: each stem is the sum of its tracks as heard at the channel output (strip + inserts + fader + pan), rendered offline; all files have the same length and line up. Group channels are exported too, each as the output of the group (its tracks, then the group inserts and fader) — stems = names of stems and / or groups; includeGroups false leaves them out. Defaults come from Options > Export (24-bit WAV, project rate, strip + inserts through, master chain NOT included — like a standard channel export). Overrides: bitDepth 16|24|32, sampleRate (0 = project, 44100, 48000, 88200, 96000), process "full" (strip + inserts) | "noInserts" | "dry" (no strip, no inserts), masterChain true|false, tailSeconds. stems = names to export (default all), perTrack = one file per track, startSeconds / seconds = range. By default it also checks that the stems add up to the mix of the same tracks and reports the difference. The folder is chosen by the app (Documents/Awaker/Stems/...) when called by the built-in assistant.',
    inputSchema: obj({
      stems: { type: 'array', items: { type: 'string' }, description: 'stem names; default all stems' },
      perTrack: bool('one file per track instead of per stem'),
      includeGroups: bool('also export every group channel (default true when no stems are named)'),
      folder: str('output folder (external MCP clients only; the built-in assistant always uses the default folder)'),
      bitDepth: num('16 | 24 | 32 (32 = float)'),
      sampleRate: num('0 = project rate, or 44100 / 48000 / 88200 / 96000'),
      process: { type: 'string', enum: ['full', 'noInserts', 'dry'], description: 'what of the channel processing is included; default full' },
      masterChain: bool('also run the master fader + master inserts; default false'),
      tailSeconds: num('extra seconds after the last clip'),
      startSeconds: num('range start; default 0'),
      seconds: num('range length; default to the end of the last clip'),
      verify: bool('check the stems add up (default true with 2+ stems)')
    })
  },
  {
    name: 'mix_target',
    where: 'renderer',
    description:
      'The balance the AI mix steers towards: a genre\'s typical long-term spectrum, or the average spectrum of a reference song the person picked in the AI Mix dialog. Returns the current target (null = none yet) and the genre ids you can set with mix_target_set.',
    inputSchema: obj({})
  },
  {
    name: 'mix_target_set',
    where: 'renderer',
    description:
      'Pick the target by genre id: pop | rock | metal | edm | hiphop | rnb | jazz | acoustic | classical. (A reference song can only be chosen by the person, in the AI Mix dialog.)',
    inputSchema: obj({ genre: str('genre id') }, ['genre'])
  },
  {
    name: 'spectrum_analyze',
    where: 'renderer',
    description:
      'MEASURE the long-term average spectrum of the whole song (offline render, transport is stopped for you) against the target of mix_target. Returns, in 28 third-octave bands 31.5 Hz – 16 kHz: measuredDb / targetDb / deviationDb (measured - target; positive = too much energy), toleranceDb, a score (rmsDb, withinTolerancePct, worst band) and a summary ("on target" | "close" | "off target"). `regions` lists the stretches that are out of tolerance: verdict "too much" / "too little", meanDb, and `fix` = one EQ move that corrects ~70 % of it ({kind, freq, gainDb, q}; pass it to eq_apply). scope "breakdown" also renders each group channel, each stem that is not in a group and the remaining tracks on their own: every region then carries `parts` = the parts that hold its energy, each with owner ({kind:"group",id} | {kind:"stem",tracks} | {kind:"other",tracks}), shareDb (0 = it is all of it) and gainDb (the gain an EQ band on that part alone would need; null = it hardly contributes). Takes about the length of the song x number of parts / 20 in seconds; startSeconds / seconds measure a part of the song.',
    inputSchema: obj({
      scope: { type: 'string', enum: ['master', 'breakdown'], description: 'default master' },
      startSeconds: num('default 0'),
      seconds: num('length; default to the end')
    })
  },
  {
    name: 'track_levels',
    where: 'renderer',
    description:
      'MEASURE each track as it leaves its channel (strip + inserts + fader + pan, offline, transport is stopped for you): rmsDb = RMS over the stretches that actually play (a sparse part is not diluted by silence), peakDb, crestDb = peak - rms, stickOutDb = how far the loudest 100 ms sticks out over the average (the part that "jumps out"), activeSeconds, and the current faderDb / trimDb / comp. suggestTrimDb is the strip trim (strip_set params.trimDb) that brings rmsDb to targetDb (default -18) — set it, measure again. Silent tracks come back with silent: true. tracks = only these ids; startSeconds / seconds = a part of the song. Takes about the song length / 20 seconds per track.',
    inputSchema: obj({
      tracks: { type: 'array', items: { type: 'number' }, description: 'track ids; default every track with audio' },
      targetDb: num('target RMS in dBFS, default -18'),
      startSeconds: num('default 0'),
      seconds: num('length; default to the end')
    })
  },
  {
    name: 'eq_apply',
    where: 'renderer',
    description:
      'Add a correction to the 5-band EQ (insert "eq5": low shelf, 3 peaks, high shelf) of a channel; the first eq5 on that channel is used and one is created when there is none. The gainDb is ADDED to what the band already has (so repeated measure-correct rounds accumulate; total limit ±12 dB). kind picks the band: lowshelf = band 0, highshelf = band 4, peak = whichever of bands 1-3 already works near that frequency, else a free one. owner = track id, group id or "master"; tracks = a list of track ids (a stem\'s tracks) gets the same move on each. Use the `fix` of a spectrum_analyze region, or the `gainDb` of one of its parts. Correct the channel that CAUSES the excess; the master EQ is only a finishing touch and each master band is held to ±3 dB.',
    inputSchema: obj(
      {
        owner,
        tracks: { type: 'array', items: { type: 'number' }, description: 'several track ids instead of owner' },
        kind: { type: 'string', enum: ['lowshelf', 'peak', 'highshelf'] },
        freq: num('Hz, 20..20000'),
        gainDb: num('dB to add, -12..+12'),
        q: num('width: 0.3 (wide) .. 8 (narrow); default 1 for a peak, 0.7 for a shelf')
      },
      ['kind', 'freq', 'gainDb']
    )
  },
  {
    name: 'mixdown_export',
    where: 'renderer',
    description:
      'Export the WHOLE MIX as one WAV, exactly as it plays: strips, inserts, groups, the master chain and the master fader (transport is stopped for you). Defaults come from Options > Export (24-bit WAV, project rate, tail seconds). Returns the file path and what was measured: peakDb, rmsDb, lufsIntegrated, clippedFrames, samples clamped by the integer conversion. Only on request — it writes a file. The folder is chosen by the app (Documents/Awaker/Stems/...) when called by the built-in assistant.',
    inputSchema: obj({
      folder: str('output folder (external MCP clients only)'),
      bitDepth: num('16 | 24 | 32 (32 = float)'),
      sampleRate: num('0 = project rate, or 44100 / 48000 / 88200 / 96000'),
      tailSeconds: num('extra seconds after the last clip (reverb / delay tails)')
    })
  },
  {
    name: 'chat_say',
    where: 'renderer',
    description:
      'Write a line into the in-app chat (the MCP log window). Use it to tell the person what you are about to do or what you found; they can read it while the window is locked.',
    inputSchema: obj({ text: str('message') }, ['text'])
  },
  {
    name: 'chat_read',
    where: 'renderer',
    description:
      'Read the lines the person typed into the in-app chat since the last read (returned once, then cleared). waitSeconds (max 50) waits for a line if none is queued — use it to ask a question and wait for the answer.',
    inputSchema: obj({ waitSeconds: num('wait up to this long for a message; default 0 = return immediately') })
  },
  {
    name: 'chat_type',
    where: 'renderer',
    description:
      'Test hook: type a line into the in-app chat and press Enter, exactly as the person would (goes to whichever AI backend is selected). Use it to test the AI panel end to end.',
    inputSchema: obj({ text: str('the line to type') }, ['text'])
  },
  {
    name: 'chat_history',
    where: 'renderer',
    description:
      'Test hook: the last lines shown in the in-app chat window, oldest first, each {who: "you" | "ai", text}. Use it with chat_type to hold a conversation with the AI that lives inside the app.',
    inputSchema: obj({ limit: num('how many lines, default 10') })
  },
  {
    name: 'wait',
    where: 'renderer',
    description: 'Sleep (max 60 s) — e.g. let a recording run, or let playback progress.',
    inputSchema: obj({ ms: num('milliseconds') }, ['ms'])
  },
  {
    name: 'bounce',
    where: 'renderer',
    description:
      'Offline render of the master through the whole GPU path (no audio device, transport must be stopped) and return stats: peak/RMS dB per channel, DC, clipped frames, LUFS integrated + max short-term, a 0.5 s loudness contour. The core regression primitive: set up, bounce, compare numbers.',
    inputSchema: obj({
      startSeconds: num('default 0'),
      seconds: num('length; default = up to the last clip end'),
      tailSeconds: num('extra render past the last clip (reverb / delay tails); default 0'),
      save: bool('also write the render as a 32-bit float WAV and return its path')
    })
  },
  {
    name: 'loudness_land',
    where: 'renderer',
    description:
      'LAND THE MASTER at a target integrated loudness (default -14 LUFS): renders the whole song offline, reads the integrated loudness, moves the MASTER FADER and renders again until it is within the tolerance (the fader sits in front of the master chain, so the output answers less than 1:1 — hence the search). Returns startDb / endDb (fader), startLufs / endLufs, the steps, whether it reached the target, and the peak / clipped frames of the final render. Leaves the master fader at the best value found. Use it as the LAST step of a mix; it does not touch tracks, strips or inserts. The loudness is the app\'s displayed integrated LUFS (K-weighted, with its provisional calibration). Transport is stopped for you. Each step is a full render of the song (about song length / 20 seconds).',
    inputSchema: obj({
      targetLufs: num('target integrated loudness in LUFS, -30..-6; default -14'),
      toleranceLu: num('accept within this many LU; default 0.3'),
      maxIterations: num('renders at most; default 8')
    })
  },
  {
    name: 'headroom_fit',
    where: 'renderer',
    description:
      'REMOVE THE RED: measures the output peak of every track and every group channel over the whole song (offline, transport is stopped for you) and lowers ALL track faders together by the same amount, so the loudest peak ends marginDb under 0 dBFS — the balance is kept. A group whose sum is still over gets the remainder on its own fader. Lowering everything by 10 dB or more is normal and fine (the -18 dB per track of the gain staging is only a starting point); do not compensate with trims. Returns dropDb, groupExtraDb, the worst peak before / after, and stillOver (the tracks / groups that are still over 0 dBFS: it should be empty). Run it before loudness_land. Each track is a full render (about song length / 20 seconds per track, twice).',
    inputSchema: obj({ marginDb: num('how far under 0 dBFS the loudest peak must end up, 0..6; default 0.5') })
  },
  {
    name: 'ui_query',
    where: 'renderer',
    description: 'Inspect DOM elements by CSS selector: text, value, classes, bounding box, disabled. Max 50 matches.',
    inputSchema: obj({ selector: str('CSS selector') }, ['selector'])
  },
  {
    name: 'ui_click',
    where: 'renderer',
    description: 'Click the first element matching a CSS selector (buttons, tabs, menu rows). pointer: true also sends pointerdown / pointerup first (what selects a track lane or mixer strip).',
    inputSchema: obj({ selector: str('CSS selector'), index: num('which match, default 0'), pointer: bool('send pointerdown + pointerup before the click') }, ['selector'])
  },
  {
    name: 'screenshot',
    where: 'main',
    description: 'PNG screenshot of the app window.',
    inputSchema: obj({ maxWidth: num('downscale to this width (default 1400)') })
  },
  {
    name: 'logs',
    where: 'main',
    description: 'Recent renderer console output (ring buffer, newest last). Filter by level and/or substring.',
    inputSchema: obj({
      level: { type: 'string', enum: ['all', 'warn', 'error'], description: 'default all' },
      contains: str('substring filter'),
      limit: num('max lines, default 100'),
      clear: bool('clear the buffer after reading')
    })
  },
  {
    name: 'ops_log',
    where: 'main',
    description:
      'Look back at what was done in this app: the operation log, newest last. kind "tool" = individual tool calls (name, args, ok, ms); "turn" = one entry per question to the built-in assistant, with what the app MEASURED to have changed (field, from → to), the tools used and the assistant\'s replies; "all" (default) = both. Older entries survive in rotated files across sessions. Use it to check what actually happened instead of trusting a summary.',
    inputSchema: obj({
      limit: num('how many entries, default 20, max 100'),
      kind: { type: 'string', enum: ['all', 'tool', 'turn'], description: 'default all' }
    })
  },
  {
    name: 'skills_list',
    where: 'main',
    description:
      'The skills of this app: detailed, tested instructions for specific jobs (name + one line each). Read the one that fits with skill_get before you start the job.',
    inputSchema: obj({})
  },
  {
    name: 'skill_get',
    where: 'main',
    description:
      'The full text of a skill (its steps, the tools and values to use, what not to do). Call it before a job a skill covers — mixing, stems / groups, basic operation — and follow it exactly.',
    inputSchema: obj({ name: str('skill name from skills_list, e.g. "ai-mix"') }, ['name'])
  },
  {
    name: 'audio_devices',
    where: 'main',
    description: 'Native audio devices (RtAudio / WASAPI view): ids, channel counts, sample rates.',
    inputSchema: obj({})
  },
  {
    name: 'audio_inputs',
    where: 'main',
    description: 'WASAPI recording (input) devices (inputChannels > 0): ids, names, channel counts, sample rates, and the default input id.',
    inputSchema: obj({})
  },
  {
    name: 'return_start',
    where: 'main',
    description:
      'Start the secondary WASAPI shared-mode return input (or a synthetic sine/impulse test source) and route it into the live path with drift compensation. Pick a device by `deviceId` (from audio_inputs) or `deviceName`, or pass `synthetic: true | "sine" | "impulse"` (and optional `driftPpm`) for verification.',
    inputSchema: obj({
      deviceId: num('WASAPI input device id from audio_inputs'),
      deviceName: str('substring of the WASAPI input device name'),
      delayMs: num('manual delay offset in ms (-100..500)'),
      synthetic: { description: 'true / "sine" for stereo 440/660 Hz test tones, "impulse" for click alignment test', anyOf: [{ type: 'boolean' }, { type: 'string' }] },
      driftPpm: num('simulated clock drift in ppm for synthetic mode (-450..450)')
    })
  },
  {
    name: 'return_stop',
    where: 'main',
    description: 'Stop the secondary WASAPI return input and release the external live path.',
    inputSchema: obj({})
  },
  {
    name: 'return_status',
    where: 'main',
    description:
      'Status and numerical telemetry of the secondary WASAPI return input: connection state, received/injected frames, ring buffer occupancy (fillRatio, ringBufferedFrames/ringTargetFrames), drift compensation (resampleRatio, ppm), underruns/overruns, clockDeltaFrames, and delayMs (pass delayMs to update it live).',
    inputSchema: obj({
      delayMs: num('optional: update the manual delay offset in ms (-100..500)')
    })
  },
  {
    name: 'vst_listen',
    where: 'main',
    description:
      'VST host bridge (proof of concept): start listening for an out-of-process VST3 host on 127.0.0.1. Returns {port, token, sampleRate, block}; start the host with those (it connects, loads `plugin`, and feeds the live path). Add a line-input track (live_lane_add) and start the monitor to hear it.',
    inputSchema: obj({ plugin: str('absolute path of the .vst3 the host should load') }, ['plugin'])
  },
  {
    name: 'vst_note',
    where: 'main',
    description: 'Play one note through the VST host now (test hook): key 0-127, vel 1-127, durMs, MIDI channel 1-16.',
    inputSchema: obj({ key: num('0-127'), vel: num('1-127'), durMs: num('note length, ms'), channel: num('1-16') }, ['key'])
  },
  {
    name: 'vst_status',
    where: 'main',
    description: 'VST host bridge health: connected / ready, host round trip per block (mean / max) against the block budget, late events, resyncs.',
    inputSchema: obj({})
  },
  {
    name: 'vst_stop',
    where: 'main',
    description: 'Stop the VST host bridge (tells the host to quit, releases the live path).',
    inputSchema: obj({})
  },
  {
    name: 'app_reload',
    where: 'main',
    description: 'Reload the renderer (fresh JS state; restores the last saved project).',
    inputSchema: obj({})
  }
]

// ---- console ring buffer ----------------------------------------------------------

interface LogLine {
  t: number
  level: 'log' | 'info' | 'warn' | 'error'
  msg: string
}
const LOG_MAX = 1000
const logs: LogLine[] = []
const LEVELS: LogLine['level'][] = ['log', 'info', 'warn', 'error']

/** Feed from `webContents 'console-message'` (levels 0..3). */
export function mcpLog(level: number, message: string): void {
  logs.push({ t: Date.now(), level: LEVELS[Math.min(3, Math.max(0, level))], msg: message })
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX)
}

// ---- renderer bridge --------------------------------------------------------------

let rendererReady = false
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

let mcpUrl = ''
/** The renderer shows the connection URL next to the AI button. */
ipcMain.handle('daw:mcp:url', () => mcpUrl)

ipcMain.on('daw:mcp:ready', () => {
  rendererReady = true
})
ipcMain.on('daw:mcp:reply', (_e, id: number, ok: boolean, payload: unknown) => {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  clearTimeout(p.timer)
  if (ok) p.resolve(payload)
  else p.reject(new Error(String(payload)))
})

/** The renderer page reloaded — its tool table is gone until it re-announces. */
export function mcpRendererReset(): void {
  rendererReady = false
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error('renderer reloaded'))
    pending.delete(id)
  }
}

async function callRenderer(win: BrowserWindow | null, tool: string, args: unknown): Promise<unknown> {
  if (!win || win.isDestroyed()) throw new Error('no app window')
  const t0 = Date.now()
  while (!rendererReady) {
    if (Date.now() - t0 > 30000) throw new Error('renderer not ready (still booting / WebGPU failed?)')
    await new Promise((r) => setTimeout(r, 100))
  }
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`tool ${tool} timed out`))
    }, 180000)
    pending.set(id, { resolve, reject, timer })
    win.webContents.send('daw:mcp:call', { id, tool, args })
  })
}

// ---- server ------------------------------------------------------------------------

export interface McpDeps {
  getWin: () => BrowserWindow | null
  listDevices: () => unknown
  listInputs?: () => unknown
  vst?: import('./vst-bridge').VstBridge
  returnIn?: import('./return-in').ReturnIn
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
interface ToolOut {
  content: Content[]
  isError?: boolean
}

/** JSON can't carry -Infinity / NaN (levels of silence) — render them as strings. */
function jsonSafe(_k: string, v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity'
  return v
}
const text = (v: unknown): ToolOut => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, jsonSafe, 2) }]
})

async function runMainTool(name: string, args: Record<string, unknown>, deps: McpDeps): Promise<ToolOut> {
  const win = deps.getWin()
  switch (name) {
    case 'screenshot': {
      if (!win || win.isDestroyed()) throw new Error('no app window')
      let img = await win.webContents.capturePage()
      const maxW = Number(args['maxWidth']) || 1400
      if (img.getSize().width > maxW) img = img.resize({ width: maxW })
      return { content: [{ type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }] }
    }
    case 'logs': {
      const level = String(args['level'] ?? 'all')
      const contains = args['contains'] ? String(args['contains']) : ''
      const limit = Math.max(1, Number(args['limit']) || 100)
      let out = logs.filter((l) =>
        level === 'all' ? true : level === 'warn' ? l.level === 'warn' || l.level === 'error' : l.level === 'error'
      )
      if (contains) out = out.filter((l) => l.msg.includes(contains))
      out = out.slice(-limit)
      if (args['clear']) logs.length = 0
      return text(
        out.map((l) => `${new Date(l.t).toISOString().slice(11, 23)} [${l.level}] ${l.msg}`).join('\n') ||
          '(no log lines)'
      )
    }
    case 'audio_devices':
      return text(deps.listDevices())
    case 'audio_inputs':
      return text(deps.listInputs ? deps.listInputs() : { devices: [], defaultInput: 0 })
    case 'return_start': {
      if (!deps.returnIn) throw new Error('return input is not available')
      const syn = args['synthetic']
      return text(
        deps.returnIn.start({
          deviceId: args['deviceId'] !== undefined ? Number(args['deviceId']) : undefined,
          deviceName: typeof args['deviceName'] === 'string' ? args['deviceName'] : undefined,
          delayMs: args['delayMs'] !== undefined ? Number(args['delayMs']) : undefined,
          synthetic: syn === 'impulse' ? 'impulse' : syn === 'sine' || syn === true || syn === 'true' ? 'sine' : false,
          driftPpm: args['driftPpm'] !== undefined ? Number(args['driftPpm']) : undefined
        })
      )
    }
    case 'return_stop':
      if (!deps.returnIn) throw new Error('return input is not available')
      return text(deps.returnIn.stop())
    case 'return_status':
      if (!deps.returnIn) return text({ running: false, mode: 'off' })
      if (args['delayMs'] !== undefined) return text(deps.returnIn.setDelayMs(Number(args['delayMs'])))
      return text(deps.returnIn.status())
    case 'vst_listen': {
      const plugin = String(args['plugin'] ?? '')
      if (!/\.vst3$/i.test(plugin)) throw new Error('plugin must be a .vst3 path')
      if (!deps.vst) throw new Error('VST bridge is not available')
      return text(await deps.vst.listen(plugin))
    }
    case 'vst_note': {
      if (!deps.vst) throw new Error('VST bridge is not available')
      const key = Math.max(0, Math.min(127, Number(args['key']) | 0))
      const vel = Math.max(1, Math.min(127, Number(args['vel']) || 100))
      const dur = Math.max(10, Math.min(10000, Number(args['durMs']) || 500))
      const ch = Math.max(1, Math.min(16, Number(args['channel']) | 0 || 1)) - 1
      const t = performance.timeOrigin + performance.now()
      deps.vst.midi([
        { t, st: 0x90 | ch, d1: key, d2: vel },
        { t: t + dur, st: 0x80 | ch, d1: key, d2: 0 }
      ])
      return text({ key, vel, durMs: dur })
    }
    case 'vst_status':
      return text(deps.vst ? deps.vst.status() : { listening: false })
    case 'vst_stop':
      deps.vst?.stop()
      return text('stopped')
    case 'ops_log': {
      const limit = Math.min(100, Math.max(1, Number(args['limit']) || 20))
      const kind = args['kind'] === 'turn' || args['kind'] === 'tool' ? String(args['kind']) : 'all'
      if (!opsLogReader) return text({ entries: [], note: 'operation log is not available' })
      return text({ entries: await opsLogReader(limit, kind) })
    }
    case 'skills_list': {
      const all = skillsReader ? await skillsReader() : []
      return text({ skills: all.map((s) => ({ name: s.name, description: s.description, source: s.source })) })
    }
    case 'skill_get': {
      const all = skillsReader ? await skillsReader() : []
      const s = findSkill(all, args['name'])
      if (!s) throw new Error(`no skill "${String(args['name'])}" (skills: ${all.map((x) => x.name).join(', ') || 'none'})`)
      return text(`# skill: ${s.name} (${s.source})\n\n${s.body}`)
    }
    case 'app_reload':
      win?.webContents.reload()
      return text('reloading')
    case 'project_save_file': {
      const path = String(args['path'] ?? '')
      if (!path.toLowerCase().endsWith('.json')) throw new Error('path must end in .json')
      const proj = await callRenderer(win, 'project_get', {})
      await writeFile(path, JSON.stringify(proj, null, 2), 'utf8')
      return text({ saved: path })
    }
    case 'project_load_file': {
      const path = String(args['path'] ?? '')
      if (!path.toLowerCase().endsWith('.json')) throw new Error('path must end in .json')
      const proj = JSON.parse(await readFile(path, 'utf8'))
      return text(await callRenderer(win, 'project_load', { project: proj }))
    }
  }
  throw new Error(`unknown main tool ${name}`)
}

/** The tool table, for the built-in AI agent (src/main/ai.ts) — same tools, same dispatch as the MCP server. */
export const MCP_TOOL_SPECS: readonly Pick<ToolSpec, 'name' | 'description' | 'inputSchema'>[] = TOOLS

/** One executed tool call, as seen at the single place every call goes through (any AI, any backend). */
export type CallOrigin = 'agent' | 'external' | 'internal'

export interface ToolCallRecord {
  t: number
  /** Who made the call: the built-in assistant, another MCP client (e.g. Claude Code), or the app itself. */
  origin: CallOrigin
  name: string
  args: Record<string, unknown>
  ok: boolean
  ms: number
  error?: string
}

let toolHook: ((r: ToolCallRecord) => void) | null = null
let opsLogReader: ((limit: number, kind: string) => Promise<unknown[]>) | null = null
let skillsReader: (() => Promise<Skill[]>) | null = null

/** Where `skills_list` / `skill_get` read the skills from. */
export function setSkillsReader(fn: (() => Promise<Skill[]>) | null): void {
  skillsReader = fn
}

/** Observe every executed tool call (the operation log and the per-turn trace hang off this). */
export function setToolHook(fn: ((r: ToolCallRecord) => void) | null): void {
  toolHook = fn
}
/** Where the `ops_log` tool reads the operation log from. */
export function setOpsLogReader(fn: ((limit: number, kind: string) => Promise<unknown[]>) | null): void {
  opsLogReader = fn
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: McpDeps,
  origin: CallOrigin = 'external'
): Promise<ToolOut> {
  const spec = TOOLS.find((t) => t.name === name)
  if (!spec) throw new Error(`unknown tool: ${name}`)
  if (origin === 'agent' && (name === 'stems_export' || name === 'mixdown_export') && 'folder' in args) args = { ...args, folder: undefined }
  const t0 = Date.now()
  let out: ToolOut
  try {
    out = spec.where === 'main' ? await runMainTool(name, args, deps) : text(await callRenderer(deps.getWin(), name, args))
  } catch (err) {
    out = { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true }
  }
  try {
    const first = out.content[0]
    toolHook?.({
      t: t0,
      origin,
      name,
      args,
      ok: !out.isError,
      ms: Date.now() - t0,
      ...(out.isError && first && first.type === 'text' ? { error: first.text.slice(0, 300) } : {})
    })
  } catch {
    /* a logging problem must never break a tool call */
  }
  return out
}

interface RpcReq {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

async function handleRpc(req: RpcReq, deps: McpDeps, origin: CallOrigin): Promise<unknown | null> {
  const ok = (result: unknown): unknown => ({ jsonrpc: '2.0', id: req.id, result })
  const fail = (code: number, message: string): unknown => ({ jsonrpc: '2.0', id: req.id, error: { code, message } })
  if (req.id === undefined) return null // notification
  switch (req.method) {
    case 'initialize':
      return ok({
        protocolVersion: String(req.params?.['protocolVersion'] ?? '2025-03-26'),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'awaker-daw', version: '0.0.1' },
        instructions:
          'Drives the running Awaker DAW. Regression pattern: project_load → set params (track_set / strip_set / insert_set / master_set) → bounce → compare stats. Use screenshot / ui_* for UI checks and logs for console errors.'
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const name = String(req.params?.['name'] ?? '')
      const args = (req.params?.['arguments'] as Record<string, unknown> | undefined) ?? {}
      return ok(await callTool(name, args, deps, origin))
    }
    default:
      return fail(-32601, `method not found: ${req.method}`)
  }
}

function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export interface McpServerOpts {
  /** Require `Authorization: Bearer <token>` (the app-launched agent's private server). */
  token?: string
  /** Show this server's URL next to the AI button (only the dev server `DAW_MCP=1` does). */
  publish?: boolean
}

export function startMcpServer(port: number, deps: McpDeps, opts: McpServerOpts = {}): Server {
  // the private server (token) is the one the assistant the app starts itself talks to
  const origin: CallOrigin = opts.token ? 'agent' : 'external'
  const server = createServer(async (req, res) => {
    const send = (code: number, body?: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body, jsonSafe))
    }
    try {
      const host = (req.headers.host ?? '').toLowerCase()
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'bad host' })
      if (req.headers.origin) return send(403, { error: 'browser origins are not allowed' })
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { error: 'unauthorized' })
      if (req.url !== '/mcp') return send(404, { error: 'POST /mcp' })
      if (req.method !== 'POST') return send(405, { error: 'POST only' })
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return send(415, { error: 'content-type must be application/json' })
      }
      const msg = JSON.parse(await readBody(req)) as RpcReq | RpcReq[]
      if (Array.isArray(msg)) {
        const outs = (await Promise.all(msg.map((m) => handleRpc(m, deps, origin)))).filter((o) => o !== null)
        return outs.length ? send(200, outs) : send(202)
      }
      const out = await handleRpc(msg, deps, origin)
      return out === null ? send(202) : send(200, out)
    } catch (err) {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: String((err as Error).message) } })
    }
  })
  const url = `http://127.0.0.1:${port}/mcp`
  if (opts.publish !== false) mcpUrl = url
  server.listen(port, '127.0.0.1', () => console.log(`[mcp] listening on ${url}${opts.token ? ' (token)' : ''}`))
  server.on('error', (err) => console.error('[mcp] server error:', err))
  return server
}

/**
 * A private MCP server for the agent the app launches itself: random free port on 127.0.0.1 and a random
 * bearer token, so only the process we start can drive the app. Resolves with how to reach it.
 */
export async function startPrivateMcp(deps: McpDeps): Promise<{ url: string; token: string; close(): void }> {
  const token = randomBytes(24).toString('hex')
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 49152 + Math.floor(Math.random() * (65535 - 49152))
    const server = startMcpServer(port, deps, { token, publish: false })
    const ok = await new Promise<boolean>((resolve) => {
      server.once('listening', () => resolve(true))
      server.once('error', () => resolve(false))
    })
    if (ok) return { url: `http://127.0.0.1:${port}/mcp`, token, close: () => server.close() }
    server.close()
  }
  throw new Error('no free port for the private MCP server')
}
