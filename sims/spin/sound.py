#!/usr/bin/env python3
"""Soundtrack for the 2x-spin what-if, built on the same timeline.json.

The street runs on world time like the picture. The spin-up is a rising
whirr and a hit; a drone and a tick on every world second carry the 20 s; a
breeze builds with the air sliding toward the equator; the spin-down at 20 s
is the whirr in reverse. Then the tsunami: rumble and roar grow as the bore
comes up the street, the crash, and a muffled underwater bed.

    python3 sims/spin/sound.py [-o out/sims/spin/sound.wav]

Mux it into the capture: ffmpeg -i video -i sound.wav -c:v copy -c:a aac
"""

import argparse
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))
from sfx.dsp import svf  # noqa: E402
from sfx.mix import Mix  # noqa: E402
from sfx.synth import SR, blip, chime, click, envelope, impact, pad, pop, riser, whoosh  # noqa: E402

TL = json.load(open(os.path.join(HERE, "timeline.json")))
DUR = TL["duration"]
N = int(DUR * SR)
SL = TL["slow"]
T0 = SL["start"]
TLEN = SL["world"] / (SL["s0"] + (SL["s1"] - SL["s0"]) / (SL["pow"] + 1))
T1 = T0 + TLEN


def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def smooth(x):
    x = clamp01(x)
    return x * x * (3 - 2 * x)


def speed(t):
    """Same curve as main.js speedAt."""
    if t < T0 - SL["in"]:
        return 1.0
    if t < T0:
        k = clamp01((t - T0 + SL["in"]) / SL["in"])
        return 1 + (SL["s0"] - 1) * (1 - (1 - k) ** 3)
    if t < T1:
        return SL["s0"] + (SL["s1"] - SL["s0"]) * ((t - T0) / TLEN) ** SL["pow"]
    if t < T1 + SL["out"]:
        return SL["s1"] + (1 - SL["s1"]) * smooth((t - T1) / SL["out"])
    return 1.0


# world clock W(t), zero when selenium vanishes
DT = 1 / 1000
WT = [0.0] * (int(DUR / DT) + 2)
i0 = round(T0 / DT)
for i in range(i0 + 1, len(WT)):
    WT[i] = WT[i - 1] + 0.5 * (speed((i - 1) * DT) + speed(i * DT)) * DT
for i in range(i0 - 1, -1, -1):
    WT[i] = WT[i + 1] - 0.5 * (speed(i * DT) + speed((i + 1) * DT)) * DT


def world(t):
    f = min(max(t / DT, 0), len(WT) - 1.001)
    i = int(f)
    return WT[i] + (WT[i + 1] - WT[i]) * (f - i)


def t_of_world(w):
    lo, hi = 0, len(WT) - 1
    while hi - lo > 1:
        m = (lo + hi) // 2
        if WT[m] < w:
            lo = m
        else:
            hi = m
    return lo * DT


G = 9.81
TS = TL["tsunami"]
PUSH_A = 0.0508  # m/s2 toward the equator; the air reaches about 1 m/s in 20 s


def fall_time(h):
    return math.sqrt(2 * h / G)


def env(fn):
    out = [0.0] * N
    for s in range(0, N, 64):
        v = fn(s / SR)
        out[s:s + 64] = [v] * min(64, N - s)
    return out


def mul(a, b):
    return [x * y for x, y in zip(a, b)]


def white(seed):
    r = random.Random(seed).random
    return [2.0 * r() - 1.0 for _ in range(N)]


def brown(seed, leak=0.996):
    y = 0.0
    out = [0.0] * N
    for i, v in enumerate(white(seed)):
        y = leak * y + 0.05 * v
        out[i] = y
    return out


def norm(x, peak=1.0):
    m = max(1e-9, max(abs(v) for v in x))
    return [v * peak / m for v in x]


def thump(f0, f1, dur, tau=None):
    n = int(dur * SR)
    out = []
    ph = 0.0
    for k in range(n):
        x = k / n
        ph += 2 * math.pi * (f0 + (f1 - f0) * x) / SR
        out.append(math.sin(ph) * math.exp(-x * 5.0 if tau is None else -k / (tau * SR)) * min(1, k / (0.002 * SR)))
    return out


def glitter(dur, n_hits, f_lo, f_hi, seed):
    """Dense little glassy blips: atoms leaving a surface."""
    rr = random.Random(seed)
    out = [0.0] * int(dur * SR)
    for _ in range(n_hits):
        at = int((rr.random() ** 1.6) * (len(out) - 0.05 * SR))
        b = blip(rr.uniform(f_lo, f_hi), dur=0.05, tau=0.012)
        g = rr.uniform(0.3, 1.0)
        for k, v in enumerate(b):
            if at + k < len(out):
                out[at + k] += v * g
    return out


mix = Mix(DUR, seed=12)
put = mix.put
under = env(lambda t: smooth((t - TS["hit"] + 0.1) / 0.25))  # under the wave

# 1. the street in world time, muffled once the wave has hit
for k, side in ((0, "l"), (1, "r")):
    fc = lambda s: (200 + 8000 * speed(s / SR) ** 1.8) * (1 - 0.93 * smooth((s / SR - TS["hit"] + 0.1) / 0.25))  # noqa: E731
    wash = svf(svf(white(10 + k), 1100, 0.45, "bp"), fc, 0.7)
    rumble = svf(brown(20 + k), 170, 0.7)
    voices = [0.0] * N
    for v in range(5):
        rr = random.Random(40 + v + 10 * k)
        f, ph = rr.uniform(2.6, 4.6), rr.uniform(0, 6.3)
        band = svf(white(50 + v + 10 * k), rr.uniform(500, 1300), 1.2, "bp")
        am = env(lambda t, f=f, ph=ph: max(0.0, math.sin(2 * math.pi * f * world(t) + ph)) ** 2 * (0.6 + 0.4 * math.sin(world(t) * 0.7 + ph)))
        voices = [a + b * c for a, b, c in zip(voices, band, am)]
    voices = svf(voices, fc, 0.7)
    level = env(lambda t: 0.55 + 0.45 * speed(t))
    bed = [(0.5 * a + 0.9 * b + 0.45 * c) * g for a, b, c, g in zip(norm(wash), norm(rumble), norm(voices), level)]
    if side == "l":
        mix.put_stereo(0, bed, [0.0] * N, gain=0.24)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.24)
rr = random.Random(7)
t = 0.2
while t < TS["at"]:  # birds until the water comes
    f = rr.uniform(2800, 4200)
    for c in range(rr.randint(2, 4)):
        put(t + c * 0.09, blip(f * (1 + 0.08 * c), dur=0.08, tau=0.02), 0.035, rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.5, 1.1)

# 2. the spin doubles: a rising whirr and a hit
def whirr(dur, f0, f1):
    n = int(dur * SR)
    out, ph = [], 0.0
    for k in range(n):
        x = k / n
        ph += 2 * math.pi * (f0 * (f1 / f0) ** x) / SR
        out.append((math.sin(ph) + 0.4 * math.sin(2 * ph) + 0.2 * math.sin(3.01 * ph)) * math.sin(math.pi * x) ** 0.7)
    return out


put(T0 - 1.0, riser(1.0, 300, 4200), 0.12)
put(T0 - 0.4, whirr(1.6, 60, 240), 0.16)
put(T0, impact(1.4), 0.5)
put(T0 + 0.02, glitter(1.0, 40, 2600, 7400, 5), 0.06)  # the tile shatters

# 3. the wind building toward the equator
breeze = env(lambda t: min(1.0, PUSH_A * max(0.0, min(world(t), SL["world"])) * (1 - smooth((world(t) - SL["world"] - 6) / 4))))
for k in (0, 1):
    wind = svf(white(300 + k), lambda s: 500 + 900 * min(1.0, PUSH_A * max(0.0, min(world(s / SR), SL["world"]))), 0.9, "bp")
    lay = mul(norm(wind), breeze)
    mix.put_stereo(0, lay if k == 0 else [0.0] * N, [0.0] * N if k == 0 else lay, gain=0.07)

# 4. the 20 seconds: a drone and a tick per world second
vol = envelope([(0, 0), (T0, 0), (T0 + 0.8, 1), (T1 - 0.6, 1.2), (T1, 1.2), (T1 + 0.3, 0.5), (TS["at"], 0.5), (TS["at"] + 1, 1.0), (TS["hit"], 1.2), (TS["hit"] + 0.3, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [110.0, 164.81, 220.0, 277.18, 329.63])], volume=vol, detune=0.5, tremolo=0.15), gain=0.04)
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.05), 0.16, 0.15)
    put(tw, thump(95, 60, 0.12), 0.16)

# 5. back to normal: the whirr in reverse
put(T1 - 0.6, whirr(1.4, 240, 50), 0.16)
put(T1, thump(140, 50, 0.6), 0.35)

# 6. the tsunami: rumble and roar grow, the crash, then underwater
def under_v(t):
    return smooth((t - TS["hit"] + 0.1) / 0.25)


ramp = env(lambda t: smooth((t - TS["at"]) / (TS["hit"] - TS["at"])) ** 1.6 * (1 - under_v(t)))
for k in (0, 1):
    roar = svf(white(200 + k), lambda s: 300 + 2600 * smooth((s / SR - TS["at"]) / (TS["hit"] - TS["at"])), 0.6)
    rum = svf(brown(210 + k, 0.998), 120, 0.7)
    layer = [(0.7 * a + 0.9 * b) * g for a, b, g in zip(norm(roar), norm(rum), ramp)]
    mix.put_stereo(0, layer if k == 0 else [0.0] * N, [0.0] * N if k == 0 else layer, gain=0.32)
put(TS["hit"] - 0.05, impact(1.6), 0.85)
put(TS["hit"] - 0.05, whoosh(1.2, 4000, 300, peak=0.1, q=0.6), 0.25)
bub = svf(brown(230, 0.995), 400, 0.7)
mix.put_stereo(0, *(lambda b: (b, b))(mul(norm(bub), under)), gain=0.12)
rr = random.Random(41)
t = TS["hit"] + 0.1
while t < DUR - 0.3:
    put(t, blip(rr.uniform(300, 900), dur=0.12, tau=0.04), rr.uniform(0.03, 0.08), rr.uniform(-0.7, 0.7))
    t += rr.uniform(0.06, 0.2)

# 7. captions, end card, camera turns
for c in TL["captions"]:
    put(c["at"], pop(760, 320), 0.11)
put(TL["end"], pop(980, 400), 0.2)
put(TL["end"] + 0.05, chime([1174.66, 1479.98, 1760.0], dur=1.8, tau=0.6), 0.09)
for (ta, na, _), (tb2, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb2 - ta < 1.5:
        put(ta, whoosh(tb2 - ta + 0.2, 280, 1300, peak=0.5, q=0.7), 0.05)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "spin", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
