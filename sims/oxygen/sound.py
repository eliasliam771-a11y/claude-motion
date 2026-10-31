#!/usr/bin/env python3
"""Soundtrack for the oxygen what-if, built on the same timeline.json.

The street runs on world time like the picture and muffles while the air
pressure is down. Everything that burns is audible until W = 0: the patio
heater's gas roar and the petrol engines cut dead, the electric car's whine
carries on. The slam has an ear pop; then a heartbeat, a dark drone, a tick on
every world second, a thin shimmer for the UV, the mains hum flickering out
with a relay clunk when the grid trips, and a second ear pop when the oxygen
comes back, with the hum still dead.

    python3 sims/oxygen/sound.py [-o out/sims/oxygen/sound.wav]

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
    """1 while the air has no oxygen (main.js goneAt)."""
    return smooth(w / 0.02) * (1 - smooth((w - SL["world"]) / 0.02))


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


mix = Mix(DUR, seed=8)
put = mix.put
# the street muffles while the pressure is down and your ears are blocked
fc_city = lambda s: 200 + 8000 * speed(s / SR) ** 1.8 * (1 - 0.45 * gone(world(s / SR))) ** 2  # noqa: E731

# 1. the street: wash, rumble, chatter in world time
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
    level = env(lambda t: (0.55 + 0.45 * speed(t)) * (1 - 0.3 * gone(world(t))))
    bed = [(0.5 * a + 0.9 * b + 0.45 * c) * g for a, b, c, g in zip(norm(wash), norm(rumble), norm(voices), level)]
    if side == "l":
        mix.put_stereo(0, bed, [0.0] * N, gain=0.26)
    else:
        mix.put_stereo(0, [0.0] * N, bed, gain=0.26)

# birds at normal speed
rr = random.Random(7)
t = 0.2
while t < DUR:
    if t < T0 - 0.3 or t > T1 + 0.5:
        f = rr.uniform(2800, 4200)
        for c in range(rr.randint(2, 4)):
            put(t + c * 0.09, blip(f * (1 + 0.08 * c), dur=0.08, tau=0.02), 0.035, rr.uniform(-0.8, 0.8))
    t += rr.uniform(0.5, 1.1)

# 2. things that burn: the heater's gas roar and the petrol engines, cut dead at W = 0
burning = env(lambda t: 1.0 - smooth(world(t) / 0.03))
roar = svf(svf(white(60), 2400, 0.6), 300, 0.7, "hp")
mix.put_stereo(0, *(lambda r: (r, r))(mul(norm(roar), burning)), gain=0.05)
engine = [0.0] * N
ph = 0.0
for i in range(N):
    t = i / SR
    f = 34 * (0.5 + 0.5 * min(speed(t), 1.0))  # the engine note slows with the world
    ph += 2 * math.pi * f / SR
    engine[i] = math.sin(ph) + 0.5 * math.sin(2 * ph) + 0.3 * math.sin(3.02 * ph)
engine = svf([e + 0.4 * n for e, n in zip(engine, brown(61))], 260, 0.7)
mix.put_stereo(0, *(lambda e: (e, e))(mul(norm(engine), burning)), gain=0.1)
# the electric car hums on through the whole thing
ev = [0.0] * N
ph = 0.0
for i in range(N):
    ph += 2 * math.pi * (620 * (0.35 + 0.65 * min(speed(i / SR), 1.0))) / SR
    ev[i] = math.sin(ph) + 0.3 * math.sin(2.5 * ph)
tev = t_of_world(1.2)
evenv = env(lambda t: math.exp(-(((t - tev) / 2.4) ** 2)))
mix.put_stereo(0, *(lambda e: (e, e))(mul(norm(ev), evenv)), gain=0.035)
# the mains hum of the screen and signals, until the grid dies
hum = [math.sin(2 * math.pi * 50 * i / SR) + 0.5 * math.sin(2 * math.pi * 150 * i / SR) + 0.25 * math.sin(2 * math.pi * 250 * i / SR) for i in range(N)]
tbo = t_of_world(TL["blackout"])


def powered(t):
    w = world(t)
    if w < TL["blackout"]:
        return 1.0
    k = (w - TL["blackout"]) / 0.16
    if k >= 1:
        return 0.0
    return 1 - k if math.sin(k * 23) > 0.1 else 0.1


mix.put_stereo(0, *(lambda h: (h, h))(mul(hum, env(powered))), gain=0.012)
for k in range(3):
    put(tbo + k * 0.18, click(700, 0.05), 0.2, 0.1)
put(t_of_world(TL["blackout"] + 0.16), thump(120, 40, 0.6), 0.35)
put(t_of_world(TL["blackout"] + 0.16), whoosh(0.9, 1800, 200, peak=0.15), 0.08)

# 3. the slam: the oxygen goes, the pressure drops, ears pop
put(T0 - 1.15, riser(1.15, 300, 4600), 0.16)
put(T0, impact(1.8), 0.75)
put(T0, thump(190, 34, 2.4, tau=0.9), 0.4)
put(T0 + 0.09, thump(70, 50, 0.18), 0.3)  # ear pop
put(T0 + 0.03, click(1800, 0.03), 0.18)
put(T0 + 0.02, glitter(1.6, 50, 2600, 7400, 3), 0.1)  # the tile shatters
put(T0 + 0.05, whoosh(0.9, 1600, 180, peak=0.1), 0.14)  # flames snuffed

# 4. heartbeat, drone, a tick on every world second
t = T0 + 0.55
while t < T1 - 0.3:
    put(t, thump(62, 42, 0.2), 0.6)
    put(t + 0.24, thump(54, 38, 0.18), 0.38)
    t += 1.12 - 0.42 * clamp01((t - T0) / TLEN)
vol = envelope([(0, 0), (T0, 0), (T0 + 1.0, 1), (T1 - 0.6, 1.35), (T1, 1.35), (T1 + 0.3, 0), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [73.42, 110.0, 146.83, 174.61, 220.0, 329.63])], volume=vol, detune=0.4, tremolo=0.11), gain=0.036)
vol2 = envelope([(0, 0), (T1, 0), (T1 + 0.5, 1), (DUR - 0.6, 1), (DUR, 0)])
mix.put_stereo(0, *pad(DUR, [(0, [146.83, 220.0, 293.66, 349.23, 440.0])], volume=vol2, detune=0.6), gain=0.022)
for w in range(1, SL["world"]):
    tw = t_of_world(w)
    put(tw, click(1100, 0.06), 0.24, 0.15)
    put(tw, thump(95, 60, 0.14), 0.3)

# 5. the sky beat: a thin, high shimmer for the UV
tsky = TL["captions"][3]["at"]
nuv = int(2.6 * SR)
uv = svf(white(90)[:nuv], 7000, 3.0, "bp")
put(tsky - 0.2, [v * math.sin(math.pi * k / nuv) ** 2 for k, v in enumerate(uv)], 0.05, 0.3)

# 6. oxygen is back: ears pop again, but the hum stays dead
put(T1 - 0.95, riser(0.95, 400, 6400), 0.2)
put(T1, impact(1.3), 0.55)
put(T1 + 0.09, thump(70, 50, 0.18), 0.3)
put(T1, whoosh(0.8, 3000, 600, peak=0.2), 0.12)
put(T1 + 0.1, chime([587.33, 698.46, 880.0], dur=2.4, tau=1.0), 0.1)

# 7. captions, end card, camera turns
for c in TL["captions"]:
    put(c["at"], pop(760, 320), 0.11)
put(TL["end"], pop(980, 400), 0.2)
put(TL["end"] + 0.05, chime([1174.66, 1479.98, 1760.0], dur=1.8, tau=0.6), 0.09)
for (ta, na, _), (tb, nb, _) in zip(TL["cam"], TL["cam"][1:]):
    if na != nb and tb - ta < 1.5:
        put(ta, whoosh(tb - ta + 0.2, 280, 1300, peak=0.5, q=0.7), 0.05)

ap = argparse.ArgumentParser()
ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "..", "out", "sims", "oxygen", "sound.wav"))
out = os.path.abspath(ap.parse_args().out)
info = mix.master(target_lufs=-14.0)
mix.write(out)
print(f"→ {os.path.relpath(out)}  ({DUR} s, {info['lufs']:.1f} LUFS, peak {info['peak_db']:.1f} dBFS, drive {info['drive']})")
