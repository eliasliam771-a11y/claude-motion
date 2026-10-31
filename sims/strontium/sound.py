#!/usr/bin/env python3
"""Soundtrack for the strontium what-if, built on the same timeline.json.

A fireworks night on world time, like the picture: every shell is a mortar
thump and a boom that reach you late, at the speed of sound (about 0.7 s from
the bay), crackle for the willows and the chrysanthemum, a crowd that cheers
and goes quiet, and the hiss of the road flare. When the clock slows to 0.1x
the whole street muffles and every boom stretches and drops in pitch. On top:
the slam into slow motion, a sparkle as the strontium leaves, a heartbeat, a
drone, a tick on every world second, one sound per consequence, and the hit
when strontium comes back.

    python3 sims/strontium/sound.py [-o out/sims/strontium/sound.wav]
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
EYE = (-8.3, 1.3, 0.0)
C_SOUND = 343.0
RISE = 1.4


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


def boom(sp, seed, big=False):
    """A shell bursting over the bay: low thump, a crack rolled off by 250 m of air,
    echoes off the street. Slow motion stretches it and drops its pitch."""
    sp = max(sp, 0.1)
    st = 1 / sp ** 0.65
    pf = sp ** 0.5
    n = int(2.4 * st * SR)
    rr = random.Random(seed)
    out = [0.0] * n
    ph = 0.0
    lpv = 0.0
    for k in range(n):
        tt = k / SR / st
        f = (40 + 75 * math.exp(-tt / 0.05)) * pf
        ph += 2 * math.pi * f / SR
        lpv += 0.06 * pf * (rr.uniform(-1, 1) - lpv)
        s = math.sin(ph) * math.exp(-tt / (0.42 if big else 0.32)) + lpv * math.exp(-tt / 0.1) * 2.8
        out[k] = math.tanh(1.4 * s) * min(1.0, k / (0.003 * SR))
    base = out[:]
    for d, g in ((0.19, 0.38), (0.43, 0.24), (0.86, 0.13), (1.3, 0.07)):
        j0 = int(d * st * SR)
        for k in range(n - j0):
            out[k + j0] += base[k] * g
    return out


def crackle(sp, dur, seed, density=260):
    """Willow and chrysanthemum stars popping as they burn out."""
    sp = max(sp, 0.1)
    st = 1 / sp ** 0.65
    n = int(dur * st * SR)
    rr = random.Random(seed)
    out = [0.0] * n
    for _ in range(int(density * dur)):
        u = rr.random() ** 0.7
        at = int(u * (n - 200))
        g = (1 - u) ** 0.5 * rr.uniform(0.3, 1.0)
        b = click(rr.uniform(1500, 4200) * sp ** 0.5, 0.012)
        for k, v in enumerate(b):
            if at + k < n:
                out[at + k] += v * g
    return out


mix = Mix(DUR, seed=38)
put = mix.put
fc_city = lambda s: 220 + 8000 * speed(s / SR) ** 1.8  # noqa: E731

# 1. the street: crowd murmur and wash, all muffled by the slow motion
for k, pan in ((0, -1), (1, 1)):
    wash = svf(svf(white(10 + k), 1100, 0.45, "bp"), fc_city, 0.7)
    rumble = svf(brown(20 + k), 160, 0.7)
    voices = [0.0] * N
    for v in range(7):
        rr = random.Random(40 + v + 10 * k)
        f, ph = rr.uniform(2.6, 4.6), rr.uniform(0, 6.3)
        band = svf(white(50 + v + 10 * k), rr.uniform(450, 1300), 1.2, "bp")
        am = env(lambda t, f=f, ph=ph: max(0.0, math.sin(2 * math.pi * f * world(t) + ph)) ** 2 * (0.6 + 0.4 * math.sin(world(t) * 0.7 + ph)))
        voices = [a + b * c for a, b, c in zip(voices, band, am)]
    voices = svf(voices, fc_city, 0.7)
    level = env(lambda t: 0.5 + 0.5 * speed(t))
    bed = [(0.4 * a + 0.45 * b + 0.6 * c) * g for a, b, c, g in zip(norm(wash), norm(rumble), norm(voices), level)]
    if pan < 0:
        mix.put_stereo(0, bed, [0.0] * N, gain=0.17)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.17)

# the crowd cheering ("aah"): two formant bands, swelling after the big bursts
aah = [a + 0.7 * b for a, b in zip(svf(white(60), 720, 3.0, "bp"), svf(white(61), 1150, 3.5, "bp"))]
cheer_at = []
for wb, kind, col, x, y, z in TL["fireworks"]:
    if kind in ("big", "ring") or (col == "red" and wb > SL["world"]):
        d = math.dist(EYE, (x, y, z))
        cheer_at.append(wb + d / C_SOUND + 0.25)
cheer_at.append(SL["world"] + 0.35)  # the fireworks are red again


def cheer_env(t):
    w = world(t)
    v = 0.0
    for c in cheer_at:
        if c < 0 or c > SL["world"] + 0.2:  # nobody cheers for a colour that is wrong
            dw = w - c
            if dw > 0:
                v += (1 - math.exp(-dw / 0.25)) * math.exp(-dw / 1.6)
    return min(1.2, v)


cam_ = env(cheer_env)
cheer = svf([a * b for a, b in zip(aah, cam_)], fc_city, 0.7)
mix.put_stereo(0, cheer, [0.95 * v for v in cheer], gain=0.06)

# 2. the fireworks: mortar thump at launch, boom and crackle, both late by distance / 343 m/s
for i, (wb, kind, col, x, y, z) in enumerate(TL["fireworks"]):
    d_launch = math.dist(EYE, (x, 0, z))
    d_burst = math.dist(EYE, (x, y, z))
    tl_ = t_of_world(wb - RISE + d_launch / C_SOUND)
    tb = t_of_world(wb + d_burst / C_SOUND)
    pan = max(-0.6, min(0.6, (x + 8) / 150))
    if 0 <= tl_ < DUR:
        th = thump(95 * max(speed(tl_), 0.1) ** 0.5, 50, 0.35 / max(speed(tl_), 0.1) ** 0.5)
        put(tl_, th, 0.16, pan)
    if 0 <= tb < DUR:
        sp = speed(tb)
        b = boom(sp, 300 + i, big=kind == "big")
        g = 0.62 if kind == "big" else 0.48
        put(tb, b, g, pan)
        if kind in ("willow", "chrys"):
            put(tb + 0.25 / max(sp, 0.1) ** 0.65, crackle(sp, 2.2, 400 + i), 0.09, pan)

# 3. the road flare: a steady sputtering hiss, slightly right
hiss = svf(svf(white(70), 3200, 0.9, "bp"), fc_city, 0.7)
flick = env(lambda t: 0.75 + 0.25 * math.sin(world(t) * 37) * math.sin(world(t) * 13.7 + 1))
mix.put_stereo(0, [0.75 * a * b for a, b in zip(hiss, flick)], [a * b for a, b in zip(hiss, flick)], gain=0.035)

# 4. the slam into slow motion, and strontium leaving everything at once
put(T0 - 1.15, riser(1.15, 300, 4600), 0.15)
put(T0, impact(1.8), 0.9)
put(T0, thump(190, 34, 2.4, tau=0.9), 0.5)
put(T0 + 0.02, glitter(1.6, 60, 2600, 7400, 3), 0.1)  # the tile shatters
put(T0 + 0.05, glitter(3.2, 120, 3800, 9800, 4), 0.07, -0.2)  # crimson atoms streaming off the stars
put(T0 + 0.05, glitter(3.2, 120, 3800, 9800, 5), 0.07, 0.2)

# 5. heartbeat, a little faster as time speeds up
t = T0 + 0.55
while t < T1 - 0.3:
    put(t, thump(62, 42, 0.2), 0.55)
    put(t + 0.24, thump(54, 38, 0.18), 0.36)
    t += 1.12 - 0.42 * clamp01((t - T0) / TLEN)

# 6. drone under the slow motion (A minor), A major once strontium is back
vol = envelope([(0, 0), (T0, 0), (T0 + 1.0, 1), (T1 - 0.6, 1.3), (T1, 1.3), (T1 + 0.3, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [55.0, 110.0, 164.81, 220.0, 261.63, 329.63])], volume=vol, detune=0.4, tremolo=0.11), gain=0.034)
vol2 = envelope([(0, 0), (T1, 0), (T1 + 0.5, 1), (DUR - 0.6, 1), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [110.0, 164.81, 220.0, 277.18, 329.63, 440.0])], volume=vol2, detune=0.6), gain=0.022)

# 7. a tick on every world second
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.06), 0.22, 0.15)
    put(tw, thump(95, 60, 0.14), 0.28)

# 8. the consequences
# flare: a closer, brighter hiss while we look at it
cf = TL["captions"][1]
put(cf["hit"], whoosh(1.6, 2400, 900, peak=0.5, q=1.2), 0.05, 0.3)
# purple comes out blue: a cold, high bell
cp = TL["captions"][2]
put(cp["hit"] + 0.1, chime([1318.51, 1975.53, 2637.02], dur=2.2, tau=0.8), 0.07, -0.1)
# the x-ray: a scan sweep and pings
H = TL["holo"]
put(H["in"], whoosh(0.6, 300, 1400, peak=0.6), 0.07)
ns = int((H["scanEnd"] - H["scan"]) * SR)
scan = svf(white(90, ns), lambda s: 2600 * (0.15 ** (s / ns)) + 200, 2.5, "bp")
put(H["scan"], [v * math.sin(math.pi * k / ns) for k, v in enumerate(scan)], 0.14)
for k, dt in enumerate((0.0, 0.6, 1.2)):
    put(H["scan"] + dt, blip(1318.51 if k < 2 else 1760.0, dur=1.0, tau=0.35), 0.06, 0.15)
# the lab clock: fast ticks that stop, a flat tone; then your phone's quiet tick carries on
cc = TL["captions"][4]
for k in range(8):
    put(cc["at"] - 0.1 + k * 0.07, click(2400, 0.02), 0.07, -0.3)
flat = [math.sin(2 * math.pi * 1000 * k / SR) * min(1, k / 400) * min(1, (int(1.1 * SR) - k) / 2000) for k in range(int(1.1 * SR))]
put(cc["at"] + 0.5, flat, 0.025, -0.3)
for k in range(4):
    put(cc["at"] + 0.4 + k * 0.5, click(3600, 0.015), 0.05, 0.25)
# the oceans: a deep swell
co = TL["captions"][5]
put(co["hit"], svf(svf(white(95, int(2.4 * SR)), 220, 0.8), 70, 0.7, "hp"), 0.22)
put(co["hit"], whoosh(2.0, 160, 700, peak=0.6, q=0.7), 0.06)

# 9. strontium comes back
put(T1 - 0.95, riser(0.95, 400, 6400), 0.18)
put(T1 - 0.5, glitter(0.5, 60, 3800, 9800, 6, rev=True), 0.09)
put(T1, impact(1.3), 0.55)
put(T1, chime([440.0, 554.37, 659.25, 880.0], dur=2.6, tau=1.0), 0.12)
put(T1, whoosh(0.8, 3000, 600, peak=0.2), 0.1)

# 10. captions, the end card, camera turns
for c in TL["captions"]:
    put(c["at"], pop(760, 320), 0.1)
put(TL["end"], pop(980, 400), 0.18)
put(TL["end"] + 0.05, chime([880.0, 1108.73, 1318.51], dur=1.8, tau=0.6), 0.08)
for (ta, na, _), (tb, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb - ta < 1.5:
        put(ta, whoosh(tb - ta + 0.2, 280, 1300, peak=0.5, q=0.7), 0.045, 0.2 if nb in ("flare", "friendBody", "phone") else -0.2)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "strontium", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
