import * as THREE from 'three';
import {runSim} from '../kit/runtime.js';
import {createStage} from '../kit/stage3d.js';
import {clamp01, hash, lerp, rng, smooth} from '../kit/util.js';
import TL from './timeline.json';

// "What if the atmosphere disappeared for 5 seconds?" over Bonifacio Global
// City, Taguig, at 10 in the morning. Real time for the hook, then the five
// airless seconds play at 0.4x: the sky goes black and shows stars, towers
// still holding one atmosphere blow their glass outward, condensation puffs
// out of every broken window, pools and fountains boil, and at second 5 the
// air slams back with one boom and the film returns to real time.
//
// The city is procedural: a BGC-like grid of glass towers on podiums, the
// High Street park strip down the middle, low-rise sprawl to the horizon and
// the Sierra Madre to the east. No real buildings, names or logos.
// Sound: sims/atmosphere/sound.py on the same timeline.json.

const DEFAULTS = {
  duration: TL.duration,
  fps: 60,
  theme: 'dark',
  hud: {enabled: false, title: 'atmosphere', subtitle: ''},
  director: {enabled: false},
  watermark: '',
  seed: 14,
};

// Screen time t -> event time te (seconds since the air vanished).
// Real time before and after, TL.slow during the five seconds.
const OFF = TL.off, BACK = TL.back, SLOW = TL.slow, EV = TL.event;
const eventTime = (t) => (t < OFF ? t - OFF : t < BACK ? (t - OFF) * SLOW : EV + (t - BACK));

// city grid (metres): avenues every GX in x, streets every GZ in z
const GX = 140, GZ = 120, KX = 7, KZ = 7;
const roadHalf = (k) => (k % 3 === 0 ? 18 : 12);
const PARK = {x: 22, z: 380}; // High Street strip along z at x = 0
const SUN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 50), THREE.MathUtils.degToRad(48)).normalize();

const NOISE = /* glsl */ `
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float h31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
`;

const SKY_VERT = /* glsl */ `
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
// Day sky with drifting cumulus, or (no air) black with stars and a hard sun.
// uRet sweeps the returning air up from the horizon.
const SKY_FRAG = /* glsl */ `
uniform vec3 uSun; uniform float uAir; uniform float uRet; uniform float uCloud; uniform float uT; uniform float uFlash;
varying vec3 vW;
${NOISE}
void main(){
  vec3 d = normalize(vW - cameraPosition);
  float el = d.y, e = max(el, 0.0);
  float air = max(uAir, smoothstep(0.0, 0.3, uRet * 1.4 - e));
  vec3 zen = vec3(0.05, 0.16, 0.52), hor = vec3(0.52, 0.66, 0.84);
  vec3 day = mix(hor, zen, pow(e, 0.5));
  if (el < 0.0) day = hor * 0.9;
  float sd = max(dot(d, uSun), 0.0);
  day += vec3(1.0, 0.92, 0.8) * (pow(sd, 8.0) * 0.18 + pow(sd, 150.0) * 0.9);
  if (el > 0.0) {
    vec2 p = d.xz / (el + 0.06) * 0.9 + vec2(uT * 0.006, uT * 0.002);
    float n = fbm(p);
    float c = smoothstep(0.5, 0.7, n) * smoothstep(0.0, 0.12, el) * uCloud;
    float lit = smoothstep(0.45, 0.85, fbm(p * 1.9 + 3.0));
    day = mix(day, mix(vec3(0.5, 0.55, 0.64), vec3(1.05, 1.03, 1.0), lit), c);
  }
  vec3 vac = vec3(0.0);
  vec3 q = d * 300.0; vec3 id = floor(q); float h = h31(id);
  if (h > 0.982) {
    vec3 c = id + 0.5 + (vec3(h31(id + 1.3), h31(id + 2.7), h31(id + 5.1)) - 0.5) * 0.5;
    float r = length(q - c);
    float b = 0.35 + 2.2 * pow((h - 0.982) / 0.018, 3.0);
    vac += mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.9, 0.75), h31(id + 9.0)) * exp(-r * r * 9.0) * b;
  }
  vac *= smoothstep(-0.01, 0.06, el);
  vac += vec3(1.0, 0.97, 0.92) * (pow(sd, 3000.0) * 1.5 + pow(sd, 300.0) * 0.08);
  vec3 col = mix(vac, day, air);
  col += vec3(1.0, 0.96, 0.9) * smoothstep(0.99996, 0.99998, sd) * mix(9.0, 6.0, air);
  col += vec3(1.0) * uFlash;
  gl_FragColor = vec4(col, 1.0);
}`;

// Water: blue with sun ripples, white boiling froth when the pressure goes.
const WATER_FRAG = /* glsl */ `
uniform float uBoil; uniform float uT; uniform float uAir;
varying vec3 vW;
${NOISE}
void main(){
  vec2 p = vW.xz * 0.5;
  float r = fbm(p + uT * 0.4);
  vec3 c = mix(vec3(0.02, 0.18, 0.32), vec3(0.15, 0.5, 0.7), r) * mix(0.4, 1.0, uAir);
  float f = fbm(p * 3.0 + uT * 9.0);
  float froth = smoothstep(0.75 - 0.5 * uBoil, 0.85, f + 0.1 * fbm(p * 9.0 - uT * 13.0)) * uBoil;
  c = mix(c, vec3(1.2, 1.25, 1.3), froth);
  gl_FragColor = vec4(c, 1.0);
}`;

// Glass shards: ballistic (no air, no drag), land and lie on the street.
const SHARD_VERT = /* glsl */ `
attribute vec3 aV; attribute vec2 aB;
uniform float uTe; uniform float uScale;
varying float vA; varying float vG;
void main(){
  float tau = uTe - aB.x;
  vA = 0.0; vG = 0.0;
  if (tau < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float vy = aV.y, y0 = position.y;
  float tl = (vy + sqrt(vy * vy + 19.62 * y0)) / 9.81;
  float tc = min(tau, tl);
  vec3 p = position + aV * tc + vec3(0.0, -4.905 * tc * tc, 0.0);
  p.y = max(p.y, 0.2);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vG = pow(0.5 + 0.5 * sin(aB.y * 60.0 + tau * (5.0 + aB.y * 16.0)), 12.0);
  float sz = 0.7 * uScale / max(1.0, -mv.z);
  vA = (tau < tl ? 1.0 : 0.3) * clamp(sz / 1.4, 0.25, 1.0) * smoothstep(0.0, 0.04, tau);
  gl_PointSize = clamp(sz * (1.0 + vG), 1.4, 16.0);
  gl_Position = projectionMatrix * mv;
}`;
const SHARD_FRAG = /* glsl */ `
uniform float uI;
varying float vA; varying float vG;
void main(){
  vec2 p = gl_PointCoord - 0.5; float d = dot(p, p) * 4.0;
  if (d > 1.0) discard;
  vec3 c = mix(vec3(0.16, 0.22, 0.26), vec3(2.4, 2.3, 2.1), vG);
  gl_FragColor = vec4(c * (1.0 - d) * vA * uI, 1.0);
}`;

// Soft puffs: condensation out of windows, boiling vapour, returning dust.
// Each has a birth time, a life, start/end size and an exit speed that drags out.
const PUFF_VERT = /* glsl */ `
attribute vec3 aV; attribute vec2 aB; attribute vec3 aS;
uniform float uTe; uniform float uScale; uniform float uDrag; uniform float uLift;
varying float vA;
void main(){
  float age = uTe - aB.x; float k = age / aB.y;
  vA = 0.0;
  if (k < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec3 p = position + aV * (1.0 - exp(-age * uDrag)) / uDrag + vec3(0.0, uLift * age * age, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float r = mix(aS.x, aS.y, sqrt(k));
  gl_PointSize = clamp(r * uScale / max(1.0, -mv.z), 1.0, 380.0);
  vA = aS.z * smoothstep(0.0, 0.06, k) * pow(1.0 - k, 1.6);
  gl_Position = projectionMatrix * mv;
}`;
const PUFF_FRAG = /* glsl */ `
uniform vec3 uCol;
varying float vA;
void main(){
  vec2 p = gl_PointCoord - 0.5; float d = dot(p, p) * 4.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(uCol, vA * pow(1.0 - d, 1.5));
}`;

const caps = TL.captions;

runSim(DEFAULTS, async ({cfg, canvas, hud, capture}) => {
  await Promise.all([document.fonts.load('700 20px "JetBrains Mono"'), document.fonts.load('800 20px Inter'), document.fonts.load('600 20px Inter')]).catch(() => {});
  const st = createStage(canvas, hud, {bg: '#000000', capture, fov: 60, exposure: 0.9, bloom: {strength: 0.4, radius: 0.45, threshold: 0.9}});
  const {scene, camera, renderer} = st;
  camera.near = 1;
  camera.far = 90000;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const R = rng(cfg.seed);

  // ---- camera path (screen time). Built first so towers keep out of its way.
  const KEYS = [
    [0, [-640, 330, 800], [60, 40, -80]],
    [4, [-540, 280, 660], [60, 50, -70]],
    [8, [-380, 175, 450], [40, 80, -40]],
    [12, [-240, 85, 290], [20, 150, 160]],
    [15, [-170, 46, 215], [160, 300, 420]],
    [16.5, [-162, 44, 206], [170, 310, 430]],
    [19.5, [-330, 170, 440], [60, 80, 0]],
    [24, [-780, 410, 960], [60, 40, -80]],
  ];
  const curve = (i) => new THREE.CatmullRomCurve3(KEYS.map((k) => new THREE.Vector3(...k[i])), false, 'centripetal');
  const camCurve = curve(1), tgtCurve = curve(2);
  const keyU = (t) => {
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (t <= KEYS[i + 1][0]) return (i + smooth((t - KEYS[i][0]) / (KEYS[i + 1][0] - KEYS[i][0])) * 0.5 + ((t - KEYS[i][0]) / (KEYS[i + 1][0] - KEYS[i][0])) * 0.5) / (KEYS.length - 1);
    }
    return 1;
  };
  const pathPts = [];
  for (let i = 0; i <= 400; i++) pathPts.push(camCurve.getPoint(i / 400));

  // ---- sky dome (follows the camera) and a day copy for reflections
  const skyU = {uSun: {value: SUN.clone()}, uAir: {value: 1}, uRet: {value: 0}, uCloud: {value: 1}, uT: {value: 0}, uFlash: {value: 0}};
  const skyMat = new THREE.ShaderMaterial({vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false});
  const sky = new THREE.Mesh(new THREE.SphereGeometry(80000, 64, 32), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), new THREE.ShaderMaterial({vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: {...skyU, uSun: {value: SUN.clone()}, uAir: {value: 1}, uRet: {value: 0}, uCloud: {value: 1}, uT: {value: 0}, uFlash: {value: 0}}, side: THREE.BackSide})));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;

  const sun = new THREE.DirectionalLight('#fff1dc', 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, {left: -1100, right: 1100, top: 1100, bottom: -1100, near: 100, far: 5000});
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 1.2;
  sun.position.copy(SUN).multiplyScalar(2500);
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#9fc4ff', '#6b5d4c', 1.1);
  scene.add(hemi);
  const fogDay = new THREE.Color(0.5, 0.63, 0.8);
  scene.fog = new THREE.FogExp2(fogDay.clone(), 0.00004);

  // ---- ground: avenues, sidewalks, the High Street park, sprawl beyond
  const groundMat = new THREE.MeshStandardMaterial({color: '#ffffff', roughness: 0.92, metalness: 0});
  groundMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWP;\n${NOISE}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec2 w = vWP.xz;
        float core = step(abs(w.x), ${(KX * GX).toFixed(1)}) * step(abs(w.y), ${(KZ * GZ).toFixed(1)});
        float kx = floor(w.x / ${GX.toFixed(1)} + 0.5), kz = floor(w.y / ${GZ.toFixed(1)} + 0.5);
        float dx = abs(w.x - kx * ${GX.toFixed(1)}), dz = abs(w.y - kz * ${GZ.toFixed(1)});
        float hx = mod(abs(kx), 3.0) < 0.5 ? 18.0 : 12.0, hz = mod(abs(kz), 3.0) < 0.5 ? 18.0 : 12.0;
        float aa = fwidth(w.x) + fwidth(w.y) + 0.001;
        float road = max(1.0 - smoothstep(hx - aa, hx + aa, dx), 1.0 - smoothstep(hz - aa, hz + aa, dz));
        float walk = max(1.0 - smoothstep(hx + 5.0 - aa, hx + 5.0 + aa, dx), 1.0 - smoothstep(hz + 5.0 - aa, hz + 5.0 + aa, dz));
        float park = step(abs(w.x), ${PARK.x.toFixed(1)}) * step(abs(w.y), ${PARK.z.toFixed(1)});
        float n = fbm(w * 0.02);
        vec3 blockC = mix(vec3(0.34, 0.33, 0.31), vec3(0.42, 0.41, 0.38), n);
        vec3 c = mix(blockC, vec3(0.5, 0.49, 0.46), walk);
        float dash = step(0.5, fract((dx < hx ? w.y : w.x) / 9.0)) * (1.0 - smoothstep(0.25, 0.25 + aa, min(dx, dz)));
        c = mix(c, vec3(0.07, 0.075, 0.08) + 0.02 * n, road);
        c = mix(c, vec3(0.55), dash * road * 0.6);
        vec3 grass = mix(vec3(0.08, 0.2, 0.06), vec3(0.14, 0.28, 0.08), fbm(w * 0.15));
        float path = 1.0 - smoothstep(2.0, 2.0 + aa, abs(w.x - 7.0 * sin(w.y * 0.03)));
        c = mix(c, mix(grass, vec3(0.5, 0.47, 0.42), path), park);
        // sprawl: older low-rise districts, lanes every 70 m
        float sx = abs(w.x - floor(w.x / 70.0 + 0.5) * 70.0), sz = abs(w.y - floor(w.y / 70.0 + 0.5) * 70.0);
        vec3 out_ = mix(vec3(0.28, 0.26, 0.23), vec3(0.36, 0.34, 0.3), fbm(w * 0.004));
        out_ = mix(out_, vec3(0.1, 0.1, 0.1), (1.0 - smoothstep(5.0 - aa, 5.0 + aa, min(sx, sz))) * 0.8);
        out_ = mix(out_, vec3(0.12, 0.2, 0.08), smoothstep(0.62, 0.7, fbm(w * 0.003 + 4.0)));
        c = mix(out_, c, core);
        diffuseColor.rgb = c;`,
      );
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120000, 120000), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- towers (instanced boxes; facades drawn in the shader)
  const towers = [];
  const nearPath = (cx, cz, half, h) => {
    for (const p of pathPts) {
      if (p.y > h + 40) continue;
      if (Math.abs(p.x - cx) < half + 30 && Math.abs(p.z - cz) < half + 30) return true;
    }
    return false;
  };
  for (let ix = -KX; ix < KX; ix++) {
    for (let iz = -KZ; iz < KZ; iz++) {
      const x0 = ix * GX + roadHalf(Math.abs(ix)) + 5, x1 = (ix + 1) * GX - roadHalf(Math.abs(ix + 1)) - 5;
      const z0 = iz * GZ + roadHalf(Math.abs(iz)) + 5, z1 = (iz + 1) * GZ - roadHalf(Math.abs(iz + 1)) - 5;
      const bx0 = ix === 0 ? Math.max(x0, PARK.x + 6) : x0, bx1 = ix === -1 ? Math.min(x1, -PARK.x - 6) : x1;
      const cx = (bx0 + bx1) / 2, cz = (z0 + z1) / 2;
      const r = Math.hypot(cx * 0.9, cz);
      if (R() < 0.75) towers.push({x: cx, z: cz, w: (bx1 - bx0) * 0.94, d: (z1 - z0) * 0.94, h: 8 + R() * 14, kind: 2});
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          if (R() > 0.85 * Math.exp(-Math.pow(r / 1100, 2)) + 0.12) continue;
          const lw = (bx1 - bx0) / 2, ld = (z1 - z0) / 2;
          const s = Math.min(lw, ld) * (0.62 + R() * 0.3);
          const tx = bx0 + lw * (a + 0.5) + (R() - 0.5) * (lw - s) * 0.6;
          const tz = z0 + ld * (b + 0.5) + (R() - 0.5) * (ld - s) * 0.6;
          const h = 45 + 210 * Math.exp(-Math.pow(r / 520, 2)) * (0.45 + R() * 0.75) + R() * 50;
          if (nearPath(tx, tz, s / 2, h)) continue;
          const w = s * (0.85 + R() * 0.3), d = s * (0.85 + R() * 0.3);
          const T = {x: tx, z: tz, w, d, h, kind: R() < 0.72 ? 0 : 1};
          towers.push(T);
          if (R() < 0.35) {
            T.capped = true;
            towers.push({x: tx, z: tz, w: w * 0.62, d: d * 0.62, h: h + 8 + R() * 22, kind: 0, crown: true});
          }
        }
      }
    }
  }
  const NT = towers.length;
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const tGeo = boxGeo.clone();
  const info = new Float32Array(NT * 4);
  towers.forEach((T, i) => {
    T.seed = R() * 100;
    // window blowout starts per tower; podiums (kind 2) are lower and go later
    T.br = TL.windows + R() * 1.3 + (T.kind === 2 ? 0.4 : 0);
    info.set([T.seed, T.br, R(), T.kind], i * 4);
  });
  tGeo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
  const towerU = {uTe: {value: -10}};
  const towerMat = new THREE.MeshStandardMaterial({color: '#ffffff', roughness: 0.5, metalness: 0.2, envMapIntensity: 1});
  towerMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTe = towerU.uTe;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aInfo; varying vec4 vInfo; varying vec3 vWP; varying vec3 vON;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvInfo = aInfo; vON = normal; vWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTe; varying vec4 vInfo; varying vec3 vWP; varying vec3 vON;\n${NOISE}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 on = normalize(vON);
        float u = abs(on.x) > 0.5 ? vWP.z : vWP.x;
        float kind = vInfo.w;
        float colW = kind < 0.5 ? 1.6 : 2.6, flH = kind > 1.5 ? 4.6 : 3.8;
        float fu = fract(u / colW), fv = fract(vWP.y / flH);
        float wu = fwidth(u / colW) + 1e-4, wv = fwidth(vWP.y / flH) + 1e-4;
        float mull = smoothstep(0.06 - wu, 0.06 + wu, fu) * smoothstep(0.06 - wu, 0.06 + wu, 1.0 - fu);
        float spand = kind < 0.5 ? 0.2 : 0.45;
        float band = smoothstep(spand - wv, spand + wv, fv) * smoothstep(0.04 - wv, 0.04 + wv, 1.0 - fv);
        if (kind > 0.5) mull = mix(mull, 1.0, 0.75);
        float glass = mull * band;
        float fine = clamp(max(wu, wv) * 1.6 - 0.35, 0.0, 1.0);
        glass = mix(glass, kind < 0.5 ? 0.66 : 0.4, fine);
        if (abs(on.y) > 0.5) glass = 0.0;
        // each window lets go at its own moment; a few hold
        vec3 cell = vec3(floor(u / colW), floor(vWP.y / flH), vInfo.x + on.x * 3.0 + on.z * 7.0);
        float hw = h31(cell);
        float bt = vInfo.y + hw * 1.1 + vWP.y * 0.0015;
        float broken = step(bt, uTe) * step(h31(cell + 3.1), 0.9);
        broken = mix(broken, clamp((uTe - vInfo.y) / 1.4, 0.0, 0.85), fine);
        vec3 tint = mix(vec3(0.42, 0.55, 0.6), vec3(0.55, 0.6, 0.58), vInfo.z);
        if (vInfo.z > 0.7) tint = vec3(0.45, 0.5, 0.62);
        vec3 frameC = kind > 0.5 ? mix(vec3(0.62, 0.6, 0.56), vec3(0.75, 0.73, 0.68), vInfo.z) : mix(vec3(0.18, 0.19, 0.21), vec3(0.5, 0.51, 0.52), vInfo.z);
        vec3 roofC = vec3(0.36, 0.36, 0.35) * (0.8 + 0.3 * vnoise(vWP.xz * 0.3));
        vec3 inside = vec3(0.025, 0.022, 0.02);
        vec3 baseC = abs(on.y) > 0.5 ? roofC : frameC;
        float g = glass * (1.0 - broken);
        diffuseColor.rgb = mix(mix(baseC, inside, glass * broken), tint * 0.22, g);
        metalnessFactor = mix(0.05, 0.9, g);
        roughnessFactor = mix(0.75, 0.1, g);`,
      );
  };
  const towerMesh = new THREE.InstancedMesh(tGeo, towerMat, NT);
  const m4 = new THREE.Matrix4();
  towers.forEach((T, i) => towerMesh.setMatrixAt(i, m4.makeScale(T.w, T.h, T.d).setPosition(T.x, 0, T.z)));
  towerMesh.castShadow = towerMesh.receiveShadow = true;
  scene.add(towerMesh);

  // ---- sprawl: low-rise to the horizon
  const SPR = [];
  for (let i = 0; i < 9000; i++) {
    const a = R() * Math.PI * 2, rr = 1150 + Math.pow(R(), 0.7) * 5200;
    const x = Math.cos(a) * rr * 1.1, z = Math.sin(a) * rr;
    if (Math.abs(x) < KX * GX + 40 && Math.abs(z) < KZ * GZ + 40) continue;
    SPR.push([x, z, 14 + R() * 26, 14 + R() * 26, 5 + Math.pow(R(), 3) * 40]);
  }
  const sprMesh = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({roughness: 0.85, metalness: 0}), SPR.length);
  const col = new THREE.Color();
  SPR.forEach(([x, z, w, d, h], i) => {
    sprMesh.setMatrixAt(i, m4.makeScale(w, h, d).setPosition(x, 0, z));
    sprMesh.setColorAt(i, col.setHSL(0.08 + R() * 0.05, 0.1 + R() * 0.15, 0.35 + R() * 0.3));
  });
  sprMesh.castShadow = sprMesh.receiveShadow = true;
  scene.add(sprMesh);

  // ---- trees: High Street and avenue edges
  const TREES = [];
  for (let i = 0; i < 520; i++) TREES.push([(R() - 0.5) * PARK.x * 1.6, (R() - 0.5) * PARK.z * 2]);
  for (let i = 0; i < 1400; i++) {
    const kx = Math.round((R() - 0.5) * 2 * KX), along = (R() - 0.5) * 2 * KZ * GZ, side = R() < 0.5 ? -1 : 1;
    if (kx === 0) continue;
    const x = kx * GX + side * (roadHalf(Math.abs(kx)) + 2.5);
    if (R() < 0.5) TREES.push([x, along]);
    else TREES.push([along * 1.1, Math.round((R() - 0.5) * 2 * KZ) * GZ + side * 14.5]);
  }
  const treeMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({roughness: 0.9, flatShading: true}), TREES.length);
  TREES.forEach(([x, z], i) => {
    const s = 3 + R() * 3;
    treeMesh.setMatrixAt(i, m4.makeScale(s, s * 0.9, s).setPosition(x, s * 0.9 + 1.5, z));
    treeMesh.setColorAt(i, col.setHSL(0.24 + R() * 0.08, 0.5, 0.14 + R() * 0.1));
  });
  treeMesh.castShadow = true;
  scene.add(treeMesh);

  // ---- mountains to the east (Sierra Madre direction)
  {
    const N = 400, pos = [];
    const ridge = (z) => 380 + 900 * Math.pow(Math.abs(Math.sin(z * 0.00007 + 1.3)), 1.4) * (0.6 + 0.4 * hash(Math.floor(z / 900))) + 160 * Math.sin(z * 0.0011);
    for (let i = 0; i < N; i++) {
      const za = -60000 + (120000 * i) / N, zb = -60000 + (120000 * (i + 1)) / N;
      const xa = 24000 + 3000 * Math.sin(za * 0.00005), xb = 24000 + 3000 * Math.sin(zb * 0.00005);
      pos.push(xa - 3000, 0, za, xa, ridge(za), za, xb, ridge(zb), zb, xa - 3000, 0, za, xb, ridge(zb), zb, xb - 3000, 0, zb);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({color: '#3c4a3a', roughness: 1, side: THREE.DoubleSide})));
  }

  // ---- water: rooftop pools and the High Street fountains
  const waterU = {uBoil: {value: 0}, uT: {value: 0}, uAir: {value: 1}};
  const waterMat = new THREE.ShaderMaterial({vertexShader: SKY_VERT, fragmentShader: WATER_FRAG, uniforms: waterU});
  const POOLS = [];
  for (let k = 0; k < 4; k++) POOLS.push({x: 0, y: 0.35, z: -270 + k * 180, w: 18, d: 46});
  towers
    .filter((T) => T.kind === 0 && !T.crown && !T.capped && T.h < 150 && T.w > 26)
    .slice(0, 22)
    .forEach((T) => POOLS.push({x: T.x, y: T.h + 0.4, z: T.z + T.d * 0.12, w: T.w * 0.6, d: T.d * 0.3}));
  for (const P of POOLS) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(P.w, P.d), waterMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(P.x, P.y, P.z);
    scene.add(m);
  }

  // ---- cars (coast on: no air needed to keep rolling)
  const CARS = [];
  for (let i = 0; i < 900; i++) {
    const alongX = R() < 0.5, k = Math.round((R() - 0.5) * 2 * KX);
    if (!alongX && k === 0) continue;
    const dir = R() < 0.5 ? -1 : 1;
    CARS.push({alongX, line: (alongX ? GZ : GX) * k + dir * (3 + R() * 6), dir, s0: R() * 2000, v: 7 + R() * 7});
  }
  const carMesh = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({roughness: 0.35, metalness: 0.5}), CARS.length);
  CARS.forEach((c, i) => carMesh.setColorAt(i, col.setHSL(R(), R() * 0.4, 0.15 + R() * 0.65)));
  carMesh.castShadow = true;
  scene.add(carMesh);
  const L = 2 * KX * GX;

  // ---- particles
  const scaleU = {value: 1000};
  const pts = (n, fill, mat) => {
    const g = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), V = new Float32Array(n * 3), B = new Float32Array(n * 2), S = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) fill(i, P, V, B, S);
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('aV', new THREE.BufferAttribute(V, 3));
    g.setAttribute('aB', new THREE.BufferAttribute(B, 2));
    g.setAttribute('aS', new THREE.BufferAttribute(S, 3));
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    scene.add(p);
    return p;
  };
  // a random point on a random window of a tower near the camera
  const glassTowers = towers.filter((T) => T.kind !== 2 && Math.hypot(T.x + 200, T.z - 250) < 900);
  const onFacade = (T, P, V, i, speed) => {
    const face = Math.floor(R() * 4);
    const nx = face === 0 ? 1 : face === 1 ? -1 : 0, nz = face === 2 ? 1 : face === 3 ? -1 : 0;
    const x = T.x + (nx ? (nx * T.w) / 2 + nx * 0.3 : (R() - 0.5) * T.w);
    const z = T.z + (nz ? (nz * T.d) / 2 + nz * 0.3 : (R() - 0.5) * T.d);
    const y = 4 + R() * (T.h - 6);
    P.set([x, y, z], i * 3);
    const sp = speed * (0.4 + R() * 0.8);
    V.set([nx * sp + (R() - 0.5) * sp * 0.5, (R() - 0.3) * sp * 0.35, nz * sp + (R() - 0.5) * sp * 0.5], i * 3);
    return y;
  };
  const shardMat = new THREE.ShaderMaterial({
    vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG,
    uniforms: {uTe: {value: -10}, uScale: scaleU, uI: {value: 1}},
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const shards = pts(90000, (i, P, V, B) => {
    const T = glassTowers[Math.floor(R() * glassTowers.length)];
    const y = onFacade(T, P, V, i, 32);
    B.set([T.br + R() * 1.1 + y * 0.0015, R()], i * 2);
  }, shardMat);
  const puffMat = (color, opacity, drag, lift, blending = THREE.NormalBlending) =>
    new THREE.ShaderMaterial({
      vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG,
      uniforms: {uTe: {value: -10}, uScale: scaleU, uDrag: {value: drag}, uLift: {value: lift}, uCol: {value: new THREE.Color(color).multiplyScalar(opacity)}},
      transparent: true, depthWrite: false, blending,
    });
  // humid air rushing out of a window expands, cools and fogs for an instant
  const vents = pts(14000, (i, P, V, B, S) => {
    const T = glassTowers[Math.floor(R() * glassTowers.length)];
    const y = onFacade(T, P, V, i, 70);
    B.set([T.br + R() * 1.1 + y * 0.0015, 0.5 + R() * 0.6], i * 2);
    S.set([1.5, 8 + R() * 10, 0.2], i * 3);
  }, puffMat('#f2f5f8', 1, 5, 0));
  // boiling water: vapour bursting off every pool and fountain
  const vapour = pts(16000, (i, P, V, B, S) => {
    const W = POOLS[Math.floor(R() * POOLS.length)];
    P.set([W.x + (R() - 0.5) * W.w, W.y + 0.3, W.z + (R() - 0.5) * W.d], i * 3);
    const a = R() * Math.PI * 2, sp = 3 + R() * 14;
    V.set([Math.cos(a) * sp * 0.6, sp, Math.sin(a) * sp * 0.6], i * 3);
    B.set([TL.boil + Math.pow(R(), 0.7) * (EV - TL.boil + 0.2), 0.7 + R() * 0.9], i * 2);
    S.set([1, 7 + R() * 9, 0.28], i * 3);
  }, puffMat('#ffffff', 1, 1.2, 0));
  // the return: dust slammed off every street at once
  const dust = pts(9000, (i, P, V, B, S) => {
    const alongX = R() < 0.5, k = Math.round((R() - 0.5) * 2 * KX);
    const along = (R() - 0.5) * 2 * (alongX ? KX * GX : KZ * GZ);
    P.set(alongX ? [along, 1, k * GZ] : [k * GX, 1, along], i * 3);
    const a = R() * Math.PI * 2, sp = 4 + R() * 10;
    V.set([Math.cos(a) * sp, 2 + R() * 8, Math.sin(a) * sp], i * 3);
    B.set([EV + R() * 0.35, 2.5 + R() * 3.5], i * 2);
    S.set([4, 26 + R() * 30, 0.16], i * 3);
  }, puffMat('#c9bca6', 1, 1.6, 0.15));

  // ---- overlay: location, pressure, event clock, captions
  const ov = document.createElement('div');
  ov.className = 'a-ov';
  ov.innerHTML = `
    <div class="a-loc"><i></i><div><b>BONIFACIO GLOBAL CITY</b><span>Taguig, Metro Manila · 14.55° N 121.05° E · 10:00 AM</span></div></div>
    <div class="a-clock"><span class="a-lab"></span><b></b><div class="a-bar"><em></em></div><div class="a-slow"><i></i>SLOW MOTION 0.4×</div></div>
    <div class="a-pa"><span>AIR PRESSURE</span><b></b></div>
    <div class="a-cap"></div>
    <div class="a-vig"></div>`;
  document.getElementById('app').appendChild(ov);
  const $ = (s) => ov.querySelector(s);
  const clockLab = $('.a-clock .a-lab'), clockNum = $('.a-clock b'), clockBar = $('.a-bar em'), slowEl = $('.a-slow'), clockEl = $('.a-clock');
  const paEl = $('.a-pa b'), paBox = $('.a-pa'), capEl = $('.a-cap'), vig = $('.a-vig'), locEl = $('.a-loc');
  const CAPS = caps.map(([t0, t1, text]) => {
    const el = document.createElement('div');
    el.className = 'a-line';
    const words = text.split(' ').map((w) => {
      const s = document.createElement('span');
      s.textContent = w;
      el.appendChild(s);
      el.appendChild(document.createTextNode(' '));
      return s;
    });
    capEl.appendChild(el);
    return {t0, t1, el, words};
  });

  const OW = 1080;
  let s = 1;
  const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();

  return {
    resize() {
      st.resize();
      s = innerWidth / OW;
      ov.style.width = `${OW}px`;
      ov.style.height = `${innerHeight / s}px`;
      ov.style.transform = `scale(${s})`;
      scaleU.value = (innerHeight * (capture ? 1 : Math.min(devicePixelRatio || 1, 2))) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    },
    render(t) {
      const te = eventTime(t);
      const off = te >= 0 && te < EV;
      // air: gone in 0.08 s of event time, back from the horizon up after second 5
      const airOut = te < 0 ? 1 : 1 - clamp01(te / 0.08);
      const ret = te < EV ? 0 : clamp01((te - EV) / 0.9);
      const air = Math.max(airOut, ret);
      skyU.uAir.value = airOut;
      skyU.uRet.value = ret;
      skyU.uCloud.value = te < 0 ? 1 : 1 - smooth(te / 2.6);
      skyU.uT.value = te + 40;
      const flash = te >= EV ? Math.exp(-(te - EV) * 9) * 0.9 : 0;
      skyU.uFlash.value = flash;
      hemi.intensity = 0.04 + 1.06 * air;
      sun.intensity = 3.4 + 0.8 * (1 - air);
      towerMat.envMapIntensity = 0.04 + 0.96 * air;
      // no air, no haze; the returning air comes back dusty
      const dusty = te >= EV ? Math.exp(-(te - EV) / 3) * smooth((te - EV) / 0.5) : 0;
      scene.fog.density = 0.00004 * air + 0.0006 * dusty;
      scene.fog.color.copy(fogDay).lerp(new THREE.Color(0.55, 0.5, 0.44), dusty);
      waterU.uT.value = te + 40;
      waterU.uAir.value = air;
      waterU.uBoil.value = off ? smooth((te - TL.boil) / 0.5) : te >= EV ? 1 - smooth((te - EV) / 1.5) : 0;
      towerU.uTe.value = te;
      for (const p of [shards, vents, vapour, dust]) p.material.uniforms.uTe.value = te;

      CARS.forEach((c, i) => {
        const a = ((((c.s0 + c.dir * c.v * (te + 10)) % L) + L) % L) - L / 2;
        const x = c.alongX ? a : c.line, z = c.alongX ? c.line : a;
        carMesh.setMatrixAt(i, m4.makeScale(c.alongX ? 4.6 : 1.9, 1.5, c.alongX ? 1.9 : 4.6).setPosition(x, 0, z));
      });
      carMesh.instanceMatrix.needsUpdate = true;

      // camera: on the path, a jolt as the air leaves, a hard shake when it returns
      const u = keyU(t);
      camCurve.getPoint(u, camPos);
      tgtCurve.getPoint(u, camTgt);
      const shake = (te >= EV ? Math.exp(-(te - EV) * 2.2) * 3.2 : 0) + (te >= 0 && te < 0.4 ? (1 - te / 0.4) * 0.5 : 0);
      if (shake > 0.001) {
        const f = Math.floor(t * 60);
        camPos.x += (hash(f) - 0.5) * shake;
        camPos.y += (hash(f + 77) - 0.5) * shake;
        camTgt.x += (hash(f + 13) - 0.5) * shake * 3;
        camTgt.y += (hash(f + 31) - 0.5) * shake * 3;
      }
      camera.position.copy(camPos);
      camera.lookAt(camTgt);
      sky.position.copy(camPos);
      st.bloomPass.strength = 0.35 + 0.25 * (1 - air);
      st.render();

      // ---- overlay
      locEl.style.opacity = (1 - 0.55 * smooth((t - OFF) / 0.4) + 0.55 * smooth((t - BACK - 2.5) / 0.6)).toFixed(3);
      const kpa = 101.3 * air;
      paEl.textContent = `${kpa.toFixed(1)} kPa`;
      paBox.classList.toggle('vac', air < 0.5);
      if (te < 0) {
        clockLab.textContent = 'ATMOSPHERE OFF IN';
        clockNum.textContent = `${(-te).toFixed(1)} s`;
        clockBar.style.width = '0%';
      } else if (te < EV) {
        clockLab.textContent = 'NO ATMOSPHERE';
        clockNum.textContent = `${te.toFixed(2)} s`;
        clockBar.style.width = `${(te / EV) * 100}%`;
      } else {
        clockLab.textContent = 'ATMOSPHERE BACK';
        clockNum.textContent = `${EV.toFixed(2)} s`;
        clockBar.style.width = '100%';
      }
      clockEl.classList.toggle('vac', off);
      clockEl.style.opacity = (1 - smooth((t - BACK - 2.8) / 0.6)).toFixed(3);
      slowEl.style.opacity = off ? (0.55 + 0.45 * Math.cos(t * 6) ** 2).toFixed(3) : '0';
      vig.style.opacity = (0.15 + 0.5 * (1 - air) + 0.8 * Math.exp(-Math.max(0, t - OFF) * 6) * (t >= OFF ? 1 : 0)).toFixed(3);

      for (const C of CAPS) {
        const a = smooth((t - C.t0) / 0.12) * (1 - smooth((t - C.t1 + 0.15) / 0.15));
        C.el.style.opacity = a.toFixed(3);
        if (a <= 0) continue;
        const span = (C.t1 - C.t0) * 0.62;
        const n = C.words.length;
        C.words.forEach((w, j) => {
          const wt = C.t0 + (span * j) / n;
          const k = clamp01((t - wt) / 0.14);
          w.style.opacity = k.toFixed(3);
          w.style.transform = `translateY(${lerp(18, 0, smooth(k)).toFixed(1)}px) scale(${lerp(0.9, 1, smooth(k)).toFixed(3)})`;
          const cur = t >= wt && t < C.t0 + (span * (j + 1)) / n + 0.25;
          w.classList.toggle('hi', cur && j === Math.min(n - 1, Math.floor(((t - C.t0) / span) * n)));
        });
      }
      return {};
    },
  };
});
