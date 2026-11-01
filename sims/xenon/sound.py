#!/usr/bin/env python3
"""Soundtrack for the xenon what-if, built on the same timeline.json.

An open-air cinema night on world time, like the picture: the crowd, the
film's own soundtrack from the speakers (sea and a slow score), and the fan
of the projector behind you. When xenon goes the picture dies but the sound
keeps playing, because speakers don't need xenon; the projector fan keeps
turning too. The photographer's flash pops and whines as it recharges before,
and only the shutter clicks during; the phone's shutter works. When the clock
slows to 0.1x everything muffles. On top: the slam into slow motion, a sparkle
as the xenon leaves, heartbeat, drone, a tick on every world second, the lamp
striking again, and then the tsunami: roar, crash, under water.

    python3 sims/xenon/sound.py [-o out/sims/xenon/sound.wav]
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
TS = TL["tsunami"]
FLASHES = [-2.05, -1.5, -0.95, -0.4, 0.4]
PHONE_FLASH = 0.62


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


def mul(a, b):
    return [x * y for x, y in zip(a, b)]


def wave_front(t):
    k = clamp01((t - TS["at"]) / (TS["hit"] - TS["at"])) ** 1.35
    return TS["z0"] + (TS["z1"] - TS["z0"]) * k


T_DROWN = next(i / 100 for i in range(int(DUR * 100)) if i / 100 > TS["at"] and wave_front(i / 100) > -46.0)


def under_v(t):
    return smooth((t - TS["hit"] + 0.1) / 0.25)


mix = Mix(DUR, seed=54)
put = mix.put
fc_city = lambda s: (220 + 8000 * speed(s / SR) ** 1.8) * (1 - 0.93 * under_v(s / SR))  # noqa: E731
under = env(under_v)

# 1. the street: crowd murmur and wash, muffled by the slow motion (and later the sea)
for k, pan in ((0, -1), (1, 1)):
    wash = svf(svf(white(10 + k), 1100, 0.45, "bp"), fc_city, 0.7)
    rumble = svf(brown(20 + k), 160, 0.7)
    voices = [0.0] * N
    for v in range(7):
        rr = random.Random(40 + v + 10 * k)
        f, ph = rr.uniform(2.6, 4.6), rr.uniform(0, 6.3)
        band = svf(white(50 + v + 10 * k), rr.uniform(450, 1300), 1.2, "bp")
        am = env(lambda t, f=f, ph=ph: max(0.0, math.sin(2 * math.pi * f * world(t) + ph)) ** 2 * (0.5 + 0.5 * math.sin(world(t) * 0.7 + ph)))
        voices = [a + b * c for a, b, c in zip(voices, band, am)]
    voices = svf(voices, fc_city, 0.7)
    # the crowd murmurs louder in the dark, and goes quiet when the film comes back
    level = env(lambda t: (0.45 + 0.55 * speed(t)) * (1 + 0.5 * smooth(world(t) / 0.6) * (1 - smooth((world(t) - SL["world"] - 0.6) / 0.5))) * (1 - under_v(t)))
    bed = [(0.4 * a + 0.45 * b + 0.7 * c) * g for a, b, c, g in zip(norm(wash), norm(rumble), norm(voices), level)]
    if pan < 0:
        mix.put_stereo(0, bed, [0.0] * N, gain=0.15)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.15)

# 2. the film's own sound from the speakers: the sea and a slow score. It never stops for xenon.
sea_am = env(lambda t: 0.55 + 0.45 * math.sin(world(t) * 2 * math.pi / 6.5) ** 2)
film_end = env(lambda t: 1 - smooth((t - T_DROWN) / 0.25))
for k in (0, 1):
    sea = svf(svf(white(60 + k), 900, 0.6), fc_city, 0.7)
    sea = [a * b * c for a, b, c in zip(norm(sea), sea_am, film_end)]
    mix.put_stereo(0, sea if k == 0 else [0.0] * N, [0.0] * N if k == 0 else sea, gain=0.05)
score_v = envelope([(0, 1), (T_DROWN, 1), (T_DROWN + 0.25, 0), (DUR, 0)])
sl, sr_ = pad(DUR, [(0, [146.83, 220.0, 293.66, 369.99]), (8.0, [123.47, 185.0, 246.94, 293.66]), (16.0, [130.81, 196.0, 261.63, 329.63]), (24.0, [146.83, 220.0, 293.66, 369.99])], volume=score_v, detune=0.5, tremolo=0.08)
mix.put_stereo(0, svf(sl, fc_city, 0.7), svf(sr_, fc_city, 0.7), gain=0.03)

# 3. the projector behind you: its fan keeps turning, lamp or no lamp
fan = svf(svf(white(70), 420, 0.9, "bp"), fc_city, 0.7)
mix.put_stereo(0, [0.35 * v for v in fan], [0.6 * v for v in fan], gain=0.03)

# 4. the photographer: pop + recharge whine while there is xenon; only the shutter without it
for k, f in enumerate(FLASHES):
    tf = t_of_world(f)
    if tf < 0:
        continue
    sp = max(speed(tf), 0.1)
    put(tf, click(1700 * sp ** 0.4, 0.03), 0.22, -0.35)  # shutter
    put(tf + 0.06 / sp ** 0.6, click(1300 * sp ** 0.4, 0.025), 0.16, -0.35)
    if not 0 <= f < SL["world"]:
        put(tf + 0.004, click(5200, 0.012), 0.3, -0.35)  # the tube's pop
        n = int(0.9 * SR)
        whine = []
        ph = 0.0
        for j in range(n):
            x = j / n
            ph += 2 * math.pi * (3200 + 4200 * x) / SR
            whine.append(math.sin(ph) * x * (1 - x) * 4)
        put(tf + 0.05, whine, 0.012, -0.35)
tp = t_of_world(PHONE_FLASH + 0.33)
put(tp, click(2600, 0.02), 0.14, -0.2)
put(tp + 0.05, click(2000, 0.02), 0.1, -0.2)

# 5. the slam into slow motion; the lamp goes out; xenon leaving everything at once
put(T0 - 1.15, riser(1.15, 300, 4600), 0.15)
put(T0, impact(1.8), 0.85)
put(T0, thump(190, 34, 2.4, tau=0.9), 0.48)
put(T0 + 0.01, thump(140, 60, 0.3), 0.3, 0.3)  # the arc dies
put(T0 + 0.02, glitter(1.6, 60, 2600, 7400, 3), 0.1)  # the tile shatters
put(T0 + 0.05, glitter(2.6, 110, 3600, 9400, 4), 0.07, -0.25)
put(T0 + 0.05, glitter(2.6, 110, 3600, 9400, 5), 0.07, 0.25)

# 6. heartbeat, a little faster as time speeds up
t = T0 + 0.55
while t < T1 - 0.3:
    put(t, thump(62, 42, 0.2), 0.5)
    put(t + 0.24, thump(54, 38, 0.18), 0.33)
    t += 1.12 - 0.42 * clamp01((t - T0) / TLEN)

# 7. drone under the slow motion (B minor), D major once xenon is back
vol = envelope([(0, 0), (T0, 0), (T0 + 1.0, 1), (T1 - 0.6, 1.3), (T1, 1.3), (T1 + 0.3, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [61.74, 123.47, 185.0, 246.94, 293.66, 369.99])], volume=vol, detune=0.4, tremolo=0.11), gain=0.032)

# 8. a tick on every world second
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.06), 0.2, 0.15)
    put(tw, thump(95, 60, 0.14), 0.26)

# 9. the consequences
caps = TL["captions"]
# ion engines: a thin electric hum that is not there
put(caps[3]["hit"], whoosh(1.4, 900, 2600, peak=0.5, q=1.4), 0.04, 0.2)
put(caps[3]["hit"] + 0.2, blip(1975.53, dur=1.2, tau=0.4), 0.05)
# the detector, deep underground: a low cavern tone and drips
put(caps[4]["hit"], svf(svf(white(95, int(2.2 * SR)), 140, 0.9), 50, 0.7, "hp"), 0.18)
for k, dt in enumerate((0.3, 0.95, 1.5)):
    put(caps[4]["hit"] + dt, blip(880.0 * (1 + 0.12 * k), dur=0.4, tau=0.08), 0.05, -0.3 + 0.3 * k)
# noble gas: a calm bell
put(caps[5]["hit"] + 0.1, chime([739.99, 1108.73, 1479.98], dur=2.0, tau=0.8), 0.07)

# 10. xenon comes back; the lamp is struck again and the crowd cheers
put(T1 - 0.95, riser(0.95, 400, 6400), 0.17)
put(T1 - 0.5, glitter(0.5, 60, 3600, 9400, 6, rev=True), 0.08)
put(T1, impact(1.3), 0.5)
put(T1, chime([587.33, 739.99, 880.0, 1174.66], dur=2.6, tau=1.0), 0.11)
tst = t_of_world(SL["world"] + 0.35)
for k in range(5):
    put(tst + k * 0.05, click(3000 + 400 * k, 0.015), 0.12, 0.4)  # igniter
put(tst + 0.25, thump(120, 80, 0.4), 0.2, 0.4)
aah = [a + 0.7 * b for a, b in zip(svf(white(80), 720, 3.0, "bp"), svf(white(81), 1150, 3.5, "bp"))]
cheer = env(lambda t: (lambda d: (1 - math.exp(-d / 0.3)) * math.exp(-d / 1.5) if d > 0 else 0.0)(world(t) - SL["world"] - 0.6) * (1 - under_v(t)))
mix.put_stereo(0, *(lambda c: (c, [0.9 * v for v in c]))(svf(mul(aah, cheer), fc_city, 0.7)), gain=0.07)

# 11. the tsunami: rumble and roar grow, the crash, then underwater
ramp = env(lambda t: smooth((t - TS["at"]) / (TS["hit"] - TS["at"])) ** 1.6 * (1 - under_v(t)))
for k in (0, 1):
    roar = svf(white(200 + k), lambda s: 300 + 2600 * smooth((s / SR - TS["at"]) / (TS["hit"] - TS["at"])), 0.6)
    rum = svf(brown(210 + k, 0.998), 120, 0.7)
    layer = [(0.7 * a + 0.9 * b) * g for a, b, g in zip(norm(roar), norm(rum), ramp)]
    mix.put_stereo(0, layer if k == 0 else [0.0] * N, [0.0] * N if k == 0 else layer, gain=0.3)
put(T_DROWN, thump(110, 40, 0.6), 0.25, 0.05)  # the screen goes under
put(TS["hit"] - 0.05, impact(1.6), 0.8)
put(TS["hit"] - 0.05, whoosh(1.2, 4000, 300, peak=0.1, q=0.6), 0.22)
bub = svf(brown(230, 0.995), 400, 0.7)
mix.put_stereo(0, *(lambda b: (b, b))(mul(norm(bub), under)), gain=0.11)
rr = random.Random(41)
t = TS["hit"] + 0.1
while t < DUR - 0.3:
    put(t, blip(rr.uniform(300, 900), dur=0.12, tau=0.04), rr.uniform(0.03, 0.07), rr.uniform(-0.7, 0.7))
    t += rr.uniform(0.06, 0.2)

# 12. captions, the end card, camera turns
for c in caps:
    put(c["at"], pop(760, 320), 0.1)
put(TL["end"], pop(980, 400), 0.16)
put(TL["end"] + 0.05, chime([587.33, 739.99, 880.0], dur=1.8, tau=0.6), 0.07)
for (ta, na, _), (tb, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb - ta < 1.5 and not na.startswith("wave"):
        put(ta, whoosh(tb - ta + 0.2, 280, 1300, peak=0.5, q=0.7), 0.045, 0.2 if nb in ("photog", "friend", "down") else -0.2)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "xenon", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
