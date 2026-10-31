import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {runSim} from '../kit/runtime.js';
import {createStage} from '../kit/stage3d.js';
import {clamp01, easeInOutCubic, easeOutCubic, lerp, rng, smooth} from '../kit/util.js';
import TL from './timeline.json';

// "What if all strontium disappeared for 5 seconds?" in the TikTok what-if
// format, from the café table of sims/selenium on a fireworks night. Red
// firework stars get their red from strontium (SrCl and SrOH emission), so
// every red star goes a pale orange the instant it vanishes; purple stars
// (strontium red plus copper blue) come out blue; a fan's red road flare
// (strontium nitrate) turns orange. Then an x-ray of your friend (an adult
// holds about 0.32 g of strontium, 99% of it in bone, where it sits in place
// of calcium), the strontium optical lattice clocks that stop counting while
// your phone keeps time on quartz, and the 11 trillion tonnes the oceans
// lose. When it comes back, the stars still burning turn red again.
//
// Two clocks: camera and overlay on real time t; the world (fireworks,
// people, smoke, the flare) on world time W, the integral of the slow-motion
// speed. W = 0 when strontium vanishes, W = 5 when it is back.
// Sound: sims/strontium/sound.py on the same timeline.json (firework booms
// arrive late, at the speed of sound).
//
// Numbers: ICRP reference adult 320 mg Sr; seawater 7.9 mg/kg x 1.37e21 kg
// of ocean = 1.1e16 kg; Sr-87 clock transition 429 228 004 229 873 Hz; the
// best Sr lattice clocks are uncertain by about 1e-18 (under 1 s in the age
// of the universe); phone clocks run on 32,768 Hz quartz crystals; the
// crust is about 0.037% strontium.

const DEFAULTS = {
  duration: TL.duration,
  fps: TL.fps,
  theme: 'dark',
  hud: {enabled: false, title: 'strontium', subtitle: ''},
  director: {enabled: false},
  watermark: '',
  seed: 38,
};

// ---------------------------------------------------------------- clocks
const SL = TL.slow;
const T0 = SL.start;
const TLEN = SL.world / (SL.s0 + (SL.s1 - SL.s0) / (SL.pow + 1));
const T1 = T0 + TLEN;
const speedAt = (t) => {
  if (t < T0 - SL.in) return 1;
  if (t < T0) return lerp(1, SL.s0, easeOutCubic((t - T0 + SL.in) / SL.in));
  if (t < T1) return SL.s0 + (SL.s1 - SL.s0) * Math.pow((t - T0) / TLEN, SL.pow);
  if (t < T1 + SL.out) return lerp(SL.s1, 1, smooth((t - T1) / SL.out));
  return 1;
};
const DT = 1 / 1000;
const NW = Math.ceil((TL.duration + 1) / DT) + 2;
const WT = new Float64Array(NW);
{
  const i0 = Math.round(T0 / DT);
  for (let i = i0 + 1; i < NW; i++) WT[i] = WT[i - 1] + 0.5 * (speedAt((i - 1) * DT) + speedAt(i * DT)) * DT;
  for (let i = i0 - 1; i >= 0; i--) WT[i] = WT[i + 1] - 0.5 * (speedAt(i * DT) + speedAt((i + 1) * DT)) * DT;
}
const worldAt = (t) => {
  const f = Math.min(Math.max(t / DT, 0), NW - 1.001);
  const i = Math.floor(f);
  return WT[i] + (WT[i + 1] - WT[i]) * (f - i);
};
const clockAt = (t) => (t >= T1 ? SL.world : Math.min(SL.world, Math.max(0, worldAt(t))));
// 1 while there is no strontium
const goneAt = (w) => smooth(w / 0.03) * (1 - smooth((w - SL.world) / 0.03));

// ---------------------------------------------------------------- layout
const SW = 0.12; // sidewalk height
const EYE = new THREE.Vector3(-8.3, SW + 1.18, 0);
const TOP = SW + 0.74; // table top
const BILL = {x: -1, y: 8.9, z: -43.8, w: 15, h: 8.4};
const FLARE_AT = new THREE.Vector3(-3.0, 0, -16); // the fan with the red flare, on the closed street
const TARGETS = {
  sky: [15, 92, -215],
  sky1: [17, 98, -215],
  flare: [-3.3, 1.75, -16],
  sky2: [10, 116, -210],
  friendBody: [-6.9, SW + 0.98, 0.02],
  phone: [-8.06, 0.915, 0.02],
  sky3: [6, 92, -215],
  sky4: [12, 90, -215],
};

const std = (color, rough = 0.8, metal = 0, extra = {}) => new THREE.MeshStandardMaterial({color, roughness: rough, metalness: metal, ...extra});
const glassMat = () => std('#e4eeec', 0.04, 0, {transparent: true, opacity: 0.2, envMapIntensity: 1.8, depthWrite: false});
const redMat = () => std('#c4231b', 0.42, 0.25, {envMapIntensity: 0.7});
const waterMat = std('#d6eef2', 0.02, 0, {transparent: true, opacity: 0.32, envMapIntensity: 1.6, depthWrite: false});

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const _d = V();
/** Places a Y-axis mesh (capsule, cylinder) between two points. */
const seg = (mesh, a, b) => {
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  _d.subVectors(b, a);
  const len = _d.length() || 1;
  mesh.quaternion.setFromUnitVectors(UP, _d.divideScalar(len));
};
const _iv = V();
const _iw = V();
/** Two-bone IK: elbow/knee position for root a, target t, bone lengths, pole hint. */
const ik = (a, t, l1, l2, pole, out) => {
  _iv.subVectors(t, a);
  const len = Math.min(Math.max(_iv.length(), Math.abs(l1 - l2) + 1e-3), (l1 + l2) * 0.999);
  _iv.normalize();
  const along = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
  const hh = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  _iw.copy(pole).addScaledVector(_iv, -pole.dot(_iv)).normalize();
  return out.copy(a).addScaledVector(_iv, along).addScaledVector(_iw, hh);
};
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------- fireworks
// star colours (linear, over 1 so they bloom); with no strontium red becomes
// the pale orange of the fuel and sodium, purple loses its red and is left blue
const FCOL = {
  red: [4.0, 0.24, 0.15],
  pale: [2.1, 1.0, 0.34],
  purple: [2.3, 0.34, 3.3],
  blue: [0.3, 0.55, 3.1],
  green: [0.5, 3.1, 0.7],
  gold: [3.0, 1.5, 0.4],
  white: [3.0, 2.9, 2.7],
};
const NO_SR = {red: 'pale', purple: 'blue'};
const KIND = {
  peony: {n: 160, R: 44, k: 2.6, life: 1.85, g: 7, trail: 7, tdt: 0.035, size: 92},
  big: {n: 210, R: 56, k: 2.4, life: 2.1, g: 7, trail: 8, tdt: 0.035, size: 100},
  ring: {n: 120, R: 46, k: 2.6, life: 1.75, g: 6, trail: 6, tdt: 0.035, size: 92, ring: true},
  willow: {n: 120, R: 36, k: 3.2, life: 3.4, g: 13, trail: 12, tdt: 0.075, size: 68, glitter: true},
  chrys: {n: 150, R: 46, k: 2.4, life: 2.0, g: 8, trail: 10, tdt: 0.05, size: 76, glitter: true},
};
const RISE = 1.4; // seconds from the mortar to the burst
const WIND = 1.6; // m/s, carries stars and smoke east

// ---------------------------------------------------------------- textures
function canvasTex(w, h, draw, repeat) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  return tex;
}

const PXM = 34; // facade texture pixels per metre
function facadeTex(w, h, o, R) {
  const ec = document.createElement('canvas');
  ec.width = Math.round(w * PXM);
  ec.height = Math.round(h * PXM);
  const ge = ec.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, ec.width, ec.height);
  const map = canvasTex(Math.round(w * PXM), Math.round(h * PXM), (g, cw, ch) => {
    const m = (v) => v * PXM;
    const Y = (y) => ch - m(y); // metres from ground -> canvas y
    g.fillStyle = o.base;
    g.fillRect(0, 0, cw, ch);
    // plaster / brick grain
    for (let i = 0; i < cw * ch * 0.004; i++) {
      g.fillStyle = `rgba(${R() < 0.5 ? '0,0,0' : '255,255,255'},${0.03 + R() * 0.04})`;
      g.fillRect(R() * cw, R() * ch, 2 + R() * 4, 1 + R() * 2);
    }
    if (o.brick) {
      g.strokeStyle = 'rgba(40,20,10,0.22)';
      g.lineWidth = 1;
      for (let y = 0; y < ch; y += m(0.22)) {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(cw, y);
        g.stroke();
        const off = (Math.round(y / m(0.22)) % 2) * m(0.25);
        for (let x = off; x < cw; x += m(0.5)) {
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x, y + m(0.22));
          g.stroke();
        }
      }
    }
    const ground = 4.4;
    // cornice and string courses
    g.fillStyle = o.trim;
    g.fillRect(0, Y(h) , cw, m(0.55));
    g.fillRect(0, Y(ground + 0.35), cw, m(0.35));
    // upper windows
    const fl = 3.2;
    const sp = o.sp ?? 2.5;
    const n = Math.max(1, Math.floor((w - 0.8) / sp));
    const x0 = (w - n * sp) / 2 + sp / 2;
    for (let fy = ground + 0.9; fy + 2.1 < h - 0.7; fy += fl) {
      for (let k = 0; k < n; k++) {
        const cx = x0 + k * sp;
        const ww = o.winW ?? 1.25;
        const wh = o.winH ?? 1.9;
        const x = m(cx - ww / 2);
        const y = Y(fy + wh);
        g.fillStyle = o.trim;
        g.fillRect(x - m(0.12), y - m(0.12), m(ww + 0.24), m(wh + 0.24));
        const gr = g.createLinearGradient(0, y, 0, y + m(wh));
        const lit = R();
        if (lit < 0.32) {
          ge.fillStyle = ['#ffc48a', '#ffd9a8', '#e8f0ff', '#ffb070'][Math.floor(R() * 4)];
          ge.globalAlpha = 0.35 + R() * 0.5;
          ge.fillRect(x, y, m(ww), m(wh));
          ge.globalAlpha = 1;
        }
        gr.addColorStop(0, lit < 0.15 ? '#c99a64' : '#8ea3b4');
        gr.addColorStop(0.45, lit < 0.15 ? '#7a5636' : '#3c4b58');
        gr.addColorStop(1, '#222a31');
        g.fillStyle = gr;
        g.fillRect(x, y, m(ww), m(wh));
        if (R() < 0.35) {
          g.fillStyle = ['#d8cdb8', '#b9c7c2', '#e6d6c0', '#9c8f84'][Math.floor(R() * 4)];
          g.fillRect(x, y, m(ww * (0.25 + R() * 0.3)), m(wh));
        }
        g.fillStyle = o.trim;
        g.fillRect(x + m(ww / 2) - 2, y, 4, m(wh));
        g.fillRect(x, y + m(wh * 0.38), m(ww), 4);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x - m(0.18), y + m(wh + 0.12), m(ww + 0.36), m(0.1));
      }
    }
    // storefront
    g.fillStyle = o.shop ?? '#2b2a2a';
    g.fillRect(0, Y(ground), cw, m(ground));
    g.fillStyle = o.sign ?? '#1e3b33';
    g.fillRect(m(0.4), Y(ground - 0.15), cw - m(0.8), m(0.85));
    if (o.text) {
      ge.fillStyle = '#fff3dc';
      ge.font = `700 ${m(0.52)}px Inter`;
      ge.textAlign = 'center';
      ge.textBaseline = 'middle';
      ge.fillText(o.text, cw / 2, Y(ground - 0.58));
      g.fillStyle = o.signText ?? '#f2e6cf';
      g.font = `700 ${m(0.52)}px Inter`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(o.text, cw / 2, Y(ground - 0.58));
    }
    const pane = (x, y0, pw, ph) => {
      const gr = g.createLinearGradient(0, Y(y0 + ph), 0, Y(y0));
      gr.addColorStop(0, '#6f8494');
      gr.addColorStop(0.5, '#2b3740');
      gr.addColorStop(1, '#3d3a35');
      g.fillStyle = gr;
      g.fillRect(m(x), Y(y0 + ph), m(pw), m(ph));
      ge.fillStyle = '#ffcf94';
      ge.fillRect(m(x), Y(y0 + ph), m(pw), m(ph));
      // things in the window
      for (let i = 0; i < 6; i++) {
        const fx = m(x + R() * (pw - 0.5)), fy = Y(y0 + 0.2 + R() * 1.1), fw = m(0.2 + R() * 0.4), fh = m(0.3 + R() * 0.5);
        const hue = R() * 360;
        g.fillStyle = `hsla(${hue},30%,${45 + R() * 25}%,0.55)`;
        g.fillRect(fx, fy, fw, fh);
        ge.fillStyle = `hsla(${hue},45%,35%,0.9)`;
        ge.fillRect(fx, fy, fw, fh);
      }
    };
    const bays = Math.max(2, Math.round(w / 3.2));
    const bw = (w - 0.8) / bays;
    for (let k = 0; k < bays; k++) {
      const x = 0.4 + k * bw;
      if (k === Math.floor(bays / 2)) {
        g.fillStyle = '#3a2c22';
        g.fillRect(m(x + bw * 0.25), Y(2.4), m(bw * 0.5), m(2.4));
        g.fillStyle = 'rgba(160,190,205,0.45)';
        g.fillRect(m(x + bw * 0.3), Y(2.25), m(bw * 0.4), m(1.5));
        ge.fillStyle = '#ffd9a8';
        ge.fillRect(m(x + bw * 0.3), Y(2.25), m(bw * 0.4), m(1.5));
      } else pane(x + 0.12, 0.35, bw - 0.24, 2.9);
    }
  });
  const em = new THREE.CanvasTexture(ec);
  em.colorSpace = THREE.SRGBColorSpace;
  em.anisotropy = 4;
  return {map, em};
}

function cigsTex() {
  // dark thin-film modules, 1.2 x 0.6 m, scribe lines, silver frames
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#0f1520';
    g.fillRect(0, 0, w, h);
    const R = rng(7);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 2; c++) {
        const x = c * 256, y = r * 128;
        const gr = g.createLinearGradient(x, y, x + 256, y + 128);
        const v = 18 + R() * 8;
        gr.addColorStop(0, `rgb(${v},${v + 6},${v + 18})`);
        gr.addColorStop(1, `rgb(${v - 6},${v},${v + 10})`);
        g.fillStyle = gr;
        g.fillRect(x + 4, y + 4, 248, 120);
        g.strokeStyle = 'rgba(120,140,170,0.16)';
        g.lineWidth = 1;
        for (let k = 8; k < 248; k += 7) {
          g.beginPath();
          g.moveTo(x + 4 + k, y + 4);
          g.lineTo(x + 4 + k, y + 124);
          g.stroke();
        }
        g.strokeStyle = '#8f98a3';
        g.lineWidth = 4;
        g.strokeRect(x + 2, y + 2, 252, 124);
      }
    }
  });
}

function billboardTex() {
  // invented ad, red/orange/green heavy so the loss of red and green reads
  return canvasTex(1500, 840, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#d8261c');
    bg.addColorStop(0.55, '#ff7a12');
    bg.addColorStop(1, '#ffc23a');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const orange = (cx, cy, r) => {
      g.fillStyle = '#ff8a00';
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffd27a';
      g.beginPath();
      g.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#ff9d1c';
      g.lineWidth = r * 0.07;
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(a) * r * 0.84, cy + Math.sin(a) * r * 0.84);
        g.stroke();
      }
      g.fillStyle = '#fff3d6';
      g.beginPath();
      g.arc(cx, cy, r * 0.12, 0, Math.PI * 2);
      g.fill();
    };
    const leaf = (cx, cy, r, a) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(a);
      g.fillStyle = '#1f9a3a';
      g.beginPath();
      g.ellipse(0, 0, r, r * 0.42, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#7fdc5a';
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(-r * 0.9, 0);
      g.lineTo(r * 0.9, 0);
      g.stroke();
      g.restore();
    };
    leaf(1130, 210, 150, -0.5);
    leaf(1330, 430, 130, 0.7);
    leaf(990, 640, 120, 2.6);
    orange(1180, 470, 230);
    orange(1390, 170, 120);
    g.fillStyle = '#ffffff';
    g.font = '900 150px Inter';
    g.textBaseline = 'alphabetic';
    g.fillText('SQUEEZED', 80, 300);
    g.fillText('THIS MORNING', 80, 455);
    g.fillStyle = '#1f9a3a';
    g.fillRect(84, 530, 520, 96);
    g.fillStyle = '#ffffff';
    g.font = '800 58px Inter';
    g.fillText('fresh orange juice', 112, 597);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = '700 40px Inter';
    g.fillText('JUICE BAR 34', 86, 730);
  });
}

function paversTex() {
  return canvasTex(256, 256, (g, w, h) => {
    const R = rng(3);
    g.fillStyle = '#9b958c';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const v = 150 + R() * 26;
        g.fillStyle = `rgb(${v},${v - 6},${v - 14})`;
        g.fillRect(x * 64 + 2, y * 64 + 2, 60, 60);
        for (let k = 0; k < 40; k++) {
          g.fillStyle = `rgba(0,0,0,${R() * 0.08})`;
          g.fillRect(x * 64 + 2 + R() * 58, y * 64 + 2 + R() * 58, 2, 2);
        }
      }
    }
  });
}
function asphaltTex() {
  return canvasTex(256, 256, (g, w, h) => {
    const R = rng(5);
    g.fillStyle = '#45464a';
    g.fillRect(0, 0, w, h);
    for (let k = 0; k < 5000; k++) {
      const v = 50 + R() * 50;
      g.fillStyle = `rgba(${v},${v},${v + 4},0.5)`;
      g.fillRect(R() * w, R() * h, 1 + R() * 2, 1 + R() * 2);
    }
  });
}

// ---------------------------------------------------------------- people
const SKIN = ['#f1c6a5', '#e2ae88', '#c78b65', '#9e6846', '#6d4631', '#f5d5bc', '#87583b'];
const CLOTH = ['#2f4a6d', '#3d6b5a', '#d9d2c3', '#1f2328', '#6b7280', '#c9a14a', '#4b6fa8', '#7a5c8e', '#ebe7df', '#57683a', '#2b5d63', '#a7b7c9', '#8c6d52', '#34405a', '#b7a48b', '#5c6f8c'];
const HAIR = ['#1b1512', '#3a2618', '#6b4a2b', '#a87d4a', '#d8c39a', '#2a2a2a', '#8a8a86'];
const matCache = new Map();
const clothM = (c, r = 0.85) => {
  const k = `${c}|${r}`;
  if (!matCache.has(k)) matCache.set(k, std(c, r, 0));
  return matCache.get(k);
};
const skinM = (c) => {
  const k = `skin${c}`;
  if (!matCache.has(k)) matCache.set(k, std(c, 0.62, 0));
  return matCache.get(k);
};

function makePerson(o) {
  const h = (o.h ?? 1.74) / 1.75;
  const root = new THREE.Group();
  const own = (m) => (o.own ? m.clone() : m);
  const skin = o.own ? std(o.skin, 0.62, 0) : skinM(o.skin);
  const top = own(clothM(o.top));
  const bot = own(clothM(o.bot));
  const shoe = own(clothM(o.shoe ?? '#26221f', 0.6));
  const hairM = own(clothM(o.hairC ?? '#2a1d14', 0.9));
  const add = (geo, mat, parent = root) => {
    const x = new THREE.Mesh(geo, mat);
    x.castShadow = true;
    parent.add(x);
    return x;
  };
  const cap = (r, l, mat, parent) => add(new THREE.CapsuleGeometry(r, l, 3, 10), mat, parent);
  const body = new THREE.Group();
  body.rotation.order = 'YXZ';
  root.add(body);
  const P = {root, body, h, o, seatY: o.seatY ?? 0.46};
  P.torso = cap(0.152 * h, 0.3 * h, top, body);
  P.torso.scale.set(1.13, 1, 0.66);
  P.torso.position.y = 0.27 * h;
  P.pelvis = cap(0.136 * h, 0.06 * h, bot);
  P.pelvis.scale.set(1.2, 1, 0.75);
  const shin = o.shorts ? skin : bot;
  const fore = o.tee ? skin : top;
  P.thigh = [0, 1].map(() => cap(0.074 * h, 0.42 * h, bot));
  P.shin = [0, 1].map(() => cap(0.056 * h, 0.42 * h, shin));
  P.foot = [0, 1].map(() => add(new RoundedBoxGeometry(0.1 * h, 0.075 * h, 0.26 * h, 2, 0.03 * h), shoe));
  P.upper = [0, 1].map(() => cap(0.053 * h, 0.24 * h, top));
  P.fore = [0, 1].map(() => cap(0.044 * h, 0.21 * h, fore));
  P.hand = [0, 1].map(() => add(new THREE.SphereGeometry(0.048 * h, 10, 8), skin));
  P.hand.forEach((m) => m.scale.set(0.8, 1.15, 1));
  const neck = cap(0.047 * h, 0.07 * h, skin, body);
  neck.position.y = 0.6 * h;
  const head = new THREE.Group();
  head.rotation.order = 'YXZ';
  head.position.y = 0.64 * h;
  body.add(head);
  P.head = head;
  const skull = add(new THREE.SphereGeometry(0.104 * h, 20, 16), skin, head);
  skull.scale.set(0.9, 1.07, 0.98);
  skull.position.set(0, 0.105 * h, 0.008 * h);
  const nose = add(new THREE.CapsuleGeometry(0.014 * h, 0.03 * h, 2, 6), skin, head);
  nose.position.set(0, 0.095 * h, 0.104 * h);
  nose.rotation.x = 0.35;
  for (const s of [-1, 1]) {
    const ear = add(new THREE.SphereGeometry(0.026 * h, 8, 6), skin, head);
    ear.scale.set(0.45, 1, 0.8);
    ear.position.set(s * 0.093 * h, 0.1 * h, -0.005 * h);
  }
  if (!o.glasses) {
    const eyeM = clothM('#1c1512', 0.4);
    for (const s of [-1, 1]) {
      const e = add(new THREE.SphereGeometry(0.011 * h, 8, 6), eyeM, head);
      e.scale.set(1, 0.8, 0.5);
      e.position.set(s * 0.033 * h, 0.122 * h, 0.098 * h);
    }
  }
  const style = o.hair ?? 'short';
  if (style !== 'bald') {
    const capG = new THREE.SphereGeometry(0.111 * h, 20, 12, 0, Math.PI * 2, 0, Math.PI * (style === 'beanie' ? 0.5 : 0.56));
    const hc = add(capG, style === 'beanie' ? clothM(o.beanie ?? '#2f4a6d') : hairM, head);
    hc.scale.set(0.93, 1.05, 1.02);
    hc.position.set(0, 0.112 * h, -0.004 * h);
    hc.rotation.x = -0.28;
    if (style === 'long') {
      const back = cap(0.09 * h, 0.17 * h, hairM, head);
      back.scale.set(1.08, 1, 0.55);
      back.position.set(0, 0.04 * h, -0.055 * h);
    }
    if (style === 'bun') {
      const bun = add(new THREE.SphereGeometry(0.048 * h, 10, 8), hairM, head);
      bun.position.set(0, 0.2 * h, -0.075 * h);
    }
  }
  if (o.glasses) {
    const lensM = std('#0b0d10', 0.1, 0.6, {envMapIntensity: 1.4});
    for (const s of [-1, 1]) {
      const l = add(new RoundedBoxGeometry(0.06 * h, 0.042 * h, 0.014 * h, 2, 0.012 * h), lensM, head);
      l.position.set(s * 0.038 * h, 0.12 * h, 0.1 * h);
      l.rotation.y = s * 0.18;
    }
    const br = add(new THREE.BoxGeometry(0.03 * h, 0.008 * h, 0.008 * h), lensM, head);
    br.position.set(0, 0.13 * h, 0.106 * h);
    for (const s of [-1, 1]) {
      const arm = add(new THREE.BoxGeometry(0.006 * h, 0.006 * h, 0.1 * h), lensM, head);
      arm.position.set(s * 0.085 * h, 0.128 * h, 0.05 * h);
    }
  }
  if (o.backpack) {
    const bp = add(new RoundedBoxGeometry(0.28 * h, 0.36 * h, 0.13 * h, 2, 0.04 * h), clothM(o.backpack), body);
    bp.position.set(0, 0.33 * h, -0.15 * h);
  }
  if (o.bag) {
    const bg = add(new RoundedBoxGeometry(0.06 * h, 0.3 * h, 0.34 * h, 2, 0.02 * h), clothM(o.bag, 0.7));
    P.bag = bg;
  }
  P.extra = {};
  return P;
}

const _p = {hip: [V(), V()], knee: [V(), V()], ank: [V(), V()], sh: [V(), V()], el: [V(), V()], wr: [V(), V()]};
const POLE_KNEE = V(0, 0.3, 1);
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _t = V();
/**
 * Poses a person in its own frame (forward +z). st: {mode: walk|sit, phase,
 * amp, lean, twist, headYaw, headPitch, hand: [Vector3|null, Vector3|null], shrug}
 */
function posePerson(P, st) {
  const h = P.h;
  const L1 = 0.44 * h, L2 = 0.44 * h, A1 = 0.27 * h, A2 = 0.25 * h;
  const {hip, knee, ank, sh, el, wr} = _p;
  let pelvisY;
  const pitch = [0, 0];
  if (st.mode === 'sit') {
    pelvisY = P.seatY + 0.07 * h;
    for (let s = 0; s < 2; s++) {
      const sx = (s ? -1 : 1) * 0.095 * h;
      hip[s].set(sx, pelvisY, -0.03 * h);
      ank[s].set(sx * 1.25, 0.075 * h, (0.38 + s * 0.05) * h);
      ik(hip[s], ank[s], L1, L2, POLE_KNEE, knee[s]);
    }
  } else {
    let low = 0;
    for (let s = 0; s < 2; s++) {
      const ph = st.phase + s * Math.PI;
      const th = st.amp * 0.42 * Math.sin(ph);
      const ka = 0.05 + st.amp * (0.06 + 0.95 * Math.pow(Math.max(0, Math.cos(ph + 0.45)), 2));
      const sx = (s ? -1 : 1) * 0.095 * h;
      knee[s].set(sx, -L1 * Math.cos(th), L1 * Math.sin(th));
      ank[s].set(sx * 1.05, knee[s].y - L2 * Math.cos(th - ka), knee[s].z + L2 * Math.sin(th - ka));
      pitch[s] = -0.45 * (th - ka) * st.amp;
      low = Math.min(low, ank[s].y);
    }
    pelvisY = 0.075 * h - low;
    for (let s = 0; s < 2; s++) {
      hip[s].set((s ? -1 : 1) * 0.095 * h, pelvisY, 0);
      knee[s].y += pelvisY;
      ank[s].y += pelvisY;
    }
  }
  for (let s = 0; s < 2; s++) {
    seg(P.thigh[s], hip[s], knee[s]);
    seg(P.shin[s], knee[s], ank[s]);
    const f = P.foot[s];
    f.position.set(ank[s].x, ank[s].y - 0.035 * h, ank[s].z + 0.065 * h);
    f.rotation.set(pitch[s], 0, 0);
  }
  P.pelvis.position.set(0, pelvisY, 0);
  P.body.position.set(0, pelvisY, 0);
  P.body.rotation.set(st.lean ?? 0.04, st.twist ?? 0, 0);
  _e.set(st.lean ?? 0.04, st.twist ?? 0, 0, 'YXZ');
  const shrug = st.shrug ?? 0;
  for (let s = 0; s < 2; s++) {
    const side = s ? -1 : 1;
    sh[s].set(side * 0.18 * h, 0.5 * h + shrug * 0.05 * h, 0).applyEuler(_e);
    sh[s].y += pelvisY;
    const tgt = st.hand?.[s];
    if (tgt) {
      ik(sh[s], tgt, A1, A2, _t.set(side * 0.9, -0.6, -0.4), el[s]);
      wr[s].subVectors(tgt, el[s]).normalize().multiplyScalar(A2).add(el[s]);
    } else {
      const ph = st.phase + s * Math.PI;
      const al = -(st.amp ?? 0) * 0.33 * Math.sin(ph) + 0.03;
      const be = 0.18 + (st.amp ?? 0) * 0.28 * (0.5 + 0.5 * Math.sin(-ph));
      el[s].set(sh[s].x + side * 0.02 * h, sh[s].y - A1 * Math.cos(al), sh[s].z + A1 * Math.sin(al));
      wr[s].set(el[s].x + side * 0.012 * h, el[s].y - A2 * Math.cos(al + be), el[s].z + A2 * Math.sin(al + be));
    }
    seg(P.upper[s], sh[s], el[s]);
    seg(P.fore[s], el[s], wr[s]);
    _d.subVectors(wr[s], el[s]).normalize();
    P.hand[s].position.copy(wr[s]).addScaledVector(_d, 0.035 * h);
    P.hand[s].quaternion.copy(P.fore[s].quaternion);
  }
  if (P.bag) {
    P.bag.position.set(-0.24 * h, pelvisY + 0.02 * h, 0.01 * h);
    P.bag.rotation.set(0.15 * Math.sin(st.phase ?? 0) * (st.amp ?? 0), 0, 0.05);
  }
  P.head.rotation.set(-(st.headPitch ?? 0) - (st.lean ?? 0.04), (st.headYaw ?? 0) - (st.twist ?? 0), 0);
}

// ---------------------------------------------------------------- props
function makeChair(mat) {
  const g = new THREE.Group();
  const leg = new THREE.CylinderGeometry(0.012, 0.012, 0.46, 6);
  for (const [x, z] of [[0.17, 0.17], [-0.17, 0.17], [0.17, -0.17], [-0.17, -0.17]]) {
    const m = new THREE.Mesh(leg, mat);
    m.position.set(x, 0.23, z);
    m.rotation.set(z * 0.25, 0, -x * 0.25);
    m.castShadow = true;
    g.add(m);
  }
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.2, 0.03, 20), mat);
  seat.position.y = 0.46;
  seat.castShadow = true;
  g.add(seat);
  for (const x of [0.15, -0.15]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.42, 6), mat);
    p.position.set(x, 0.66, -0.19);
    p.rotation.x = -0.12;
    p.castShadow = true;
    g.add(p);
  }
  for (const y of [0.74, 0.86]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.012, 6, 18, Math.PI), mat);
    r.position.set(0, y, -0.2);
    r.rotation.set(Math.PI / 2 - 0.12, Math.PI, 0);
    r.scale.set(1, 0.6, 1);
    r.castShadow = true;
    g.add(r);
  }
  return g;
}
function makeTable() {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.03, 40), std('#ddd6ca', 0.35, 0.05));
  top.position.y = 0.725;
  top.castShadow = top.receiveShadow = true;
  g.add(top);
  const metal = std('#2b2c2e', 0.4, 0.7);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 10), metal);
  stem.position.y = 0.36;
  stem.castShadow = true;
  g.add(stem);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.03, 24), metal);
  base.position.y = 0.015;
  g.add(base);
  return g;
}
function makeBottle(mat, scale = 1) {
  const pts = [[0, 0], [0.034, 0], [0.036, 0.01], [0.036, 0.15], [0.03, 0.19], [0.014, 0.225], [0.013, 0.27], [0.016, 0.275], [0.0, 0.275]]
    .map(([r, y]) => new THREE.Vector2(r * scale, y * scale));
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), mat);
  m.renderOrder = 2;
  return m;
}
function makeGlass(mat) {
  const pts = [[0, 0.004], [0.03, 0.0], [0.033, 0.004], [0.038, 0.11], [0.036, 0.11], [0.03, 0.008], [0, 0.01]].map(([r, y]) => new THREE.Vector2(r, y));
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), mat);
  m.renderOrder = 2;
  return m;
}
function makeTree(R) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, 3.2, 8), std('#5a4636', 0.9));
  trunk.position.y = 1.6;
  trunk.castShadow = true;
  g.add(trunk);
  const crown = new THREE.Group();
  crown.position.y = 3.0;
  g.add(crown);
  for (let i = 0; i < 6; i++) {
    const geo = new THREE.IcosahedronGeometry(1.0 + R() * 0.5, 2);
    const p = geo.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const s = 1 + (R() - 0.5) * 0.22;
      p.setXYZ(k, p.getX(k) * s, p.getY(k) * s, p.getZ(k) * s);
    }
    geo.computeVertexNormals();
    const c = new THREE.Color().setHSL(0.24 + R() * 0.06, 0.38 + R() * 0.15, 0.24 + R() * 0.08);
    const m = new THREE.Mesh(geo, std(c, 0.9));
    m.position.set((R() - 0.5) * 2.0, 0.9 + R() * 1.6, (R() - 0.5) * 2.0);
    m.castShadow = true;
    crown.add(m);
  }
  g.userData.crown = crown;
  return g;
}
function makeCar(color, R) {
  const g = new THREE.Group();
  const paint = std(color, 0.32, 0.45, {envMapIntensity: 0.9});
  const body = new THREE.Mesh(new RoundedBoxGeometry(1.82, 0.72, 4.35, 3, 0.2), paint);
  body.position.y = 0.62;
  body.castShadow = true;
  g.add(body);
  const cabin = new THREE.Mesh(new RoundedBoxGeometry(1.62, 0.62, 2.3, 3, 0.22), std('#1a2228', 0.08, 0.3, {envMapIntensity: 1.3}));
  cabin.position.set(0, 1.2, -0.15);
  cabin.castShadow = true;
  g.add(cabin);
  const roof = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.08, 1.9, 2, 0.04), paint);
  roof.position.set(0, 1.52, -0.2);
  g.add(roof);
  const tyre = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 18);
  const tyreM = std('#141414', 0.8);
  const hubM = std('#b9bcc0', 0.3, 0.8);
  g.userData.wheels = [];
  for (const [x, z] of [[0.82, 1.38], [-0.82, 1.38], [0.82, -1.35], [-0.82, -1.35]]) {
    const w = new THREE.Group();
    w.position.set(x, 0.34, z);
    const t = new THREE.Mesh(tyre, tyreM);
    t.rotation.z = Math.PI / 2;
    t.castShadow = true;
    w.add(t);
    const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.25, 5), hubM);
    hb.rotation.z = Math.PI / 2;
    w.add(hb);
    g.add(w);
    g.userData.wheels.push(w);
  }
  const lamp = (x, z, c, e) => {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.05), std(c, 0.3, 0, {emissive: c, emissiveIntensity: e}));
    l.position.set(x, 0.78, z);
    g.add(l);
  };
  for (const s of [-1, 1]) {
    lamp(s * 0.6, 2.17, '#fff6e0', 0.4);
    lamp(s * 0.62, -2.17, '#7a1410', 0.3);
  }
  return g;
}
function makePigeon(R) {
  const g = new THREE.Group();
  const grey = std('#8a8e95', 0.85);
  const dark = std('#55595f', 0.85);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), grey);
  body.scale.set(0.75, 0.7, 1.4);
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), std('#6f7a80', 0.7));
  head.position.set(0, 0.07, 0.12);
  g.add(head);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.01, 0.12), dark);
  tail.position.set(0, 0.0, -0.16);
  g.add(tail);
  g.userData.wings = [-1, 1].map((s) => {
    const p = new THREE.Group();
    p.position.set(s * 0.05, 0.03, 0.02);
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.008, 0.13), grey);
    w.position.x = s * 0.15;
    w.castShadow = true;
    p.add(w);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.008, 0.09), dark);
    tip.position.x = s * 0.33;
    p.add(tip);
    g.add(p);
    return p;
  });
  g.userData.head = head;
  return g;
}

// ---------------------------------------------------------------- shaders
const POINT_VERT = /* glsl */ `
attribute float aSize; attribute vec3 aColor; varying vec3 vC; uniform float uScale;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vC = aColor;
  gl_PointSize = min(aSize * uScale / max(0.05, -mv.z), 90.0);
  gl_Position = projectionMatrix * mv;
}`;
const POINT_FRAG = /* glsl */ `
varying vec3 vC;
void main(){
  vec2 p = gl_PointCoord - 0.5; float d = dot(p, p) * 4.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vC * pow(1.0 - d, 1.8), 1.0);
}`;
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FRAG = /* glsl */ `
uniform vec3 uBD[6]; uniform vec3 uBC[6]; uniform float uHalo;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 c = mix(vec3(0.03, 0.028, 0.06), vec3(0.004, 0.006, 0.018), smoothstep(0.0, 0.6, h));
  c += vec3(0.10, 0.055, 0.03) * exp(-max(h, 0.0) * 10.0); // city glow on the horizon
  for (int i = 0; i < 6; i++) {
    float a = max(dot(d, uBD[i]), 0.0);
    c += uBC[i] * uHalo * (0.4 * pow(a, 90.0) + 0.07 * pow(a, 14.0));
  }
  gl_FragColor = vec4(c, 1.0);
}`;
const BILL_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BILL_FRAG = /* glsl */ `
uniform sampler2D uMap; uniform float uGain;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(uMap, vUv).rgb;
  vec2 px = fract(vUv * vec2(300.0, 168.0));
  float grid = 0.82 + 0.18 * smoothstep(0.0, 0.25, px.x) * smoothstep(0.0, 0.25, px.y);
  gl_FragColor = vec4(c * grid * uGain, 1.0);
}`;
const HOLO_VERT = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec3 vW;
uniform float uPush;
void main(){
  vec3 p = position + normal * uPush;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * w;
  vW = w.xyz; vV = -mv.xyz; vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;
const HOLO_FRAG = /* glsl */ `
uniform float uI; uniform float uScan;
varying vec3 vN; varying vec3 vV; varying vec3 vW;
void main(){
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, 2.2);
  float lines = 0.85 + 0.15 * smoothstep(0.3, 0.5, fract(vW.y * 90.0));
  float band = exp(-pow((vW.y - uScan) / 0.03, 2.0));
  vec3 c = vec3(0.25, 0.7, 1.0) * (0.03 + 0.55 * rim) * lines + vec3(0.85, 0.97, 1.0) * band * 0.5;
  gl_FragColor = vec4(c * uI, 1.0);
}`;
// bones in the x-ray: bright where the scan line has passed
const BONE_FRAG = /* glsl */ `
uniform float uI; uniform float uScan;
varying vec3 vN; varying vec3 vV; varying vec3 vW;
void main(){
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float shown = smoothstep(uScan - 0.02, uScan + 0.02, vW.y);
  float band = exp(-pow((vW.y - uScan) / 0.025, 2.0));
  vec3 c = vec3(0.62, 0.82, 1.0) * (0.1 + 0.62 * pow(f, 1.4)) * (0.2 + 0.8 * shown) + vec3(0.8, 0.95, 1.0) * band * 0.7;
  gl_FragColor = vec4(c * uI, 1.0);
}`;

// ---------------------------------------------------------------- sim
runSim(DEFAULTS, async ({cfg, canvas, hud, capture}) => {
  await Promise.all([
    document.fonts.load('900 40px Inter'),
    document.fonts.load('800 40px Inter'),
    document.fonts.load('700 40px Inter'),
    document.fonts.load('700 20px "JetBrains Mono"'),
  ]).catch(() => {});
  const st = createStage(canvas, hud, {bg: '#020308', capture, fov: 74, exposure: 1.0, bloom: {strength: 0.55, radius: 0.5, threshold: 0.9}});
  const {scene, camera, renderer} = st;
  camera.near = 0.05;
  camera.far = 3000;
  const R = rng(cfg.seed);
  const add = (o, parent = scene) => (parent.add(o), o);
  const mesh = (geo, mat, x = 0, y = 0, z = 0, o = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    (o.parent ?? scene).add(m);
    return m;
  };
  const glowTex = canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
  });
  const puffTex = canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,0.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
  });

  // ---- night sky, lit by the bursts
  const skyU = {uBD: {value: [...Array(6)].map(() => V(0, 1, 0))}, uBC: {value: [...Array(6)].map(() => V())}, uHalo: {value: 1}};
  const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(2200, 48, 24),
    new THREE.ShaderMaterial({uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false}),
  );
  skyDome.renderOrder = -1;
  scene.add(skyDome);
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const eu = {uBD: skyU.uBD, uBC: {value: [...Array(6)].map(() => V())}, uHalo: {value: 0}};
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({uniforms: eu, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide})));
    for (const [x, y, z, r] of [[30, 6, -40, 9], [-40, 5, 20, 8], [10, 10, 50, 7], [-20, 30, -60, 10]]) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({color: new THREE.Color(1.1, 0.72, 0.4)}));
      b.position.set(x, y, z);
      envScene.add(b);
    }
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    scene.environmentIntensity = 0.4;
  }
  scene.fog = new THREE.Fog('#05060c', 90, 520);
  const hemi = new THREE.HemisphereLight('#36406a', '#1a120c', 0.3);
  scene.add(hemi);
  const hemiSky = new THREE.Color('#36406a');
  // the bursts light the street from the north
  const fwL = new THREE.DirectionalLight('#ffffff', 0);
  fwL.target.position.set(-3, 0, -10);
  scene.add(fwL, fwL.target);
  const warm = (x, y, z, i, d, c = '#ffb46b') => {
    const l = new THREE.PointLight(c, i, d, 2);
    l.position.set(x, y, z);
    scene.add(l);
    return l;
  };
  warm(-3.2, 5.1, -20, 16, 24);
  warm(3.2, 5.1, -24, 16, 24);
  warm(-7.6, 2.6, 1.4, 2.6, 8, '#ffbf78');
  warm(-7.4, 2.6, -4.6, 2.6, 8, '#ffbf78');
  warm(8.2, 2.4, -8, 3.5, 10, '#ffcf94');

  // ---- ground
  const asphaltT = asphaltTex();
  const paversT = paversTex();
  const tiled = (tex, rx, ry, rough) => {
    const t = tex.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    return std('#ffffff', rough, 0, {map: t});
  };
  mesh(new THREE.PlaneGeometry(8, 240), tiled(asphaltT, 2, 60, 0.75), 0, 0, -60).rotation.x = -Math.PI / 2;
  mesh(new THREE.PlaneGeometry(240, 6), tiled(asphaltT, 60, 1.5, 0.75), 0, 0.001, -39.5).rotation.x = -Math.PI / 2;
  for (const s of [-1, 1]) {
    mesh(new THREE.BoxGeometry(6, SW, 74), tiled(paversT, 4, 49, 0.8), s * 7, SW / 2, 3);
    mesh(new THREE.BoxGeometry(0.18, SW + 0.02, 74), std('#b9b4aa', 0.8), s * 4.05, SW / 2, 3);
    mesh(new THREE.BoxGeometry(110, SW, 2.5), tiled(paversT, 73, 1.6, 0.8), s * 59, SW / 2, -35.25);
  }
  mesh(new THREE.BoxGeometry(240, SW, 1.7), tiled(paversT, 160, 1.1, 0.8), 0, SW / 2, -43.3);
  const paint = std('#e9e5da', 0.7);
  for (let z = 30; z > -34; z -= 6) mesh(new THREE.PlaneGeometry(0.14, 3), paint, 0, 0.004, z).rotation.x = -Math.PI / 2;
  for (let x = -3.4; x <= 3.4; x += 0.8) mesh(new THREE.PlaneGeometry(0.45, 3.2), paint, x, 0.004, -32.2).rotation.x = -Math.PI / 2;

  // ---- buildings: shop windows and some rooms lit
  const facadeMats = [];
  const building = (side, z0, z1, h, o) => {
    const w = z1 - z0, d = 14;
    let pos, faceIdx;
    if (side === 0 || side === 2) {
      const zf = side === 0 ? -44 - d / 2 - 0.15 : 50 + d / 2;
      pos = [(z0 + z1) / 2, h / 2, zf];
      faceIdx = side === 0 ? 4 : 5;
    } else {
      pos = [side * (10 + d / 2), h / 2, (z0 + z1) / 2];
      faceIdx = side < 0 ? 0 : 1;
    }
    const tex = facadeTex(w, h, o, R);
    const face = std('#ffffff', 0.88, 0, {map: tex.map, emissive: '#ffffff', emissiveMap: tex.em, emissiveIntensity: 0.34, envMapIntensity: 0.5});
    facadeMats.push(face);
    const plain = std(o.base, 0.9);
    const mats = [plain, plain, std('#5d5853', 0.9), plain, plain, plain];
    mats[faceIdx] = face;
    const geo = side === 0 || side === 2 ? new THREE.BoxGeometry(w, h, d) : new THREE.BoxGeometry(d, h, w);
    mesh(geo, mats, ...pos);
  };
  building(-1, -34, -24, 13, {base: '#d9cbb1', trim: '#efe6d4', text: 'PHARMACY', sign: '#2c5a4f'});
  building(-1, -24, -12, 19, {base: '#9d5b45', trim: '#d8c8b4', brick: true, text: 'BOOKS & PAPER', sign: '#263a52'});
  building(-1, -12, 6, 14, {base: '#d4b48a', trim: '#e8dcc6', text: 'CAFÉ 34', sign: '#1f4a3c'});
  building(-1, 6, 20, 17, {base: '#b8b2a6', trim: '#e2ddd2', text: 'HARDWARE', sign: '#3b3f46'});
  building(-1, 20, 44, 15, {base: '#cdb79a', trim: '#ece2d0', text: 'LAUNDRY', sign: '#4a3a5c'});
  building(1, -34, -18, 16, {base: '#a86450', trim: '#e0d0bc', brick: true, text: 'NOODLES', sign: '#2e3a4c'});
  building(1, -18, -2, 24, {base: '#8f8a82', trim: '#c9ccd0', text: 'FLOWERS', sign: '#3c5a2e', sp: 2.2});
  building(1, -2, 12, 13, {base: '#d9c5a3', trim: '#e9dcc4', text: 'BAKERY', sign: '#6a4a2a'});
  building(1, 12, 28, 18, {base: '#8f9aa3', trim: '#dfe3e6', text: 'BIKES', sign: '#22323d'});
  building(1, 28, 46, 14, {base: '#d8c3a5', trim: '#f0e6d6', text: 'DELI', sign: '#5a2f2f'});
  building(0, -60, -14, 12, {base: '#c7b29a', trim: '#ece2d2', text: 'MARKET HALL', sign: '#2b4a3f'});
  building(0, -14, 12, 14, {base: '#7d858f', trim: '#cfd4da', text: 'OFFICES', sign: '#20262e'});
  building(0, 12, 60, 12, {base: '#b98f72', trim: '#ead9c6', brick: true, text: 'HOTEL', sign: '#3a2d4a'});
  building(2, -40, -4, 18, {base: '#c2a88c', trim: '#ebdfcf', text: 'CINEMA', sign: '#4a2030'});
  building(2, 4, 40, 16, {base: '#a9a49b', trim: '#dedad2', text: 'GROCER', sign: '#2f4a2a'});
  // beyond the north row: the bay, where the show is

  // ---- festival screen on the north row (invented)
  const billTex = canvasTex(1500, 840, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#0b1438');
    bg.addColorStop(1, '#241046');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const RB = rng(4);
    const burst = (cx, cy, r, c) => {
      for (let k = 0; k < 46; k++) {
        const a = (k / 46) * Math.PI * 2;
        for (let j = 0; j < 5; j++) {
          const rr = r * (0.35 + j * 0.16);
          g.fillStyle = c;
          g.globalAlpha = 0.25 + j * 0.15;
          g.beginPath();
          g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 3 + j, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.globalAlpha = 1;
      void RB;
    };
    void burst;
    g.fillStyle = '#ffd36a';
    for (const [x, y, r] of [[1180, 260, 60], [1330, 520, 44], [1020, 600, 34]]) {
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2, rr = k % 2 ? r * 0.42 : r;
        g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.fill();
    }
    g.fillStyle = '#ffffff';
    g.font = '900 150px Inter';
    g.fillText('HARBOUR', 80, 270);
    g.fillText('LIGHTS', 80, 420);
    g.fillStyle = '#ff4d6d';
    g.fillRect(84, 490, 640, 96);
    g.fillStyle = '#ffffff';
    g.font = '800 58px Inter';
    g.fillText('fireworks tonight', 112, 557);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.font = '700 44px "JetBrains Mono"';
    g.fillText('21:30 · over the bay', 86, 700);
  });
  const billMat = new THREE.ShaderMaterial({uniforms: {uMap: {value: billTex}, uGain: {value: 0.85}}, vertexShader: BILL_VERT, fragmentShader: BILL_FRAG});
  mesh(new RoundedBoxGeometry(BILL.w + 0.6, BILL.h + 0.6, 0.5, 2, 0.12), std('#1c1f24', 0.5, 0.6), BILL.x, BILL.y, BILL.z - 0.1);
  mesh(new THREE.PlaneGeometry(BILL.w, BILL.h), billMat, BILL.x, BILL.y, BILL.z + 0.16);

  // ---- street furniture
  const metalDark = std('#2e3236', 0.5, 0.6);
  const lampHead = std('#fff1d6', 0.4, 0, {emissive: '#ffd9a0', emissiveIntensity: 6});
  const lamp = (x, z) => {
    mesh(new THREE.CylinderGeometry(0.07, 0.1, 5.6, 8), metalDark, x, 2.8 + SW, z);
    const arm = mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.3, 6), metalDark, x - Math.sign(x) * 0.6, 5.5, z);
    arm.rotation.z = Math.PI / 2;
    mesh(new RoundedBoxGeometry(0.5, 0.16, 0.28, 2, 0.05), metalDark, x - Math.sign(x) * 1.2, 5.45, z);
    mesh(new THREE.BoxGeometry(0.4, 0.03, 0.2), lampHead, x - Math.sign(x) * 1.2, 5.36, z);
  };
  lamp(-4.4, -20);
  lamp(4.4, -24);
  lamp(4.4, 14);
  lamp(-4.4, 16);
  for (const x of [-4.6, 4.6]) {
    mesh(new THREE.CylinderGeometry(0.07, 0.08, 3.4, 8), metalDark, x, 1.7 + SW, -34.2);
    mesh(new RoundedBoxGeometry(0.34, 0.95, 0.28, 2, 0.05), std('#1e2124', 0.6, 0.3), x, 3.8, -34.2);
    for (const [k, c, e] of [[0, '#ff3020', 3.0], [1, '#3a3010', 0.0], [2, '#163a22', 0.0]]) mesh(new THREE.CircleGeometry(0.1, 14), std(c, 0.3, 0, {emissive: c, emissiveIntensity: e}), x, 4.1 - k * 0.3, -34.055);
  }
  const trees = [];
  for (const [x, z] of [[-4.9, -30], [-4.9, 14], [-4.9, 24], [4.9, -27], [4.9, 18], [4.9, 28], [4.9, -38.5]]) {
    const t = makeTree(R);
    t.position.set(x, SW, z);
    t.userData.ph = R() * 6;
    scene.add(t);
    trees.push(t);
  }
  // festival barriers across the closed street
  {
    const bm = std('#d8dde2', 0.5, 0.6);
    const stripe = canvasTex(256, 32, (g, w, h) => {
      for (let i = 0; i < 8; i++) {
        g.fillStyle = i % 2 ? '#ffffff' : '#d8261c';
        g.fillRect(i * 32, 0, 32, h);
      }
    });
    for (const x of [-2.8, 0, 2.8]) {
      const g = new THREE.Group();
      g.position.set(x, 0, 8);
      scene.add(g);
      for (const dx of [-1.1, 1.1]) mesh(new THREE.BoxGeometry(0.06, 1.05, 0.06), bm, dx, 0.52, 0, {parent: g});
      mesh(new THREE.BoxGeometry(2.3, 0.22, 0.04), std('#ffffff', 0.5, 0, {map: stripe}), 0, 0.92, 0, {parent: g});
    }
  }

  // ---- café terrace
  const ourTable = makeTable();
  ourTable.position.set(-7.6, SW, 0);
  scene.add(ourTable);
  const chair = (x, z, rotY) => {
    const c = makeChair(redMat());
    c.position.set(x, SW, z);
    c.rotation.y = rotY;
    scene.add(c);
    return c;
  };
  chair(-6.82, 0.0, -Math.PI / 2); // friend's
  for (const z of [-3.4, -6.8]) {
    const t = makeTable();
    t.position.set(-7.6, SW, z);
    scene.add(t);
    chair(-8.3, z, Math.PI / 2);
    chair(-6.9, z, -Math.PI / 2);
    const b = makeBottle(glassMat(), 1);
    b.position.set(-7.5, TOP, z + 0.12);
    scene.add(b);
    const gl = makeGlass(glassMat());
    gl.position.set(-7.75, TOP, z - 0.1);
    scene.add(gl);
  }
  for (const z of [-2.7, -9.4]) {
    mesh(new RoundedBoxGeometry(0.46, 0.5, 1.5, 2, 0.04), redMat(), -4.6, SW + 0.25, z);
    for (let k = 0; k < 4; k++) {
      const s = mesh(new THREE.IcosahedronGeometry(0.22 + R() * 0.1, 1), std(new THREE.Color().setHSL(0.27, 0.45, 0.26 + R() * 0.06), 0.9), -4.6, SW + 0.6, z - 0.55 + k * 0.37);
      s.scale.y = 0.8;
    }
  }
  // string lights over the terrace
  {
    const bulbM = std('#fff1d0', 0.4, 0, {emissive: '#ffc77a', emissiveIntensity: 5});
    const wireM = std('#1a1a1a', 0.7);
    for (const z of [1.7, -5.7]) {
      const a = V(-9.9, 3.05, z), b = V(-4.45, 2.85, z);
      mesh(new THREE.CylinderGeometry(0.03, 0.035, 2.85, 6), metalDark, -4.45, 1.43, z);
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const k = i / 24;
        pts.push(a.clone().lerp(b, k).add(V(0, -0.38 * 4 * k * (1 - k), 0)));
      }
      mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.006, 4, false), wireM);
      for (let i = 1; i < 13; i++) {
        const k = i / 13;
        const p = a.clone().lerp(b, k).add(V(0, -0.38 * 4 * k * (1 - k) - 0.05, 0));
        mesh(new THREE.SphereGeometry(0.034, 8, 6), bulbM, p.x, p.y, p.z);
      }
    }
  }
  // table things (ours)
  const glassA = makeGlass(glassMat());
  glassA.position.set(-7.4, TOP, -0.07);
  const glassB = makeGlass(glassMat());
  glassB.position.set(-7.86, TOP, 0.15);
  const soda = makeBottle(glassMat(), 0.85);
  soda.position.set(-7.62, TOP, -0.24);
  const bottle = makeBottle(glassMat(), 1.05);
  bottle.position.set(-7.33, TOP, -0.2);
  scene.add(glassA, glassB, soda, bottle);
  const waterA = mesh(new THREE.CylinderGeometry(0.031, 0.028, 0.07, 20), waterMat, -7.4, TOP + 0.043, -0.07);
  const waterB = mesh(new THREE.CylinderGeometry(0.033, 0.029, 0.06, 20), waterMat, -7.86, TOP + 0.035, 0.15);
  waterA.renderOrder = waterB.renderOrder = 1;
  {
    const mug = new THREE.Group();
    mug.position.set(-7.84, TOP, -0.13);
    scene.add(mug);
    const m = redMat();
    const pts = [[0, 0], [0.04, 0], [0.042, 0.005], [0.044, 0.09], [0.04, 0.09], [0.038, 0.012], [0, 0.012]].map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(pts, 24), m, 0, 0, 0, {parent: mug});
    const handle = mesh(new THREE.TorusGeometry(0.025, 0.007, 8, 14), m, 0, 0.048, -0.046, {parent: mug});
    handle.rotation.y = Math.PI / 2;
    mesh(new THREE.CircleGeometry(0.039, 20), std('#3b2416', 0.3), 0, 0.078, 0, {parent: mug}).rotation.x = -Math.PI / 2;
    mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.012, 28), std('#f4f1ea', 0.3), -7.56, TOP + 0.006, 0.2);
    const cro = mesh(new THREE.TorusGeometry(0.045, 0.022, 8, 18, Math.PI * 1.25), std('#c98a3e', 0.65), -7.56, TOP + 0.03, 0.2);
    cro.rotation.x = -Math.PI / 2;
    cro.rotation.z = 0.8;
    cro.scale.set(1, 1, 0.75);
  }
  // our phone, face up, lock screen on
  const phoneScreenTex = canvasTex(256, 520, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, '#1b1440');
    gr.addColorStop(1, '#3a1430');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.font = '600 26px Inter';
    g.fillText('Saturday', w / 2, 92);
    g.font = '800 96px Inter';
    g.fillText('21:47', w / 2, 190);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.beginPath();
    g.roundRect(18, 300, w - 36, 92, 18);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'left';
    g.font = '700 20px Inter';
    g.fillText('Harbour Lights', 34, 336);
    g.font = '500 19px Inter';
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillText('Fireworks are on now', 34, 368);
  });
  const ourPhone = new THREE.Group();
  ourPhone.position.set(-7.93, TOP + 0.005, 0.02);
  ourPhone.rotation.y = 0.25;
  scene.add(ourPhone);
  mesh(new RoundedBoxGeometry(0.155, 0.009, 0.075, 2, 0.006), std('#16181b', 0.3, 0.4), 0, 0, 0, {parent: ourPhone});
  {
    const scr = mesh(new THREE.PlaneGeometry(0.068, 0.146), new THREE.MeshBasicMaterial({map: phoneScreenTex, color: new THREE.Color(0.85, 0.85, 0.85)}), 0, 0.0047, 0, {parent: ourPhone});
    scr.rotation.order = 'YXZ';
    scr.rotation.set(-Math.PI / 2, -Math.PI / 2, 0);
  }
  const steamMat = new THREE.SpriteMaterial({map: puffTex, color: '#ffe6cc', transparent: true, opacity: 0, depthWrite: false});
  const steam = [...Array(7)].map(() => add(new THREE.Sprite(steamMat.clone())));

  // bus shelter with a lit ad
  {
    const g = new THREE.Group();
    g.position.set(7.4, SW, -9.4);
    scene.add(g);
    for (const [x, z] of [[0.65, -2], [0.65, 2], [-0.65, -2], [-0.65, 2]]) mesh(new THREE.BoxGeometry(0.07, 2.55, 0.07), metalDark, x, 1.27, z, {parent: g});
    mesh(new RoundedBoxGeometry(1.6, 0.12, 4.3, 2, 0.04), metalDark, 0, 2.6, 0, {parent: g});
    const back = mesh(new THREE.BoxGeometry(0.03, 2.0, 3.9), std('#cfe0e4', 0.05, 0, {transparent: true, opacity: 0.18, envMapIntensity: 1.4, depthWrite: false}), 0.65, 1.2, 0, {parent: g});
    back.renderOrder = 2;
    const ad = canvasTex(256, 512, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#2b6bb0');
      gr.addColorStop(1, '#5fc0d8');
      c.fillStyle = gr;
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff';
      c.font = '800 44px Inter';
      c.fillText('CITY', 24, 90);
      c.fillText('SWIM', 24, 140);
      c.font = '600 22px Inter';
      c.fillText('open air pools', 26, 180);
    });
    mesh(new THREE.BoxGeometry(0.12, 1.75, 1.0), std('#ffffff', 0.4, 0, {map: ad, emissive: '#ffffff', emissiveMap: ad, emissiveIntensity: 0.8}), 0.0, 1.15, -2.0, {parent: g});
  }
  const parked = makeCar('#9aa3ab', R);
  parked.position.set(3.0, 0, -19);
  scene.add(parked);

  // ---- the crowd on the closed street, watching the show
  const SHOW = V(30, 130, -265);
  const S = (i) => SKIN[i % SKIN.length];
  const Hc = (i) => HAIR[i % HAIR.length];
  const PEOPLE = [];
  const spots = [];
  const free = (x, z, r = 0.78) =>
    spots.every(([a, b]) => Math.hypot(a - x, b - z) > r) && Math.hypot(x - FLARE_AT.x, z - FLARE_AT.z) > 1.15 && !(x > 1.7 && x < 4.3 && z > -21.8 && z < -16.2);
  const phoneScr = new THREE.MeshBasicMaterial({color: '#202030'});
  const person = (x, z, o, kind) => {
    const P = makePerson(o);
    scene.add(P.root);
    const heading = Math.atan2(SHOW.x - x, SHOW.z - z) + (R() - 0.5) * 0.5;
    const dist = Math.hypot(SHOW.x - x, SHOW.z - z);
    const p = {P, kind, x, z, heading, pitch: Math.atan2(SHOW.y - 1.6, dist) * (0.75 + R() * 0.35), ph: R() * 6.28, turn: (R() < 0.5 ? -1 : 1) * (0.5 + R() * 0.4), r0: 0.5 + R() * 1.6, cheer: R() < 0.45, look: R()};
    p.r1 = p.r0 + 1.2 + R() * 1.4;
    if (kind === 'phone') {
      const ph = new THREE.Group();
      ph.position.set(0, 1.66 * P.h, 0.36 * P.h);
      ph.rotation.x = -0.45;
      P.root.add(ph);
      mesh(new RoundedBoxGeometry(0.075, 0.155, 0.009, 2, 0.006), std('#16181b', 0.3, 0.4), 0, 0, 0, {parent: ph});
      const scr = mesh(new THREE.PlaneGeometry(0.068, 0.146), phoneScr, 0, 0, -0.0048, {parent: ph});
      scr.rotation.y = Math.PI;
    }
    PEOPLE.push(p);
    return p;
  };
  const outfit = (i) => ({
    h: 1.55 + R() * 0.35,
    skin: S(Math.floor(R() * 7)),
    top: CLOTH[Math.floor(R() * CLOTH.length)],
    bot: ['#1f2328', '#2a2f3a', '#34405a', '#4b6fa8', '#57683a', '#6b7280'][Math.floor(R() * 6)],
    hair: ['short', 'long', 'bun', 'short', 'beanie', 'bald', 'long'][i % 7],
    hairC: Hc(Math.floor(R() * 7)),
    beanie: ['#2b5d63', '#c4231b', '#1f2328', '#c9a14a'][i % 4],
    backpack: R() < 0.2 ? '#2e5a48' : undefined,
  });
  const place = (n, x0, x1, z0, z1) => {
    for (let k = 0, tries = 0; k < n && tries < 500; tries++) {
      const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0);
      if (!free(x, z)) continue;
      spots.push([x, z]);
      person(x, z, outfit(PEOPLE.length), R() < 0.32 ? 'phone' : 'stand');
      k++;
    }
  };
  spots.push([FLARE_AT.x, FLARE_AT.z]);
  place(22, -3.6, 3.6, -37, -8.5);
  place(8, 5.0, 8.8, -31, -4);
  place(4, -6.4, -5.0, -31, -13);
  // a child next to the flare fan
  person(-2.4, -15.2, {h: 1.16, skin: S(2), top: '#c9a14a', bot: '#2f4a6d', hair: 'short', hairC: Hc(1)}, 'stand');
  // a couple walking up the east sidewalk, one down the west
  const WALKERS = [
    {o: {h: 1.74, skin: S(1), top: '#2f4a6d', bot: '#b7a48b', hair: 'short', hairC: Hc(0)}, x: 5.6, z0: 1.0, v: 1.15, dir: -1},
    {o: {h: 1.64, skin: S(5), top: '#ebe7df', bot: '#4b6fa8', hair: 'long', hairC: Hc(3), bag: '#8c6d52'}, x: 6.15, z0: 1.4, v: 1.15, dir: -1},
    {o: {h: 1.8, skin: S(3), top: '#57683a', bot: '#1f2328', hair: 'beanie', beanie: '#1f2328'}, x: -5.3, z0: -24, v: 1.25, dir: 1},
  ].map((w) => {
    const P = makePerson(w.o);
    scene.add(P.root);
    return {...w, P, ph: R() * 6};
  });

  // ---- the fan with a red road flare (strontium nitrate), on the street ahead
  const fan = makePerson({h: 1.8, skin: S(2), top: '#1f2328', bot: '#34405a', hair: 'beanie', beanie: '#c4231b'});
  scene.add(fan.root);
  fan.root.position.copy(FLARE_AT);
  fan.root.rotation.y = Math.atan2(SHOW.x - FLARE_AT.x, SHOW.z - FLARE_AT.z) + 0.3;
  const flareHand = V(0.24, 1.98 * fan.h, 0.14);
  {
    const stick = mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.36, 8), std('#8a1a14', 0.7), flareHand.x + 0.012, flareHand.y + 0.13, flareHand.z, {parent: fan.root});
    stick.rotation.z = -0.08;
    mesh(new THREE.CylinderGeometry(0.02, 0.017, 0.05, 8), std('#2a2522', 0.9), flareHand.x + 0.025, flareHand.y + 0.31, flareHand.z, {parent: fan.root});
  }
  fan.root.updateMatrixWorld(true);
  const flareHead = fan.root.localToWorld(V(flareHand.x + 0.026, flareHand.y + 0.35, flareHand.z));
  const spr = (col, op, order) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTex, color: col, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false}));
    s.position.copy(flareHead);
    s.renderOrder = order;
    scene.add(s);
    return s;
  };
  const flareGlow = spr('#ffffff', 0.7, 7);
  const flareCore = spr('#ffffff', 1, 8);
  const flareL = new THREE.PointLight('#ff2a1a', 0, 20, 2);
  flareL.position.copy(flareHead).add(V(0, 0.15, 0.25));
  scene.add(flareL);
  const FSMOKE = [...Array(34)].map((_, k) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map: puffTex, color: '#777777', transparent: true, opacity: 0, depthWrite: false}));
    s.renderOrder = 4;
    scene.add(s);
    return {s, k, dx: (R() - 0.5) * 0.6, dz: (R() - 0.5) * 0.6};
  });

  // ---- the friend across the table
  const friend = makePerson({h: 1.74, skin: '#d9a47c', top: '#7a2f3a', bot: '#2a2f3a', hair: 'short', hairC: '#2a1a12', glasses: true, seatY: 0.47, own: true});
  friend.root.position.set(-6.82, SW, 0);
  friend.root.rotation.y = -Math.PI / 2;
  scene.add(friend.root);
  const friendMeshes = [];
  friend.root.traverse((o) => o.isMesh && friendMeshes.push(o));
  const friendMats = [...new Set(friendMeshes.map((m) => m.material))].map((m) => ({m, c: m.color.clone()}));
  const xrayDark = new THREE.Color('#040c12');
  const holoMat = new THREE.ShaderMaterial({
    uniforms: {uI: {value: 0}, uScan: {value: 2}, uPush: {value: 0.004}},
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const holo = friendMeshes.map((m) => {
    const hm = new THREE.Mesh(m.geometry, holoMat);
    hm.visible = false;
    hm.renderOrder = 5;
    m.add(hm);
    return hm;
  });
  // the skeleton the x-ray shows: where 99% of the body's strontium lives
  const boneMat = new THREE.ShaderMaterial({
    uniforms: {uI: {value: 0}, uScan: {value: 2}, uPush: {value: 0}},
    vertexShader: HOLO_VERT,
    fragmentShader: BONE_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const bones = [];
  const bone = (geo, parent, p = [0, 0, 0], r = [0, 0, 0], sc = [1, 1, 1]) => {
    const m = new THREE.Mesh(geo, boneMat);
    m.position.set(...p);
    m.rotation.set(...r);
    m.scale.set(...sc);
    m.visible = false;
    m.renderOrder = 7;
    parent.add(m);
    bones.push(m);
    return m;
  };
  {
    const h = friend.h;
    const capG = (r, l) => new THREE.CapsuleGeometry(r, l, 2, 8);
    for (let s = 0; s < 2; s++) {
      bone(capG(0.021 * h, 0.38 * h), friend.thigh[s]);
      bone(capG(0.016 * h, 0.38 * h), friend.shin[s], [0.012 * h, 0, 0]);
      bone(capG(0.008 * h, 0.36 * h), friend.shin[s], [-0.022 * h, 0, 0]);
      bone(capG(0.015 * h, 0.22 * h), friend.upper[s]);
      bone(capG(0.009 * h, 0.19 * h), friend.fore[s], [0.012 * h, 0, 0]);
      bone(capG(0.008 * h, 0.19 * h), friend.fore[s], [-0.012 * h, 0, 0]);
      bone(new THREE.SphereGeometry(0.032 * h, 8, 6), friend.hand[s], [0, 0, 0], [0, 0, 0], [0.8, 1.1, 0.45]);
      bone(new RoundedBoxGeometry(0.055 * h, 0.03 * h, 0.2 * h, 1, 0.01 * h), friend.foot[s]);
      bone(capG(0.008 * h, 0.13 * h), friend.body, [(s ? -1 : 1) * 0.085 * h, 0.5 * h, 0.035 * h], [0, 0, Math.PI / 2 + (s ? -1 : 1) * 0.12]);
    }
    for (let i = 0; i < 18; i++) bone(new RoundedBoxGeometry(0.042 * h, 0.026 * h, 0.034 * h, 1, 0.006 * h), friend.body, [0, 0.015 * h + i * 0.036 * h, -0.05 * h]);
    for (let i = 0; i < 9; i++) {
      const rr = 0.112 * h * (0.8 + 0.2 * Math.sin((Math.PI * (i + 1.5)) / 10));
      bone(new THREE.TorusGeometry(rr, 0.006 * h, 4, 28), friend.body, [0, 0.235 * h + i * 0.03 * h, 0.0], [Math.PI / 2 - 0.3, 0, 0], [1.12, 0.66, 1]);
    }
    bone(new RoundedBoxGeometry(0.03 * h, 0.17 * h, 0.012 * h, 1, 0.005 * h), friend.body, [0, 0.39 * h, 0.072 * h]);
    bone(new THREE.TorusGeometry(0.085 * h, 0.022 * h, 6, 20), friend.pelvis, [0, 0, 0], [Math.PI / 2, 0, 0]);
    bone(new THREE.SphereGeometry(0.093 * h, 16, 12), friend.head, [0, 0.112 * h, 0.004 * h], [0, 0, 0], [0.9, 1.04, 1.0]);
    bone(new THREE.TorusGeometry(0.048 * h, 0.011 * h, 4, 14, Math.PI), friend.head, [0, 0.05 * h, 0.03 * h], [Math.PI / 2 + 0.25, 0, Math.PI], [1, 1.2, 1]);
  }

  // ---- fireworks over the bay, beyond the north end of the street
  const BURSTS = TL.fireworks.map(([wb, kind, col, x, y, z], bi) => {
    const K = KIND[kind];
    const RB = rng(200 + bi * 7);
    const nrm = V((RB() - 0.5) * 0.6, 0.45 + RB() * 0.35, 1).normalize(); // rings roughly face the street
    const t1 = V(1, 0, 0).cross(nrm).normalize(), t2 = nrm.clone().cross(t1);
    const stars = [];
    for (let s = 0; s < K.n; s++) {
      let u;
      if (K.ring) {
        const a = (s / K.n) * Math.PI * 2 + RB() * 0.03;
        u = t1.clone().multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));
      } else {
        const zz = RB() * 2 - 1, a = RB() * Math.PI * 2, r = Math.sqrt(1 - zz * zz);
        u = V(r * Math.cos(a), zz, r * Math.sin(a));
      }
      stars.push({u, sv: K.ring ? 0.97 + RB() * 0.06 : 0.84 + RB() * 0.2, life: K.life * (0.82 + RB() * 0.32), ph: RB() * 6.28, md: V(RB() - 0.5, RB() - 0.5, RB() - 0.5).normalize()});
    }
    const sr = !!NO_SR[col];
    return {wb, K, col, c: V(x, y, z), stars, sr, end: K.life * 1.15 + K.trail * K.tdt + 0.05, lx: x - WIND * RISE * 0.5, i0: 0, n: 0};
  });
  let NF = 0;
  for (const B of BURSTS) {
    B.i0 = NF;
    B.n = 6 + B.stars.length * (B.K.trail + (B.sr ? 1 : 0));
    NF += B.n;
  }
  const fPos = new Float32Array(NF * 3), fCol = new Float32Array(NF * 3), fSize = new Float32Array(NF);
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
  fg.setAttribute('aColor', new THREE.BufferAttribute(fCol, 3));
  fg.setAttribute('aSize', new THREE.BufferAttribute(fSize, 1));
  const pMat = new THREE.ShaderMaterial({uniforms: {uScale: {value: 1}}, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false});
  const fPts = new THREE.Points(fg, pMat);
  fPts.frustumCulled = false;
  fPts.renderOrder = 6;
  scene.add(fPts);
  // the smoke each shell leaves, lit by the bursts after it
  const SMOKE = [];
  for (const B of BURSTS) {
    for (let k = 0; k < 3; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({map: puffTex, color: '#000000', transparent: true, opacity: 0, depthWrite: false, fog: false}));
      s.renderOrder = 3;
      scene.add(s);
      SMOKE.push({s, B, off: V((R() - 0.5) * 44, (R() - 0.5) * 28, (R() - 0.5) * 20), sz: 55 + R() * 45});
    }
  }
  const _sp = V();
  const starPos = (B, s, a, out) => {
    const K = B.K;
    out.copy(B.c).addScaledVector(s.u, K.R * s.sv * (1 - Math.exp(-K.k * a)));
    out.y -= (K.g * a * a) / (2 * (1 + 0.35 * a));
    out.x += WIND * a;
    return out;
  };
  const SRC = [3.8, 0.2, 0.85]; // strontium's own crimson, for the atoms leaving
  const colOf = (B, S) => {
    const a = FCOL[B.col];
    if (!B.sr) return a;
    const b = FCOL[NO_SR[B.col]];
    return [lerp(b[0], a[0], S), lerp(b[1], a[1], S), lerp(b[2], a[2], S)];
  };
  const fw = {col: V(), dir: V(), I: 0, halos: []};
  const updateFireworks = (W) => {
    const S = 1 - goneAt(W);
    fw.col.set(0, 0, 0);
    fw.dir.set(0, 0, 0);
    fw.I = 0;
    fw.halos.length = 0;
    for (const B of BURSTS) {
      const a = W - B.wb;
      let i = B.i0;
      if (a < -RISE || a > B.end + (B.sr ? 1.0 : 0)) {
        fSize.fill(0, B.i0, B.i0 + B.n);
        continue;
      }
      const K = B.K;
      // the rising shell
      for (let j = 0; j < 6; j++, i++) {
        const ar = a + RISE - j * 0.035;
        if (ar < 0 || ar > RISE || a > 0.02) {
          fSize[i] = 0;
          continue;
        }
        const k = ar / RISE;
        fPos[i * 3] = lerp(B.lx, B.c.x, k);
        fPos[i * 3 + 1] = lerp(16, B.c.y, 1 - (1 - k) * (1 - k));
        fPos[i * 3 + 2] = B.c.z;
        const b = Math.pow(1 - j / 6, 1.5) * 0.9;
        fCol[i * 3] = 1.7 * b;
        fCol[i * 3 + 1] = 0.95 * b;
        fCol[i * 3 + 2] = 0.42 * b;
        fSize[i] = 34 * (1 - j * 0.1);
      }
      const C = colOf(B, S);
      const flash = a >= 0 && a < 0.09 ? 1 - a / 0.09 : 0;
      const a0 = -B.wb; // the star's age when strontium left
      const a5 = SL.world - B.wb; // and when it came back
      for (const s of B.stars) {
        const fade = a < 0 ? 0 : 1 - smooth((a - 0.72 * s.life) / (0.28 * s.life));
        const late = a > 0.6 * s.life ? 0.75 + 0.25 * Math.sin(s.ph * 7 + a * 41) : 1;
        for (let j = 0; j < K.trail; j++, i++) {
          const aj = a - j * K.tdt;
          if (aj < 0 || fade <= 0) {
            fSize[i] = 0;
            continue;
          }
          starPos(B, s, aj, _sp);
          fPos[i * 3] = _sp.x;
          fPos[i * 3 + 1] = _sp.y;
          fPos[i * 3 + 2] = _sp.z;
          let b = fade * late * Math.pow(1 - j / K.trail, 1.7);
          if (K.glitter) b *= 0.5 + 0.5 * Math.sin(s.ph * 13 + aj * 57 + j * 2.1);
          const wf = j === 0 ? flash : 0;
          fCol[i * 3] = (C[0] * (1 - wf) + 3.4 * wf) * b;
          fCol[i * 3 + 1] = (C[1] * (1 - wf) + 3.2 * wf) * b;
          fCol[i * 3 + 2] = (C[2] * (1 - wf) + 3.0 * wf) * b;
          fSize[i] = K.size * (j === 0 ? 1 : 0.86 - 0.035 * j);
        }
        if (!B.sr) continue;
        // strontium atoms leaving the burning stars, and coming back
        let b = 0;
        if (W >= 0 && W < 0.9 && a0 >= 0 && a0 < s.life) {
          const u = W / 0.9;
          starPos(B, s, a0, _sp).addScaledVector(s.md, 16 * easeOutCubic(u));
          b = Math.pow(1 - u, 1.4) * Math.min(1, u / 0.03);
        } else if (W > SL.world - 0.5 && W < SL.world + 0.06 && a5 >= 0 && a5 < s.life && a >= 0) {
          const k = clamp01((W - SL.world + 0.5) / 0.5);
          starPos(B, s, a, _sp).addScaledVector(s.md, 16 * (1 - k) * (1 - k));
          b = Math.pow(k, 1.3) * (1 - smooth((W - SL.world) / 0.06));
        }
        if (b > 0.002) {
          fPos[i * 3] = _sp.x;
          fPos[i * 3 + 1] = _sp.y;
          fPos[i * 3 + 2] = _sp.z;
          fCol[i * 3] = SRC[0] * b;
          fCol[i * 3 + 1] = SRC[1] * b;
          fCol[i * 3 + 2] = SRC[2] * b;
          fSize[i] = K.size * 0.95;
        } else fSize[i] = 0;
        i++;
      }
      // light: a white flash at the burst, then the colour of the stars
      if (a >= 0 && a < K.life * 1.1) {
        const I = (a < 0.1 ? 1 + 3 * (1 - a / 0.1) : 1) * (1 - smooth((a - 0.5 * K.life) / (0.6 * K.life))) * (K.n / 150);
        const wf = flash;
        const cr = C[0] * (1 - wf) + 3 * wf, cg = C[1] * (1 - wf) + 3 * wf, cb = C[2] * (1 - wf) + 3 * wf;
        fw.col.x += cr * I;
        fw.col.y += cg * I;
        fw.col.z += cb * I;
        _sp.copy(B.c).sub(EYE).normalize();
        fw.dir.addScaledVector(_sp, I);
        fw.I += I;
        fw.halos.push({I, B, c: [cr, cg, cb]});
      }
    }
    fg.attributes.position.needsUpdate = true;
    fg.attributes.aColor.needsUpdate = true;
    fg.attributes.aSize.needsUpdate = true;
    fw.halos.sort((p, q) => q.I - p.I);
    for (let k = 0; k < 6; k++) {
      const h = fw.halos[k];
      if (h) {
        skyU.uBD.value[k].copy(h.B.c).normalize();
        skyU.uBC.value[k].set(h.c[0], h.c[1], h.c[2]).multiplyScalar(h.I * 0.045);
      } else skyU.uBC.value[k].set(0, 0, 0);
    }
    // smoke
    const lit = V(fw.col.x, fw.col.y, fw.col.z).multiplyScalar(0.012);
    for (const m of SMOKE) {
      const a = W - m.B.wb;
      if (a < 0.1) {
        m.s.material.opacity = 0;
        continue;
      }
      m.s.position.copy(m.B.c).add(m.off).add(V(WIND * a * 1.3, 0.5 * a - 4, 0));
      m.s.scale.setScalar(m.sz + 7 * a);
      m.s.material.opacity = smooth((a - 0.1) / 1.0) * 0.5 * (1 - smooth((a - 8) / 4));
      m.s.material.color.setRGB(0.03 + lit.x, 0.03 + lit.y, 0.04 + lit.z);
    }
  };

  // ---- strontium atoms leaving everything near: rock and concrete (0.04%), people's bones, the flare
  scene.updateMatrixWorld(true);
  const MOTES = [];
  const mote = (p, v, dist, size, b) => MOTES.push({p, v, dist, size, b, dl: R() * 0.12});
  for (let i = 0; i < 560; i++) {
    const k = R();
    let p;
    if (k < 0.45) p = V(-9.5 + R() * 19, R() < 0.6 ? 0.02 : SW + 0.01, -42 + R() * 46);
    else if (k < 0.85) p = V((R() < 0.5 ? -1 : 1) * 9.97, R() * 14, -42 + R() * 44);
    else p = V(-30 + R() * 60, R() * 22, -44.1);
    if (p.distanceTo(EYE) < 6) continue;
    mote(p, V((R() - 0.5) * 0.4, 1, (R() - 0.5) * 0.4).normalize(), 0.5 + R() * 1.4, 3 + R() * 3, 0.85);
  }
  for (const p of [...PEOPLE, {x: FLARE_AT.x, z: FLARE_AT.z}]) {
    for (let k = 0; k < 9; k++) mote(V(p.x + (R() - 0.5) * 0.3, 0.2 + R() * 1.4, p.z + (R() - 0.5) * 0.25), V((R() - 0.5) * 0.6, 1, (R() - 0.5) * 0.6).normalize(), 0.3 + R() * 0.7, 2.4 + R() * 2, 0.9);
  }
  for (let k = 0; k < 110; k++) {
    const d = V(R() - 0.5, R() - 0.3, R() - 0.5).normalize();
    mote(flareHead.clone(), d, 0.5 + R() * 1.6, 3.5 + R() * 3, 1.3);
  }
  const NM = MOTES.length;
  const mPos = new Float32Array(NM * 3), mCol = new Float32Array(NM * 3), mSize = new Float32Array(NM);
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  mg.setAttribute('aColor', new THREE.BufferAttribute(mCol, 3));
  mg.setAttribute('aSize', new THREE.BufferAttribute(mSize, 1));
  const mPts = new THREE.Points(mg, pMat);
  mPts.frustumCulled = false;
  mPts.renderOrder = 6;
  scene.add(mPts);
  const updateMotes = (W) => {
    for (let i = 0; i < NM; i++) {
      const m = MOTES[i];
      let b = 0, k = 0;
      const u = (W - m.dl) / 0.9;
      if (u > 0 && u < 1) {
        k = easeOutCubic(u);
        b = Math.pow(1 - u, 1.4) * Math.min(1, u / 0.04);
      } else if (W > SL.world - 0.45 - m.dl && W < SL.world + 0.06) {
        const r = clamp01((W - SL.world + 0.45 + m.dl) / (0.45 + m.dl));
        k = (1 - r) * (1 - r);
        b = Math.pow(r, 1.3) * (1 - smooth((W - SL.world) / 0.06));
      }
      mPos[i * 3] = m.p.x + m.v.x * m.dist * k;
      mPos[i * 3 + 1] = m.p.y + m.v.y * m.dist * k;
      mPos[i * 3 + 2] = m.p.z + m.v.z * m.dist * k;
      mCol[i * 3] = SRC[0] * b * m.b;
      mCol[i * 3 + 1] = SRC[1] * b * m.b;
      mCol[i * 3 + 2] = SRC[2] * b * m.b;
      mSize[i] = b > 0.002 ? m.size : 0;
    }
    mg.attributes.position.needsUpdate = true;
    mg.attributes.aColor.needsUpdate = true;
    mg.attributes.aSize.needsUpdate = true;
  };
  // sparks dripping off the flare
  const NSP = 60;
  const sPos = new Float32Array(NSP * 3), sCol = new Float32Array(NSP * 3), sSize = new Float32Array(NSP);
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  sg.setAttribute('aColor', new THREE.BufferAttribute(sCol, 3));
  sg.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
  const sPts = new THREE.Points(sg, pMat);
  sPts.frustumCulled = false;
  sPts.renderOrder = 6;
  scene.add(sPts);
  const SPK = [...Array(NSP)].map(() => ({vx: (R() - 0.5) * 1.4, vy: 0.2 + R() * 1.2, vz: (R() - 0.5) * 1.4, o: R(), s: 1.2 + R() * 1.4}));

  // ---------------------------------------------------------------- overlay
  const app = document.getElementById('app');
  const ov = document.createElement('div');
  ov.className = 'se-ov';
  ov.innerHTML = `<div class="se-vig"></div>
    <canvas class="sr-panel"></canvas>
    <div class="se-title">What if all <em>strontium</em><br>disappeared for 5 seconds?</div>
    <div class="se-tile"></div>
    <div class="se-hud">
      <div class="se-speed"><svg viewBox="0 0 40 28"><path d="M4 24a16 16 0 0 1 32 0" fill="none" stroke-width="4" stroke-linecap="round"/><g class="ndl"><path d="M20 24L20 9" stroke-width="4" stroke-linecap="round"/></g><circle cx="20" cy="24" r="3.5"/></svg><b>1x</b></div>
      <div class="se-clock"><b>0.00</b><span>s</span></div>
    </div>
    <div class="se-track"><i></i>${[0, 1, 2, 3, 4, 5].map((k) => `<em style="left:${k * 20}%"><span>${k}</span></em>`).join('')}</div>
    <canvas class="se-lines"></canvas>
    <div class="se-cap"><div class="se-stamp"></div><div class="se-head"></div><div class="se-sub"></div></div>
    <div class="se-end"><b>What should<br>disappear next?</b><span>Comment an element</span></div>
    <div class="se-flash"></div>`;
  app.appendChild(ov);
  const Q = (s) => ov.querySelector(s);
  const vig = Q('.se-vig'), titleEl = Q('.se-title'), tileEl = Q('.se-tile'), hudEl = Q('.se-hud');
  const speedEl = Q('.se-speed b'), speedBox = Q('.se-speed'), needle = Q('.se-speed .ndl'), clockEl = Q('.se-clock b'), clockBox = Q('.se-clock');
  const trackEl = Q('.se-track'), trackFill = Q('.se-track i');
  const capEl = Q('.se-cap'), stampEl = Q('.se-stamp'), headEl = Q('.se-head'), subEl = Q('.se-sub');
  const endEl = Q('.se-end'), flashEl = Q('.se-flash');
  const lineCv = Q('.se-lines'), lctx = lineCv.getContext('2d');
  const panCv = Q('.sr-panel'), pctx = panCv.getContext('2d');

  // periodic-table tile, drawn once, cut into shards
  const TW = 236, TH = 262;
  const tileCv = document.createElement('canvas');
  tileCv.width = TW * 2;
  tileCv.height = TH * 2;
  {
    const g = tileCv.getContext('2d');
    g.scale(2, 2);
    const gr = g.createLinearGradient(0, 0, TW, TH);
    gr.addColorStop(0, '#ff6b81');
    gr.addColorStop(1, '#e0244b');
    g.fillStyle = gr;
    g.beginPath();
    g.roundRect(0, 0, TW, TH, 22);
    g.fill();
    g.fillStyle = '#2a0410';
    g.font = '800 34px Inter';
    g.fillText('38', 20, 46);
    g.textAlign = 'center';
    g.font = '900 120px Inter';
    g.fillText('Sr', TW / 2, 168);
    g.font = '700 30px Inter';
    g.fillText('Strontium', TW / 2, 210);
    g.font = '600 22px "JetBrains Mono"';
    g.fillText('87.62', TW / 2, 243);
  }
  const url = tileCv.toDataURL();
  const NS = 5;
  const shards = [];
  for (let r = 0; r < NS; r++) {
    for (let c = 0; c < NS; c++) {
      const d = document.createElement('i');
      const w = TW / NS, hh = TH / NS;
      Object.assign(d.style, {left: `${c * w}px`, top: `${r * hh}px`, width: `${w + 0.5}px`, height: `${hh + 0.5}px`, backgroundImage: `url(${url})`, backgroundSize: `${TW}px ${TH}px`, backgroundPosition: `${-c * w}px ${-r * hh}px`});
      tileEl.appendChild(d);
      const cx = (c + 0.5) / NS - 0.5, cy = (r + 0.5) / NS - 0.5;
      shards.push({d, vx: cx * 2600 + (R() - 0.5) * 700, vy: cy * 2000 - 900 + (R() - 0.5) * 600, rot: (R() - 0.5) * 900});
    }
  }

  // callouts pinned to things in the world
  const LBL = [
    {t0: 3.05, t1: 4.85, head: 'RED STARS · strontium salts', sub: 'their red is light from SrCl and SrOH', at: () => BURSTS[5].c.clone().add(V(0, -30, 0)), dx: -60, dy: 330},
    {t0: 5.85, t1: 7.5, head: 'ROAD FLARE · Sr(NO<sub>3</sub>)<sub>2</sub>', sub: 'still burning, minus the red', at: () => flareHead.clone().add(V(0, -0.45, 0)), dx: 70, dy: -230},
    {t0: 8.65, t1: 10.3, head: 'PURPLE STAR · Sr + Cu', sub: '<s>strontium red</s> + copper blue', at: () => BURSTS[8].c.clone().add(V(0, -38, 0)), dx: -40, dy: 300},
    {t0: 11.55, t1: 13.15, head: 'SKELETON', sub: 'holds 99% of the body\'s 0.32 g', at: () => friend.body.localToWorld(V(0, 0.38 * friend.h, 0.08)), dx: 150, dy: -200},
    {t0: 12.0, t1: 13.15, head: 'BONE MINERAL', sub: 'Sr<sup>2+</sup> sits where Ca<sup>2+</sup> would', at: () => friend.thigh[1].getWorldPosition(V()), dx: -60, dy: 160},
    {t0: 19.5, t1: 21.2, head: 'STRONTIUM IS BACK', sub: 'the stars still burning turn red', at: () => BURSTS[14].c, dx: -40, dy: 330},
  ].map((L) => {
    const el = document.createElement('div');
    el.className = 'se-lab';
    el.innerHTML = `<b>${L.head}</b><span>${L.sub}</span>`;
    ov.appendChild(el);
    return {...L, el};
  });

  let s = 1, OW = 1080, OH = 1920;
  const layoutOv = () => {
    const iw = innerWidth, ih = innerHeight;
    s = iw / ih <= 1080 / 1920 ? iw / 1080 : ih / 1920;
    OW = iw / s;
    OH = ih / s;
    ov.style.width = `${OW}px`;
    ov.style.height = `${OH}px`;
    ov.style.transform = `scale(${s})`;
    const dpr = devicePixelRatio || 1;
    for (const cv of [lineCv, panCv]) {
      cv.width = Math.round(iw * dpr);
      cv.height = Math.round(ih * dpr);
      cv.style.width = `${OW}px`;
      cv.style.height = `${OH}px`;
    }
  };
  layoutOv();
  st.resize();

  // insets: a strontium lattice clock in a lab, and the oceans
  const PX0 = 70, PX1 = 1010, PY = 540;
  let PH = 272;
  const panelBg = (g) => {
    g.fillStyle = 'rgba(6,6,12,0.82)';
    g.beginPath();
    g.roundRect(PX0, PY, PX1 - PX0, PH, 22);
    g.fill();
    g.strokeStyle = 'rgba(255,77,109,0.55)';
    g.lineWidth = 2;
    g.stroke();
  };
  const drawLab = (t, W, a) => {
    const g = pctx;
    g.globalAlpha = a;
    PH = 326;
    panelBg(g);
    PH = 272;
    const cx = PX0 + 150, cy = PY + PH / 2, r = 104;
    const rim = g.createRadialGradient(cx, cy, r - 14, cx, cy, r + 4);
    rim.addColorStop(0, '#2b2f36');
    rim.addColorStop(0.5, '#9aa1ab');
    rim.addColorStop(1, '#3a3f47');
    g.fillStyle = rim;
    g.beginPath();
    g.arc(cx, cy, r + 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#04060b';
    g.beginPath();
    g.arc(cx, cy, r - 12, 0, Math.PI * 2);
    g.fill();
    g.save();
    g.beginPath();
    g.arc(cx, cy, r - 12, 0, Math.PI * 2);
    g.clip();
    // the lattice laser stays on; it is the atoms that are gone
    const bg = g.createLinearGradient(0, cy - 10, 0, cy + 10);
    bg.addColorStop(0, 'rgba(255,40,60,0)');
    bg.addColorStop(0.5, 'rgba(255,40,60,0.45)');
    bg.addColorStop(1, 'rgba(255,40,60,0)');
    g.fillStyle = bg;
    g.fillRect(cx - r, cy - 10, 2 * r, 20);
    const S = 1 - goneAt(W);
    if (S > 0.01) {
      g.globalAlpha = a * S;
      const cl = g.createRadialGradient(cx, cy, 0, cx, cy, 40);
      cl.addColorStop(0, 'rgba(170,180,255,1)');
      cl.addColorStop(0.4, 'rgba(110,120,255,0.75)');
      cl.addColorStop(1, 'rgba(80,60,255,0)');
      g.fillStyle = cl;
      g.beginPath();
      g.ellipse(cx, cy, 40, 14, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(230,235,255,0.9)';
      for (let k = -9; k <= 9; k++) g.fillRect(cx + k * 3.6 - 0.8, cy - 6 * Math.exp(-(k * k) / 30), 1.6, 12 * Math.exp(-(k * k) / 30));
      g.globalAlpha = a;
    }
    g.restore();
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '700 22px "JetBrains Mono"';
    g.fillText('STRONTIUM LATTICE CLOCK · a lab', PX0 + 290, PY + 46);
    g.fillStyle = '#ffffff';
    g.font = '700 26px Inter';
    g.fillText('strontium ticks counted per second', PX0 + 290, PY + 92);
    g.font = '800 38px "JetBrains Mono"';
    const num = '429 228 004 229 873';
    g.fillStyle = S > 0.5 ? '#ffffff' : 'rgba(255,255,255,0.35)';
    g.fillText(num, PX0 + 290, PY + 146);
    if (S < 0.5) {
      const w = g.measureText(num).width;
      g.strokeStyle = '#ff4d6d';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(PX0 + 286, PY + 134);
      g.lineTo(PX0 + 294 + w, PY + 134);
      g.stroke();
      g.fillStyle = '#ff4d6d';
      g.font = '800 40px "JetBrains Mono"';
      g.fillText('0 · nothing to count', PX0 + 290, PY + 198);
    }
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.font = '600 22px Inter';
    g.fillText('the best drift under 1 s in the age of the universe', PX0 + 290, PY + 244);
    g.fillStyle = '#8ff0b0';
    g.font = '700 24px Inter';
    g.fillText('your phone: a 32,768 Hz quartz crystal, still ticking', PX0 + 40, PY + 300);
    g.globalAlpha = 1;
  };
  const OCEAN_MOTES = [...Array(70)].map(() => ({a: R() * Math.PI * 2, r: Math.sqrt(R()) * 0.92, d: 40 + R() * 70, s: 2 + R() * 2.5}));
  const drawOcean = (t, W, a) => {
    const g = pctx;
    g.globalAlpha = a;
    panelBg(g);
    const cx = PX0 + 150, cy = PY + PH / 2, r = 104;
    const og = g.createRadialGradient(cx - 30, cy - 30, 10, cx, cy, r);
    og.addColorStop(0, '#4f9be8');
    og.addColorStop(1, '#123a72');
    g.fillStyle = og;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    const tilt = 0.35, rot = 0.25 * W + 0.05 * t;
    const proj = (lat, lon) => {
      const x = Math.cos(lat) * Math.sin(lon), y0 = Math.sin(lat), z0 = Math.cos(lat) * Math.cos(lon);
      return [cx + r * x, cy - r * (y0 * Math.cos(tilt) - z0 * Math.sin(tilt)), z0 * Math.cos(tilt) + y0 * Math.sin(tilt)];
    };
    // rough continents as blobs
    g.fillStyle = '#4f8a4a';
    for (const [lat, lon, rr] of [[0.75, 0.3, 0.32], [0.35, 0.45, 0.28], [-0.15, 0.55, 0.3], [0.7, 2.0, 0.42], [0.4, 2.3, 0.3], [0.65, -1.7, 0.35], [-0.35, -1.0, 0.3], [-0.45, 2.4, 0.22]]) {
      const [x, y, z] = proj(lat, lon + rot);
      if (z < 0.05) continue;
      g.beginPath();
      g.ellipse(x, y, r * rr * Math.sqrt(z), r * rr * 0.8, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1.4;
    for (const lat of [-0.9, -0.45, 0, 0.45, 0.9]) {
      g.beginPath();
      let pen = false;
      for (let i = 0; i <= 48; i++) {
        const [x, y, z] = proj(lat, (i / 48) * Math.PI * 2);
        if (z < 0) {
          pen = false;
          continue;
        }
        if (pen) g.lineTo(x, y);
        else g.moveTo(x, y);
        pen = true;
      }
      g.stroke();
    }
    // strontium flying back into the sea in the last half second
    const k = clamp01((W - SL.world + 0.5) / 0.5);
    if (k > 0 && W < SL.world + 0.05) {
      for (const m of OCEAN_MOTES) {
        const rr = r * m.r + m.d * (1 - k) * (1 - k);
        g.fillStyle = `rgba(255,70,110,${(Math.pow(k, 1.2) * 0.95).toFixed(3)})`;
        g.beginPath();
        g.arc(cx + Math.cos(m.a) * rr, cy + Math.sin(m.a) * rr, m.s, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '700 22px "JetBrains Mono"';
    g.fillText('SEAWATER · 8 mg Sr per litre', PX0 + 290, PY + 46);
    g.fillStyle = '#ffffff';
    g.font = '700 26px Inter';
    g.fillText('strontium in the oceans', PX0 + 290, PY + 92);
    g.font = '800 46px "JetBrains Mono"';
    g.fillStyle = '#ff4d6d';
    g.fillText('−11 trillion t', PX0 + 290, PY + 156);
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.font = '600 22px Inter';
    g.fillText('and every rock is about 0.04% lighter', PX0 + 290, PY + 214);
    g.globalAlpha = 1;
  };

  // ---------------------------------------------------------------- camera
  const ang = {};
  for (const [k, p] of Object.entries(TARGETS)) {
    const d = V(...p).sub(EYE);
    ang[k] = {yaw: Math.atan2(-d.z, d.x), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z))};
  }
  const CK = TL.cam;
  const camAt = (t) => {
    let a = CK[0], b = CK[0], k = 0;
    if (t >= CK[CK.length - 1][0]) a = b = CK[CK.length - 1];
    else
      for (let i = 0; i < CK.length - 1; i++) {
        if (t >= CK[i][0] && t < CK[i + 1][0]) {
          a = CK[i];
          b = CK[i + 1];
          k = (t - a[0]) / (b[0] - a[0]);
          break;
        }
      }
    const e = easeInOutCubic(k);
    const A = ang[a[1]], B = ang[b[1]];
    return {yaw: A.yaw + wrapA(B.yaw - A.yaw) * e, pitch: lerp(A.pitch, B.pitch, e), fov: lerp(a[2], b[2], e)};
  };
  const fmtSpeed = (v) => (v > 0.985 ? '1x' : `${v.toFixed(1)}x`);
  const capAt = (t) => TL.captions.find((c) => t >= c.at - 0.3 && t < c.until + 0.3);
  const groundAt = (x) => (Math.abs(x) > 4.05 ? SW : 0);

  // ---------------------------------------------------------------- state
  const _hl = [V(), V()];
  return {
    resize() {
      st.resize();
      layoutOv();
    },
    render(t) {
      const W = worldAt(t);
      const spd = speedAt(t);
      const Sr = 1 - goneAt(W);

      // ---- camera: POV head, seated
      const c = camAt(t);
      const slam = t >= T0 ? Math.exp(-(t - T0) / 0.35) : 0;
      const ret = t >= T1 ? Math.exp(-(t - T1) / 0.3) : 0;
      const jit = 0.012 * slam + 0.008 * ret;
      const yaw = c.yaw + 0.006 * Math.sin(t * 0.7) + jit * Math.sin(t * 61);
      const pit = c.pitch + 0.004 * Math.sin(t * 1.3 + 1) + jit * Math.sin(t * 47 + 2);
      const lean = clamp01((-pit - 0.25) / 0.3);
      camera.position.set(EYE.x + 0.13 * lean, EYE.y + 0.004 * Math.sin(t * 1.7) - 0.05 * lean, EYE.z);
      const dir = V(Math.cos(pit) * Math.cos(yaw), Math.sin(pit), -Math.cos(pit) * Math.sin(yaw));
      camera.lookAt(camera.position.clone().add(dir));
      camera.fov = c.fov - 6 * slam * (t - T0 < 0.08 ? (t - T0) / 0.08 : 1) - 4 * ret;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // ---- fireworks and the light they throw
      updateFireworks(W);
      if (fw.I > 0.001) {
        const m = Math.max(fw.col.x, fw.col.y, fw.col.z);
        fwL.color.setRGB(fw.col.x / m, fw.col.y / m, fw.col.z / m);
        fwL.position.copy(fwL.target.position).addScaledVector(fw.dir.normalize(), 100);
      }
      fwL.intensity = 0.2 * fw.I;
      hemi.color.copy(hemiSky).lerp(fwL.color, clamp01(0.2 * fw.I));

      // ---- the flare: red with strontium, orange without
      const fc = [lerp(2.0, 3.4, Sr), lerp(1.08, 0.38, Sr), lerp(0.34, 0.22, Sr)];
      const fl = 1 + 0.08 * Math.sin(W * 37) + 0.06 * Math.sin(W * 61 + 1) + 0.04 * Math.sin(W * 13.7);
      flareCore.material.color.setRGB(fc[0] * 2.4 * fl + 1.2, fc[1] * 2.4 * fl + 1.0, fc[2] * 2.4 * fl + 0.8);
      flareCore.scale.setScalar(0.42 * fl);
      flareGlow.material.color.setRGB(fc[0] * fl, fc[1] * fl, fc[2] * fl);
      flareGlow.scale.setScalar(3.4 * fl);
      {
        const m = Math.max(...fc);
        flareL.color.setRGB(fc[0] / m, fc[1] / m, fc[2] / m);
        flareL.intensity = 6 * fl * lerp(0.8, 1, Sr);
      }
      FSMOKE.forEach((p) => {
        const u = (((W * 0.42 + p.k / FSMOKE.length) % 1) + 1) % 1;
        const age = u * 2.4;
        p.s.position.set(flareHead.x + p.dx * age * 0.6 + WIND * 0.45 * age, flareHead.y + 0.12 + 0.85 * age, flareHead.z + p.dz * age * 0.6);
        p.s.scale.setScalar(0.22 + 0.9 * age);
        p.s.material.opacity = 0.4 * Math.sin(Math.PI * u) * (1 - u * 0.3);
        const k = 0.2 * Math.exp(-age * 0.7);
        p.s.material.color.setRGB(0.16 + fc[0] * k, 0.16 + fc[1] * k, 0.17 + fc[2] * k);
      });
      SPK.forEach((s, i) => {
        const u = (((W * 2.2 + s.o) % 1) + 1) % 1;
        const age = u * 0.5;
        sPos[i * 3] = flareHead.x + s.vx * age;
        sPos[i * 3 + 1] = flareHead.y + s.vy * age - 4.9 * age * age;
        sPos[i * 3 + 2] = flareHead.z + s.vz * age;
        const b = (1 - u) * 1.2;
        sCol[i * 3] = (fc[0] * 0.8 + 0.5) * b;
        sCol[i * 3 + 1] = (fc[1] * 0.8 + 0.3) * b;
        sCol[i * 3 + 2] = (fc[2] * 0.8 + 0.1) * b;
        sSize[i] = s.s;
      });
      sg.attributes.position.needsUpdate = true;
      sg.attributes.aColor.needsUpdate = true;
      sg.attributes.aSize.needsUpdate = true;

      // ---- the crowd
      const scrK = 0.05;
      phoneScr.color.setRGB(Math.min(1, 0.1 + scrK * fw.col.x), Math.min(1, 0.1 + scrK * fw.col.y), Math.min(1, 0.13 + scrK * fw.col.z));
      for (const p of PEOPLE) {
        const h = p.P.h;
        p.P.root.position.set(p.x, groundAt(p.x), p.z);
        p.P.root.rotation.y = p.heading;
        const turn = smooth((W - p.r0) / 0.5) * (1 - smooth((W - p.r1) / 0.6));
        const cheer = p.cheer && p.kind !== 'phone' ? smooth((W - 5.25 - p.look * 0.5) / 0.35) : 0;
        const st2 = {mode: 'walk', phase: 0, amp: 0, lean: 0.02, twist: 0.12 * p.turn * turn, headYaw: p.turn * turn + 0.04 * Math.sin(W * 0.8 + p.ph), headPitch: p.pitch * (1 - 0.7 * turn) + 0.02 * Math.sin(W * 0.6 + p.ph), hand: null};
        if (p.kind === 'phone') {
          st2.hand = [_hl[0].set(0.045 * h, 1.6 * h, 0.34 * h), _hl[1].set(-0.045 * h, 1.6 * h, 0.33 * h)];
          st2.headPitch = 0.05 + 0.3 * p.look - 0.1 * turn;
        } else if (cheer > 0.01) {
          st2.hand = [_hl[0].set(0.21 * h, lerp(0.92, 2.05, cheer) * h, 0.12 * h), _hl[1].set(-0.21 * h, lerp(0.92, 2.0, cheer) * h, 0.12 * h)];
        }
        posePerson(p.P, st2);
      }
      for (const w of WALKERS) {
        const z = w.z0 + w.dir * w.v * W;
        w.P.root.position.set(w.x, groundAt(w.x), z);
        w.P.root.rotation.y = w.dir > 0 ? 0 : Math.PI;
        posePerson(w.P, {mode: 'walk', phase: w.ph + ((2 * Math.PI * w.v) / (1.4 * w.P.h)) * W, amp: 1, lean: 0.06, twist: 0, headYaw: 0.05 * Math.sin(W), headPitch: 0.25, hand: null});
      }
      posePerson(fan, {mode: 'walk', phase: 0, amp: 0, lean: 0.0, twist: 0, headYaw: -0.1, headPitch: 0.42 + 0.02 * Math.sin(W), hand: [flareHand, null]});

      // ---- the friend: watches the show, turns to you once it's back; x-ray
      {
        const back = smooth((W - 5.6) / 0.5) * (1 - smooth((W - 7.6) / 0.6));
        const lh = friend.root.worldToLocal(V(-7.28, TOP + 0.03, 0.17));
        const rh = friend.root.worldToLocal(V(-7.36, TOP + 0.04, -0.14));
        posePerson(friend, {mode: 'sit', phase: 0, amp: 0, lean: 0.1, twist: lerp(-0.22, 0, back), headYaw: lerp(-1.3, 0.05, back) + 0.04 * Math.sin(W * 0.7), headPitch: lerp(0.34, 0.02, back), hand: [lh, rh], shrug: 0.6 * back * (1 - smooth((W - 6.9) / 0.4))});
        const H = TL.holo;
        const hi = smooth((t - H.in) / 0.4) * (1 - smooth((t - H.out) / 0.25));
        const scan = lerp(SW + 1.5, SW - 0.05, clamp01((t - H.scan) / (H.scanEnd - H.scan)));
        holoMat.uniforms.uI.value = hi;
        holoMat.uniforms.uScan.value = scan;
        boneMat.uniforms.uI.value = hi;
        boneMat.uniforms.uScan.value = scan;
        holo.forEach((m) => (m.visible = hi > 0.01));
        bones.forEach((m) => (m.visible = hi > 0.01));
        friendMats.forEach(({m, c: c0}) => m.color.copy(c0).lerp(xrayDark, 0.9 * hi));
      }
      steam.forEach((sp, i) => {
        const u = (((W * 0.35 + i / steam.length) % 1) + 1) % 1;
        sp.position.set(-7.84 + 0.02 * Math.sin(u * 7 + i), TOP + 0.1 + u * 0.22, -0.13 + 0.02 * Math.cos(u * 5 + i * 2));
        sp.scale.setScalar(0.04 + u * 0.09);
        sp.material.opacity = 0.12 * Math.sin(Math.PI * u);
      });
      trees.forEach((tr) => (tr.userData.crown.rotation.z = 0.012 * Math.sin(W * 0.9 + tr.userData.ph)));
      updateMotes(W);
      pMat.uniforms.uScale.value = 19 * (st.size.h / 1920) * (window.devicePixelRatio || 1) * (60 / camera.fov);

      st.render();

      // ---------------------------------------------------------------- overlay
      vig.style.opacity = (0.5 + 0.3 * (1 - Sr)).toFixed(3);
      const tk = smooth((t - T0 + 0.1) / 0.5);
      titleEl.style.transform = `translateY(${(-18 * tk).toFixed(1)}px) scale(${(1 - 0.18 * tk).toFixed(4)})`;
      if (t < T0) {
        const gl = smooth((t - T0 + 0.6) / 0.6);
        const j = gl * 6 * Math.sin(t * 83);
        tileEl.style.opacity = '1';
        tileEl.style.transform = `translate(${j.toFixed(1)}px, 0) scale(${(1 + 0.04 * Math.sin(t * 3)).toFixed(4)})`;
        tileEl.style.filter = gl > 0.2 ? `drop-shadow(${(-gl * 5).toFixed(1)}px 0 0 rgba(0,220,255,0.7)) drop-shadow(${(gl * 5).toFixed(1)}px 0 0 rgba(255,40,80,0.7))` : 'none';
        shards.forEach((sd) => (sd.d.style.transform = 'none'));
      } else {
        const wv = Math.max(0, W) + 0.03;
        tileEl.style.filter = 'none';
        tileEl.style.transform = 'none';
        tileEl.style.opacity = (1 - smooth((t - T0 - 0.15) / 0.45)).toFixed(3);
        shards.forEach((sd) => {
          sd.d.style.transform = `translate(${(sd.vx * wv).toFixed(1)}px, ${(sd.vy * wv).toFixed(1)}px) rotate(${(sd.rot * wv).toFixed(1)}deg)`;
        });
      }
      speedEl.textContent = fmtSpeed(spd);
      speedBox.classList.toggle('slow', spd < 0.985);
      needle.setAttribute('transform', `rotate(${(-80 + 160 * spd).toFixed(1)} 20 24)`);
      const clk = clockAt(t);
      if (t < T0) {
        clockEl.textContent = `−${(T0 - t).toFixed(2)}`;
        clockBox.className = 'se-clock pre';
      } else {
        clockEl.textContent = clk.toFixed(2);
        clockBox.className = t >= T1 ? 'se-clock done' : 'se-clock run';
      }
      const pop = t >= T0 ? 1 + 0.18 * Math.exp(-(t - T0) / 0.18) : 1;
      speedBox.style.transform = `scale(${pop.toFixed(3)})`;
      trackFill.style.width = `${((clk / SL.world) * 100).toFixed(2)}%`;
      const hudOut = smooth((t - TL.end + 0.2) / 0.4);
      hudEl.style.opacity = (1 - 0.3 * hudOut).toFixed(3);
      trackEl.style.opacity = (1 - 0.3 * hudOut).toFixed(3);
      const cp = capAt(t);
      if (cp) {
        const a = smooth((t - cp.at) / 0.22) * (1 - smooth((t - cp.until) / 0.2));
        if (capEl.dataset.k !== cp.head) {
          capEl.dataset.k = cp.head;
          headEl.textContent = cp.head.replace(/ (g|s|mg|tonnes)\b/g, ' $1');
          subEl.textContent = cp.sub;
          stampEl.textContent = `${Math.min(SL.world, Math.max(0, worldAt(cp.hit))).toFixed(2)} s`;
        }
        capEl.style.opacity = a.toFixed(3);
        capEl.style.transform = `translateY(${(26 * (1 - easeOutCubic((t - cp.at) / 0.35))).toFixed(1)}px)`;
      } else capEl.style.opacity = '0';
      const ea = smooth((t - TL.end) / 0.35);
      endEl.style.opacity = ea.toFixed(3);
      endEl.style.transform = `translateY(-50%) scale(${(0.92 + 0.08 * easeOutCubic((t - TL.end) / 0.5)).toFixed(4)})`;
      const fl2 = (t >= T0 ? 0.55 * Math.exp(-(t - T0) / 0.12) : 0) + (t >= T1 ? 0.7 * Math.exp(-(t - T1) / 0.22) : 0);
      flashEl.style.opacity = fl2.toFixed(3);

      // insets
      const dpr = lineCv.width / (OW * s);
      pctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
      pctx.clearRect(0, 0, OW, OH);
      const la = smooth((t - 13.95) / 0.35) * (1 - smooth((t - 16.1) / 0.3));
      if (la > 0.002) drawLab(t, W, la);
      const oa = smooth((t - 16.7) / 0.35) * (1 - smooth((t - 19.0) / 0.3));
      if (oa > 0.002) drawOcean(t, W, oa);

      // callouts
      lctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
      lctx.clearRect(0, 0, OW, OH);
      for (const L of LBL) {
        const a = smooth((t - L.t0) / 0.3) * (1 - smooth((t - L.t1) / 0.25));
        if (a <= 0.002) {
          L.el.style.opacity = '0';
          continue;
        }
        const p = st.project(L.at());
        if (!p.visible) {
          L.el.style.opacity = '0';
          continue;
        }
        const ax = p.x / s, ay = p.y / s;
        const w = L.el.offsetWidth, hh = L.el.offsetHeight;
        const lx = Math.min(OW - 150 - w, Math.max(54, ax + L.dx - (L.dx < 0 ? w : 0)));
        const ly = Math.min(1100 - hh / 2, Math.max(520 + hh / 2, ay + L.dy));
        L.el.style.opacity = a.toFixed(3);
        L.el.style.left = `${lx}px`;
        L.el.style.top = `${ly - hh / 2}px`;
        const ex = ax < lx ? lx : ax > lx + w ? lx + w : lx + w / 2;
        const ey = ax >= lx && ax <= lx + w ? (ay < ly ? ly - hh / 2 : ly + hh / 2) : ly;
        lctx.globalAlpha = a;
        lctx.strokeStyle = 'rgba(255,255,255,0.92)';
        lctx.lineWidth = 2.4;
        lctx.beginPath();
        lctx.moveTo(ex, ey);
        lctx.lineTo(ax, ay);
        lctx.stroke();
        lctx.fillStyle = '#ff4d6d';
        lctx.beginPath();
        lctx.arc(ax, ay, 7, 0, Math.PI * 2);
        lctx.fill();
        lctx.strokeStyle = '#fff';
        lctx.lineWidth = 2.5;
        lctx.stroke();
        lctx.globalAlpha = 1;
      }
      return {};
    },
  };
});
