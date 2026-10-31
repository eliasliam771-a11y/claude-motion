#!/usr/bin/env python3
"""Soundtrack for the atoms what-if, built on the same timeline.json.

No air, no sound: the street (in world time, like the picture) crackles
apart with the atoms and cuts to silence for the five seconds, then slams
back. The void carries only score: a soft drone, a tick on every world
second, a shimmer of stars, a low note as the Moon's light runs out, quiet
ticks for neutrinos, and a bright hit when everything returns.

    python3 sims/atoms/sound.py [-o out/sims/atoms/sound.wav]

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


def gone(w):
    """1 while there are no atoms (main.js disAt, past halfway)."""
    d = clamp01(w / TL["dissolve"]) if w < SL["world"] - 0.5 else 1 - clamp01((w - SL["world"]) / TL["dissolve"])
    return smooth((d - 0.35) / 0.4)


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


mix = Mix(DUR, seed=6)
put = mix.put
air = env(lambda t: 1 - gone(world(t)))  # sound needs air

# 1. the street in world time, until there is no air to carry it
for k, side in ((0, "l"), (1, "r")):
    fc = lambda s: 200 + 8000 * speed(s / SR) ** 1.8  # noqa: E731
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
    bed = [(0.5 * a + 0.9 * b + 0.45 * c) * g * q for a, b, c, g, q in zip(norm(wash), norm(rumble), norm(voices), level, air)]
    if side == "l":
        mix.put_stereo(0, bed, [0.0] * N, gain=0.26)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.26)
rr = random.Random(7)
t = 0.2
while t < DUR:
    if t < T0 - 0.3 or t > T1 + 0.5:
        f = rr.uniform(2800, 4200)
        for c in range(rr.randint(2, 4)):
            put(t + c * 0.09, blip(f * (1 + 0.08 * c), dur=0.08, tau=0.02), 0.035, rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.5, 1.1)

# 2. the atoms go: a hit, a crackle of disintegration, then nothing
td = t_of_world(TL["dissolve"])
put(T0 - 1.15, riser(1.15, 300, 4600), 0.16)
put(T0, impact(1.6), 0.7)
put(T0, thump(160, 30, 2.2, tau=0.8), 0.35)
put(T0, glitter(td - T0 + 0.4, 220, 1800, 9000, 3), 0.12)
put(T0 + 0.02, glitter(1.2, 40, 2600, 7400, 5), 0.07)  # the tile shatters

# 3. the void: score only
vol = envelope([(0, 0), (T0, 0), (T0 + 0.8, 1), (T1 - 0.6, 1.3), (T1, 1.3), (T1 + 0.3, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [73.42, 110.0, 146.83, 220.0, 329.63, 440.0])], volume=vol, detune=0.5, tremolo=0.08), gain=0.05)
vol2 = envelope([(0, 0), (T1, 0), (T1 + 0.5, 1), (DUR - 0.6, 1), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [146.83, 220.0, 293.66, 369.99, 440.0])], volume=vol2, detune=0.6), gain=0.022)
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.06), 0.2, 0.15)
    put(tw, thump(95, 60, 0.14), 0.22)
rr = random.Random(21)
t = T0 + 1.0
while t < T1 - 0.4:
    put(t, blip(rr.choice([2349.32, 2637.02, 2959.96, 3520.0, 3951.07]), dur=0.4, tau=0.12), rr.uniform(0.012, 0.03), rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.25, 0.6)
tm = t_of_world(1.28)
put(tm, thump(130, 55, 0.8), 0.25, 0.3)
put(tm, chime([659.25, 987.77], dur=1.6, tau=0.5), 0.06, 0.3)
for k in range(28):
    put(TL["left"][1] + 0.1 + k * 0.06 + random.Random(k).uniform(0, 0.04), click(random.Random(k + 50).uniform(3000, 7000), 0.015), 0.05, random.Random(k + 99).uniform(-0.9, 0.9))

# 4. everything returns at once
put(T1 - 0.95, riser(0.95, 400, 6400), 0.2)
put(T1, impact(1.3), 0.6)
put(T1, whoosh(0.8, 3000, 600, peak=0.2), 0.12)
put(T1 + 0.05, chime([587.33, 880.0, 1174.66, 1479.98], dur=2.6, tau=1.0), 0.12)

# 5. the gap in the sunlight, the captions, the end card
put(TL["gap"][0], whoosh(1.2, 300, 1600, peak=0.6), 0.1)
for c in TL["captions"]:
    put(c["at"], pop(760, 320), 0.11)
put(TL["end"], pop(980, 400), 0.2)
put(TL["end"] + 0.05, chime([1174.66, 1479.98, 1760.0], dur=1.8, tau=0.6), 0.09)
for (ta, na, _), (tb, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb - ta < 1.5:
        put(ta, whoosh(tb - ta + 0.2, 280, 1300, peak=0.5, q=0.7), 0.05)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "atoms", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
