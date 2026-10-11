// Copyright 2026 TK <tk.oss.developer@gmail.com>
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
  waveColor : vec4<f32>,  // the waveform ink (a dark grey on the track colour)
  fillColor : vec4<f32>,  // fill behind a picked clip (a pale tint of the track colour)
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
  return vec4<f32>(V.fillColor.rgb, 1.0); // pale tint of the track colour behind a picked clip
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
  // Default: the track's wave ink (dark grey) over the lane, which is painted in the track colour.
  // Picked: near-black wave over the pale tint drawn by bgvs/bgfs.
  let base = V.waveColor.rgb;
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
struct P { blockFrames : u32, clampOut : u32 };   // clampOut = 0: leave the signal as is (stem export)
@group(0) @binding(0) var<uniform> u : P;
@group(0) @binding(1) var<storage, read> inP : array<f32>;
@group(0) @binding(2) var<storage, read_write> outLR : array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u.blockFrames) { return; }
  let l = inP[i];
  let r = inP[u.blockFrames + i];
  if (u.clampOut != 0u) {
    outLR[i * 2u] = clamp(l, -1.0, 1.0);
    outLR[i * 2u + 1u] = clamp(r, -1.0, 1.0);
  } else {
    outLR[i * 2u] = l;
    outLR[i * 2u + 1u] = r;
  }
}
`

/**
 * Insert reverb — Freeverb (Schroeder/Moorer: 8 parallel damped combs + 4 series
 * allpasses per channel), computed in parallel with the SAME result as the plain
 * sample-by-sample recurrence.
 *
 * Why it parallelises: a comb of length D reads the slot written D samples ago, so
 * inside a chunk of D samples every read is of an OLD value and every write is to a
 * distinct slot — the chunk is independent; only chunk-to-chunk is sequential
 * (~block/D steps, a workgroup barrier apart). The comb's one-pole damping filter
 * `fs[m] = damp2·y[m] + damp1·fs[m-1]` is a recurrence too, but damp1 <= 0.4, so
 * its impulse response (damp1^k) is below 1e-9 after 24 taps: a 24-tap FIR over the
 * chunk's y values (plus the exact carry for the first samples) equals the
 * recursion to float32 precision. Allpasses are the same chunk trick with their own
 * length. 16 comb workgroups (channel x comb) + 2 allpass workgroups instead of two
 * threads doing everything serially.
 *
 * cfg (storage, u32):
 *   [0..7]   comb lengths           [8..15]  comb offsets (within a channel)
 *   [16..19] allpass lengths        [20..23] allpass offsets
 *   [24] sum(comb lengths)          [25] sum(allpass lengths)
 * scratch (f32, size 18 x blockFrames): [16 comb outputs | 2 channel accumulators].
 * No Freeverb stereo-spread (equal L/R delay lengths).
 */
export const REVERB_COMB_WGSL = /* wgsl */ `
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
@group(0) @binding(5) var<storage, read_write> lpf : array<f32>;     // ch*8 + comb -> filterstore
@group(0) @binding(6) var<storage, read_write> scratch : array<f32>;

const INPUT_GAIN : f32 = 0.015;
const TAPS : u32 = 24u;
var<workgroup> fsCarry : f32;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg : vec3<u32>, @builtin(local_invocation_index) tid : u32) {
  let ch = wg.x / 8u;
  let k = wg.x % 8u;
  let len = cfg[k];
  let bf = P.blockFrames;
  let sigBase = ch * bf;
  let combBase = ch * cfg[24] + cfg[8u + k];
  let yBase = wg.x * bf;
  let li = ch * 8u + k;
  let a = P.damp1;
  let b = P.damp2;

  if (tid == 0u) { fsCarry = lpf[li]; }
  workgroupBarrier();

  var c = 0u;
  loop {
    if (c >= bf) { break; }
    let n = min(len, bf - c);

    // a) this chunk's comb outputs (old values), kept for the sum and for the filter
    for (var j = tid; j < n; j += 256u) {
      scratch[yBase + c + j] = combBuf[combBase + ((P.baseIndex + c + j) % len)];
    }
    storageBarrier();
    workgroupBarrier();
    let carry = fsCarry;
    workgroupBarrier();

    // b) damping low-pass (24-tap exact-to-float32) and the write-back
    for (var j = tid; j < n; j += 256u) {
      let lo = select(0u, j - TAPS, j >= TAPS);
      var fs = 0.0;
      var w = b;
      for (var i = 0u; i <= j - lo; i = i + 1u) {
        fs = fs + w * scratch[yBase + c + j - i];
        w = w * a;
      }
      if (lo == 0u) { fs = fs + carry * (w / b); }   // a^(j+1) * previous filter state
      let x = sig[sigBase + c + j] * INPUT_GAIN;
      combBuf[combBase + ((P.baseIndex + c + j) % len)] = x + fs * P.feedback;
      if (j == n - 1u) { fsCarry = fs; }
    }
    storageBarrier();
    workgroupBarrier();
    c = c + n;
  }
  if (tid == 0u) { lpf[li] = fsCarry; }
}
`

/** Second reverb pass: sum the 8 combs, run the 4 allpasses in series (chunked by their length), mix wet/dry. */
export const REVERB_AP_WGSL = /* wgsl */ `
struct Fx {
  blockFrames : u32,
  baseIndex : u32,
  feedback : f32,
  damp1 : f32,
  damp2 : f32,
  apFeedback : f32,
  wet : f32,
  dry : f32,
};
@group(0) @binding(0) var<uniform> P : Fx;
@group(0) @binding(1) var<storage, read> cfg : array<u32>;
@group(0) @binding(2) var<storage, read_write> sig : array<f32>;
@group(0) @binding(4) var<storage, read_write> apBuf : array<f32>;   // [ch0 aps | ch1 aps]
@group(0) @binding(6) var<storage, read_write> scratch : array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg : vec3<u32>, @builtin(local_invocation_index) tid : u32) {
  let ch = wg.x;
  let bf = P.blockFrames;
  let accBase = (16u + ch) * bf;

  // sum of the 8 combs, in the same order as the serial version
  for (var n = tid; n < bf; n += 256u) {
    var acc = 0.0;
    for (var k = 0u; k < 8u; k = k + 1u) { acc = acc + scratch[(ch * 8u + k) * bf + n]; }
    scratch[accBase + n] = acc;
  }
  storageBarrier();
  workgroupBarrier();

  let apChBase = ch * cfg[25];
  for (var st = 0u; st < 4u; st = st + 1u) {
    let len = cfg[16u + st];
    let base = apChBase + cfg[20u + st];
    var c = 0u;
    loop {
      if (c >= bf) { break; }
      let n = min(len, bf - c);
      for (var j = tid; j < n; j += 256u) {
        let pos = base + ((P.baseIndex + c + j) % len);
        let y = apBuf[pos];
        let sIn = scratch[accBase + c + j];
        apBuf[pos] = sIn + y * P.apFeedback;
        scratch[accBase + c + j] = y - sIn;
      }
      storageBarrier();
      workgroupBarrier();
      c = c + n;
    }
  }

  for (var n = tid; n < bf; n += 256u) {
    sig[ch * bf + n] = sig[ch * bf + n] * P.dry + scratch[accBase + n] * P.wet;
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
  peakSlot : u32,   // this track's slot in \`peaks\`
};
@group(0) @binding(0) var<uniform> u : P;
@group(0) @binding(1) var<storage, read> inP : array<f32>;         // [L|R] scratch
@group(0) @binding(2) var<storage, read_write> outP : array<f32>;  // [L|R] master
// Post-fader (pre-master) peak of each track over the block: the largest |L| or |R| after the strip, the inserts,
// the fader and the pan. Non-negative floats order like their bit patterns, so a u32 atomicMax is a float max.
// The host clears the slots each block.
@group(0) @binding(3) var<storage, read_write> peaks : array<atomic<u32>>;

var<workgroup> wm : array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(local_invocation_index) li : u32) {
  let i = gid.x;
  var pk = 0.0;
  if (i < u.blockFrames) {
    let jR = u.blockFrames + i;
    let l0 = inP[i] * u.gain * u.panL;
    let r0 = inP[jR] * u.gain * u.panR;
    let l = l0 * u.masterGain;
    let r = r0 * u.masterGain;
    pk = max(abs(l0), abs(r0));
    if (u.accumulate != 0u) {
      outP[i] = outP[i] + l;
      outP[jR] = outP[jR] + r;
    } else {
      outP[i] = l;
      outP[jR] = r;
    }
  }
  wm[li] = pk;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (li < s) { wm[li] = max(wm[li], wm[li + s]); }
    workgroupBarrier();
  }
  if (li == 0u) { atomicMax(&peaks[u.peakSlot], bitcast<u32>(wm[0])); }
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
  // DRIVE mode — 12AX7 triode grit + feedback FET compressor ("76 all-buttons").
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
@group(0) @binding(4) var<storage, read_write> E : array<f32>;     // comp scratch, [track][frame]

// Per-track params of the track this workgroup handles (copied once; helpers read P.* as before).
var<private> P : CS;

const DRIVE    : u32 = 1u;   // saturation stage active (amount > 0)
const HPF      : u32 = 2u;
const EQ       : u32 = 4u;
const SATCOLOR : u32 = 8u;   // saturation mode: set = Color (transformer), clear = Drive (triode + FET comp)
const COMP     : u32 = 16u;
const ACTIVE   : u32 = 0x80000000u;   // not a strip flag: marks "this slot is processed" in trackFlags()

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

// ~12 Hz one-pole DC-block coefficient. Fixed (not rate-scaled): across 44.1–192
// kHz the corner only moves 6–24 Hz, inaudible, and it saves a uniform word.
const COL_DC_A : f32 = 0.0016;

// ---------------------------------------------------------------------------------------------
// The strip, in parallel over TIME. Per sample per channel the chain is
//   trim -> saturation (Drive | Color) -> allpass (if saturating) -> HPF -> 4 EQ bands -> comp.
// Almost all of it is linear recursion (one-poles, biquads) with per-sample nonlinearities in
// between — which chunked scans solve exactly (zero-state chunks -> carry -> true run; biquads add
// a parareal correction, see EQ5_WGSL). The only truly serial part is the Drive-mode feedback
// compressor (its detector looks at the previous output). Kernels, one 256-thread workgroup per
// (track, channel), D = a [track*2+ch][frame] scratch:
//   preA   Color mode: trim, then DC-block / LF-bloom / emphasis+Class-A / output one-poles; plain
//          tracks (no saturation): trim only                                    sig -> D
//   driveA Drive mode: trim, emphasis one-pole + 12AX7 grit (tanh)              sig -> D
//   driveB Drive mode: the feedback FET compressor, DC block, density clip      D -> D (serial, tiled)
//   tailC  Drive: soft-top + 1:1 trim; allpass; HPF; 4 EQ biquads               D -> sig
//   comp*  stereo-linked compressor (below)
// State words (per track slice of 64 f32; b = ch*24): [b] prevOut [b+1] env [b+2] emphasis LP
// [b+3] DC LP (Drive) · biquads x1,x2,y1,y2 at b+4 (HPF), b+8 .. b+20 (EQ) · Color one-poles at
// 48+ch*4 (dc / bloom / emphasis / out) · allpass z at 56+ch · comp env 58, gain 59.
//
// DRIVE mode — 12AX7-flavoured triode grit slammed by a feedback FET compressor with an extreme
// "all-buttons" ratio. One knob drives the signal hard into the triode: HF pre-emphasis makes the
// asymmetric clip bright and ragged ("ささくれ"), then a very fast, FEEDBACK-detected (previous
// output sample), program-dependent-release compressor levels it — the fast attack lets the
// transient front bite through ("バイト"). For shoving a kick / bass forward.
// COLOR mode — one-knob transformer + Class-A harmonic stage: DC-block -> transformer LF bloom
// (weight / 2nd on lows) -> HF pre-emphasis -> asymmetric Class-A drive (bias = 2nd, tanh = 3rd) ->
// output-transformer shoulder, half-direct top (keeps sparkle). Unity at amount 0.
// Allpass: a first-order magnitude-flat allpass with a tiny per-instance coefficient, after
// whichever saturation mode is active. Inaudible on a solo track; its only job is to decorrelate
// the phase of many stacked copies of the same source. NOT component-tolerance modelling — just a
// small fixed coefficient the user never sees or picks.
// Float32 chunk transitions M for the biquads are computed in the shader — parareal only applies
// them to the small residual, so their rounding does not reach the output.
// ---------------------------------------------------------------------------------------------
@group(0) @binding(5) var<storage, read_write> D : array<f32>;

var<workgroup> dFlagsWord : u32;
var<workgroup> dtile : array<f32, 256>;
var<workgroup> dE : array<vec2<f32>, 256>;
var<workgroup> dS : array<vec2<f32>, 256>;
var<workgroup> dN : array<vec2<f32>, 256>;

// The track's flags | ACTIVE (0 if its slot is inactive), uniform across the workgroup so barriers stay legal.
fn trackFlags(t : u32, lid : u32) -> u32 {
  if (lid == 0u) {
    var f = 0u;
    if (t < B.trackCount && Pall[t].slotOn != 0u) { f = Pall[t].flags | ACTIVE; }
    dFlagsWord = f;
  }
  return workgroupUniformLoad(&dFlagsWord);
}

fn isDriveMode(f : u32) -> bool {
  return (f & ACTIVE) != 0u && (f & DRIVE) != 0u && (f & SATCOLOR) == 0u;
}

// ---- Color mode: four one-poles on D, in place -----------------------------------------------
fn colorCoef(stage : u32) -> f32 {
  if (stage == 0u) { return COL_DC_A; }
  if (stage == 1u) { return P.colLoA; }
  if (stage == 2u) { return P.colEmphA; }
  return P.colOutA;
}

// Stage input: only the output stage filters a nonlinear function (the shoulder) of D.
fn colorIn(stage : u32, v : f32) -> f32 {
  if (stage == 3u) {
    let sh = v / (1.0 + abs(v));
    return mix(v, sh, P.colShoulder);
  }
  return v;
}

// Stage output given its input x and the updated one-pole state e.
fn colorOut(stage : u32, x : f32, e : f32) -> f32 {
  if (stage == 0u) { return x - e; }                                          // DC block
  if (stage == 1u) { return x + P.colBloom * (tanh(e * 2.0) * 0.5 - e); }     // LF bloom
  if (stage == 2u) {                                                          // emphasis -> Class-A
    let pre = x + P.colEmph * (x - e);
    return tanh(pre * P.colG + P.colBias) - P.colBiasT;
  }
  return mix(x, e, 0.5) * P.colMakeup;                                        // shoulder + half-direct top
}

fn colorPole(stage : u32, lid : u32, i0 : u32, n : u32, C : u32, go : u32, so : u32) {
  let a = colorCoef(stage);
  var e = 0.0;
  for (var j = 0u; j < n; j = j + 1u) {
    let x = colorIn(stage, D[go + i0 + j]);
    e = e + a * (x - e);
  }
  dE[lid] = vec2<f32>(e, 0.0);
  workgroupBarrier();
  if (lid == 0u) {
    let dec = pow(1.0 - a, f32(C));
    var c0 = st[so];
    for (var c = 0u; c < 256u; c = c + 1u) {
      dS[c] = vec2<f32>(c0, 0.0);
      c0 = dE[c].x + dec * c0;
    }
  }
  workgroupBarrier();
  e = dS[lid].x;
  for (var j = 0u; j < n; j = j + 1u) {
    let x = colorIn(stage, D[go + i0 + j]);
    e = e + a * (x - e);
    D[go + i0 + j] = colorOut(stage, x, e);
  }
  if (i0 + n == B.blockFrames && n > 0u) { st[so] = e; }
  workgroupBarrier();
}

@compute @workgroup_size(256)
fn preA(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) lid : u32) {
  let t = wid.x >> 1u;
  let ch = wid.x & 1u;
  let f = trackFlags(t, lid);
  if ((f & ACTIVE) == 0u || isDriveMode(f)) { return; }
  P = Pall[t];
  let bf = B.blockFrames;
  let C = (bf + 255u) / 256u;
  let i0 = min(lid * C, bf);
  let n = min(i0 + C, bf) - i0;
  let po = t * bf * 2u + ch * bf;
  let go = (t * 2u + ch) * bf;
  for (var j = 0u; j < n; j = j + 1u) { D[go + i0 + j] = sig[po + i0 + j] * P.trimLin; }
  if ((f & DRIVE) != 0u) {   // Color mode (Drive mode returned above)
    let so = t * 64u + 48u + ch * 4u;
    colorPole(0u, lid, i0, n, C, go, so);
    colorPole(1u, lid, i0, n, C, go, so + 1u);
    colorPole(2u, lid, i0, n, C, go, so + 2u);
    colorPole(3u, lid, i0, n, C, go, so + 3u);
  }
}

// Drive-mode emphasis one-pole e += a*(x - e) over this chunk (x = sig * trim * dPre), with carry,
// then the 12AX7 grit tanh(pre * dTriG + dBias) - dBiasT per sample -> D.
fn driveA_scan(lid : u32, i0 : u32, n : u32, C : u32, po : u32, go : u32, so : u32) {
  let a = P.dEmphA;
  var e = 0.0;
  for (var j = 0u; j < n; j = j + 1u) {
    let xd = sig[po + i0 + j] * P.trimLin * P.dPre;
    e = e + a * (xd - e);
  }
  dE[lid] = vec2<f32>(e, 0.0);
  workgroupBarrier();
  if (lid == 0u) {
    let dec = pow(1.0 - a, f32(C));
    var c0 = st[so];
    for (var c = 0u; c < 256u; c = c + 1u) {
      dS[c] = vec2<f32>(c0, 0.0);
      c0 = dE[c].x + dec * c0;
    }
  }
  workgroupBarrier();
  e = dS[lid].x;
  for (var j = 0u; j < n; j = j + 1u) {
    let xd = sig[po + i0 + j] * P.trimLin * P.dPre;
    e = e + a * (xd - e);
    let pre = xd + P.dEmph * (xd - e);
    D[go + i0 + j] = tanh(pre * P.dTriG + P.dBias) - P.dBiasT;
  }
  if (i0 + n == B.blockFrames && n > 0u) { st[so] = e; }
}

@compute @workgroup_size(256)
fn driveA(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) lid : u32) {
  let t = wid.x >> 1u;
  let ch = wid.x & 1u;
  if (!isDriveMode(trackFlags(t, lid))) { return; }
  P = Pall[t];
  let bf = B.blockFrames;
  let C = (bf + 255u) / 256u;
  let i0 = min(lid * C, bf);
  let n = min(i0 + C, bf) - i0;
  driveA_scan(lid, i0, n, C, t * bf * 2u + ch * bf, (t * 2u + ch) * bf, t * 64u + ch * 24u + 2u);
}

@compute @workgroup_size(256)
fn driveB(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) l : u32) {
  let t = wid.x >> 1u;
  let ch = wid.x & 1u;
  if (!isDriveMode(trackFlags(t, l))) { return; }
  P = Pall[t];
  let bf = B.blockFrames;
  let go = (t * 2u + ch) * bf;
  let sb = t * 64u + ch * 24u;
  var prevOut = st[sb];
  var env = st[sb + 1u];
  var dcLP = st[sb + 3u];
  for (var t0 = 0u; t0 < bf; t0 = t0 + 256u) {
    let idx = t0 + l;
    if (idx < bf) { dtile[l] = D[go + idx]; }
    workgroupBarrier();
    if (l == 0u) {
      let m = min(256u, bf - t0);
      for (var j = 0u; j < m; j = j + 1u) {
        let grit = dtile[j];
        // feedback FET compressor — detector on the PREVIOUS output sample
        let det = abs(prevOut);
        let slam = clamp(det / P.dThr - 1.0, 0.0, 1.0);
        let rel = mix(P.dRelSlow, P.dRelFast, slam);
        env = env + select(rel, P.dAtt, det > env) * (det - env);
        var gr = 1.0;
        let over = env / P.dThr;
        if (over > 1.0) { gr = pow(over, P.dRatioInv - 1.0); }
        var y = grit * gr * P.dMakeup;
        dcLP = dcLP + 0.0016 * (y - dcLP);
        y = y - dcLP;
        y = y / (1.0 + abs(y) * P.dDensity);
        prevOut = y;
        dtile[j] = y;
      }
    }
    workgroupBarrier();
    if (idx < bf) { D[go + idx] = dtile[l]; }
    workgroupBarrier();
  }
  if (l == 0u) { st[sb] = prevOut; st[sb + 1u] = env; st[sb + 3u] = dcLP; }
}

// One biquad over this chunk of D, in place (parareal-style scan, see EQ5_WGSL). Called with the
// same arguments by every invocation, from uniform control flow.
fn driveBiquad(lid : u32, i0 : u32, n : u32, C : u32, go : u32, o : u32,
               b0 : f32, b1 : f32, b2 : f32, a1 : f32, a2 : f32) {
  let N = B.blockFrames;
  // chunk transition in (value, slope) coordinates
  var pp1 = 1.0; var pp2 = 1.0; var dd1 = 0.0; var dd2 = -1.0;
  for (var j = 0u; j < C; j = j + 1u) {
    let yp = -a1 * pp1 - a2 * pp2; pp2 = pp1; pp1 = yp;
    let yd = -a1 * dd1 - a2 * dd2; dd2 = dd1; dd1 = yd;
  }
  var iu1 = st[o]; var iu2 = st[o + 1u];
  if (i0 >= 2u) { iu1 = D[go + i0 - 1u]; iu2 = D[go + i0 - 2u]; }
  else if (i0 == 1u) { iu1 = D[go]; iu2 = st[o]; }
  storageBarrier(); workgroupBarrier();

  var u1 = iu1; var u2 = iu2; var z1 = 0.0; var z2 = 0.0;
  for (var j = 0u; j < n; j = j + 1u) {
    let u = D[go + i0 + j];
    let y = b0 * u + b1 * u1 + b2 * u2 - a1 * z1 - a2 * z2;
    u2 = u1; u1 = u; z2 = z1; z1 = y;
  }
  dE[lid] = vec2<f32>(z1, z2);
  let lastIn = vec2<f32>(u1, u2);
  workgroupBarrier();

  if (lid == 0u) {
    var s1 = st[o + 2u]; var s2 = st[o + 3u];
    for (var c = 0u; c < 256u; c = c + 1u) {
      dS[c] = vec2<f32>(s1, s2);
      let e = dE[c];
      let p = s1; let d = s1 - s2;
      let t1 = e.x + p * pp1 + d * dd1;
      let t2 = e.y + p * pp2 + d * dd2;
      s1 = t1; s2 = t2;
    }
  }
  workgroupBarrier();

  var w1 = dS[lid].x; var w2 = dS[lid].y;
  u1 = iu1; u2 = iu2;
  for (var j = 0u; j < n; j = j + 1u) {
    let u = D[go + i0 + j];
    let y = b0 * u + b1 * u1 + b2 * u2 - a1 * w1 - a2 * w2;
    u2 = u1; u1 = u; w2 = w1; w1 = y;
  }
  dE[lid] = vec2<f32>(w1, w2);
  workgroupBarrier();

  if (lid == 0u) {
    var n1 = st[o + 2u]; var n2 = st[o + 3u];
    for (var c = 0u; c < 256u; c = c + 1u) {
      dN[c] = vec2<f32>(n1, n2);
      let f = dE[c];
      let dp = n1 - dS[c].x;
      let dq = (n1 - n2) - (dS[c].x - dS[c].y);
      let t1 = f.x + dp * pp1 + dq * dd1;
      let t2 = f.y + dp * pp2 + dq * dd2;
      n1 = t1; n2 = t2;
    }
  }
  workgroupBarrier();

  w1 = dN[lid].x; w2 = dN[lid].y;
  u1 = iu1; u2 = iu2;
  for (var j = 0u; j < n; j = j + 1u) {
    let u = D[go + i0 + j];
    let y = b0 * u + b1 * u1 + b2 * u2 - a1 * w1 - a2 * w2;
    u2 = u1; u1 = u; w2 = w1; w1 = y;
    D[go + i0 + j] = y;
  }
  if (i0 + n == N && n > 0u) {
    st[o] = lastIn.x; st[o + 1u] = lastIn.y; st[o + 2u] = w1; st[o + 3u] = w2;
  }
  storageBarrier(); workgroupBarrier();
}

@compute @workgroup_size(256)
fn tailC(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) lid : u32) {
  let t = wid.x >> 1u;
  let ch = wid.x & 1u;
  let f = trackFlags(t, lid);
  if ((f & ACTIVE) == 0u) { return; }
  P = Pall[t];
  let bf = B.blockFrames;
  let C = (bf + 255u) / 256u;
  let i0 = min(lid * C, bf);
  let n = min(i0 + C, bf) - i0;
  let po = t * bf * 2u + ch * bf;
  let go = (t * 2u + ch) * bf;
  let sb = t * 64u + ch * 24u;

  // Drive mode: headroom soft-top + final 1:1 trim (outside the feedback loop), per sample
  if (isDriveMode(f)) {
    for (var j = 0u; j < n; j = j + 1u) {
      D[go + i0 + j] = softTop(D[go + i0 + j], P.dLimT) * P.dOut;
    }
  }

  // per-instance decorrelation allpass (one-pole in disguise): z' = x + a*y, y = -a*x + z.
  // Runs after whichever saturation mode is active.
  if ((f & DRIVE) != 0u) {
    let a = P.colVarAp;
    let so = 56u + ch;
    var z = 0.0;
    for (var j = 0u; j < n; j = j + 1u) {
      let x = D[go + i0 + j];
      let y = -a * x + z;
      z = x + a * y;
    }
    dE[lid] = vec2<f32>(z, 0.0);
    workgroupBarrier();
    if (lid == 0u) {
      var dec = 1.0;
      for (var k = 0u; k < C; k = k + 1u) { dec = dec * a; }
      var c0 = st[t * 64u + so];
      for (var c = 0u; c < 256u; c = c + 1u) {
        dS[c] = vec2<f32>(c0, 0.0);
        c0 = dE[c].x + dec * c0;
      }
    }
    workgroupBarrier();
    z = dS[lid].x;
    for (var j = 0u; j < n; j = j + 1u) {
      let x = D[go + i0 + j];
      let y = -a * x + z;
      z = x + a * y;
      D[go + i0 + j] = y;
    }
    if (i0 + n == bf && n > 0u) { st[t * 64u + so] = z; }
    storageBarrier(); workgroupBarrier();
  }

  if ((f & HPF) != 0u) {
    driveBiquad(lid, i0, n, C, go, sb + 4u, P.hpfB0, P.hpfB1, P.hpfB2, P.hpfA1, P.hpfA2);
  }
  if ((f & EQ) != 0u) {
    driveBiquad(lid, i0, n, C, go, sb + 8u, P.eq0B0, P.eq0B1, P.eq0B2, P.eq0A1, P.eq0A2);
    driveBiquad(lid, i0, n, C, go, sb + 12u, P.eq1B0, P.eq1B1, P.eq1B2, P.eq1A1, P.eq1A2);
    driveBiquad(lid, i0, n, C, go, sb + 16u, P.eq2B0, P.eq2B1, P.eq2B2, P.eq2A1, P.eq2A2);
    driveBiquad(lid, i0, n, C, go, sb + 20u, P.eq3B0, P.eq3B1, P.eq3B2, P.eq3A1, P.eq3A2);
  }

  for (var j = 0u; j < n; j = j + 1u) { sig[po + i0 + j] = D[go + i0 + j]; }
}

// Pass 2: the stereo-linked compressor (needs both channels in lock-step). Only its two
// state-dependent one-pole followers are serial (detector envelope, gain smoothing); the gain
// computer (pow) and the gain application are per-sample and run across the GPU. E is a
// [track][frame] scratch: envelope -> gain target -> smoothed gain, in place.
//   compEnv   workgroup per track, tiled through shared memory, thread 0 runs the recursion
//   compTg    (x = frame group, y = track) tg = pow(env / thresh, ratioInv - 1) above threshold
//   compGain  workgroup per track, smoothed gain g toward tg (attack when it must drop)
//   compApply (x = frame group, y = track) out = in * g * makeup
// A track whose comp is off returns at once from all four (the planes are already final).
var<workgroup> ctile : array<f32, 256>;

fn compActive(t : u32) -> bool {
  if (t >= B.trackCount) { return false; }
  P = Pall[t];
  return P.slotOn != 0u && (P.flags & COMP) != 0u;
}

@compute @workgroup_size(256)
fn compEnv(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) l : u32) {
  let t = wid.x;
  let act = compActive(t);   // not provably uniform: no early return, every thread reaches the barriers
  let bf = B.blockFrames;
  let base = t * bf * 2u;
  var env = 0.0;
  if (act) { env = st[t * 64u + 58u]; }
  for (var t0 = 0u; t0 < bf; t0 = t0 + 256u) {
    let idx = t0 + l;
    if (act && idx < bf) { ctile[l] = max(abs(sig[base + idx]), abs(sig[base + bf + idx])); }
    workgroupBarrier();
    if (act && l == 0u) {
      let m = min(256u, bf - t0);
      for (var j = 0u; j < m; j = j + 1u) {
        let det = ctile[j];
        env = env + select(P.relCoef, P.attCoef, det > env) * (det - env);
        ctile[j] = env;
      }
    }
    workgroupBarrier();
    if (act && idx < bf) { E[t * bf + idx] = ctile[l]; }
    workgroupBarrier();
  }
  if (act && l == 0u) { st[t * 64u + 58u] = env; }
}

@compute @workgroup_size(256)
fn compTg(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) l : u32) {
  let t = wid.y;
  if (!compActive(t)) { return; }
  let bf = B.blockFrames;
  let i = wid.x * 256u + l;
  if (i >= bf) { return; }
  var tg = 1.0;
  let over = E[t * bf + i] / P.threshLin;
  if (over > 1.0) { tg = pow(over, P.ratioInv - 1.0); }
  E[t * bf + i] = tg;
}

@compute @workgroup_size(256)
fn compGain(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) l : u32) {
  let t = wid.x;
  let act = compActive(t);
  let bf = B.blockFrames;
  var g = 0.0;
  if (act) { g = st[t * 64u + 59u]; }
  for (var t0 = 0u; t0 < bf; t0 = t0 + 256u) {
    let idx = t0 + l;
    if (act && idx < bf) { ctile[l] = E[t * bf + idx]; }
    workgroupBarrier();
    if (act && l == 0u) {
      let m = min(256u, bf - t0);
      for (var j = 0u; j < m; j = j + 1u) {
        let tg = ctile[j];
        g = g + select(P.relCoef, P.attCoef, tg < g) * (tg - g);
        ctile[j] = g;
      }
    }
    workgroupBarrier();
    if (act && idx < bf) { E[t * bf + idx] = ctile[l]; }
    workgroupBarrier();
  }
  if (act && l == 0u) { st[t * 64u + 59u] = g; }
}

@compute @workgroup_size(256)
fn compApply(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) l : u32) {
  let t = wid.y;
  if (!compActive(t)) { return; }
  let bf = B.blockFrames;
  let i = wid.x * 256u + l;
  if (i >= bf) { return; }
  let g = E[t * bf + i];
  let base = t * bf * 2u;
  sig[base + i] = sig[base + i] * g * P.makeupLin;
  sig[base + bf + i] = sig[base + bf + i] * g * P.makeupLin;
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
 * Insert **stereo delay**, parallel. Same idea as the reverb: a delay of D samples reads
 * what was written D samples ago, so a chunk of D samples has no internal dependency
 * (reads are old values, writes go to distinct slots). The feedback low-pass
 * `lp[n] = lp[n-1] + damp·(d[n] - lp[n-1])` is an affine recurrence over the chunk and
 * is solved exactly with a segmented scan: 256 threads each run their segment from a
 * zero state, a 256-step carry pass links the segments, and each thread adds the
 * carry's decayed contribution. Ping-pong only changes which channel's filtered value
 * feeds which line, so both channels are scanned before any write. One workgroup.
 *
 *   line : [ch0 (lineLen) | ch1 (lineLen)]   circular, indexed by baseIndex
 *   lpst : [ch0, ch1]                         feedback-LP memory
 *   scr  : [local scan L (block) | local scan R (block)]
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
@group(0) @binding(4) var<storage, read_write> scr : array<f32>;

var<workgroup> segEnd : array<f32, 512>;
var<workgroup> segIn : array<f32, 512>;
var<workgroup> lpState : array<f32, 2>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) tid : u32) {
  let LL = P.lineLen;
  let bf = P.blockFrames;
  let D = P.delaySamples;
  let A = 1.0 - P.damp;
  if (tid == 0u) { lpState[0] = lpst[0]; lpState[1] = lpst[1]; }
  workgroupBarrier();

  var c = 0u;
  loop {
    if (c >= bf) { break; }
    // a chunk must neither outrun the delay (its reads are old values) nor lap the ring (LL - D)
    let n = min(min(D, LL - D), bf - c);
    let S = (n + 255u) / 256u;
    let s0 = min(n, tid * S);
    let s1 = min(n, s0 + S);

    // 1) local scans of the delayed (old) values, zero initial state
    var eL = 0.0;
    var eR = 0.0;
    for (var m = s0; m < s1; m = m + 1u) {
      let r = (P.baseIndex + c + m + LL - D) % LL;
      eL = eL + P.damp * (line[r] - eL);
      eR = eR + P.damp * (line[LL + r] - eR);
      scr[c + m] = eL;
      scr[bf + c + m] = eR;
    }
    segEnd[tid] = eL;
    segEnd[256u + tid] = eR;
    workgroupBarrier();

    // 2) carry into each segment (sequential over 256 segments, one thread per channel)
    if (tid < 2u) {
      var cin = lpState[tid];
      for (var t = 0u; t < 256u; t = t + 1u) {
        segIn[tid * 256u + t] = cin;
        let a0 = min(n, t * S);
        let a1 = min(n, a0 + S);
        cin = pow(A, f32(a1 - a0)) * cin + segEnd[tid * 256u + t];
      }
      lpState[tid] = cin;
    }
    workgroupBarrier();

    // 3) final filtered values, feedback write, output
    for (var m = s0; m < s1; m = m + 1u) {
      let i = c + m;
      let decay = pow(A, f32(m - s0 + 1u));
      let lpL = scr[i] + decay * segIn[tid];
      let lpR = scr[bf + i] + decay * segIn[256u + tid];
      let w = (P.baseIndex + i) % LL;
      let r = (P.baseIndex + i + LL - D) % LL;
      let dL = line[r];
      let dR = line[LL + r];
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
    storageBarrier();
    workgroupBarrier();
    c = c + n;
  }
  if (tid < 2u) { lpst[tid] = lpState[tid]; }
}
`

/**
 * (Serial version, kept for very short delays < 256 samples, where chunks would be tiny.)
 * Insert **stereo delay** — circular delay line per channel, one-pole damping
 * low-pass in the feedback path, wet/dry, optional ping-pong (feedback taken
 * from the opposite channel). One GPU thread does both channels serially so the
 * ping-pong cross-feed is race-free (the recurrence can't parallelise anyway).
 *
 *   line : [ch0 (lineLen) | ch1 (lineLen)]   circular, indexed by baseIndex
 *   lpst : [ch0, ch1]                         feedback-LP memory
 */
export const DELAY_SERIAL_WGSL = /* wgsl */ `
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
 * Insert **5-band parametric EQ** (RBJ biquads in series; band 0 = low-shelf, 1..3 peaking,
 * 4 = high-shelf), clean / linear-phase-agnostic (the "digital" counterpart to the strip's
 * analogue-voiced console EQ).
 *
 * Parallel over TIME. One workgroup (256 threads) per channel; each biquad stage cuts the block
 * into 256 chunks and solves the recursion by a parareal-style scan, so the serial depth is
 * ~3 * blockFrames/256 instead of blockFrames:
 *   1. every chunk runs the recursion from a ZERO state (parallel) -> its end state E;
 *   2. one thread carries a first estimate of the state chunk to chunk: S' = E + M·S, with M the
 *      2x2 transition over a whole chunk (from the CPU, float64; in (value, slope) coordinates —
 *      low poles make the plain (y1,y2) basis cancel ~100:1 and lose float32 precision);
 *   3. every chunk reruns the TRUE recursion from that estimate (parallel) -> exact end state F;
 *   4. one thread corrects the carry with the small error left: S_new' = F(S_old) + M·(S_new - S_old);
 *   5. every chunk reruns from S_new and writes the output.
 * Accuracy matches the old sample-by-sample loop (tests/eq5-chunking.test.ts pins the math;
 * live float32 checked against a float64 reference, see DEVELOP.md).
 * State st: per channel base = ch*20, band k at base + k*4 = x1,x2,y1,y2.
 * mt[k] = (MP.y1, MP.y2, MD.y1, MD.y2): chunk transition applied to a (value, slope) state.
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
  _p1 : f32,
  mt : array<vec4<f32>, 5>,
};
@group(0) @binding(0) var<uniform> P : EP;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>; // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> st : array<f32>;

var<workgroup> wE : array<vec2<f32>, 256>;  // per-chunk end state: zero-start, then the true rerun
var<workgroup> wS : array<vec2<f32>, 256>;  // first carried estimate of the state entering each chunk
var<workgroup> wN : array<vec2<f32>, 256>;  // corrected state entering each chunk

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) lid : u32) {
  let ch = wid.x;
  let N = P.blockFrames;
  let sb = ch * N;
  let C = (N + 255u) / 256u;
  let i0 = min(lid * C, N);
  let n = min(i0 + C, N) - i0;
  let base = ch * 20u;
  let cf = array<f32, 25>(
    P.b0_0, P.b1_0, P.b2_0, P.a1_0, P.a2_0,
    P.b0_1, P.b1_1, P.b2_1, P.a1_1, P.a2_1,
    P.b0_2, P.b1_2, P.b2_2, P.a1_2, P.a2_2,
    P.b0_3, P.b1_3, P.b2_3, P.a1_3, P.a2_3,
    P.b0_4, P.b1_4, P.b2_4, P.a1_4, P.a2_4);
  for (var k = 0u; k < 5u; k = k + 1u) {
    let b0 = cf[k * 5u]; let b1 = cf[k * 5u + 1u]; let b2 = cf[k * 5u + 2u];
    let a1 = cf[k * 5u + 3u]; let a2 = cf[k * 5u + 4u];
    let m = P.mt[k];
    let o = base + k * 4u;

    // inputs just before this chunk (x[-1], x[-2] come from the state)
    var iu1 = st[o]; var iu2 = st[o + 1u];
    if (i0 >= 2u) { iu1 = sig[sb + i0 - 1u]; iu2 = sig[sb + i0 - 2u]; }
    else if (i0 == 1u) { iu1 = sig[sb]; iu2 = st[o]; }
    storageBarrier(); workgroupBarrier();

    // 1. zero-state run -> chunk end state (outputs not stored)
    var u1 = iu1; var u2 = iu2; var z1 = 0.0; var z2 = 0.0;
    for (var j = 0u; j < n; j = j + 1u) {
      let u = sig[sb + i0 + j];
      let y = b0 * u + b1 * u1 + b2 * u2 - a1 * z1 - a2 * z2;
      u2 = u1; u1 = u; z2 = z1; z1 = y;
    }
    wE[lid] = vec2<f32>(z1, z2);
    // the thread owning the block's last sample now holds its last two inputs
    var lastIn = vec2<f32>(0.0, 0.0);
    if (i0 + n == N && n > 0u) { lastIn = vec2<f32>(u1, u2); }
    workgroupBarrier();

    // 2. first carry estimate (serial over 256)
    if (lid == 0u) {
      var s1 = st[o + 2u]; var s2 = st[o + 3u];
      for (var c = 0u; c < 256u; c = c + 1u) {
        wS[c] = vec2<f32>(s1, s2);
        let e = wE[c];
        let p = s1; let d = s1 - s2;
        let t1 = e.x + p * m.x + d * m.z;
        let t2 = e.y + p * m.y + d * m.w;
        s1 = t1; s2 = t2;
      }
    }
    workgroupBarrier();

    // 3. true recursion from the estimate -> exact end state of each chunk
    var w1 = wS[lid].x; var w2 = wS[lid].y;
    u1 = iu1; u2 = iu2;
    for (var j = 0u; j < n; j = j + 1u) {
      let u = sig[sb + i0 + j];
      let y = b0 * u + b1 * u1 + b2 * u2 - a1 * w1 - a2 * w2;
      u2 = u1; u1 = u; w2 = w1; w1 = y;
    }
    wE[lid] = vec2<f32>(w1, w2);
    workgroupBarrier();

    // 4. correct the carry with the small remaining error
    if (lid == 0u) {
      var n1 = st[o + 2u]; var n2 = st[o + 3u];
      for (var c = 0u; c < 256u; c = c + 1u) {
        wN[c] = vec2<f32>(n1, n2);
        let f = wE[c];
        let dp = n1 - wS[c].x;
        let dd = (n1 - n2) - (wS[c].x - wS[c].y);
        let t1 = f.x + dp * m.x + dd * m.z;
        let t2 = f.y + dp * m.y + dd * m.w;
        n1 = t1; n2 = t2;
      }
    }
    workgroupBarrier();

    // 5. final run from the corrected state, writing the output (all reads of sig for this
    //    stage are behind us; neighbours only needed their pre-chunk inputs, read above)
    w1 = wN[lid].x; w2 = wN[lid].y;
    u1 = iu1; u2 = iu2;
    storageBarrier(); workgroupBarrier();
    for (var j = 0u; j < n; j = j + 1u) {
      let u = sig[sb + i0 + j];
      let y = b0 * u + b1 * u1 + b2 * u2 - a1 * w1 - a2 * w2;
      sig[sb + i0 + j] = y;
      u2 = u1; u1 = u; w2 = w1; w1 = y;
    }
    // block-end state for the next block
    if (i0 + n == N && n > 0u) {
      st[o] = lastIn.x; st[o + 1u] = lastIn.y;
    }
    storageBarrier(); workgroupBarrier();
    if (lid == 0u && N >= 2u) { st[o + 2u] = sig[sb + N - 1u]; st[o + 3u] = sig[sb + N - 2u]; }
  }
}
`

/**
 * Insert **tube program EQ**. Signal path:
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
 * Master **bus compressor** — stereo-linked, feed-forward, soft-knee, SL-G-bus
 * voiced (fixed 2 / 4 / 10 ratios, stepped attack, fixed-or-program-dependent
 * release). One knob of **bright harmonic drive** sits after the gain reduction:
 * HF pre-emphasis → asymmetric soft-clip (bias = 2nd, tanh = odd) → DC block →
 * a baked bright high-shelf. Subtle by design — its blend is `driveAmt` — and it
 * gives the "明るめの倍音" colour the user asked for. `Mix` blends the whole
 * processed path back against the dry input (parallel compression).
 *
 * Three kernels (the old single thread did all of it serially, sample by sample):
 *   envs  — the stereo-linked detector envelope: the ONLY truly serial part (state-dependent
 *           attack / release). One workgroup, tiled through shared memory, thread 0 runs it.
 *   prep  — per-sample gain computer (log / pow) and gain application -> W (parallel everywhere).
 *   scan  — the bright-drive chain per channel (one 256-thread workgroup each). Its three
 *           recursions are LINEAR (emphasis one-pole, DC one-pole, high-shelf biquad) with only
 *           per-sample nonlinearities between them, so each is solved by a chunked scan
 *           (zero-state chunks -> carry -> true run; the biquad adds the parareal correction, see
 *           EQ5_WGSL). Then the dry/wet mix writes the result back to sig.
 * W: [L | R] work planes. E: detector envelope. dec = one-pole carry per whole chunk
 * ((1-a)^chunk, float64 from the CPU); mt = the biquad's chunk transition (see eq5.ts).
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
  _pad1 : f32,
  mt : vec4<f32>,       // high-shelf chunk transition (MP.y1, MP.y2, MD.y1, MD.y2)
  dec : vec4<f32>,      // x = emphasis one-pole chunk decay, y = DC one-pole chunk decay
};
@group(0) @binding(0) var<uniform> P : BC;
@group(0) @binding(1) var<storage, read_write> sig : array<f32>;  // [L(block) | R(block)]
@group(0) @binding(2) var<storage, read_write> st : array<f32>;
@group(0) @binding(3) var<storage, read_write> E : array<f32>;    // detector envelope per sample
@group(0) @binding(4) var<storage, read_write> W : array<f32>;    // work planes [L | R]

const LOG10 : f32 = 0.43429448190325176;  // 1 / ln(10)
const DC_A : f32 = 0.0016;

var<workgroup> tile : array<f32, 256>;
var<workgroup> wE : array<vec2<f32>, 256>;
var<workgroup> wS : array<vec2<f32>, 256>;
var<workgroup> wN : array<vec2<f32>, 256>;

@compute @workgroup_size(256)
fn envs(@builtin(local_invocation_index) l : u32) {
  let bf = P.blockFrames;
  var env = st[0];
  for (var t0 = 0u; t0 < bf; t0 = t0 + 256u) {
    let idx = t0 + l;
    if (idx < bf) { tile[l] = max(abs(sig[idx]), abs(sig[bf + idx])); }
    workgroupBarrier();
    if (l == 0u) {
      let m = min(256u, bf - t0);
      for (var j = 0u; j < m; j = j + 1u) {
        let det = tile[j];
        var coef = P.attCoef;
        if (det <= env) {
          let slam = clamp((env - det) * 4.0, 0.0, 1.0);
          coef = mix(P.relCoef, P.relCoefFast, P.autoRel * slam);
        }
        env = env + coef * (det - env);
        tile[j] = env;
      }
    }
    workgroupBarrier();
    if (idx < bf) { E[idx] = tile[l]; }
    workgroupBarrier();
  }
  if (l == 0u) { st[0] = env; }
}

@compute @workgroup_size(256)
fn prep(@builtin(global_invocation_id) gid : vec3<u32>) {
  let bf = P.blockFrames;
  let i = gid.x;
  if (i >= bf) { return; }
  // gain computer — soft knee, in dB
  let envDb = 20.0 * log(max(E[i], 1e-6)) * LOG10;
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
  W[i] = sig[i] * g * P.makeupLin;
  W[bf + i] = sig[bf + i] * g * P.makeupLin;
}

// Bright-harmonic drive, per-sample part after the emphasis one-pole (stage 0) / the DC one-pole
// (stage 1) has produced its state e for this sample. x is that stage's input.
fn stageOut(stage : u32, x : f32, e : f32) -> f32 {
  if (stage == 0u) {
    let pe = x + P.emphAmt * (x - e);
    let shp = tanh(pe * P.driveG + P.bias) - P.biasC;
    return mix(x, shp, P.driveAmt);
  }
  return x - e;
}

// One-pole stage on the work plane, in place: e += a*(x - e), out = stageOut(x, e).
fn onePole(stage : u32, lid : u32, ch : u32, i0 : u32, n : u32, a : f32, dec : f32, so : u32) {
  let sb = ch * P.blockFrames;
  var e = 0.0;
  for (var j = 0u; j < n; j = j + 1u) {
    let x = W[sb + i0 + j];
    e = e + a * (x - e);
  }
  wE[lid] = vec2<f32>(e, 0.0);
  workgroupBarrier();
  if (lid == 0u) {
    var c0 = st[so];
    for (var c = 0u; c < 256u; c = c + 1u) {
      wS[c] = vec2<f32>(c0, 0.0);
      c0 = wE[c].x + dec * c0;
    }
  }
  workgroupBarrier();
  e = wS[lid].x;
  for (var j = 0u; j < n; j = j + 1u) {
    let x = W[sb + i0 + j];
    e = e + a * (x - e);
    W[sb + i0 + j] = stageOut(stage, x, e);
  }
  if (i0 + n == P.blockFrames && n > 0u) { st[so] = e; }
  storageBarrier(); workgroupBarrier();
}

@compute @workgroup_size(256)
fn scan(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) lid : u32) {
  let ch = wid.x;
  let N = P.blockFrames;
  let sb = ch * N;
  let C = (N + 255u) / 256u;
  let i0 = min(lid * C, N);
  let n = min(i0 + C, N) - i0;

  onePole(0u, lid, ch, i0, n, P.emphA, P.dec.x, 2u + ch);
  onePole(1u, lid, ch, i0, n, DC_A, P.dec.y, 4u + ch);

  // high-shelf biquad on W -> sig (parareal scan, see EQ5_WGSL)
  let b0 = P.hsB0; let b1 = P.hsB1; let b2 = P.hsB2; let a1 = P.hsA1; let a2 = P.hsA2;
  let m = P.mt;
  let o = 6u + ch * 4u;
  var iu1 = st[o]; var iu2 = st[o + 1u];
  if (i0 >= 2u) { iu1 = W[sb + i0 - 1u]; iu2 = W[sb + i0 - 2u]; }
  else if (i0 == 1u) { iu1 = W[sb]; iu2 = st[o]; }
  storageBarrier(); workgroupBarrier();

  var u1 = iu1; var u2 = iu2; var z1 = 0.0; var z2 = 0.0;
  for (var j = 0u; j < n; j = j + 1u) {
    let u = W[sb + i0 + j];
    let y = b0 * u + b1 * u1 + b2 * u2 - a1 * z1 - a2 * z2;
    u2 = u1; u1 = u; z2 = z1; z1 = y;
  }
  wE[lid] = vec2<f32>(z1, z2);
  let lastIn = vec2<f32>(u1, u2);
  workgroupBarrier();

  if (lid == 0u) {
    var s1 = st[o + 2u]; var s2 = st[o + 3u];
    for (var c = 0u; c < 256u; c = c + 1u) {
      wS[c] = vec2<f32>(s1, s2);
      let e = wE[c];
      let p = s1; let d = s1 - s2;
      let t1 = e.x + p * m.x + d * m.z;
      let t2 = e.y + p * m.y + d * m.w;
      s1 = t1; s2 = t2;
    }
  }
  workgroupBarrier();

  var w1 = wS[lid].x; var w2 = wS[lid].y;
  u1 = iu1; u2 = iu2;
  for (var j = 0u; j < n; j = j + 1u) {
    let u = W[sb + i0 + j];
    let y = b0 * u + b1 * u1 + b2 * u2 - a1 * w1 - a2 * w2;
    u2 = u1; u1 = u; w2 = w1; w1 = y;
  }
  wE[lid] = vec2<f32>(w1, w2);
  workgroupBarrier();

  if (lid == 0u) {
    var n1 = st[o + 2u]; var n2 = st[o + 3u];
    for (var c = 0u; c < 256u; c = c + 1u) {
      wN[c] = vec2<f32>(n1, n2);
      let f = wE[c];
      let dp = n1 - wS[c].x;
      let dd = (n1 - n2) - (wS[c].x - wS[c].y);
      let t1 = f.x + dp * m.x + dd * m.z;
      let t2 = f.y + dp * m.y + dd * m.w;
      n1 = t1; n2 = t2;
    }
  }
  workgroupBarrier();

  w1 = wN[lid].x; w2 = wN[lid].y;
  u1 = iu1; u2 = iu2;
  for (var j = 0u; j < n; j = j + 1u) {
    let u = W[sb + i0 + j];
    let y = b0 * u + b1 * u1 + b2 * u2 - a1 * w1 - a2 * w2;
    u2 = u1; u1 = u; w2 = w1; w1 = y;
    sig[sb + i0 + j] = mix(sig[sb + i0 + j], y * P.outTrim, P.mix);
  }
  if (i0 + n == N && n > 0u) {
    st[o] = lastIn.x; st[o + 1u] = lastIn.y; st[o + 2u] = w1; st[o + 3u] = w2;
  }
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
 * mastering insert.
 *
 * Only the gain envelope is truly recursive (peak-hold + attack/release smoothing), so it is the
 * only serial part (`envs`, one thread, ~10 instructions a sample). Everything else is per-sample
 * and runs across the whole GPU:
 *   prep  — input gain, peak, per-sample gain target (parallel; copies the gained input to X)
 *   envs  — peak-hold + gain envelope over the block (serial, lean)  G: target -> envelope
 *   apply — out[i] = clamp(delayed input * G[i]) (parallel; the delayed input is X[i-lookahead],
 *           or the ring for the first `lookahead` samples of the block)
 *   save  — refresh the ring with the block's last samples for the next block
 * Same arithmetic as the old single-thread loop, so the output is bit-identical.
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
@group(0) @binding(4) var<storage, read_write> X : array<f32>;     // gained input [L | R]
@group(0) @binding(5) var<storage, read_write> G : array<f32>;     // gain target, then envelope

@compute @workgroup_size(256)
fn prep(@builtin(global_invocation_id) gid : vec3<u32>) {
  let bf = P.blockFrames;
  let i = gid.x;
  if (i >= bf) { return; }
  let inL = sig[i] * P.inGain;
  let inR = sig[bf + i] * P.inGain;
  X[i] = inL;
  X[bf + i] = inR;
  let peak = max(abs(inL), abs(inR));
  var gt = 1.0;
  if (peak > P.ceilingLin) { gt = P.ceilingLin / peak; }
  G[i] = gt;
}

// The recursion itself is a handful of register ops; what hurt was a global-memory round trip per
// sample. So the workgroup stages 256 targets at a time through shared memory (coalesced), thread 0
// runs the recursion on them, and everyone writes the envelope back.
var<workgroup> tile : array<f32, 256>;

@compute @workgroup_size(256)
fn envs(@builtin(local_invocation_index) l : u32) {
  let bf = P.blockFrames;
  var gEnv = stt[0];
  var gHold = stt[1];
  for (var t0 = 0u; t0 < bf; t0 = t0 + 256u) {
    let idx = t0 + l;
    if (idx < bf) { tile[l] = G[idx]; }
    workgroupBarrier();
    if (l == 0u) {
      let m = min(256u, bf - t0);
      for (var j = 0u; j < m; j = j + 1u) {
        gHold = min(tile[j], gHold + P.holdRel * (1.0 - gHold));
        let c = select(P.relCoef, P.atkCoef, gHold < gEnv);
        gEnv = gEnv + c * (gHold - gEnv);
        tile[j] = gEnv;
      }
    }
    workgroupBarrier();
    if (idx < bf) { G[idx] = tile[l]; }
    workgroupBarrier();
  }
  if (l == 0u) { stt[0] = gEnv; stt[1] = gHold; }
}

@compute @workgroup_size(256)
fn apply(@builtin(global_invocation_id) gid : vec3<u32>) {
  let bf = P.blockFrames;
  let i = gid.x;
  if (i >= bf) { return; }
  let LL = P.lineLen;
  let la = P.lookahead;
  var xl : f32;
  var xr : f32;
  if (i >= la) {
    xl = X[i - la];
    xr = X[bf + i - la];
  } else {
    let r = (P.baseIndex + i + LL - la) % LL;
    xl = line[r];
    xr = line[LL + r];
  }
  let g = G[i];
  let yl = clamp(xl * g, -P.ceilingLin, P.ceilingLin);
  let yr = clamp(xr * g, -P.ceilingLin, P.ceilingLin);
  sig[i] = yl * P.outTrim;
  sig[bf + i] = yr * P.outTrim;
}

@compute @workgroup_size(256)
fn save(@builtin(global_invocation_id) gid : vec3<u32>) {
  let bf = P.blockFrames;
  let i = gid.x;
  if (i >= bf || i + P.lineLen < bf) { return; }   // only the last lineLen samples survive in the ring
  let w = (P.baseIndex + i) % P.lineLen;
  line[w] = X[i];
  line[P.lineLen + w] = X[bf + i];
}
`

/**
 * Simple polyphonic synth, rendered **offline on the GPU** from a note list into
 * the instrument track's planar buffers (the track then plays like any audio
 * source: strip, inserts, mix). One workgroup = 256 output frames; the group first
 * gathers the notes that overlap its block into shared memory, then each thread
 * sums those voices for its own frame. Voices are stateless: oscillator phase is a
 * wrapping u32 fixed-point accumulator (`frames-since-start * increment`), exact for
 * arbitrarily long notes, so no per-voice state is needed.
 *
 * notes[i] = (startFrame, endFrame, freqHz, velocity 0..1), sorted by start.
 * Two oscillators detuned ±detune (A → left, B → right by `spread`) + a sub sine
 * one octave down. Saw / square are PolyBLEP band-limited. ADSR is analytic in the
 * time since note-on; release starts at note-off from the level reached then.
 */
export const SYNTH_WGSL = /* wgsl */ `
struct SY {
  blockFrames : u32, // frames to write into out*[0..blockFrames)
  nNotes : u32,
  wave : u32,        // 0 saw, 1 square, 2 triangle, 3 sine
  base : u32,        // absolute frame of out*[0] (whole render = 0; blocks for live use)
  sampleRate : f32,
  detune : f32,      // cents (each osc ±detune/2)
  sub : f32,         // sub-oscillator level
  spread : f32,      // 0 mono .. 1 hard-split detuned oscillators
  atk : f32, dec : f32, sus : f32, rel : f32,
  gain : f32,
  pw : f32,          // square pulse width
  _p1 : f32, _p2 : f32,
};
@group(0) @binding(0) var<uniform> P : SY;
@group(0) @binding(1) var<storage, read> notes : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outL : array<f32>;
@group(0) @binding(3) var<storage, read_write> outR : array<f32>;

const MAXV : u32 = 96u;
var<workgroup> vCount : atomic<u32>;
var<workgroup> vList : array<u32, 96>;

const TAU : f32 = 6.28318530718;

fn blep(t : f32, dt : f32) -> f32 {
  if (t < dt) { let x = t / dt; return x + x - x * x - 1.0; }
  if (t > 1.0 - dt) { let x = (t - 1.0) / dt; return x * x + x + x + 1.0; }
  return 0.0;
}

fn osc(phase : u32, dt : f32) -> f32 {
  let p = f32(phase >> 8u) * (1.0 / 16777216.0);
  switch (P.wave) {
    case 0u: { return 2.0 * p - 1.0 - blep(p, dt); }
    case 1u: {
      var v = select(-1.0, 1.0, p < P.pw);
      v = v + blep(p, dt) - blep(fract(p + 1.0 - P.pw), dt);
      return v;
    }
    case 2u: { return 1.0 - 4.0 * abs(p - 0.5); }
    default: { return sin(TAU * p); }
  }
}

fn env0(t : f32) -> f32 {
  if (t < P.atk) { return t / max(P.atk, 1e-5); }
  if (t < P.atk + P.dec) {
    let x = (t - P.atk) / max(P.dec, 1e-5);
    return 1.0 - (1.0 - P.sus) * x;
  }
  return P.sus;
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg : vec3<u32>, @builtin(local_invocation_id) lid : vec3<u32>) {
  let b0 = f32(P.base + wg.x * 256u);
  let b1 = b0 + 256.0;
  let relFrames = P.rel * P.sampleRate;

  if (lid.x == 0u) { atomicStore(&vCount, 0u); }
  workgroupBarrier();
  for (var i = lid.x; i < P.nNotes; i = i + 256u) {
    let n = notes[i];
    if (n.x < b1 && n.y + relFrames >= b0) {
      let k = atomicAdd(&vCount, 1u);
      if (k < MAXV) { vList[k] = i; }
    }
  }
  workgroupBarrier();

  let i0 = wg.x * 256u + lid.x;
  if (i0 >= P.blockFrames) { return; }
  let f = P.base + i0;
  let cnt = min(atomicLoad(&vCount), MAXV);
  let ff = f32(f);
  var l = 0.0;
  var r = 0.0;
  for (var k = 0u; k < cnt; k = k + 1u) {
    let n = notes[vList[k]];
    if (ff < n.x) { continue; }
    let t = (ff - n.x) / P.sampleRate;
    let tOff = (n.y - n.x) / P.sampleRate;
    var e : f32;
    if (t <= tOff) {
      e = env0(t);
    } else {
      let x = clamp((t - tOff) / max(P.rel, 1e-4), 0.0, 1.0);
      e = env0(tOff) * (1.0 - x) * (1.0 - x);
    }
    if (e <= 0.0) { continue; }

    let nFrames = u32(ff - n.x);
    let dt = n.z / P.sampleRate;
    let dA = exp2(P.detune / 2400.0);
    let incA = u32(clamp(dt * dA, 0.0, 0.49) * 4294967296.0);
    let incB = u32(clamp(dt / dA, 0.0, 0.49) * 4294967296.0);
    let incS = u32(clamp(dt * 0.5, 0.0, 0.49) * 4294967296.0);
    let a = osc(nFrames * incA, dt * dA);
    let b = osc(nFrames * incB, dt / dA);
    let s = sin(TAU * f32((nFrames * incS) >> 8u) * (1.0 / 16777216.0)) * P.sub;
    let mono = 0.5 * (a + b) + s;
    let amp = e * n.w;
    l = l + amp * (mono + P.spread * (a - 0.5 * (a + b)));
    r = r + amp * (mono + P.spread * (b - 0.5 * (a + b)));
  }
  let g = P.gain * 0.25;
  outL[i0] = tanh(l * g);
  outR[i0] = tanh(r * g);
}
`

/**
 * Synth post filter: a TPT state-variable low-pass, serial over the buffer (a
 * recursive filter), run in chunks so one dispatch never holds the GPU for long.
 * One thread per channel; the two filter states persist between chunks in \`st\`.
 */
export const SYNTH_FILTER_WGSL = /* wgsl */ `
struct SF {
  offset : u32,
  count : u32,
  total : u32,
  _p : u32,
  g : f32,      // tan(pi * fc / sr)
  k : f32,      // damping = 1/Q
  _q0 : f32, _q1 : f32,
};
@group(0) @binding(0) var<uniform> P : SF;
@group(0) @binding(1) var<storage, read_write> bufL : array<f32>;
@group(0) @binding(2) var<storage, read_write> bufR : array<f32>;
@group(0) @binding(3) var<storage, read_write> st : array<f32>;   // [ic1eqL, ic2eqL, ic1eqR, ic2eqR]

@compute @workgroup_size(2)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ch = gid.x;
  if (ch >= 2u) { return; }
  var ic1 = st[ch * 2u];
  var ic2 = st[ch * 2u + 1u];
  let a1 = 1.0 / (1.0 + P.g * (P.g + P.k));
  let a2 = P.g * a1;
  let a3 = P.g * a2;
  let end = min(P.offset + P.count, P.total);
  for (var i = P.offset; i < end; i = i + 1u) {
    var v0 : f32;
    if (ch == 0u) { v0 = bufL[i]; } else { v0 = bufR[i]; }
    let v3 = v0 - ic2;
    let v1 = a1 * ic1 + a2 * v3;
    let v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2.0 * v1 - ic1;
    ic2 = 2.0 * v2 - ic2;
    if (ch == 0u) { bufL[i] = v2; } else { bufR[i] = v2; }
  }
  st[ch * 2u] = ic1;
  st[ch * 2u + 1u] = ic2;
}
`

/**
 * Analog-style drum machine, rendered offline on the GPU from a note list (same
 * scheme as SYNTH_WGSL: a workgroup gathers the hits that overlap its 256-frame block,
 * each thread sums their voices). Every voice is a closed-form function of the time
 * since the hit, so no per-voice state exists: pitch sweeps are integrated analytically,
 * noise is a hash of the (rate-quantised) time, band-limited by interpolation.
 *
 * notes[i] = (startFrame, lastFrame, voice, velocity 0..1); `lastFrame` is where the
 * voice has died out or been choked (closed hat cutting an open hat), prepared on the CPU.
 *
 * Voices: 0 kick, 1 snare, 2 clap, 3 closed hat, 4 open hat, 5/6/7 tom lo/mid/hi,
 * 8 rim, 9 cowbell, 10 clave, 11 cymbal.
 */
export const DRUMS_WGSL = /* wgsl */ `
struct DR {
  blockFrames : u32,
  nNotes : u32,
  base : u32,
  _p0 : u32,
  sampleRate : f32,
  tune : f32,        // pitch ratio for the whole kit (1 = as designed)
  kickDecay : f32,   // kick length multiplier
  kickPunch : f32,   // kick pitch-sweep depth (0..1)
  snareSnap : f32,   // snare noise level
  hatDecay : f32,    // hat / cymbal length multiplier
  gain : f32,
  _p1 : f32,
};
@group(0) @binding(0) var<uniform> P : DR;
@group(0) @binding(1) var<storage, read> notes : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outL : array<f32>;
@group(0) @binding(3) var<storage, read_write> outR : array<f32>;

const MAXV : u32 = 96u;
var<workgroup> vCount : atomic<u32>;
var<workgroup> vList : array<u32, 96>;

const TAU : f32 = 6.28318530718;

fn hash(n : u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) * (1.0 / 2147483648.0) - 1.0;
}

// Band-limited noise: random values at \`rate\` Hz, smoothly interpolated, so its energy
// stays below ~rate/2 whatever the project sample rate is.
fn lpnoise(t : f32, rate : f32, seed : u32) -> f32 {
  let x = max(t, 0.0) * rate;
  let i = u32(floor(x));
  let fr = x - floor(x);
  let s = fr * fr * (3.0 - 2.0 * fr);
  return mix(hash(i * 2654435761u + seed), hash((i + 1u) * 2654435761u + seed), s);
}

fn sq(phase : f32) -> f32 { return select(-1.0, 1.0, fract(phase) < 0.5); }

// square wave built from its first four odd harmonics (band-limited, no aliasing)
fn sqbl(phase : f32) -> f32 {
  let x = TAU * fract(phase);
  return 1.2732395 * (sin(x) + sin(3.0 * x) / 3.0 + sin(5.0 * x) / 5.0 + sin(7.0 * x) / 7.0);
}

// sine whose frequency decays exponentially f0 -> f1 (time constant tc): phase integrated in closed form
fn sweep(t : f32, f0 : f32, f1 : f32, tc : f32) -> f32 {
  return sin(TAU * (f1 * t + (f0 - f1) * tc * (1.0 - exp(-t / tc))));
}

// metallic hat / cymbal core: six detuned squares, high-passed by a short comb (t - t0)
fn metal(t : f32, k : f32) -> f32 {
  let d = 1.0 / 12000.0;
  var a = 0.0;
  var b = 0.0;
  let fs = array<f32, 6>(205.3, 304.4, 369.6, 522.7, 540.0, 800.0);
  for (var j = 0u; j < 6u; j = j + 1u) {
    a = a + sq(fs[j] * k * t);
    b = b + sq(fs[j] * k * (t - d));
  }
  return (a - b) * (1.0 / 6.0);
}

fn atk(t : f32, a : f32) -> f32 { return min(1.0, t / a); }

fn voice(id : u32, t : f32, vel : f32) -> f32 {
  let k = P.tune;
  if (id == 0u) {
    // kick: sine sweeping ~150 -> 48 Hz, long decay, warm saturation
    let fs = (48.0 + 110.0 * P.kickPunch) * k;
    let s = sweep(t, fs, 48.0 * k, 0.04);
    let env = exp(-t / (0.22 * P.kickDecay)) * atk(t, 0.0015);
    return tanh(1.6 * s * env) * 1.1;
  }
  if (id == 1u) {
    // snare: two tones + high-passed noise
    let tone = sin(TAU * 180.0 * k * t) * exp(-t / 0.055) + 0.55 * sin(TAU * 330.0 * k * t) * exp(-t / 0.035);
    let nz = (lpnoise(t, 12000.0, 11u) - lpnoise(t, 1800.0, 11u)) * exp(-t / 0.10) * P.snareSnap;
    return 0.55 * tone + 0.8 * nz;
  }
  if (id == 2u) {
    // clap: three tight noise bursts then a tail, band-passed around 1-2 kHz
    var env = 0.0;
    for (var j = 0u; j < 3u; j = j + 1u) {
      let tj = t - f32(j) * 0.0105;
      if (tj >= 0.0) { env = env + exp(-tj / 0.0035); }
    }
    let tt = t - 0.0315;
    if (tt >= 0.0) { env = env + 0.9 * exp(-tt / 0.085); }
    let nz = lpnoise(t, 5000.0, 23u) - lpnoise(t, 700.0, 23u);
    return 0.8 * nz * min(env, 1.4);
  }
  if (id == 3u || id == 4u) {
    let tc = select(0.022, 0.20, id == 4u) * P.hatDecay;
    let nz = lpnoise(t, 15000.0, 31u) - lpnoise(t, 4000.0, 31u);
    return (0.5 * metal(t, k) + 0.25 * nz) * exp(-t / tc) * atk(t, 0.0006);
  }
  if (id == 5u || id == 6u || id == 7u) {
    let base = select(select(210.0, 150.0, id == 6u), 100.0, id == 5u) * k;
    let s = sweep(t, base * 1.7, base, 0.05);
    return 0.9 * s * exp(-t / select(0.16, 0.26, id == 5u)) * atk(t, 0.001);
  }
  if (id == 8u) {
    // rim shot: two short resonances + click
    let r = 0.6 * sin(TAU * 1667.0 * k * t) * exp(-t / 0.005) + 0.5 * sin(TAU * 455.0 * k * t) * exp(-t / 0.010);
    return r + 0.25 * (lpnoise(t, 9000.0, 41u)) * exp(-t / 0.002);
  }
  if (id == 9u) {
    // cowbell: two square waves, quick bite then a short ring
    // band-limited squares (first four odd harmonics): the plain squares' upper harmonics would fold back as hiss
    let s = 0.5 * (sqbl(540.0 * k * t) + sqbl(800.0 * k * t));
    return 0.5 * s * (0.6 * exp(-t / 0.012) + 0.4 * exp(-t / 0.14));
  }
  if (id == 10u) {
    return 0.8 * sin(TAU * 2450.0 * k * t) * exp(-t / 0.018) + 0.2 * sin(TAU * 4100.0 * k * t) * exp(-t / 0.008);
  }
  if (id >= 12u && id <= 14u) {
    // djembe: 12 bass (deep open), 13 tone (rim of the head), 14 slap (sharp, noisy)
    if (id == 12u) {
      let s = sweep(t, 165.0 * k, 88.0 * k, 0.06);
      return 0.95 * s * exp(-t / 0.30) * atk(t, 0.002) + 0.12 * lpnoise(t, 900.0, 61u) * exp(-t / 0.03);
    }
    if (id == 13u) {
      let s = sweep(t, 270.0 * k, 205.0 * k, 0.03);
      return 0.8 * (s + 0.25 * sin(TAU * 205.0 * k * 2.4 * t)) * exp(-t / 0.13) * atk(t, 0.001);
    }
    let sl = lpnoise(t, 9000.0, 67u) - lpnoise(t, 1800.0, 67u);
    return 0.75 * sl * exp(-t / 0.045) + 0.35 * sin(TAU * 430.0 * k * t) * exp(-t / 0.03);
  }
  if (id >= 15u && id <= 16u) {
    // guiro: a scraped row of ridges — a pulse train of short bright noise bursts
    let dur = select(0.11, 0.34, id == 16u);
    if (t > dur) { return 0.0; }
    let period = select(0.0072, 0.0085, id == 16u);
    let ph = fract(t / period);
    let ridge = exp(-ph * period / 0.0013);
    let nz = lpnoise(t, 11000.0, 71u) - lpnoise(t, 2600.0, 71u);
    let shape = select(1.0, 1.0 - 0.6 * (t / dur), id == 16u);
    return 0.7 * (nz + 0.3 * sin(TAU * 3300.0 * k * t)) * ridge * shape * atk(t, 0.002);
  }
  if (id >= 17u && id <= 21u) {
    // small hand drums: 17/18 bongo high / low, 19 conga muted, 20 conga open, 21 conga low
    var f0 = 470.0;
    var f1 = 400.0;
    var tc = 0.11;
    if (id == 18u) { f0 = 340.0; f1 = 285.0; tc = 0.15; }
    if (id == 19u) { f0 = 365.0; f1 = 335.0; tc = 0.055; }
    if (id == 20u) { f0 = 350.0; f1 = 305.0; tc = 0.22; }
    if (id == 21u) { f0 = 255.0; f1 = 215.0; tc = 0.28; }
    let body = sweep(t, f0 * k, f1 * k, 0.018) + 0.2 * sin(TAU * f1 * k * 2.3 * t) * exp(-t / 0.04);
    let slap = (lpnoise(t, 8000.0, 83u) - lpnoise(t, 2200.0, 83u)) * exp(-t / 0.006);
    return 0.85 * body * exp(-t / tc) * atk(t, 0.0008) + 0.35 * slap;
  }
  // 11: cymbal — hat core, longer, with more noise
  let nz = lpnoise(t, 16000.0, 53u) - lpnoise(t, 3500.0, 53u);
  return (0.35 * metal(t, 0.93 * k) + 0.4 * nz) * exp(-t / (0.55 * P.hatDecay)) * atk(t, 0.001);
}

fn pan(id : u32) -> f32 {
  let p = array<f32, 22>(0.0, 0.0, 0.1, 0.25, 0.25, -0.3, 0.0, 0.3, -0.2, 0.2, -0.1, 0.3,
                         -0.15, -0.05, 0.1, 0.35, 0.35, 0.2, 0.05, 0.15, -0.05, -0.25);
  return p[min(id, 21u)];
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg : vec3<u32>, @builtin(local_invocation_id) lid : vec3<u32>) {
  let b0 = f32(P.base + wg.x * 256u);
  let b1 = b0 + 256.0;
  if (lid.x == 0u) { atomicStore(&vCount, 0u); }
  workgroupBarrier();
  for (var i = lid.x; i < P.nNotes; i = i + 256u) {
    let n = notes[i];
    if (n.x < b1 && n.y >= b0) {
      let k = atomicAdd(&vCount, 1u);
      if (k < MAXV) { vList[k] = i; }
    }
  }
  workgroupBarrier();

  let i0 = wg.x * 256u + lid.x;
  if (i0 >= P.blockFrames) { return; }
  let ff = f32(P.base + i0);
  let cnt = min(atomicLoad(&vCount), MAXV);
  var l = 0.0;
  var r = 0.0;
  for (var k = 0u; k < cnt; k = k + 1u) {
    let n = notes[vList[k]];
    if (ff < n.x || ff > n.y) { continue; }
    let t = (ff - n.x) / P.sampleRate;
    // a 2 ms fade into a choke / end of life so cutting a voice never clicks
    let fade = clamp((n.y - ff) / (0.002 * P.sampleRate), 0.0, 1.0);
    let id = u32(n.z + 0.5);
    let v = voice(id, t, n.w) * n.w * fade;
    let a = (pan(id) + 1.0) * 0.78539816; // equal-power pan
    l = l + v * cos(a);
    r = r + v * sin(a);
  }
  let g = P.gain * 0.9;
  outL[i0] = tanh(l * g);
  outR[i0] = tanh(r * g);
}
`

/**
 * 4-operator FM synth, rendered offline on the GPU (same scheme as SYNTH_WGSL / DRUMS_WGSL:
 * a workgroup gathers the notes overlapping its block, each thread sums their voices; voices
 * are closed-form functions of time since note-on, so there is no per-voice state).
 *
 * Operators are evaluated from index 3 down to 0, so operator j may modulate operator i only
 * when j > i (modM[i][j] = weight; `out` mixes operators to the output). A modulator's
 * peak phase deviation is `level * 8` radians. Each operator has its own ADSR (exponential
 * decay / release) and a velocity sensitivity, so a hard hit is brighter as well as louder.
 *
 * Built for tight transients: attacks as short as 0.3 ms, a short band-passed noise click
 * (`click`), and a quick pitch drop at the start (`pitchPunch`, closed form like the kick:
 * phase integral of f*(1 + a*exp(-t/tau)) is f*(t + a*tau*(1-exp(-t/tau)))). One operator
 * may feed back on itself (`fbOp`), approximated by a few fixed-point iterations.
 *
 * notes[i] = (startFrame, endFrame, freqHz, velocity 0..1).
 */
export const FM_WGSL = /* wgsl */ `
struct FM {
  blockFrames : u32,
  nNotes : u32,
  base : u32,
  _p0 : u32,
  sampleRate : f32,
  gain : f32,
  click : f32,
  pitchA : f32,      // 2^(semitones/12) - 1: initial pitch excess
  pitchTau : f32,    // seconds
  fbOp : f32,        // operator index with self feedback (-1 = none)
  fbAmt : f32,       // feedback depth (radians at full level)
  indexMul : f32,    // macro: scales every pure modulator's level
  maxRel : f32,      // longest release time constant (seconds), for the gather window
  _p1 : f32, _p2 : f32, _p3 : f32,
  opA : array<vec4<f32>, 4>,  // (freq multiplier, fixed Hz or 0, level, velocity sensitivity)
  opB : array<vec4<f32>, 4>,  // (attack s, decay tau s, sustain, release tau s)
  modM : array<vec4<f32>, 4>, // modM[i] = (from op0, op1, op2, op3) into op i
  outV : vec4<f32>,           // output mix per operator
};
@group(0) @binding(0) var<uniform> P : FM;
@group(0) @binding(1) var<storage, read> notes : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outL : array<f32>;
@group(0) @binding(3) var<storage, read_write> outR : array<f32>;

const MAXV : u32 = 96u;
var<workgroup> vCount : atomic<u32>;
var<workgroup> vList : array<u32, 96>;
const TAU : f32 = 6.28318530718;

fn hash(n : u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) * (1.0 / 2147483648.0) - 1.0;
}
fn lpnoise(t : f32, rate : f32, seed : u32) -> f32 {
  let x = max(t, 0.0) * rate;
  let i = u32(floor(x));
  let fr = x - floor(x);
  let s = fr * fr * (3.0 - 2.0 * fr);
  return mix(hash(i * 2654435761u + seed), hash((i + 1u) * 2654435761u + seed), s);
}

fn envOn(b : vec4<f32>, t : f32) -> f32 {
  let a = max(b.x, 0.0003);
  if (t < a) { return t / a; }
  return b.z + (1.0 - b.z) * exp(-(t - a) / max(b.y, 1e-4));
}
fn env(b : vec4<f32>, t : f32, tOff : f32) -> f32 {
  if (t <= tOff) { return envOn(b, t); }
  return envOn(b, tOff) * exp(-(t - tOff) / max(b.w, 1e-4));
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg : vec3<u32>, @builtin(local_invocation_id) lid : vec3<u32>) {
  let b0 = f32(P.base + wg.x * 256u);
  let b1 = b0 + 256.0;
  let relFrames = P.maxRel * 7.0 * P.sampleRate; // ~ -60 dB after the longest release
  if (lid.x == 0u) { atomicStore(&vCount, 0u); }
  workgroupBarrier();
  for (var i = lid.x; i < P.nNotes; i = i + 256u) {
    let n = notes[i];
    if (n.x < b1 && n.y + relFrames >= b0) {
      let k = atomicAdd(&vCount, 1u);
      if (k < MAXV) { vList[k] = i; }
    }
  }
  workgroupBarrier();

  let i0 = wg.x * 256u + lid.x;
  if (i0 >= P.blockFrames) { return; }
  let ff = f32(P.base + i0);
  let cnt = min(atomicLoad(&vCount), MAXV);
  var sum = 0.0;
  for (var k = 0u; k < cnt; k = k + 1u) {
    let n = notes[vList[k]];
    if (ff < n.x) { continue; }
    let t = (ff - n.x) / P.sampleRate;
    let tOff = (n.y - n.x) / P.sampleRate;
    let vel = n.w;
    let nFrames = u32(ff - n.x);
    let pitchExtra = P.pitchA * P.pitchTau * (1.0 - exp(-t / P.pitchTau)); // cycles per Hz
    var o = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
    for (var ii = 0; ii < 4; ii = ii + 1) {
      let i = 3 - ii;
      let a = P.opA[i];
      let b = P.opB[i];
      let e = env(b, t, tOff);
      if (e < 1e-5) { continue; }
      let isMod = P.outV[i] < 0.001;
      let lvl = a.z * mix(1.0, vel, a.w) * select(1.0, P.indexMul, isMod);
      let freq = select(n.z * a.x, a.y, a.y > 0.0);
      let inc = u32(clamp(freq / P.sampleRate, 0.0, 0.49) * 4294967296.0);
      let cyc = f32((nFrames * inc) >> 8u) * (1.0 / 16777216.0) + freq * pitchExtra;
      let theta = TAU * fract(cyc);
      // phase modulation from the operators above this one
      var pm = 0.0;
      let row = P.modM[i];
      if (i < 3) { pm = pm + row.w * 8.0 * o[3]; }
      if (i < 2) { pm = pm + row.z * 8.0 * o[2]; }
      if (i < 1) { pm = pm + row.y * 8.0 * o[1]; }
      var s : f32;
      if (i32(P.fbOp + 0.5) == i && P.fbAmt > 0.0) {
        // y = sin(theta + pm + beta*y): three fixed-point passes approximate the recurrence
        let beta = P.fbAmt * lvl;
        var y = sin(theta + pm);
        y = sin(theta + pm + beta * y);
        y = sin(theta + pm + beta * y);
        s = sin(theta + pm + beta * y);
      } else {
        s = sin(theta + pm);
      }
      o[i] = s * lvl * e;
    }
    var v = P.outV.x * o[0] + P.outV.y * o[1] + P.outV.z * o[2] + P.outV.w * o[3];
    // click: a ~2 ms band-passed noise tick on every hit — the "transient" of a plucked / struck sound
    if (P.click > 0.0) {
      v = v + P.click * vel * (lpnoise(t, 14000.0, 97u) - lpnoise(t, 3000.0, 97u)) * exp(-t / 0.0022);
    }
    sum = sum + v * (0.4 + 0.6 * vel);
  }
  let g = tanh(sum * P.gain * 0.5);
  outL[i0] = g;
  outR[i0] = g;
}
`

/**
 * EarlySynth's shader: a byte-for-byte copy of FM_WGSL as it was when EarlySynth was frozen. It is
 * deliberately a separate constant so that improving the FM synth (FM_WGSL) can never change how
 * EarlySynth sounds. Do not edit. See gpu/instruments/earlysynth/earlysynth.ts.
 */
export const EARLYSYNTH_WGSL = /* wgsl */ `
struct FM {
  blockFrames : u32,
  nNotes : u32,
  base : u32,
  _p0 : u32,
  sampleRate : f32,
  gain : f32,
  click : f32,
  pitchA : f32,      // 2^(semitones/12) - 1: initial pitch excess
  pitchTau : f32,    // seconds
  fbOp : f32,        // operator index with self feedback (-1 = none)
  fbAmt : f32,       // feedback depth (radians at full level)
  indexMul : f32,    // macro: scales every pure modulator's level
  maxRel : f32,      // longest release time constant (seconds), for the gather window
  _p1 : f32, _p2 : f32, _p3 : f32,
  opA : array<vec4<f32>, 4>,  // (freq multiplier, fixed Hz or 0, level, velocity sensitivity)
  opB : array<vec4<f32>, 4>,  // (attack s, decay tau s, sustain, release tau s)
  modM : array<vec4<f32>, 4>, // modM[i] = (from op0, op1, op2, op3) into op i
  outV : vec4<f32>,           // output mix per operator
};
@group(0) @binding(0) var<uniform> P : FM;
@group(0) @binding(1) var<storage, read> notes : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outL : array<f32>;
@group(0) @binding(3) var<storage, read_write> outR : array<f32>;

const MAXV : u32 = 96u;
var<workgroup> vCount : atomic<u32>;
var<workgroup> vList : array<u32, 96>;
const TAU : f32 = 6.28318530718;

fn hash(n : u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) * (1.0 / 2147483648.0) - 1.0;
}
fn lpnoise(t : f32, rate : f32, seed : u32) -> f32 {
  let x = max(t, 0.0) * rate;
  let i = u32(floor(x));
  let fr = x - floor(x);
  let s = fr * fr * (3.0 - 2.0 * fr);
  return mix(hash(i * 2654435761u + seed), hash((i + 1u) * 2654435761u + seed), s);
}

fn envOn(b : vec4<f32>, t : f32) -> f32 {
  let a = max(b.x, 0.0003);
  if (t < a) { return t / a; }
  return b.z + (1.0 - b.z) * exp(-(t - a) / max(b.y, 1e-4));
}
fn env(b : vec4<f32>, t : f32, tOff : f32) -> f32 {
  if (t <= tOff) { return envOn(b, t); }
  return envOn(b, tOff) * exp(-(t - tOff) / max(b.w, 1e-4));
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg : vec3<u32>, @builtin(local_invocation_id) lid : vec3<u32>) {
  let b0 = f32(P.base + wg.x * 256u);
  let b1 = b0 + 256.0;
  let relFrames = P.maxRel * 7.0 * P.sampleRate; // ~ -60 dB after the longest release
  if (lid.x == 0u) { atomicStore(&vCount, 0u); }
  workgroupBarrier();
  for (var i = lid.x; i < P.nNotes; i = i + 256u) {
    let n = notes[i];
    if (n.x < b1 && n.y + relFrames >= b0) {
      let k = atomicAdd(&vCount, 1u);
      if (k < MAXV) { vList[k] = i; }
    }
  }
  workgroupBarrier();

  let i0 = wg.x * 256u + lid.x;
  if (i0 >= P.blockFrames) { return; }
  let ff = f32(P.base + i0);
  let cnt = min(atomicLoad(&vCount), MAXV);
  var sum = 0.0;
  for (var k = 0u; k < cnt; k = k + 1u) {
    let n = notes[vList[k]];
    if (ff < n.x) { continue; }
    let t = (ff - n.x) / P.sampleRate;
    let tOff = (n.y - n.x) / P.sampleRate;
    let vel = n.w;
    let nFrames = u32(ff - n.x);
    let pitchExtra = P.pitchA * P.pitchTau * (1.0 - exp(-t / P.pitchTau)); // cycles per Hz
    var o = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
    for (var ii = 0; ii < 4; ii = ii + 1) {
      let i = 3 - ii;
      let a = P.opA[i];
      let b = P.opB[i];
      let e = env(b, t, tOff);
      if (e < 1e-5) { continue; }
      let isMod = P.outV[i] < 0.001;
      let lvl = a.z * mix(1.0, vel, a.w) * select(1.0, P.indexMul, isMod);
      let freq = select(n.z * a.x, a.y, a.y > 0.0);
      let inc = u32(clamp(freq / P.sampleRate, 0.0, 0.49) * 4294967296.0);
      let cyc = f32((nFrames * inc) >> 8u) * (1.0 / 16777216.0) + freq * pitchExtra;
      let theta = TAU * fract(cyc);
      // phase modulation from the operators above this one
      var pm = 0.0;
      let row = P.modM[i];
      if (i < 3) { pm = pm + row.w * 8.0 * o[3]; }
      if (i < 2) { pm = pm + row.z * 8.0 * o[2]; }
      if (i < 1) { pm = pm + row.y * 8.0 * o[1]; }
      var s : f32;
      if (i32(P.fbOp + 0.5) == i && P.fbAmt > 0.0) {
        // y = sin(theta + pm + beta*y): three fixed-point passes approximate the recurrence
        let beta = P.fbAmt * lvl;
        var y = sin(theta + pm);
        y = sin(theta + pm + beta * y);
        y = sin(theta + pm + beta * y);
        s = sin(theta + pm + beta * y);
      } else {
        s = sin(theta + pm);
      }
      o[i] = s * lvl * e;
    }
    var v = P.outV.x * o[0] + P.outV.y * o[1] + P.outV.z * o[2] + P.outV.w * o[3];
    // click: a ~2 ms band-passed noise tick on every hit — the "transient" of a plucked / struck sound
    if (P.click > 0.0) {
      v = v + P.click * vel * (lpnoise(t, 14000.0, 97u) - lpnoise(t, 3000.0, 97u)) * exp(-t / 0.0022);
    }
    sum = sum + v * (0.4 + 0.6 * vel);
  }
  let g = tanh(sum * P.gain * 0.5);
  outL[i0] = g;
  outR[i0] = g;
}
`
