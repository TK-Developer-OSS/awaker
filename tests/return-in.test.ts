// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { DriftRing, ReturnIn, RETURN_BLOCK } from '../src/main/return-in'
import { LiveRing } from '../src/main/live-ring'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

// 1. Frame alignment: injected blocks land on exact contiguous output clock frames (and shift by delayMs)
{
  let outClock = 1000
  let external = false
  const injected: { start: number; firstL: number }[] = []
  const ret = new ReturnIn({
    clock: () => outClock,
    running: () => true,
    rate: () => 96000,
    inject: (block, start) => injected.push({ start, firstL: block[0] }),
    setExternal: (on) => {
      external = on
    }
  })

  ret.start({ synthetic: 'sine', delayMs: 10 }) // +10 ms @ 96 kHz = +960 frames
  ret.stop() // stop background timers; drive deterministically below
  // Re-open in manual-drive mode via a custom opener
  const ret2 = new ReturnIn({
    clock: () => outClock,
    running: () => true,
    rate: () => 96000,
    inject: (block, start) => injected.push({ start, firstL: block[0] }),
    setExternal: (on) => {
      external = on
    },
    openWasapiInput: () => ({
      close: () => {},
      deviceId: 1,
      deviceName: 'Virtual Cable Return',
      sampleRate: 96000,
      channels: 2
    })
  })
  ret2.start({ deviceId: 1, delayMs: 10 })
  const liveRing = new LiveRing(96000)
  const latFrames = 2048 // simulated GPU + IPC landing latency

  for (let b = 0; b < 50; b++) {
    const inBuf = new Float32Array(RETURN_BLOCK * 2)
    for (let i = 0; i < RETURN_BLOCK; i++) {
      const s = Math.sin((2 * Math.PI * 440 * (b * RETURN_BLOCK + i)) / 96000) * 0.5
      inBuf[i * 2] = s
      inBuf[i * 2 + 1] = -s
    }
    ret2.feedInput(inBuf, 2)
    ret2.pump()
    while (injected.length) {
      const blk = injected.shift()!
      const dummy = new Float32Array(RETURN_BLOCK * 2).fill(0.25)
      liveRing.write(blk.start + latFrames, dummy, outClock)
    }
    outClock += RETURN_BLOCK
  }
  const st = ret2.status()
  ret2.stop()
  check('delayMs=10 at 96k shifts offsetFrames by +960', st.offsetFrames === 960, `offsetFrames=${st.offsetFrames}`)
  check('all 51 blocks injected contiguously with 0 resyncs', st.injectedBlocks === 51 && st.resyncs === 0, `blocks=${st.injectedBlocks} resyncs=${st.resyncs}`)
  check('clockDeltaFrames is locked to lead (512..1024 fr)', st.clockDeltaFrames >= 0 && st.clockDeltaFrames <= RETURN_BLOCK * 2, `clockDelta=${st.clockDeltaFrames}`)
  check('LiveRing received all blocks with 0 late and 0 tooFar', liveRing.late === 0 && liveRing.tooFar === 0 && liveRing.written === 51 * RETURN_BLOCK, `late=${liveRing.late} written=${liveRing.written}`)
  check('stop releases external live flag', external === false)
}

// 2. 5-minute (300 s @ 96 kHz = 28,800,000 frames) drift test at +150 ppm and -150 ppm:
//    ring must neither overflow nor underflow, and resample ratio / ppm must track the drift.
for (const driftPpm of [150, -150]) {
  const sr = 96000
  const ring = new DriftRing(Math.round(sr * 0.25), Math.round(sr * 0.045))
  const totalBlocks = Math.floor((300 * sr) / RETURN_BLOCK) // 56,250 blocks = 5 minutes
  const dst = new Float32Array(RETURN_BLOCK * 2)
  let inAcc = 0
  const inPerBlock = RETURN_BLOCK * (1 + driftPpm * 1e-6)
  const chunk = new Float32Array((RETURN_BLOCK + 8) * 2)

  for (let b = 0; b < totalBlocks; b++) {
    inAcc += inPerBlock
    const nIn = Math.floor(inAcc)
    inAcc -= nIn
    ring.push(chunk.subarray(0, nIn * 2), 2, true)
    ring.pull(RETURN_BLOCK, sr, dst, 1)
  }

  check(
    `5 min @ ${driftPpm > 0 ? '+' : ''}${driftPpm} ppm: 0 underruns and 0 overruns`,
    ring.underruns === 0 && ring.overruns === 0,
    `underruns=${ring.underruns} overruns=${ring.overruns}`
  )
  check(
    `5 min @ ${driftPpm > 0 ? '+' : ''}${driftPpm} ppm: fillRatio stays near 1.0 (0.85..1.15)`,
    ring.fillRatio > 0.85 && ring.fillRatio < 1.15,
    `fillRatio=${ring.fillRatio.toFixed(3)} (${Math.round(ring.available)}/${ring.target})`
  )
  check(
    `5 min @ ${driftPpm > 0 ? '+' : ''}${driftPpm} ppm: ppm converges within 5 ppm of ${driftPpm}`,
    Math.abs(ring.ppm - driftPpm) < 5,
    `ppm=${ring.ppm.toFixed(2)}`
  )
}

if (fails) {
  console.log(`${fails} FAILED`)
  process.exit(1)
}
console.log('ALL OK')
