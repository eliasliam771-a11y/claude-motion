#!/usr/bin/env python3
"""Soundtrack for the gravity x4 what-if, built on the same timeline.json.

The street runs on world time like the picture. Gravity quadruples with a
slam and a sub drop; then, because the whole planet is falling and you with
it, the street sounds just the same (water pouring, voices), only a deep groan
grows underneath. Gravity's return is a release; a fast-forward of 30 s; then
the earthquake: rumble, roar, glass breaking, cornices landing, things off the
tables, a car alarm, aftershocks. A low bell for the planet ringing.

    python3 sims/gravity/sound.py [-o out/sims/gravity/sound.wav]
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
FF = TL["ff"]
QK = TL["quake"]
P0 = TL["pour"]


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
    if FF["from"] <= t < FF["to"]:
        return 1 + (FF["peak"] - 1) * math.sin(math.pi * (t - FF["from"]) / (FF["to"] - FF["from"]))
    return 1.0


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
    if w <= WT[0]:
        return w - WT[0]
    while hi - lo > 1:
        m = (lo + hi) // 2
        if WT[m] < w:
            lo = m
        else:
            hi = m
    return lo * DT


def env(fn):
    out = [0.0] * N
    for s in range(0, N, 64):
        v = fn(s / SR)
        out[s:s + 64] = [v] * min(64, N - s)
    return out


def white(seed, n=N):
    r = random.Random(seed).random
    return [2.0 * r() - 1.0 for _ in range(n)]


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


def glitter(dur, n_hits, f_lo, f_hi, seed, rev=False):
    """Dense little glassy blips: atoms leaving (or, reversed, arriving)."""
    rr = random.Random(seed)
    out = [0.0] * int(dur * SR)
    for _ in range(n_hits):
        u = rr.random() ** 1.6
        if rev:
            u = 1 - u
        at = int(u * (len(out) - 0.06 * SR))
        b = blip(rr.uniform(f_lo, f_hi), dur=0.05, tau=0.012)
        g = rr.uniform(0.3, 1.0)
        for k, v in enumerate(b):
            if at + k < len(out):
                out[at + k] += v * g
    return out


def mul(a, b):
    return [x * y for x, y in zip(a, b)]


def quake(t):
    main = smooth((t - QK["at"]) / 0.35) * (1 - smooth((t - QK["peak"]) / QK["fade"]))
    after = max([k * smooth((t - a) / 0.15) * (1 - smooth((t - a - 0.25) / 0.9)) for a, k in QK["after"]] + [0.0])
    return max(main, after)


mix = Mix(DUR, seed=41)
put = mix.put
fc_city = lambda s: 220 + 8000 * min(1.0, speed(s / SR)) ** 1.8  # noqa: E731
Q = env(quake)

# 1. the street: wash, voices, birds; it goes quiet under the quake, then murmurs
for k, pan in ((0, -1), (1, 1)):
    wash = svf(svf(white(10 + k), 1100, 0.45, "bp"), fc_city, 0.7)
    rumble = svf(brown(20 + k), 160, 0.7)
    voices = [0.0] * N
    for v in range(6):
        rr = random.Random(40 + v + 10 * k)
        f, ph = rr.uniform(2.6, 4.6), rr.uniform(0, 6.3)
        band = svf(white(50 + v + 10 * k), rr.uniform(450, 1300), 1.2, "bp")
        am = env(lambda t, f=f, ph=ph: max(0.0, math.sin(2 * math.pi * f * min(world(t), 12) + ph)) ** 2 * (0.5 + 0.5 * math.sin(world(t) * 0.7 + ph)))
        voices = [a + b * c for a, b, c in zip(voices, band, am)]
    voices = svf(voices, fc_city, 0.7)
    level = env(lambda t: (0.45 + 0.55 * min(1.0, speed(t))) * (1 - 0.6 * quake(t)))
    bed = [(0.45 * a + 0.5 * b + 0.6 * c) * g for a, b, c, g in zip(norm(wash), norm(rumble), norm(voices), level)]
    if pan < 0:
        mix.put_stereo(0, bed, [0.0] * N, gain=0.18)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.18)
rr = random.Random(7)
t = 0.2
while t < QK["at"]:
    if t < T0 - 0.3 or (T1 + 0.5 < t < FF["from"]):
        f = rr.uniform(2800, 4200)
        for c in range(rr.randint(2, 4)):
            put(t + c * 0.09, blip(f * (1 + 0.08 * c), dur=0.08, tau=0.02), 0.03, rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.5, 1.1)

# 2. the friend's pour, which sounds like any pour: everything is falling together
p0, p1 = t_of_world(P0["tilt"] + 0.45), t_of_world(P0["end"] - 0.25)
water = svf(white(70), 950, 1.4, "bp")
wam = env(lambda t: (0.55 + 0.45 * math.sin(world(t) * 2 * math.pi * 9.0) ** 2) * smooth((t - p0) / 0.1) * (1 - smooth((t - p1) / 0.2)))
wv = svf(mul(water, wam), fc_city, 0.7)
mix.put_stereo(0, wv, wv, gain=0.09)

# 3. gravity x4: the slam and a sub drop
put(T0 - 1.15, riser(1.15, 300, 4600), 0.14)
put(T0, impact(1.8), 0.85)
put(T0, thump(90, 22, 3.2, tau=1.2), 0.5)
put(T0 + 0.02, glitter(1.6, 60, 2600, 7400, 3), 0.1)

# 4. the 5 seconds: heartbeat, drone, ticks, and the planet groaning underneath
t = T0 + 0.6
while t < T1 - 0.3:
    put(t, thump(62, 42, 0.2), 0.45)
    put(t + 0.24, thump(54, 38, 0.18), 0.3)
    t += 1.15 - 0.4 * clamp01((t - T0) / TLEN)
vol = envelope([(0, 0), (T0, 0), (T0 + 1.0, 1), (T1 - 0.6, 1.3), (T1, 1.3), (T1 + 0.4, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [55.0, 82.41, 110.0, 130.81, 164.81])], volume=vol, detune=0.4, tremolo=0.1), gain=0.034)
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.06), 0.2, 0.15)
    put(tw, thump(95, 60, 0.14), 0.24)
groan = svf(svf(brown(90, 0.998), 70, 0.8), lambda s: 40 + 40 * clamp01((s / SR - T0) / TLEN), 0.9, "hp")
gam = env(lambda t: smooth((t - T0) / TLEN) ** 1.5 * (1 - smooth((t - T1 - 0.3) / 0.6)) + 0.6 * smooth((t - FF["from"]) / 0.8) * (1 - smooth((t - QK["at"] - 0.5) / 0.6)))
mix.put_stereo(0, *(lambda g: (g, g))(mul(norm(groan), gam)), gain=0.2)
# first tremors: the glass rattles a little
rr = random.Random(12)
for k in range(10):
    put(t_of_world(3.7 + k * 0.13 + rr.uniform(0, 0.05)), click(rr.uniform(3800, 5200), 0.01), 0.035, -0.1)

# 5. gravity is back: a release; then the fast-forward
put(T1 - 0.6, whoosh(1.2, 300, 2400, peak=0.4), 0.1)
put(T1, thump(150, 60, 0.5), 0.3)
put(T1, chime([220.0, 329.63, 440.0], dur=1.6, tau=0.6), 0.06)
put(FF["from"] - 0.1, riser(FF["to"] - FF["from"] + 0.1, 500, 7000), 0.1)
for k in range(10):
    put(FF["from"] + k * 0.11, click(1800 + 300 * k, 0.02), 0.06)

# 6. the earthquake
for k in (0, 1):
    deep = svf(brown(200 + k, 0.998), 140, 0.8)
    mid = svf(svf(white(210 + k), 900, 0.6), 160, 0.7, "hp")
    lay = [(0.9 * a + 0.35 * b) * q for a, b, q in zip(norm(deep), norm(mid), Q)]
    mix.put_stereo(0, lay if k == 0 else [0.0] * N, [0.0] * N if k == 0 else lay, gain=0.42)
put(QK["at"], impact(2.0), 0.7)
rr = random.Random(31)
for _ in range(90):  # windows breaking up and down the street
    tg = QK["at"] + 0.25 + rr.uniform(0, 1.9)
    put(tg, click(rr.uniform(3000, 7500), 0.015), rr.uniform(0.03, 0.09), rr.uniform(-0.9, 0.9))
put(QK["at"] + 0.3, glitter(2.2, 120, 3000, 9000, 33), 0.08, -0.4)
put(QK["at"] + 0.4, glitter(2.2, 120, 3000, 9000, 34), 0.08, 0.4)
for _ in range(16):  # chunks of cornice landing
    tl = QK["at"] + 0.4 + rr.uniform(0, 2.0) + rr.uniform(1.4, 2.0)
    put(tl, thump(rr.uniform(90, 140), 40, 0.35), rr.uniform(0.12, 0.25), rr.uniform(-0.8, 0.8))
for k in range(8):  # cups and glasses off the tables
    tc = QK["at"] + 0.4 + k * 0.13 + rr.uniform(0, 0.1)
    put(tc, chime([rr.uniform(2400, 3600), rr.uniform(3800, 5200)], dur=0.5, tau=0.12), 0.05, rr.uniform(-0.4, 0.4))
# a car alarm somewhere up the street
ta = QK["at"] + 1.3
n = int((DUR - ta) * SR)
alarm = []
for j in range(n):
    tt = j / SR
    f = 720 if int(tt * 2.5) % 2 == 0 else 980
    alarm.append((1.0 if math.sin(2 * math.pi * f * tt) > 0 else -1.0) * min(1, tt / 0.05))
put(ta, svf(alarm, 1800, 0.7), 0.025, 0.55)
for a, k in QK["after"]:
    put(a, thump(70, 30, 1.2, tau=0.5), 0.3 * k / 0.35)

# 7. Earth rings like a bell
cb = TL["captions"][8]
put(cb["hit"], chime([65.41, 130.81, 196.0, 261.63], dur=4.0, tau=1.6), 0.22)
put(cb["hit"] + 1.6, chime([65.41, 130.81, 196.0], dur=3.0, tau=1.2), 0.12)

# 8. captions, the end card, camera turns
for c in TL["captions"]:
    put(c["at"], pop(760, 320), 0.1)
put(TL["end"], pop(980, 400), 0.16)
put(TL["end"] + 0.05, chime([523.25, 659.25, 783.99], dur=1.8, tau=0.6), 0.07)
for (ta2, na, _), (tb, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb - ta2 < 1.5:
        put(ta2, whoosh(tb - ta2 + 0.2, 280, 1300, peak=0.5, q=0.7), 0.045, -0.2)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "gravity", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
