import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {runSim} from '../kit/runtime.js';
import {createStage} from '../kit/stage3d.js';
import {clamp01, easeInOutCubic, easeOutCubic, lerp, rng, smooth} from '../kit/util.js';
import TL from './timeline.json';

// "What if all xenon disappeared for 5 seconds?" in the TikTok what-if
// format, from the café table of sims/selenium on an open-air cinema night.
// Xenon is 87 parts per billion of the air (2 billion tonnes), and it barely
// reacts with anything, so almost nothing notices. What does: the projector,
// whose lamp is an arc through xenon, so the film and its beam go black; the
// event photographer's flash, a spark through a xenon tube, fires nothing
// while a phone's LED flash still works; ion engines in space (probes like
// Psyche carry over a tonne of xenon) and the 10 tonnes of liquid xenon in a
// dark matter detector 1.5 km underground. Air pressure drops 0.009 Pa, the
// same as raising your head 0.7 mm. When xenon is back the lamp is struck
// again, and then, as a joke the caption owns up to, a tsunami.
//
// Two clocks: camera, overlay and the tsunami on real time t; the world
// (people, the film, flashes, the air) on world time W, the integral of the
// slow-motion speed. W = 0 when xenon vanishes, W = 5 when it is back.
// Sound: sims/xenon/sound.py on the same timeline.json.
//
// Numbers: Xe 0.087 ppmv of dry air; 1.78e20 mol of air x 8.7e-8 x 131.3 g =
// 2.0e12 kg; partial pressure 101325 Pa x 8.7e-8 = 0.0088 Pa = rho g h with
// h = 0.75 mm; LZ holds 10 t of xenon at 4,850 ft (1.48 km); Psyche launched
// with 1,085 kg.

const DEFAULTS = {
  duration: TL.duration,
  fps: TL.fps,
  theme: 'dark',
  hud: {enabled: false, title: 'xenon', subtitle: ''},
  director: {enabled: false},
  watermark: '',
  seed: 54,
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
// 1 while there is no xenon
const goneAt = (w) => smooth(w / 0.03) * (1 - smooth((w - SL.world) / 0.03));

// ---------------------------------------------------------------- layout
const SW = 0.12; // sidewalk height
const EYE = new THREE.Vector3(-8.3, SW + 1.18, 0);
const TOP = SW + 0.74; // table top
const BILL = {x: -1, y: 8.6, z: -43.8, w: 17, h: 9.2}; // the open-air cinema screen
const PROJ = new THREE.Vector3(0.6, 6.1, 19.5); // projector lens, on a tower behind you
const PHOTOG = new THREE.Vector3(-3.4, 0, -8.2); // the event photographer, shooting the audience
const TARGETS = {
  screen: [1, 11.5, -44],
  screen1: [1, 10.5, -44],
  photog: [-3.0, 1.5, -8.5],
  friend: [-6.85, SW + 1.3, 0.05],
  up: [6, 60, -30],
  down: [-7.75, TOP - 0.1, 0.0],
  screen2: [1, 10, -44],
  wave: [-1, 10, -44],
  wave2: [-1, 15, -30],
  wave3: [-3, 9, -8],
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

const XE = [0.55, 0.62, 1.9]; // xenon's own lavender, for the atoms leaving
// the photographer's xenon flash pops (world time); the one at 0.4 s finds no gas
const FLASHES = [-2.05, -1.5, -0.95, -0.4, 0.4];
const PHONE_FLASH = 0.62; // an LED: works fine
const G = 9.81;

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
// the film on the open-air screen: a sunset sea, letterboxed; dim grey when the lamp is out
const FILM_FRAG = /* glsl */ `
uniform sampler2D uMap; uniform float uGain; uniform float uT;
varying vec2 vUv;
void main(){
  vec2 uv = vUv;
  float lb = step(0.085, uv.y) * step(uv.y, 0.915);
  float sea = smoothstep(0.475, 0.455, uv.y);
  uv.x += sea * 0.003 * sin(uv.y * 170.0 + uT * 2.2);
  vec3 c = texture2D(uMap, uv).rgb;
  float gl = pow(max(0.0, sin(uv.x * 340.0 + uT * 3.0 + 6.0 * sin(uv.y * 70.0 + uT * 0.7))), 14.0);
  c += sea * vec3(1.0, 0.72, 0.42) * gl * smoothstep(0.16, 0.0, abs(uv.x - 0.64)) * 0.7;
  float vig = 1.0 - 0.3 * length((vUv - 0.5) * vec2(1.3, 1.0));
  gl_FragColor = vec4(c * lb * vig * uGain + vec3(0.03, 0.03, 0.035), 1.0);
}`;
// the projector beam through the night air
const BEAM_VERT = /* glsl */ `
attribute vec2 aB; varying vec2 vB; varying vec3 vW;
void main(){ vB = aB; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const BEAM_FRAG = /* glsl */ `
uniform float uOn; uniform float uT; uniform vec3 uCol;
varying vec2 vB; varying vec3 vW;
float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
void main(){
  float edge = smoothstep(0.0, 0.25, vB.x) * smoothstep(1.0, 0.75, vB.x);
  float along = 1.0 - 0.8 * vB.y;
  float dust = 0.45 + 0.9 * vn(vW.xz * 0.35 + vec2(uT * 0.04, 0.0)) * vn(vW.yz * 0.5 - vec2(0.0, uT * 0.03));
  vec3 c = uCol * 0.12 * along * (0.3 + 0.7 * edge) * dust;
  gl_FragColor = vec4(c * uOn, 1.0);
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
  const hemi = new THREE.HemisphereLight('#36406a', '#1a120c', 0.32);
  scene.add(hemi);
  const hemiSky = new THREE.Color('#36406a');
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
  warm(-4.2, 2.8, -5.6, 2.2, 7, '#ffcf94'); // café light on the photographer

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
  // beyond the north row: the bay


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
  // ---- the open-air cinema: a screen on the north row, a xenon-lamp projector on a tower behind you
  const filmTex = canvasTex(1600, 860, (g, w, h) => {
    const HZ = 430;
    const sky = g.createLinearGradient(0, 0, 0, HZ);
    sky.addColorStop(0, '#1e2350');
    sky.addColorStop(0.55, '#8a4a6a');
    sky.addColorStop(0.85, '#f08a52');
    sky.addColorStop(1, '#ffc27a');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, HZ);
    const sun = g.createRadialGradient(1024, 400, 10, 1024, 400, 260);
    sun.addColorStop(0, 'rgba(255,240,200,1)');
    sun.addColorStop(0.25, 'rgba(255,200,120,0.9)');
    sun.addColorStop(1, 'rgba(255,150,80,0)');
    g.fillStyle = sun;
    g.fillRect(700, 140, 650, HZ - 140);
    g.fillStyle = '#ffe9b8';
    g.beginPath();
    g.arc(1024, 410, 62, Math.PI, 0);
    g.fill();
    g.fillStyle = 'rgba(60,30,60,0.55)';
    for (const [x, y, cw, chh] of [[180, 170, 420, 22], [520, 230, 360, 16], [1180, 190, 300, 18], [1300, 260, 260, 12]]) {
      g.beginPath();
      g.ellipse(x + cw / 2, y, cw / 2, chh, 0, 0, Math.PI * 2);
      g.fill();
    }
    const sea = g.createLinearGradient(0, HZ, 0, h);
    sea.addColorStop(0, '#3a3a5c');
    sea.addColorStop(1, '#0e1424');
    g.fillStyle = sea;
    g.fillRect(0, HZ, w, h - HZ);
    g.fillStyle = 'rgba(255,190,120,0.35)';
    for (let k = 0; k < 40; k++) g.fillRect(1024 - 70 + Math.sin(k * 7) * 50, HZ + 6 + k * 9, 140 - k * 2, 2);
    // a sailboat
    g.fillStyle = '#14141e';
    g.beginPath();
    g.moveTo(420, HZ + 4);
    g.lineTo(560, HZ + 4);
    g.lineTo(540, HZ + 24);
    g.lineTo(440, HZ + 24);
    g.fill();
    g.fillRect(488, HZ - 190, 6, 194);
    g.beginPath();
    g.moveTo(496, HZ - 186);
    g.lineTo(496, HZ - 6);
    g.lineTo(580, HZ - 8);
    g.fill();
    g.beginPath();
    g.moveTo(486, HZ - 160);
    g.lineTo(486, HZ - 8);
    g.lineTo(424, HZ - 10);
    g.fill();
  });
  const filmMat = new THREE.ShaderMaterial({uniforms: {uMap: {value: filmTex}, uGain: {value: 1}, uT: {value: 0}}, vertexShader: BILL_VERT, fragmentShader: FILM_FRAG});
  mesh(new RoundedBoxGeometry(BILL.w + 0.6, BILL.h + 0.6, 0.5, 2, 0.12), std('#15171b', 0.6, 0.3), BILL.x, BILL.y, BILL.z - 0.1);
  mesh(new THREE.PlaneGeometry(BILL.w, BILL.h), filmMat, BILL.x, BILL.y, BILL.z + 0.16);
  const screenL = new THREE.PointLight('#ffc39a', 0, 70, 2);
  screenL.position.set(BILL.x, BILL.y - 1.5, BILL.z + 7);
  scene.add(screenL);
  {
    const g = new THREE.Group();
    g.position.set(PROJ.x, 0, PROJ.z + 0.6);
    scene.add(g);
    for (const [x, z] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) mesh(new THREE.BoxGeometry(0.06, 5.5, 0.06), metalDark, x, 2.75, z, {parent: g});
    for (const y of [1.4, 2.8, 4.2]) mesh(new THREE.BoxGeometry(1.7, 0.05, 1.7), metalDark, 0, y, 0, {parent: g});
    mesh(new THREE.BoxGeometry(1.9, 0.1, 1.9), std('#3a3d42', 0.7, 0.3), 0, 5.5, 0, {parent: g});
    mesh(new RoundedBoxGeometry(0.75, 0.55, 1.1, 2, 0.06), std('#202226', 0.5, 0.5), 0, 5.85, 0, {parent: g});
    const lens = mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.2, 16), std('#0b0c10', 0.2, 0.7), 0, PROJ.y - 0.0, -0.62, {parent: g});
    lens.rotation.x = Math.PI / 2;
  }
  const lensGlow = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTex, color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false}));
  lensGlow.position.copy(PROJ).add(V(0, 0, -0.75));
  lensGlow.scale.setScalar(0.9);
  scene.add(lensGlow);
  const beamMat = new THREE.ShaderMaterial({uniforms: {uOn: {value: 1}, uT: {value: 0}, uCol: {value: new THREE.Color(1, 0.8, 0.62)}}, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide});
  {
    const L = PROJ.clone().add(V(0, 0, -0.75));
    const lc = [V(-0.1, -0.06, 0), V(0.1, -0.06, 0), V(0.1, 0.06, 0), V(-0.1, 0.06, 0)].map((p) => p.add(L));
    const sc = [V(-BILL.w / 2, -BILL.h / 2, 0), V(BILL.w / 2, -BILL.h / 2, 0), V(BILL.w / 2, BILL.h / 2, 0), V(-BILL.w / 2, BILL.h / 2, 0)].map((p) => p.add(V(BILL.x, BILL.y, BILL.z + 0.2)));
    const pos = [], ab = [], idx = [];
    for (let f = 0; f < 4; f++) {
      const a = f, b = (f + 1) % 4, base = pos.length / 3;
      for (const [p, u, v] of [[lc[a], 0, 0], [lc[b], 1, 0], [sc[b], 1, 1], [sc[a], 0, 1]]) {
        pos.push(p.x, p.y, p.z);
        ab.push(u, v);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    bg.setAttribute('aB', new THREE.Float32BufferAttribute(ab, 2));
    bg.setIndex(idx);
    const beam = new THREE.Mesh(bg, beamMat);
    beam.renderOrder = 4;
    beam.frustumCulled = false;
    scene.add(beam);
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

  // ---- the crowd on the closed street, watching the film
  const SHOW = V(BILL.x, BILL.y - 1, BILL.z);
  const S = (i) => SKIN[i % SKIN.length];
  const Hc = (i) => HAIR[i % HAIR.length];
  const PEOPLE = [];
  const spots = [];
  const free = (x, z, r = 0.78) =>
    spots.every(([a, b]) => Math.hypot(a - x, b - z) > r) && Math.hypot(x - PHOTOG.x, z - PHOTOG.z) > 1.3 && Math.hypot(x - PHOTOG.x - 0.9, z - PHOTOG.z + 0.7) > 1.0 && !(x > 1.7 && x < 4.3 && z > -21.8 && z < -16.2);
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
  place(24, -3.6, 3.6, -37, -12.5);
  place(8, 5.0, 8.8, -31, -4);
  place(4, -6.4, -5.0, -31, -13);
  person(1.6, -13.4, {h: 1.16, skin: S(2), top: '#c9a14a', bot: '#2f4a6d', hair: 'short', hairC: Hc(1)}, 'stand');
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

  // ---- the event photographer (xenon speedlight) and someone with a phone (LED flash), facing the audience
  const aimAt = (x, z) => Math.atan2(-7.4 - x, 0.2 - z);
  const ph1 = makePerson({h: 1.78, skin: S(4), top: '#1f2328', bot: '#2a2f3a', hair: 'short', hairC: Hc(5), backpack: '#2a2a2a'});
  ph1.root.position.copy(PHOTOG);
  ph1.root.rotation.y = aimAt(PHOTOG.x, PHOTOG.z);
  scene.add(ph1.root);
  const camRig = new THREE.Group();
  camRig.position.set(0, 1.6 * ph1.h, 0.2 * ph1.h);
  ph1.root.add(camRig);
  const blackM = std('#141518', 0.45, 0.3);
  mesh(new RoundedBoxGeometry(0.15, 0.1, 0.08, 2, 0.015), blackM, 0, 0, 0, {parent: camRig});
  {
    const ln = mesh(new THREE.CylinderGeometry(0.036, 0.04, 0.11, 16), blackM, 0.01, -0.005, 0.09, {parent: camRig});
    ln.rotation.x = Math.PI / 2;
    mesh(new THREE.BoxGeometry(0.06, 0.055, 0.06), blackM, 0, 0.075, -0.005, {parent: camRig});
    mesh(new RoundedBoxGeometry(0.085, 0.055, 0.065, 2, 0.01), blackM, 0, 0.13, 0.005, {parent: camRig});
  }
  const flashWin = new THREE.MeshStandardMaterial({color: '#e8e6e0', roughness: 0.3, emissive: '#ffffff', emissiveIntensity: 0});
  mesh(new THREE.PlaneGeometry(0.07, 0.04), flashWin, 0, 0.13, 0.039, {parent: camRig});
  const readyLed = new THREE.MeshStandardMaterial({color: '#401010', emissive: '#ff2020', emissiveIntensity: 1.5});
  mesh(new THREE.SphereGeometry(0.004, 6, 4), readyLed, 0.03, 0.15, -0.026, {parent: camRig});
  ph1.root.updateMatrixWorld(true);
  const flashAt = camRig.localToWorld(V(0, 0.13, 0.06));
  const flashL = new THREE.PointLight('#f4f6ff', 0, 30, 2);
  flashL.position.copy(flashAt);
  scene.add(flashL);
  const flashGlare = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTex, color: '#ffffff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false}));
  flashGlare.position.copy(flashAt);
  flashGlare.renderOrder = 8;
  scene.add(flashGlare);
  const ph2At = V(PHOTOG.x + 0.9, 0, PHOTOG.z - 0.7);
  const ph2 = makePerson({h: 1.66, skin: S(0), top: '#ebe7df', bot: '#4b6fa8', hair: 'long', hairC: Hc(3), bag: '#8c6d52'});
  ph2.root.position.copy(ph2At);
  ph2.root.rotation.y = aimAt(ph2At.x, ph2At.z);
  scene.add(ph2.root);
  const phRig = new THREE.Group();
  phRig.position.set(0, 1.58 * ph2.h, 0.32 * ph2.h);
  ph2.root.add(phRig);
  mesh(new RoundedBoxGeometry(0.075, 0.155, 0.009, 2, 0.006), std('#2a2c30', 0.3, 0.5), 0, 0, 0, {parent: phRig});
  const ledM = new THREE.MeshStandardMaterial({color: '#fff6d8', emissive: '#ffffff', emissiveIntensity: 0});
  mesh(new THREE.CircleGeometry(0.006, 10), ledM, 0.022, 0.06, 0.0052, {parent: phRig});
  ph2.root.updateMatrixWorld(true);
  const ledAt = phRig.localToWorld(V(0.022, 0.06, 0.02));
  const ledL = new THREE.PointLight('#fff4e0', 0, 22, 2);
  ledL.position.copy(ledAt);
  scene.add(ledL);
  const ledGlare = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTex, color: '#ffffff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false}));
  ledGlare.position.copy(ledAt);
  ledGlare.renderOrder = 8;
  scene.add(ledGlare);

  // ---- the friend across the table
  const friend = makePerson({h: 1.74, skin: '#d9a47c', top: '#7a2f3a', bot: '#2a2f3a', hair: 'short', hairC: '#2a1a12', glasses: true, seatY: 0.47, own: true});
  friend.root.position.set(-6.82, SW, 0);
  friend.root.rotation.y = -Math.PI / 2;
  scene.add(friend.root);

  // ---- xenon atoms in the air, drawn huge and few (really 1 in 11.5 million molecules)
  const pMat = new THREE.ShaderMaterial({uniforms: {uScale: {value: 1}}, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false});
  const pointsOf = (n) => {
    const g = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), C = new Float32Array(n * 3), Z = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(C, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(Z, 1));
    const pts = new THREE.Points(g, pMat);
    pts.frustumCulled = false;
    pts.renderOrder = 6;
    scene.add(pts);
    const dirty = () => {
      g.attributes.position.needsUpdate = true;
      g.attributes.aColor.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
    };
    return {P, C, Z, dirty};
  };
  const ATOMS = [];
  for (let i = 0; i < 900; i++) {
    const p = V(-9.6 + R() * 19.2, 0.3 + Math.pow(R(), 1.4) * 13, -42 + R() * 46);
    if (p.distanceTo(EYE) < 2.2) continue;
    ATOMS.push({p, ph: R() * 6.28, f: 0.3 + R() * 0.5, s: 5 + R() * 4, d: V(R() - 0.5, R() - 0.3, R() - 0.5).normalize(), dl: R() * 0.1});
  }
  const AP = pointsOf(ATOMS.length);
  const updateAtoms = (W) => {
    for (let i = 0; i < ATOMS.length; i++) {
      const a = ATOMS[i];
      let b = 0.7 * (0.75 + 0.25 * Math.sin(W * 3 + a.ph * 3)), k = 0, sz = a.s;
      const u = (W - a.dl) / 0.45;
      if (W >= a.dl && W < SL.world) {
        // a bright pop as each atom goes, then nothing
        b = u < 1 ? (u < 0.08 ? 0.7 + 2.3 * (u / 0.08) : 3.0 * Math.pow(1 - (u - 0.08) / 0.92, 2)) : 0;
        k = easeOutCubic(Math.min(1, u));
        sz = a.s * (1 + 0.6 * Math.min(1, u));
      } else if (W >= SL.world) {
        const r = clamp01((W - SL.world) / (0.5 + a.dl));
        b = (0.7 + 2.2 * (1 - r)) * Math.pow(r, 0.7);
        k = (1 - r) * (1 - r);
      }
      b *= 1 - smooth((W - 6.2) / 1.2);
      const drift = 0.25;
      AP.P[i * 3] = a.p.x + drift * Math.sin(W * a.f + a.ph) + a.d.x * 1.4 * k;
      AP.P[i * 3 + 1] = a.p.y + drift * Math.sin(W * a.f * 1.3 + a.ph * 2) + a.d.y * 1.4 * k;
      AP.P[i * 3 + 2] = a.p.z + drift * Math.cos(W * a.f + a.ph) + a.d.z * 1.4 * k;
      AP.C[i * 3] = XE[0] * b;
      AP.C[i * 3 + 1] = XE[1] * b;
      AP.C[i * 3 + 2] = XE[2] * b;
      AP.Z[i] = b > 0.003 ? sz : 0;
    }
    AP.dirty();
  };
  // stars, seen once the screen is dark
  {
    const NS_ = 900;
    const SP_ = pointsOf(NS_);
    for (let i = 0; i < NS_; i++) {
      const u = 0.12 + R() * 0.88, a = R() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      SP_.P.set([r * Math.cos(a) * 1500, u * 1500, r * Math.sin(a) * 1500], i * 3);
      const m = Math.pow(R(), 4), b = 0.35 + 3 * m;
      SP_.C.set([b, b, b * 1.08], i * 3);
      SP_.Z[i] = 120 + 260 * m;
    }
    SP_.dirty();
  }

  // ---- the twist: a tsunami over the rooftops (fiction, and the caption says so)
  const WNX = 56, WNS = 44;
  const waveGeo = new THREE.BufferGeometry();
  const wPos = new Float32Array(WNX * WNS * 3), wS = new Float32Array(WNX * WNS);
  {
    const idx = [];
    for (let i = 0; i < WNX - 1; i++) {
      for (let j = 0; j < WNS - 1; j++) {
        const a = i * WNS + j, b = (i + 1) * WNS + j;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    waveGeo.setIndex(idx);
    for (let i = 0; i < WNX; i++) for (let j = 0; j < WNS; j++) wS[i * WNS + j] = j / (WNS - 1);
  }
  waveGeo.setAttribute('position', new THREE.BufferAttribute(wPos, 3));
  waveGeo.setAttribute('aS', new THREE.BufferAttribute(wS, 1));
  // cross-section: flood behind, crest, a curling lip, the face back down to the street
  const PROF = new THREE.CatmullRomCurve3(
    [[-60, 0.4], [-24, 0.46], [-9, 0.72], [-3.5, 0.95], [0, 1.0], [2.4, 0.93], [3.9, 0.74], [3.7, 0.55], [2.6, 0.43], [1.7, 0.33], [1.3, 0.16], [1.1, 0.0]].map(([dz, y]) => V(0, y, dz)),
    false,
    'centripetal',
  ).getSpacedPoints(WNS - 1);
  let crestJ = 0;
  PROF.forEach((P, j) => (P.y > PROF[crestJ].y ? (crestJ = j) : 0));
  // at night: lit by the street lamps and the screen from in front, foam catching the light
  const waveMat = new THREE.ShaderMaterial({
    uniforms: {uT: {value: 0}, uLight: {value: V(0.1, 0.5, 1).normalize()}, uCrest: {value: crestJ / (WNS - 1)}, uScreen: {value: 0}},
    vertexShader: /* glsl */ `
      attribute float aS; varying float vS; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main(){ vS = aS; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform float uT; uniform vec3 uLight; uniform float uCrest; uniform float uScreen;
      varying float vS; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.07 + 3.1; a *= 0.5; } return s; }
      void main(){
        vec3 n = normalize(vN); vec3 v = normalize(vV);
        if (!gl_FrontFacing) n = -n;
        float fres = pow(1.0 - abs(dot(n, v)), 3.0);
        float hgt = clamp(vW.y / 24.0, 0.0, 1.0);
        vec3 c = mix(vec3(0.006, 0.03, 0.04), vec3(0.02, 0.12, 0.14), smoothstep(0.05, 0.9, hgt));
        float k = vS - uCrest;
        float crest = smoothstep(-0.06, 0.0, k) * (1.0 - smoothstep(0.05, 0.12, k));
        c = mix(c, vec3(0.08, 0.28, 0.27), crest * 0.7);
        c += vec3(0.25, 0.3, 0.42) * fres * 0.3;
        float nn = fbm(vec2(vW.x * 0.32 + uT * 0.4, vW.y * 0.32 + vW.z * 0.2 - uT * 1.6));
        float lip = smoothstep(-0.02, 0.015, k) * (1.0 - smoothstep(0.05, 0.1, k));
        float foam = lip * smoothstep(0.35, 0.6, nn) * 1.4
                   + smoothstep(0.1, 0.2, k) * smoothstep(0.58, 0.8, nn) * 0.7
                   + (1.0 - smoothstep(-0.12, -0.04, k)) * smoothstep(0.64, 0.82, nn) * 0.5
                   + smoothstep(2.5, 0.0, vW.y) * smoothstep(0.3, 0.55, nn);
        float lit = 0.3 + 0.5 * max(dot(n, uLight), 0.0) + 0.35 * smoothstep(8.0, 0.0, vW.y);
        c = mix(c, vec3(0.42, 0.46, 0.5) * lit, clamp(foam, 0.0, 1.0));
        vec3 hv = normalize(uLight + v);
        c += vec3(1.0, 0.85, 0.62) * pow(max(dot(n, hv), 0.0), 60.0) * 0.4;
        c += vec3(1.0, 0.75, 0.55) * uScreen * 0.25 * fres;
        gl_FragColor = vec4(c * 0.5, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
  const wave = new THREE.Mesh(waveGeo, waveMat);
  wave.frustumCulled = false;
  wave.visible = false;
  scene.add(wave);
  const TW_ = TL.tsunami;
  const waveFront = (t) => lerp(TW_.z0, TW_.z1, Math.pow(clamp01((t - TW_.at) / (TW_.hit - TW_.at)), 1.35));
  const waveH = (t) => lerp(TW_.h0, TW_.h1, smooth((t - TW_.at) / (TW_.hit - TW_.at)));
  const NSPRAY = 420;
  const SPR = pointsOf(NSPRAY);
  const SPRAY = [...Array(NSPRAY)].map(() => ({x: -11 + R() * 22, ph: R(), vy: 1 + R() * 4, vz: 2 + R() * 5}));

  // ---------------------------------------------------------------- overlay
  const app = document.getElementById('app');
  const ov = document.createElement('div');
  ov.className = 'se-ov';
  ov.innerHTML = `<div class="se-vig"></div>
    <div class="bd-water"></div>
    <canvas class="sr-panel"></canvas>
    <div class="se-title">What if all <em>xenon</em><br>disappeared for 5 seconds?</div>
    <div class="se-tile"></div>
    <div class="se-hud">
      <div class="se-speed"><svg viewBox="0 0 40 28"><path d="M4 24a16 16 0 0 1 32 0" fill="none" stroke-width="4" stroke-linecap="round"/><g class="ndl"><path d="M20 24L20 9" stroke-width="4" stroke-linecap="round"/></g><circle cx="20" cy="24" r="3.5"/></svg><b>1x</b></div>
      <div class="se-clock"><b>0.00</b><span>s</span></div>
    </div>
    <div class="se-track"><i></i>${[0, 1, 2, 3, 4, 5].map((k) => `<em style="left:${k * 20}%"><span>${k}</span></em>`).join('')}</div>
    <div class="xe-air"><span>air pressure <b class="a1">1013.25000 hPa</b></span><span>xenon in the air <b class="a2">2 billion t</b></span></div>
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
  const endEl = Q('.se-end'), flashEl = Q('.se-flash'), waterEl = Q('.bd-water');
  const airEl = Q('.xe-air'), a1El = Q('.xe-air .a1'), a2El = Q('.xe-air .a2');
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
    gr.addColorStop(0, '#b9b0ff');
    gr.addColorStop(1, '#7a62f0');
    g.fillStyle = gr;
    g.beginPath();
    g.roundRect(0, 0, TW, TH, 22);
    g.fill();
    g.fillStyle = '#140a3a';
    g.font = '800 34px Inter';
    g.fillText('54', 20, 46);
    g.textAlign = 'center';
    g.font = '900 120px Inter';
    g.fillText('Xe', TW / 2, 168);
    g.font = '700 30px Inter';
    g.fillText('Xenon', TW / 2, 210);
    g.font = '600 22px "JetBrains Mono"';
    g.fillText('131.29', TW / 2, 243);
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
  let tNow = 0; // the frame time, for the callout that follows the wave
  const scr = V(BILL.x, BILL.y, BILL.z + 0.2);
  const LBL = [
    {t0: 3.0, t1: 4.85, head: 'PROJECTOR LAMP · xenon arc', sub: 'no gas, no arc, no picture', at: () => scr.clone().add(V(-2, -1.5, 0)), dx: -60, dy: 300},
    {t0: 3.4, t1: 4.85, head: 'XENON ATOMS · drawn huge', sub: 'really 1 in 11.5 million air molecules', at: () => V(4.2, 5.2, -15), dx: 40, dy: -190},
    {t0: 5.85, t1: 6.95, head: 'XENON FLASH TUBE', sub: 'a spark through xenon: nothing to light', at: () => flashAt, dx: 80, dy: -210},
    {t0: 7.0, t1: 7.55, head: 'PHONE FLASH · LED', sub: 'no xenon needed', at: () => ledAt, dx: 80, dy: -170},
    {t0: 19.55, t1: 21.2, head: 'XENON ARC LAMP', sub: 'struck again', at: () => scr.clone().add(V(-2, -1.5, 0)), dx: -60, dy: 300},
    {t0: 22.4, t1: 25.2, head: 'REAL TSUNAMI TIP', sub: 'if the sea suddenly pulls back, head for high ground', at: () => V(-1, waveH(tNow) * 0.95, waveFront(tNow)), dx: -140, dy: 260},
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
  const BUB = [...Array(70)].map(() => ({x: R() * 1080, y0: 1900 + R() * 600, r: 4 + R() * 26, v: 300 + R() * 700, w: R() * 6}));

  // insets: a strontium lattice clock in a lab, and the oceans
  const PX0 = 70, PX1 = 1010, PY = 540;
  let PH = 272;
  const panelBg = (g) => {
    g.fillStyle = 'rgba(6,6,12,0.82)';
    g.beginPath();
    g.roundRect(PX0, PY, PX1 - PX0, PH, 22);
    g.fill();
    g.strokeStyle = 'rgba(150,140,255,0.6)';
    g.lineWidth = 2;
    g.stroke();
  };
  const drawEngine = (t, W, a) => {
    const g = pctx;
    g.globalAlpha = a;
    panelBg(g);
    const cx = PX0 + 150, cy = PY + PH / 2;
    g.save();
    g.beginPath();
    g.roundRect(PX0 + 14, PY + 14, 272, PH - 28, 14);
    g.clip();
    g.fillStyle = '#02030a';
    g.fillRect(PX0 + 14, PY + 14, 272, PH - 28);
    for (let k = 0; k < 60; k++) {
      g.fillStyle = `rgba(255,255,255,${0.2 + 0.6 * ((k * 37) % 10) / 10})`;
      g.fillRect(PX0 + 20 + ((k * 97) % 260), PY + 20 + ((k * 53) % 230), 1.6, 1.6);
    }
    // the plume: blue xenon plasma, gone while there is no xenon
    const on = 1 - goneAt(W);
    if (on > 0.01) {
      const pl = g.createLinearGradient(cx + 34, 0, cx + 140, 0);
      pl.addColorStop(0, `rgba(170,190,255,${0.95 * on})`);
      pl.addColorStop(1, 'rgba(90,110,255,0)');
      g.fillStyle = pl;
      g.beginPath();
      g.moveTo(cx + 34, cy - 10);
      g.lineTo(cx + 150, cy - 30);
      g.lineTo(cx + 150, cy + 30);
      g.lineTo(cx + 34, cy + 10);
      g.fill();
    } else {
      g.strokeStyle = 'rgba(160,170,255,0.35)';
      g.setLineDash([5, 5]);
      g.beginPath();
      g.moveTo(cx + 34, cy - 10);
      g.lineTo(cx + 150, cy - 30);
      g.moveTo(cx + 34, cy + 10);
      g.lineTo(cx + 150, cy + 30);
      g.stroke();
      g.setLineDash([]);
    }
    // a probe: gold-foil body, two solar arrays
    g.fillStyle = '#c9a14a';
    g.fillRect(cx - 34, cy - 24, 64, 48);
    g.fillStyle = '#8a6a2a';
    g.fillRect(cx + 30, cy - 9, 8, 18);
    for (const s2 of [-1, 1]) {
      g.fillStyle = '#28305a';
      g.fillRect(cx - 24, cy + s2 * 30 - (s2 < 0 ? 78 : 0), 44, 78);
      g.strokeStyle = 'rgba(140,160,220,0.6)';
      g.lineWidth = 1;
      for (let k = 1; k < 5; k++) {
        const yy = cy + s2 * 30 - (s2 < 0 ? 78 : 0) + k * 15.6;
        g.beginPath();
        g.moveTo(cx - 24, yy);
        g.lineTo(cx + 20, yy);
        g.stroke();
      }
    }
    g.restore();
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '700 22px "JetBrains Mono"';
    g.fillText('XENON ION ENGINE · deep space', PX0 + 310, PY + 46);
    g.fillStyle = '#ffffff';
    g.font = '700 26px Inter';
    g.fillText('probes like Psyche carry 1,085 kg', PX0 + 310, PY + 92);
    g.font = '800 40px "JetBrains Mono"';
    g.fillStyle = on > 0.5 ? '#b9b0ff' : '#ff6b81';
    g.fillText(on > 0.5 ? 'thrusting' : 'tanks empty', PX0 + 310, PY + 150);
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.font = '600 22px Inter';
    g.fillText('the blue glow is xenon plasma', PX0 + 310, PY + 200);
    g.fillText('5 s off course is a few cm', PX0 + 310, PY + 236);
    g.globalAlpha = 1;
  };
  const drawDetector = (t, W, a) => {
    const g = pctx;
    g.globalAlpha = a;
    panelBg(g);
    const cx = PX0 + 150, top = PY + 40, bot = PY + PH - 34, rw = 82;
    // rock and the cavern
    g.fillStyle = '#2a2420';
    g.fillRect(PX0 + 14, PY + 14, 272, PH - 28);
    g.fillStyle = '#0a0b10';
    g.beginPath();
    g.roundRect(cx - rw - 16, top - 12, 2 * rw + 32, bot - top + 24, 18);
    g.fill();
    // the vessel
    g.strokeStyle = '#a9b0ba';
    g.lineWidth = 5;
    g.beginPath();
    g.roundRect(cx - rw, top, 2 * rw, bot - top, 26);
    g.stroke();
    const on = 1 - goneAt(W);
    if (on > 0.01) {
      g.globalAlpha = a * on;
      const lq = g.createLinearGradient(0, top + 30, 0, bot);
      lq.addColorStop(0, 'rgba(150,140,255,0.75)');
      lq.addColorStop(1, 'rgba(70,60,200,0.9)');
      g.fillStyle = lq;
      g.beginPath();
      g.roundRect(cx - rw + 5, top + 30, 2 * rw - 10, bot - top - 35, 20);
      g.fill();
      g.globalAlpha = a;
    }
    // photomultiplier arrays, top and bottom
    g.fillStyle = '#d8dce2';
    for (let k = -3; k <= 3; k++) {
      g.beginPath();
      g.arc(cx + k * 20, top + 14, 6, 0, Math.PI * 2);
      g.arc(cx + k * 20, bot - 14, 6, 0, Math.PI * 2);
      g.fill();
    }
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '700 22px "JetBrains Mono"';
    g.fillText('LZ DARK MATTER DETECTOR', PX0 + 310, PY + 46);
    g.fillStyle = '#ffffff';
    g.font = '700 26px Inter';
    g.fillText('1.5 km under South Dakota', PX0 + 310, PY + 92);
    g.font = '800 40px "JetBrains Mono"';
    g.fillStyle = on > 0.5 ? '#b9b0ff' : '#ff6b81';
    g.fillText(on > 0.5 ? '10 t liquid Xe' : '0 t · empty', PX0 + 310, PY + 150);
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.font = '600 22px Inter';
    g.fillText('waiting for dark matter to bump', PX0 + 310, PY + 200);
    g.fillText('into a xenon atom', PX0 + 310, PY + 232);
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
  const filmOn = (W, t) => {
    // the arc needs xenon; once it is back the lamp is struck again, with a flicker
    if (W < 0) return 1;
    if (W < SL.world + 0.35) return 0;
    const k = W - SL.world - 0.35;
    const on = k < 0.25 ? (Math.sin(k * 90) > 0.2 ? 0.6 : 0.05) : smooth((k - 0.25) / 0.2);
    // the wave takes out the screen
    const drown = t > TL.tsunami.at && waveFront(t) > BILL.z - 2 ? 0 : 1;
    return on * drown;
  };
  const flashK = (W) => {
    let b = 0;
    for (const f of FLASHES) {
      if (f >= 0 && f < SL.world) continue; // no xenon in the tube
      const d = W - f;
      if (d >= 0 && d < 0.034) b = Math.max(b, 1);
      else if (d >= 0.034 && d < 0.12) b = Math.max(b, 0.25 * (1 - (d - 0.034) / 0.086));
    }
    return b;
  };
  const shutterK = (W) => FLASHES.reduce((m, f) => Math.max(m, Math.exp(-Math.pow((W - f - 0.02) / 0.04, 2))), 0);
  const ledK = (W) => {
    const d = W - PHONE_FLASH;
    if (d < 0 || d > 0.42) return 0;
    if (d < 0.26) return 0.45 * smooth(d / 0.03); // pre-flash, metering
    return d < 0.36 ? 1 : 1 - (d - 0.36) / 0.06;
  };
  const nb = (x) => x.replace(/ (g|s|t|mm|Pa|kg|km)\b/g, ' $1');
  return {
    resize() {
      st.resize();
      layoutOv();
    },
    render(t) {
      tNow = t;
      const W = worldAt(t);
      const spd = speedAt(t);
      const gone = goneAt(W);

      // ---- camera: POV head, seated
      const c = camAt(t);
      const slam = t >= T0 ? Math.exp(-(t - T0) / 0.35) : 0;
      const ret = t >= T1 ? Math.exp(-(t - T1) / 0.3) : 0;
      const shake = t >= TL.tsunami.at ? 0.004 + 0.02 * smooth((t - TL.tsunami.at) / (TL.tsunami.hit - TL.tsunami.at)) : 0;
      const jit = 0.012 * slam + 0.008 * ret + shake;
      const yaw = c.yaw + 0.006 * Math.sin(t * 0.7) + jit * Math.sin(t * 61);
      const pit = c.pitch + 0.004 * Math.sin(t * 1.3 + 1) + jit * Math.sin(t * 47 + 2);
      const lean = clamp01((-pit - 0.25) / 0.3);
      camera.position.set(EYE.x + 0.13 * lean, EYE.y + 0.004 * Math.sin(t * 1.7) - 0.05 * lean, EYE.z);
      const dir = V(Math.cos(pit) * Math.cos(yaw), Math.sin(pit), -Math.cos(pit) * Math.sin(yaw));
      camera.lookAt(camera.position.clone().add(dir));
      camera.fov = c.fov - 6 * slam * (t - T0 < 0.08 ? (t - T0) / 0.08 : 1) - 4 * ret;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // ---- the film, the beam, the light off the screen
      const on = filmOn(W, t);
      const fl = 1 + 0.03 * Math.sin(W * 47) * Math.sin(W * 13);
      filmMat.uniforms.uGain.value = on * fl;
      filmMat.uniforms.uT.value = W;
      beamMat.uniforms.uOn.value = on * fl;
      beamMat.uniforms.uT.value = W;
      lensGlow.material.opacity = on;
      lensGlow.material.color.setRGB(3, 2.6, 2.2);
      screenL.intensity = 70 * on * fl;

      // ---- the photographer's flash (xenon) and the phone's (LED)
      const fk = flashK(W);
      flashWin.emissiveIntensity = 14 * fk;
      flashL.intensity = 160 * fk;
      flashGlare.material.opacity = fk;
      flashGlare.material.color.setRGB(3.5, 3.5, 3.8);
      flashGlare.scale.setScalar(2.6 * fk + 0.01);
      const sk = shutterK(W);
      camRig.rotation.x = -0.05 * sk;
      readyLed.emissiveIntensity = 1.2 + 2.5 * sk;
      const lk = ledK(W);
      ledM.emissiveIntensity = 10 * lk;
      ledL.intensity = 26 * lk;
      ledGlare.material.opacity = lk;
      ledGlare.material.color.setRGB(3.2, 3.1, 2.8);
      ledGlare.scale.setScalar(1.2 * lk + 0.01);

      // ---- the crowd: watching; when the screen dies, they look around
      phoneScr.color.setRGB(0.22 + 0.25 * on, 0.2 + 0.18 * on, 0.26 + 0.12 * on);
      const darkK = (w) => smooth((w - 0.15) / 0.4) * (1 - smooth((w - SL.world - 0.6) / 0.5));
      for (const p of PEOPLE) {
        const h = p.P.h;
        p.P.root.position.set(p.x, groundAt(p.x), p.z);
        p.P.root.rotation.y = p.heading;
        const turn = smooth((W - p.r0) / 0.5) * (1 - smooth((W - p.r1 - 1.2) / 0.6)) * darkK(W);
        const cheer = p.cheer && p.kind !== 'phone' ? smooth((W - SL.world - 0.7 - p.look * 0.5) / 0.35) * (1 - smooth((W - SL.world - 2.4) / 0.5)) : 0;
        const st2 = {mode: 'walk', phase: 0, amp: 0, lean: 0.02, twist: 0.12 * p.turn * turn, headYaw: p.turn * turn + 0.04 * Math.sin(W * 0.8 + p.ph), headPitch: p.pitch * (1 - 0.7 * turn) + 0.02 * Math.sin(W * 0.6 + p.ph), hand: null};
        if (p.kind === 'phone') {
          st2.hand = [_hl[0].set(0.045 * h, 1.6 * h, 0.34 * h), _hl[1].set(-0.045 * h, 1.6 * h, 0.33 * h)];
          st2.headPitch = 0.05 + 0.3 * p.look - 0.1 * turn;
        } else if (cheer > 0.01) {
          st2.hand = [_hl[0].set(0.21 * h, lerp(0.92, 2.05, cheer) * h, 0.12 * h), _hl[1].set(-0.21 * h, lerp(0.92, 2.0, cheer) * h, 0.12 * h)];
        }
        // the wave: everyone turns to it
        if (t > TL.tsunami.at) {
          const k = smooth((t - TL.tsunami.at - 0.4 - p.look * 0.6) / 0.6);
          st2.headPitch = lerp(st2.headPitch, 0.55, k);
          st2.headYaw *= 1 - k;
        }
        posePerson(p.P, st2);
      }
      for (const w of WALKERS) {
        const z = w.z0 + w.dir * w.v * W;
        w.P.root.position.set(w.x, groundAt(w.x), z);
        w.P.root.rotation.y = w.dir > 0 ? 0 : Math.PI;
        posePerson(w.P, {mode: 'walk', phase: w.ph + ((2 * Math.PI * w.v) / (1.4 * w.P.h)) * W, amp: 1, lean: 0.06, twist: 0, headYaw: 0.05 * Math.sin(W), headPitch: 0.1, hand: null});
      }
      {
        const h = ph1.h;
        posePerson(ph1, {mode: 'walk', phase: 0, amp: 0, lean: 0.03, twist: 0, headYaw: 0, headPitch: 0.02, hand: [_hl[0].set(0.075, 1.56 * h, 0.2 * h), _hl[1].set(-0.07, 1.55 * h, 0.24 * h)]});
        const h2 = ph2.h;
        posePerson(ph2, {mode: 'walk', phase: 0, amp: 0, lean: 0.02, twist: 0, headYaw: 0, headPitch: -0.05, hand: [_hl[0].set(0.04, 1.52 * h2, 0.3 * h2), _hl[1].set(-0.04, 1.52 * h2, 0.3 * h2)]});
      }

      // ---- the friend: watching, then turns to you in the dark and shrugs
      {
        const look = smooth((W - 0.55) / 0.4) * (1 - smooth((W - 2.6) / 0.5));
        const lh = friend.root.worldToLocal(V(-7.28, TOP + 0.03, 0.17));
        const rh = friend.root.worldToLocal(V(-7.36, TOP + 0.04, -0.14));
        const wave = t > TL.tsunami.at ? smooth((t - TL.tsunami.at - 0.6) / 0.5) : 0;
        posePerson(friend, {
          mode: 'sit', phase: 0, amp: 0, lean: 0.1,
          twist: lerp(-0.22, 0, look),
          headYaw: lerp(lerp(-1.25, 0.05, look), -1.2, wave) + 0.04 * Math.sin(W * 0.7),
          headPitch: lerp(lerp(0.12, 0.0, look), 0.4, wave),
          hand: [lh, rh],
          shrug: 0.8 * smooth((W - 0.95) / 0.3) * (1 - smooth((W - 2.2) / 0.4)),
        });
      }
      steam.forEach((sp, i) => {
        const u = (((W * 0.35 + i / steam.length) % 1) + 1) % 1;
        sp.position.set(-7.84 + 0.02 * Math.sin(u * 7 + i), TOP + 0.1 + u * 0.22, -0.13 + 0.02 * Math.cos(u * 5 + i * 2));
        sp.scale.setScalar(0.04 + u * 0.09);
        sp.material.opacity = 0.12 * Math.sin(Math.PI * u);
      });
      trees.forEach((tr) => (tr.userData.crown.rotation.z = 0.012 * Math.sin(W * 0.9 + tr.userData.ph)));
      updateAtoms(W);

      // ---- the tsunami (real time)
      const TS = TL.tsunami;
      wave.visible = t >= TS.at - 0.05;
      if (wave.visible) {
        const zf = waveFront(t), H = waveH(t), sc = H / 20;
        for (let i = 0; i < WNX; i++) {
          const x = -12 + (24 * i) / (WNX - 1);
          for (let j = 0; j < WNS; j++) {
            const P = PROF[j];
            const k = (i * WNS + j) * 3;
            const lip = smooth((P.y - 0.55) / 0.35);
            wPos[k] = x;
            wPos[k + 1] = P.y * H * (1 + 0.05 * Math.sin(x * 0.45 + t * 1.6)) + 0.4 * Math.sin(x * 0.9 - t * 3.1) * lip;
            wPos[k + 2] = zf + P.z * sc + 0.7 * Math.sin(x * 0.3 + t * 1.2) + 0.5 * Math.sin(x * 0.71 - t * 2.3) * (0.4 + 0.6 * lip);
          }
        }
        waveGeo.attributes.position.needsUpdate = true;
        waveGeo.computeVertexNormals();
        waveMat.uniforms.uT.value = t;
        waveMat.uniforms.uScreen.value = on;
        for (let i = 0; i < NSPRAY; i++) {
          const sp = SPRAY[i];
          const u = (((t * 0.9 + sp.ph) % 1) + 1) % 1;
          const a = u * 1.4;
          const y = 0.93 * H + sp.vy * a - 0.5 * G * a * a;
          SPR.P[i * 3] = sp.x + 0.3 * Math.sin(i);
          SPR.P[i * 3 + 1] = Math.max(0.2, y);
          SPR.P[i * 3 + 2] = zf + 2.8 * sc + sp.vz * a;
          const b = 0.3 * (1 - u) * (y > 0.2 ? 1 : 0);
          SPR.C.set([b, b, b * 1.05], i * 3);
          SPR.Z[i] = (0.9 + 1.4 * u) * Math.max(4, Math.abs(zf - EYE.z)) * 0.3;
        }
      } else SPR.Z.fill(0);
      SPR.dirty();
      pMat.uniforms.uScale.value = 19 * (st.size.h / 1920) * (window.devicePixelRatio || 1) * (60 / camera.fov);

      st.render();

      // ---------------------------------------------------------------- overlay
      vig.style.opacity = (0.5 + 0.25 * gone).toFixed(3);
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
      const hudOut = smooth((t - TL.tsunami.hit + 0.3) / 0.4);
      hudEl.style.opacity = (1 - 0.3 * hudOut).toFixed(3);
      trackEl.style.opacity = (1 - 0.3 * hudOut).toFixed(3);
      // the air readout during its beat
      const aa = smooth((t - 8.3) / 0.3) * (1 - smooth((t - 10.5) / 0.3));
      airEl.style.opacity = aa.toFixed(3);
      if (aa > 0.001) {
        a1El.textContent = gone > 0.5 ? '1013.24991 hPa' : '1013.25000 hPa';
        a2El.textContent = gone > 0.5 ? '0 t' : '2 billion t';
        airEl.classList.toggle('gone', gone > 0.5);
      }
      // under the wave
      const subK = smooth((t - TL.tsunami.hit + 0.15) / 0.3);
      waterEl.style.opacity = subK.toFixed(3);
      const cp = capAt(t);
      if (cp) {
        const a = smooth((t - cp.at) / 0.22) * (1 - smooth((t - cp.until) / 0.2));
        if (capEl.dataset.k !== cp.head) {
          capEl.dataset.k = cp.head;
          headEl.textContent = nb(cp.head);
          subEl.textContent = nb(cp.sub);
          stampEl.textContent = cp.stamp ?? `${Math.min(SL.world, Math.max(0, worldAt(cp.hit))).toFixed(2)} s`;
        }
        capEl.style.opacity = a.toFixed(3);
        capEl.style.transform = `translateY(${(26 * (1 - easeOutCubic((t - cp.at) / 0.35))).toFixed(1)}px)`;
      } else capEl.style.opacity = '0';
      const ea = smooth((t - TL.end) / 0.35);
      endEl.style.opacity = ea.toFixed(3);
      endEl.style.transform = `translateY(-50%) scale(${(0.92 + 0.08 * easeOutCubic((t - TL.end) / 0.5)).toFixed(4)})`;
      const fl2 = (t >= T0 ? 0.3 * Math.exp(-(t - T0) / 0.12) : 0) + (t >= T1 ? 0.45 * Math.exp(-(t - T1) / 0.22) : 0);
      flashEl.style.opacity = fl2.toFixed(3);

      // insets
      const dpr = lineCv.width / (OW * s);
      pctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
      pctx.clearRect(0, 0, OW, OH);
      const ia = smooth((t - 11.15) / 0.35) * (1 - smooth((t - 13.3) / 0.3));
      if (ia > 0.002) drawEngine(t, W, ia);
      const da = smooth((t - 13.95) / 0.35) * (1 - smooth((t - 16.1) / 0.3));
      if (da > 0.002) drawDetector(t, W, da);

      // callouts + bubbles
      lctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
      lctx.clearRect(0, 0, OW, OH);
      if (subK > 0.01) {
        const tt = t - TL.tsunami.hit + 0.15;
        for (const b of BUB) {
          const y = b.y0 - b.v * tt;
          if (y < -40) continue;
          lctx.globalAlpha = 0.55 * subK;
          lctx.strokeStyle = 'rgba(220,245,255,0.9)';
          lctx.lineWidth = 2;
          lctx.beginPath();
          lctx.arc(b.x + 14 * Math.sin(tt * 5 + b.w), y, b.r, 0, Math.PI * 2);
          lctx.stroke();
        }
        lctx.globalAlpha = 1;
      }
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
        lctx.fillStyle = '#9f8cff';
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
