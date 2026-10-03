// Copyright 2026 @TK_Developer <tk.oss.developer@gmail.com> (https://x.com/TK_Developer)
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

// WGSL kept as string literals so no extra Vite loader config is needed.
// Split into its own file to keep pipeline code readable.

/**
 * Peak reduction: each invocation collapses `samplesPerPeak` frames into a
 * (min, max) pair used for waveform drawing at arbitrary zoom. This is the
 * "waveform data lives on the GPU" core — no CPU-side peak cache.
 */
export const PEAKS_WGSL = /* wgsl */ `
struct Params {
  totalFrames : u32,
  samplesPerPeak : u32,
  peakCount : u32,
  _pad : u32,
};

@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var<storage, read> samples : array<f32>;
@group(0) @binding(2) var<storage, read_write> peaks : array<vec2<f32>>;

@compute @workgroup_size(64)
fn main(
  @builtin(global_invocation_id) gid : vec3<u32>,
  @builtin(num_workgroups) nw : vec3<u32>
) {
  let stride = nw.x * 64u;
  var i = gid.x;
  loop {
    if (i >= P.peakCount) { break; }

    let start = i * P.samplesPerPeak;
    let end = min(start + P.samplesPerPeak, P.totalFrames);

    var lo : f32 = 1.0;
    var hi : f32 = -1.0;
    var s = start;
    loop {
      if (s >= end) { break; }
      let v = samples[s];
      lo = min(lo, v);
      hi = max(hi, v);
      s = s + 1u;
    }
    if (start >= end) { lo = 0.0; hi = 0.0; }
    peaks[i] = vec2<f32>(lo, hi);

    i = i + stride;
  }
}
`

/**
 * Waveform draw: a line-list with 2 vertices per peak bucket, pulling min/max
 * straight out of the peaks storage buffer. View transform (scroll/zoom) comes
 * from a uniform so panning never re-touches sample data.
 */
export const WAVE_WGSL = /* wgsl */ `
struct View {
  peakCount : u32,     // buckets in the bound source peak buffer
  firstPeak : u32,     // source bucket that local bucket 0 maps to
  peaksPerPixel : f32, // horizontal zoom
  viewportPx : f32,    // canvas width in CSS px
  pxOffset : f32,      // CSS px of local bucket 0, relative to the viewport left
  highlight : f32,     // >0.5 = this clip is picked in the right-pane list
  clipLeftPx : f32,    // picked-clip fill: left / right edge in CSS px from viewport left
  clipRightPx : f32,
};

@group(0) @binding(0) var<uniform> V : View;
@group(0) @binding(1) var<storage, read> peaks : array<vec2<f32>>;

// ---- picked-clip background fill (two triangles spanning the clip's x range) ----
@vertex
fn bgvs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  var xs = array<f32, 6>(V.clipLeftPx, V.clipRightPx, V.clipLeftPx, V.clipRightPx, V.clipRightPx, V.clipLeftPx);
  var ys = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let ndcX = (xs[vi] / V.viewportPx) * 2.0 - 1.0;
  return vec4<f32>(ndcX, ys[vi], 0.0, 1.0);
}

@fragment
fn bgfs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.60, 0.90, 0.78, 1.0); // pale mint bar behind a picked clip
}

// ---- waveform line-list ----
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) shade : f32,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VsOut {
  let bucket = vi / 2u;
  let isMax = (vi & 1u) == 1u;
  let peakIndex = V.firstPeak + bucket;

  var mm = vec2<f32>(0.0, 0.0);
  if (peakIndex < V.peakCount) { mm = peaks[peakIndex]; }

  let px = V.pxOffset + f32(bucket) / V.peaksPerPixel;
  let ndcX = (px / V.viewportPx) * 2.0 - 1.0;
  var y = mm.x;
  if (isMax) { y = mm.y; }
  let ndcY = clamp(y, -1.0, 1.0) * 0.92;

  var out : VsOut;
  out.pos = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.shade = 1.0;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  // Default: bright emerald wave over the dark lane background.
  // Picked: near-black wave over the pale mint fill drawn by bgvs/bgfs.
  let base = vec3<f32>(0.204, 0.827, 0.600);
  let col = select(base, vec3<f32>(0.03, 0.06, 0.05), V.highlight > 0.5);
  return vec4<f32>(col, 1.0) * in.shade;
}
`

/**
 * Demo tone generator — writes a calm sustained chord directly into a sample
 * buffer on the GPU so the "load something" path exists without touching disk.
 * Deliberately a soft, static major triad (fade in/out, gentle tremolo) — NOT a
 * rising sweep, which can resemble an emergency-alert signal.
 */
export const TONE_WGSL = /* wgsl */ `
struct Params {
  totalFrames : u32,
  sampleRate : f32,
  rootHz : f32,
  _unused : f32,
  detune : f32,   // per-channel multiplier for a bit of stereo width
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
};

@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var<storage, read_write> samples : array<f32>;

const PI : f32 = 3.14159265;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.totalFrames) { return; }
  let t = f32(i) / P.sampleRate;
  let dur = f32(P.totalFrames) / P.sampleRate;

  let f0 = P.rootHz * P.detune;
  // Major triad: root, major third (5/4), perfect fifth (3/2).
  var s = sin(2.0 * PI * f0 * t);
  s = s + 0.7 * sin(2.0 * PI * f0 * 1.25 * t);
  s = s + 0.6 * sin(2.0 * PI * f0 * 1.5 * t);
  s = s / 2.3;

  // Smooth fade in/out + slow tremolo — nothing that reads as an alarm.
  let fade = clamp(min(t, dur - t) / 0.15, 0.0, 1.0);
  let trem = 0.9 + 0.1 * sin(2.0 * PI * 4.0 * t);
  samples[i] = s * fade * trem * 0.5;
}
`

/**
 * Sample-rate conversion on the GPU (load time). Band-limited **polyphase FIR**:
 * a windowed-sinc low-pass prototype is split into `phases` fractional-delay
 * sub-filters of `taps` coefficients each (computed on the CPU in
 * `resample-gpu.ts`, uploaded once). Each output frame picks the nearest phase
 * and convolves `taps` input samples around its source position.
 *
 * Unlike the old Catmull-Rom path this does NOT overshoot on transients (a cubic
 * spline inflates hot masters ~+1 dB → clipped meters); each phase row sums to 1
 * so DC gain is exactly unity. One dispatch per channel; input samples live in a
 * scratch buffer that's freed straight after.
 */
export const RESAMPLE_WGSL = /* wgsl */ `
struct RP {
  outLen : u32,
  inLen : u32,
  phases : u32,
  taps : u32,
  step : f32,   // input samples advanced per output frame (inRate / outRate)
  _p0 : f32, _p1 : f32, _p2 : f32,
};
@group(0) @binding(0) var<uniform> P : RP;
@group(0) @binding(1) var<storage, read> src : array<f32>;
@group(0) @binding(2) var<storage, read> coeff : array<f32>; // phases * taps
@group(0) @binding(3) var<storage, read_write> dst : array<f32>;

@compute @workgroup_size(256)
fn main(
  @builtin(global_invocation_id) gid : vec3<u32>,
  @builtin(num_workgroups) nw : vec3<u32>
) {
  let half = i32(P.taps / 2u) - 1;
  let last = i32(P.inLen) - 1;
  // Grid-stride: a whole file at 192 kHz is tens of millions of frames, far past
  // the per-dimension workgroup limit, so each thread walks several outputs.
  let stride = nw.x * 256u;
  var i = gid.x;
  loop {
    if (i >= P.outLen) { break; }

    let pos = f32(i) * P.step;
    let base = i32(floor(pos));
    let frac = pos - floor(pos);
    var ph = u32(frac * f32(P.phases) + 0.5);
    if (ph >= P.phases) { ph = P.phases - 1u; }
    let row = ph * P.taps;

    var acc = 0.0;
    for (var k = 0u; k < P.taps; k = k + 1u) {
      let n = clamp(base - half + i32(k), 0, last);
      acc = acc + coeff[row + k] * src[u32(n)];
    }
    dst[i] = acc;

    i = i + stride;
  }
}
`

/**
 * Master bus: mixes N input tracks (mono or stereo, planar) → **planar** stereo
 * master block (outL / outR). gain + pan/balance + master gain. The host runs
 * this once per track into the same `outP` buffer: track 0 writes, tracks 1..N
 * accumulate (`accumulate != 0`). Each pass is its own compute pass so the
 * read-modify-write of `outP` is ordered.
 *
 * Planar output so insert effects (see REVERB_WGSL) can process L/R in place
 * before a final interleave pass.
 */
export const MASTER_WGSL = /* wgsl */ `
struct Params {
  blockFrames : u32,
  startFrame : u32,
  totalFrames : u32,
  channelCount : u32,   // 1 = mono, 2 = stereo
  accumulate : u32,     // 0 = write outP, else add into outP
  gain : f32,
  panL : f32,           // mono: constant-power pan gains; stereo: per-side trim
  panR : f32,
  masterGain : f32,
};

@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var<storage, read> chL : array<f32>;
@group(0) @binding(2) var<storage, read> chR : array<f32>;  // == chL when mono
@group(0) @binding(3) var<storage, read_write> outP : array<f32>; // planar [L(block) | R(block)]

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.blockFrames) { return; }
  let src = P.startFrame + i;

  var l : f32 = 0.0;
  var r : f32 = 0.0;
  if (src < P.totalFrames) {
    let sl = chL[src];
    if (P.channelCount == 1u) {
      l = sl * P.gain * P.panL;
      r = sl * P.gain * P.panR;
    } else {
      l = sl * P.gain * P.panL;
      r = chR[src] * P.gain * P.panR;
    }
  }
  let outL = l * P.masterGain;
  let outR = r * P.masterGain;
  let jR = P.blockFrames + i;
  if (P.accumulate != 0u) {
    outP[i] = outP[i] + outL;
    outP[jR] = outP[jR] + outR;
  } else {
    outP[i] = outL;
    outP[jR] = outR;
  }
}
`

/**
 * Planar stereo block [L|R] -> interleaved [L0,R0,L1,R1,...] for readback.
 * Also the master output safety clamp: samples handed to the native device are
 * kept in [-1, 1] so track summing / interpolation overshoot / hot source files
 * can't overflow the float→int conversion in RtAudio (which reads as a boost /
 * pegged meters). This is a hard clip on whatever exceeds full scale, not a gain
 * change to in-range audio.
 */
export const INTERLEAVE_WGSL = /* wgsl */ `
struct P { blockFrames : u32 };
@group(0) @binding(0) var<uniform> u : P;
@group(0) @binding(1) var<storage, read> inP : array<f32>;
@group(0) @binding(2) var<storage, read_write> outLR : array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u.blockFrames) { return; }
  outLR[i * 2u] = clamp(inP[i], -1.0, 1.0);
  outLR[i * 2u + 1u] = clamp(inP[u.blockFrames + i], -1.0, 1.0);
}
`

/**
 * Insert reverb — Freeverb (Schroeder/Moorer: 8 parallel damped combs + 4 series
 * allpasses per channel). Prototype: **one GPU thread per channel** running the
 * recurrence serially over the block. That wastes the GPU (feedback loops don't
 * parallelise across samples), but it's the plain, correct algorithm and it
 * proves the "stateful GPU insert in the chain" mechanism. Delay lines / filter
 * state live in persistent GPU buffers owned by the insert.
 *
 * cfg (storage, u32):
 *   [0..7]   comb lengths           [8..15]  comb offsets (within a channel)
 *   [16..19] allpass lengths        [20..23] allpass offsets
 *   [24] sum(comb lengths)          [25] sum(allpass lengths)
 * No Freeverb stereo-spread (equal L/R delay lengths); stereo still comes from
 * the differing L/R master signal. Good enough for the prototype.
 */
export const REVERB_WGSL = /* wgsl */ `
struct Fx {
  blockFrames : u32,
  baseIndex : u32,     // monotonic sample index since playback start
  feedback : f32,      // comb feedback  (roomsize)
  damp1 : f32,
  damp2 : f32,
  apFeedback : f32,
  wet : f32,
  dry : f32,
};
@group(0) @binding(0) var<uniform> P : Fx;
@group(0) @binding(1) var<storage, read> cfg : array<u32>;
@group(0) @binding(2) var<storage, read_write> sig : array<f32>;     // [L(block) | R(block)]
@group(0) @binding(3) var<storage, read_write> combBuf : array<f32>; // [ch0 combs | ch1 combs]
@group(0) @binding(4) var<storage, read_write> apBuf : array<f32>;   // [ch0 aps  | ch1 aps]
@group(0) @binding(5) var<storage, read_write> lpf : array<f32>;     // ch*8 + comb -> filterstore

const INPUT_GAIN : f32 = 0.015;

@compute @workgroup_size(2)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ch = gid.x;
  if (ch >= 2u) { return; }

  let sigBase = ch * P.blockFrames;
  let combChBase = ch * cfg[24];
  let apChBase = ch * cfg[25];

  for (var i = 0u; i < P.blockFrames; i = i + 1u) {
    let dry = sig[sigBase + i];
    let x = dry * INPUT_GAIN;

    var acc = 0.0;
    for (var k = 0u; k < 8u; k = k + 1u) {
      let len = cfg[k];
      let pos = combChBase + cfg[8u + k] + ((P.baseIndex + i) % len);
      let y = combBuf[pos];
      let li = ch * 8u + k;
      let fs = y * P.damp2 + lpf[li] * P.damp1;
      lpf[li] = fs;
      combBuf[pos] = x + fs * P.feedback;
      acc = acc + y;
    }

    var s = acc;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let len = cfg[16u + k];
      let pos = apChBase + cfg[20u + k] + ((P.baseIndex + i) % len);
      let y = apBuf[pos];
      apBuf[pos] = s + y * P.apFeedback;
      s = y - s;
    }

    sig[sigBase + i] = dry * P.dry + s * P.wet;
  }
}
`

/**
 * Gather ONE clip's overlap with the current timeline block, **accumulating** into
 * the lane's planar `[L(block) | R(block)]` slice (mono is duplicated to both
 * sides). The host pre-clears the slice, then dispatches this once per clip that
 * touches the block; overlapping clips (crossfades) sum for free. A per-clip
 * fade-in / fade-out envelope is applied here so fades are non-destructive.
 *
 * `outP` is bound to the lane's slice only, so `arrayLength(&outP) / 2` is
 * `blockFrames`. First stage of the per-lane path: clip-gather → channel strip →
 * inserts → mix-add.
 */
export const CLIPGATHER_WGSL = /* wgsl */ `
struct P {
  count : u32,          // frames this clip writes into the block
  dstOffset : u32,      // first frame index within the [L|R] slice
  srcStart : u32,       // first source frame to read
  srcTotal : u32,       // source length (read guard)
  channelCount : u32,
  clipLocalBase : u32,  // clip-local frame of the first written sample
  clipLen : u32,
  fadeIn : u32,
  fadeOut : u32,
  fadeInShape : u32,    // 0 lin | 1 equal-power | 2 log (t*t)
  fadeOutShape : u32,
  _pad0 : u32,
  gain : f32,
  _pad1 : f32, _pad2 : f32, _pad3 : f32,
};
@group(0) @binding(0) var<uniform> u : P;
@group(0) @binding(1) var<storage, read> chL : array<f32>;
@group(0) @binding(2) var<storage, read> chR : array<f32>;  // == chL when mono
@group(0) @binding(3) var<storage, read_write> outP : array<f32>; // one lane's [L|R] slice

fn fadeShape(t : f32, mode : u32) -> f32 {
  let x = clamp(t, 0.0, 1.0);
  if (mode == 1u) { return sin(x * 1.5707963); }   // equal-power
  if (mode == 2u) { return x * x; }                 // log-ish
  return x;                                         // linear
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let k = gid.x;
  if (k >= u.count) { return; }
  let blockFrames = arrayLength(&outP) / 2u;

  let s = u.srcStart + k;
  var l = 0.0;
  var r = 0.0;
  if (s < u.srcTotal) {
    l = chL[s];
    r = select(l, chR[s], u.channelCount == 2u);
  }

  // clip-local position → fade envelope
  let p = u.clipLocalBase + k;
  var env = 1.0;
  if (u.fadeIn > 0u && p < u.fadeIn) {
    env = env * fadeShape(f32(p) / f32(u.fadeIn), u.fadeInShape);
  }
  if (u.fadeOut > 0u && p < u.clipLen && p >= u.clipLen - u.fadeOut) {
    env = env * fadeShape(f32(u.clipLen - p) / f32(u.fadeOut), u.fadeOutShape);
  }

  let g = u.gain * env;
  let di = u.dstOffset + k;
  outP[di] = outP[di] + l * g;
  outP[blockFrames + di] = outP[blockFrames + di] + r * g;
}
`

/**
 * Mix one track's processed planar block (shared scratch `[L|R]`) into the planar
 * master with gain + constant-power pan + master gain. Track 0 writes, the rest
 * accumulate (`accumulate != 0`). Separate compute pass per track so the RMW of
 * the master buffer stays ordered — same contract as the old MASTER_WGSL.
 */
export const MIXADD_WGSL = /* wgsl */ `
struct P {
  blockFrames : u32,
  startFrame : u32,
  totalFrames : u32,
  channelCount : u32,
  accumulate : u32,
  gain : f32, panL : f32, panR : f32, masterGain : f32,
};
@group(0) @binding(0) var<uniform> u : P;
@group(0) @binding(1) var<storage, read> inP : array<f32>;         // [L|R] scratch
@group(0) @binding(2) var<storage, read_write> outP : array<f32>;  // [L|R] master

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u.blockFrames) { return; }
  let jR = u.blockFrames + i;
  let l = inP[i] * u.gain * u.panL * u.masterGain;
  let r = inP[jR] * u.gain * u.panR * u.masterGain;
  if (u.accumulate != 0u) {
    outP[i] = outP[i] + l;
    outP[jR] = outP[jR] + r;
  } else {
    outP[i] = l;
    outP[jR] = r;
  }
}
`

/**
 * Built-in per-track **channel strip**, fixed order, in place on each track's
 * `[L|R]` slice of the big post-gather scratch:
 *   trim → saturation (one knob, mode = Drive: 12AX7 triode + feedback FET comp |
 *   Color: transformer + Class-A) + tiny per-instance decorrelation allpass →
 *   HPF → analogue-console 4-band EQ → compressor (stereo-linked)
 *
 * **Batched**: one invocation per track (global_invocation_id.x), not one thread
 * for the whole strip. The per-sample chain is still serial within a track (the
 * biquads / envelope followers are recursive) but every track now runs in
 * parallel across the warp instead of back-to-back on a single lane — the strip
 * was N serial `@workgroup_size(1)` passes, one per track, and turning saturation
 * on across a full session pegged the GPU. `Pall[t]` / `st[t*64..]` are copied
 * into private `P` / `s` so the hot loop only touches storage for the signal.
 * State offsets within a track's 64-f32 slice (`s`, mirrors `st[t*64 + n]`):
 *   per channel ch: base = ch*24 →
 *     [0]  Drive prevOut (feedback)  [1] Drive env  [2] Drive HF-emph LP  [3] Drive DC-block LP
 *     [4..7]  HPF biquad (x1,x2,y1,y2)      [8..11]  EQ band 0
 *     [12..15] EQ band 1  [16..19] EQ band 2  [20..23] EQ band 3
 *   shared: [48..51] Color one-poles ch0 (dc / bloom / emphasis / out)
 *           [52..55] Color one-poles ch1
 *           [56..57] per-instance decorrelation allpass z (ch0 / ch1)
 *           [58] comp detector env     [59] comp gain (reset to 1.0)  ([60..63] free)
 */
export const CHANNELSTRIP_WGSL = /* wgsl */ `
struct CS {
  slotOn : u32,   // 1 = process this track's slot (host zeroes the rest of the array)
  flags : u32,
  trimLin : f32,
  // DRIVE mode — 12AX7 triode grit + feedback FET compressor ("1176 all-buttons").
  dPre : f32,        // pre-gain into the triode (knob)
  dEmphA : f32,      // HF pre-emphasis one-pole coeff (~1.8 kHz) — bright/ragged grit
  dEmph : f32,       // HF pre-emphasis amount
  dTriG : f32,       // triode drive gain (on top of dPre)
  dBias : f32,       // triode asymmetry -> 2nd harmonic
  dBiasT : f32,      // tanh(dBias), precomputed (DC removal)
  dThr : f32,        // compressor threshold (linear)
  dRatioInv : f32,   // 1/ratio  (gr = over^(dRatioInv-1))
  dAtt : f32,        // attack coeff (fast; transient front bites through)
  dRelSlow : f32,    // release coeff, light GR
  dRelFast : f32,    // release coeff, heavy GR (program-dependent pump)
  dMakeup : f32,     // output makeup (numeric level match, feeds the feedback loop)
  dDensity : f32,    // final surge soft-clip
  dOut : f32,        // final 1:1 output trim — applied AFTER the feedback tap so
                     // the compressor loop can't compensate it (real level match)
  dLimT : f32,       // headroom limiter threshold (linear) — soft-tops transients
  _dpad : f32,
  hpfB0 : f32, hpfB1 : f32, hpfB2 : f32, hpfA1 : f32, hpfA2 : f32,
  eq0B0 : f32, eq0B1 : f32, eq0B2 : f32, eq0A1 : f32, eq0A2 : f32,
  eq1B0 : f32, eq1B1 : f32, eq1B2 : f32, eq1A1 : f32, eq1A2 : f32,
  eq2B0 : f32, eq2B1 : f32, eq2B2 : f32, eq2A1 : f32, eq2A2 : f32,
  eq3B0 : f32, eq3B1 : f32, eq3B2 : f32, eq3A1 : f32, eq3A2 : f32,
  // --- Color saturation mode (transformer + Class-A). Reuses the 7 words the
  //     retired "nasal" stage held so threshLin below stays at offset 51. ---
  colLoA : f32,     // LF "bloom" one-pole coeff (~90 Hz)
  colBloom : f32,   // LF bloom depth (amount-scaled)
  colEmphA : f32,   // HF pre-emphasis one-pole coeff (~2.5 kHz)
  colEmph : f32,    // HF pre-emphasis amount
  colG : f32,       // Class-A drive gain (linear)
  colBias : f32,    // asymmetry bias -> 2nd harmonic
  colBiasT : f32,   // tanh(colBias), precomputed
  threshLin : f32,
  ratioInv : f32,
  attCoef : f32,
  relCoef : f32,
  makeupLin : f32,
  _dpad2 : f32,  // (was a drive param; kept so offsets above stay put)
  // --- appended (existing offsets above unchanged) ---
  colShoulder : f32,  // Color output hard-shoulder blend
  colOutA : f32,      // Color output HF rolloff one-pole coeff (kept high = sparkle)
  colMakeup : f32,    // Color output level compensation
  colVarAp : f32,     // per-instance magnitude-flat allpass coeff (stack decorrelation)  [word 60]
  // Pad to 64 words / 256 B so the array<CS> element stride matches the host's
  // STRIP_WORDS (61 real words would give a 244 B stride and misalign track 1+).
  _tail0 : f32, _tail1 : f32, _tail2 : f32,
};
struct Batch {
  trackCount : u32,
  blockFrames : u32,
};
@group(0) @binding(0) var<storage, read> Pall : array<CS>;         // per-track params, 64-word (256 B) stride
@group(0) @binding(1) var<storage, read_write> sig : array<f32>;   // all tracks' [L|R] slices, stride 2*blockFrames
@group(0) @binding(2) var<storage, read_write> st : array<f32>;    // all tracks' 64-f32 state slices
@group(0) @binding(3) var<uniform> B : Batch;

// Private copies of this invocation's track slice — the recursive hot loop never
// touches storage except the signal. Helpers below read P exactly as they did
// when it was a uniform binding.
var<private> P : CS;
var<private> s : array<f32, 64>;

const DRIVE    : u32 = 1u;   // saturation stage active (amount > 0)
const HPF      : u32 = 2u;
const EQ       : u32 = 4u;
const SATCOLOR : u32 = 8u;   // saturation mode: set = Color (transformer), clear = Drive (triode + FET comp)
const COMP     : u32 = 16u;

// Direct-form-I biquad; state at s[o..o+3] = x1, x2, y1, y2.
fn bq(o : u32, x : f32, b0 : f32, b1 : f32, b2 : f32, a1 : f32, a2 : f32) -> f32 {
  let x1 = s[o]; let x2 = s[o + 1u]; let y1 = s[o + 2u]; let y2 = s[o + 3u];
  let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
  s[o] = x; s[o + 1u] = x1; s[o + 2u] = y; s[o + 3u] = y1;
  return y;
}

// Headroom limiter — "another 12AX7 stage". Everything below t passes untouched;
// above t the overshoot goes through a tanh knee (slope 1 at t, asymptote 1.0),
// so transients that were poking out fully extended get their heads rounded off
// with a soft triode-ish character instead of running free.
fn softTop(x : f32, t : f32) -> f32 {
  let a = abs(x);
  if (a <= t) { return x; }
  let rounded = t + (1.0 - t) * tanh((a - t) / (1.0 - t));
  return select(-rounded, rounded, x >= 0.0);
}

// DRIVE mode — 12AX7-flavoured triode grit slammed by a feedback FET compressor
// with an extreme "all-buttons" ratio. One knob drives the signal hard into the
// triode: HF pre-emphasis makes the asymmetric clip bright and ragged ("ささくれ"),
// then a very fast, FEEDBACK-detected (previous output sample), program-dependent-
// release compressor levels it — the fast attack lets the transient front bite
// through ("バイト"). For shoving a kick / bass forward.
// State s[b..b+3]: [0] prevOut (feedback det)  [1] env  [2] HF-emphasis LP  [3] DC-block LP
fn driveStage(ch : u32, x : f32) -> f32 {
  let b = ch * 24u;
  var prevOut = s[b];
  var env     = s[b + 1u];
  var emLP    = s[b + 2u];
  var dcLP    = s[b + 3u];

  let xd = x * P.dPre;

  // 12AX7 grit: HF pre-emphasis into an asymmetric triode clip
  emLP = emLP + P.dEmphA * (xd - emLP);
  let pre = xd + P.dEmph * (xd - emLP);
  let grit = tanh(pre * P.dTriG + P.dBias) - P.dBiasT;

  // feedback FET compressor — detector on the PREVIOUS output sample
  let det = abs(prevOut);
  let slam = clamp(det / P.dThr - 1.0, 0.0, 1.0);
  let rel = mix(P.dRelSlow, P.dRelFast, slam);           // faster release the harder it's clamping
  env = env + select(rel, P.dAtt, det > env) * (det - env);
  var gr = 1.0;
  let over = env / P.dThr;
  if (over > 1.0) { gr = pow(over, P.dRatioInv - 1.0); }

  var y = grit * gr * P.dMakeup;

  // DC block (asym clip of low bass leaves an offset) then the "surge" soft-clip
  dcLP = dcLP + 0.0016 * (y - dcLP);
  y = y - dcLP;
  y = y / (1.0 + abs(y) * P.dDensity);

  s[b] = y;              // feedback tap for the next sample (loop regulates to THIS)
  s[b + 1u] = env;
  s[b + 2u] = emLP;
  s[b + 3u] = dcLP;
  y = softTop(y, P.dLimT);   // headroom limiter — top the transients (outside the loop)
  return y * P.dOut;         // 1:1 output trim, outside the loop
}

// ~12 Hz one-pole DC-block coefficient. Fixed (not rate-scaled): across 44.1–192
// kHz the corner only moves 6–24 Hz, inaudible, and it saves a uniform word.
const COL_DC_A : f32 = 0.0016;

// COLOR saturation mode — one-knob transformer + Class-A harmonic stage
// ("Neve-ish"), the alternative to the parallel-multiband Drive mode:
//   DC-block → transformer LF bloom (weight / 2nd on lows) → HF pre-emphasis →
//   asymmetric Class-A drive (bias = 2nd, tanh = 3rd) → output-transformer
//   shoulder, half-direct top (keeps sparkle). Unity at amount 0.
// State s[48 + ch*4 .. +3] = dcLP / bloomLP / emphasisLP / outLP.
fn colorStage(ch : u32, xin : f32) -> f32 {
  let b = 48u + ch * 4u;
  var dcLP = s[b]; var loLP = s[b + 1u]; var emLP = s[b + 2u]; var outLP = s[b + 3u];

  dcLP = dcLP + COL_DC_A * (xin - dcLP);
  let x = xin - dcLP;

  loLP = loLP + P.colLoA * (x - loLP);
  let bloom = x + P.colBloom * (tanh(loLP * 2.0) * 0.5 - loLP);

  emLP = emLP + P.colEmphA * (bloom - emLP);
  let pre = bloom + P.colEmph * (bloom - emLP);

  let a = tanh(pre * P.colG + P.colBias) - P.colBiasT;

  let sh = a / (1.0 + abs(a));
  let bl = mix(a, sh, P.colShoulder);
  outLP = outLP + P.colOutA * (bl - outLP);
  let y = mix(bl, outLP, 0.5);

  s[b] = dcLP; s[b + 1u] = loLP; s[b + 2u] = emLP; s[b + 3u] = outLP;
  return y * P.colMakeup;
}

// First-order magnitude-flat allpass with a tiny per-instance coefficient. Runs
// after whichever saturation mode is active. Inaudible on a solo track; its only
// job is to decorrelate the phase of many stacked copies of the same source so a
// 30-track pile doesn't collapse into one blob. This is NOT component-tolerance
// modelling — just a small fixed coefficient the user never sees or picks.
// State s[56 + ch].
fn satVary(ch : u32, x : f32) -> f32 {
  let zi = 56u + ch;
  let a = P.colVarAp;
  let z = s[zi];
  let y = -a * x + z;
  s[zi] = x + a * y;
  return y;
}

fn chain(ch : u32, xin : f32) -> f32 {
  let b = ch * 24u;
  var x = xin * P.trimLin;
  if ((P.flags & DRIVE) != 0u) {
    if ((P.flags & SATCOLOR) != 0u) { x = colorStage(ch, x); }
    else { x = driveStage(ch, x); }
    x = satVary(ch, x);
  }
  if ((P.flags & HPF) != 0u) { x = bq(b + 4u, x, P.hpfB0, P.hpfB1, P.hpfB2, P.hpfA1, P.hpfA2); }
  if ((P.flags & EQ) != 0u) {
    x = bq(b + 8u,  x, P.eq0B0, P.eq0B1, P.eq0B2, P.eq0A1, P.eq0A2);
    x = bq(b + 12u, x, P.eq1B0, P.eq1B1, P.eq1B2, P.eq1A1, P.eq1A2);
    x = bq(b + 16u, x, P.eq2B0, P.eq2B1, P.eq2B2, P.eq2A1, P.eq2A2);
    x = bq(b + 20u, x, P.eq3B0, P.eq3B1, P.eq3B2, P.eq3A1, P.eq3A2);
  }
  return x;
}

@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let t = gid.x;
  if (t >= B.trackCount) { return; }
  P = Pall[t];
  if (P.slotOn == 0u) { return; }   // host left this slot inactive (no strip / bypassed / transparent)

  let sb = t * 64u;
  for (var k = 0u; k < 64u; k = k + 1u) { s[k] = st[sb + k]; }

  let bf = B.blockFrames;
  let base = t * bf * 2u;           // this track's [L|R] region in the big buffer
  for (var i = 0u; i < bf; i = i + 1u) {
    let l = chain(0u, sig[base + i]);
    let r = chain(1u, sig[base + bf + i]);
    var outL = l;
    var outR = r;
    if ((P.flags & COMP) != 0u) {
      let det = max(abs(l), abs(r));
      var env = s[58u];
      env = env + select(P.relCoef, P.attCoef, det > env) * (det - env);
      s[58u] = env;
      var tg = 1.0;
      let over = env / P.threshLin;
      if (over > 1.0) { tg = pow(over, P.ratioInv - 1.0); }
      var g = s[59u];
      g = g + select(P.relCoef, P.attCoef, tg < g) * (tg - g);
      s[59u] = g;
      outL = l * g * P.makeupLin;
      outR = r * g * P.makeupLin;
    }
    sig[base + i] = outL;
    sig[base + bf + i] = outR;
  }

  for (var k = 0u; k < 64u; k = k + 1u) { st[sb + k] = s[k]; }
}
`

/**
 * Insert "tube EQ" — one-knob 12AX7-flavoured drive stage, placed before the
 * reverb. Not a parametric EQ: a fixed tone-shaping "Ft" characteristic around
 * an asymmetric soft-saturator whose harmonic content grows as the single
 * `drive` knob is raised (near-clean at low drive, breaking up past the middle).
 *
 * Per channel, serial over the block (1-pole IIR = recursive, same as reverb):
 *   DC-block HP  →  HF pre-emphasis  →  drive + asymmetric tanh  →  HF rolloff
 *   (Miller)  →  makeup
 *
 * st (storage f32), per channel (ch*4 + n):
 *   0 hpX1   1 hpY1   2 emphLpY1   3 outLpY1
 */
export const TUBE_WGSL = /* wgsl */ `
struct Tube {
  blockFrames : u32,
  _pad : u32,
  hpR : f32,        // DC-block pole
  lpEmphA : f32,    // pre-emphasis LP coeff
  emphAmt : f32,    // HF pre-emphasis amount
  lpOutA : f32,     // output LP coeff (Miller)
  bias : f32,       // asymmetry -> even harmonics
  preGain : f32,    // derived from the drive knob (knee'd)
  makeup : f32,     // output level compensation
};
@group(0) @binding(0) var<uniform> P : Tube;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>; // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> st : array<f32>;

@compute @workgroup_size(2)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ch = gid.x;
  if (ch >= 2u) { return; }
  let base = ch * P.blockFrames;
  let s = ch * 4u;

  var hpX1 = st[s];
  var hpY1 = st[s + 1u];
  var eY1 = st[s + 2u];
  var oY1 = st[s + 3u];
  let biasT = tanh(P.bias);

  for (var i = 0u; i < P.blockFrames; i = i + 1u) {
    let x = sig[base + i];

    // 1-pole DC-block high-pass: y = x - x1 + R*y1
    let hp = x - hpX1 + P.hpR * hpY1;
    hpX1 = x;
    hpY1 = hp;

    // HF pre-emphasis: boost (input - lowpassed input)
    eY1 = eY1 + P.lpEmphA * (hp - eY1);
    let pre = hp + P.emphAmt * (hp - eY1);

    // drive + asymmetric tube saturation (2nd harmonic from bias, odd from tanh)
    let ws = tanh(pre * P.preGain + P.bias) - biasT;

    // output low-pass (Miller capacitance / de-emphasis)
    oY1 = oY1 + P.lpOutA * (ws - oY1);

    sig[base + i] = oY1 * P.makeup;
  }

  st[s] = hpX1;
  st[s + 1u] = hpY1;
  st[s + 2u] = eY1;
  st[s + 3u] = oY1;
}
`

/**
 * Insert **stereo delay** — circular delay line per channel, one-pole damping
 * low-pass in the feedback path, wet/dry, optional ping-pong (feedback taken
 * from the opposite channel). One GPU thread does both channels serially so the
 * ping-pong cross-feed is race-free (the recurrence can't parallelise anyway).
 *
 *   line : [ch0 (lineLen) | ch1 (lineLen)]   circular, indexed by baseIndex
 *   lpst : [ch0, ch1]                         feedback-LP memory
 */
export const DELAY_WGSL = /* wgsl */ `
struct DP {
  blockFrames : u32,
  baseIndex : u32,
  lineLen : u32,
  delaySamples : u32,
  feedback : f32,
  damp : f32,
  wet : f32,
  dry : f32,
  pingpong : f32,
  _p0 : f32, _p1 : f32, _p2 : f32,
};
@group(0) @binding(0) var<uniform> P : DP;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>;   // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> line : array<f32>;  // [ch0 line | ch1 line]
@group(0) @binding(3) var<storage, read_write> lpst : array<f32>;  // [ch0, ch1]

@compute @workgroup_size(1)
fn main() {
  let LL = P.lineLen;
  let bf = P.blockFrames;
  var lpL = lpst[0];
  var lpR = lpst[1];
  for (var i = 0u; i < bf; i = i + 1u) {
    let w = (P.baseIndex + i) % LL;
    let r = (P.baseIndex + i + LL - P.delaySamples) % LL;
    let dL = line[r];
    let dR = line[LL + r];
    lpL = lpL + P.damp * (dL - lpL);
    lpR = lpR + P.damp * (dR - lpR);
    let xL = sig[i];
    let xR = sig[bf + i];
    if (P.pingpong > 0.5) {
      line[w] = xL + lpR * P.feedback;
      line[LL + w] = xR + lpL * P.feedback;
    } else {
      line[w] = xL + lpL * P.feedback;
      line[LL + w] = xR + lpR * P.feedback;
    }
    sig[i] = xL * P.dry + dL * P.wet;
    sig[bf + i] = xR * P.dry + dR * P.wet;
  }
  lpst[0] = lpL;
  lpst[1] = lpR;
}
`

/**
 * Insert **digital 5-band EQ** — 5 RBJ biquads in series per channel (band 0
 * low-shelf, 1..3 peaking, 4 high-shelf), clean / linear-phase-agnostic (the
 * "digital" counterpart to the strip's analogue-voiced console EQ). `@workgroup_size(2)`:
 * one thread per channel, serial over the block (biquads are recursive).
 * State st: per channel base = ch*20, band k at base + k*4 = x1,x2,y1,y2.
 * cf: 5 sets of [b0,b1,b2,a1,a2] (a0 normalized to 1 on the CPU).
 */
export const EQ5_WGSL = /* wgsl */ `
struct EP {
  blockFrames : u32,
  _pad : u32,
  b0_0 : f32, b1_0 : f32, b2_0 : f32, a1_0 : f32, a2_0 : f32,
  b0_1 : f32, b1_1 : f32, b2_1 : f32, a1_1 : f32, a2_1 : f32,
  b0_2 : f32, b1_2 : f32, b2_2 : f32, a1_2 : f32, a2_2 : f32,
  b0_3 : f32, b1_3 : f32, b2_3 : f32, a1_3 : f32, a2_3 : f32,
  b0_4 : f32, b1_4 : f32, b2_4 : f32, a1_4 : f32, a2_4 : f32,
};
@group(0) @binding(0) var<uniform> P : EP;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>; // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> st : array<f32>;

fn bq(o : u32, x : f32, b0 : f32, b1 : f32, b2 : f32, a1 : f32, a2 : f32) -> f32 {
  let x1 = st[o]; let x2 = st[o + 1u]; let y1 = st[o + 2u]; let y2 = st[o + 3u];
  let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
  st[o] = x; st[o + 1u] = x1; st[o + 2u] = y; st[o + 3u] = y1;
  return y;
}

@compute @workgroup_size(2)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ch = gid.x;
  if (ch >= 2u) { return; }
  let sb = ch * P.blockFrames;
  let base = ch * 20u;
  for (var i = 0u; i < P.blockFrames; i = i + 1u) {
    var x = sig[sb + i];
    x = bq(base + 0u,  x, P.b0_0, P.b1_0, P.b2_0, P.a1_0, P.a2_0);
    x = bq(base + 4u,  x, P.b0_1, P.b1_1, P.b2_1, P.a1_1, P.a2_1);
    x = bq(base + 8u,  x, P.b0_2, P.b1_2, P.b2_2, P.a1_2, P.a2_2);
    x = bq(base + 12u, x, P.b0_3, P.b1_3, P.b2_3, P.a1_3, P.a2_3);
    x = bq(base + 16u, x, P.b0_4, P.b1_4, P.b2_4, P.a1_4, P.a2_4);
    sig[sb + i] = x;
  }
}
`

/**
 * Insert **tube program EQ** — a Pultec EQP-1A homage. Signal path:
 *   input 12AX7 (2 triode halves: gain stage + cathode follower)
 *   → passive program-EQ network (low-shelf boost + a higher-cornered low-shelf
 *     atten so simultaneous boost/atten give the classic bottom bump with a
 *     low-mid dip; HF peaking boost with a Bandwidth control; HF shelving atten)
 *   → output 12AX7 (2 triode halves: make-up gain stage + cathode follower)
 *   → gentle program-dependent compression (glue, ~1 dB, not pump)
 *   → a barely-perceptible short delay (~-21 dB, ~14 ms, subtle L/R offset — adds
 *     sheen / dimension without an audible echo)
 *   → Output trim
 *
 * Each triode half is the tube.ts model: DC block → HF pre-emphasis →
 * asymmetric tanh (bias → 2nd harmonic, tanh → odd) → Miller roll-off. The
 * follower halves run near-unity with a small HF bloom for gloss ("つややかさ").
 *
 * `@workgroup_size(2)`: one thread per channel, serial over the block (IIR +
 * waveshaper + delay are recursive). st per channel, base = ch*40:
 *   0..3   triode A (input gain stage)    hpX1, hpY1, emphY1, lpY1
 *   4..7   triode B (input follower)
 *   8..23  4 biquads (x1, x2, y1, y2) each
 *   24..27 triode C (output gain stage)
 *   28..31 triode D (output follower)
 *   32     compressor envelope
 *   34..37 baked presence-dip biquad
 * The short delay has its own circular line buffer (binding 3), [ch0 | ch1].
 */
export const TUBEEQ_WGSL = /* wgsl */ `
struct TE {
  blockFrames : u32,
  baseIndex : u32,
  aHpR:f32, aEmphA:f32, aEmphAmt:f32, aLpA:f32, aPreGain:f32, aBias:f32, aBiasT:f32, aMakeup:f32,
  bHpR:f32, bEmphA:f32, bEmphAmt:f32, bLpA:f32, bPreGain:f32, bBias:f32, bBiasT:f32, bMakeup:f32,
  cHpR:f32, cEmphA:f32, cEmphAmt:f32, cLpA:f32, cPreGain:f32, cBias:f32, cBiasT:f32, cMakeup:f32,
  dHpR:f32, dEmphA:f32, dEmphAmt:f32, dLpA:f32, dPreGain:f32, dBias:f32, dBiasT:f32, dMakeup:f32,
  q0b0:f32,q0b1:f32,q0b2:f32,q0a1:f32,q0a2:f32,
  q1b0:f32,q1b1:f32,q1b2:f32,q1a1:f32,q1a2:f32,
  q2b0:f32,q2b1:f32,q2b2:f32,q2a1:f32,q2a2:f32,
  q3b0:f32,q3b1:f32,q3b2:f32,q3a1:f32,q3a2:f32,
  compThr:f32, compSlope:f32, compAtt:f32, compRel:f32, compMakeup:f32,
  dlyLen:u32, dlySampL:u32, dlySampR:u32, dlyMix:f32, dlyFb:f32,
  pb0:f32, pb1:f32, pb2:f32, pa1:f32, pa2:f32,   // baked presence dip (~4-8 kHz), not on any dial
  outVol:f32,
};
@group(0) @binding(0) var<uniform> P : TE;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>;  // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> st : array<f32>;
@group(0) @binding(3) var<storage, read_write> line : array<f32>; // [ch0 line | ch1 line], circular

fn bq(o : u32, x : f32, b0 : f32, b1 : f32, b2 : f32, a1 : f32, a2 : f32) -> f32 {
  let x1 = st[o]; let x2 = st[o + 1u]; let y1 = st[o + 2u]; let y2 = st[o + 3u];
  let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
  st[o] = x; st[o + 1u] = x1; st[o + 2u] = y; st[o + 3u] = y1;
  return y;
}

// One 12AX7 triode half: DC block → HF pre-emphasis → asymmetric tanh → Miller LP.
fn triode(
  x : f32, hpR : f32, emphA : f32, emphAmt : f32, lpA : f32,
  preGain : f32, bias : f32, biasT : f32, makeup : f32,
  hpX1 : ptr<function, f32>, hpY1 : ptr<function, f32>,
  emY1 : ptr<function, f32>, lpY1 : ptr<function, f32>
) -> f32 {
  let hp = x - *hpX1 + hpR * (*hpY1);
  *hpX1 = x;
  *hpY1 = hp;
  *emY1 = *emY1 + emphA * (hp - *emY1);
  let pre = hp + emphAmt * (hp - *emY1);
  let ws = tanh(pre * preGain + bias) - biasT;
  *lpY1 = *lpY1 + lpA * (ws - *lpY1);
  return *lpY1 * makeup;
}

@compute @workgroup_size(2)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ch = gid.x;
  if (ch >= 2u) { return; }
  let sb = ch * P.blockFrames;
  let base = ch * 40u;

  var aH = st[base + 0u]; var aHy = st[base + 1u]; var aE = st[base + 2u]; var aL = st[base + 3u];
  var bH = st[base + 4u]; var bHy = st[base + 5u]; var bE = st[base + 6u]; var bL = st[base + 7u];
  var cH = st[base + 24u]; var cHy = st[base + 25u]; var cE = st[base + 26u]; var cL = st[base + 27u];
  var dH = st[base + 28u]; var dHy = st[base + 29u]; var dE = st[base + 30u]; var dL = st[base + 31u];
  var cEnv = st[base + 32u];

  let lb = ch * P.dlyLen;
  let ds = select(P.dlySampR, P.dlySampL, ch == 0u);

  for (var i = 0u; i < P.blockFrames; i = i + 1u) {
    var x = sig[sb + i];

    // input 12AX7 — gain stage then cathode follower
    x = triode(x, P.aHpR, P.aEmphA, P.aEmphAmt, P.aLpA, P.aPreGain, P.aBias, P.aBiasT, P.aMakeup, &aH, &aHy, &aE, &aL);
    x = triode(x, P.bHpR, P.bEmphA, P.bEmphAmt, P.bLpA, P.bPreGain, P.bBias, P.bBiasT, P.bMakeup, &bH, &bHy, &bE, &bL);

    // passive program EQ: low boost shelf, low atten shelf (higher corner),
    // HF peaking boost, HF shelving atten
    x = bq(base + 8u,  x, P.q0b0, P.q0b1, P.q0b2, P.q0a1, P.q0a2);
    x = bq(base + 12u, x, P.q1b0, P.q1b1, P.q1b2, P.q1a1, P.q1a2);
    x = bq(base + 16u, x, P.q2b0, P.q2b1, P.q2b2, P.q2a1, P.q2a2);
    x = bq(base + 20u, x, P.q3b0, P.q3b1, P.q3b2, P.q3a1, P.q3a2);

    // output 12AX7 — make-up gain stage then cathode follower
    x = triode(x, P.cHpR, P.cEmphA, P.cEmphAmt, P.cLpA, P.cPreGain, P.cBias, P.cBiasT, P.cMakeup, &cH, &cHy, &cE, &cL);
    x = triode(x, P.dHpR, P.dEmphA, P.dEmphAmt, P.dLpA, P.dPreGain, P.dBias, P.dBiasT, P.dMakeup, &dH, &dHy, &dE, &dL);

    // gentle program-dependent compression — glue, not pump
    let mag = abs(x);
    let k = select(P.compRel, P.compAtt, mag > cEnv);
    cEnv = cEnv + k * (mag - cEnv);
    var gr = 1.0;
    if (cEnv > P.compThr) {
      gr = 1.0 / (1.0 + P.compSlope * (cEnv - P.compThr) / P.compThr);
    }
    x = x * gr * P.compMakeup;

    // barely-perceptible short delay — sheen / dimension, not an audible echo
    let w = (P.baseIndex + i) % P.dlyLen;
    let r = (P.baseIndex + i + P.dlyLen - ds) % P.dlyLen;
    let dv = line[lb + r];
    line[lb + w] = x + dv * P.dlyFb;
    x = x + dv * P.dlyMix;

    // baked presence dip — a broad, shallow cut through the 4-8 kHz "刺さる"
    // region so the box always calms the highs a little, independent of the EQ.
    x = bq(base + 34u, x, P.pb0, P.pb1, P.pb2, P.pa1, P.pa2);

    sig[sb + i] = x * P.outVol;
  }

  st[base + 0u] = aH; st[base + 1u] = aHy; st[base + 2u] = aE; st[base + 3u] = aL;
  st[base + 4u] = bH; st[base + 5u] = bHy; st[base + 6u] = bE; st[base + 7u] = bL;
  st[base + 24u] = cH; st[base + 25u] = cHy; st[base + 26u] = cE; st[base + 27u] = cL;
  st[base + 28u] = dH; st[base + 29u] = dHy; st[base + 30u] = dE; st[base + 31u] = dL;
  st[base + 32u] = cEnv;
}
`

/**
 * Insert **"Awaker" enhancer** — a silky high-frequency exciter with a transient
 * lift. It works in *parallel*: the dry signal is passed through untouched and a
 * generated "sheen" bus is added on top, so the source phase is preserved and
 * the result "opens up" without smearing.
 *
 * Per channel, serial over the block (all one-pole IIR + envelope followers,
 * recursive like the tube / reverb prototypes):
 *   DC-block  →  crossover (isolate the HF band)  →  HF pre-emphasis
 *   →  even-harmonic-biased cubic shaper (only up to the 3rd harmonic — no
 *      tanh fizz)  →  post low-pass (Tone: warm ↔ bright)
 *   →  transient envelopes on the HF band give a fast attack lift (Punch)
 *   →  wet = harmonics + broadband HF sparkle, then  out = dry + Amount·wet
 *
 * st (storage f32), per channel (ch*8 + n):
 *   0 dcX1   1 dcY1   2 xoverLP   3 emphLP   4 postLP   5 envFast   6 envSlow
 */
export const AWAKER_WGSL = /* wgsl */ `
struct AW {
  blockFrames : u32,
  _pad : u32,
  dcR : f32,        // DC-block pole
  xoA : f32,        // crossover LP coeff (Freq) — hi = input - LP
  preGain : f32,    // pre-gain into the shaper (Air, drive² knee)
  bias : f32,       // shaper asymmetry -> 2nd harmonic
  biasC : f32,      // shape(bias), precomputed for DC removal
  emphA : f32,      // HF pre-emphasis one-pole coeff (Tone)
  emph : f32,       // HF pre-emphasis amount (Tone)
  postA : f32,      // harmonic post-LP coeff (Tone: warm = low corner = silky)
  harmAmt : f32,    // generated-harmonic level (Air)
  shelfAmt : f32,   // broadband HF lift blended with the harmonics (Air)
  fastA : f32,      // transient fast-env release coeff (attack is instant)
  slowA : f32,      // transient slow-env coeff
  punchAmt : f32,   // transient boost depth
  punchMax : f32,   // transient gain ceiling (1..~4)
  transThru : f32,  // dry-HF transient lift, independent of Air (Punch alone)
  amount : f32,     // overall wet blend (dry always full)
  outTrim : f32,    // slight output level trim
  limT : f32,       // soft-limiter threshold on the wet bus (pre-add)
};
@group(0) @binding(0) var<uniform> P : AW;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>; // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> st : array<f32>;

// Cubic soft shaper. Unlike tanh this has a *finite* series — only a 3rd
// harmonic — so it stays smooth ("サラサラ") and doesn't spray aliased fizz.
fn shape(u : f32) -> f32 {
  let a = clamp(u, -1.0, 1.0);
  return a - a * a * a * 0.33333333;
}

// Soft headroom knee: below t untouched, above t a tanh shoulder asymptotic to 1.
fn softTop(x : f32, t : f32) -> f32 {
  let a = abs(x);
  if (a <= t) { return x; }
  let r = t + (1.0 - t) * tanh((a - t) / (1.0 - t));
  return select(-r, r, x >= 0.0);
}

@compute @workgroup_size(2)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ch = gid.x;
  if (ch >= 2u) { return; }
  let base = ch * P.blockFrames;
  let s = ch * 8u;

  var dcX1 = st[s];
  var dcY1 = st[s + 1u];
  var xoLP = st[s + 2u];
  var emLP = st[s + 3u];
  var poLP = st[s + 4u];
  var envF = st[s + 5u];
  var envS = st[s + 6u];

  for (var i = 0u; i < P.blockFrames; i = i + 1u) {
    let x = sig[base + i];

    // DC-block for the side path — the dry signal stays pristine
    let hp = x - dcX1 + P.dcR * dcY1;
    dcX1 = x;
    dcY1 = hp;

    // crossover: the HF band we excite
    xoLP = xoLP + P.xoA * (hp - xoLP);
    let hi = hp - xoLP;

    // transient envelopes on the HF band (fast = instant attack / P.fastA release)
    let mag = abs(hi);
    envF = envF + select(P.fastA, 1.0, mag > envF) * (mag - envF);
    envS = envS + P.slowA * (mag - envS);
    let trans = max(0.0, envF - envS);
    let tGain = clamp(1.0 + P.punchAmt * trans / (envS + 0.0001), 1.0, P.punchMax);

    // HF pre-emphasis into the shaper (extension / sparkle without raw level)
    emLP = emLP + P.emphA * (hi - emLP);
    let pre = (hi + P.emph * (hi - emLP)) * P.preGain;

    // even-harmonic-biased cubic shaper
    var harm = shape(pre + P.bias) - P.biasC;

    // post low-pass — rolls the very top so it reads silky, not glassy
    poLP = poLP + P.postA * (harm - poLP);
    harm = poLP;

    // wet bus: harmonics + broadband HF lift, plus a Punch-only transient term
    let enh = harm * P.harmAmt + hi * P.shelfAmt;
    let wet = enh * tGain + hi * (tGain - 1.0) * P.transThru;

    let y = x + P.amount * softTop(wet, P.limT);
    sig[base + i] = y * P.outTrim;
  }

  st[s]      = dcX1;
  st[s + 1u] = dcY1;
  st[s + 2u] = xoLP;
  st[s + 3u] = emLP;
  st[s + 4u] = poLP;
  st[s + 5u] = envF;
  st[s + 6u] = envS;
}
`

/**
 * Master **bus compressor** — stereo-linked, feed-forward, soft-knee, SSL-G-bus
 * voiced (fixed 2 / 4 / 10 ratios, stepped attack, fixed-or-program-dependent
 * release). One knob of **bright harmonic drive** sits after the gain reduction:
 * HF pre-emphasis → asymmetric soft-clip (bias = 2nd, tanh = odd) → DC block →
 * a baked bright high-shelf. Subtle by design — its blend is `driveAmt` — and it
 * gives the "明るめの倍音" colour the user asked for. `Mix` blends the whole
 * processed path back against the dry input (parallel compression).
 *
 * Single thread (`@workgroup_size(1)`): the detector is stereo-linked so L and R
 * must run in lock-step, and the ballistics / biquads are recursive.
 * st: [0] detector env  [2] emphLP ch0 [3] emphLP ch1  [4] dcLP ch0 [5] dcLP ch1
 *     [6..9] bright high-shelf biquad ch0  [10..13] bright high-shelf biquad ch1
 */
export const BUSCOMP_WGSL = /* wgsl */ `
struct BC {
  blockFrames : u32,
  _pad : u32,
  threshDb : f32,
  kneeDb : f32,
  ratioInv : f32,       // 1/ratio
  attCoef : f32,
  relCoef : f32,        // fixed release, or the slow pole when autoRel != 0
  relCoefFast : f32,    // fast pole, blended in when autoRel != 0 (program-dependent)
  autoRel : f32,        // 0 = fixed release, 1 = program-dependent
  makeupLin : f32,
  mix : f32,            // 0 = dry input, 1 = fully processed (parallel comp)
  driveAmt : f32,       // 0..1 bright-harmonic blend
  emphA : f32,          // HF pre-emphasis one-pole coeff
  emphAmt : f32,
  driveG : f32,         // shaper input gain
  bias : f32,           // asymmetry -> 2nd harmonic
  biasC : f32,          // tanh(bias), precomputed (DC removal)
  hsB0 : f32, hsB1 : f32, hsB2 : f32, hsA1 : f32, hsA2 : f32,  // baked bright high-shelf
  outTrim : f32,        // makeup for the drive lift
};
@group(0) @binding(0) var<uniform> P : BC;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>;  // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> st : array<f32>;

const LOG10 : f32 = 0.43429448190325176;  // 1 / ln(10)

fn hsBq(o : u32, x : f32) -> f32 {
  let x1 = st[o]; let x2 = st[o + 1u]; let y1 = st[o + 2u]; let y2 = st[o + 3u];
  let y = P.hsB0 * x + P.hsB1 * x1 + P.hsB2 * x2 - P.hsA1 * y1 - P.hsA2 * y2;
  st[o] = x; st[o + 1u] = x1; st[o + 2u] = y; st[o + 3u] = y1;
  return y;
}

// Bright-harmonic drive on one channel. Unity when driveAmt == 0 (the shelf is
// 0 dB and the DC-block only removes a near-zero offset).
fn bright(ch : u32, x : f32) -> f32 {
  let e = 2u + ch;
  let d = 4u + ch;
  var emLP = st[e];
  var dcLP = st[d];
  emLP = emLP + P.emphA * (x - emLP);
  let pe = x + P.emphAmt * (x - emLP);
  let shp = tanh(pe * P.driveG + P.bias) - P.biasC;
  var y = mix(x, shp, P.driveAmt);
  dcLP = dcLP + 0.0016 * (y - dcLP);
  y = y - dcLP;
  st[e] = emLP;
  st[d] = dcLP;
  return hsBq(6u + ch * 4u, y);
}

@compute @workgroup_size(1)
fn main() {
  let bf = P.blockFrames;
  var env = st[0];
  for (var i = 0u; i < bf; i = i + 1u) {
    let xl = sig[i];
    let xr = sig[bf + i];

    // stereo-linked peak detector, attack / (program-dependent) release
    let det = max(abs(xl), abs(xr));
    var coef = P.attCoef;
    if (det <= env) {
      let slam = clamp((env - det) * 4.0, 0.0, 1.0);
      coef = mix(P.relCoef, P.relCoefFast, P.autoRel * slam);
    }
    env = env + coef * (det - env);

    // gain computer — soft knee, in dB
    let envDb = 20.0 * log(max(env, 1e-6)) * LOG10;
    let over = envDb - P.threshDb;
    let hk = P.kneeDb * 0.5;
    var grDb = 0.0;
    if (over >= hk) {
      grDb = (P.ratioInv - 1.0) * over;
    } else if (over > -hk) {
      let t = over + hk;
      grDb = (P.ratioInv - 1.0) * t * t / (2.0 * P.kneeDb);
    }
    let g = pow(10.0, grDb * 0.05);

    var pl = bright(0u, xl * g * P.makeupLin) * P.outTrim;
    var pr = bright(1u, xr * g * P.makeupLin) * P.outTrim;
    sig[i] = mix(xl, pl, P.mix);
    sig[bf + i] = mix(xr, pr, P.mix);
  }
  st[0] = env;
}
`

/**
 * Master **maximizer** — a look-ahead brick-wall limiter. The signal is delayed
 * by `lookahead` samples while a stereo-linked gain envelope is driven down ahead
 * of each peak (slow-releasing peak-hold → attack-smoothed gain), so by the time
 * a transient emerges from the delay line the gain is already where it needs to
 * be. A hard clamp at the ceiling is the final safety net.
 *
 * `lookahead` (~1.5 ms) is NOT latency-compensated — acceptable for a prototype
 * mastering insert. Single thread (`@workgroup_size(1)`): stereo-linked + circular
 * delay line.
 * stt: [0] gain env  [1] peak-hold
 */
export const MAXIMIZER_WGSL = /* wgsl */ `
struct MX {
  blockFrames : u32,
  baseIndex : u32,
  lineLen : u32,
  lookahead : u32,
  inGain : f32,
  ceilingLin : f32,
  atkCoef : f32,    // gain attack (reaches target within the look-ahead window)
  relCoef : f32,    // gain-envelope smoothing on recovery
  holdRel : f32,    // slow release of the peak-hold (the Release control)
  outTrim : f32,
  _p0 : f32, _p1 : f32,
};
@group(0) @binding(0) var<uniform> P : MX;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>;   // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> line : array<f32>;  // [ch0 line | ch1 line]
@group(0) @binding(3) var<storage, read_write> stt : array<f32>;   // [gEnv, gHold]

@compute @workgroup_size(1)
fn main() {
  let LL = P.lineLen;
  let bf = P.blockFrames;
  var gEnv = stt[0];
  var gHold = stt[1];
  for (var i = 0u; i < bf; i = i + 1u) {
    let w = (P.baseIndex + i) % LL;
    let r = (P.baseIndex + i + LL - P.lookahead) % LL;
    let inL = sig[i] * P.inGain;
    let inR = sig[bf + i] * P.inGain;
    line[w] = inL;
    line[LL + w] = inR;

    let peak = max(abs(inL), abs(inR));
    var gt = 1.0;
    if (peak > P.ceilingLin) { gt = P.ceilingLin / peak; }

    gHold = min(gt, gHold + P.holdRel * (1.0 - gHold));
    let c = select(P.relCoef, P.atkCoef, gHold < gEnv);
    gEnv = gEnv + c * (gHold - gEnv);

    var yl = line[r] * gEnv;
    var yr = line[LL + r] * gEnv;
    yl = clamp(yl, -P.ceilingLin, P.ceilingLin);
    yr = clamp(yr, -P.ceilingLin, P.ceilingLin);
    sig[i] = yl * P.outTrim;
    sig[bf + i] = yr * P.outTrim;
  }
  stt[0] = gEnv;
  stt[1] = gHold;
}
`
