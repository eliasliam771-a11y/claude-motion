import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {Sky} from 'three/addons/objects/Sky.js';
import {runSim} from '../kit/runtime.js';
import {createStage} from '../kit/stage3d.js';
import {clamp01, easeInOutCubic, easeOutCubic, lerp, rng, smooth} from '../kit/util.js';
import TL from './timeline.json';

// "What if the Sun disappeared for 15 seconds?" in the TikTok what-if format,
// first person from the café table of sims/selenium. The twist is the real
// physics: sunlight and the Sun's gravity both travel at the speed of light,
// so nothing changes on Earth for 8 min 19 s. The clock fast-forwards through
// that wait while a space-view inset shows the 15-light-second gap in the
// light flying toward Earth. Then it arrives: the sky goes black at 0.1x, the
// Moon stays lit 1.3 s longer, stars and Jupiter come out, phones and
// headlights switch on, Earth flies straight, your eyes slowly adapt, and the
// Sun comes back blinding.
//
// Three clocks: real time t (camera, overlay); world time W since the Sun
// vanished (people, cars, the sky), the integral of the speed curve; and dark
// time, W minus the 499 s light delay. Sound: sims/nosun/sound.py.
//
// Invented street, people and brands. Numbers: Sun-Earth light time 499 s;
// Moon 1.28 light-seconds away; Jupiter's light reaches us 76-96 min after the
// Sun's would go out there; the Sun pulls Earth at 5.93 mm/s^2, so 15 s of
// straight flight is 0.5*a*t^2 = 0.67 m off the orbit.

const DEFAULTS = {
  duration: TL.duration,
  fps: TL.fps,
  theme: 'dark',
  hud: {enabled: false, title: 'nosun', subtitle: ''},
  director: {enabled: false},
  watermark: '',
  seed: 15,
};

// ---------------------------------------------------------------- clocks
const CK = TL.clock;
const TV = CK.vanish; // the Sun vanishes
const TA = TV + CK.hold; // fast-forward starts
const TB = TA + CK.ff; // fast-forward ends
const TC = TB + CK.decel; // down to slow motion
const TD = TC + CK.pre; // the last sunlight passes Earth
const TDL = CK.dark / (CK.s0 + (CK.s1 - CK.s0) / (CK.pow + 1));
const TS = TD + TDL; // sunlight is back
// fast-forward peak chosen so the clock reads exactly 8:19 when the dark lands
const SP = 1 + 2 * ((CK.light - CK.hold - (CK.decel * (1 + CK.s0)) / 2 - CK.pre * CK.s0) / CK.ff - 1);
const speedAt = (t) => {
  if (t < TA) return 1;
  if (t < TB) return 1 + (SP - 1) * Math.sin((Math.PI * (t - TA)) / CK.ff) ** 2;
  if (t < TC) return lerp(1, CK.s0, smooth((t - TB) / CK.decel));
  if (t < TD) return CK.s0;
  if (t < TS) return CK.s0 + (CK.s1 - CK.s0) * Math.pow((t - TD) / TDL, CK.pow);
  if (t < TS + CK.out) return lerp(CK.s1, 1, smooth((t - TS) / CK.out));
  return 1;
};
const DT = 1 / 1000;
const NW = Math.ceil((TL.duration + 1) / DT) + 2;
const WT = new Float64Array(NW);
{
  const i0 = Math.round(TV / DT);
  for (let i = i0 + 1; i < NW; i++) WT[i] = WT[i - 1] + 0.5 * (speedAt((i - 1) * DT) + speedAt(i * DT)) * DT;
  for (let i = i0 - 1; i >= 0; i--) WT[i] = WT[i + 1] - 0.5 * (speedAt(i * DT) + speedAt((i + 1) * DT)) * DT;
}
const worldAt = (t) => {
  const f = Math.min(Math.max(t / DT, 0), NW - 1.001);
  const i = Math.floor(f);
  return WT[i] + (WT[i + 1] - WT[i]) * (f - i);
};
const WD0 = worldAt(TD);
const darkAt = (t) => worldAt(t) - WD0; // seconds since the last sunlight passed
const nightAt = (t) => smooth((t - TD) / 0.2) * (1 - smooth((t - TS) / 0.12));
const ADAPT_MAX = 9;
const adaptAt = (t) => {
  if (t < TD) return 1;
  if (t < TS) return 1 + ADAPT_MAX * (1 - Math.exp(-Math.max(0, darkAt(t)) / 2.5));
  const end = ADAPT_MAX * (1 - Math.exp(-CK.dark / 2.5));
  return 1 + end * Math.exp(-(t - TS) / 0.8);
};

// ---------------------------------------------------------------- layout
const SW = 0.12; // sidewalk height
const EYE = new THREE.Vector3(-8.3, SW + 1.18, 0);
const TOP = SW + 0.74; // table top
const BILL = {x: -1, y: 12.6, z: -43.8, w: 15, h: 8.4};
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const SUN0 = V(-0.06, 0.72, 0.98).normalize();
// a quarter Moon: exactly 90 degrees from the Sun, so its sunlight stops when Earth's does
const MOON = V(0.325, 1.388, -1.0).normalize();
const JUP = V(0.43, 1.2, -1.12).normalize();
const sunDirAt = (w) => {
  // the sky turns 15 degrees an hour: a visible creep during the fast-forward
  const a = (Math.max(0, Math.min(w, CK.light + 30)) / 86400) * Math.PI * 2;
  const d = SUN0.clone().applyAxisAngle(V(0, 1, 0), a * 0.8);
  d.y -= a * 0.5;
  return d.normalize();
};
const TARGETS = {
  friend: [-6.85, SW + 1.35, 0.05],
  sun: EYE.clone().addScaledVector(SUN0, 100).toArray(),
  streetS: [0.5, 2.6, 30],
  friend2: [-6.85, SW + 1.55, 0.25],
  moon: EYE.clone().addScaledVector(MOON, 100).add(V(0, -32, 0)).toArray(),
  busstop: [8, 3.2, -9],
  friendLow: [-6.9, SW + 1.12, 0.02],
};

const std = (color, rough = 0.8, metal = 0, extra = {}) => new THREE.MeshStandardMaterial({color, roughness: rough, metalness: metal, ...extra});
const glassMat = () => std('#e4eeec', 0.04, 0, {transparent: true, opacity: 0.2, envMapIntensity: 1.8, depthWrite: false});
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
const wrapR = (v, lo, hi) => lo + ((((v - lo) % (hi - lo)) + (hi - lo)) % (hi - lo));

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
const STAR_VERT = /* glsl */ `
attribute float aSize; attribute vec3 aColor; varying vec3 vC; uniform float uPx;
void main(){ vC = aColor; gl_PointSize = aSize * uPx; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const STAR_FRAG = /* glsl */ `
varying vec3 vC; uniform float uI;
void main(){
  vec2 p = gl_PointCoord - 0.5; float d = dot(p, p) * 4.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vC * uI * pow(1.0 - d, 2.0), 1.0);
}`;
const MOON_VERT = /* glsl */ `
varying vec3 vN; varying vec3 vP;
void main(){ vN = normalize(mat3(modelMatrix) * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const MOON_FRAG = /* glsl */ `
uniform vec3 uSun; uniform float uLit;
varying vec3 vN; varying vec3 vP;
float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float n3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main(){
  float l = smoothstep(-0.04, 0.1, dot(normalize(vN), uSun));
  float maria = 0.72 + 0.28 * smoothstep(0.35, 0.65, n3(vP * 0.14) * 0.7 + n3(vP * 0.36) * 0.3);
  gl_FragColor = vec4(vec3(1.0, 0.98, 0.94) * l * maria * uLit, 1.0);
}`;
const BEAM_VERT = /* glsl */ `
uniform float uLen; varying float vL; varying vec3 vN; varying vec3 vV;
void main(){
  vL = clamp(position.z / uLen, 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = -mv.xyz; vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;
const BEAM_FRAG = /* glsl */ `
uniform vec3 uCol; uniform float uI;
varying float vL; varying vec3 vN; varying vec3 vV;
void main(){
  float f = abs(dot(normalize(vN), normalize(vV)));
  float a = pow(1.0 - vL, 1.8) * pow(f, 1.4) * smoothstep(0.0, 0.06, vL);
  gl_FragColor = vec4(uCol * a * uI, 1.0);
}`;

// ---------------------------------------------------------------- sim
runSim(DEFAULTS, async ({cfg, canvas, hud, capture}) => {
  await Promise.all([
    document.fonts.load('900 40px Inter'),
    document.fonts.load('800 40px Inter'),
    document.fonts.load('700 40px Inter'),
    document.fonts.load('700 20px "JetBrains Mono"'),
  ]).catch(() => {});
  const st = createStage(canvas, hud, {bg: '#000000', capture, fov: 74, exposure: 0.6, bloom: {strength: 0.3, radius: 0.45, threshold: 1.4}});
  const {scene, camera, renderer} = st;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  camera.near = 0.05;
  camera.far = 3000;
  const R = rng(cfg.seed);
  const mesh = (geo, mat, x = 0, y = 0, z = 0, o = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = o.cast ?? true;
    m.receiveShadow = o.recv ?? true;
    (o.parent ?? scene).add(m);
    return m;
  };

  // ---- sky by day, black with stars by night
  const sky = new Sky();
  sky.scale.setScalar(2500);
  const su = sky.material.uniforms;
  su.turbidity.value = 2.2;
  su.rayleigh.value = 1.1;
  su.mieCoefficient.value = 0.0018;
  su.mieDirectionalG.value = 0.72;
  su.sunPosition.value.copy(SUN0);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky);
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  scene.add(sky);
  const sunTex = canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.11, 'rgba(255,250,235,1)');
    gr.addColorStop(0.125, 'rgba(255,236,190,0.4)');
    gr.addColorStop(0.32, 'rgba(255,220,160,0.1)');
    gr.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
  });
  const sunDisc = new THREE.Sprite(new THREE.SpriteMaterial({map: sunTex, color: new THREE.Color(6, 5.4, 4.4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false}));
  sunDisc.scale.setScalar(320);
  sunDisc.renderOrder = 5;
  scene.add(sunDisc);
  const nightDome = new THREE.Mesh(new THREE.SphereGeometry(2200, 32, 16), new THREE.MeshBasicMaterial({color: '#000000', side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, fog: false}));
  nightDome.renderOrder = 1;
  scene.add(nightDome);
  // stars: a few bright ones, many faint, upper hemisphere
  let starMat;
  {
    const NSTAR = 1400;
    const pos = new Float32Array(NSTAR * 3), col = new Float32Array(NSTAR * 3), size = new Float32Array(NSTAR);
    for (let i = 0; i < NSTAR; i++) {
      const u = 0.08 + R() * 0.92, a = R() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos.set([s * Math.cos(a) * 2100, u * 2100, s * Math.sin(a) * 2100], i * 3);
      const mag = Math.pow(R(), 5);
      const tint = R();
      const b = 0.4 + 3.2 * mag;
      col.set(tint < 0.2 ? [b * 0.8, b * 0.9, b * 1.2] : tint > 0.85 ? [b * 1.2, b * 1.0, b * 0.75] : [b, b, b], i * 3);
      size[i] = 1.4 + 3.2 * mag;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    starMat = new THREE.ShaderMaterial({uniforms: {uPx: {value: 1}, uI: {value: 0}}, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false});
    const stars = new THREE.Points(g, starMat);
    stars.renderOrder = 2;
    stars.frustumCulled = false;
    scene.add(stars);
  }
  // Jupiter: one bright dot near the Moon
  const jupMat = new THREE.ShaderMaterial({uniforms: {uPx: {value: 1}, uI: {value: 0}}, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false});
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(JUP.clone().multiplyScalar(1400).toArray()), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array([2.6, 2.3, 1.8]), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array([7]), 1));
    const j = new THREE.Points(g, jupMat);
    j.renderOrder = 4;
    j.frustumCulled = false;
    scene.add(j);
  }
  // the Moon, lit by the Sun from its side; a black occluder hides stars behind it at night
  const moonMat = new THREE.ShaderMaterial({uniforms: {uSun: {value: SUN0.clone()}, uLit: {value: 1}}, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false});
  const moon = new THREE.Mesh(new THREE.SphereGeometry(40, 48, 28), moonMat);
  moon.position.copy(MOON).multiplyScalar(1500);
  moon.renderOrder = 4;
  scene.add(moon);
  const occl = new THREE.Mesh(new THREE.SphereGeometry(39.5, 24, 16), new THREE.MeshBasicMaterial({color: '#000', transparent: true, opacity: 0, depthWrite: false, fog: false}));
  occl.position.copy(moon.position);
  occl.renderOrder = 3;
  scene.add(occl);

  scene.fog = new THREE.Fog('#c9d6e4', 80, 450);
  const fogDay = new THREE.Color('#c9d6e4'), fogNight = new THREE.Color('#020306');
  const sun = new THREE.DirectionalLight('#fff1dc', 2.0);
  const sunTarget = V(-2, 0, -6);
  sun.target.position.copy(sunTarget);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {left: -42, right: 42, top: 42, bottom: -42, near: 1, far: 320});
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#a8c2ea', '#6b5c4c', 0.42);
  scene.add(hemi);

  // ---- night lights (always in the scene so shaders never recompile)
  const warm = (x, y, z, i, d, c = '#ffb46b') => {
    const l = new THREE.PointLight(c, 0, d, 2);
    l.position.set(x, y, z);
    l.userData.i = i;
    scene.add(l);
    return l;
  };
  const pools = [warm(-9.5, 2.7, 0.6, 1.6, 12), warm(9.3, 2.4, 4.5, 2.2, 12), warm(9.3, 2.4, -10, 2.0, 12), warm(-1, 10, -40, 60, 40, '#ff9a3c'), warm(-9.4, 2.4, -16, 1.6, 10)];

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

  // ---- café terrace
  const ourTable = makeTable();
  ourTable.position.set(-7.6, SW, 0);
  scene.add(ourTable);
  const chairRed = std('#c4231b', 0.42, 0.25, {envMapIntensity: 0.7});
  const chair = (x, z, rotY) => {
    const c = makeChair(chairRed);
    c.position.set(x, SW, z);
    c.rotation.y = rotY;
    scene.add(c);
  };
  chair(-6.82, 0.0, -Math.PI / 2);
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
    mesh(new RoundedBoxGeometry(0.46, 0.5, 1.5, 2, 0.04), std('#3d4a52', 0.6, 0.2), -4.6, SW + 0.25, z);
    for (let k = 0; k < 4; k++) mesh(new THREE.IcosahedronGeometry(0.22 + R() * 0.1, 1), std(new THREE.Color().setHSL(0.27, 0.45, 0.26 + R() * 0.06), 0.9), -4.6, SW + 0.6, z - 0.55 + k * 0.37).scale.y = 0.8;
  }
  // table things
  const mugMat = std('#f2efe8', 0.3, 0);
  const mkMug = (x, z) => {
    const mug = new THREE.Group();
    mug.position.set(x, TOP, z);
    scene.add(mug);
    const pts = [[0, 0], [0.04, 0], [0.042, 0.005], [0.044, 0.09], [0.04, 0.09], [0.038, 0.012], [0, 0.012]].map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(pts, 24), mugMat, 0, 0, 0, {parent: mug});
    mesh(new THREE.CylinderGeometry(0.0445, 0.0445, 0.012, 24, 1, true), std('#2b5d8a', 0.4), 0, 0.06, 0, {parent: mug});
    const handle = mesh(new THREE.TorusGeometry(0.025, 0.007, 8, 14), mugMat, 0, 0.048, -0.046, {parent: mug});
    handle.rotation.y = Math.PI / 2;
    mesh(new THREE.CircleGeometry(0.039, 20), std('#3b2416', 0.3), 0, 0.078, 0, {parent: mug, cast: false}).rotation.x = -Math.PI / 2;
    return mug;
  };
  mkMug(-7.84, -0.13);
  mkMug(-7.36, 0.12);
  const gB = makeGlass(glassMat());
  gB.position.set(-7.86, TOP, 0.15);
  const soda = makeBottle(glassMat(), 0.85);
  soda.position.set(-7.62, TOP, -0.24);
  scene.add(gB, soda);
  const wB = mesh(new THREE.CylinderGeometry(0.033, 0.029, 0.06, 20), waterMat, -7.86, TOP + 0.035, 0.15, {cast: false});
  wB.renderOrder = 1;
  mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.012, 28), std('#f4f1ea', 0.3), -7.56, TOP + 0.006, 0.2);
  {
    const cro = mesh(new THREE.TorusGeometry(0.045, 0.022, 8, 18, Math.PI * 1.25), std('#c98a3e', 0.65), -7.56, TOP + 0.03, 0.2);
    cro.rotation.x = -Math.PI / 2;
    cro.rotation.z = 0.8;
    cro.scale.set(1, 1, 0.75);
    const ph = mesh(new RoundedBoxGeometry(0.075, 0.009, 0.155, 2, 0.006), std('#16181b', 0.3, 0.4), -7.93, TOP + 0.005, 0.02);
    ph.rotation.y = 0.25;
  }

  // bikes, bus shelter
  const bike = (x, z, col) => {
    const g = new THREE.Group();
    g.position.set(x, SW, z);
    g.rotation.y = 0.1;
    scene.add(g);
    const fm = std(col, 0.4, 0.3);
    const tyre = std('#151515', 0.8);
    for (const zz of [-0.52, 0.52]) mesh(new THREE.TorusGeometry(0.33, 0.025, 6, 28), tyre, 0, 0.35, zz, {parent: g}).rotation.y = Math.PI / 2;
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
    mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.48, 6), metalDark, 0, 0.92, 0.38, {parent: g}).rotation.z = Math.PI / 2;
  };
  bike(8.9, -1.0, '#c4231b');
  bike(9.1, 0.2, '#2a6f7a');
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
    mesh(new THREE.BoxGeometry(0.12, 1.75, 1.0), std('#ffffff', 0.4, 0, {map: ad, emissive: '#ffffff', emissiveMap: ad, emissiveIntensity: 0.5}), 0.0, 1.15, -2.0, {parent: g});
    const sign = canvasTex(128, 128, (c) => {
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
    mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 24), std('#ffffff', 0.5, 0, {map: sign}), -1.9, 2.75, 2.4, {parent: g}).rotation.set(0, 0, Math.PI / 2);
  }

  // ---- light beams (additive cones) for headlights and phone torches
  const beamGeo = (len, r) => {
    const g = new THREE.ConeGeometry(r, len, 24, 1, true);
    g.translate(0, -len / 2, 0);
    g.rotateX(-Math.PI / 2);
    return g;
  };
  const beam = (len, r, col) => {
    const m = new THREE.Mesh(beamGeo(len, r), new THREE.ShaderMaterial({uniforms: {uLen: {value: len}, uCol: {value: new THREE.Color(col)}, uI: {value: 0}}, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide}));
    m.renderOrder = 6;
    m.frustumCulled = false;
    return m;
  };

  // ---- cars: timelapse blur by day, brake and switch on headlights in the dark
  const parked = makeCar('#9aa3ab', R);
  parked.position.set(3.0, 0, -19);
  scene.add(parked);
  const DK = TL.dark;
  const CARS = [
    {col: '#33475b', x: -2.0, zs: -12, dir: 1, v: 11},
    {col: '#e2ded6', x: 2.0, zs: -4.5, dir: -1, v: 10, spot: true},
    {col: '#7a8a5a', x: -2.0, zs: -27, dir: 1, v: 11},
    {col: '#2b2f36', x: 2.0, zs: 17, dir: -1, v: 10},
  ].map((k) => {
    const c = makeCar(k.col, R);
    scene.add(c);
    k.c = c;
    k.beams = [-0.6, 0.6].map((x) => {
      const b = beam(12, 1.9, '#fff1d6');
      b.position.set(x, 0.75, 2.2);
      b.rotation.x = 0.06;
      c.add(b);
      return b;
    });
    k.lamps = [];
    c.traverse((o) => o.isMesh && o.material.emissive && o.material.emissiveIntensity > 0.35 && k.lamps.push(o));
    if (k.spot) {
      const sl = new THREE.SpotLight('#fff1d6', 0, 40, 0.42, 0.5, 2);
      sl.position.set(0, 0.8, 2.2);
      sl.target.position.set(0, 0, 14);
      c.add(sl, sl.target);
      k.light = sl;
    }
    return k;
  });

  // ---- people
  const S = (i) => SKIN[i % SKIN.length];
  const Hc = (i) => HAIR[i % HAIR.length];
  const PEOPLE = [];
  const phoneGeo = new RoundedBoxGeometry(0.075, 0.15, 0.01, 2, 0.008);
  const phoneBody = std('#16181b', 0.3, 0.4);
  const mkPhone = () => {
    const g = new THREE.Group();
    const b = new THREE.Mesh(phoneGeo, phoneBody);
    g.add(b);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.066, 0.138), new THREE.MeshBasicMaterial({color: '#9fc4ff'}));
    scr.position.z = -0.0055;
    scr.rotation.y = Math.PI;
    g.add(scr);
    const tb = beam(3.6, 1.0, '#eef4ff');
    tb.position.set(0, 0.05, 0.01);
    g.add(tb);
    g.userData = {scr, tb};
    g.visible = false;
    return g;
  };
  const person = (kind, x, zs, dir, v, o, r = {}) => {
    const P = makePerson(o);
    scene.add(P.root);
    const p = {P, kind, x, zs, dir, v, r, ph0: R() * 6.28};
    if (r.phone !== undefined) {
      p.phone = mkPhone();
      P.root.add(p.phone);
    }
    PEOPLE.push(p);
    return p;
  };
  const walker = (x, zs, dir, v, o, r) => person('walk', x, zs, dir, v, o, r);
  walker(-5.35, -0.6, -1, 1.38, {h: 1.8, skin: S(1), top: '#3d6b5a', bot: '#2a2f3a', hair: 'short', hairC: Hc(0), backpack: '#b7a48b'}, {look: 0.2});
  walker(-5.85, 1.9, 1, 1.24, {h: 1.66, skin: S(5), top: '#ebe7df', bot: '#4b6fa8', hair: 'long', hairC: Hc(3), bag: '#8c6d52'}, {phone: 4.1});
  walker(-5.2, 6.5, -1, 1.45, {h: 1.76, skin: S(3), top: '#c9a14a', bot: '#34405a', hair: 'short', hairC: Hc(1), tee: true}, {look: 0.5});
  walker(5.5, 2.8, -1, 1.32, {h: 1.83, skin: S(4), top: '#2f4a6d', bot: '#b7a48b', hair: 'bald', bag: '#2a2a2a'}, {phone: 3.4});
  walker(6.1, 6.2, 1, 1.2, {h: 1.7, skin: S(2), top: '#d9d2c3', bot: '#57683a', hair: 'beanie', beanie: '#2b5d63'}, {look: 0.3});
  walker(5.4, -5.6, 1, 1.1, {h: 1.72, skin: S(6), top: '#5c6f8c', bot: '#1f2328', hair: 'short', hairC: Hc(5)}, {phone: 5.2});
  walker(6.0, -5.3, 1, 1.1, {h: 1.16, skin: S(6), top: '#c9a14a', bot: '#2f4a6d', hair: 'short', hairC: Hc(5), tee: true, shorts: true}, {look: 0.1});
  walker(5.9, -12.8, -1, 1.42, {h: 1.74, skin: S(1), top: '#1f2328', bot: '#6b7280', hair: 'long', hairC: Hc(0), backpack: '#2e5a48'}, {phone: 3.0});
  walker(5.3, -14.6, 1, 1.35, {h: 1.68, skin: S(0), top: '#a7b7c9', bot: '#2a2f3a', hair: 'short', hairC: Hc(4)}, {look: 0.4});
  walker(-6.0, -21, -1, 1.3, {h: 1.78, skin: S(2), top: '#4b6fa8', bot: '#d9d2c3', hair: 'short', hairC: Hc(1)}, {look: 0.25});
  walker(-5.2, -27, 1, 1.2, {h: 1.64, skin: S(5), top: '#3d6b5a', bot: '#1f2328', hair: 'long', hairC: Hc(2), bag: '#c9a14a'}, {phone: 4.5});
  walker(6.2, -26, -1, 1.25, {h: 1.8, skin: S(3), top: '#ebe7df', bot: '#34405a', hair: 'short', hairC: Hc(0)}, {look: 0.1});
  walker(-7.0, -24.5, 1, 1.15, {h: 1.7, skin: S(4), top: '#8c6d52', bot: '#2a2f3a', hair: 'bun', hairC: Hc(0)}, {phone: 6.0});
  walker(-5.6, 18, -1, 1.3, {h: 1.62, skin: S(0), top: '#7a5c8e', bot: '#1f2328', hair: 'bun', hairC: Hc(2)}, {look: 0.3});
  walker(6.0, 21, 1, 1.3, {h: 1.75, skin: S(1), top: '#2b5d63', bot: '#d9d2c3', hair: 'short', hairC: Hc(3)}, {look: 0.2});
  walker(5.4, 13, -1, 1.25, {h: 1.69, skin: S(3), top: '#b7a48b', bot: '#34405a', hair: 'long', hairC: Hc(1)}, {phone: 5.6});
  person('phone', 7.2, -7.9, 0, 0, {h: 1.72, skin: S(2), top: '#6b7280', bot: '#1f2328', hair: 'short', hairC: Hc(5)}, {phone: -99, heading: -Math.PI / 2});
  person('sit', 7.25, -9.3, 0, 0, {h: 1.65, skin: S(5), top: '#7a5c8e', bot: '#34405a', hair: 'bun', hairC: Hc(3), seatY: 0.46}, {look: 0.3, heading: -Math.PI / 2});
  person('stand', 6.6, -11.2, 0, 0, {h: 1.82, skin: S(4), top: '#57683a', bot: '#b7a48b', hair: 'beanie', beanie: '#1f2328'}, {phone: 3.8, heading: -Math.PI / 2 + 0.3});
  person('sit', -8.3, -3.4, 0, 0, {h: 1.7, skin: S(0), top: '#2f4a6d', bot: '#1f2328', hair: 'short', hairC: Hc(2), seatY: 0.46}, {look: 0.15, heading: Math.PI / 2});
  person('sit', -6.9, -3.4, 0, 0, {h: 1.66, skin: S(3), top: '#ebe7df', bot: '#4b6fa8', hair: 'long', hairC: Hc(0), seatY: 0.46}, {phone: 4.4, heading: -Math.PI / 2});
  person('sit', -8.3, -6.8, 0, 0, {h: 1.76, skin: S(6), top: '#c9a14a', bot: '#34405a', hair: 'bald', seatY: 0.46}, {look: 0.05, heading: Math.PI / 2});
  // one pedestrian phone torch is a real light
  const pedTorch = new THREE.SpotLight('#eef4ff', 0, 12, 0.5, 0.6, 2);
  {
    const p = PEOPLE[1];
    p.phone.add(pedTorch, pedTorch.target);
    pedTorch.position.set(0, 0.05, 0.02);
    pedTorch.target.position.set(0, 0, 4);
  }

  // distance walked: normal by day (wrapping in the timelapse), stopping in the dark
  const DWN = 3000, DDW = 0.01;
  const sfOf = (d, stop) => 1 - 0.93 * smooth((d - stop) / 1.2) + 0.93 * smooth((d - DK.resume) / 1.0);
  const distTable = (stop) => {
    const T = new Float32Array(DWN + 1);
    for (let i = 1; i <= DWN; i++) T[i] = T[i - 1] + 0.5 * (sfOf((i - 1) * DDW, stop) + sfOf(i * DDW, stop)) * DDW;
    return T;
  };
  const distAt = (T, w) => {
    if (w <= WD0) return w;
    const f = Math.min((w - WD0) / DDW, DWN - 1.001);
    const i = Math.floor(f);
    return WD0 + T[i] + (T[i + 1] - T[i]) * (f - i);
  };
  for (const p of PEOPLE) {
    p.T = distTable(DK.stop + (p.r.look ?? 0) * 0.5);
    p.ref = distAt(p.T, WD0 + 9);
  }
  for (const k of CARS) {
    const T = new Float32Array(DWN + 1);
    const sf = (d) => 1 - smooth((d - 0.5) / 2.2) + smooth((d - 15.4) / 1.6);
    for (let i = 1; i <= DWN; i++) T[i] = T[i - 1] + 0.5 * (sf((i - 1) * DDW) + sf(i * DDW)) * DDW;
    k.T = T;
    k.ref = distAt(T, WD0 + 9);
  }

  // ---- the friend across the table
  const friend = makePerson({h: 1.74, skin: '#d9a47c', top: '#2b5d63', bot: '#2a2f3a', hair: 'short', hairC: '#2a1a12', glasses: true, seatY: 0.47, own: true});
  friend.root.position.set(-6.82, SW, 0);
  friend.root.rotation.y = -Math.PI / 2;
  scene.add(friend.root);
  const fPhone = mkPhone();
  scene.add(fPhone);
  const fTorch = new THREE.SpotLight('#eef4ff', 0, 8, 0.6, 0.6, 2);
  fPhone.add(fTorch, fTorch.target);
  fTorch.position.set(0, 0.05, 0.02);
  fTorch.target.position.set(0, 0, 2);

  // ---------------------------------------------------------------- overlay
  const app = document.getElementById('app');
  const ov = document.createElement('div');
  ov.className = 'se-ov';
  ov.innerHTML = `<div class="se-vig"></div>
    <canvas class="ns-inset"></canvas>
    <div class="se-title">What if the <em>Sun</em><br>disappeared for 15 seconds?</div>
    <div class="se-tile"></div>
    <div class="se-hud">
      <div class="se-speed"><svg viewBox="0 0 40 28"><path d="M4 24a16 16 0 0 1 32 0" fill="none" stroke-width="4" stroke-linecap="round"/><g class="ndl"><path d="M20 24L20 9" stroke-width="4" stroke-linecap="round"/></g><circle cx="20" cy="24" r="3.5"/></svg><b>1x</b></div>
      <div class="se-clock"><span class="lbl"></span><div><b>0.00</b><span class="u"></span></div></div>
    </div>
    <div class="se-track"><i></i>${[0, 5, 10, 15].map((k) => `<em style="left:${(k / 15) * 100}%"><span>${k}</span></em>`).join('')}</div>
    <canvas class="se-lines"></canvas>
    <div class="se-cap"><div class="se-stamp"></div><div class="se-head"></div><div class="se-sub"></div></div>
    <div class="se-end"><b>What should<br>disappear next?</b><span>Comment below</span></div>
    <div class="se-flash"></div>`;
  app.appendChild(ov);
  const Q = (s) => ov.querySelector(s);
  const vig = Q('.se-vig'), titleEl = Q('.se-title'), tileEl = Q('.se-tile'), hudEl = Q('.se-hud');
  const speedEl = Q('.se-speed b'), speedBox = Q('.se-speed'), needle = Q('.se-speed .ndl');
  const clockBox = Q('.se-clock'), clockEl = Q('.se-clock b'), clockLbl = Q('.se-clock .lbl'), clockU = Q('.se-clock .u');
  const trackEl = Q('.se-track'), trackFill = Q('.se-track i');
  const capEl = Q('.se-cap'), stampEl = Q('.se-stamp'), headEl = Q('.se-head'), subEl = Q('.se-sub');
  const endEl = Q('.se-end'), flashEl = Q('.se-flash');
  const lineCv = Q('.se-lines'), lctx = lineCv.getContext('2d');
  const insCv = Q('.ns-inset'), ictx = insCv.getContext('2d');

  // sun emblem, cut into shards that fly off when the Sun vanishes
  const TW = 236, TH = 236;
  const tileCv = document.createElement('canvas');
  tileCv.width = TW * 2;
  tileCv.height = TH * 2;
  {
    const g = tileCv.getContext('2d');
    g.scale(2, 2);
    const cx = TW / 2, cy = TH / 2;
    g.strokeStyle = '#ffc93a';
    g.lineCap = 'round';
    g.lineWidth = 13;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 74, cy + Math.sin(a) * 74);
      g.lineTo(cx + Math.cos(a) * 106, cy + Math.sin(a) * 106);
      g.stroke();
    }
    const gr = g.createRadialGradient(cx - 18, cy - 18, 8, cx, cy, 62);
    gr.addColorStop(0, '#fff3b0');
    gr.addColorStop(0.6, '#ffc93a');
    gr.addColorStop(1, '#ff9a1a');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(cx, cy, 60, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3a2204';
    g.font = '900 46px Inter';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('15 s', cx, cy + 2);
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
      shards.push({d, vx: cx * 1700 + (R() - 0.5) * 500, vy: cy * 1300 - 500 + (R() - 0.5) * 400, rot: (R() - 0.5) * 700});
    }
  }

  const LBL = [
    {t0: 3.75, t1: 4.65, head: 'THE SUN · already gone', sub: 'this light left it 8 min ago', at: () => EYE.clone().addScaledVector(sunDirAt(worldAt(4)), 300), dx: 60, dy: 190},
    {t0: 13.75, t1: 18.0, head: 'MOON', sub: '<b class="mn">still lit</b> · 1.28 light-seconds away', at: () => moon.position.clone().add(V(-8, -10, 0)), dx: -120, dy: 230},
    {t0: 18.45, t1: 20.8, head: 'JUPITER', sub: 'still lit for another hour+', at: () => JUP.clone().multiplyScalar(1400), dx: -60, dy: 180},
    {t0: 22.25, t1: 24.85, head: 'SOLAR FACADE', sub: '<b>0 W</b> · no sunlight, no power', at: () => V(9.9, 12, -12), dx: -320, dy: -60},
  ].map((L) => {
    const el = document.createElement('div');
    el.className = 'se-lab';
    el.innerHTML = `<b>${L.head}</b><span>${L.sub}</span>`;
    ov.appendChild(el);
    return {...L, el, mn: el.querySelector('.mn')};
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
    for (const cv of [lineCv, insCv]) {
      cv.width = Math.round(iw * dpr);
      cv.height = Math.round(ih * dpr);
      cv.style.width = `${OW}px`;
      cv.style.height = `${OH}px`;
    }
  };
  layoutOv();
  st.resize();

  // space view: the Sun, Earth, and the 15-light-second gap flying between them
  const IX0 = 70, IX1 = 1010, IY = 520, IH = 190;
  const drawSpace = (w, a) => {
    const g = ictx;
    g.globalAlpha = a;
    g.fillStyle = 'rgba(4,6,12,0.78)';
    g.beginPath();
    g.roundRect(IX0, IY, IX1 - IX0, IH, 22);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 2;
    g.stroke();
    g.font = '700 20px "JetBrains Mono"';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.textAlign = 'left';
    g.fillText('SPACE VIEW · not to scale', IX0 + 22, IY + 34);
    const sx = IX0 + 110, ex = IX1 - 90, cy = IY + 108;
    const on = (wEmit) => !(wEmit >= 0 && wEmit < CK.dark);
    // light in flight: each point carries the light the Sun emitted d seconds ago
    const N = 260;
    for (let i = 0; i < N; i++) {
      const x0 = sx + 46 + ((ex - sx - 46) * i) / N, x1 = sx + 46 + ((ex - sx - 46) * (i + 1)) / N;
      const dsec = ((x0 + x1) / 2 - sx) / (ex - sx) * CK.light;
      if (!on(w - dsec)) continue;
      const k = 1 - (0.35 * i) / N;
      g.fillStyle = `rgba(255,${200 + 30 * k},${90 + 60 * k},${0.75 * k})`;
      g.fillRect(x0, cy - 9, x1 - x0 + 0.5, 18);
    }
    // the Sun
    if (on(w)) {
      const gr = g.createRadialGradient(sx, cy, 4, sx, cy, 58);
      gr.addColorStop(0, '#fff6c8');
      gr.addColorStop(0.55, '#ffc23a');
      gr.addColorStop(1, 'rgba(255,150,30,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(sx, cy, 58, 0, Math.PI * 2);
      g.fill();
    } else {
      g.setLineDash([7, 7]);
      g.strokeStyle = 'rgba(255,210,120,0.8)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(sx, cy, 40, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffd27a';
      g.font = '700 22px Inter';
      g.textAlign = 'center';
      g.fillText('gone', sx, cy + 8);
    }
    // Earth and Moon
    const dark = w >= CK.light && w < CK.light + CK.dark;
    g.fillStyle = dark ? '#1b2a44' : '#4d9be6';
    g.beginPath();
    g.arc(ex, cy, 15, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = dark ? '#3a3a3a' : '#cfcfcf';
    g.beginPath();
    g.arc(ex + 38, cy - 26, 5, 0, Math.PI * 2);
    g.fill();
    g.font = '700 22px Inter';
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    g.fillText('Earth', ex, cy + 46);
    // the gap label
    const gx = sx + ((Math.min(w, CK.light) - CK.dark / 2) / CK.light) * (ex - sx);
    if (w > 0 && w < CK.light + CK.dark) {
      g.fillStyle = '#ffffff';
      g.font = '700 20px "JetBrains Mono"';
      const label = w < CK.light ? 'the gap: 15 light-seconds' : 'the gap reaches Earth';
      const lx = Math.min(Math.max(gx, IX0 + 330), IX1 - 200);
      g.fillText(label, lx, cy - 26);
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(lx, cy - 20);
      g.lineTo(gx, cy - 11);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.font = '600 20px Inter';
    g.fillText('150 million km · 8 min 19 s at light speed', (sx + ex) / 2, cy + 54);
    g.globalAlpha = 1;
  };
  // orbit view: Earth leaves its curve along the tangent while the pull is gone
  const drawOrbit = (d, a) => {
    const g = ictx;
    g.globalAlpha = a;
    g.fillStyle = 'rgba(4,6,12,0.78)';
    g.beginPath();
    g.roundRect(IX0, IY, IX1 - IX0, IH + 30, 22);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 2;
    g.stroke();
    g.font = '700 20px "JetBrains Mono"';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.textAlign = 'left';
    g.fillText('ORBIT · drift exaggerated', IX0 + 22, IY + 34);
    const cx = (IX0 + IX1) / 2, cy = IY + 1080, r = 1000;
    g.strokeStyle = 'rgba(120,180,255,0.7)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
    g.stroke();
    const a0 = -Math.PI / 2 - 0.3;
    const p0 = [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r];
    const tan = [-Math.sin(a0), Math.cos(a0)];
    const L = 560 * clamp01(d / CK.dark);
    g.setLineDash([10, 8]);
    g.strokeStyle = 'rgba(255,210,120,0.95)';
    g.beginPath();
    g.moveTo(p0[0], p0[1]);
    g.lineTo(p0[0] - tan[0] * 560, p0[1] - tan[1] * 560);
    g.stroke();
    g.setLineDash([]);
    const ex = p0[0] - tan[0] * L, ey = p0[1] - tan[1] * L;
    g.fillStyle = '#4d9be6';
    g.beginPath();
    g.arc(ex, ey, 14, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '700 22px Inter';
    g.textAlign = 'center';
    g.fillText('orbit', cx + 280, IY + 150);
    g.fillStyle = '#ffd27a';
    g.fillText('straight line, no pull', p0[0] + 300, p0[1] - 92);
    g.fillStyle = '#ffffff';
    g.font = '700 24px "JetBrains Mono"';
    g.fillText(`+${(0.5 * 5.93e-3 * Math.min(d, CK.dark) ** 2 * 100).toFixed(0)} cm off orbit`, (IX0 + IX1) / 2 + 160, IY + 200);
    g.globalAlpha = 1;
  };

  // ---------------------------------------------------------------- camera
  const ang = {};
  for (const [k, p] of Object.entries(TARGETS)) {
    const d = V(...p).sub(EYE);
    ang[k] = {yaw: Math.atan2(-d.z, d.x), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z))};
  }
  const CAM = TL.cam;
  const camAt = (t) => {
    let a = CAM[0], b = CAM[0], k = 0;
    if (t >= CAM[CAM.length - 1][0]) a = b = CAM[CAM.length - 1];
    else
      for (let i = 0; i < CAM.length - 1; i++) {
        if (t >= CAM[i][0] && t < CAM[i + 1][0]) {
          a = CAM[i];
          b = CAM[i + 1];
          k = (t - a[0]) / (b[0] - a[0]);
          break;
        }
      }
    const e = easeInOutCubic(k);
    const A = ang[a[1]], B = ang[b[1]];
    return {yaw: A.yaw + wrapA(B.yaw - A.yaw) * e, pitch: lerp(A.pitch, B.pitch, e), fov: lerp(a[2], b[2], e)};
  };

  const fmtSpeed = (v) => (v >= 9.95 ? `${Math.round(v)}x` : Math.abs(v - 1) < 0.015 ? '1x' : `${v.toFixed(1)}x`);
  const mmss = (w, dp) => {
    const m = Math.floor(w / 60);
    const sec = Math.floor((w - 60 * m) * 10 ** dp) / 10 ** dp;
    return `${m}:${sec.toFixed(dp).padStart(3 + dp, '0')}`;
  };
  const stampAt = (c) => c.stamp ?? (c.hit < TD ? mmss(Math.max(0, worldAt(c.hit)), 1) : `${Math.min(CK.dark, Math.max(0, darkAt(c.hit))).toFixed(2)} s`);
  const capAt = (t) => TL.captions.find((c) => t >= c.at - 0.3 && t < c.until + 0.3);

  return {
    resize() {
      st.resize();
      layoutOv();
    },
    render(t) {
      const W = worldAt(t);
      const D = darkAt(t);
      const spd = speedAt(t);
      const night = nightAt(t);
      const day = 1 - night;
      const adapt = adaptAt(t);

      // ---- sky, Sun, Moon, stars
      const sd = sunDirAt(W);
      su.sunPosition.value.copy(sd);
      sun.position.copy(sunTarget).addScaledVector(sd, 140);
      sun.intensity = 2.0 * day;
      sunDisc.position.copy(EYE).addScaledVector(sd, 1900);
      sunDisc.material.opacity = day;
      hemi.intensity = 0.42 * day + 0.004 * night;
      scene.environmentIntensity = 0.55 * day;
      scene.fog.color.copy(fogDay).lerp(fogNight, night);
      nightDome.material.opacity = night;
      const seeing = night * clamp01((adapt - 1.4) / 5);
      starMat.uniforms.uI.value = seeing;
      starMat.uniforms.uPx.value = (st.size.h / 1920) * (window.devicePixelRatio || 1);
      jupMat.uniforms.uI.value = night * clamp01((adapt - 1.15) / 2.5);
      jupMat.uniforms.uPx.value = starMat.uniforms.uPx.value;
      // moonlight left the Moon 1.28 s before it reaches us, so its gap lands 1.28 s later
      const moonOff = smooth((D - DK.moon) / 0.05) * (1 - smooth((D - DK.moon - CK.dark) / 0.05));
      moonMat.uniforms.uSun.value.copy(sd);
      moonMat.uniforms.uLit.value = (0.55 * day + 1.25 * night) * (1 - moonOff);
      occl.material.opacity = night;
      const facadeGlow = 0.28 * night;
      for (const m of facadeMats) m.emissiveIntensity = facadeGlow;
      pools.forEach((l) => (l.intensity = l.userData.i * night));
      billMat.uniforms.uGain.value = 1 / (1 + 0.6 * (adapt - 1));

      // ---- camera: seated POV head
      const c = camAt(t);
      const hit = t >= TD ? Math.exp(-(t - TD) / 0.4) : 0;
      const ret = t >= TS ? Math.exp(-(t - TS) / 0.35) : 0;
      const jit = 0.01 * hit + 0.012 * ret;
      const yaw = c.yaw + 0.006 * Math.sin(t * 0.7) + jit * Math.sin(t * 61);
      const pit = c.pitch + 0.004 * Math.sin(t * 1.3 + 1) + jit * Math.sin(t * 47 + 2);
      const lean = clamp01((-pit - 0.25) / 0.3);
      camera.position.set(EYE.x + 0.13 * lean, EYE.y + 0.004 * Math.sin(t * 1.7) - 0.05 * lean, EYE.z);
      const dir = V(Math.cos(pit) * Math.cos(yaw), Math.sin(pit), -Math.cos(pit) * Math.sin(yaw));
      camera.lookAt(camera.position.clone().add(dir));
      const sunLook = smooth((dir.dot(sd) - 0.82) / 0.16) * day;
      renderer.toneMappingExposure = 0.6 * adapt * (1 - 0.55 * sunLook);
      st.bloomPass.threshold = 3.2 / (adapt * (1 - 0.55 * sunLook));
      st.bloomPass.strength = (0.28 + 0.2 * night) * (1 - 0.9 * sunLook);
      camera.fov = c.fov + 3 * ret;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // ---- people
      for (const p of PEOPLE) {
        const r = p.r;
        const walking = p.kind === 'walk';
        const dist = distAt(p.T, W);
        let x = p.x, z = p.zs, hd = r.heading ?? (p.dir > 0 ? 0 : Math.PI);
        let amp = 0;
        if (walking) {
          z = wrapR(p.zs + p.dir * p.v * (dist - p.ref), -40, 46);
          amp = D < 0 ? 1 : sfOf(D, DK.stop + (r.look ?? 0) * 0.5);
        }
        p.P.root.position.set(x, SW, z);
        p.P.root.rotation.y = hd;
        const lk = r.look !== undefined && D > 0 ? smooth((D - DK.look - r.look) / 0.6) * (1 - smooth((D - CK.dark - 0.4) / 0.6)) : 0;
        const ph = r.phone !== undefined ? (r.phone < -50 ? 1 : D > 0 ? smooth((D - r.phone) / 0.5) * (1 - smooth((D - CK.dark - 1.5) / 0.6)) : 0) : 0;
        const st2 = {mode: p.kind === 'sit' ? 'sit' : 'walk', phase: p.ph0 + (2 * Math.PI * p.v * dist) / (1.4 * p.P.h), amp: walking ? amp : 0, lean: 0.04 + 0.03 * amp, twist: 0.07 * amp * Math.sin(p.ph0 + dist), headYaw: 0.25 * lk * Math.sin(p.ph0) + 0.08 * Math.sin(W * 0.9 + p.ph0) * (1 - lk), headPitch: 0.75 * lk - 0.35 * ph, hand: null};
        if (p.kind === 'sit') st2.hand = [V(0.16, p.P.seatY + 0.2, 0.3), V(-0.16, p.P.seatY + 0.2, 0.3)];
        if (p.phone) {
          const hp = V(-0.08, lerp(0.75, 1.18, ph) * p.P.h, lerp(0.12, 0.34, ph));
          if (ph > 0.01) {
            st2.hand = st2.hand ?? [null, null];
            st2.hand = [st2.hand[0], hp];
          }
          p.phone.visible = ph > 0.05;
          p.phone.position.copy(hp).add(V(0, 0.06, 0.02));
          p.phone.rotation.set(0.45, 0, 0);
          const torch = r.phone > -50 ? ph * night : 0;
          p.phone.userData.tb.material.uniforms.uI.value = (0.55 * torch) / adapt;
          p.phone.userData.scr.material.color.setRGB(0.5 + 0.6 * night, 0.62 + 0.6 * night, 0.9 + 0.8 * night);
        }
        posePerson(p.P, st2);
      }
      pedTorch.intensity = 0.5 * clamp01((PEOPLE[1].phone.userData.tb.material.uniforms.uI.value * adapt) / 0.55);

      // ---- friend: looks up, finds the phone torch, shields their eyes when the Sun comes back
      {
        const lk = D > 0 ? smooth((D - DK.look) / 0.5) * (1 - smooth((D - 6.8) / 0.8)) : 0;
        const ph = D > 0 ? smooth((D - 3.5) / 0.6) * (1 - smooth((D - CK.dark - 1.2) / 0.6)) : 0;
        const shield = t >= TS ? smooth((t - TS - 0.1) / 0.35) * (1 - smooth((t - TS - 2.6) / 0.8)) : 0;
        const fr = friend.root;
        fr.updateMatrixWorld();
        const handPh = V(-0.12, lerp(0.88, 1.06, ph) * friend.h, lerp(0.25, 0.42, ph));
        const lh = shield > 0.01 ? V(0.02, 1.42 * friend.h, 0.2).lerp(fr.worldToLocal(V(-7.3, TOP + 0.03, 0.17)), 1 - shield) : fr.worldToLocal(V(-7.3, TOP + 0.03, 0.17));
        const rh = ph > 0.01 ? handPh.clone().lerp(fr.worldToLocal(V(-7.32, TOP + 0.03, -0.17)), 1 - ph) : fr.worldToLocal(V(-7.32, TOP + 0.03, -0.17));
        posePerson(friend, {mode: 'sit', phase: 0, amp: 0, lean: 0.1, twist: 0, headYaw: -0.6 * lk + 0.05 * Math.sin(W * 0.8), headPitch: 0.55 * lk - 0.25 * ph * (1 - lk) - 0.3 * shield, hand: [lh, rh]});
        fPhone.visible = ph > 0.05;
        fPhone.position.copy(fr.localToWorld(handPh.clone().add(V(0, 0.06, 0.02))));
        fPhone.quaternion.copy(fr.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.95, 0, 0)));
        fPhone.userData.tb.material.uniforms.uI.value = (0.12 * ph * night) / adapt;
        fPhone.userData.scr.material.color.setRGB(0.5 + 0.6 * night, 0.62 + 0.6 * night, 0.9 + 0.8 * night);
        fTorch.intensity = 0.12 * ph * night;
      }

      // ---- cars
      for (const k of CARS) {
        const dist = distAt(k.T, W);
        const z = wrapR(k.zs + k.dir * k.v * (dist - k.ref), -38, 48);
        k.c.position.set(k.x, 0, z);
        k.c.rotation.y = k.dir > 0 ? 0 : Math.PI;
        k.c.userData.wheels.forEach((w) => (w.rotation.x = (k.v * dist) / 0.34));
        const on = D > 0 ? smooth((D - DK.headlights) / 0.15) * (1 - smooth((D - CK.dark - 3) / 0.3)) : 0;
        k.beams.forEach((b) => (b.material.uniforms.uI.value = (0.5 * on * night) / adapt));
        k.lamps.forEach((l) => (l.material.emissiveIntensity = 0.4 + 5 * on));
        if (k.light) k.light.intensity = 30 * on * night;
      }
      trees.forEach((tr) => (tr.userData.crown.rotation.z = 0.012 * Math.sin(Math.min(W, WD0 + 40) * 0.9 + tr.userData.ph)));

      st.render();

      // ---------------------------------------------------------------- overlay
      vig.style.opacity = (0.4 + 0.45 * night).toFixed(3);
      const tk = smooth((t - TV + 0.1) / 0.5);
      titleEl.style.transform = `translateY(${(-18 * tk).toFixed(1)}px) scale(${(1 - 0.18 * tk).toFixed(4)})`;
      if (t < TV) {
        const gl = smooth((t - TV + 0.6) / 0.6);
        tileEl.style.opacity = '1';
        tileEl.style.transform = `translate(${(gl * 6 * Math.sin(t * 83)).toFixed(1)}px, 0) scale(${(1 + 0.04 * Math.sin(t * 3)).toFixed(4)})`;
        tileEl.style.filter = gl > 0.2 ? `drop-shadow(${(-gl * 5).toFixed(1)}px 0 0 rgba(0,220,255,0.7)) drop-shadow(${(gl * 5).toFixed(1)}px 0 0 rgba(255,40,80,0.7))` : 'none';
        shards.forEach((sd2) => (sd2.d.style.transform = 'none'));
      } else {
        const u = Math.min(t - TV, 1.2) * 0.55 + 0.02;
        tileEl.style.filter = 'none';
        tileEl.style.transform = 'none';
        tileEl.style.opacity = (1 - smooth((t - TV - 0.15) / 0.45)).toFixed(3);
        shards.forEach((sd2) => (sd2.d.style.transform = `translate(${(sd2.vx * u).toFixed(1)}px, ${(sd2.vy * u).toFixed(1)}px) rotate(${(sd2.rot * u).toFixed(1)}deg)`));
      }
      // HUD
      speedEl.textContent = fmtSpeed(spd);
      speedBox.classList.toggle('slow', spd < 0.985);
      speedBox.classList.toggle('fast', spd > 1.015);
      needle.setAttribute('transform', `rotate(${(-80 + 160 * Math.min(1, Math.log10(Math.max(spd, 0.1)) / 2.4 + 0.42)).toFixed(1)} 20 24)`);
      const pop = t >= TD ? 1 + 0.18 * Math.exp(-(t - TD) / 0.18) : 1;
      speedBox.style.transform = `scale(${pop.toFixed(3)})`;
      if (t < TV) {
        clockLbl.textContent = 'Sun vanishes in';
        clockEl.textContent = `−${(TV - t).toFixed(1)}`;
        clockU.textContent = 's';
        clockBox.className = 'se-clock pre';
      } else if (t < TD) {
        clockLbl.textContent = 'since the Sun vanished';
        clockEl.textContent = mmss(Math.min(W, CK.light - 0.001), t >= TC ? 2 : 1);
        clockU.textContent = '';
        clockBox.className = 'se-clock ff';
      } else {
        clockLbl.textContent = t >= TS ? 'darkness lasted' : 'darkness';
        clockEl.textContent = (t >= TS ? CK.dark : Math.min(CK.dark, D)).toFixed(2);
        clockU.textContent = 's';
        clockBox.className = t >= TS ? 'se-clock done' : 'se-clock run';
      }
      const trA = smooth((t - TC + 0.1) / 0.4);
      trackEl.style.opacity = trA.toFixed(3);
      trackFill.style.width = `${((t >= TS ? 1 : clamp01(D / CK.dark)) * 100).toFixed(2)}%`;
      hudEl.style.opacity = (1 - 0.3 * smooth((t - TL.end + 0.2) / 0.4)).toFixed(3);
      // insets
      const dpr2 = insCv.width / (OW * s);
      ictx.setTransform(s * dpr2, 0, 0, s * dpr2, 0, 0);
      ictx.clearRect(0, 0, OW, OH);
      const I = TL.inset;
      const sa = smooth((t - I.in) / 0.35) * (1 - smooth((t - I.out) / 0.3));
      if (sa > 0.002) drawSpace(W, sa);
      const oa = smooth((t - I.orbitIn) / 0.35) * (1 - smooth((t - I.orbitOut) / 0.3));
      if (oa > 0.002) drawOrbit(D, oa);
      // caption
      const cp = capAt(t);
      if (cp) {
        const a = smooth((t - cp.at) / 0.22) * (1 - smooth((t - cp.until) / 0.2));
        // numbers keep their units: no line break inside '8 min 19 s'
        const head = cp.head.replace(/(\d) (min|s|W|cm)\b/g, '$1\u00a0$2').replace(/(min) (\d)/g, '$1\u00a0$2');
        if (headEl.textContent !== head) {
          headEl.textContent = head;
          subEl.textContent = cp.sub;
          stampEl.textContent = stampAt(cp);
        }
        capEl.style.opacity = a.toFixed(3);
        capEl.style.transform = `translateY(${(26 * (1 - easeOutCubic((t - cp.at) / 0.35))).toFixed(1)}px)`;
      } else capEl.style.opacity = '0';
      const ea = smooth((t - TL.end) / 0.35);
      endEl.style.opacity = ea.toFixed(3);
      endEl.style.transform = `translateY(-50%) scale(${(0.92 + 0.08 * easeOutCubic((t - TL.end) / 0.5)).toFixed(4)})`;
      flashEl.style.opacity = (t >= TS ? 0.9 * Math.exp(-(t - TS) / 0.35) : 0).toFixed(3);

      // callouts
      const dpr = lineCv.width / (OW * s);
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
        if (L.mn) L.mn.textContent = moonOff > 0.5 ? 'dark now' : 'still lit';
        const ax = p.x / s, ay = p.y / s;
        const w = L.el.offsetWidth, hh = L.el.offsetHeight;
        const lx = Math.min(OW - 150 - w, Math.max(54, ax + L.dx - (L.dx < 0 ? w : 0)));
        const ly = Math.min(1090 - hh / 2, Math.max(555 + hh / 2, ay + L.dy));
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
        lctx.fillStyle = '#ffc93a';
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
