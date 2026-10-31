#!/usr/bin/env python3
"""Soundtrack for the selenium what-if, built on the same timeline.json.

The city runs on world time like the picture: when the clock slows to 0.1x
the street muffles and its chatter slows down, and both open back up as the
speed climbs to 0.6x and snaps to 1x on the return. On top: the slam into
slow motion, a heartbeat, a dark drone, one sound per consequence (glass
tinkle, pigment swish, solar power-down, screen glitch, body scan), a clock
tick on every world second, and the hit when selenium comes back.

    python3 sims/selenium/sound.py [-o out/sims/selenium/sound.wav]

Mux it with capture.mjs: --music <wav> --music-start 0 --no-sync --lufs -14
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


RK = TL["ripple"]


def t_of_r(r):
    for (ta, ra), (tb, rb) in zip(RK, RK[1:]):
        if r <= rb:
            return ta + (tb - ta) * (r - ra) / (rb - ra)
    return RK[-1][0]


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


mix = Mix(DUR, seed=34)
put = mix.put
fc_city = lambda s: 200 + 8000 * speed(s / SR) ** 1.8  # noqa: E731

# 1. the street: wash, rumble, chatter, all muffled by the slow motion
for k, pan in ((0, -1), (1, 1)):
    wash = svf(svf(white(10 + k), 1100, 0.45, "bp"), fc_city, 0.7)
    rumble = svf(brown(20 + k), 170, 0.7)
    voices = [0.0] * N
    for v in range(5):
        rr = random.Random(40 + v + 10 * k)
        f, ph = rr.uniform(2.6, 4.6), rr.uniform(0, 6.3)
        band = svf(white(50 + v + 10 * k), rr.uniform(500, 1300), 1.2, "bp")
        am = env(lambda t, f=f, ph=ph: max(0.0, math.sin(2 * math.pi * f * world(t) + ph)) ** 2 * (0.6 + 0.4 * math.sin(world(t) * 0.7 + ph)))
        voices = [a + b * c for a, b, c in zip(voices, band, am)]
    voices = svf(voices, fc_city, 0.7)
    level = env(lambda t: 0.55 + 0.45 * speed(t))
    bed = [(0.5 * a + 0.9 * b + 0.45 * c) * g for a, b, c, g in zip(norm(wash), norm(rumble), norm(voices), level)]
    if pan < 0:
        mix.put_stereo(0, bed, [0.0] * N, gain=0.2)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.2)

# birds, only at normal speed
rr = random.Random(7)
t = 0.2
while t < DUR:
    if t < T0 - 0.3 or t > T1 + 0.5:
        f = rr.uniform(2800, 4200)
        for c in range(rr.randint(2, 4)):
            put(t + c * 0.09, blip(f * (1 + 0.08 * c), dur=0.08, tau=0.02), 0.035, rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.5, 1.1)

# 2. pigeons burst off the road just before the slam
for k in range(7):
    tk = t_of_world(-0.42 + k * 0.05)
    put(tk, whoosh(0.09, 500, 1800, peak=0.4, q=0.8), 0.13, -0.35 + 0.08 * k)

# 3. the slam into slow motion
put(T0 - 1.15, riser(1.15, 300, 4600), 0.16)
put(T0, impact(1.8), 0.95)
put(T0, thump(190, 34, 2.4, tau=0.9), 0.55)
put(T0 + 0.02, glitter(1.6, 60, 2600, 7400, 3), 0.11, 0.0)  # the tile shatters

# 4. heartbeat through the five seconds, a little faster as time speeds up
t = T0 + 0.55
while t < T1 - 0.3:
    put(t, thump(62, 42, 0.2), 0.62)
    put(t + 0.24, thump(54, 38, 0.18), 0.4)
    t += 1.12 - 0.42 * clamp01((t - T0) / TLEN)

# 5. drone under the slow motion, D minor; D major once selenium is back
vol = envelope([(0, 0), (T0, 0), (T0 + 1.0, 1), (T1 - 0.6, 1.35), (T1, 1.35), (T1 + 0.3, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [73.42, 110.0, 146.83, 174.61, 220.0, 329.63])], volume=vol, detune=0.4, tremolo=0.11), gain=0.036)
vol2 = envelope([(0, 0), (T1, 0), (T1 + 0.5, 1), (DUR - 0.6, 1), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [146.83, 220.0, 293.66, 369.99, 440.0])], volume=vol2, detune=0.6), gain=0.022)

# 6. a clock tick on every world second
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.06), 0.24, 0.15)
    put(tw, thump(95, 60, 0.14), 0.3)

# 7. the consequences
# glass: tinkle as the front crosses the table
tg = t_of_r(0.75)
put(tg, chime([2637.02, 3135.96, 3951.07], dur=2.4, tau=0.9), 0.12, -0.1)
put(tg - 0.1, glitter(1.4, 45, 3200, 8200, 5), 0.08, 0.1)
# water pouring, slowed and muffled with everything else
P = TL["pour"]
p0, p1 = t_of_world(P["tilt"] + 0.45), t_of_world(P["end"] - 0.25)
water = svf(white(70), 950, 1.4, "bp")
wam = env(lambda t: (0.55 + 0.45 * math.sin(world(t) * 2 * math.pi * 9.0) ** 2) * smooth((t - p0) / 0.1) * (1 - smooth((t - p1) / 0.2)))
mix.put_stereo(0, *(lambda w: (w, w))(svf(mul(water, wam), fc_city, 0.7)), gain=0.1)
# the passing car, a long low swell in slow motion
tc = t_of_world(0.374)
car = svf(brown(80), 260, 0.8)
cam = env(lambda t: math.exp(-(((t - tc) / 1.6) ** 2)))
cl, cr = [], []
for i, (v, e) in enumerate(zip(car, cam)):
    p = max(-1.0, min(1.0, (i / SR - tc) / 2.5))
    cl.append(v * e * math.sqrt(0.5 * (1 - p)))
    cr.append(v * e * math.sqrt(0.5 * (1 + p)))
mix.put_stereo(0, norm(cl), norm(cr), gain=0.12)
# pigment: a soft swish and a lower bell as the chairs flip
tr = t_of_r(3.4)
put(tr - 0.2, whoosh(0.9, 380, 1900, peak=0.5), 0.1, -0.3)
put(tr, chime([987.77, 1318.51, 1567.98], dur=2.0, tau=0.7), 0.09, -0.2)
put(tr, glitter(1.6, 30, 1800, 5200, 6), 0.06, -0.2)
# solar facade: electrical power-down while the front crosses it
ts0, ts1 = t_of_r(18.5), t_of_r(30.5)
n = int((ts1 - ts0 + 0.8) * SR)
buzz = []
ph = 0.0
for k in range(n):
    x = k / n
    ph += 2 * math.pi * (120 - 92 * x ** 0.8) / SR
    s = sum(math.sin(h * ph) / h for h in range(1, 7))
    buzz.append(s * math.sin(math.pi * min(1, x * 3)) * (1 - x) ** 0.6)
put(ts0, svf(buzz, 1800, 0.7), 0.13, 0.35)
rr = random.Random(9)
for _ in range(26):
    put(rr.uniform(ts0, ts1), click(rr.uniform(2500, 6000), 0.02), rr.uniform(0.05, 0.14), rr.uniform(0.1, 0.7))
put(ts1 - 0.05, thump(110, 40, 0.5), 0.3, 0.3)
# screen: digital glitch and a thunk as the billboard loses red and green
tb0, tb1 = t_of_r(47.0), t_of_r(50.5)
rr = random.Random(11)
for k in range(14):
    tk = tb0 + (tb1 - tb0 + 0.2) * k / 14 + rr.uniform(-0.01, 0.01)
    put(tk, blip(rr.choice([440, 587.33, 880, 1174.66, 1760]), dur=0.06, tau=0.02), 0.07, rr.uniform(-0.5, 0.5))
put(tb1, thump(90, 42, 0.6), 0.4)
put(tb1, glitter(1.2, 30, 2000, 6000, 12), 0.06)
# body: a scan sweep and sonar pings
H = TL["holo"]
put(H["in"], whoosh(0.6, 300, 1400, peak=0.6), 0.08)
ns = int((H["scanEnd"] - H["scan"]) * SR)
scan = svf(white(90)[:ns], lambda s: 2600 * (0.15 ** (s / ns)) + 200, 2.5, "bp")
put(H["scan"], [v * math.sin(math.pi * k / ns) for k, v in enumerate(scan)], 0.16)
for k, dt in enumerate((0.0, 0.75, 1.5)):
    put(H["scan"] + dt, blip(1318.51 if k < 2 else 1760.0, dur=1.0, tau=0.35), 0.07, 0.15)

# 8. selenium comes back
put(T1 - 0.95, riser(0.95, 400, 6400), 0.2)
put(T1, impact(1.3), 0.6)
put(T1, chime([587.33, 880.0, 1174.66, 1479.98], dur=2.6, tau=1.0), 0.13)
put(T1, whoosh(0.8, 3000, 600, peak=0.2), 0.12)

# 9. captions, callouts and the end card
for c in TL["captions"]:
    put(c["at"], pop(760, 320), 0.11)
put(TL["end"], pop(980, 400), 0.2)
put(TL["end"] + 0.05, chime([1174.66, 1479.98, 1760.0], dur=1.8, tau=0.6), 0.09)
# camera turns
for (ta, na, _), (tb, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb - ta < 1.5:
        put(ta, whoosh(tb - ta + 0.2, 280, 1300, peak=0.5, q=0.7), 0.05, 0.2 if nb in ("facade", "friendBody") else -0.2)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "selenium", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
