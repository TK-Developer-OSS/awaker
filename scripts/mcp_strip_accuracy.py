# Copyright 2026 TK <tk.oss.developer@gmail.com>
# SPDX-License-Identifier: Apache-2.0
# Generated with Claude Code (https://claude.com/claude-code)
"""
Accuracy of the channel strip's saturation chain (Drive or Color, optional HPF) against a float64 reference.

Needs the app running with MCP (`npm run dev:mcp`) and the strip's per-instance variance PINNED, because
the reference has to know the values: temporarily replace the `Math.random()` calls in the `vary` block of
`src/renderer/src/gpu/channel-strip.ts` with 0.37 (and put them back before committing).

    python scripts/mcp_strip_accuracy.py setup     # synthetic 96 kHz wav + a one-track test project
    MODE=drive|color DRIVE=0.74 HPF=0 python scripts/mcp_strip_accuracy.py run

`run` bounces the test project, fits the (linear) master gain against the float64 chain and prints the SNR.
Reference numbers (2026-10-09): Drive 110 dB, Color 109 dB without HPF (that is the GPU's tanh / pow accuracy);
with a 30-40 Hz HPF both the old serial kernel and the parallel one sit at ~63-68 dB (float32 biquad conditioning).
"""
import sys, os, json, math, tempfile
import numpy as np
from scipy.io import wavfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcp_perf_breakdown as m

S = tempfile.gettempdir().replace('\\', '/')
WAV = S + '/drive_test.wav'
PRJ = S + '/drive_test.awaker.json'
SR = 96000
DRIVE = float(os.environ.get('DRIVE', '0.74'))
HPF = float(os.environ.get('HPF', '0'))
MODE = os.environ.get('MODE', 'drive')


def make_signal():
    rng = np.random.default_rng(1)
    n = SR * 4
    t = np.arange(n) / SR
    x = np.zeros(n)
    # kick-ish hits, a bass tone, some noise bursts
    for k in range(8):
        s = int(k * 0.5 * SR)
        L = int(0.3 * SR)
        tt = np.arange(L) / SR
        x[s:s + L] += 0.8 * np.sin(2 * np.pi * (45 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)
        x[s:s + L] += 0.15 * rng.standard_normal(L) * np.exp(-tt * 60)
    x += 0.25 * np.sin(2 * np.pi * 55 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.7 * t))
    x += 0.04 * rng.standard_normal(n)
    return (x * 0.9 / np.abs(x).max()).astype(np.float32)


def setup():
    x = make_signal()
    wavfile.write(WAV, SR, x)
    c = m.call
    base = S + '/drive_base.awaker.json'
    c('project_save_file', path=base)
    p = json.load(open(base, encoding='utf-8'))
    tr = p['tracks'][0]
    tr['clips'] = [dict(tr['clips'][0], lengthFrames=len(x), sourceId=1, name='t')]
    p['sources'] = [{'id': 1, 'name': 't', 'path': WAV.replace('/', '\\'), 'kind': 'wav'}]
    tr['inserts'] = []
    tr['mix'].update({'gainDb': 0, 'pan': 0})
    sp = tr['strip']['params']
    sp.update({'drive': DRIVE, 'satMode': MODE, 'hpfHz': HPF, 'eqOn': False, 'trimDb': 0})
    sp['comp']['on'] = False
    tr['strip']['bypass'] = False
    p['tracks'] = [tr]
    p['master']['inserts'] = []
    json.dump(p, open(PRJ, 'w', encoding='utf-8'))
    c('project_load_file', path=base)
    print('setup ok', len(x))


def ref_color(x, drive, vary):
    f32 = lambda v: float(np.float32(v))
    fs = SR
    d = min(1, max(0, drive))
    lp1 = lambda fc: f32(1 - math.exp(-2 * math.pi * fc / fs))
    ck = d ** 0.68
    colG = f32(10 ** (ck * 34 / 20) * vary['gain'])
    colBias = f32(0.12 + 0.32 * ck + vary['bias'])
    colBiasT = f32(math.tanh(colBias))
    colLoA = lp1(90); colBloom = f32(0.85 * ck); colEmphA = lp1(2500); colEmph = f32(0.5 + 0.95 * ck)
    colShoulder = f32(0.28 + 0.55 * ck); colOutA = lp1((26000 - 11000 * ck) * vary['corner'])
    inSq = outSq = 0
    for n in range(64):
        sn = 0.2 * math.sin(2 * math.pi * n / 64)
        on = math.tanh(sn * colG + colBias) - colBiasT
        inSq += sn * sn; outSq += on * on
    colMakeup = f32(math.sqrt(inSq / max(1e-9, outSq)) * (1 - 0.2 * ck))
    a = f32(vary['allpass'])
    DC = f32(0.0016)
    y = np.zeros(len(x)); dc = lo = em = ol = z = 0.0
    for i, xin in enumerate(x.astype(np.float64)):
        dc = dc + DC * (xin - dc); xx = xin - dc
        lo = lo + colLoA * (xx - lo)
        bloom = xx + colBloom * (math.tanh(lo * 2) * 0.5 - lo)
        em = em + colEmphA * (bloom - em)
        pre = bloom + colEmph * (bloom - em)
        aa = math.tanh(pre * colG + colBias) - colBiasT
        sh = aa / (1 + abs(aa)); bl = aa + (sh - aa) * colShoulder
        ol = ol + colOutA * (bl - ol)
        v = (bl + (ol - bl) * 0.5) * colMakeup
        out = -a * v + z; z = v + a * out
        y[i] = out
    return y


def ref_drive(x, drive, vary):
    f32 = lambda v: float(np.float32(v))
    fs = SR
    d = min(1, max(0, drive))
    lp1 = lambda fc: f32(1 - math.exp(-2 * math.pi * fc / fs))
    k = d ** 2.1
    dPre = f32(10 ** (k * 30 / 20) * vary['gain'])
    dTriG = f32(1 + 2.6 * k)
    dBias = f32(0.12 + 0.4 * k + vary['bias'])
    dBiasT = f32(math.tanh(dBias))
    dThr = f32(0.14 - 0.09 * k)
    dRatioInv = f32(1 / (3 + 17 * k))
    dDensity = f32(0.35 + 1.2 * k)
    dEmphA = lp1(1800 * vary['corner'])
    dEmph = f32(0.5 + 1.2 * k)
    dAtt = f32(1 - math.exp(-1 / (0.0004 * fs)))
    dRelSlow = f32(1 - math.exp(-1 / (0.18 * fs)))
    dRelFast = f32(1 - math.exp(-1 / (0.04 * fs)))
    dInSq = dGritSq = 0
    for n in range(64):
        sn = 0.2 * math.sin(2 * math.pi * n / 64)
        gr = math.tanh(sn * dPre * dTriG + dBias) - dBiasT
        dInSq += sn * sn; dGritSq += gr * gr
    gritRms = math.sqrt(dGritSq / 64)
    envSS = gritRms * 1.3
    grSS = envSS / dThr ** 1 if False else (math.pow(envSS / dThr, dRatioInv - 1) if envSS / dThr > 1 else 1)
    postGr = gritRms * grSS
    postSurge = postGr / (1 + postGr * 1.2 * dDensity)
    dMakeup = f32(math.sqrt(dInSq / 64) / max(1e-6, postSurge) * (1 - 0.76 * k))
    dOut = f32(1 - 0.6 * math.sqrt(k))
    dLimT = f32(0.92 - 0.35 * k)
    a = f32(vary['allpass'])
    y = np.zeros(len(x))
    em = 0.0; prev = 0.0; env = 0.0; dc = 0.0; z = 0.0
    for i, xin in enumerate(x.astype(np.float64)):
        xd = xin * dPre
        em = em + dEmphA * (xd - em)
        pre = xd + dEmph * (xd - em)
        grit = math.tanh(pre * dTriG + dBias) - dBiasT
        det = abs(prev)
        slam = min(1, max(0, det / dThr - 1))
        rel = dRelSlow + (dRelFast - dRelSlow) * slam
        env = env + (dAtt if det > env else rel) * (det - env)
        gr = 1.0
        over = env / dThr
        if over > 1: gr = over ** (dRatioInv - 1)
        v = grit * gr * dMakeup
        dc = dc + 0.0016 * (v - dc)
        v = v - dc
        v = v / (1 + abs(v) * dDensity)
        prev = v
        # softTop
        aa = abs(v)
        if aa > dLimT:
            r = dLimT + (1 - dLimT) * math.tanh((aa - dLimT) / (1 - dLimT))
            v = r if v >= 0 else -r
        v = v * dOut
        out = -a * v + z
        z = v + a * out
        y[i] = out
    return y


def hpf_apply(y, fs):
    if HPF > 0:
        import scipy.signal as sg
        w0 = 2 * math.pi * HPF / fs; cw = math.cos(w0); al = math.sin(w0) / (2 * 0.707)
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; aa = [1 + al, -2 * cw, 1 - al]
        b = [float(np.float32(v / aa[0])) for v in b]; a1 = float(np.float32(aa[1] / aa[0])); a2 = float(np.float32(aa[2] / aa[0]))
        y = sg.lfilter(b, [1, a1, a2], y)
    return y


def run():
    c = m.call
    c('project_load_file', path=PRJ)
    c('transport', action='stop')
    b = c('bounce', tailSeconds=0, save=True)
    sr, w = wavfile.read(b['wav'])
    got = w[:, 0].astype(np.float64)
    x = wavfile.read(WAV)[1]
    vary = {'gain': 1 + (0.37 - 0.5) * 0.006, 'bias': (0.37 - 0.5) * 0.004,
            'corner': 1 + (0.37 - 0.5) * 0.03, 'allpass': (0.37 - 0.5) * 0.06}
    ref = (ref_color if MODE == 'color' else ref_drive)(x, DRIVE, vary)
    ref = hpf_apply(ref, SR)
    n = min(len(ref), len(got))
    ref = ref[:n]; got = got[:n]
    g = (got * ref).sum() / (ref * ref).sum()
    e = got - g * ref
    print('renderMs %.0f  fitted gain %.5f  SNR vs float64 reference: %.1f dB  maxerr %.2e (ref peak %.3f)' %
          (b['renderMs'], g, 10 * np.log10(((g * ref) ** 2).sum() / (e ** 2).sum()), np.abs(e).max(), np.abs(g * ref).max()))


if __name__ == '__main__':
    {'setup': setup, 'run': run}[sys.argv[1]]()
