#!/usr/bin/env python3
"""Soundtrack for the aluminium what-if, built on the same timeline.json.

The street on world time like the picture, muffled in the slow motion. The
slam and a metallic shimmer as the aluminium goes; the cola's splash and its
drip off the table; the glass wall landing pane by pane; steel brake discs
grinding on asphalt; the pavement cracking; the power dying. The return, the
alloy wheels clattering onto the road, a fast-forward of 6 minutes, and the
tsunami: roar, crash, under water.

    python3 sims/aluminium/sound.py [-o out/sims/aluminium/sound.wav]
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
TS = TL["tsunami"]


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


def under_v(t):
    return smooth((t - TS["hit"] + 0.1) / 0.25)


def noise_burst(dur, f, q, seed, tau):
    n = int(dur * SR)
    x = svf(white(seed, n), f, q, "bp")
    return [v * math.exp(-k / (tau * SR)) for k, v in enumerate(x)]


mix = Mix(DUR, seed=13)
put = mix.put
fc_city = lambda s: (220 + 8000 * min(1.0, speed(s / SR)) ** 1.8) * (1 - 0.93 * under_v(s / SR))  # noqa: E731
under = env(under_v)
slow = lambda t: max(0.1, min(1.0, speed(t)))  # noqa: E731

# 1. the street: wash, voices, birds
for k, pan in ((0, -1), (1, 1)):
    wash = svf(svf(white(10 + k), 1100, 0.45, "bp"), fc_city, 0.7)
    rumble = svf(brown(20 + k), 170, 0.7)
    voices = [0.0] * N
    for v in range(5):
        rr = random.Random(40 + v + 10 * k)
        f, ph = rr.uniform(2.6, 4.6), rr.uniform(0, 6.3)
        band = svf(white(50 + v + 10 * k), rr.uniform(500, 1300), 1.2, "bp")
        am = env(lambda t, f=f, ph=ph: max(0.0, math.sin(2 * math.pi * f * min(world(t), 12) + ph)) ** 2 * (0.6 + 0.4 * math.sin(world(t) * 0.7 + ph)))
        voices = [a + b * c for a, b, c in zip(voices, band, am)]
    voices = svf(voices, fc_city, 0.7)
    level = env(lambda t: 0.55 + 0.45 * min(1.0, speed(t)))
    bed = [(0.5 * a + 0.6 * b + 0.5 * c) * g for a, b, c, g in zip(norm(wash), norm(rumble), norm(voices), level)]
    if pan < 0:
        mix.put_stereo(0, bed, [0.0] * N, gain=0.2)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.2)
rr = random.Random(7)
t = 0.2
while t < TS["at"]:
    if t < T0 - 0.3 or T1 + 0.5 < t < FF["from"]:
        f = rr.uniform(2800, 4200)
        for c in range(rr.randint(2, 4)):
            put(t + c * 0.09, blip(f * (1 + 0.08 * c), dur=0.08, tau=0.02), 0.03, rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.5, 1.1)

# 2. the slam, and aluminium leaving everything at once
put(T0 - 1.15, riser(1.15, 300, 4600), 0.14)
put(T0, impact(1.8), 0.8)
put(T0, thump(190, 34, 2.4, tau=0.9), 0.45)
put(T0 + 0.02, glitter(1.6, 60, 2600, 7400, 3), 0.1)
for k in range(14):  # a metallic shimmer
    put(T0 + 0.05 + k * 0.11, blip(random.Random(k).uniform(3500, 7800), dur=0.6, tau=0.2), 0.035, (k % 5 - 2) * 0.3)
# the power dies: a falling buzz and a clunk
n = int(1.2 * SR)
buzz, ph = [], 0.0
for j in range(n):
    x = j / n
    ph += 2 * math.pi * (100 - 70 * x ** 0.7) / SR
    buzz.append(sum(math.sin(h * ph) / h for h in range(1, 6)) * (1 - x) ** 0.8 * min(1, j / 400))
put(t_of_world(0.03), svf(buzz, 1500, 0.7), 0.1, 0.3)

# 3. the cola: a splash, then a stream off the table and drips
ts = t_of_world(0.15)
put(ts, noise_burst(1.4, 1400, 0.9, 60, 0.35), 0.16)
rr = random.Random(61)
for k in range(24):
    put(ts + rr.uniform(0, 1.2), blip(rr.uniform(900, 2200) * slow(ts), dur=0.08, tau=0.025), rr.uniform(0.02, 0.05), rr.uniform(-0.3, 0.3))
t0s, t1s = t_of_world(0.28), t_of_world(1.3)
stream = svf(white(62), 900, 1.2, "bp")
sam = env(lambda t: smooth((t - t0s) / 0.3) * (1 - smooth((t - t1s) / 0.4)))
sv = svf(mul(stream, sam), fc_city, 0.7)
mix.put_stereo(0, sv, [0.8 * v for v in sv], gain=0.06)

# 4. the glass wall landing pane by pane
rh = (23.2 - 5) / 6
rr = random.Random(70)
for r in range(6):
    yc = 5 + (r + 0.5) * rh
    tl = math.sqrt(2 * (yc - (rh - 0.08) / 2 - 0.12) / 9.81)
    for c in range(8):
        tw = t_of_world(tl + rr.uniform(0, 0.05))
        put(tw, glitter(0.9, 26, 2400, 8000, 100 + r * 8 + c), 0.04, 0.6)
        put(tw, noise_burst(0.5, 3200, 0.7, 120 + r * 8 + c, 0.12), 0.05, 0.6)
        put(tw, thump(150, 60, 0.2), 0.08, 0.6)

# 5. the car: a clunk as it drops, then steel grinding on asphalt
tc = t_of_world(0.05)
put(tc, thump(110, 50, 0.4), 0.3, 0.35)
g0, g1 = t_of_world(0.02), t_of_world(9 / (0.55 * 9.81))
grind = svf(svf(white(80), 3200, 1.6, "bp"), fc_city, 0.7)
gam = env(lambda t: smooth((t - g0) / 0.2) * (1 - smooth((t - g1 + 0.2) / 0.4)) * (0.6 + 0.4 * math.sin(world(t) * 90) ** 2))
gv = mul(grind, gam)
mix.put_stereo(0, [0.6 * v for v in gv], gv, gain=0.1)

# 6. the sapphire, a small cold chime
put(TL["captions"][3]["hit"] + 0.1, chime([1760.0, 2637.02, 3520.0], dur=1.6, tau=0.5), 0.05)

# 7. the pavement cracking: a low groan and crackle
c0 = t_of_world(2.0)
groan = svf(brown(90, 0.998), 90, 0.8)
grm = env(lambda t: math.exp(-(((world(t) - 2.6) / 0.6) ** 2)) * (1 if world(t) < SL["world"] else 0))
mix.put_stereo(0, *(lambda g: (g, g))(mul(norm(groan), grm)), gain=0.25)
rr = random.Random(90)
for _ in range(60):
    put(t_of_world(2.0 + rr.uniform(0, 1.4)), click(rr.uniform(800, 3000), 0.02), rr.uniform(0.04, 0.12), rr.uniform(-0.8, 0.8))

# 8. heartbeat, drone, a tick on every world second
t = T0 + 0.6
while t < T1 - 0.3:
    put(t, thump(62, 42, 0.2), 0.45)
    put(t + 0.24, thump(54, 38, 0.18), 0.3)
    t += 1.15 - 0.4 * clamp01((t - T0) / TLEN)
vol = envelope([(0, 0), (T0, 0), (T0 + 1.0, 1), (T1 - 0.6, 1.3), (T1, 1.3), (T1 + 0.4, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [73.42, 110.0, 146.83, 174.61, 220.0])], volume=vol, detune=0.4, tremolo=0.1), gain=0.032)
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.06), 0.2, 0.15)
    put(tw, thump(95, 60, 0.14), 0.24)

# 9. aluminium is back: the hit, and the wheels clattering onto the road
put(T1 - 0.95, riser(0.95, 400, 6400), 0.15)
put(T1 - 0.5, glitter(0.5, 60, 3600, 9400, 6, rev=True), 0.07)
put(T1, impact(1.3), 0.45)
put(T1, chime([587.33, 880.0, 1174.66], dur=2.2, tau=0.9), 0.08)
rr = random.Random(95)
for k in range(4):
    tw = t_of_world(SL["world"] + 0.17 + k * 0.05)
    put(tw, blip(rr.uniform(500, 900), dur=0.7, tau=0.25), 0.07, -0.2)
    put(tw + 0.25, blip(rr.uniform(700, 1100), dur=0.5, tau=0.15), 0.05, -0.2)
put(FF["from"] - 0.1, riser(FF["to"] - FF["from"] + 0.1, 500, 7000), 0.1)
for k in range(10):
    put(FF["from"] + k * 0.1, click(1800 + 300 * k, 0.02), 0.05)

# 10. the tsunami: rumble and roar grow, the crash, then underwater
ramp = env(lambda t: smooth((t - TS["at"]) / (TS["hit"] - TS["at"])) ** 1.6 * (1 - under_v(t)))
for k in (0, 1):
    roar = svf(white(200 + k), lambda s: 300 + 2600 * smooth((s / SR - TS["at"]) / (TS["hit"] - TS["at"])), 0.6)
    rum = svf(brown(210 + k, 0.998), 120, 0.7)
    layer = [(0.7 * a + 0.9 * b) * g for a, b, g in zip(norm(roar), norm(rum), ramp)]
    mix.put_stereo(0, layer if k == 0 else [0.0] * N, [0.0] * N if k == 0 else layer, gain=0.32)
put(TS["hit"] - 0.05, impact(1.6), 0.8)
put(TS["hit"] - 0.05, whoosh(1.2, 4000, 300, peak=0.1, q=0.6), 0.22)
bub = svf(brown(230, 0.995), 400, 0.7)
mix.put_stereo(0, *(lambda b: (b, b))(mul(norm(bub), under)), gain=0.11)
rr = random.Random(41)
t = TS["hit"] + 0.1
while t < DUR - 0.3:
    put(t, blip(rr.uniform(300, 900), dur=0.12, tau=0.04), rr.uniform(0.03, 0.07), rr.uniform(-0.7, 0.7))
    t += rr.uniform(0.06, 0.2)

# 11. captions, the end card, camera turns
for c in TL["captions"]:
    put(c["at"], pop(760, 320), 0.1)
put(TL["end"], pop(980, 400), 0.16)
put(TL["end"] + 0.05, chime([587.33, 739.99, 880.0], dur=1.8, tau=0.6), 0.07)
for (ta2, na, _), (tb, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb - ta2 < 1.5 and not na.startswith("wave") and na != "north":
        put(ta2, whoosh(tb - ta2 + 0.2, 280, 1300, peak=0.5, q=0.7), 0.045, -0.2)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "aluminium", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
