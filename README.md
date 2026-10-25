# Awaker DAW over GPU

GPGPU-oriented DAW (dev release). All audio sample and waveform data lives in
WebGPU buffers (VRAM); the CPU only orchestrates. Playback goes
tracks → GPGPU mix → stereo master → native output (RtAudio / ASIO / WASAPI) from
the Electron main process.

> **Status: development preview (v0.1.0-dev.1), source release.** APIs, file formats and UI may change
> without notice.

## Highlights

- **Full-GPU audio.** Samples live in VRAM, and the mix, channel strips, inserts,
  sample-rate conversion and waveform peaks all run as WebGPU compute. The CPU only
  schedules blocks and does device I/O. DSP that is expensive on a CPU is cheap here:
  an early measurement (RTX 3060 Ti, 8 GB) played 24 tracks at 96 kHz at ~7 % GPU
  load. VRAM capacity, not compute, is the practical limit today (see DEVELOP.md).
- **Built for AI from the start.** An opt-in, localhost-only MCP server
  (`npm run dev:mcp`) lets an AI drive the running app: edit the project, move faders
  and plugin parameters, control transport and recording, render an offline bounce and
  read level / LUFS numbers, take screenshots and read the console. That makes
  numeric regression checks and "have the AI mix it" workflows possible.
- **Cubase in, Awaker finishes.** Import a DAWproject exported from Cubase 14+ (tracks, clips,
  fades, volume / pan, MIDI) — MIDI tracks play through a built-in GPU synth — and export one back.
  MIDI files, a piano roll, MIDI in / out and a control surface (MCU) are supported too.
- **Instrument tracks, rendered on the GPU.** A MIDI track can be played by a built-in instrument that renders its
  notes straight into VRAM (no CPU sample array); the result is an ordinary audio source, so the channel strip,
  inserts, fader and mix apply as for any track. Only the notes and the instrument's parameters are saved; the audio is
  rendered again when the project loads or a note changes. Instruments (swap one for another and the notes, strip and
  inserts stay): **Simple Synth** (two oscillators plus a sub, band-limited saw / square, ADSR, low-pass), **FM Synth**
  (four operators with a routing matrix, 18 factory presets, click / pitch-punch / index macros, aimed at crisp
  transients), **EarlySynth** (the first FM synth, kept frozen as it was) and a **Drum Machine** (22 analogue-style
  drum and hand-percussion voices — synthesised, not sampled — with a step sequencer and preset patterns). Edit notes in
  the piano roll, import / export Standard MIDI Files, record from a MIDI keyboard, or send a track's notes out to a
  hardware or software synth. The voices are closed-form per frame, so the same kernels can later be driven block by
  block for live playing.
- **AI mix.** *AI MIX* (transport bar) asks the AI you connected to bring every track to a working level
  (about -18 dBFS RMS), tame what sticks out with the channel-strip compressors, and match the song's
  long-term average spectrum to a genre curve or to a reference song — from numbers the app measures
  (`track_levels`, `spectrum_analyze`), not from guesses. The AI is yours: Claude Code, Gemini, Ollama or any
  OpenAI-compatible server (Options → AI); no account or key is built in. Detailed instructions the AI follows
  are plain `skills/*/SKILL.md` files you can read and override.
- **Stems and mixdown.** Group channels (buses), stems by track name, per-track colours; File → Export →
  Stems… / Mixdown… (24-bit WAV by default, 48 kHz selectable).
- **Native output.** Playback goes through RtAudio (WASAPI) in the main package, not Web Audio. ASIO is an optional
  add-on file (see below).
- **External instruments (experimental).** A MIDI track can have no internal sound ("None") and play an outside
  synth through its MIDI output port (use a virtual MIDI port such as loopMIDI; Electron's Web MIDI does not list
  the built-in Windows synth). The synth's audio can come back into the app's *live path* (the same GPU channel strip
  and inserts as a line input) in two ways: a **VST host bridge** — a separate process loads a VST3 instrument and
  returns blocks over a local socket (the protocol is in `src/main/vst-bridge.ts`; the trial host used a GPL library
  and is not part of this repository) — and a **return input**, a second WASAPI input (for example a virtual
  cable's recording side) with drift correction. Only one of the two feeds the live path at a time. Measured: four
  heavy strips at 1024-frame blocks without dropped blocks, and an external Kontakt piano lined up with the built-in
  drums and bass using a −35 ms MIDI out delay. Limits: live-path audio goes to the master only and is not in bounces,
  mixdowns or stems yet; the return input has not been tried with a real virtual cable.

## Requirements

- Windows 10/11 (primary target), a GPU with WebGPU support
- Node.js 20+ and npm
- Optional: the ASIO add-on file and an ASIO driver, for low-latency output

## Building from source

Build it yourself:

```sh
npm install
npm run build:audio  # the audio module (see below); needs MSYS2 UCRT64 g++, no MSVC / CMake
npm run dev          # run with hot reload
npm run package      # optional: a portable Windows build + zip in dist/ (for your own use)
```

**Audio module** (`native/audio`): RtAudio (WASAPI) + [cwASIO](https://github.com/s13n/cwASIO) (an independent,
MIT-licensed implementation of the ASIO driver API; no Steinberg SDK code) behind a small Node-API layer.
`npm run build:audio` compiles it with MinGW-w64 g++ (install [MSYS2](https://www.msys2.org/) and
`pacman -S mingw-w64-ucrt-x86_64-gcc`, or set `CXX` / `CC`). It produces two files in `native/audio/build`:

- `awaker_audio.node` — WASAPI only (exclusive, then shared). It contains no ASIO code; this is the file the
  main package ships.
- `awaker_audio_asio.node` — the optional **ASIO add-on** (WASAPI + ASIO through cwASIO). It is packaged
  separately (`Awaker-ASIO-addon-<version>-win32-x64.zip`). Put it in the same folder as `Awaker.exe` (or next to
  `awaker_audio.node`) and the app uses ASIO when a pro-audio driver is installed; delete it and the app is WASAPI
  only again. The add-on is provided as is, without warranty; combining it with Awaker is your own responsibility.

ASIO is a trademark of Steinberg Media Technologies GmbH.

Without the module built, the app falls back to the npm package
[audify](https://github.com/almoghamdani/audify) (MIT; optional dependency) if it is installed. Its Windows
binary is built with Steinberg's ASIO host headers — see [NOTICE](NOTICE) before redistributing a build.

## Quick start

```sh
npm install
npm run dev        # development with HMR
npm run typecheck
npm run build
npm run preview    # run the built app
npm run package    # portable Windows build + zip in dist/
```

Note: `npm run dev` / `preview` go through `scripts/run.mjs`, which clears
`ELECTRON_RUN_AS_NODE` (set by some terminals) before launching Electron.

## Documentation

Architecture, design invariants, known pitfalls and the development log are in
[DEVELOP.md](DEVELOP.md) (Japanese).

## Authors

- **TK** — project owner; steers the design and the real-hardware work. [@TK_Developer](https://x.com/TK_Developer)
- **Anthropic Claude** — wrote most of the code, working through Claude Code.
- **Google Gemini** — implemented the return input (`src/main/return-in.ts`), supervised by Claude, working through
  [Incline](https://github.com/TK-Developer-OSS/incline).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

ASIO is a trademark and software of Steinberg Media Technologies GmbH; see [NOTICE](NOTICE).

Copyright 2026 TK <tk.oss.developer@gmail.com>
