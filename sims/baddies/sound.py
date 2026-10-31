#!/usr/bin/env python3
"""Soundtrack for the baddies what-if, built on the same timeline.json.

The street runs on world time like the picture. The baddies leave with a
glam sparkle; what they held lands with real timing (the bottle on the table,
the iced coffee and its ice on the pavement, the phone); a light drone and a
tick on every world second carry the wait; they respawn with a reversed
shimmer. Then the twist: a rumble and roar that grow as the tsunami comes
over the rooftops, the crash, and a muffled underwater bed under the end card.

    python3 sims/baddies/sound.py [-o out/sims/baddies/sound.wav]

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


mix = Mix(DUR, seed=9)
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
while t < TS["at"]:
    if t < T0 - 0.3 or t > T1 + 0.5:
        f = rr.uniform(2800, 4200)
        for c in range(rr.randint(2, 4)):
            put(t + c * 0.09, blip(f * (1 + 0.08 * c), dur=0.08, tau=0.02), 0.035, rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.5, 1.1)

# 2. the baddies leave: a glam sparkle
put(T0 - 1.0, riser(1.0, 500, 6000), 0.12)
put(T0, impact(1.2), 0.45)
put(T0, chime([1318.51, 1661.22, 1975.53, 2637.02], dur=2.6, tau=1.0), 0.14)
put(T0, glitter(2.2, 140, 2600, 9000, 3), 0.11)
put(T0 + 0.02, glitter(1.2, 40, 2600, 7400, 5), 0.07)  # the tile shatters

# 3. what they held lands, on real fall times
tb = t_of_world(fall_time(0.255))
put(tb, click(1900, 0.05), 0.3, 0.1)
put(tb, chime([2093.0, 2793.83], dur=0.6, tau=0.12), 0.08, 0.1)
put(tb + 0.05, whoosh(1.4, 900, 300, peak=0.2, q=0.9), 0.06, 0.1)  # water over the table
tc = t_of_world(0.501)
put(tc, thump(170, 90, 0.18), 0.4, -0.3)
put(tc, whoosh(0.9, 2400, 500, peak=0.08, q=0.8), 0.12, -0.3)  # the coffee goes everywhere
for k in range(4):
    put(tc + 0.05 + k * 0.07, click(rr.uniform(2600, 4200), 0.03), 0.12, -0.3 + 0.1 * k)  # ice
tp = t_of_world(fall_time(1.45))
put(tp, click(1200, 0.06), 0.22, 0.5)
put(tp + 0.06, click(1600, 0.04), 0.12, 0.5)
# the ring light keeps humming
put(9.4, [math.sin(2 * math.pi * 100 * k / SR) * 0.5 * math.sin(math.pi * k / (2.8 * SR)) for k in range(int(2.8 * SR))], 0.04, 0.5)

# 4. the wait: a light drone and a tick per world second
vol = envelope([(0, 0), (T0, 0), (T0 + 0.8, 1), (T1 - 0.6, 1.2), (T1, 1.2), (T1 + 0.3, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [146.83, 220.0, 293.66, 369.99, 440.0])], volume=vol, detune=0.5, tremolo=0.15), gain=0.04)
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.06), 0.2, 0.15)
    put(tw, thump(95, 60, 0.14), 0.22)

# 5. respawn
put(T1 - 0.9, riser(0.9, 900, 7000), 0.14)
put(T1, chime([1661.22, 1975.53, 2489.02, 3322.44], dur=2.0, tau=0.7), 0.12)
put(T1, glitter(0.8, 80, 3000, 9000, 11), 0.08)

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
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "baddies", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
