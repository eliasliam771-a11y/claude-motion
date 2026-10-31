# Web sims → 60 fps video

Some videos aren't motion graphics, they're simulations: 256 agents crawling
a wall of websites, a rocket engine you can fly through. Those are easier to
build as a web page than as a Remotion composition, so this folder is a second
pipeline for them:

1. A sim is **one HTML page** (`sims/<name>/main.js`, bundled to
   `sims/dist/<name>.html` with three.js and fonts inlined, works offline).
2. Its `render(t)` is a **pure function of time**. Heavy work (agents, paths,
   collisions) is simulated once at 60 Hz when the page loads, so any frame can
   be drawn on demand.
3. `capture.mjs` opens it in headless Chromium, **steps `render(t)` frame by
   frame** and pipes screenshots to ffmpeg: frame-exact 60 fps at any size,
   however slow a frame is to draw.

Open the HTML file in a browser and it plays live and loops (space pauses,
←/→ seek, r restarts, f fullscreen).

## Examples

| | What it shows | Tricks worth stealing |
|---|---|---|
| [`crawlers`](crawlers/) | One spider agent doubles every 2 beats (1 → 256) across 16 made-up websites; every word a foot lands on lights up; the camera pulls back to the whole wall. [On X](https://x.com/whaleyxbt/status/2106099822088331481) | Real DOM text as terrain: every word is wrapped and measured, feet hit-test it. Procedural legs (2-bone IK, alternating gait). Doublings snap to the music's beat grid. |
| [`dossier`](dossier/) | The same swarm aimed at one fictional person: each public page leaks one detail, the nearest agent walks to it, a red thread carries it into a dossier. [On X](https://x.com/whaleyxbt/status/2106420024286031963) | "Hunter" agents steered to a target by a set time; screen-space threads from world-space words; facts land on the beat. |
| [`engine`](engine/) | A methane rocket engine running above a sunset cloud deck: the skirt opens, chapters light the flows, the camera flies through the chamber and throat into the plume, then the engine comes apart and back together. | three.js with sky + environment lighting, clipping-plane cutaway, glowing flow tubes, a plume volume with shock diamonds, a Python sound script on the same `timeline.json`. |
| [`selenium`](selenium/) | A TikTok "what if" in first person (9:16, 30 fps): selenium vanishes for 5 s around a café table on a city street. Slow motion slams to 0.1x and climbs to 0.6x; glass goes green, cadmium red goes yellow, a solar facade dies, a billboard goes blue, an x-ray of your friend. | Two clocks: camera and captions on real time, the world on the integral of the speed curve. One shader uniform (the radius of the vanishing front) drives every material change, the atom sparks and the readouts. Procedural people with IK. Sound on the same clock in `sound.py`. |
| [`nosun`](nosun/) | The Sun vanishes for 15 s, seen from the same café table. Nothing happens for 8 min 19 s (fast-forward to 225x, a space-view inset of the light gap in flight), then 15 s of night at 0.1x: black sky, the Moon going out 1.28 s late, stars, Jupiter, phone torches, headlights, Earth leaving its orbit. | A clock solved so the fast-forward lands exactly on the light delay. Night built from lights, not a filter: emissive window maps, point-light pools, cone beams, eye adaptation driving exposure and bloom threshold together. |
| [`oxygen`](oxygen/) | The O₂ in the air vanishes for 5 s at the same café table, 0.1x → 0.6x. Molecules pop, pressure drops 21%, candles and a patio heater go out, petrol cars stall beside an electric one, the sky stays blue as UV-C arrives, the grid trips. | Built from the selenium and no-sun parts. Instanced molecules for the hook, readouts that move with world time, effects that stay after the return (candles out, power off). |
| [`atoms`](atoms/) | Every atom vanishes for 5 s at the café table. The street dissolves into a starfield, the Sun keeps shining on its 8 min 19 s light delay, the Moon goes 1.28 s late, and a panel lists what isn't made of atoms (light, neutrinos, dark matter, the CMB). | One dissolve shader patched into every standard material, driven by a single uniform; sparks sampled off every static surface; a full-sphere starfield with a Milky Way band; sound that cuts to silence when the air goes. |
| [`baddies`](baddies/) | The street's stylish main characters vanish for 5 s in a glam sparkle; what they were holding falls with real timing (a bottle 25 cm in 0.23 s, an iced coffee 1.2 m in 0.5 s, then splash and ice). They respawn, then a tsunami comes over the rooftops. | Props become free bodies from their pose at W = 0; a dissolve on the baddies' own materials only; a swept, curling wave surface with foam keyed to its crest, spray, and an underwater end card. |
| [`spin`](spin/) | Earth spins 2x faster for 20 s (0.5x → 2x speed pill). Weight and day-length readouts, a spinning globe inset with the ocean current building to 1 m/s toward the equator, a flag lifting in the matching breeze, then a real tsunami bore up the street. | Physics worked out per latitude and drawn live; a tsunami with a real cause, sized from 2u√(H/g). |

Everything in the examples is invented: no real people, brands or domains
(`.example`). Caption figures in `engine` are rounded textbook values.

## Commands

```bash
npm install
npx playwright install chromium          # once; or set $CHROMIUM to your own build

node sims/build.mjs                      # all sims → sims/dist/<name>.html
node sims/build.mjs engine               # one sim

# review sheet: one frame per listed second, tiled
node sims/capture.mjs engine --stills 0,4,8,12,16,20 --cols 3 --out out/sims/engine-review.png

# video: 1080x1350 layout → 1440x1800 at 60 fps (default dpr 4/3, crf 16)
node sims/capture.mjs engine --size 1080x1350 --out out/sims/engine.mp4

# with a music track: beats.py finds tempo, bars and the drop, places the
# window so the drop lands ~40 % in, and passes the beat map to the sim
node sims/capture.mjs crawlers --music path/to/track.mp3 --to 20 --out out/sims/crawlers.mp4

# with a generated sound bed (engine)
python3 sims/engine/sound.py
node sims/capture.mjs engine --music out/sims/engine/ambient.wav --music-start 0 --no-sync --lufs -24 --out out/sims/engine.mp4
```

Other flags: `--config post.json` (merged over the sim's `DEFAULTS`),
`--still 12.5` (one PNG), `--fps`, `--dpr`, `--crf`, `--from`/`--to`,
`--lufs` (loudness of the muxed audio, default −21).

Every example has `watermark` in its `DEFAULTS`. Set it to your own handle,
or to `''`, in the sim or in a `--config` file.

## Making a new sim

Copy the example closest to what you want and change it. The contract:

```js
import {runSim} from '../kit/runtime.js';

const DEFAULTS = {duration: 20, fps: 60, hud: {enabled: false}, director: {enabled: false}, /* your params */};

runSim(DEFAULTS, async ({cfg, canvas, capture}) => {
  // build the scene, precompute anything stateful
  return {
    render(t) { /* draw frame t from scratch */ return {}; },
    resize() {},
  };
});
```

- `render(t)` must be pure: no `Math.random` (use `rng(seed)` from
  `kit/util.js` at setup), no `Date`, no state carried between frames.
  Capture calls it at arbitrary times.
- Anything that moves by its own rules (agents, particles that collide,
  steering) is simulated once at load into typed arrays, then `render` reads
  them.
- Frame 0 is the thumbnail on X. It must already be busy and beautiful.
- Lay out for 1080 px wide (CSS px); `--dpr` sets the output resolution.
- One NaN pixel blacks out the whole frame through bloom: clamp `pow()` bases
  in shaders.
- `cfg.beats` (with `--music`) holds `beats`, `downbeats`, `kicks` and `drop`
  in seconds from the clip start. Snap your big moments to them.

Kit: `kit/runtime.js` (boot, config merge, live loop, `window.SIM` for
capture), `kit/stage3d.js` (three.js renderer, bloom, camera),
`kit/util.js` (easing, keyframes, seeded rng), `kit/hud.js` and
`kit/director.js` (an optional instrument HUD and auto camera cuts; the
examples turn both off).

Review before you render the full clip: make a `--stills` sheet at the key
moments, look at every tile (see `.claude/skills/review-loop`), fix, repeat.
