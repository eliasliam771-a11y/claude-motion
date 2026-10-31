#!/usr/bin/env python3
"""Sound for "concrete", on the same timeline.json.

Street life for the hook (traffic, crowd murmur, footsteps), a deep thump as
everything drops a slab's thickness, then the slowed five seconds: glass
sheets grinding down and shattering at every base, steel groaning as the
cages lean, lamp posts clanging down. At second 5 one dull, heavy set as the
concrete returns, then a stunned quiet and the street coming back.

    python3 sims/concrete/sound.py [-o out/sims/concrete/sound.wav]

Mux with capture.mjs: --music <wav> --music-start 0 --no-sync --lufs -16
"""

import argparse
import json
import os
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))
from sfx.dsp import SR, biquad, bp, hp, lp  # noqa: E402

TL = json.load(open(os.path.join(HERE, "timeline.json")))
DUR, OFF, BACK, SLOW, EV = TL["duration"], TL["off"], TL["back"], TL["slow"], TL["event"]
N = int(DUR * SR)
t = np.arange(N) / SR
rng = np.random.default_rng(11)


def filt(x, c):
    return np.array(biquad(list(x), c))


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def at(sec):
    return int(sec * SR)


def screen(te):
    """Event time -> screen time."""
    return OFF + te / SLOW if te < EV else BACK + (te - EV)


L = np.zeros(N)
R = np.zeros(N)


def add(x, start=0.0, gain=1.0, pan=0.0):
    i = at(start)
    n = min(len(x), N - i)
    if n <= 0 or i < 0:
        return
    L[i:i + n] += x[:n] * gain * (1 - max(0, pan))
    R[i:i + n] += x[:n] * gain * (1 + min(0, pan))


# street bed: full before, muffled and thin in slow motion, back after
live = np.where(t < OFF, 1.0, np.where(t < BACK, 0.18, smooth((t - BACK - 1.2) / 3.0) * 0.8))
for ch, seed in ((L, 1), (R, 2)):
    w = np.random.default_rng(seed).standard_normal(N)
    traffic = filt(filt(w, lp(220)), lp(300)) * 1.8
    murmur = filt(filt(w, bp(420, 0.9)), bp(700, 0.8)) * 0.5 * (0.7 + 0.3 * np.sin(t * 1.9 + seed) * np.sin(t * 0.7))
    ch += (traffic + murmur) * live * 0.4

# hero footsteps until the ground goes
for k in range(12):
    s0 = 0.2 + k * 0.4
    if s0 > OFF - 0.05:
        break
    n = at(0.08)
    tt = np.arange(n) / SR
    add(filt(rng.standard_normal(n), bp(900, 1.2)) * np.exp(-tt * 70), s0, 0.25, 0.1 * (-1) ** k)

# the drop: a deep thump, gravel crunch (slowed: lower and longer)
n = at(2.0)
tt = np.arange(n) / SR
thump = np.sin(2 * np.pi * (28 * tt + 30 * (1 - np.exp(-tt * 4)) / 4)) * np.exp(-tt * 2.2)
crunch = filt(rng.standard_normal(n), bp(500, 0.6)) * np.exp(-tt * 3) * smooth(tt / 0.05)
add(thump * 1.1 + crunch * 0.5, OFF, 1.0)

# glass sheets grinding down and shattering: dense, low-pitched in slow motion
for k in range(900):
    te = 0.05 + (rng.random() ** 0.8) * (EV - 0.05)
    s0 = screen(te)
    f = rng.uniform(1100, 3200) * (1.0 + 0.4 * te / EV)
    n = at(0.25)
    tt = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * tt + rng.random() * 6) * np.exp(-tt * rng.uniform(12, 30))
    add(x, s0, 0.02 * (0.4 + te / EV), rng.uniform(-0.9, 0.9))
n = at(BACK - OFF)
tt = np.arange(n) / SR
roar = filt(filt(rng.standard_normal(n), bp(1800, 0.5)), hp(600)) * smooth(tt / 3) * (0.5 + 0.5 * tt / (BACK - OFF))
add(roar, OFF + 0.4, 0.12)

# steel groans as the cages lean
for k, te in enumerate((1.6, 2.6, 3.3, 3.9, 4.5)):
    n = at(2.4)
    tt = np.arange(n) / SR
    f0 = 55 + 25 * k
    ph = 2 * np.pi * np.cumsum(f0 * (1 + 0.08 * np.sin(tt * 3.1 + k))) / SR
    x = (np.sin(ph) + 0.4 * np.sin(2.01 * ph) + 0.2 * np.sin(3.03 * ph)) * smooth(tt / 0.4) * np.exp(-tt * 0.9)
    add(filt(x, lp(900)), screen(te), 0.35, (-1) ** k * 0.4)

# lamp posts hitting the gravel
for te in (2.7, 3.0, 3.25, 3.5, 3.7, 3.9, 4.2):
    n = at(1.2)
    tt = np.arange(n) / SR
    x = sum(np.sin(2 * np.pi * f * tt) * np.exp(-tt * d) for f, d in ((310, 5), (742, 8), (1290, 12)))
    add(x * smooth(tt / 0.002), screen(te), 0.08, rng.uniform(-0.8, 0.8))

# second 5: the concrete sets back, one dull heavy hit, then quiet
n = at(4.0)
tt = np.arange(n) / SR
setx = np.sin(2 * np.pi * (36 * tt + 20 * (1 - np.exp(-tt * 6)) / 6)) * np.exp(-tt * 1.3)
setx += filt(rng.standard_normal(n), lp(400)) * np.exp(-tt * 6) * 0.8
add(setx * smooth(tt / 0.003), BACK, 1.1)
# a few late shards tinkling
for k in range(80):
    s0 = BACK + 0.3 + rng.exponential(1.0)
    n = at(0.1)
    tt = np.arange(n) / SR
    add(np.sin(2 * np.pi * rng.uniform(3000, 7000) * tt) * np.exp(-tt * 60), s0, 0.03, rng.uniform(-0.9, 0.9))

fade = 1 - smooth((t - (DUR - 1.2)) / 1.2)
L *= fade
R *= fade
pk = max(np.abs(L).max(), np.abs(R).max(), 1e-9)
st = np.stack([L, R], 1) / pk * 0.9

ap = argparse.ArgumentParser()
ap.add_argument("-o", default=os.path.join(HERE, "..", "..", "out", "sims", "concrete", "sound.wav"))
out = os.path.abspath(ap.parse_args().o)
os.makedirs(os.path.dirname(out), exist_ok=True)
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((st * 32767).astype("<i2").tobytes())
print(f"-> {os.path.relpath(out)}  {DUR:.1f} s")
