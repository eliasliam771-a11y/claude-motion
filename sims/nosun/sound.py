#!/usr/bin/env python3
"""Soundtrack for the no-sun what-if, built on the same timeline.json.

The street runs on world time like the picture: in the fast-forward its
chatter blurs into a hiss under a rising tape whine and a tick for every
world minute; the whine falls as the clock drops to 0.1x and the street
muffles. Then the dark lands: a deep hit, a murmur from the crowd, a
heartbeat and a minor drone, a soft drop when the Moon goes out, twinkles as
the stars come up, clicks for phone torches and the headlight relays, a tick
for every second of darkness, and a bright major hit when the Sun is back.

    python3 sims/nosun/sound.py [-o out/sims/nosun/sound.wav]

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
CK = TL["clock"]
DK = TL["dark"]
TV = CK["vanish"]
TA = TV + CK["hold"]
TB = TA + CK["ff"]
TC = TB + CK["decel"]
TD = TC + CK["pre"]
TDL = CK["dark"] / (CK["s0"] + (CK["s1"] - CK["s0"]) / (CK["pow"] + 1))
TS = TD + TDL
SP = 1 + 2 * ((CK["light"] - CK["hold"] - CK["decel"] * (1 + CK["s0"]) / 2 - CK["pre"] * CK["s0"]) / CK["ff"] - 1)


def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def smooth(x):
    x = clamp01(x)
    return x * x * (3 - 2 * x)


def speed(t):
    """Same curve as main.js speedAt."""
    if t < TA:
        return 1.0
    if t < TB:
        return 1 + (SP - 1) * math.sin(math.pi * (t - TA) / CK["ff"]) ** 2
    if t < TC:
        return 1 + (CK["s0"] - 1) * smooth((t - TB) / CK["decel"])
    if t < TD:
        return CK["s0"]
    if t < TS:
        return CK["s0"] + (CK["s1"] - CK["s0"]) * ((t - TD) / TDL) ** CK["pow"]
    if t < TS + CK["out"]:
        return CK["s1"] + (1 - CK["s1"]) * smooth((t - TS) / CK["out"])
    return 1.0


DT = 1 / 1000
WT = [0.0] * (int(DUR / DT) + 2)
i0 = round(TV / DT)
for i in range(i0 + 1, len(WT)):
    WT[i] = WT[i - 1] + 0.5 * (speed((i - 1) * DT) + speed(i * DT)) * DT
for i in range(i0 - 1, -1, -1):
    WT[i] = WT[i + 1] - 0.5 * (speed(i * DT) + speed((i + 1) * DT)) * DT


def world(t):
    f = min(max(t / DT, 0), len(WT) - 1.001)
    i = int(f)
    return WT[i] + (WT[i + 1] - WT[i]) * (f - i)


WD0 = world(TD)


def t_of_world(w):
    lo, hi = 0, len(WT) - 1
    while hi - lo > 1:
        m = (lo + hi) // 2
        if WT[m] < w:
            lo = m
        else:
            hi = m
    return lo * DT


def t_of_dark(d):
    return t_of_world(WD0 + d)


def night(t):
    return smooth((t - TD) / 0.2) * (1 - smooth((t - TS) / 0.12))


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
    rr = random.Random(seed)
    out = [0.0] * int(dur * SR)
    for _ in range(n_hits):
        at = int((rr.random() ** 1.4) * (len(out) - 0.05 * SR))
        b = blip(rr.uniform(f_lo, f_hi), dur=0.05, tau=0.012)
        g = rr.uniform(0.3, 1.0)
        for k, v in enumerate(b):
            if at + k < len(out):
                out[at + k] += v * g
    return out


mix = Mix(DUR, seed=15)
put = mix.put
# the street brightens when time rushes and muffles when it crawls
fc_city = lambda s: min(14000, 220 + 8000 * speed(s / SR) ** 1.4)  # noqa: E731
level = env(lambda t: (0.55 + 0.45 * min(speed(t), 1.6)) * (1 - 0.35 * night(t)))

# 1. street: wash, rumble, chatter in world time
for k, side in ((0, "l"), (1, "r")):
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
    bed = [(0.5 * a + 0.9 * b + 0.45 * c) * g for a, b, c, g in zip(norm(wash), norm(rumble), norm(voices), level)]
    if side == "l":
        mix.put_stereo(0, bed, [0.0] * N, gain=0.2)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.2)

# birds by day at normal speed
rr = random.Random(7)
t = 0.2
while t < DUR:
    if t < TA - 0.2 or t > TS + 0.6:
        f = rr.uniform(2800, 4200)
        for c in range(rr.randint(2, 4)):
            put(t + c * 0.09, blip(f * (1 + 0.08 * c), dur=0.08, tau=0.02), 0.035, rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.5, 1.1)

# 2. the Sun vanishes: a small, wrong-feeling hit, the emblem breaks
put(TV, thump(220, 90, 0.5), 0.35)
put(TV, chime([1318.51, 1396.91], dur=1.6, tau=0.5), 0.08)
put(TV + 0.02, glitter(1.0, 40, 2400, 7000, 3), 0.09)

# 3. fast-forward: tape whine that follows the speed, a tick per world minute
n = int((TC - TA + 0.3) * SR)
whine = []
ph = 0.0
for k in range(n):
    t = TA + k / SR
    sp = speed(t)
    f = 120 * (1 + math.log10(max(sp, 0.1)) * 1.4)
    ph += 2 * math.pi * f / SR
    a = clamp01(math.log10(max(sp, 1.0)) / 2.3)
    whine.append((math.sin(ph) + 0.4 * math.sin(2 * ph) + 0.2 * math.sin(3 * ph)) * a)
put(TA, svf(whine, 2400, 0.7), 0.16)
put(TA - 0.1, whoosh(0.9, 300, 3200, peak=0.8), 0.12)
for m in range(1, 9):
    put(t_of_world(60 * m), click(1500, 0.05), 0.2, 0.2)
put(TB - 0.2, whoosh(0.8, 3200, 260, peak=0.3), 0.14)

# 4. the wait at 0.1x, then lights out
put(TD - 1.15, riser(1.15, 220, 2600), 0.14)
put(TD, impact(2.0), 0.95)
put(TD, thump(120, 30, 2.6, tau=1.0), 0.5)
# the street gasps
gasp = svf(white(60), 900, 0.9, "bp")
gam = env(lambda t: math.sin(math.pi * clamp01((world(t) - WD0 - 0.25) / 2.4)) ** 2 if t > TD else 0.0)
mix.put_stereo(0, *(lambda g: (g, g))(mul(gasp, gam)), gain=0.07)
# heartbeat through the dark
t = TD + 0.5
while t < TS - 0.3:
    put(t, thump(62, 42, 0.2), 0.6)
    put(t + 0.24, thump(54, 38, 0.18), 0.38)
    t += 1.15 - 0.45 * clamp01((t - TD) / TDL)
# drone in the dark, D minor; D major once the Sun is back
vol = envelope([(0, 0), (TD, 0), (TD + 0.8, 1), (TS - 0.5, 1.3), (TS, 1.3), (TS + 0.3, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [73.42, 110.0, 146.83, 174.61, 220.0, 329.63])], volume=vol, detune=0.4, tremolo=0.11), gain=0.036)
vol2 = envelope([(0, 0), (TS, 0), (TS + 0.5, 1), (DUR - 0.6, 1), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [146.83, 220.0, 293.66, 369.99, 440.0])], volume=vol2, detune=0.6), gain=0.022)
# a tick for every second of darkness
for d in range(1, CK["dark"]):
    td = t_of_dark(d)
    put(td, click(1100, 0.06), 0.2, 0.15)
    put(td, thump(95, 60, 0.14), 0.24)

# 5. the beats inside the dark
tm = t_of_dark(DK["moon"])
put(tm, thump(140, 50, 0.7), 0.3, 0.2)
put(tm, chime([880.0, 1174.66], dur=1.4, tau=0.4), 0.06, 0.2)
# stars: sparse twinkles while the eyes adapt
rr = random.Random(21)
t = t_of_dark(1.6)
while t < TS - 0.5:
    put(t, blip(rr.choice([2349.32, 2637.02, 2959.96, 3520.0, 3951.07]), dur=0.4, tau=0.12), rr.uniform(0.015, 0.04), rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.18, 0.5)
# phone torches and headlight relays
for d in (3.0, 3.4, 3.5, 3.8, 4.1, 4.4, 4.5, 5.2, 5.6, 6.0):
    put(t_of_dark(d), click(2600, 0.03), 0.12, random.Random(int(d * 10)).uniform(-0.6, 0.6))
th = t_of_dark(DK["headlights"])
for k in range(4):
    put(th + k * 0.04, click(900, 0.05), 0.16, 0.4 - 0.25 * k)
# Earth leaves its curve
put(TL["inset"]["orbitIn"], whoosh(1.2, 200, 1400, peak=0.6), 0.1)

# 6. the Sun comes back
put(TS - 0.95, riser(0.95, 400, 7000), 0.22)
put(TS, impact(1.4), 0.65)
put(TS, chime([587.33, 880.0, 1174.66, 1479.98], dur=2.8, tau=1.1), 0.15)
put(TS, whoosh(1.0, 4000, 500, peak=0.15), 0.14)

# 7. captions and end card
for c in TL["captions"]:
    put(c["at"], pop(760, 320), 0.11)
put(TL["end"], pop(980, 400), 0.2)
put(TL["end"] + 0.05, chime([1174.66, 1479.98, 1760.0], dur=1.8, tau=0.6), 0.09)
for (ta, na, _), (tb, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb - ta < 1.6:
        put(ta, whoosh(tb - ta + 0.2, 280, 1300, peak=0.5, q=0.7), 0.05)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "nosun", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
