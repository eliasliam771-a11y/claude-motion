import * as THREE from 'three';
import {runSim} from '../kit/runtime.js';
import {createStage} from '../kit/stage3d.js';
import {clamp01, hash, lerp, rng, smooth} from '../kit/util.js';
import TL from './timeline.json';

// "What if all concrete vanished for 5 seconds?" in Bonifacio Global City,
// seen over the shoulder of one pedestrian on the High Street sidewalk.
// Real time for the hook, then the five seconds at 0.4x: sidewalks and roads
// drop the thickness of their slab, towers become rebar cages (steel stays),
// their glass curtain walls slide down in free fall and shatter at the base,
// lamp posts lose their footings and topple, the cages start to lean. At
// second 5 the concrete returns exactly where it was: around everyone's feet.
//
// Procedural city and crowd, no real buildings, people, names or logos.
// Sound: sims/concrete/sound.py on the same timeline.json.

const DEFAULTS = {
  duration: TL.duration,
  fps: 30,
  theme: 'dark',
  hud: {enabled: false, title: 'concrete', subtitle: ''},
  director: {enabled: false},
  watermark: '',
  seed: 31,
};

const OFF = TL.off, BACK = TL.back, SLOW = TL.slow, EV = TL.event, SLAB = TL.slab;
const eventTime = (t) => (t < OFF ? t - OFF : t < BACK ? (t - OFF) * SLOW : EV + (t - BACK));
const G = 9.81;
// how far something resting on a slab has dropped by event time te
const sink = (te) => (te <= 0 ? 0 : Math.min(SLAB, 0.5 * G * te * te));
// walkers stop within `k` seconds once the ground goes
const coast = (te, v, k) => (te <= 0 ? v * te : te < k ? v * (te - (te * te) / (2 * k)) : (v * k) / 2);

const GX = 140, GZ = 120, KX = 7, KZ = 7;
const roadHalf = (k) => (k % 3 === 0 ? 18 : 12);
const PARK = {x: 22, z: 380};
const SUN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 52), THREE.MathUtils.degToRad(60)).normalize();

const NOISE = /* glsl */ `
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float h31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float lineAA(float x, float halfW){ float w = fwidth(x) + 1e-4; float d = min(fract(x), 1.0 - fract(x)); return 1.0 - smoothstep(halfW - w, halfW + w, d); }
`;

const SKY_VERT = /* glsl */ `
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SKY_FRAG = /* glsl */ `
uniform vec3 uSun; uniform float uT;
varying vec3 vW;
${NOISE}
void main(){
  vec3 d = normalize(vW - cameraPosition);
  float el = d.y, e = max(el, 0.0);
  vec3 col = mix(vec3(0.52, 0.66, 0.84), vec3(0.05, 0.16, 0.52), pow(e, 0.5));
  if (el < 0.0) col = vec3(0.47, 0.59, 0.75);
  float sd = max(dot(d, uSun), 0.0);
  col += vec3(1.0, 0.92, 0.8) * (pow(sd, 8.0) * 0.18 + pow(sd, 150.0) * 0.9);
  if (el > 0.0) {
    vec2 p = d.xz / (el + 0.06) * 0.9 + vec2(uT * 0.006, uT * 0.002);
    float c = smoothstep(0.5, 0.7, fbm(p)) * smoothstep(0.0, 0.12, el);
    col = mix(col, mix(vec3(0.5, 0.55, 0.64), vec3(1.05, 1.03, 1.0), smoothstep(0.45, 0.85, fbm(p * 1.9 + 3.0))), c);
  }
  col += vec3(1.0, 0.96, 0.9) * smoothstep(0.99996, 0.99998, sd) * 6.0;
  gl_FragColor = vec4(col, 1.0);
}`;

// Interior slabs with the concrete gone: just the rebar mats, leaning with the cage.
const FLOOR_VERT = /* glsl */ `
attribute vec3 aLean; uniform float uBend;
varying vec3 vW;
void main(){
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  w.xz += aLean.xy * uBend * aLean.z * aLean.z;
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FLOOR_FRAG = /* glsl */ `
uniform vec3 uSun;
varying vec3 vW;
${NOISE}
void main(){
  float g = max(lineAA(vW.x / 0.6, 0.06), lineAA(vW.z / 0.6, 0.06));
  float fine = clamp((fwidth(vW.x / 0.6) - 0.25) * 2.0, 0.0, 1.0);
  g = mix(g, 0.22, fine);
  if (g < ign(gl_FragCoord.xy)) discard;
  vec3 c = vec3(0.3, 0.17, 0.1) * (0.55 + 0.45 * uSun.y);
  gl_FragColor = vec4(c, 1.0);
}`;

// Glass shards: ballistic, land and lie.
const SHARD_VERT = /* glsl */ `
attribute vec3 aV; attribute vec2 aB;
uniform float uTe; uniform float uScale; uniform float uSize; uniform float uFloor;
varying float vA; varying float vG;
void main(){
  float tau = uTe - aB.x;
  vA = 0.0; vG = 0.0;
  if (tau < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float y0 = position.y - uFloor, vy = aV.y;
  float tl = (vy + sqrt(max(0.0, vy * vy + 19.62 * y0))) / 9.81;
  float tc = min(tau, tl);
  vec3 p = position + aV * tc + vec3(0.0, -4.905 * tc * tc, 0.0);
  p.y = max(p.y, uFloor + 0.03);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vG = pow(0.5 + 0.5 * sin(aB.y * 60.0 + tau * (5.0 + aB.y * 16.0)), 12.0);
  float sz = uSize * uScale / max(0.3, -mv.z);
  vA = (tau < tl ? 1.0 : 0.55) * clamp(sz / 1.4, 0.25, 1.0) * smoothstep(0.0, 0.03, tau);
  gl_PointSize = clamp(sz * (1.0 + vG), 1.4, 28.0);
  gl_Position = projectionMatrix * mv;
}`;
const SHARD_FRAG = /* glsl */ `
uniform vec3 uBase; uniform vec3 uGlint;
varying float vA; varying float vG;
void main(){
  vec2 p = gl_PointCoord - 0.5;
  if (max(abs(p.x), abs(p.y)) > 0.42) discard;
  gl_FragColor = vec4(mix(uBase, uGlint, vG) * vA, 1.0);
}`;
const PUFF_VERT = /* glsl */ `
attribute vec3 aV; attribute vec2 aB; attribute vec3 aS;
uniform float uTe; uniform float uScale; uniform float uDrag;
varying float vA;
void main(){
  float age = uTe - aB.x; float k = age / aB.y;
  vA = 0.0;
  if (k < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec3 p = position + aV * (1.0 - exp(-age * uDrag)) / uDrag;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(mix(aS.x, aS.y, sqrt(k)) * uScale / max(0.3, -mv.z), 1.0, 300.0);
  vA = aS.z * smoothstep(0.0, 0.08, k) * pow(1.0 - k, 1.6);
  gl_Position = projectionMatrix * mv;
}`;
const PUFF_FRAG = /* glsl */ `
uniform vec3 uCol;
varying float vA;
void main(){
  vec2 p = gl_PointCoord - 0.5; float d = dot(p, p) * 4.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(uCol, vA * pow(1.0 - d, 2.5));
}`;

runSim(DEFAULTS, async ({cfg, canvas, hud, capture}) => {
  await Promise.all([document.fonts.load('700 20px "JetBrains Mono"'), document.fonts.load('800 20px Inter'), document.fonts.load('600 20px Inter')]).catch(() => {});
  const st = createStage(canvas, hud, {bg: '#000000', capture, fov: 58, exposure: 0.9, bloom: {strength: 0.3, radius: 0.4, threshold: 0.92}});
  const {scene, camera, renderer} = st;
  camera.near = 0.1;
  camera.far = 90000;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const R = rng(cfg.seed);
  const m4 = new THREE.Matrix4(), m5 = new THREE.Matrix4(), col = new THREE.Color();
  const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

  // ---- the hero: walks north on the east High Street sidewalk, stops when the ground goes
  const HERO = {x: 25.2, z0: 162, v: 1.35};
  const heroPos = (te, out) => out.set(HERO.x, -sink(te), HERO.z0 - coast(te, HERO.v, 0.45) - HERO.v * 4);

  // ---- sky, light
  const skyU = {uSun: {value: SUN.clone()}, uT: {value: 0}};
  const skyMat = new THREE.ShaderMaterial({vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false});
  const sky = new THREE.Mesh(new THREE.SphereGeometry(80000, 64, 32), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), new THREE.ShaderMaterial({vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: {uSun: {value: SUN.clone()}, uT: {value: 40}}, side: THREE.BackSide})));
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(envScene, 0.02).texture;
  const sun = new THREE.DirectionalLight('#fff1dc', 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, {left: -260, right: 260, top: 260, bottom: -260, near: 50, far: 3000});
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.25;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight('#9fc4ff', '#6b5d4c', 1.1));
  scene.fog = new THREE.FogExp2(new THREE.Color(0.5, 0.63, 0.8), 0.00004);

  // ---- ground: avenues, sidewalks and plazas are concrete; the park strip is soil and grass
  const groundU = {uGone: {value: 0}};
  const groundMat = new THREE.MeshStandardMaterial({color: '#ffffff', roughness: 0.92, metalness: 0});
  groundMat.onBeforeCompile = (sh) => {
    sh.uniforms.uGone = groundU.uGone;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uGone; varying vec3 vWP;\n${NOISE}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec2 w = vWP.xz;
        if (abs(w.x) < ${PARK.x.toFixed(1)} && abs(w.y) < ${PARK.z.toFixed(1)}) discard;
        float core = step(abs(w.x), ${(KX * GX).toFixed(1)}) * step(abs(w.y), ${(KZ * GZ).toFixed(1)});
        float kx = floor(w.x / ${GX.toFixed(1)} + 0.5), kz = floor(w.y / ${GZ.toFixed(1)} + 0.5);
        float dx = abs(w.x - kx * ${GX.toFixed(1)}), dz = abs(w.y - kz * ${GZ.toFixed(1)});
        float hx = mod(abs(kx), 3.0) < 0.5 ? 18.0 : 12.0, hz = mod(abs(kz), 3.0) < 0.5 ? 18.0 : 12.0;
        if (abs(kx) < 0.5) hx = ${PARK.x.toFixed(1)};
        float aa = fwidth(w.x) + fwidth(w.y) + 0.001;
        float road = max(1.0 - smoothstep(hx - aa, hx + aa, dx), 1.0 - smoothstep(hz - aa, hz + aa, dz));
        if (abs(kx) < 0.5 && abs(w.y) < ${PARK.z.toFixed(1)}) road = 1.0 - smoothstep(hz - aa, hz + aa, dz);
        float walk = max(1.0 - smoothstep(hx + 6.0 - aa, hx + 6.0 + aa, dx), 1.0 - smoothstep(hz + 6.0 - aa, hz + 6.0 + aa, dz));
        float n = fbm(w * 0.05);
        // sidewalk: 0.6 m pavers, a darker curb line
        float pav = max(lineAA(w.x / 0.6, 0.03), lineAA(w.y / 0.6, 0.03)) * (1.0 - smoothstep(0.2, 0.6, aa));
        vec3 side = mix(vec3(0.55, 0.53, 0.5), vec3(0.62, 0.6, 0.56), h21(floor(w / 0.6))) * (1.0 - 0.18 * pav);
        vec3 c = mix(mix(vec3(0.36, 0.35, 0.33), vec3(0.44, 0.43, 0.4), n), side, walk);
        float curb = (1.0 - smoothstep(0.15, 0.15 + aa, abs(min(dx - hx, dz - hz)))) * walk;
        c = mix(c, vec3(0.75, 0.74, 0.7), curb);
        float along = dx < hx ? w.y : w.x, across = dx < hx ? dx : dz;
        float dash = step(0.5, fract(along / 9.0)) * (1.0 - smoothstep(0.12, 0.12 + aa, abs(across - (dx < hx ? hx : hz) * 0.5)));
        float zebra = step(0.5, fract(across / 1.2)) * step(abs(dx < hx ? dz : dx) - (dx < hx ? hz : hx), 4.0) * step(0.0, abs(dx < hx ? dz : dx) - (dx < hx ? hz : hx));
        vec3 asphalt = vec3(0.07, 0.075, 0.08) + 0.03 * n;
        c = mix(c, mix(asphalt, vec3(0.7), max(dash * 0.7, zebra * 0.0)), road);
        float zx = 1.0 - smoothstep(hx - aa, hx + aa, dx), zz = 1.0 - smoothstep(hz - aa, hz + aa, dz);
        float zeb = step(0.5, fract((zx > 0.5 ? w.x : w.y) / 1.1)) * zx * zz * step(min(dx, dz), 1e9);
        float nearX = step(dz, hz + 5.0) * step(hz + 0.6, dz) * zx, nearZ = step(dx, hx + 5.0) * step(hx + 0.6, dx) * zz;
        c = mix(c, vec3(0.78), (step(0.5, fract(w.x / 1.2)) * nearX + step(0.5, fract(w.y / 1.2)) * nearZ) * 0.85);
        // concrete gone: compacted gravel, and under the sidewalks the steel mesh
        vec3 gravel = mix(vec3(0.3, 0.26, 0.21), vec3(0.42, 0.37, 0.3), fbm(w * 1.7)) * (0.8 + 0.4 * h21(floor(w * 9.0)));
        float mesh = max(lineAA(w.x / 0.2, 0.06), lineAA(w.y / 0.2, 0.06)) * walk * (1.0 - smoothstep(0.03, 0.1, aa));
        gravel = mix(gravel, vec3(0.32, 0.18, 0.1), mesh * 0.9);
        c = mix(c, gravel, uGone * core);
        vec3 out_ = mix(vec3(0.28, 0.26, 0.23), vec3(0.36, 0.34, 0.3), fbm(w * 0.004));
        out_ = mix(out_, vec3(0.12, 0.2, 0.08), smoothstep(0.62, 0.7, fbm(w * 0.003 + 4.0)));
        c = mix(out_, c, core);
        diffuseColor.rgb = c;`,
      );
  };
  // subdivided: one giant quad gets its depth wrong next to the camera in software GL
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120000, 120000, 400, 400), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // the park: a raised bed of soil and grass that stays when the slabs go
  const parkMat = new THREE.MeshStandardMaterial({color: '#ffffff', roughness: 0.95});
  parkMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vON;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvON = normal; vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWP; varying vec3 vON;\n${NOISE}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec2 w = vWP.xz;
        vec3 grass = mix(vec3(0.07, 0.19, 0.05), vec3(0.15, 0.3, 0.08), fbm(w * 0.4)) * (0.85 + 0.3 * h21(floor(w * 14.0)));
        float aa = fwidth(w.x) + 0.001;
        float pth = 1.0 - smoothstep(1.6 - aa, 1.6 + aa, abs(w.x - 7.0 * sin(w.y * 0.03)));
        vec3 c = mix(grass, mix(vec3(0.6, 0.55, 0.47), vec3(0.68, 0.63, 0.55), h21(floor(w * 3.0))), pth);
        if (abs(vON.y) < 0.5) c = mix(vec3(0.24, 0.17, 0.11), vec3(0.32, 0.23, 0.15), fbm(vWP.xy * 3.0 + vWP.zy));
        diffuseColor.rgb = c;`,
      );
  };
  const park = new THREE.Mesh(new THREE.BoxGeometry(PARK.x * 2, 0.6, PARK.z * 2).translate(0, -0.3 + 0.02, 0), parkMat);
  park.receiveShadow = true;
  scene.add(park);

  // ---- towers: concrete frame + curtain wall. Gone: rebar cage, the glass slides off
  const towers = [];
  for (let ix = -KX; ix < KX; ix++) {
    for (let iz = -KZ; iz < KZ; iz++) {
      const x0 = ix * GX + (ix === 0 ? PARK.x + 6 : roadHalf(Math.abs(ix)) + 6), x1 = (ix + 1) * GX - (ix === -1 ? PARK.x + 6 : roadHalf(Math.abs(ix + 1)) + 6);
      const z0 = iz * GZ + roadHalf(Math.abs(iz)) + 6, z1 = (iz + 1) * GZ - roadHalf(Math.abs(iz + 1)) - 6;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const r = Math.hypot(cx * 0.9, cz);
      const pod = R() < 0.8;
      if (pod) towers.push({x: cx, z: cz, w: x1 - x0, d: z1 - z0, h: 10 + R() * 9, kind: 2});
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          if (R() > 0.85 * Math.exp(-Math.pow(r / 1100, 2)) + 0.12) continue;
          const lw = (x1 - x0) / 2, ld = (z1 - z0) / 2;
          const s = Math.min(lw, ld) * (0.62 + R() * 0.3);
          const tx = x0 + lw * (a + 0.5) + (R() - 0.5) * (lw - s) * 0.6;
          const tz = z0 + ld * (b + 0.5) + (R() - 0.5) * (ld - s) * 0.6;
          const h = 45 + 210 * Math.exp(-Math.pow(r / 520, 2)) * (0.45 + R() * 0.75) + R() * 50;
          const w = s * (0.85 + R() * 0.3), d = s * (0.85 + R() * 0.3);
          towers.push({x: tx, z: tz, w, d, h, kind: R() < 0.72 ? 0 : 1});
        }
      }
    }
  }
  const NT = towers.length;
  const info = new Float32Array(NT * 4), dim = new Float32Array(NT * 4);
  towers.forEach((T, i) => {
    T.seed = R() * 100;
    // the cage leans under its own steel; taller ones more
    const a = R() * Math.PI * 2, lean = (T.kind === 2 ? 0.2 : 1) * (1.5 + R() * 3) * (T.h / 120);
    T.lean = [Math.cos(a) * lean, Math.sin(a) * lean];
    info.set([T.seed, 0, R(), T.kind], i * 4);
    dim.set([T.h, T.lean[0] / T.w, T.lean[1] / T.d, 0], i * 4);
  });
  const tGeo = unitBox.clone();
  tGeo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
  tGeo.setAttribute('aDim', new THREE.InstancedBufferAttribute(dim, 4));
  const towerU = {uTe: {value: -10}, uBend: {value: 0}};
  const towerMat = new THREE.MeshStandardMaterial({color: '#ffffff', roughness: 0.5, metalness: 0.2});
  towerMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTe = towerU.uTe;
    sh.uniforms.uBend = towerU.uBend;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uBend; attribute vec4 aInfo; attribute vec4 aDim; varying vec4 vInfo; varying vec4 vDim; varying vec3 vWP; varying vec3 vON;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xz += aDim.yz * uBend * transformed.y * transformed.y;\nvec3 straight = position;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvInfo = aInfo; vDim = aDim; vON = normal; vWP = (modelMatrix * instanceMatrix * vec4(straight, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTe; varying vec4 vInfo; varying vec4 vDim; varying vec3 vWP; varying vec3 vON;\n${NOISE}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 on = normalize(vON);
        bool roof = abs(on.y) > 0.5;
        float u = abs(on.x) > 0.5 ? vWP.z : vWP.x;
        float kind = vInfo.w, H = vDim.x;
        float gone = step(0.0, uTe) * step(uTe, ${EV.toFixed(1)} - 1e-4);
        float te = clamp(uTe, 0.0, ${EV.toFixed(1)});
        // the curtain wall hangs from the slabs: no slabs, it free-falls as one sheet
        float drop = 4.905 * te * te;
        float yg = vWP.y + drop;
        float colW = kind < 0.5 ? 1.6 : 2.6, flH = kind > 1.5 ? 4.6 : 3.8;
        float fu = fract(u / colW), fv = fract(yg / flH);
        float wu = fwidth(u / colW) + 1e-4, wv = fwidth(vWP.y / flH) + 1e-4;
        float mull = smoothstep(0.06 - wu, 0.06 + wu, fu) * smoothstep(0.06 - wu, 0.06 + wu, 1.0 - fu);
        float spand = kind < 0.5 ? 0.2 : 0.45;
        float band = smoothstep(spand - wv, spand + wv, fv) * smoothstep(0.04 - wv, 0.04 + wv, 1.0 - fv);
        if (kind > 0.5) mull = mix(mull, 1.0, 0.75);
        float glass = mull * band;
        if (kind > 1.5 && yg < 5.0) glass = smoothstep(0.03 - wu, 0.03 + wu, fu) * smoothstep(0.03 - wu, 0.03 + wu, 1.0 - fu) * step(0.3, yg);
        float fine = clamp(max(wu, wv) * 1.6 - 0.35, 0.0, 1.0);
        glass = mix(glass, kind < 0.5 ? 0.66 : 0.4, fine);
        if (roof) glass = 0.0;
        float sheet = step(yg, H - 0.3);
        vec3 tint = mix(vec3(0.42, 0.55, 0.6), vec3(0.55, 0.6, 0.58), vInfo.z);
        if (vInfo.z > 0.7) tint = vec3(0.45, 0.5, 0.62);
        vec3 alu = mix(vec3(0.18, 0.19, 0.21), vec3(0.5, 0.51, 0.52), vInfo.z);
        vec3 conc = mix(vec3(0.62, 0.6, 0.56), vec3(0.75, 0.73, 0.68), vInfo.z);
        vec3 frameC = kind < 0.5 ? alu : conc;
        vec3 roofC = vec3(0.4, 0.4, 0.38) * (0.8 + 0.3 * vnoise(vWP.xz * 0.3));
        vec3 inside = vec3(0.025, 0.022, 0.02);
        float shop = kind > 1.5 && yg < 5.0 ? 1.0 : 0.0;
        if (gone < 0.5) {
          // whole, or back: the glass that slid away during the five seconds is missing
          float g = glass * sheet;
          vec3 baseC = roof ? roofC : frameC;
          if (kind < 0.5 && sheet < 0.5 && !roof) baseC = conc * 0.9;
          diffuseColor.rgb = mix(mix(baseC, inside, glass * (1.0 - sheet)), tint * 0.22, g);
          metalnessFactor = mix(0.05, 0.9, g);
          roughnessFactor = mix(0.75, 0.1, g);
          totalEmissiveRadiance += vec3(1.0, 0.72, 0.42) * 0.35 * shop * g;
        } else {
          // the cage: columns every 8.4 m, a slab edge at every floor, ties in between
          float fl = flH;
          float colB = lineAA(u / 8.4, 0.03), slabB = lineAA(vWP.y / fl, 0.035);
          float ties = lineAA(vWP.y / 0.3, 0.12) * colB;
          float vbars = lineAA(u / 0.25, 0.1) * slabB;
          float reb = max(max(colB * 0.85, ties), max(slabB * 0.7, vbars));
          if (roof) reb = max(lineAA(vWP.x / 0.6, 0.06), lineAA(vWP.z / 0.6, 0.06));
          reb = mix(reb, 0.3, clamp(fwidth(u / 0.25) - 0.3, 0.0, 1.0));
          float sh = roof ? 0.0 : sheet * (kind < 0.5 ? 1.0 : glass);
          float cov = max(reb, sh);
          if (cov < ign(gl_FragCoord.xy)) discard;
          if (reb >= sh) {
            diffuseColor.rgb = vec3(0.3, 0.17, 0.1) * (0.8 + 0.4 * h21(floor(vWP.xy * 3.0)));
            metalnessFactor = 0.55; roughnessFactor = 0.6;
          } else {
            float g = glass;
            diffuseColor.rgb = mix(frameC, tint * 0.22, g);
            metalnessFactor = mix(0.3, 0.9, g); roughnessFactor = mix(0.6, 0.1, g);
            totalEmissiveRadiance += vec3(1.0, 0.72, 0.42) * 0.35 * shop * g;
          }
        }`,
      );
  };
  const towerMesh = new THREE.InstancedMesh(tGeo, towerMat, NT);
  towers.forEach((T, i) => towerMesh.setMatrixAt(i, m4.makeScale(T.w, T.h, T.d).setPosition(T.x, 0, T.z)));
  towerMesh.castShadow = towerMesh.receiveShadow = true;
  scene.add(towerMesh);

  const near = (T, r) => Math.hypot(T.x - HERO.x, T.z - 150) < r;
  // interior rebar mats, one per floor, for the towers you can see into
  const FLOORS = [];
  for (const T of towers) {
    if (!near(T, 520)) continue;
    const fl = T.kind === 2 ? 4.6 : 3.8;
    for (let y = fl; y < T.h - 1; y += fl) FLOORS.push([T, y]);
  }
  const floorGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const lean = new Float32Array(FLOORS.length * 3);
  FLOORS.forEach(([T, y], i) => lean.set([T.lean[0], T.lean[1], y / T.h], i * 3));
  floorGeo.setAttribute('aLean', new THREE.InstancedBufferAttribute(lean, 3));
  const floorU = {uBend: towerU.uBend, uSun: {value: SUN}};
  const floorMesh = new THREE.InstancedMesh(floorGeo, new THREE.ShaderMaterial({vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, uniforms: floorU, side: THREE.DoubleSide}), FLOORS.length);
  FLOORS.forEach(([T, y], i) => floorMesh.setMatrixAt(i, m4.makeScale(T.w - 0.2, 1, T.d - 0.2).setPosition(T.x, y, T.z)));
  floorMesh.frustumCulled = false;
  scene.add(floorMesh);

  // ---- sprawl, mountains
  const SPR = [];
  for (let i = 0; i < 9000; i++) {
    const a = R() * Math.PI * 2, rr = 1150 + Math.pow(R(), 0.7) * 5200;
    const x = Math.cos(a) * rr * 1.1, z = Math.sin(a) * rr;
    if (Math.abs(x) < KX * GX + 40 && Math.abs(z) < KZ * GZ + 40) continue;
    SPR.push([x, z, 14 + R() * 26, 14 + R() * 26, 5 + Math.pow(R(), 3) * 40]);
  }
  const sprMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({roughness: 0.85}), SPR.length);
  SPR.forEach(([x, z, w, d, h], i) => {
    sprMesh.setMatrixAt(i, m4.makeScale(w, h, d).setPosition(x, 0, z));
    sprMesh.setColorAt(i, col.setHSL(0.08 + R() * 0.05, 0.1 + R() * 0.15, 0.35 + R() * 0.3));
  });
  scene.add(sprMesh);
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

  // ---- street furniture
  // trees: park canopy (trunk + crown), stay put
  const TREES = [];
  for (let i = 0; i < 700; i++) {
    const z = (R() - 0.5) * PARK.z * 2, x = (R() - 0.5) * 28;
    if (Math.abs(x - 7 * Math.sin(z * 0.03)) < 3) continue;
    TREES.push([x, z, 2.6 + R() * 2.2]);
  }
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 1, 6).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({color: '#4a3626', roughness: 1}), TREES.length);
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({roughness: 0.9, flatShading: true}), TREES.length);
  TREES.forEach(([x, z, s], i) => {
    trunk.setMatrixAt(i, m4.makeScale(1, s * 0.9, 1).setPosition(x, 0, z));
    crown.setMatrixAt(i, m4.makeScale(s, s * 0.85, s).setPosition(x, s * 1.45, z));
    crown.setColorAt(i, col.setHSL(0.24 + R() * 0.08, 0.5, 0.13 + R() * 0.1));
  });
  trunk.castShadow = crown.castShadow = true;
  scene.add(trunk, crown);

  // lamp posts on concrete footings: no footing, they tip and fall
  const LAMPS = [];
  for (const side of [-1, 1]) {
    for (let z = -370; z < 370; z += 22) LAMPS.push({x: side * (PARK.x + 0.8), z: z + R() * 3, dir: side > 0 ? (R() < 0.6 ? Math.PI / 2 : -Math.PI / 2 + (R() - 0.5)) : -Math.PI / 2 + (R() - 0.5), th0: 0.012 + R() * 0.03, face: side});
  }
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 7, 8).translate(0, 3.5, 0);
  const headGeo = new THREE.BoxGeometry(1.4, 0.18, 0.35).translate(0.55, 7, 0);
  const steel = new THREE.MeshStandardMaterial({color: '#2b2f33', metalness: 0.6, roughness: 0.45});
  const poles = new THREE.InstancedMesh(poleGeo, steel, LAMPS.length);
  const heads = new THREE.InstancedMesh(headGeo, steel, LAMPS.length);
  poles.castShadow = heads.castShadow = true;
  scene.add(poles, heads);
  const lampAngle = (L, te) => (te <= 0 ? 0 : te >= EV ? Math.min(Math.PI / 2, L.th0 * Math.cosh(1.45 * EV)) : Math.min(Math.PI / 2, L.th0 * Math.cosh(1.45 * te)));

  // concrete benches and planters along the park edge: simply not there for five seconds
  const BENCH = [];
  for (let z = -360; z < 360; z += 15) {
    const x = (z % 30 === 0 ? 1 : -1) * (PARK.x - 3.5);
    if (Math.abs(z - 150) < 8 && x > 0) continue;
    BENCH.push([x, z + R() * 4]);
  }
  const bench = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({color: '#a9a49a', roughness: 0.9}), BENCH.length);
  BENCH.forEach(([x, z], i) => bench.setMatrixAt(i, m4.makeScale(0.6, 0.45, 2.2).setPosition(x, 0, z)));
  bench.castShadow = bench.receiveShadow = true;
  scene.add(bench);

  // ---- cars: drop onto the gravel and grind to a stop
  const CARS = [];
  for (let i = 0; i < 700; i++) {
    const alongX = R() < 0.5, k = Math.round((R() - 0.5) * 2 * KX);
    if (!alongX && k === 0) continue;
    const dir = R() < 0.5 ? -1 : 1;
    CARS.push({alongX, line: (alongX ? GZ : GX) * k + dir * (3 + R() * 6), dir, s0: R() * 2000, v: 6 + R() * 6});
  }
  const carBody = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.55, 1).translate(0, 0.55, 0), new THREE.MeshStandardMaterial({roughness: 0.3, metalness: 0.6}), CARS.length);
  const carCab = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.5, 0.9).translate(-0.05, 1.07, 0), new THREE.MeshStandardMaterial({color: '#141a20', roughness: 0.1, metalness: 0.8}), CARS.length);
  CARS.forEach((c, i) => carBody.setColorAt(i, col.setHSL(R(), R() * 0.4, 0.12 + R() * 0.7)));
  carBody.castShadow = true;
  scene.add(carBody, carCab);
  const L = 2 * KX * GX;

  // ---- people: a procedural crowd on the sidewalks and in the park
  const P = [];
  const skin = ['#8d5a3b', '#a8714c', '#c08a62', '#6e4428', '#d0a07a'];
  const hairC = ['#120d0a', '#1f1610', '#2c1d12', '#0b0b0b'];
  const pants = ['#1d2433', '#2b3a55', '#3a3a3a', '#6b5d48', '#11151c', '#4c5a6e'];
  const shirts = ['#e8e4dc', '#d94b3d', '#2f6db3', '#f2c14e', '#3f8f5a', '#ffffff', '#1c1c1c', '#c9748f', '#6a8caf', '#f08a3c'];
  const pick = (a) => a[Math.floor(R() * a.length)];
  const addPerson = (o) =>
    P.push({
      x: 0, z: 0, dir: R() < 0.5 ? -1 : 1, v: 1.05 + R() * 0.45, walk: R() < 0.75, slab: true, ph: R() * 10, h: 1.55 + R() * 0.22,
      look: R() * 2 - 1, react: 0.35 + R() * 0.65, delay: 0.08 + R() * 0.35,
      skin: pick(skin), hair: pick(hairC), pants: pick(pants), shirt: pick(shirts), ...o,
    });
  // the hero is P[0]
  addPerson({x: HERO.x, z: HERO.z0, dir: -1, v: HERO.v, walk: true, h: 1.72, skin: '#a8714c', hair: '#120d0a', pants: '#2b3a55', shirt: '#f2c14e', react: 0.8, delay: 0.12, hero: true});
  for (let i = 0; i < 700; i++) {
    const r = R();
    const z = 150 + (R() - 0.5) * (R() < 0.6 ? 160 : 700);
    if (r < 0.5) {
      const side = R() < 0.7 ? 1 : -1;
      const x = side * (PARK.x + 1.5 + R() * 3.8);
      if (side > 0 && Math.abs(x - HERO.x) < 1.6 && z > 140 && z < 175) continue;
      addPerson({x, z});
    } else if (r < 0.8) {
      addPerson({x: 7 * Math.sin(z * 0.03) + (R() - 0.5) * 2.4, z, path: true});
    } else {
      addPerson({x: (R() - 0.5) * PARK.x * 1.7, z, walk: false, slab: false});
    }
  }
  const NP = P.length;
  const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);
  const mk = (geo, n, color) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({roughness: 0.75, color: color || '#ffffff'}), n);
    m.castShadow = true;
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const legs = mk(capsule(0.075, 0.72), NP * 2);
  const shoes = mk(new THREE.BoxGeometry(0.11, 0.08, 0.27), NP * 2, '#1a1a1a');
  const torso = mk(capsule(0.17, 0.34), NP);
  const arms = mk(capsule(0.052, 0.5), NP * 2);
  const heads2 = mk(new THREE.SphereGeometry(0.105, 16, 12), NP);
  const hair = mk(new THREE.SphereGeometry(0.112, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), NP);
  const bag = mk(new THREE.BoxGeometry(0.3, 0.42, 0.15), 1, '#20343f');
  P.forEach((p, i) => {
    legs.setColorAt(2 * i, col.set(p.pants));
    legs.setColorAt(2 * i + 1, col.set(p.pants));
    torso.setColorAt(i, col.set(p.shirt));
    col.set(R() < 0.5 ? p.skin : p.shirt);
    arms.setColorAt(2 * i, col);
    arms.setColorAt(2 * i + 1, col);
    heads2.setColorAt(i, col.set(p.skin));
    hair.setColorAt(i, col.set(p.hair));
  });
  const q = new THREE.Quaternion(), e3 = new THREE.Euler(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  const part = (base, x, y, z, rx, ry, rz, sx = 1, sy = 1, sz = 1) => m5.copy(base).multiply(m4.compose(v3.set(x, y, z), q.setFromEuler(e3.set(rx, ry, rz)), s3.set(sx, sy, sz)));
  const sub = new THREE.Matrix4(), base = new THREE.Matrix4();
  const placePeople = (te) => {
    P.forEach((p, i) => {
      const k = p.h / 1.7;
      const s = p.walk ? coast(te, p.v, 0.5) + p.v * 6 : 0;
      let z = p.z + p.dir * s;
      if (p.hero) z = p.z - coast(te, p.v, 0.45) - p.v * 4;
      else z = ((((z + 380) % 760) + 760) % 760) - 380;
      const x = p.path ? 7 * Math.sin(z * 0.03) + (p.x - 7 * Math.sin(p.z * 0.03)) : p.x;
      const y = p.slab ? -sink(te) : 0;
      const head = p.dir < 0 ? Math.PI : 0;
      // reaction: stumble, arms out, look around
      const rk = te <= 0 ? 0 : smooth((te - p.delay) / 0.5) * p.react;
      const stride = p.walk ? (te <= 0 ? 1 : Math.max(0, 1 - te / 0.5)) : 0;
      const phase = ((s + p.ph) / 0.78) * Math.PI;
      const sw = Math.sin(phase) * 0.42 * stride;
      const bob = Math.abs(Math.cos(phase)) * 0.03 * stride;
      const dip = te > 0 && te < 0.6 && p.slab ? Math.sin(clamp01(te / 0.6) * Math.PI) * 0.12 : 0;
      base.compose(v3.set(x, y + bob - dip, z), q.setFromEuler(e3.set(0, head + (rk * p.look * 0.4), 0)), s3.set(k, k, k));
      for (const sd of [-1, 1]) {
        const a = sd * sw;
        part(base, sd * 0.1, 0.92, 0, a, 0, 0);
        sub.copy(m5).multiply(m4.makeTranslation(0, -0.44, 0));
        legs.setMatrixAt(2 * i + (sd > 0 ? 1 : 0), sub);
        sub.copy(m5).multiply(m4.makeTranslation(0, -0.88, 0.05));
        shoes.setMatrixAt(2 * i + (sd > 0 ? 1 : 0), sub);
        const raise = rk * (1.1 + 0.9 * p.react) * (0.7 + 0.3 * Math.sin(te * 2.2 + p.ph + sd));
        part(base, sd * 0.235, 1.42, 0, -a * 0.9 - rk * 0.5, 0, sd * (0.07 + raise));
        sub.copy(m5).multiply(m4.makeTranslation(0, -0.3, 0));
        arms.setMatrixAt(2 * i + (sd > 0 ? 1 : 0), sub);
      }
      torso.setMatrixAt(i, part(base, 0, 1.2, 0, -0.04 * stride + rk * 0.12, 0, 0, 1, 1, 0.62));
      const look = rk * Math.sin(te * 1.6 + p.ph) * 0.7;
      heads2.setMatrixAt(i, part(base, 0, 1.63, 0, -rk * 0.25, look, 0));
      hair.setMatrixAt(i, part(base, 0, 1.645, 0.012, -rk * 0.25, look, 0, 1, 0.95, 1));
      if (p.hero) bag.setMatrixAt(0, part(base, 0, 1.24, -0.17, 0, 0, 0));
    });
    for (const m of [legs, shoes, torso, arms, heads2, hair, bag]) m.instanceMatrix.needsUpdate = true;
  };

  // ---- particles
  const scaleU = {value: 1000};
  const pts = (n, fill, mat) => {
    const g = new THREE.BufferGeometry();
    const Pp = new Float32Array(n * 3), V = new Float32Array(n * 3), B = new Float32Array(n * 2), S = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) fill(i, Pp, V, B, S);
    g.setAttribute('position', new THREE.BufferAttribute(Pp, 3));
    g.setAttribute('aV', new THREE.BufferAttribute(V, 3));
    g.setAttribute('aB', new THREE.BufferAttribute(B, 2));
    g.setAttribute('aS', new THREE.BufferAttribute(S, 3));
    const pp = new THREE.Points(g, mat);
    pp.frustumCulled = false;
    scene.add(pp);
    return pp;
  };
  const shardMat = (size, base, glint, blending = THREE.AdditiveBlending) =>
    new THREE.ShaderMaterial({
      vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG,
      uniforms: {uTe: {value: -10}, uScale: scaleU, uSize: {value: size}, uFloor: {value: -SLAB}, uBase: {value: new THREE.Color(...base)}, uGlint: {value: new THREE.Color(...glint)}},
      transparent: blending !== THREE.NormalBlending, depthWrite: blending === THREE.NormalBlending, blending,
    });
  // the sliding sheet shatters where it meets the gravel, all the way round each base
  const glassT = towers.filter((T) => near(T, 380));
  const perim = (T, i, Pp, V, speed) => {
    const f = Math.floor(R() * 4);
    const nx = f === 0 ? 1 : f === 1 ? -1 : 0, nz = f === 2 ? 1 : f === 3 ? -1 : 0;
    Pp.set([T.x + (nx ? (nx * T.w) / 2 + nx * 0.3 : (R() - 0.5) * T.w), 0.2, T.z + (nz ? (nz * T.d) / 2 + nz * 0.3 : (R() - 0.5) * T.d)], i * 3);
    V.set([nx * speed * (0.3 + R()) + (R() - 0.5) * speed * 0.8, speed * (0.2 + R() * 0.6), nz * speed * (0.3 + R()) + (R() - 0.5) * speed * 0.8], i * 3);
  };
  const burst = pts(90000, (i, Pp, V, B) => {
    const T = glassT[Math.floor(R() * glassT.length)];
    const b = 0.05 + Math.pow(R(), 0.8) * (EV - 0.05);
    // impact speed grows with the fall
    perim(T, i, Pp, V, 1 + G * b * 0.35);
    B.set([b, R()], i * 2);
  }, shardMat(0.07, [0.15, 0.2, 0.24], [2.2, 2.1, 2.0]));
  // office contents dropping through the cages
  const debris = pts(40000, (i, Pp, V, B) => {
    const T = glassT[Math.floor(R() * glassT.length)];
    const fl = T.kind === 2 ? 4.6 : 3.8;
    const y = fl * (1 + Math.floor(R() * Math.max(1, T.h / fl - 1)));
    Pp.set([T.x + (R() - 0.5) * T.w * 0.9, y, T.z + (R() - 0.5) * T.d * 0.9], i * 3);
    V.set([(R() - 0.5) * 0.6, R() * 0.4, (R() - 0.5) * 0.6], i * 3);
    B.set([R() * 0.05, R()], i * 2);
  }, shardMat(0.45, [0.09, 0.08, 0.07], [0.35, 0.33, 0.3], THREE.NormalBlending));
  // grit kicked up as everything settles 30 cm, and again when the concrete returns
  const dustMat = new THREE.ShaderMaterial({vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, uniforms: {uTe: {value: -10}, uScale: scaleU, uDrag: {value: 2}, uCol: {value: new THREE.Color('#bdb19c')}}, transparent: true, depthWrite: false});
  const dust = pts(9000, (i, Pp, V, B, S) => {
    const second = R() < 0.4;
    const z = 150 + (R() - 0.5) * 500, side = R() < 0.5 ? -1 : 1;
    Pp.set([side * (PARK.x + R() * 6), 0.1, z], i * 3);
    const a = R() * Math.PI * 2, sp = 0.5 + R() * 2;
    V.set([Math.cos(a) * sp, 0.3 + R() * 1.2, Math.sin(a) * sp], i * 3);
    B.set([second ? EV + R() * 0.2 : 0.2 + R() * 0.3, 1.5 + R() * 2], i * 2);
    S.set([1.2, 5 + R() * 5, 0.1], i * 3);
  }, dustMat);

  // ---- overlay
  const ov = document.createElement('div');
  ov.className = 'c-ov';
  ov.innerHTML = `
    <div class="c-loc"><i></i><div><b>BONIFACIO GLOBAL CITY</b><span>High Street, Taguig · 14.55° N 121.05° E · 10:00 AM</span></div></div>
    <div class="c-clock"><span class="c-lab"></span><b></b><div class="c-bar"><em></em></div><div class="c-slow"><i></i>SLOW MOTION 0.4×</div></div>
    <div class="c-pa"><span>CONCRETE</span><b></b></div>
    <div class="c-cap"></div>
    <div class="c-vig"></div>`;
  document.getElementById('app').appendChild(ov);
  const $ = (s) => ov.querySelector(s);
  const clockLab = $('.c-clock .c-lab'), clockNum = $('.c-clock b'), clockBar = $('.c-bar em'), slowEl = $('.c-slow'), clockEl = $('.c-clock');
  const paEl = $('.c-pa b'), paBox = $('.c-pa'), capEl = $('.c-cap'), vig = $('.c-vig'), locEl = $('.c-loc');
  const CAPS = TL.captions.map(([t0, t1, text]) => {
    const el = document.createElement('div');
    el.className = 'c-line';
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

  // ---- camera: over the hero's shoulder, offsets keyed in screen time
  const KEYS = [
    [0, [-0.8, 2.3, 5.4], [-0.6, 6, -40]],
    [3.6, [-0.7, 1.75, 3.7], [-0.5, 3.5, -30]],
    [5.2, [-0.8, 1.0, 3.3], [-0.3, 2.4, -22]],
    [8, [-2.4, 2.2, 3.6], [2, 14, -40]],
    [11.5, [-3.2, 6.5, 9], [0, 2, -32]],
    [14.8, [-3.8, 21, 17], [14, 70, -95]],
    [16.5, [-3.6, 19, 15], [8, 60, -80]],
    [17.5, [-4, 5, 2], [-1, 2, -14]],
    [18.6, [-2.4, 1.5, -4.6], [0, 0.4, 0]],
    [21, [-1.9, 1.05, -3.5], [0, 0.15, 0]],
    [24, [-2.8, 2.9, -7.5], [0, 1.9, 6]],
  ];
  const curve = (j) => new THREE.CatmullRomCurve3(KEYS.map((k) => new THREE.Vector3(...k[j])), false, 'centripetal');
  const offC = curve(1), lookC = curve(2);
  const keyU = (t) => {
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (t <= KEYS[i + 1][0]) {
        const k = (t - KEYS[i][0]) / (KEYS[i + 1][0] - KEYS[i][0]);
        return (i + smooth(k) * 0.5 + k * 0.5) / (KEYS.length - 1);
      }
    }
    return 1;
  };

  const OW = 1080;
  let s = 1;
  const H = new THREE.Vector3(), off = new THREE.Vector3(), look = new THREE.Vector3();

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
      const gone = te >= 0 && te < EV;
      const dropNow = sink(te);
      skyU.uT.value = te + 40;
      towerU.uTe.value = te;
      towerU.uBend.value = gone ? Math.pow(te / EV, 2) : 0;
      towerMesh.castShadow = !gone;
      floorMesh.visible = gone;
      groundU.uGone.value = gone ? 1 : 0;
      ground.position.y = gone ? -dropNow : 0;
      bench.visible = !gone;
      for (const p of [burst, debris, dust]) p.material.uniforms.uTe.value = te;
      debris.visible = gone;

      LAMPS.forEach((Lp, i) => {
        const th = lampAngle(Lp, te);
        // tip toward Lp.dir by th, lamp arm still pointing over the sidewalk
        m4.makeTranslation(Lp.x, -sink(te), Lp.z)
          .multiply(m5.makeRotationY(Lp.dir))
          .multiply(sub.makeRotationZ(-th))
          .multiply(m5.makeRotationY(-Lp.dir + (Lp.face > 0 ? 0 : Math.PI)));
        poles.setMatrixAt(i, m4);
        heads.setMatrixAt(i, m4);
      });
      poles.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;

      CARS.forEach((c, i) => {
        const a = ((((c.s0 + c.dir * coast(te, c.v, 1.2) + c.dir * c.v * 10) % L) + L) % L) - L / 2;
        const x = c.alongX ? a : c.line, z = c.alongX ? c.line : a;
        const y = -sink(te);
        m4.makeScale(c.alongX ? 4.4 : 1.85, 1, c.alongX ? 1.85 : 4.4).setPosition(x, y, z);
        carBody.setMatrixAt(i, m4);
        m4.compose(v3.set(x, y, z), q.setFromEuler(e3.set(0, c.alongX ? 0 : Math.PI / 2, 0)), s3.set(4.4, 1, 1.85));
        carCab.setMatrixAt(i, m4);
      });
      carBody.instanceMatrix.needsUpdate = carCab.instanceMatrix.needsUpdate = true;
      placePeople(te);

      heroPos(te, H);
      const u = keyU(t);
      offC.getPoint(u, off);
      lookC.getPoint(u, look);
      const shake = (te >= EV ? Math.exp(-(te - EV) * 4) * 0.25 : 0) + (te >= 0 && te < 0.5 ? (1 - te / 0.5) * 0.12 : 0);
      camera.position.copy(H).add(off);
      if (shake > 0.001) {
        const f = Math.floor(t * 30);
        camera.position.x += (hash(f) - 0.5) * shake;
        camera.position.y += (hash(f + 77) - 0.5) * shake;
      }
      // never into the shopfronts east of the sidewalk
      camera.position.x = Math.min(camera.position.x, HERO.x + 1.2);
      camera.position.y = Math.max(camera.position.y, (gone ? -SLAB : 0) + 0.22);
      camera.lookAt(look.add(H));
      sky.position.copy(camera.position);
      sun.target.position.set(H.x, 0, H.z - 60);
      sun.position.copy(sun.target.position).addScaledVector(SUN, 1500);
      st.render();

      // ---- overlay
      locEl.style.opacity = (1 - 0.5 * smooth((t - OFF) / 0.4) + 0.5 * smooth((t - BACK - 2.5) / 0.6)).toFixed(3);
      paEl.textContent = gone ? '0%' : '100%';
      paBox.classList.toggle('vac', gone);
      if (te < 0) {
        clockLab.textContent = 'CONCRETE GONE IN';
        clockNum.textContent = `${(-te).toFixed(1)} s`;
        clockBar.style.width = '0%';
      } else if (te < EV) {
        clockLab.textContent = 'NO CONCRETE';
        clockNum.textContent = `${te.toFixed(2)} s`;
        clockBar.style.width = `${(te / EV) * 100}%`;
      } else {
        clockLab.textContent = 'CONCRETE BACK';
        clockNum.textContent = `${EV.toFixed(2)} s`;
        clockBar.style.width = '100%';
      }
      clockEl.classList.toggle('vac', gone);
      clockEl.style.opacity = (1 - smooth((t - BACK - 2.8) / 0.6)).toFixed(3);
      slowEl.style.opacity = gone ? (0.55 + 0.45 * Math.cos(t * 6) ** 2).toFixed(3) : '0';
      vig.style.opacity = (0.2 + 0.2 * (gone ? 1 : 0) + 0.6 * Math.exp(-Math.max(0, t - OFF) * 6) * (t >= OFF ? 1 : 0) + 0.6 * Math.exp(-Math.max(0, t - BACK) * 6) * (t >= BACK ? 1 : 0)).toFixed(3);

      for (const C of CAPS) {
        const a = smooth((t - C.t0) / 0.12) * (1 - smooth((t - C.t1 + 0.15) / 0.15));
        C.el.style.opacity = a.toFixed(3);
        if (a <= 0) continue;
        const span = (C.t1 - C.t0) * 0.5;
        const n = C.words.length;
        C.words.forEach((w, j) => {
          const wt = C.t0 + (span * j) / n;
          const k = clamp01((t - wt) / 0.14);
          w.style.opacity = k.toFixed(3);
          w.style.transform = `translateY(${lerp(18, 0, smooth(k)).toFixed(1)}px) scale(${lerp(0.9, 1, smooth(k)).toFixed(3)})`;
          w.classList.toggle('hi', j === Math.min(n - 1, Math.floor(((t - C.t0) / span) * n)) && t < C.t0 + span + 0.4);
        });
      }
      return {};
    },
  };
});
