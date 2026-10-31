import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {Sky} from 'three/addons/objects/Sky.js';
import {runSim} from '../kit/runtime.js';
import {createStage} from '../kit/stage3d.js';
import {clamp01, easeInOutCubic, easeOutCubic, lerp, rng, smooth} from '../kit/util.js';
import TL from './timeline.json';

// "What if Earth spun 2x faster for 20 seconds?" in the TikTok what-if
// format, from the café table of sims/selenium (a city at 45 degrees north,
// with the sea beyond the north end of the street). Everything spins with it
// (air, oceans, people), the only survivable reading; otherwise the air would
// hit the ground at 1,200 km/h. Centrifugal acceleration goes up 4x: you
// weigh 0.5% less, a day is 12 h, and the extra equatorward push of
// 0.051 m/s2 starts the oceans and the air sliding toward the equator. After
// 20 s the spin is back to normal but the oceans keep moving at 1 m/s, and
// where they meet a pole-facing coast they pile up into tsunamis a few metres
// high. One comes up the street.
//
// Two clocks: camera, overlay and the tsunami on real time t; the world on
// world time W, the integral of the speed curve (0.5x -> 2x). W = 0 when the
// spin doubles, W = 20 when it is back. Sound: sims/spin/sound.py.
//
// Numbers at 45 deg: dg = 3 w^2 R cos^2 = 0.051 m/s2 (0.52%, 70 -> 69.6 kg);
// horizontal push 3 w^2 R cos sin = 0.051 m/s2, 1.02 m/s after 20 s, glass
// tilt 0.30 deg; surface speed 329 m/s; spin energy 2.1e29 J, +6.4e29 J at
// 2x = 28 min of the Sun's output; the Sun moves 0.0084 deg/s; a 1 m/s current
// stopped by a coast 10-200 m deep makes a 2-9 m wave (2 u sqrt(H/g)).

const DEFAULTS = {
  duration: TL.duration,
  fps: TL.fps,
  theme: 'dark',
  hud: {enabled: false, title: 'spin', subtitle: ''},
  director: {enabled: false},
  watermark: '',
  seed: 12,
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
const G = 9.81;
const PUSH = 0.0508; // extra equatorward acceleration at 45 degrees, m/s2
const spinning = (w) => w > 0 && w < SL.world;
// current toward the equator: builds while spinning fast, then keeps going
const currentAt = (w) => PUSH * Math.min(Math.max(w, 0), SL.world);

// ---------------------------------------------------------------- layout
const SW = 0.12; // sidewalk height
const EYE = new THREE.Vector3(-8.3, SW + 1.18, 0);
const TOP = SW + 0.74; // table top
const BILL = {x: -1, y: 12.6, z: -43.8, w: 15, h: 8.4};
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const TARGETS = {
  friend: [-6.85, SW + 1.35, 0.05],
  friendBody: [-6.9, SW + 0.95, 0.02],
  shadow: [-3.2, SW + 0.2, -5.5],
  glass: [-7.4, TOP + 0.08, -0.07],
  flag: [-4.7, 3.2, 1.6],
  sky: [3, 18, -22],
  north: [-1, 5, -40],
  wave2: [-1.5, 2.6, -20],
  wave3: [-3.5, 3.2, -6],
};

const std = (color, rough = 0.8, metal = 0, extra = {}) => new THREE.MeshStandardMaterial({color, roughness: rough, metalness: metal, ...extra});
const glassMat = () => std('#e4eeec', 0.04, 0, {transparent: true, opacity: 0.2, envMapIntensity: 1.8, depthWrite: false});
const redMat = () => std('#c4231b', 0.42, 0.25, {envMapIntensity: 0.7});
const waterMat = std('#d6eef2', 0.02, 0, {transparent: true, opacity: 0.32, envMapIntensity: 1.6, depthWrite: false});

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
const STREAM_FRAG = /* glsl */ `
uniform float uW; uniform float uHead; uniform float uTail;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){
  if (vUv.y < uTail || vUv.y > uHead) discard;
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float streak = 0.5 + 0.5 * sin(vUv.y * 60.0 - uW * 30.0 + vUv.x * 6.283);
  vec3 c = mix(vec3(0.62, 0.78, 0.84), vec3(1.0), pow(f, 1.5) * 0.8 + streak * 0.15);
  gl_FragColor = vec4(c, 0.25 + 0.6 * pow(f, 1.2));
}`;
const STREAM_VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`;

// ---------------------------------------------------------------- sim
runSim(DEFAULTS, async ({cfg, canvas, hud, capture}) => {
  await Promise.all([
    document.fonts.load('900 40px Inter'),
    document.fonts.load('800 40px Inter'),
    document.fonts.load('700 40px Inter'),
    document.fonts.load('700 20px "JetBrains Mono"'),
  ]).catch(() => {});
  const st = createStage(canvas, hud, {bg: '#c9b8a6', capture, fov: 74, exposure: 0.6, bloom: {strength: 0.22, radius: 0.42, threshold: 1.6}});
  const {scene, camera, renderer} = st;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  camera.near = 0.05;
  camera.far = 3000;
  const R = rng(cfg.seed);
  const add = (o, parent = scene) => (parent.add(o), o);
  const mesh = (geo, mat, x = 0, y = 0, z = 0, o = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = o.cast ?? true;
    m.receiveShadow = o.recv ?? true;
    (o.parent ?? scene).add(m);
    return m;
  };

  // ---- sky, sun, haze
  const sky = new Sky();
  sky.scale.setScalar(2500);
  const su = sky.material.uniforms;
  su.turbidity.value = 7;
  su.rayleigh.value = 1.6;
  su.mieCoefficient.value = 0.006;
  su.mieDirectionalG.value = 0.82;
  const sunDir = V(-0.45, 0.24, 0.86).normalize();
  su.sunPosition.value.copy(sunDir);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky);
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  scene.environmentIntensity = 0.55;
  scene.add(sky);
  scene.fog = new THREE.Fog('#d4c2b4', 70, 420);
  const sun = new THREE.DirectionalLight('#ffd2a1', 2.0);
  const sunTarget = V(-2, 0, -12);
  sun.position.copy(sunTarget).addScaledVector(sunDir, 140);
  sun.target.position.copy(sunTarget);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 320});
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight('#a8bfe6', '#6b5848', 0.4));

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
  mesh(new THREE.PlaneGeometry(8, 240), tiled(asphaltT, 2, 60, 0.92), 0, 0, -60, {cast: false}).rotation.x = -Math.PI / 2;
  mesh(new THREE.PlaneGeometry(240, 6), tiled(asphaltT, 60, 1.5, 0.92), 0, 0.001, -39.5, {cast: false}).rotation.x = -Math.PI / 2;
  for (const s of [-1, 1]) {
    mesh(new THREE.BoxGeometry(6, SW, 74), tiled(paversT, 4, 49, 0.85), s * 7, SW / 2, 3, {cast: false});
    mesh(new THREE.BoxGeometry(0.18, SW + 0.02, 74), std('#b9b4aa', 0.8), s * 4.05, SW / 2, 3, {cast: false});
    mesh(new THREE.BoxGeometry(110, SW, 2.5), tiled(paversT, 73, 1.6, 0.85), s * 59, SW / 2, -35.25, {cast: false});
  }
  mesh(new THREE.BoxGeometry(240, SW, 1.7), tiled(paversT, 160, 1.1, 0.85), 0, SW / 2, -43.3, {cast: false});
  const paint = std('#e9e5da', 0.7);
  for (let z = 30; z > -34; z -= 6) mesh(new THREE.PlaneGeometry(0.14, 3), paint, 0, 0.004, z, {cast: false}).rotation.x = -Math.PI / 2;
  for (let x = -3.4; x <= 3.4; x += 0.8) mesh(new THREE.PlaneGeometry(0.45, 3.2), paint, x, 0.004, -32.2, {cast: false}).rotation.x = -Math.PI / 2;

  // ---- buildings (shop windows and some rooms glow at night)
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
    const face = std('#ffffff', 0.88, 0, {map: tex.map, emissive: '#ffffff', emissiveMap: tex.em, emissiveIntensity: 0, envMapIntensity: 0.5});
    facadeMats.push(face);
    const plain = std(o.base, 0.9);
    const mats = [plain, plain, std('#5d5853', 0.9), plain, plain, plain];
    mats[faceIdx] = face;
    const geo = side === 0 || side === 2 ? new THREE.BoxGeometry(w, h, d) : new THREE.BoxGeometry(d, h, w);
    mesh(geo, mats, ...pos, {cast: false});
  };
  building(-1, -34, -24, 13, {base: '#d9cbb1', trim: '#efe6d4', text: 'PHARMACY', sign: '#2c5a4f'});
  building(-1, -24, -12, 19, {base: '#9d5b45', trim: '#d8c8b4', brick: true, text: 'BOOKS & PAPER', sign: '#263a52'});
  building(-1, -12, 6, 14, {base: '#d4b48a', trim: '#e8dcc6', text: 'CAFÉ 34', sign: '#1f4a3c'});
  building(-1, 6, 20, 17, {base: '#b8b2a6', trim: '#e2ddd2', text: 'HARDWARE', sign: '#3b3f46'});
  building(-1, 20, 44, 15, {base: '#cdb79a', trim: '#ece2d0', text: 'LAUNDRY', sign: '#4a3a5c'});
  building(1, -34, -18, 16, {base: '#a86450', trim: '#e0d0bc', brick: true, text: 'NOODLES', sign: '#2e3a4c'});
  building(1, -18, -2, 24, {base: '#3b4048', trim: '#c9ccd0', text: 'FLOWERS', sign: '#3c5a2e', sp: 2.2});
  {
    const cigs = cigsTex();
    cigs.wrapS = cigs.wrapT = THREE.RepeatWrapping;
    cigs.repeat.set(16 / 2.4, 19 / 2.4);
    const p = mesh(new THREE.PlaneGeometry(16, 19), std('#ffffff', 0.2, 0.25, {map: cigs, envMapIntensity: 1.1}), 9.96, 14.5, -10, {cast: false});
    p.rotation.y = -Math.PI / 2;
  }
  building(1, -2, 12, 13, {base: '#d9c5a3', trim: '#e9dcc4', text: 'BAKERY', sign: '#6a4a2a'});
  building(1, 12, 28, 18, {base: '#8f9aa3', trim: '#dfe3e6', text: 'BIKES', sign: '#22323d'});
  building(1, 28, 46, 14, {base: '#d8c3a5', trim: '#f0e6d6', text: 'DELI', sign: '#5a2f2f'});
  building(0, -60, -14, 22, {base: '#c7b29a', trim: '#ece2d2', text: 'MARKET HALL', sign: '#2b4a3f'});
  building(0, -14, 12, 27, {base: '#7d858f', trim: '#cfd4da', text: 'OFFICES', sign: '#20262e'});
  building(0, 12, 60, 20, {base: '#b98f72', trim: '#ead9c6', brick: true, text: 'HOTEL', sign: '#3a2d4a'});
  building(2, -40, -4, 18, {base: '#c2a88c', trim: '#ebdfcf', text: 'CINEMA', sign: '#4a2030'});
  building(2, 4, 40, 16, {base: '#a9a49b', trim: '#dedad2', text: 'GROCER', sign: '#2f4a2a'});
  for (let i = 0; i < 9; i++) {
    const w = 16 + R() * 14, h = 34 + R() * 40, x = -70 + i * 17 + R() * 6;
    const base = ['#a9a7a8', '#b8aa9a', '#8c949c', '#c2b6a8'][i % 4];
    const tex = facadeTex(w, h, {base, trim: '#d8d4cc', sp: 2.0}, R);
    const m = std('#ffffff', 0.9, 0, {map: tex.map, emissive: '#ffffff', emissiveMap: tex.em, emissiveIntensity: 0});
    facadeMats.push(m);
    mesh(new THREE.BoxGeometry(w, h, 16), m, x, h / 2, -80 - R() * 40, {cast: false, recv: false});
  }

  // ---- billboard
  const billMat = new THREE.ShaderMaterial({uniforms: {uMap: {value: billboardTex()}, uGain: {value: 1}}, vertexShader: BILL_VERT, fragmentShader: BILL_FRAG});
  mesh(new RoundedBoxGeometry(BILL.w + 0.6, BILL.h + 0.6, 0.5, 2, 0.12), std('#1c1f24', 0.5, 0.6), BILL.x, BILL.y, BILL.z - 0.1);
  mesh(new THREE.PlaneGeometry(BILL.w, BILL.h), billMat, BILL.x, BILL.y, BILL.z + 0.16, {cast: false, recv: false});

  // ---- street furniture
  const metalDark = std('#2e3236', 0.5, 0.6);
  const lamp = (x, z) => {
    mesh(new THREE.CylinderGeometry(0.07, 0.1, 5.6, 8), metalDark, x, 2.8 + SW, z);
    const arm = mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.3, 6), metalDark, x - Math.sign(x) * 0.6, 5.5, z);
    arm.rotation.z = Math.PI / 2;
    mesh(new RoundedBoxGeometry(0.5, 0.16, 0.28, 2, 0.05), metalDark, x - Math.sign(x) * 1.2, 5.45, z);
  };
  lamp(-4.4, -20);
  lamp(4.4, -24);
  lamp(4.4, 14);
  lamp(-4.4, 16);
  for (const x of [-4.6, 4.6]) {
    mesh(new THREE.CylinderGeometry(0.07, 0.08, 3.4, 8), metalDark, x, 1.7 + SW, -34.2);
    mesh(new RoundedBoxGeometry(0.34, 0.95, 0.28, 2, 0.05), std('#1e2124', 0.6, 0.3), x, 3.8, -34.2);
    for (const [k, c, e] of [[0, '#3a1010', 0.0], [1, '#3a3010', 0.0], [2, '#36f08a', 2.2]]) mesh(new THREE.CircleGeometry(0.1, 14), std(c, 0.3, 0, {emissive: c, emissiveIntensity: e}), x, 4.1 - k * 0.3, -34.055, {cast: false});
  }
  const trees = [];
  for (const [x, z] of [[-4.9, -30], [-4.9, 14], [-4.9, 24], [4.9, -27], [4.9, 18], [4.9, 28], [4.9, -38.5]]) {
    const t = makeTree(R);
    t.position.set(x, SW, z);
    t.userData.ph = R() * 6;
    scene.add(t);
    trees.push(t);
  }

  // ---- café terrace: our table, the friend's chair, neighbours
  const ourTable = makeTable();
  ourTable.position.set(-7.6, SW, 0);
  scene.add(ourTable);
  const chairs = [];
  const chair = (x, z, rotY) => {
    const m = redMat();
    const c = makeChair(m);
    c.position.set(x, SW, z);
    c.rotation.y = rotY;
    scene.add(c);
    chairs.push(c);
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
  // red planters and bench
  for (const z of [-2.7, -9.4]) {
    const m = redMat();
    const p = mesh(new RoundedBoxGeometry(0.46, 0.5, 1.5, 2, 0.04), m, -4.6, SW + 0.25, z);
    for (let k = 0; k < 4; k++) {
      const s = mesh(new THREE.IcosahedronGeometry(0.22 + R() * 0.1, 1), std(new THREE.Color().setHSL(0.27, 0.45, 0.26 + R() * 0.06), 0.9), -4.6, SW + 0.6, z - 0.55 + k * 0.37);
      s.scale.y = 0.8;
    }
  }
  {
    const m = redMat();
    const g = new THREE.Group();
    g.position.set(-9.55, SW, -10.2);
    scene.add(g);
    const seat = mesh(new RoundedBoxGeometry(0.45, 0.06, 1.8, 2, 0.02), m, 0, 0.45, 0, {parent: g});
    const back = mesh(new RoundedBoxGeometry(0.06, 0.4, 1.8, 2, 0.02), m, -0.2, 0.72, 0, {parent: g});
    for (const z of [-0.8, 0.8]) mesh(new THREE.BoxGeometry(0.4, 0.45, 0.05), metalDark, 0, 0.22, z, {parent: g});
  }
  // table things (ours)
  const glassA = makeGlass(glassMat()); // friend's, being filled
  glassA.position.set(-7.4, TOP, -0.07);
  const glassB = makeGlass(glassMat()); // ours
  glassB.position.set(-7.86, TOP, 0.15);
  const soda = makeBottle(glassMat(), 0.85);
  soda.position.set(-7.62, TOP, -0.24);
  const pourBottle = makeBottle(glassMat(), 1.05);
  scene.add(glassA, glassB, soda, pourBottle);
  const waterA = mesh(new THREE.CylinderGeometry(0.031, 0.028, 1, 20), waterMat, -7.4, TOP, -0.07, {cast: false});
  const waterB = mesh(new THREE.CylinderGeometry(0.033, 0.029, 0.06, 20), waterMat, -7.86, TOP + 0.035, 0.15, {cast: false});
  waterA.renderOrder = waterB.renderOrder = 1;
  {
    const m = redMat();
    const mug = new THREE.Group();
    mug.position.set(-7.84, TOP, -0.13);
    scene.add(mug);
    const pts = [[0, 0], [0.04, 0], [0.042, 0.005], [0.044, 0.09], [0.04, 0.09], [0.038, 0.012], [0, 0.012]].map(([r, y]) => new THREE.Vector2(r, y));
    const body = mesh(new THREE.LatheGeometry(pts, 24), m, 0, 0, 0, {parent: mug});
    const handle = mesh(new THREE.TorusGeometry(0.025, 0.007, 8, 14), m, 0, 0.048, -0.046, {parent: mug});
    handle.rotation.y = Math.PI / 2;
    mesh(new THREE.CircleGeometry(0.039, 20), std('#3b2416', 0.3), 0, 0.078, 0, {parent: mug, cast: false}).rotation.x = -Math.PI / 2;
    const plate = mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.012, 28), std('#f4f1ea', 0.3), -7.56, TOP + 0.006, 0.2);
    const cro = mesh(new THREE.TorusGeometry(0.045, 0.022, 8, 18, Math.PI * 1.25), std('#c98a3e', 0.65), -7.56, TOP + 0.03, 0.2);
    cro.rotation.x = -Math.PI / 2;
    cro.rotation.z = 0.8;
    cro.scale.set(1, 1, 0.75);
    void plate;
    const phone = mesh(new RoundedBoxGeometry(0.075, 0.009, 0.155, 2, 0.006), std('#16181b', 0.3, 0.4), -7.93, TOP + 0.005, 0.02);
    phone.rotation.y = 0.25;
  }
  // steam puffs over the mug (world time)
  const steamMat = new THREE.SpriteMaterial({color: '#ffffff', transparent: true, opacity: 0.0, depthWrite: false});
  const steamTex = canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,0.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
  });
  steamMat.map = steamTex;
  const steam = [...Array(7)].map(() => add(new THREE.Sprite(steamMat.clone())));

  // water stream from the bottle into the friend's glass
  const streamMat = new THREE.ShaderMaterial({
    uniforms: {uW: {value: 0}, uHead: {value: 1}, uTail: {value: 0}},
    vertexShader: STREAM_VERT,
    fragmentShader: STREAM_FRAG,
    transparent: true,
    depthWrite: false,
  });
  let streamMesh = null;
  const drops = [...Array(26)].map(() => {
    const d = mesh(new THREE.SphereGeometry(1, 8, 6), waterMat, 0, -10, 0, {cast: false});
    d.renderOrder = 3;
    return d;
  });

  // bikes on the east sidewalk, one cadmium red
  const bike = (x, z, red) => {
    const g = new THREE.Group();
    g.position.set(x, SW, z);
    g.rotation.y = 0.1;
    scene.add(g);
    const fm = red ? redMat() : std('#2a6f7a', 0.4, 0.3);
    const tyre = std('#151515', 0.8);
    for (const zz of [-0.52, 0.52]) {
      const w = mesh(new THREE.TorusGeometry(0.33, 0.025, 6, 28), tyre, 0, 0.35, zz, {parent: g});
      w.rotation.y = Math.PI / 2;
    }
    const tube = (a, b) => {
      const m = mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 6), fm, 0, 0, 0, {parent: g});
      const A = V(...a), B = V(...b);
      seg(m, A, B);
      m.scale.y = A.distanceTo(B);
    };
    tube([0, 0.35, -0.52], [0, 0.62, -0.1]);
    tube([0, 0.35, -0.52], [0, 0.35, 0.02]);
    tube([0, 0.35, 0.02], [0, 0.62, -0.1]);
    tube([0, 0.62, -0.1], [0, 0.66, 0.42]);
    tube([0, 0.35, 0.02], [0, 0.66, 0.42]);
    tube([0, 0.66, 0.42], [0, 0.35, 0.52]);
    tube([0, 0.62, -0.1], [0, 0.82, -0.16]);
    tube([0, 0.66, 0.42], [0, 0.92, 0.38]);
    mesh(new RoundedBoxGeometry(0.1, 0.04, 0.24, 2, 0.015), std('#1a1a1a', 0.7), 0, 0.84, -0.17, {parent: g});
    const bar = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.48, 6), metalDark, 0, 0.92, 0.38, {parent: g});
    bar.rotation.z = Math.PI / 2;
  };
  bike(8.9, -1.0, true);
  bike(9.1, 0.2, false);

  // bus shelter in front of the solar facade
  {
    const g = new THREE.Group();
    g.position.set(7.4, SW, -9.4);
    scene.add(g);
    for (const [x, z] of [[0.65, -2], [0.65, 2], [-0.65, -2], [-0.65, 2]]) mesh(new THREE.BoxGeometry(0.07, 2.55, 0.07), metalDark, x, 1.27, z, {parent: g});
    mesh(new RoundedBoxGeometry(1.6, 0.12, 4.3, 2, 0.04), metalDark, 0, 2.6, 0, {parent: g});
    const back = mesh(new THREE.BoxGeometry(0.03, 2.0, 3.9), std('#cfe0e4', 0.05, 0, {transparent: true, opacity: 0.18, envMapIntensity: 1.4, depthWrite: false}), 0.65, 1.2, 0, {parent: g, cast: false});
    back.renderOrder = 2;
    mesh(new RoundedBoxGeometry(0.4, 0.05, 2.4, 2, 0.02), std('#8a6a4a', 0.6), 0.35, 0.46, 0.3, {parent: g});
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
    mesh(new THREE.BoxGeometry(0.12, 1.75, 1.0), std('#ffffff', 0.4, 0, {map: ad, emissive: '#ffffff', emissiveMap: ad, emissiveIntensity: 0.35}), 0.0, 1.15, -2.0, {parent: g});
    const sign = canvasTex(128, 128, (c, w, h) => {
      c.fillStyle = '#1d4f8f';
      c.beginPath();
      c.arc(64, 64, 62, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#fff';
      c.font = '800 46px Inter';
      c.textAlign = 'center';
      c.fillText('BUS', 64, 58);
      c.fillText('34', 64, 104);
    });
    mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.8, 8), metalDark, -1.9, 1.4, 2.4, {parent: g});
    const sg = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 24), std('#ffffff', 0.5, 0, {map: sign}), -1.9, 2.75, 2.4, {parent: g});
    sg.rotation.set(0, 0, Math.PI / 2);
  }

  // parked car + moving cars
  const parked = makeCar('#9aa3ab', R);
  parked.position.set(3.0, 0, -19);
  scene.add(parked);
  const CARS = [
    {c: makeCar('#33475b', R), x: -2.0, z0: -36.5, dir: 1, v: 11.5},
    {c: makeCar('#5d6b4a', R), x: 2.0, z0: 60, dir: -1, v: 10},
    {c: makeCar('#eef1f3', R), x: -2.0, z0: -150.0, dir: 1, v: 11},
    {c: makeCar('#3b3d40', R), x: 52, z0: -38.2, dir: -1, v: 9, cross: true},
  ];
  CARS.forEach((k) => scene.add(k.c));

  // ---- the café flag: the equatorward breeze lifts it toward the south
  const FLAG = V(-4.7, SW, 1.6);
  mesh(new THREE.CylinderGeometry(0.035, 0.045, 4.3, 8), std('#d8d8d6', 0.35, 0.7), FLAG.x, FLAG.y + 2.15, FLAG.z);
  const FNX = 18, FNY = 10, FW = 1.15, FH = 0.72;
  const flagGeo = new THREE.PlaneGeometry(FW, FH, FNX - 1, FNY - 1);
  const flagTex = canvasTex(256, 160, (g, w, h) => {
    g.fillStyle = '#1f4a3c';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#f1ead9';
    g.fillRect(0, h * 0.38, w, h * 0.24);
    g.fillStyle = '#1f4a3c';
    g.font = '800 30px Inter';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('CAFÉ 34', w / 2, h / 2 + 1);
  });
  const flag = mesh(flagGeo, std('#ffffff', 0.85, 0, {map: flagTex, side: THREE.DoubleSide}), 0, 0, 0);
  const fPos = flagGeo.attributes.position;

  // ---- the tsunami bore: about 6.5 m of debris-brown water, foaming at the front
  const WNX = 56, WNS = 40;
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
  const PROF = new THREE.CatmullRomCurve3(
    [[-60, 0.8], [-24, 0.84], [-9, 0.9], [-3, 1.0], [0, 0.97], [1.2, 0.86], [1.9, 0.66], [2.1, 0.42], [2.0, 0.2], [1.8, 0.0]].map(([dz, y]) => V(0, y, dz)),
    false,
    'centripetal',
  ).getSpacedPoints(WNS - 1);
  let crestJ = 0;
  PROF.forEach((P, j) => (P.y > PROF[crestJ].y ? (crestJ = j) : 0));
  const waveMat = new THREE.ShaderMaterial({
    uniforms: {uT: {value: 0}, uSun: {value: V(-0.45, 0.24, 0.86).normalize()}, uCrest: {value: crestJ / (WNS - 1)}},
    vertexShader: /* glsl */ `
      attribute float aS; varying float vS; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main(){ vS = aS; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform float uT; uniform vec3 uSun; uniform float uCrest;
      varying float vS; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.07 + 3.1; a *= 0.5; } return s; }
      void main(){
        vec3 n = normalize(vN); vec3 v = normalize(vV);
        if (!gl_FrontFacing) n = -n;
        float fres = pow(1.0 - abs(dot(n, v)), 3.0);
        float k = vS - uCrest;
        float nn = fbm(vec2(vW.x * 0.5 + uT * 0.5, vW.y * 0.6 + vW.z * 0.25 - uT * 2.2));
        vec3 c = mix(vec3(0.05, 0.065, 0.05), vec3(0.2, 0.22, 0.16), smoothstep(0.2, 0.8, nn));
        c += vec3(0.42, 0.5, 0.55) * fres * 0.4;
        float foam = smoothstep(-0.04, 0.02, k) * smoothstep(0.32, 0.55, nn) * 1.3
                   + (1.0 - smoothstep(-0.2, -0.05, k)) * smoothstep(0.6, 0.8, nn) * 0.55
                   + smoothstep(1.4, 0.0, vW.y) * smoothstep(0.25, 0.5, nn);
        c = mix(c, vec3(0.88, 0.88, 0.84), clamp(foam, 0.0, 1.0));
        vec3 hv = normalize(uSun + v);
        c += vec3(1.0, 0.88, 0.7) * pow(max(dot(n, hv), 0.0), 60.0) * 0.6;
        gl_FragColor = vec4(c * 1.2, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
  const wave = new THREE.Mesh(waveGeo, waveMat);
  wave.frustumCulled = false;
  wave.visible = false;
  scene.add(wave);
  const TS = TL.tsunami;
  const waveFront = (t) => lerp(TS.z0, TS.z1, Math.pow(clamp01((t - TS.at) / (TS.hit - TS.at)), 1.2));
  const waveH = (t) => lerp(TS.h0, TS.h1, smooth((t - TS.at) / (TS.hit - TS.at)));
  const NSPRAY = 360;
  const sprG = new THREE.BufferGeometry();
  const sprPos = new Float32Array(NSPRAY * 3), sprCol = new Float32Array(NSPRAY * 3), sprSize = new Float32Array(NSPRAY);
  sprG.setAttribute('position', new THREE.BufferAttribute(sprPos, 3));
  sprG.setAttribute('aColor', new THREE.BufferAttribute(sprCol, 3));
  sprG.setAttribute('aSize', new THREE.BufferAttribute(sprSize, 1));
  const SPRAY = [...Array(NSPRAY)].map(() => ({x: -10 + R() * 20, ph: R(), vy: 1 + R() * 3, vz: 2 + R() * 4}));

  // ---- the friend across the table
  const friend = makePerson({h: 1.74, skin: '#d9a47c', top: '#2b5d63', bot: '#2a2f3a', hair: 'short', hairC: '#2a1a12', glasses: true, seatY: 0.47, own: true});
  friend.root.position.set(-6.82, SW, 0);
  friend.root.rotation.y = -Math.PI / 2;
  scene.add(friend.root);

  // ---- people
  const S = (i) => SKIN[i % SKIN.length];
  const Cl = (i) => CLOTH[i % CLOTH.length];
  const Hc = (i) => HAIR[i % HAIR.length];
  const bill2 = (x, z) => Math.atan2(BILL.x - x, BILL.z - z);
  const RX = TL.react;
  const PEOPLE = [];
  const walker = (x, z, north, v, o, react) => {
    const P = makePerson(o);
    scene.add(P.root);
    PEOPLE.push({P, kind: 'walk', x, z, heading: north ? Math.PI : 0, v, react, ph0: R() * 6.28});
  };
  const stander = (x, z, heading, o, react, kind = 'stand') => {
    const P = makePerson(o);
    scene.add(P.root);
    PEOPLE.push({P, kind, x, z, heading, v: 0, react, ph0: R() * 6.28});
  };
  // west lane, right behind the friend
  walker(-5.4, 3.6, true, 1.38, {h: 1.8, skin: S(1), top: '#3d6b5a', bot: '#2a2f3a', hair: 'short', hairC: Hc(0), backpack: '#b7a48b'}, {look: 0.25, stop: 0.2});
  walker(-5.75, -9.6, false, 1.24, {h: 1.66, skin: S(5), top: '#ebe7df', bot: '#4b6fa8', hair: 'long', hairC: Hc(3), bag: '#8c6d52'}, {look: 0.1, stop: 0, turn: true});
  walker(-5.2, 11.8, true, 1.46, {h: 1.76, skin: S(3), top: '#c9a14a', bot: '#34405a', hair: 'short', hairC: Hc(1), tee: true, bottle: true}, {look: 0.3, stop: 0.4});
  walker(-5.6, 22, true, 1.3, {h: 1.62, skin: S(0), top: '#7a5c8e', bot: '#1f2328', hair: 'bun', hairC: Hc(2)}, {look: 0.2});
  // east sidewalk
  walker(5.5, 1.5, true, 1.32, {h: 1.83, skin: S(4), top: '#2f4a6d', bot: '#b7a48b', hair: 'bald', bag: '#2a2a2a'}, {look: 0.35, stop: 0.3});
  walker(6.0, -21, false, 1.22, {h: 1.7, skin: S(2), top: '#d9d2c3', bot: '#57683a', hair: 'beanie', beanie: '#2b5d63'}, {look: 0.25, stop: 0.1, turn: true});
  walker(5.4, -6.5, false, 1.1, {h: 1.72, skin: S(6), top: '#5c6f8c', bot: '#1f2328', hair: 'short', hairC: Hc(5)}, {look: 0.4});
  walker(6.1, -6.0, false, 1.1, {h: 1.16, skin: S(6), top: '#c9a14a', bot: '#2f4a6d', hair: 'short', hairC: Hc(5), tee: true, shorts: true}, {look: 0.3});
  walker(7.1, -3.5, true, 1.42, {h: 1.74, skin: S(1), top: '#1f2328', bot: '#6b7280', hair: 'long', hairC: Hc(0), backpack: '#2e5a48'}, {look: 0.15, stop: 0.2});
  walker(5.3, 9, true, 1.35, {h: 1.68, skin: S(0), top: '#a7b7c9', bot: '#2a2f3a', hair: 'short', hairC: Hc(4)}, {look: 0.3});
  // near the intersection: these stop and stare at the screen
  walker(-6.0, -16.2, true, 1.3, {h: 1.78, skin: S(2), top: '#4b6fa8', bot: '#d9d2c3', hair: 'short', hairC: Hc(1)}, {look: 0, stop: 0});
  walker(-5.2, -34, false, 1.2, {h: 1.64, skin: S(5), top: '#3d6b5a', bot: '#1f2328', hair: 'long', hairC: Hc(2), bag: '#c9a14a'}, {look: 0.1, stop: 0.1, turn: true});
  walker(6.2, -30.5, true, 1.25, {h: 1.8, skin: S(3), top: '#ebe7df', bot: '#34405a', hair: 'short', hairC: Hc(0)}, {look: 0.05, stop: 0});
  walker(-7.0, -27, false, 1.15, {h: 1.7, skin: S(4), top: '#8c6d52', bot: '#2a2f3a', hair: 'bun', hairC: Hc(0)}, {look: 0.2, stop: 0.2, turn: true});
  {
    // crossing at the zebra
    for (const [x, o] of [[4.2, {h: 1.75, skin: S(1), top: '#2b5d63', bot: '#d9d2c3', hair: 'short', hairC: Hc(3)}], [5.0, {h: 1.6, skin: S(0), top: '#c9a14a', bot: '#1f2328', hair: 'long', hairC: Hc(1)}]]) {
      const P = makePerson(o);
      scene.add(P.root);
      PEOPLE.push({P, kind: 'walk', x, z: -32.2 + (x - 4.6), heading: -Math.PI / 2, v: 1.3, react: {look: 0, stop: 0}, ph0: R() * 6.28});
    }
  }
  // bus stop
  stander(7.2, -7.9, -Math.PI / 2, {h: 1.72, skin: S(2), top: '#6b7280', bot: '#1f2328', hair: 'short', hairC: Hc(5)}, {look: 0.1}, 'phone');
  stander(7.25, -9.3, -Math.PI / 2, {h: 1.65, skin: S(5), top: '#7a5c8e', bot: '#34405a', hair: 'bun', hairC: Hc(3), seatY: 0.46}, {look: 0.3}, 'sit');
  stander(6.6, -11.2, -Math.PI / 2 + 0.3, {h: 1.82, skin: S(4), top: '#57683a', bot: '#b7a48b', hair: 'beanie', beanie: '#1f2328'}, {look: 0.2});
  // neighbours at the café
  stander(-8.3, -3.4, Math.PI / 2, {h: 1.7, skin: S(0), top: '#2f4a6d', bot: '#1f2328', hair: 'short', hairC: Hc(2), seatY: 0.46}, {look: 0.15}, 'sit');
  stander(-6.9, -3.4, -Math.PI / 2, {h: 1.66, skin: S(3), top: '#ebe7df', bot: '#4b6fa8', hair: 'long', hairC: Hc(0), seatY: 0.46}, {look: 0.25}, 'sit');
  stander(-8.3, -6.8, Math.PI / 2, {h: 1.76, skin: S(6), top: '#c9a14a', bot: '#34405a', hair: 'bald', seatY: 0.46}, {look: 0.05}, 'sit');

  // precompute every walker's track in world time
  const WMIN = -2.8, WMAX = 11, DW = 1 / 100;
  const NTk = Math.ceil((WMAX - WMIN) / DW) + 2;
  for (const p of PEOPLE) {
    const N = NTk;
    p.X = new Float32Array(N);
    p.Z = new Float32Array(N);
    p.H = new Float32Array(N);
    p.PH = new Float32Array(N);
    p.A = new Float32Array(N);
    let x = p.x, z = p.z, ph = p.ph0;
    const stride = 1.4 * p.P.h;
    for (let i = 0; i < N; i++) {
      const w = WMIN + i * DW;
      const r = p.react;
      const stopK = r && r.stop !== undefined && p.kind === 'walk' ? smooth((w - (RX.stop + r.stop)) / 1.1) * (1 - smooth((w - RX.resume - r.stop) / 0.9)) : 0;
      const sf = p.kind === 'walk' ? 1 - stopK : 0;
      const hd = r?.turn ? p.heading + wrapA(bill2(x, z) - p.heading) * stopK : p.heading;
      p.X[i] = x;
      p.Z[i] = z;
      p.H[i] = hd;
      p.PH[i] = ph;
      p.A[i] = sf;
      x += Math.sin(p.heading) * p.v * sf * DW;
      z += Math.cos(p.heading) * p.v * sf * DW;
      ph += ((2 * Math.PI * p.v) / stride) * sf * DW;
    }
  }
  const trk = (arr, w) => {
    const f = Math.min(Math.max((w - WMIN) / DW, 0), NTk - 1.001);
    const i = Math.floor(f);
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
  };
  // the walker carrying a bottle
  {
    const p = PEOPLE[2];
    const b = makeBottle(glassMat(), 0.9);
    p.P.root.add(b);
    p.bottle = b;
  }

  // ---- pigeons (take off as the white car comes)
  const PIG = [...Array(9)].map((_, i) => {
    const g = makePigeon(R);
    scene.add(g);
    return {g, sx: -3.5 + (R() - 0.5) * 0.9, sz: -7.5 + (R() - 0.5) * 2.2, tk: -0.42 + R() * 0.16, vx: -0.5 + (R() - 0.5) * 0.6, vy: 1.7 + R() * 0.5, vz: -5.2 - R() * 1.2, ph: R() * 6.28, f: 6.5 + R() * 1.5};
  });

  const pMat = new THREE.ShaderMaterial({uniforms: {uScale: {value: 1}}, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false});
  // dust motes in the low sun, near the camera (world time)
  const ND = 240;
  const dg = new THREE.BufferGeometry();
  const dPos = new Float32Array(ND * 3), dCol = new Float32Array(ND * 3), dSize = new Float32Array(ND);
  const DM = [...Array(ND)].map(() => ({x: -9.5 + R() * 9, y: SW + 0.3 + R() * 2.8, z: -6 + R() * 12, a: R() * 6.28, s: 0.22 + R() * 0.4}));
  for (let i = 0; i < ND; i++) {
    const b = 0.08 + R() * 0.12;
    dCol.set([b * 1.0, b * 0.8, b * 0.55], i * 3);
    dSize[i] = DM[i].s;
  }
  dg.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
  dg.setAttribute('aColor', new THREE.BufferAttribute(dCol, 3));
  dg.setAttribute('aSize', new THREE.BufferAttribute(dSize, 1));
  const dust = new THREE.Points(dg, pMat);
  dust.frustumCulled = false;
  scene.add(dust);

  const sprays = new THREE.Points(sprG, pMat);
  sprays.frustumCulled = false;
  sprays.renderOrder = 6;
  scene.add(sprays);

  // ---------------------------------------------------------------- overlay
  const app = document.getElementById('app');
  const ov = document.createElement('div');
  ov.className = 'se-ov';
  ov.innerHTML = `<div class="se-vig"></div>
    <div class="bd-water"></div>
    <canvas class="sp-panel"></canvas>
    <div class="se-title">What if Earth spun <em>2x faster</em><br>for 20 seconds?</div>
    <div class="se-tile"></div>
    <div class="se-hud">
      <div class="se-speed"><svg viewBox="0 0 40 28"><path d="M4 24a16 16 0 0 1 32 0" fill="none" stroke-width="4" stroke-linecap="round"/><g class="ndl"><path d="M20 24L20 9" stroke-width="4" stroke-linecap="round"/></g><circle cx="20" cy="24" r="3.5"/></svg><b>1x</b></div>
      <div class="se-clock"><b>0.00</b><span>s</span></div>
    </div>
    <div class="se-track"><i></i>${[0, 5, 10, 15, 20].map((k) => `<em style="left:${k * 5}%"><span>${k}</span></em>`).join('')}</div>
    <div class="ox-air"><span>a day lasts <b class="a1">24 h</b></span><span>you weigh <b class="a2">70.0 kg</b></span></div>
    <canvas class="se-lines"></canvas>
    <div class="se-cap"><div class="se-stamp"></div><div class="se-head"></div><div class="se-sub"></div></div>
    <div class="se-end"><b>What should<br>happen next?</b><span>Comment below</span></div>
    <div class="se-flash"></div>`;
  app.appendChild(ov);
  const Q = (s) => ov.querySelector(s);
  const vig = Q('.se-vig'), titleEl = Q('.se-title'), tileEl = Q('.se-tile'), hudEl = Q('.se-hud'), waterEl = Q('.bd-water');
  const speedEl = Q('.se-speed b'), speedBox = Q('.se-speed'), needle = Q('.se-speed .ndl'), clockEl = Q('.se-clock b'), clockBox = Q('.se-clock');
  const trackEl = Q('.se-track'), trackFill = Q('.se-track i');
  const airEl = Q('.ox-air'), a1El = Q('.ox-air .a1'), a2El = Q('.ox-air .a2');
  const capEl = Q('.se-cap'), stampEl = Q('.se-stamp'), headEl = Q('.se-head'), subEl = Q('.se-sub');
  const endEl = Q('.se-end'), flashEl = Q('.se-flash');
  const lineCv = Q('.se-lines'), lctx = lineCv.getContext('2d');
  const panCv = Q('.sp-panel'), pctx = panCv.getContext('2d');

  // tile: Earth with a spin arrow, cut into shards
  const TW = 236, TH = 262;
  const tileCv = document.createElement('canvas');
  tileCv.width = TW * 2;
  tileCv.height = TH * 2;
  {
    const g = tileCv.getContext('2d');
    g.scale(2, 2);
    const gr = g.createLinearGradient(0, 0, TW, TH);
    gr.addColorStop(0, '#7fe3a8');
    gr.addColorStop(1, '#2fb3a0');
    g.fillStyle = gr;
    g.beginPath();
    g.roundRect(0, 0, TW, TH, 22);
    g.fill();
    const cx = TW / 2, cy = 112;
    const eg = g.createRadialGradient(cx - 22, cy - 22, 8, cx, cy, 64);
    eg.addColorStop(0, '#6fb6ff');
    eg.addColorStop(1, '#1d5fb8');
    g.fillStyle = eg;
    g.beginPath();
    g.arc(cx, cy, 60, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3aa35a';
    g.beginPath();
    g.ellipse(cx - 14, cy - 18, 22, 14, 0.4, 0, Math.PI * 2);
    g.ellipse(cx + 22, cy + 16, 16, 24, -0.3, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#06261f';
    g.lineWidth = 7;
    g.beginPath();
    g.ellipse(cx, cy, 92, 26, -0.18, 0.25, Math.PI * 2 - 0.6);
    g.stroke();
    g.fillStyle = '#06261f';
    g.beginPath();
    g.moveTo(cx + 92 * Math.cos(-0.6) - 4, cy + 26 * Math.sin(-0.6) - 20);
    g.lineTo(cx + 92 * Math.cos(-0.6) + 16, cy + 26 * Math.sin(-0.6) - 4);
    g.lineTo(cx + 92 * Math.cos(-0.6) - 8, cy + 26 * Math.sin(-0.6) + 6);
    g.fill();
    g.textAlign = 'center';
    g.font = '900 40px Inter';
    g.fillText('2× spin', cx, 238);
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

  let tNow = 0; // the frame time, for the callout that follows the wave
  const LBL = [
    {t0: 7.95, t1: 10.25, head: 'SHADOWS · moving 2x faster', sub: 'still only 0.008° a second', at: () => V(-3.4, SW + 0.05, -6.2), dx: 60, dy: -230},
    {t0: 10.6, t1: 13.0, head: 'YOUR FRIEND\'S WATER', sub: '<b class="gl">surface tilts 0.30° toward the equator</b>', at: () => V(-7.4, TOP + 0.09, -0.07), dx: 100, dy: -260},
    {t0: 13.45, t1: 15.6, head: 'BREEZE · toward the equator', sub: '<b class="bz">0.5 m/s</b> and building', at: () => flag.localToWorld(V(0.3, 0, 0)), dx: -80, dy: -200},
    {t0: 22.6, t1: 26.0, head: 'REAL TSUNAMI TIP', sub: 'they come in several waves: stay on high ground for hours', at: () => V(-1, waveH(tNow) * 0.95, waveFront(tNow)), dx: -140, dy: 220},
  ].map((L) => {
    const el = document.createElement('div');
    el.className = 'se-lab';
    el.innerHTML = `<b>${L.head}</b><span>${L.sub}</span>`;
    ov.appendChild(el);
    return {...L, el, gl: el.querySelector('.gl'), bz: el.querySelector('.bz')};
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

  // globe inset: spin rate, and the ocean current toward the equator
  const spinAngle = (t) => 0.5 * t + 0.5 * (Math.min(Math.max(t, T0), T1) - T0);
  const drawGlobe = (t, W, a) => {
    const g = pctx;
    const X0 = 70, X1 = 1010, Y = 612, H = 250;
    g.globalAlpha = a;
    g.fillStyle = 'rgba(4,8,14,0.8)';
    g.beginPath();
    g.roundRect(X0, Y, X1 - X0, H, 22);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 2;
    g.stroke();
    const cx = X0 + 150, cy = Y + 128, r = 100, tilt = 0.32;
    const og = g.createRadialGradient(cx - 30, cy - 30, 10, cx, cy, r);
    og.addColorStop(0, '#4f9be8');
    og.addColorStop(1, '#14427e');
    g.fillStyle = og;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    const proj = (lat, lon) => {
      const x = Math.cos(lat) * Math.sin(lon), y0 = Math.sin(lat), z0 = Math.cos(lat) * Math.cos(lon);
      return [cx + r * x, cy - r * (y0 * Math.cos(tilt) - z0 * Math.sin(tilt)), z0 * Math.cos(tilt) + y0 * Math.sin(tilt)];
    };
    const rot = spinAngle(t);
    g.lineWidth = 1.6;
    for (let k = 0; k < 12; k++) {
      const lon = (k / 12) * Math.PI * 2 + rot;
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.beginPath();
      let pen = false;
      for (let i = 0; i <= 24; i++) {
        const [x, y, z] = proj(-Math.PI / 2 + (i / 24) * Math.PI, lon);
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
    for (const lat of [-0.9, -0.45, 0.45, 0.9, 0]) {
      g.strokeStyle = lat === 0 ? '#ffb43a' : 'rgba(255,255,255,0.3)';
      g.lineWidth = lat === 0 ? 3 : 1.4;
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
    // ocean flow toward the equator
    const u = currentAt(W);
    if (u > 0.01) {
      g.strokeStyle = '#9fffd0';
      g.fillStyle = '#9fffd0';
      g.lineWidth = 3;
      for (const lat of [0.75, -0.75, 0.45, -0.45]) {
        for (const lon of [-0.7, 0, 0.7]) {
          const [x, y, z] = proj(lat, lon);
          if (z < 0.2) continue;
          const len = 30 * Math.min(1, u);
          const dy = lat > 0 ? len : -len;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x, y + dy);
          g.stroke();
          g.beginPath();
          g.moveTo(x - 6, y + dy - Math.sign(dy) * 7);
          g.lineTo(x + 6, y + dy - Math.sign(dy) * 7);
          g.lineTo(x, y + dy + Math.sign(dy) * 2);
          g.fill();
        }
      }
    }
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '700 22px "JetBrains Mono"';
    g.fillText(spinning(W) ? 'SPIN ×2' : W >= SL.world ? 'SPIN ×1 · back to normal' : 'SPIN ×1', X0 + 300, Y + 48);
    g.fillStyle = '#ffffff';
    g.font = '700 26px Inter';
    g.fillText('oceans sliding toward the equator', X0 + 300, Y + 98);
    g.font = '800 54px "JetBrains Mono"';
    g.fillStyle = '#9fffd0';
    g.fillText(`${u.toFixed(2)} m/s`, X0 + 300, Y + 162);
    g.font = '600 22px Inter';
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(W >= SL.world ? 'and still moving' : `pushed by 0.051 m/s² of extra spin`, X0 + 300, Y + 202);
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

  // ---------------------------------------------------------------- state
  const P0 = TL.pour;
  const bottleRest = V(-7.33, TOP, -0.2);
    const mouthAt = V(-7.405, TOP + 0.255, -0.07);
  const pourAxis = V(0.62, 0.55, -0.56).normalize(); // mouth -> base
  const pourTilt = (w) => smooth((w - P0.tilt) / 0.7) * (1 - smooth((w - P0.end) / 0.8));
  const liftK = (w) => smooth((w - P0.lift) / 0.9) * (1 - smooth((w - P0.down) / 0.8));
  const levelAt = (w) => lerp(0.028, 0.092, clamp01((w - P0.tilt - 0.4) / (P0.end - P0.tilt - 0.4)));
  const streamK = (w) => {
    const on = clamp01((w - P0.tilt - 0.45) / 0.12);
    const off = clamp01((w - P0.end + 0.25) / 0.14);
    return {head: on, tail: off};
  };
  const bottlePose = (w) => {
    const pt = pourTilt(w), lf = liftK(w);
    const center = V().copy(mouthAt).addScaledVector(pourAxis, 0.144);
    const pos = bottleRest.clone().add(V(0, 0.144 + 0.15 * lf, 0)).lerp(center, pt);
    const axis = V(0, -1, 0).lerp(pourAxis, pt).normalize(); // mouth -> base
    pourBottle.quaternion.setFromUnitVectors(V(0, -1, 0), axis);
    pourBottle.position.copy(pos).addScaledVector(axis, 0.144);
    return {pt, lf};
  };
  const buildStream = (level) => {
    if (streamMesh) {
      streamMesh.geometry.dispose();
      scene.remove(streamMesh);
    }
    const a = mouthAt.clone().add(V(-0.004, -0.004, 0.002));
    const b = V(-7.4, TOP + level, -0.07);
    const mid = a.clone().lerp(b, 0.5).add(V(-0.006, 0.0, 0.003));
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    streamMesh = mesh(new THREE.TubeGeometry(curve, 24, 0.0055, 10, false), streamMat, 0, 0, 0, {cast: false, recv: false});
    streamMesh.renderOrder = 3;
  };
  buildStream(0.05);
  let lastLevel = -1;
  bottlePose(0.05);
  pourBottle.updateMatrixWorld(true);


  const fmtSpeed = (v) => (Math.abs(v - 1) < 0.015 ? '1x' : `${v.toFixed(1)}x`);
  const capAt = (t) => TL.captions.find((c) => t >= c.at - 0.3 && t < c.until + 0.3);
  const nb = (x) => x.replace(/(\d) (s|m|h|J|kg|km\/h|m\/s)\b/g, '$1 $2');
  const PANEL = TL.panel;
  let spinShown = false;

  const posePeople = (W) => {
    for (const p of PEOPLE) {
      const x = trk(p.X, W), z = trk(p.Z, W), hd = trk(p.H, W), ph = trk(p.PH, W), amp = trk(p.A, W);
      p.P.root.position.set(x, SW, z);
      p.P.root.rotation.y = hd;
      const r = p.react ?? {};
      const lk = r.look !== undefined ? smooth((W - RX.look - r.look) / 0.6) * (1 - smooth((W - RX.resume - 0.3) / 0.7)) : 0;
      const yB = wrapA(bill2(x, z) - hd);
      const st2 = {mode: p.kind === 'sit' ? 'sit' : 'walk', phase: ph, amp: p.kind === 'walk' ? amp : 0, lean: 0.04 + 0.03 * amp, twist: 0.07 * amp * Math.sin(ph), headYaw: Math.max(-1.3, Math.min(1.3, yB)) * lk + 0.08 * Math.sin(W * 0.9 + p.ph0) * (1 - lk), headPitch: 0.1 * lk, hand: null};
      if (p.kind === 'phone') {
        st2.hand = [V(0.03, 1.12 * p.P.h, 0.25), V(-0.06, 1.12 * p.P.h, 0.24)];
        st2.headPitch -= 0.45 * (1 - lk);
      }
      if (p.kind === 'sit') st2.hand = [V(0.16, p.P.seatY + 0.2, 0.3), V(-0.16, p.P.seatY + 0.2, 0.3)];
      posePerson(p.P, st2);
      if (p.bottle) p.bottle.position.copy(p.P.hand[1].position).add(V(0, -0.1, 0.02));
    }
  };

  return {
    resize() {
      st.resize();
      layoutOv();
    },
    render(t) {
      tNow = t;
      const W = worldAt(t);
      const spd = speedAt(t);
      const breeze = 0.6 + currentAt(W) * (1 - smooth((W - SL.world - 6) / 4)); // m/s, toward the equator (south, +z)

      // ---- camera: seated POV head; it shakes as the water comes
      const c = camAt(t);
      const slam = t >= T0 ? Math.exp(-(t - T0) / 0.35) : 0;
      const ret = t >= T1 ? Math.exp(-(t - T1) / 0.3) : 0;
      const shake = t >= TS.at ? 0.003 + 0.016 * smooth((t - TS.at) / (TS.hit - TS.at)) : 0;
      const jit = 0.008 * slam + 0.008 * ret + shake;
      const yaw = c.yaw + 0.006 * Math.sin(t * 0.7) + jit * Math.sin(t * 61);
      const pit = c.pitch + 0.004 * Math.sin(t * 1.3 + 1) + jit * Math.sin(t * 47 + 2);
      const lean = clamp01((-pit - 0.25) / 0.3);
      camera.position.set(EYE.x + 0.13 * lean, EYE.y + 0.004 * Math.sin(t * 1.7) - 0.05 * lean, EYE.z);
      const dir = V(Math.cos(pit) * Math.cos(yaw), Math.sin(pit), -Math.cos(pit) * Math.sin(yaw));
      camera.lookAt(camera.position.clone().add(dir));
      camera.fov = c.fov - 4 * slam * (t - T0 < 0.08 ? (t - T0) / 0.08 : 1) - 3 * ret;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // ---- people, the friend and their pour
      posePeople(W);
      {
        const fr = friend.root;
        fr.updateMatrixWorld();
        const lk = smooth((W - RX.look) / 0.5);
        const {pt, lf} = bottlePose(W);
        pourBottle.updateMatrixWorld();
        const gl = fr.worldToLocal(pourBottle.localToWorld(V(0.03, 0.12, 0)));
        posePerson(friend, {mode: 'sit', phase: 0, amp: 0, lean: 0.12 + 0.05 * pt, twist: 0, headYaw: -0.95 * lk + 0.05 * Math.sin(W * 0.8), headPitch: 0.15 * lk - 0.05, hand: [fr.worldToLocal(V(-7.28, TOP + 0.03, 0.17)), lf > 0.02 || pt > 0.02 ? gl : fr.worldToLocal(V(-7.3, TOP + 0.02, -0.18))]});
        const lvl = levelAt(W);
        waterA.scale.y = lvl;
        waterA.position.y = TOP + 0.008 + lvl / 2;
        const sk = streamK(W);
        streamMesh.visible = sk.head > 0 && sk.tail < 1;
        if (streamMesh.visible && Math.abs(lvl - lastLevel) > 0.004) {
          buildStream(lvl);
          lastLevel = lvl;
        }
        streamMat.uniforms.uHead.value = sk.head;
        streamMat.uniforms.uTail.value = sk.tail;
        streamMat.uniforms.uW.value = W;
        drops.forEach((d, i) => {
          const u = (((W * 1.9 + i * 0.618) % 1) + 1) % 1;
          const tt = u * 0.38;
          const a = (i * 2.399) % 6.283;
          const vh = 0.12 + ((i * 7) % 5) * 0.04;
          const vy = 0.35 + ((i * 3) % 4) * 0.12;
          d.visible = streamMesh.visible && sk.head > 0.9;
          d.position.set(-7.4 + Math.cos(a) * vh * tt, TOP + lvl + 0.01 + vy * tt - 4.9 * tt * tt, -0.07 + Math.sin(a) * vh * tt);
          d.scale.setScalar((0.0018 + ((i * 5) % 4) * 0.0009) * (1 - u * 0.3));
          if (d.position.y < TOP + lvl) d.visible = false;
        });
        steam.forEach((sp, i) => {
          const u = (((W * 0.35 + i / steam.length) % 1) + 1) % 1;
          sp.position.set(-7.84 + 0.02 * Math.sin(u * 7 + i), TOP + 0.1 + u * 0.22, -0.13 + 0.02 * Math.cos(u * 5 + i * 2) + 0.06 * breeze * u);
          sp.scale.setScalar(0.04 + u * 0.09);
          sp.material.opacity = 0.16 * Math.sin(Math.PI * u);
        });
      }

      // ---- the flag in the breeze
      {
        const lift = Math.min(1, Math.max(0.15, breeze / 2.4));
        const d = V(0, -1, 0).lerp(V(0, -0.15, 1), lift).normalize();
        const top = V(FLAG.x, FLAG.y + 4.25, FLAG.z);
        for (let j = 0; j < FNY; j++) {
          for (let i = 0; i < FNX; i++) {
            const u = i / (FNX - 1), v = j / (FNY - 1);
            const fl = (0.05 + 0.06 * lift) * u * Math.sin(u * 7 - W * (5 + 3 * breeze) + v * 1.5);
            fPos.setXYZ(j * FNX + i, top.x + fl, top.y - v * FH + d.y * u * FW, top.z + d.z * u * FW);
          }
        }
        fPos.needsUpdate = true;
        flagGeo.computeVertexNormals();
      }

      // ---- cars, pigeons, trees (leaning with the breeze), dust
      for (const k of CARS) {
        const dd = k.v * (W + 2.8);
        if (k.cross) {
          k.c.position.set(k.x + k.dir * dd, 0, k.z0);
          k.c.rotation.y = k.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
        } else {
          k.c.position.set(k.x, 0, k.z0 + k.dir * dd);
          k.c.rotation.y = k.dir > 0 ? 0 : Math.PI;
        }
        k.c.userData.wheels.forEach((w) => (w.rotation.x = dd / 0.34));
      }
      for (const b of PIG) {
        const dt = W - b.tk;
        const g = b.g;
        const [wl, wr] = g.userData.wings;
        if (dt < 0) {
          g.position.set(b.sx, 0.07, b.sz);
          g.rotation.set(0, b.ph, 0);
          g.userData.head.position.y = 0.07 - 0.03 * Math.max(0, Math.sin(W * 9 + b.ph));
          wl.rotation.z = wr.rotation.z = 0;
          wl.scale.x = wr.scale.x = 0.55;
        } else {
          const hdist = (dt * dt) / (dt + 0.35);
          g.position.set(b.sx + b.vx * hdist, 0.07 + b.vy * dt - 0.08 * dt * dt + 0.09 * hdist, b.sz + b.vz * hdist);
          g.rotation.set(-0.35 * Math.exp(-dt), Math.atan2(b.vx, b.vz), 0);
          const fl = Math.sin(dt * b.f * 6.283 + b.ph);
          wl.rotation.z = 0.15 + 0.95 * fl;
          wr.rotation.z = -0.15 - 0.95 * fl;
          wl.scale.x = wr.scale.x = 1;
        }
      }
      trees.forEach((tr) => {
        tr.userData.crown.rotation.z = 0.012 * Math.sin(W * 0.9 + tr.userData.ph);
        tr.userData.crown.rotation.x = 0.012 * breeze + 0.008 * breeze * Math.sin(W * 1.7 + tr.userData.ph);
      });
      for (let i = 0; i < ND; i++) {
        const m = DM[i];
        dPos[i * 3] = m.x + 0.05 * Math.sin(W * 0.6 + m.a);
        dPos[i * 3 + 1] = m.y + 0.04 * Math.sin(W * 0.45 + m.a * 2) - 0.01 * W;
        dPos[i * 3 + 2] = ((m.z + 6 + 0.05 * Math.cos(W * 0.5 + m.a) + 0.4 * (0.6 * W + 0.5 * PUSH * Math.min(Math.max(W, 0), SL.world) ** 2)) % 12) - 6;
      }
      dg.attributes.position.needsUpdate = true;
      pMat.uniforms.uScale.value = 19 * (st.size.h / 1920) * (window.devicePixelRatio || 1) * (60 / camera.fov);

      // ---- the tsunami bore (real time)
      wave.visible = t >= TS.at - 0.05;
      sprays.visible = wave.visible;
      if (wave.visible) {
        const zf = waveFront(t), H = waveH(t);
        for (let i = 0; i < WNX; i++) {
          const x = -10.5 + (21 * i) / (WNX - 1);
          for (let j = 0; j < WNS; j++) {
            const P = PROF[j];
            const k = (i * WNS + j) * 3;
            const front = smooth((P.y - 0.4) / 0.5) * (P.z > -4 ? 1 : 0.4);
            wPos[k] = x;
            wPos[k + 1] = P.y * H * (1 + 0.06 * Math.sin(x * 0.7 + t * 2.1)) + 0.25 * Math.sin(x * 1.3 - t * 4.1) * front;
            wPos[k + 2] = zf + P.z + 0.5 * Math.sin(x * 0.4 + t * 1.5) + 0.35 * Math.sin(x * 0.9 - t * 2.7) * front;
          }
        }
        waveGeo.attributes.position.needsUpdate = true;
        waveGeo.computeVertexNormals();
        waveMat.uniforms.uT.value = t;
        for (let i = 0; i < NSPRAY; i++) {
          const sp = SPRAY[i];
          const u = (((t * 1.1 + sp.ph) % 1) + 1) % 1;
          const a = u * 1.0;
          const y = 0.9 * H + sp.vy * a - 0.5 * G * a * a;
          sprPos[i * 3] = sp.x;
          sprPos[i * 3 + 1] = Math.max(0.15, y);
          sprPos[i * 3 + 2] = zf + 1.8 + sp.vz * a;
          const b = 0.6 * (1 - u) * (y > 0.15 ? 1 : 0);
          sprCol.set([b, b * 0.97, b * 0.9], i * 3);
          sprSize[i] = (0.8 + 1.2 * u) * Math.max(4, Math.abs(zf - EYE.z)) * 0.3;
        }
        sprG.attributes.position.needsUpdate = true;
        sprG.attributes.aColor.needsUpdate = true;
        sprG.attributes.aSize.needsUpdate = true;
      }

      st.render();

      // ---------------------------------------------------------------- overlay
      vig.style.opacity = (0.45 + 0.2 * clamp01((t - T0) / 0.3) * (1 - smooth((t - T1) / 0.3))).toFixed(3);
      const tk = smooth((t - T0 + 0.1) / 0.5);
      titleEl.style.transform = `translateY(${(-18 * tk).toFixed(1)}px) scale(${(1 - 0.18 * tk).toFixed(4)})`;
      if (t < T0) {
        const gl = smooth((t - T0 + 0.6) / 0.6);
        tileEl.style.opacity = '1';
        tileEl.style.transform = `translate(${(gl * 6 * Math.sin(t * 83)).toFixed(1)}px, 0) rotate(${(t * 40).toFixed(1)}deg) scale(${(1 + 0.04 * Math.sin(t * 3)).toFixed(4)})`;
        tileEl.style.filter = gl > 0.2 ? `drop-shadow(${(-gl * 5).toFixed(1)}px 0 0 rgba(0,220,255,0.7)) drop-shadow(${(gl * 5).toFixed(1)}px 0 0 rgba(255,40,80,0.7))` : 'none';
        shards.forEach((sd) => (sd.d.style.transform = 'none'));
      } else {
        const wv = Math.min(Math.max(0, W), 2) * 0.25 + 0.03;
        tileEl.style.filter = 'none';
        tileEl.style.transform = 'none';
        tileEl.style.opacity = (1 - smooth((t - T0 - 0.15) / 0.45)).toFixed(3);
        shards.forEach((sd) => (sd.d.style.transform = `translate(${(sd.vx * wv).toFixed(1)}px, ${(sd.vy * wv).toFixed(1)}px) rotate(${(sd.rot * wv).toFixed(1)}deg)`));
      }
      speedEl.textContent = fmtSpeed(spd);
      speedBox.classList.toggle('slow', Math.abs(spd - 1) > 0.015);
      needle.setAttribute('transform', `rotate(${(-80 + 80 * spd).toFixed(1)} 20 24)`);
      const clk = clockAt(t);
      if (t < T0) {
        clockEl.textContent = `−${(T0 - t).toFixed(2)}`;
        clockBox.className = 'se-clock pre';
      } else {
        clockEl.textContent = clk.toFixed(2);
        clockBox.className = t >= T1 ? 'se-clock done' : 'se-clock run';
      }
      speedBox.style.transform = `scale(${(t >= T0 ? 1 + 0.18 * Math.exp(-(t - T0) / 0.18) : 1).toFixed(3)})`;
      trackFill.style.width = `${((clk / SL.world) * 100).toFixed(2)}%`;
      const hudOut = smooth((t - TL.end + 0.2) / 0.4);
      hudEl.style.opacity = trackEl.style.opacity = airEl.style.opacity = (1 - 0.3 * hudOut).toFixed(3);
      const sp2 = spinning(W);
      if (sp2 !== spinShown) {
        spinShown = sp2;
        a1El.textContent = sp2 ? '12 h' : '24 h';
        a2El.textContent = sp2 ? '69.6 kg' : '70.0 kg';
        airEl.classList.toggle('gone', sp2);
      }
      const sub = smooth((t - TS.hit + 0.15) / 0.3);
      waterEl.style.opacity = sub.toFixed(3);
      // globe panel
      const dpr2 = panCv.width / (OW * s);
      pctx.setTransform(s * dpr2, 0, 0, s * dpr2, 0, 0);
      pctx.clearRect(0, 0, OW, OH);
      let pa = 0;
      for (const [a0, a1] of PANEL) pa = Math.max(pa, smooth((t - a0) / 0.35) * (1 - smooth((t - a1) / 0.3)));
      if (pa > 0.002) drawGlobe(t, W, pa);
      // caption
      const cp = capAt(t);
      if (cp) {
        const a = smooth((t - cp.at) / 0.22) * (1 - smooth((t - cp.until) / 0.2));
        const head = nb(cp.head);
        if (headEl.textContent !== head) {
          headEl.textContent = head;
          subEl.textContent = nb(cp.sub);
          stampEl.textContent = cp.stamp ?? `${Math.min(SL.world, Math.max(0, worldAt(cp.hit))).toFixed(2)} s`;
        }
        capEl.style.opacity = a.toFixed(3);
        capEl.style.transform = `translateY(${(26 * (1 - easeOutCubic((t - cp.at) / 0.35))).toFixed(1)}px)`;
      } else capEl.style.opacity = '0';
      const ea = smooth((t - TL.end) / 0.35);
      endEl.style.opacity = ea.toFixed(3);
      endEl.style.transform = `translateY(-50%) scale(${(0.92 + 0.08 * easeOutCubic((t - TL.end) / 0.5)).toFixed(4)})`;
      flashEl.style.opacity = ((t >= T0 ? 0.2 * Math.exp(-(t - T0) / 0.12) : 0) + (t >= T1 ? 0.25 * Math.exp(-(t - T1) / 0.2) : 0)).toFixed(3);

      // callouts + bubbles
      const dpr = lineCv.width / (OW * s);
      lctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
      lctx.clearRect(0, 0, OW, OH);
      if (sub > 0.01) {
        const tt = t - TS.hit + 0.15;
        for (const b of BUB) {
          const y = b.y0 - b.v * tt;
          if (y < -40) continue;
          lctx.globalAlpha = 0.5 * sub;
          lctx.strokeStyle = 'rgba(230,240,230,0.9)';
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
        if (L.bz) L.bz.textContent = `${currentAt(W).toFixed(2)} m/s`;
        const ax = p.x / s, ay = p.y / s;
        const w = L.el.offsetWidth, hh = L.el.offsetHeight;
        const lx = Math.min(OW - 150 - w, Math.max(54, ax + L.dx - (L.dx < 0 ? w : 0)));
        const ly = Math.min(1100 - hh / 2, Math.max((pa > 0.05 ? 890 : 610) + hh / 2, ay + L.dy));
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
        lctx.fillStyle = '#5fe0b0';
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
