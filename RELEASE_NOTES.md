# Awaker DAW over GPU — v0.1.0-dev.1 (development preview, source release)

GPGPU-oriented DAW. All audio sample and waveform data lives in WebGPU buffers (VRAM); the CPU only
orchestrates. Playback goes tracks → GPGPU mix → stereo master → native output (RtAudio, WASAPI; ASIO through an optional add-on).

> **Development preview.** File formats, the UI and the tools may change without notice.
> Binaries are attached to this release as two separate files (see "Downloads"), or build it yourself
> (see "Building from source" in the README).

## Downloads

- `Awaker-0.1.0-dev.1-win32-x64.zip` — the portable app. WASAPI output only; it contains no ASIO code.
- `Awaker-ASIO-addon-0.1.0-dev.1-win32-x64.zip` — optional add-on: one file, `awaker_audio_asio.node`
  (cwASIO + RtAudio, MIT licences included).

**Combining the two is your own responsibility.** If you want ASIO, you download the add-on yourself and place
`awaker_audio_asio.node` in the same folder as `Awaker.exe`. The add-on is provided as is, without warranty.
ASIO is a trademark of Steinberg Media Technologies GmbH. Delete the file to go back to WASAPI only.

## Build and run (Windows 10/11, Node.js 20+)

```sh
npm install
npm run build:audio   # the audio modules (WASAPI-only + the ASIO add-on), built with MSYS2 UCRT64 g++
npm run dev
```

Needs a GPU with WebGPU support. The main package outputs through WASAPI and contains no ASIO code.
ASIO is a separate add-on file, `awaker_audio_asio.node` (`Awaker-ASIO-addon-*.zip`): place it in the same
folder as `Awaker.exe` and Awaker uses ASIO when a pro-audio driver is installed; remove it to go back to WASAPI.
The add-on reaches ASIO drivers through cwASIO, an independent MIT implementation of the ASIO driver API, so this
repository contains no code from Steinberg's ASIO SDK (see NOTICE). The add-on is provided as is, without warranty.

## What is in this preview

- **Full-GPU audio**: mix, channel strips, inserts, sample-rate conversion and waveform peaks run as WebGPU compute.
- **Mixer**: channel strips (trim, saturation, HPF, 4-band EQ, compressor), 8 insert slots per channel (drag a
  plug-in to reorder or move it to another channel), group channels (buses), per-track colours.
- **Insert plug-ins**: 5-band EQ, tube EQ, enhancer, reverb, delay; bus compressor and maximizer on the master.
- **Import / export**: DAWproject import and export, MIDI files, stems (by track name or group), mixdown
  (you choose the file name, bit depth and sample rate).
- **AI mix** (opt-in, bring your own AI): *AI MIX* in the transport bar brings every track to about -18 dBFS RMS,
  tames what sticks out with the strip compressors, and matches the song's long-term average spectrum to a
  genre curve or a reference song — from measurements the app makes. Connect Claude Code, Gemini, Ollama or any
  OpenAI-compatible server in Options → AI. No account or key is built in. The instructions the AI follows are
  plain `SKILL.md` files that you can read and override.
- **Built-in MCP server** (localhost only, off by default; set `DAW_MCP=1`) so an AI can drive the running app.

## Known limits

- Windows only. The icon is a temporary one.
- VRAM capacity, not compute, is the practical limit (see DEVELOP.md).
- Phase and stereo width are not measured by the AI mix.

## Licence and credits

Apache License 2.0. Copyright 2026 TK — https://x.com/TK_Developer.
ASIO is a trademark of Steinberg Media Technologies GmbH.
