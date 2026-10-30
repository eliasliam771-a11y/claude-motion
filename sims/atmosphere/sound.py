#!/usr/bin/env python3
"""Sound for "atmosphere", on the same timeline.json.

City air for the hook (traffic rumble, wind, a horn, a rising swell), then a
hard cut to silence when the air goes: sound needs air. Only a slowed,
muffled heartbeat carries through, the way your own body would by bone
conduction. At second 5 the air returns as one huge boom, glass rains down,
and the city comes back with car alarms.

    python3 sims/atmosphere/sound.py [-o out/sims/atmosphere/sound.wav]

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
DUR, OFF, BACK, SLOW = TL["duration"], TL["off"], TL["back"], TL["slow"]
N = int(DUR * SR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)


def filt(x, c):
    return np.array(biquad(list(x), c))


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def at(sec):
    return int(sec * SR)


L = np.zeros(N)
R = np.zeros(N)


def add(x, start=0.0, gain=1.0, pan=0.0):
    i = at(start)
    n = min(len(x), N - i)
    if n <= 0:
        return
    L[i:i + n] += x[:n] * gain * (1 - max(0, pan))
    R[i:i + n] += x[:n] * gain * (1 + min(0, pan))


# the air is there before OFF and after BACK; a 25 ms cut, a 2 s return
air = np.where(t < OFF, 1 - smooth((t - OFF + 0.025) / 0.025), smooth((t - BACK - 0.3) / 2.0))

# ---- city bed: traffic rumble, wind hiss
for ch, seed in ((L, 1), (R, 2)):
    w = np.random.default_rng(seed).standard_normal(N)
    rumble = filt(filt(w, lp(180)), lp(260)) * 2.2
    hiss = filt(filt(w, hp(900)), lp(5000)) * 0.12 * (0.8 + 0.2 * np.sin(t * 0.7 + seed))
    ch += (rumble + hiss) * air * 0.5

# a distant horn, two cars passing
def horn(dur, f):
    n = at(dur)
    tt = np.arange(n) / SR
    x = np.sign(np.sin(2 * np.pi * f * tt)) * 0.5 + np.sign(np.sin(2 * np.pi * f * 1.26 * tt)) * 0.5
    return filt(x, lp(1400)) * smooth(tt / 0.02) * smooth((dur - tt) / 0.05)


add(horn(0.35, 410), 1.1, 0.05, -0.5)
for s0, pan in ((0.3, 0.4), (2.0, -0.3)):
    n = at(2.2)
    tt = np.arange(n) / SR
    x = filt(rng.standard_normal(n), bp(500, 0.7)) * np.exp(-((tt - 1.1) ** 2) / 0.25)
    add(x, s0, 0.35, pan)

# rising swell into the cut (stops dead at OFF)
n = at(1.6)
tt = np.arange(n) / SR
sw = filt(rng.standard_normal(n), hp(300)) * (tt / 1.6) ** 3
sw += np.sin(2 * np.pi * (60 + 140 * (tt / 1.6) ** 2) * tt) * (tt / 1.6) ** 2 * 0.6
add(sw, OFF - 1.6, 0.5)

# ---- silence, except a slowed heartbeat through your own bones
beat = 0.75 / SLOW
for k in range(20):
    s0 = OFF + 0.5 + k * beat
    if s0 > BACK - 0.3:
        break
    for dt, g in ((0.0, 1.0), (0.32, 0.7)):
        n = at(0.4)
        tt = np.arange(n) / SR
        x = np.sin(2 * np.pi * (52 - 14 * tt) * tt) * np.exp(-tt * 14) * smooth(tt / 0.01)
        add(x, s0 + dt, 0.55 * g)

# ---- the return: sub drop + broadband slam + rolling tail
n = at(5.0)
tt = np.arange(n) / SR
sub = np.sin(2 * np.pi * (34 * tt + 40 * (1 - np.exp(-tt * 3)) / 3)) * np.exp(-tt * 0.9)
slam = filt(rng.standard_normal(n), lp(2400)) * np.exp(-tt * 3.2)
roll = filt(filt(rng.standard_normal(n), lp(140)), lp(140)) * 6 * np.exp(-tt * 0.6)
boom = (sub * 1.2 + slam * 0.9 + roll) * smooth(tt / 0.004)
add(boom, BACK, 1.0)

# glass: thousands of shards landing, a bright tinkle thinning out
for k in range(700):
    s0 = BACK + 0.2 + rng.exponential(1.4)
    if s0 > DUR - 0.5:
        continue
    f = rng.uniform(2800, 7500)
    n = at(0.12)
    tt = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * tt) * np.exp(-tt * rng.uniform(40, 90))
    add(x, s0, 0.05 * rng.uniform(0.3, 1), rng.uniform(-0.9, 0.9))

# car alarms after the boom
def alarm(start, f0, f1, pan):
    n = at(DUR - start)
    tt = np.arange(n) / SR
    f = np.where((tt * 3) % 1 < 0.5, f0, f1)
    x = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * smooth(tt / 0.3)
    add(filt(x, lp(2500)), start, 0.035, pan)


alarm(BACK + 1.4, 820, 1020, 0.6)
alarm(BACK + 2.3, 640, 760, -0.5)

# ---- master: fade tail, normalise peak (capture.mjs sets loudness)
fade = 1 - smooth((t - (DUR - 1.2)) / 1.2)
L *= fade
R *= fade
pk = max(np.abs(L).max(), np.abs(R).max(), 1e-9)
st = np.stack([L, R], 1) / pk * 0.9

ap = argparse.ArgumentParser()
ap.add_argument("-o", default=os.path.join(HERE, "..", "..", "out", "sims", "atmosphere", "sound.wav"))
out = os.path.abspath(ap.parse_args().o)
os.makedirs(os.path.dirname(out), exist_ok=True)
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((st * 32767).astype("<i2").tobytes())
print(f"-> {os.path.relpath(out)}  {DUR:.1f} s")
