// devibe City — the Map extruded into 3D. Folders are district plinths, files
// are lots with a sign and a shell, and as you zoom in a building opens: types
// become podiums and functions become towers standing on the exact code
// layout, so each tower's roof is its function's code. One geometry with the
// Map: picking, selection, links, and edits work the same in both.
//
// Rendering: one instanced box per part (InstancedBufferGeometry and a
// ShaderMaterial). Every instance carries its previous and next geometry, so a
// morph (layout change, buildings opening, heights changing, Preview) costs
// one uniform per frame. Two passes share the geometry: opaque boxes, then
// translucent ones (glass shells, isolate and cutaway ghosts, deleted files).
//
// Picking and occlusion: a uniform grid over the layout (the skyline) lists
// the boxes over each cell. Under the orthographic camera all view rays are
// parallel, so a pick walks the grid along the ray's ground projection and
// slab-tests the boxes it meets.

import * as THREE from 'three';

const BOX_VERT = `
attribute vec4 aTo;
attribute vec4 aFrom;
attribute vec4 aToZ;
attribute vec4 aFromZ;
attribute vec4 aColor;
attribute vec4 aFlags;
uniform float uT;
uniform float uFlat;
uniform float uGhost;
uniform float uPass;
varying vec3 vColor;
varying float vAlpha;
varying vec3 vN;
varying vec2 vUv;
varying float vTop;
varying float vHover;
float bit(float v, float b) { return mod(floor(v / b + 0.5 / b), 2.0); }
void main() {
  vec4 r = mix(aFrom, aTo, uT);
  vec4 zz = mix(aFromZ, aToZ, uT);
  float bits = aFlags.x;
  float f = bit(bits, 16.0) > 0.5 ? mix(1.0, 0.15, uFlat) : 1.0;
  float z = zz.z + (zz.x - zz.z) * f;
  float d = max(zz.y * f, 0.0001);
  float glass = mix(aFlags.y, aFlags.z, uT);
  vAlpha = bit(bits, 4.0) > 0.5 ? uGhost : mix(1.0, 0.13, glass);
  float opaque = vAlpha >= 0.999 ? 1.0 : 0.0;
  if ((uPass < 0.5 && opaque < 0.5) || (uPass > 0.5 && opaque > 0.5) || r.z <= 0.0 || r.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 p = vec3(r.x + position.x * r.z, -(r.y + r.w) + position.y * r.w, z + position.z * d);
  vColor = aColor.rgb;
  vN = normalize(normalMatrix * normal);
  vUv = uv;
  vTop = normal.z;
  vHover = bit(bits, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const BOX_FRAG = `
precision highp float;
uniform vec3 uBg;
uniform vec3 uSun;
varying vec3 vColor;
varying float vAlpha;
varying vec3 vN;
varying vec2 vUv;
varying float vTop;
varying float vHover;
void main() {
  vec3 n = normalize(vN);
  float sun = max(dot(n, normalize(uSun)), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 c = vColor * (0.46 + 0.3 * sky + 0.36 * sun);
  if (vTop > 0.5) c = mix(c, vColor, 0.45);
  if (vTop > 0.5 && vHover > 0.5) c *= 1.12;
  vec2 fw = max(fwidth(vUv), vec2(1e-5));
  vec2 e2 = min(vUv, 1.0 - vUv) / fw;
  float edge = clamp(min(e2.x, e2.y) / 1.2, 0.0, 1.0);
  c *= mix(0.78, 1.0, edge);
  float a = vAlpha;
  if (a < 0.999) {
    c = mix(uBg, c, 0.85);
    a = max(a, (1.0 - edge) * 0.5);
  }
  gl_FragColor = vec4(c, a);
}`;

// Instance flags (bit values).
const HOVER = 1, MEMBER = 2, GHOST = 4, FLAT = 16;
const BUDGET = 60000;
const OPEN_AT = 70, CLOSE_AT = 50;
const READ_AT = 7.5, UNREAD_AT = 5.5;
const READ_PITCH = 0.6;

export function makeCity(env) {
  const { state, R, d3, S } = env;
  const C = {
    lay: null, inst: [], index: new Map(), from: null, to: null, glass: null,
    open: new Set(), openKeys: new Set(), closing: [], anim: null, uT: 1,
    flat: { file: -1, key: null, t: 0, from: 0, to: 0, t0: 0, prevPitch: null },
    sky: null, skyAll: null, cut: new Set(), planAt: 0, planTimer: 0, cutTimer: 0, hoverTimer: 0, ownerCache: new Map(),
  };
  const N = () => state.T.N;
  const clamp = env.clamp;
  const ease = d3.easeCubicInOut;

  // ───────────── Layout ─────────────

  // The Map extruded: districts, lots, signs, shells, and the pieces (podiums
  // and towers) of every file, all from the Map layout.
  function lay(T, map) {
    const Nn = T.N;
    const W = map.bounds.w;
    const P = W * 0.0018, tall = W * 0.09;
    const height = heightMeasure();
    const vOf = (id) => env.S.measure({ I: T.I, rank: env.detailRank() }, height, id);
    const towerH = (id) => Math.max(0.8 * P, tall * clamp(vOf(id), 0, 1.15) ** 1.25);
    const shellH = (id) => Math.max(1.5 * P, tall * clamp(vOf(id), 0, 1.15) ** 1.25);
    const podiumH = Math.max(0.6 * P, tall * 0.035);
    const items = [], files = new Map(), byNode = new Map(), ghosts = [];
    const put = (id, b) => { if (!byNode.has(id)) byNode.set(id, []); byNode.get(id).push(b); };
    let maxDepth = 1, top = 0;
    for (const it of map.items) {
      if (it.part === 'dir') {
        const d = T.depth[it.id];
        maxDepth = Math.max(maxDepth, d);
        const b = { key: `${it.nk}|dir`, id: it.id, part: 'dir', x: it.x, y: it.y, w: it.w, h: it.h, z: (d - 1) * P, d: P, zb: 0, file: -1 };
        items.push(b);
        put(it.id, b);
      } else if (it.part === 'body') {
        const id = it.id;
        const r = map.rect.get(id);
        const c = map.code.get(id);
        const z0 = (T.depth[id] - 1) * P;
        const inset = Math.min(Math.min(it.w, it.h) * 0.06, (c?.pad ?? 0) * 0.6);
        const lot = { key: `${it.nk}|lot`, id, part: 'lot', x: it.x + inset, y: it.y + inset, w: Math.max(0, it.w - 2 * inset), h: Math.max(0, it.h - 2 * inset), z: z0, d: 0.5 * P, zb: 0, file: id };
        const lotTop = z0 + 0.5 * P;
        const headH = Math.max(r.head - inset, Math.min(lot.h * 0.2, P));
        const sign = { key: `${it.nk}|sign`, id, part: 'sign', x: lot.x, y: lot.y, w: lot.w, h: Math.min(headH, lot.h), z: lotTop, d: 1.2 * P, zb: lotTop, file: id };
        const body = { x: lot.x, y: lot.y + sign.h, w: lot.w, h: Math.max(0, lot.h - sign.h) };
        const closedH = shellH(id);
        const shell = { key: `${it.nk}|shell`, id, part: 'shell', ...body, z: lotTop, d: closedH, zb: lotTop, file: id };
        // Pieces stand on their parent's roof in the same column.
        const pieces = [];
        const tops = new Map();
        for (const p of map.pieces.get(id) ?? []) {
          const n = Nn[p.id];
          const parent = n.up;
          const base = parent === id ? lotTop : tops.get(`${parent}|${p.col}`) ?? lotTop;
          const isTower = n.kind === 'func';
          const d = isTower ? towerH(p.id) : podiumH;
          const b = { key: `${p.nk}|${p.key.split('|').pop()}`, id: p.id, part: isTower ? 'tower' : 'podium', x: p.x, y: p.y, w: p.w, h: p.h, z: base, d, zb: lotTop, file: id, col: p.col };
          tops.set(`${p.id}|${p.col}`, base + d);
          pieces.push(b);
          put(p.id, b);
        }
        const openTop = Math.max(lotTop + 0.8 * P, ...pieces.map((b) => b.z + b.d));
        files.set(id, { id, key: it.nk, lot, sign, shell, pieces, lotTop, openTop, closedH, body });
        items.push(lot, sign, shell);
        put(id, lot); put(id, sign); put(id, shell);
        top = Math.max(top, lotTop + closedH);
      }
    }
    for (const g of map.ghosts ?? []) {
      if (g.kind !== 'file') continue;
      const depth = g.key.split('/').length;
      const z0 = (depth - 1) * P;
      ghosts.push({ key: `${g.key}|ghost`, id: -1, part: 'ghost', ghost: g.ghost, x: g.x, y: g.y, w: g.w, h: g.h, z: z0, d: g.ghost === 'gone' ? tall * 0.25 : P, zb: z0, file: -1, name: g.name });
    }
    return { kind: 'city', map, rect: map.rect, bounds: map.bounds, items, files, byNode, ghosts, P, tall, top: Math.max(top, tall * 0.2), maxDepth };
  }

  // The Height measure: the color measure when it is numeric, else Lines.
  function heightMeasure() {
    if (state.height !== 'same') return state.height;
    return ['lines', 'cx', 'churn', 'age', 'fanin'].includes(state.paint) ? state.paint : 'lines';
  }

  // ───────────── GPU ─────────────

  const ATTRS = ['aTo', 'aFrom', 'aToZ', 'aFromZ', 'aColor', 'aFlags'];
  function attach() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0.5, 0.5, 0.5);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = box.index;
    for (const name of ['position', 'normal', 'uv']) geo.setAttribute(name, box.getAttribute(name));
    const uniforms = () => ({ uT: { value: 1 }, uFlat: { value: 0 }, uGhost: { value: 0.12 }, uPass: { value: 0 }, uBg: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3(-0.45, 0.6, 1) } });
    const solid = new THREE.ShaderMaterial({ vertexShader: BOX_VERT, fragmentShader: BOX_FRAG, uniforms: uniforms(), depthTest: true, depthWrite: true });
    const ghost = new THREE.ShaderMaterial({ vertexShader: BOX_VERT, fragmentShader: BOX_FRAG, uniforms: { ...uniforms(), uPass: { value: 1 } }, transparent: true, depthTest: true, depthWrite: false });
    const opaque = new THREE.Mesh(geo, solid);
    const glass = new THREE.Mesh(geo, ghost);
    for (const m of [opaque, glass]) { m.frustumCulled = false; m.visible = false; R.base.add(m); }
    opaque.renderOrder = 1;
    glass.renderOrder = 6;
    Object.assign(C, { geo, solid, ghost, opaque, glass, cap: 0 });
  }

  function ensure(n) {
    if (n <= C.cap) return;
    const cap = Math.max(1024, Math.ceil(n * 1.25));
    for (const name of ATTRS) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      C.geo.setAttribute(name, a);
    }
    C.cap = cap;
  }

  const uniformsEach = (fn) => { fn(C.solid.uniforms); fn(C.ghost.uniforms); };

  // ───────────── Instances ─────────────

  // Where an instance is drawn right now (mid-morph included).
  function current(key) {
    const i = C.index.get(key);
    if (i == null) return null;
    const e = C.uT;
    const f = C.from, t = C.to;
    const o = i * 6;
    const g = C.glass;
    return [0, 1, 2, 3, 4, 5].map((k) => f[o + k] + (t[o + k] - f[o + k]) * e).concat([g[i * 2] + (g[i * 2 + 1] - g[i * 2]) * e]);
  }

  function target(b) {
    if (b.part === 'shell') {
      const F = C.lay.files.get(b.file);
      const open = C.open.has(b.file);
      return { x: b.x, y: b.y, w: b.w, h: b.h, z: b.z, d: open ? F.openTop - F.lotTop : F.closedH, glass: open ? 1 : 0 };
    }
    if (b.closing) return { x: b.x, y: b.y, w: b.w, h: b.h, z: b.zb, d: 0, glass: 0 };
    return { x: b.x, y: b.y, w: b.w, h: b.h, z: b.z, d: b.d, glass: 0 };
  }

  // Where a new instance starts: pieces grow from the lot top, new files rise
  // from their lot, and in a layout change everything grows from the Map.
  function spawn(b, prev) {
    if (prev && prev.kind !== 'city') {
      const items = prev.items;
      if (!prev.byKey) prev.byKey = new Map(items.map((it) => [it.key, it]));
      const nk = b.key.slice(0, b.key.lastIndexOf('|'));
      const tail = b.key.slice(b.key.lastIndexOf('|') + 1);
      const want = prev.kind === 'map' ? (b.part === 'dir' ? `${nk}|d` : b.part === 'sign' ? `${nk}|h` : b.part === 'lot' || b.part === 'shell' ? `${nk}|b` : b.part === 'ghost' ? `${nk}|g` : `${nk}|${tail}`) : `${nk}|n`;
      let o = prev.byKey.get(want);
      if (!o && prev.kind !== 'map' && b.file >= 0) o = prev.byKey.get(`${N()[b.file].key}|n`);
      if (o) return [o.x, o.y, o.w, o.h, 0, 0.0001, 0];
      return [b.x + b.w / 2, b.y + b.h / 2, 0, 0, 0, 0.0001, 0];
    }
    if (b.part === 'tower' || b.part === 'podium') return [b.x, b.y, b.w, b.h, b.zb, 0.0001, 0];
    return [b.x, b.y, b.w, b.h, b.z, 0.0001, 0];
  }

  // Rebuild the instance list from the layout and the open files, morphing
  // from where each instance is now (or from `prev`, a previous layout).
  function sync({ dur = 280, prev = null } = {}) {
    const L = C.lay;
    if (!L) return;
    const list = [...L.items];
    for (const id of C.open) list.push(...L.files.get(id).pieces);
    const keep = new Set(list.map((b) => b.key));
    // Pieces of buildings that just closed shrink back into the lot first.
    const closing = [];
    for (const b of C.inst) if ((b.part === 'tower' || b.part === 'podium') && !keep.has(b.key) && L.files.has(b.file) && !b.closing) closing.push({ ...b, closing: true });
    list.push(...closing);
    list.push(...L.ghosts);
    const n = list.length;
    ensure(n);
    const from = new Float32Array(n * 6), to = new Float32Array(n * 6), glass = new Float32Array(n * 2);
    const motion = dur > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.forEach((b, i) => {
      const t = target(b);
      const cur = motion ? (prev ? spawn(b, prev) : current(b.key) ?? spawn(b, null)) : null;
      const f = cur ?? [t.x, t.y, t.w, t.h, t.z, t.d, t.glass];
      from.set(f.slice(0, 6), i * 6);
      to.set([t.x, t.y, t.w, t.h, t.z, t.d], i * 6);
      glass[i * 2] = f[6] ?? 0;
      glass[i * 2 + 1] = t.glass;
    });
    C.inst = list;
    C.index = new Map(list.map((b, i) => [b.key, i]));
    C.from = from; C.to = to; C.glass = glass;
    const g = C.geo;
    const aTo = g.getAttribute('aTo').array, aFrom = g.getAttribute('aFrom').array, aToZ = g.getAttribute('aToZ').array, aFromZ = g.getAttribute('aFromZ').array, aFlags = g.getAttribute('aFlags').array;
    list.forEach((b, i) => {
      const o = i * 6;
      aFrom.set([from[o], from[o + 1], from[o + 2], from[o + 3]], i * 4);
      aTo.set([to[o], to[o + 1], to[o + 2], to[o + 3]], i * 4);
      aFromZ.set([from[o + 4], from[o + 5], b.zb, 0], i * 4);
      aToZ.set([to[o + 4], to[o + 5], b.zb, 0], i * 4);
      aFlags[i * 4 + 1] = glass[i * 2];
      aFlags[i * 4 + 2] = glass[i * 2 + 1];
    });
    for (const name of ['aTo', 'aFrom', 'aToZ', 'aFromZ']) g.getAttribute(name).needsUpdate = true;
    g.instanceCount = n;
    C.anim = motion ? { t0: performance.now(), dur } : null;
    C.uT = motion ? 0 : 1;
    uniformsEach((u) => { u.uT.value = C.uT; });
    C.closing = closing;
    color();
    skyBuild();
    env.requestDraw();
  }

  // ───────────── Colors and flags ─────────────

  function color() {
    if (!C.lay || !C.inst.length) return;
    const th = env.theme;
    const bg = env.rgb(th.bg);
    const lit = env.makeLit();
    const g = C.geo;
    const col = g.getAttribute('aColor').array;
    const T = state.T;
    const iso = state.isolate && S.setSize(state.set) ? S.seedIds(T.I, state.set) : null;
    const isoSet = iso ? new Set(iso) : null;
    const isoUp = new Set();
    if (iso) for (const m of iso) for (let p = m; p >= 0; p = T.N[p].up) isoUp.add(p);
    const inside = (id) => { for (let p = id; p >= 0; p = T.N[p].up) if (isoSet.has(p)) return true; return false; };
    // Labels of parts isolated away are drawn faint (see ink).
    C.faint = iso ? (id) => !inside(id) && !isoUp.has(id) : null;
    const before = C.ghostSig;
    C.ghostOf = new Uint8Array(C.inst.length);
    C.inst.forEach((b, i) => {
      let c;
      if (b.part === 'ghost') c = env.rgb(b.ghost === 'gone' ? env.STATUS.critical : env.STATUS.good);
      else {
        c = env.paintOf(b.id);
        if (b.part === 'dir') c = env.mix(c, env.rgb(th.ink3), 0.12);
        if (b.part === 'lot') c = env.mix(c, bg, 0.5);
        if (lit && !lit(b.id)) c = env.mix(c, bg, b.part === 'dir' ? 0.45 : 0.78);
      }
      let ghost = b.part === 'ghost';
      if (isoSet && b.part !== 'ghost') {
        const keep = inside(b.id) || ((b.part === 'dir' || b.part === 'lot' || b.part === 'sign') && isoUp.has(b.id));
        if (!keep) { if (b.part === 'dir') c = env.mix(c, bg, 0.6); else ghost = true; }
      }
      if (C.cut.has(i)) ghost = true;
      C.ghostOf[i] = ghost ? 1 : 0;
      col[i * 4] = c[0]; col[i * 4 + 1] = c[1]; col[i * 4 + 2] = c[2]; col[i * 4 + 3] = 1;
    });
    g.getAttribute('aColor').needsUpdate = true;
    let sig = 0;
    C.ghostOf.forEach((v, i) => { if (v) sig = (sig * 31 + i + 1) % 1e9; });
    C.ghostSig = sig;
    if (sig !== before && C.sky) C.sky = grid((b, i) => !b.closing && b.part !== 'ghost' && !(b.part === 'shell' && C.glass[i * 2 + 1] > 0.5) && !C.ghostOf[i]);
    flags();
  }

  function flags() {
    if (!C.inst.length) return;
    const T = state.T;
    const g = C.geo;
    const arr = g.getAttribute('aFlags').array;
    const members = new Set(env.selIds());
    const hoverFile = state.hover > 0 ? T.fileOf[state.hover] : -1;
    C.inst.forEach((b, i) => {
      let bits = 0;
      if (b.id === state.hover || ((b.part === 'lot' || b.part === 'sign' || b.part === 'shell') && b.file === hoverFile && hoverFile === state.hover)) bits |= HOVER;
      if (members.has(b.id)) bits |= MEMBER;
      if (C.ghostOf?.[i]) bits |= GHOST;
      if (b.file >= 0 && b.file === C.flat.file && (b.part === 'tower' || b.part === 'podium' || b.part === 'shell')) bits |= FLAT;
      arr[i * 4] = bits;
    });
    g.getAttribute('aFlags').needsUpdate = true;
    env.requestDraw();
  }

  // ───────────── Projection ─────────────

  // The screen mapping and its inverse on the ground: a screen point is the
  // line P(z) = P0 − z·D in layout units.
  function view() {
    const A = env.affine();
    const det = A.u[0] * A.v[1] - A.v[0] * A.u[1];
    const inv = (x, y) => [(x * A.v[1] - A.v[0] * y) / det, (A.u[0] * y - x * A.u[1]) / det];
    const D = inv(A.w[0], A.w[1]);
    return { A, inv, D, ul: Math.hypot(A.u[0], A.u[1]), vl: Math.hypot(A.v[0], A.v[1]) };
  }

  const proj = (A, x, y, z) => [A.O[0] + x * A.u[0] + y * A.v[0] + z * A.w[0], A.O[1] + x * A.u[1] + y * A.v[1] + z * A.w[1]];

  // Geometry at rest, with the reading pose applied.
  function rest(i) {
    const o = i * 6;
    const t = C.to;
    const b = C.inst[i];
    let z = t[o + 4], d = t[o + 5];
    if (b.file === C.flat.file && C.flat.to && (b.part === 'tower' || b.part === 'podium' || b.part === 'shell')) {
      const f = 1 - 0.85 * C.flat.to;
      z = b.zb + (z - b.zb) * f;
      d *= f;
    }
    return { x: t[o], y: t[o + 1], w: t[o + 2], h: t[o + 3], z, d };
  }
  const restOf = (b) => { const i = C.index.get(b.key); return i == null ? { x: b.x, y: b.y, w: b.w, h: b.h, z: b.z, d: b.d } : rest(i); };
  const topOf = (b) => { const r = restOf(b); return r.z + r.d; };

  // ───────────── Skyline ─────────────

  function grid(filter) {
    const L = C.lay;
    const b = L.bounds;
    const lots = [...L.files.values()].map((F) => F.lot.w * F.lot.h).filter((a) => a > 0).sort((p, q) => p - q);
    const median = lots.length ? lots[Math.floor(lots.length / 2)] : b.w * b.h / 100;
    const cell = Math.max(Math.sqrt(median), b.w / 256, b.h / 256, 1e-6);
    const nx = Math.max(1, Math.min(256, Math.ceil(b.w / cell))), ny = Math.max(1, Math.min(256, Math.ceil(b.h / cell)));
    const cw = b.w / nx, ch = b.h / ny;
    const cells = Array.from({ length: nx * ny }, () => []);
    const box = new Float32Array(C.inst.length * 6);
    let maxZ = 0, count = 0;
    C.inst.forEach((it, i) => {
      if (!filter(it, i)) return;
      const r = rest(i);
      if (r.d <= 1e-4 || r.w <= 0 || r.h <= 0) return;
      box.set([r.x, r.y, r.x + r.w, r.y + r.h, r.z, r.z + r.d], i * 6);
      maxZ = Math.max(maxZ, r.z + r.d);
      const gx0 = clamp(Math.floor((r.x - b.x) / cw), 0, nx - 1), gx1 = clamp(Math.floor((r.x + r.w - b.x) / cw), 0, nx - 1);
      const gy0 = clamp(Math.floor((r.y - b.y) / ch), 0, ny - 1), gy1 = clamp(Math.floor((r.y + r.h - b.y) / ch), 0, ny - 1);
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) cells[gy * nx + gx].push(i);
      count++;
    });
    return { cells, box, nx, ny, cw, ch, x0: b.x, y0: b.y, maxZ, count };
  }

  function skyBuild() {
    if (!C.lay) return;
    const solid = (b, i) => !b.closing && b.part !== 'ghost' && !(b.part === 'shell' && C.glass[i * 2 + 1] > 0.5);
    C.skyAll = grid(solid);
    C.sky = grid((b, i) => solid(b, i) && !C.ghostOf?.[i]);
  }

  // Walk the line P(z) = P0 − z·D from z = zTop down to zEnd. Returns the
  // first box hit (the nearest to the camera), or every box when `all`.
  function walkLine(G, P0, D, zTop, zEnd, { all = false, skip = null } = {}) {
    if (!G || zTop <= zEnd) return all ? [] : null;
    const at = (z) => [P0[0] - z * D[0], P0[1] - z * D[1]];
    let [sx, sy] = at(zTop);
    let [ex, ey] = at(zEnd);
    // Clip the ground segment to the grid.
    const bx0 = G.x0, by0 = G.y0, bx1 = G.x0 + G.nx * G.cw, by1 = G.y0 + G.ny * G.ch;
    let t0 = 0, t1 = 1;
    const dx = ex - sx, dy = ey - sy;
    for (const [p, q] of [[-dx, sx - bx0], [dx, bx1 - sx], [-dy, sy - by0], [dy, by1 - sy]]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) return all ? [] : null; continue; }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    }
    if (t0 > t1) return all ? [] : null;
    const zAt = (t) => zTop + (zEnd - zTop) * t;
    let gx = clamp(Math.floor((sx + dx * t0 - G.x0) / G.cw), 0, G.nx - 1), gy = clamp(Math.floor((sy + dy * t0 - G.y0) / G.ch), 0, G.ny - 1);
    const ex1 = clamp(Math.floor((sx + dx * t1 - G.x0) / G.cw), 0, G.nx - 1), ey1 = clamp(Math.floor((sy + dy * t1 - G.y0) / G.ch), 0, G.ny - 1);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tDx = Math.abs(dx) > 1e-12 ? G.cw / Math.abs(dx) : Infinity, tDy = Math.abs(dy) > 1e-12 ? G.ch / Math.abs(dy) : Infinity;
    const nextX = (gxv) => (Math.abs(dx) > 1e-12 ? (G.x0 + (gxv + (dx > 0 ? 1 : 0)) * G.cw - sx) / dx : Infinity);
    const nextY = (gyv) => (Math.abs(dy) > 1e-12 ? (G.y0 + (gyv + (dy > 0 ? 1 : 0)) * G.ch - sy) / dy : Infinity);
    let tMaxX = nextX(gx), tMaxY = nextY(gy);
    let best = null, bestZ = -Infinity;
    const hits = all ? new Set() : null;
    const seen = new Set();
    let tCell = t0;
    for (let guard = 0; guard < G.nx + G.ny + 4; guard++) {
      const tExit = Math.min(tMaxX, tMaxY, t1);
      for (const i of G.cells[gy * G.nx + gx]) {
        if (seen.has(i)) continue;
        seen.add(i);
        if (skip?.(i)) continue;
        const o = i * 6;
        const [x0, y0, x1, y1, z0, z1] = [G.box[o], G.box[o + 1], G.box[o + 2], G.box[o + 3], G.box[o + 4], G.box[o + 5]];
        let lo = Math.max(z0, zEnd), hi = Math.min(z1, zTop), face = 'top';
        for (let axis = 0; axis < 2; axis++) {
          const p = P0[axis], d = D[axis], a = axis ? y0 : x0, b = axis ? y1 : x1;
          if (Math.abs(d) < 1e-12) { if (p < a || p > b) { lo = Infinity; break; } continue; }
          const za = (p - a) / d, zb = (p - b) / d;
          const zl = Math.min(za, zb), zh = Math.max(za, zb);
          if (zh < hi) { hi = zh; face = axis ? 'y' : 'x'; }
          lo = Math.max(lo, zl);
        }
        if (lo > hi) continue;
        if (all) { hits.add(i); continue; }
        if (hi > bestZ) { bestZ = hi; best = { index: i, z: hi, face: hi >= z1 - 1e-9 ? 'top' : face }; }
      }
      if (!all && best && bestZ >= zAt(tExit)) break;
      if (gx === ex1 && gy === ey1) break;
      if (tMaxX < tMaxY) { gx += stepX; tCell = tMaxX; tMaxX += tDx; } else { gy += stepY; tCell = tMaxY; tMaxY += tDy; }
      if (gx < 0 || gy < 0 || gx >= G.nx || gy >= G.ny || tCell > t1) break;
    }
    if (all) return [...hits];
    if (best) best.point = [P0[0] - best.z * D[0], P0[1] - best.z * D[1], best.z];
    return best;
  }

  // Is the screen point drawn at world point (x, y, z) hidden by a box?
  function hidden(x, y, z) {
    if (!C.sky) return false;
    const V = view();
    const eps = C.lay.bounds.w * 2e-5 + 1e-6;
    const P0 = [x + z * V.D[0], y + z * V.D[1]];
    return !!walkLine(C.sky, P0, V.D, C.sky.maxZ + eps, z + eps);
  }

  // What is under a screen point: { id, line, part, face, point }.
  function pick(sx, sy) {
    if (!C.sky || !C.lay) return null;
    const V = view();
    const P0 = V.inv(sx - V.A.O[0], sy - V.A.O[1]);
    const hit = walkLine(C.sky, P0, V.D, C.sky.maxZ + 1e-6, -1e-6);
    if (!hit) return null;
    const b = C.inst[hit.index];
    const out = { id: b.id, part: b.part, face: hit.face, point: hit.point };
    if (b.id < 0) return null;
    if (hit.face === 'top' && (b.part === 'lot' || b.part === 'tower' || b.part === 'podium') && C.open.has(b.file)) {
      const at = lineAt(b.file, hit.point[0], hit.point[1]);
      if (at.line) {
        Object.assign(out, at);
        const owner = ownerOf(b.file)[at.line] ?? b.file;
        out.id = owner;
      }
    }
    return out;
  }

  function lineAt(file, x, y) {
    const c = C.lay.map.code.get(file);
    if (!c || y < c.y) return { line: 0 };
    const col = Math.floor((x - c.x) / (c.colW + c.gap));
    const row = Math.floor((y - c.y) / c.lh);
    if (col < 0 || col >= c.cols || row < 0 || row >= c.rows) return { line: 0 };
    let line = col * c.rows + row + 1;
    if (line > state.T.N[file].lines) line = 0;
    const inCol = x - c.x - col * (c.colW + c.gap);
    return { line, gutter: inCol >= 0 && inCol < env.CODE.gut * env.CODE.cw * c.lh, mark: inCol > c.colW - 5 * env.CODE.cw * c.lh && inCol <= c.colW };
  }

  // The deepest symbol that owns each line of a file.
  function ownerOf(file) {
    let o = C.ownerCache.get(file);
    if (o && o.made === state.model.made) return o.arr;
    const T = state.T;
    const arr = new Int32Array(T.N[file].lines + 2).fill(file);
    env.walk(file, (k) => { if (k === file) return; const n = T.N[k]; if (n.from) for (let l = n.from; l <= n.to && l < arr.length; l++) arr[l] = k; });
    C.ownerCache.set(file, { made: state.model.made, arr });
    return arr;
  }

  // The roof a symbol's code sits on (the lot top for code outside symbols).
  function roofOf(file, id) {
    const F = C.lay.files.get(file);
    if (!F) return 0;
    if (id === file || !C.open.has(file)) return F.lotTop;
    const b = C.lay.byNode.get(id)?.find((x) => x.part === 'tower' || x.part === 'podium');
    return b ? topOf(b) : F.lotTop;
  }

  // ───────────── Open buildings ─────────────

  // Open the files that are big enough on screen (with hysteresis), plus set
  // members and the hovered file, largest first within the instance budget.
  function plan() {
    if (!C.lay || state.lay?.kind !== 'city') return;
    C.planAt = performance.now();
    const V = view();
    const T = state.T;
    const forced = new Set();
    for (const id of env.selIds()) { const f = T.fileOf[id]; if (f >= 0) forced.add(f); }
    for (const r of state.set.ranges) { const f = env.idOf(r[0]); if (f >= 0) forced.add(f); }
    if (C.hoverOpen > 0) forced.add(C.hoverOpen);
    const want = [];
    let budget = BUDGET - C.lay.items.length - C.lay.ghosts.length;
    const A = V.A;
    for (const F of C.lay.files.values()) {
      // The lot's screen bounds: its corner plus the projected sides (affine).
      const L = F.lot;
      const ox = A.O[0] + L.x * A.u[0] + L.y * A.v[0] + F.lotTop * A.w[0], oy = A.O[1] + L.x * A.u[1] + L.y * A.v[1] + F.lotTop * A.w[1];
      const ux = L.w * A.u[0], uy = L.w * A.u[1], vx = L.h * A.v[0], vy = L.h * A.v[1];
      const on = ox + Math.max(0, ux) + Math.max(0, vx) > -80 && ox + Math.min(0, ux) + Math.min(0, vx) < R.W + 80 && oy + Math.max(0, uy) + Math.max(0, vy) > -80 && oy + Math.min(0, uy) + Math.min(0, vy) < R.H + 80;
      if (!on && !forced.has(F.id)) continue;
      const short = Math.min(V.ul * F.lot.w, V.vl * F.lot.h);
      const open = forced.has(F.id) || short >= OPEN_AT || (C.open.has(F.id) && short >= CLOSE_AT);
      if (open) want.push([forced.has(F.id) ? Infinity : short, F]);
    }
    want.sort((a, b) => b[0] - a[0]);
    const next = new Set();
    for (const [, F] of want) {
      if (F.pieces.length > budget) continue;
      budget -= F.pieces.length;
      next.add(F.id);
    }
    const same = next.size === C.open.size && [...next].every((id) => C.open.has(id));
    if (same) return;
    C.open = next;
    C.openKeys = new Set([...next].map((id) => T.N[id].key));
    C.cut = new Set();
    sync({ dur: 280 });
    env.relink?.();
  }

  // ───────────── Reading pose ─────────────

  // When the selected file is readable, its towers ease down to a low terrace
  // (15% height) so the code reads, and the view tips toward the reading angle.
  function readingFile() {
    const T = state.T;
    const id = env.selIds()[0] ?? -1;
    const f = id >= 0 ? T.fileOf[id] : -1;
    if (f < 0 || !C.open.has(f)) return -1;
    const c = C.lay.map.code.get(f);
    if (!c) return -1;
    const vlh = view().vl * c.lh;
    const was = C.flat.file === f && C.flat.to > 0;
    return vlh >= (was ? UNREAD_AT : READ_AT) ? f : -1;
  }

  function updateFlat(now) {
    const f = readingFile();
    const fl = C.flat;
    const want = f >= 0 ? 1 : 0;
    if (f >= 0 && f !== fl.file) {
      fl.file = f;
      fl.key = state.T.N[f].key;
      fl.from = 0; fl.to = 1; fl.t0 = now;
      fl.prevPitch = fl.prevPitch ?? R.pitch;
      flags();
      skyBuild();
      if (now - (R.orbitAt ?? -1e9) > 10000 && Math.abs(R.pitch - READ_PITCH) > 0.05 && !R.cam && !R.orbit) {
        setPivot(centerPoint());
        R.cam = { from: { pitch: R.pitch, yaw: R.yaw }, to: { pitch: READ_PITCH, yaw: R.yaw }, t0: now, dur: 420 };
      }
    } else if (want !== fl.to) {
      fl.from = fl.t; fl.to = want; fl.t0 = now;
      skyBuild();
      if (!want && fl.prevPitch != null && now - (R.orbitAt ?? -1e9) > 10000 && !R.cam && !R.orbit) {
        setPivot(centerPoint());
        R.cam = { from: { pitch: R.pitch, yaw: R.yaw }, to: { pitch: fl.prevPitch, yaw: R.yaw }, t0: now, dur: 420 };
      }
      if (!want) fl.prevPitch = null;
    }
    const p = clamp((now - fl.t0) / 280, 0, 1);
    fl.t = fl.from + (fl.to - fl.from) * ease(p);
    if (!fl.to && p >= 1 && fl.file >= 0) { fl.file = -1; fl.key = null; flags(); }
    uniformsEach((u) => { u.uFlat.value = fl.t; });
    return p < 1;
  }

  // ───────────── Camera ─────────────

  function rotate(v) {
    const c = Math.cos(R.yaw), s = Math.sin(R.yaw), cp = Math.cos(R.pitch), sp = Math.sin(R.pitch);
    const x = c * v[0] - s * v[1], y = s * v[0] + c * v[1];
    return [x, y * cp + v[2] * sp];
  }

  // Move the rotation pivot without moving anything on screen.
  function setPivot(p1) {
    if (!p1) return;
    const p0 = R.pivot;
    const t = state.t;
    const d = [p1[0] - p0[0], -(p1[1] - p0[1]), (p1[2] ?? 0) - p0[2]];
    const r = rotate(d);
    const vx = r[0] + p0[0] - p1[0];
    const vy = r[1] - p0[1] + p1[1];
    R.pivot = [p1[0], p1[1], p1[2] ?? 0];
    env.setTransform(t.x + t.k * vx, t.y - t.k * vy, t.k);
  }

  // The world point under the middle of the free screen area.
  function centerPoint() {
    const v = env.viewport();
    const sx = v.x + v.w / 2, sy = v.y + v.h / 2;
    const hit = pick(sx, sy);
    if (hit?.point) return hit.point;
    const V = view();
    const P = V.inv(sx - V.A.O[0], sy - V.A.O[1]);
    return [P[0], P[1], 0];
  }

  function orbitStart() { setPivot(centerPoint()); R.cam = null; }

  function animateTo(pitch, yaw, dur = 480) {
    setPivot(centerPoint());
    const now = performance.now();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { R.pitch = pitch; R.yaw = yaw; viewChanged(true); env.requestDraw(); return; }
    R.cam = { from: { pitch: R.pitch, yaw: R.yaw }, to: { pitch, yaw }, t0: now, dur };
    env.requestDraw();
  }

  function angle(id) {
    const a = { tilt: [0.95, -0.5], top: [0, 0], low: [1.2, null] }[id];
    if (!a) return;
    state.angle = id;
    R.orbitAt = performance.now();
    animateTo(a[0], a[1] ?? R.cam?.to.yaw ?? R.yaw);
  }

  function turn(dir) {
    R.orbitAt = performance.now();
    animateTo(R.cam?.to.pitch ?? R.pitch, (R.cam?.to.yaw ?? R.yaw) + dir * Math.PI / 4, 420);
  }

  // A 3D box around a part: its boxes at rest.
  function boxesFor(id) {
    const T = state.T;
    const n = T.N[id];
    if (!n || !C.lay) return [];
    const L = C.lay;
    if (n.kind === 'dir' || n.kind === 'repo') return L.byNode.get(id) ?? [];
    const f = T.fileOf[id];
    const F = L.files.get(f);
    if (!F) return [];
    if (id === f) return [F.lot, F.shell];
    if (C.open.has(f)) { const list = L.byNode.get(id) ?? []; if (list.length) return list; }
    return [F.lot, F.shell];
  }

  // The space boxes take at rest; `flat` lowers a reading file's towers.
  function extent(boxes, flat = -1) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of boxes) {
      const r = { ...restOf(b) };
      if (b.file === flat && b.file !== C.flat.file && (b.part === 'tower' || b.part === 'podium' || b.part === 'shell')) { r.z = b.zb + (r.z - b.zb) * 0.15; r.d *= 0.15; }
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); z0 = Math.min(z0, r.z); z1 = Math.max(z1, r.z + r.d);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, z: z0, d: z1 - z0 };
  }

  // Fly to a part. Functions and types zoom until their code is readable and
  // the view tips to the reading angle (unless you orbited in the last 10 s).
  function flyTo(id, ms = 700) {
    const T = state.T;
    const n = T.N[id];
    if (!n) return;
    const f = T.fileOf[id];
    if (f >= 0 && !C.open.has(f)) { C.open.add(f); C.openKeys.add(T.N[f].key); sync({ dur: 280 }); }
    const boxes = boxesFor(id);
    if (!boxes.length) return;
    const symbol = f >= 0 && f !== id;
    const box = extent(boxes, symbol ? f : -1);
    const recent = performance.now() - (R.orbitAt ?? -1e9) < 10000;
    if (symbol && !recent && Math.abs(R.pitch - READ_PITCH) > 0.05) {
      setPivot([box.x + box.w / 2, box.y + box.h / 2, box.z]);
      R.cam = { from: { pitch: R.pitch, yaw: R.yaw }, to: { pitch: READ_PITCH, yaw: R.yaw }, t0: performance.now(), dur: ms };
    }
    const c = C.lay.map.code.get(f);
    let minK = 0;
    if (symbol && c) {
      const p = R.cam?.to.pitch ?? R.pitch, y = R.cam?.to.yaw ?? R.yaw;
      const vPer = Math.hypot(Math.sin(y), Math.cos(y) * Math.cos(p));
      minK = Math.min(10 / (c.lh * vPer), env.viewport().w * 0.9 / (c.colW + c.lh * 4));
      box.h = Math.min(box.h, c.lh * 60);
    }
    env.fitBox(box, symbol ? 0.8 : 0.6, ms, minK);
    cutSoon();
  }

  // ───────────── Isolate and cutaway ─────────────

  // Ghost whatever stands between the camera and a member's roof.
  function cutaway() {
    if (!C.lay || !C.skyAll) return;
    const T = state.T;
    const ids = env.selIds().slice(0, 40);
    const next = new Set();
    if (ids.length) {
      const V = view();
      const eps = C.lay.bounds.w * 2e-5 + 1e-6;
      for (const id of ids) {
        const own = new Set(boxesFor(id).map((b) => C.index.get(b.key)));
        const a = anchor(id);
        if (!a) continue;
        const P0 = [a[0] + a[2] * V.D[0], a[1] + a[2] * V.D[1]];
        const f = T.fileOf[id];
        for (const i of walkLine(C.skyAll, P0, V.D, C.skyAll.maxZ + eps, a[2] + eps, { all: true })) {
          const b = C.inst[i];
          if (own.has(i) || b.part === 'dir' || b.part === 'lot' || (f >= 0 && b.file === f && b.part === 'shell')) continue;
          if (env.isUnder(id, b.id) && b.part !== 'shell') continue;
          next.add(i);
        }
      }
    }
    const same = next.size === C.cut.size && [...next].every((i) => C.cut.has(i));
    if (same) return;
    C.cut = next;
    color();
  }

  function cutSoon() {
    clearTimeout(C.cutTimer);
    C.cutTimer = setTimeout(() => { C.cutTimer = 0; cutaway(); env.requestDraw(); }, 120);
  }

  // ───────────── Links ─────────────

  // A link end: the deepest visible box. Symbols in closed buildings lift to
  // their file.
  function endOf(id, rank) {
    const T = state.T;
    let x = env.liftTo(id, Math.max(rank, 3));
    const f = T.fileOf[x];
    if (f >= 0 && f !== x && !C.open.has(f)) x = f;
    return x;
  }

  function anchor(id) {
    const T = state.T;
    const L = C.lay;
    if (!L) return null;
    const n = T.N[id];
    if (!n) return null;
    if (n.kind === 'dir' || n.kind === 'repo') {
      const b = L.byNode.get(id)?.[0];
      if (!b) return null;
      return [b.x + b.w / 2, b.y + b.h / 2, topOf(b)];
    }
    const f = T.fileOf[id];
    const F = L.files.get(f);
    if (!F) return null;
    if (f !== id && C.open.has(f)) {
      const list = L.byNode.get(id) ?? [];
      const b = list[0];
      if (b) { const c = L.map.code.get(f); return [b.x + Math.min(b.w, 6 * (c?.lh ?? 1)) / 2, b.y + Math.min(b.h, (c?.lh ?? 1) * 2) / 2, topOf(b)]; }
    }
    if (C.open.has(f)) return [F.sign.x + F.sign.w / 2, F.sign.y + F.sign.h / 2, topOf(F.sign)];
    const s = restOf(F.shell);
    return [s.x + s.w / 2, s.y + s.h / 2, s.z + s.d];
  }

  // A code line on its roof: where call arcs leave and land at reading zoom.
  function siteAnchor(file, line) {
    const c = C.lay?.map.code.get(file);
    if (!c) return null;
    const j = Math.floor((line - 1) / c.rows), r = (line - 1) % c.rows;
    const owner = ownerOf(file)[line] ?? file;
    return [c.x + j * (c.colW + c.gap) + env.CODE.gut * env.CODE.cw * c.lh, c.y + (r + 0.5) * c.lh, roofOf(file, owner)];
  }

  // Skyways: control points run through the hubs of the folders on the tree
  // path. A hub floats above its folder, higher for folders near the root, so
  // far links travel high and local ones stay low. Bundled (β = 0.85) and
  // sampled as a cubic B-spline in 3D.
  function route(e) {
    const T = state.T;
    const L = C.lay;
    const a = e.pa ?? anchor(e.a), b = e.pb ?? anchor(e.b);
    if (!a || !b) return null;
    const fa = T.fileOf[e.a], fb = T.fileOf[e.b];
    if (fa >= 0 && fa === fb) {
      const F = L.files.get(fa);
      const top = (C.open.has(fa) ? F.openTop : F.lotTop + F.closedH) + L.tall * 0.08;
      return spline([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.max(top, a[2], b[2])], b], 24);
    }
    const pa = env.pathOf(e.a), pb = env.pathOf(e.b);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    const via = [...pa.slice(Math.max(i - 1, 0), -1).reverse(), ...pb.slice(Math.max(i - 1, 0), -1)].filter((x, k, arr) => (T.N[x].kind === 'dir' || T.N[x].kind === 'repo') && arr[k - 1] !== x);
    const hubs = via.slice(0, 10).map((d) => {
      const r = L.map.rect.get(d);
      if (!r) return null;
      return [r.x + r.w / 2, r.y + r.h / 2, T.depth[d] * L.P + L.tall * (0.5 + 0.5 * (1 - T.depth[d] / L.maxDepth))];
    }).filter(Boolean);
    let pts = [a, ...hubs, b];
    if (pts.length === 2) pts = [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.max(a[2], b[2]) + Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.25], b];
    const n = pts.length - 1;
    pts = pts.map((p, k) => (k === 0 || k === n ? p : p.map((v, j) => 0.85 * v + 0.15 * (a[j] + (b[j] - a[j]) * (k / n)))));
    return spline(pts, 24);
  }

  // Uniform cubic B-spline through clamped ends.
  function spline(pts, count) {
    const E = [pts[0], pts[0], ...pts, pts.at(-1), pts.at(-1)];
    const segs = E.length - 3;
    const out = [];
    for (let s = 0; s < count; s++) {
      const u = (s / (count - 1)) * segs;
      const k = Math.min(segs - 1, Math.floor(u));
      const t = u - k;
      const b0 = (1 - t) ** 3 / 6, b1 = (3 * t ** 3 - 6 * t * t + 4) / 6, b2 = (-3 * t ** 3 + 3 * t * t + 3 * t + 1) / 6, b3 = t ** 3 / 6;
      const [p0, p1, p2, p3] = [E[k], E[k + 1], E[k + 2], E[k + 3]];
      out.push([0, 1, 2].map((j) => b0 * p0[j] + b1 * p1[j] + b2 * p2[j] + b3 * p3[j]));
    }
    out[0] = [...pts[0]];
    out[count - 1] = [...pts.at(-1)];
    return out;
  }

  // ───────────── Ink: labels, roofs, beacons ─────────────

  function ink(ctx, now) {
    if (!C.lay || !C.inst.length) return;
    const th = env.theme;
    const T = state.T;
    const V = view();
    const A = V.A;
    roofs(ctx, V);
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    ctx.textBaseline = 'middle';
    const gridSet = new Set();
    const cell = 16;
    let count = 0;
    const free = (x, y, w, h) => {
      for (let gx = Math.floor(x / cell); gx <= Math.floor((x + w) / cell); gx++) for (let gy = Math.floor(y / cell); gy <= Math.floor((y + h) / cell); gy++) if (gridSet.has(gx * 4096 + gy)) return false;
      return true;
    };
    const take = (x, y, w, h) => { for (let gx = Math.floor(x / cell); gx <= Math.floor((x + w) / cell); gx++) for (let gy = Math.floor(y / cell); gy <= Math.floor((y + h) / cell); gy++) gridSet.add(gx * 4096 + gy); count++; };
    const onScreen = (p) => p[0] > -40 && p[1] > -20 && p[0] < R.W + 40 && p[1] < R.H + 20;
    // Labels stay clear of the top bar and the screen's edges.
    const topY = env.viewport().y - 4;
    const clear = (x, y, w) => y > topY && x >= 2 && x + w <= R.W - 2;
    // Signs carry file names, with the staged glyph.
    const files = C.lay.bySize ??= [...C.lay.files.values()].sort((a, b) => b.lot.w * b.lot.h - a.lot.w * a.lot.h);
    for (const F of files) {
      if (count >= 400) break;
      const s = F.sign;
      const span = V.ul * s.w;
      if (span < 34) continue;
      const top = topOf(s);
      const p = proj(A, s.x + s.w / 2, s.y + s.h / 2, top);
      if (!onScreen(p) || hidden(s.x + s.w / 2, s.y + s.h / 2, top)) continue;
      const n = T.N[F.id];
      const size = env.fontSize(V.vl * s.h * 0.55, 9.5, 14);
      ctx.font = `600 ${size}px ${env.UI_FONT}`;
      const st = env.stageOf(F.id);
      const glyph = st ? ` ${{ add: '+', edit: '~', delete: '−' }[st]}` : '';
      const text = env.fitText(ctx, n.name + glyph, Math.min(span - 8, 220));
      if (!text) continue;
      const w = env.textWidth(ctx, text);
      const lx = p[0] - w / 2;
      if (!clear(lx, p[1] - size / 2, w) || !free(lx, p[1] - size / 2, w, size)) continue;
      take(lx, p[1] - size / 2, w, size);
      env.haloText(ctx, text, lx, p[1], C.faint?.(F.id) ? th.ink3 : th.ink, th);
    }
    // Symbol names on roofs big enough to hold them.
    const roofsSeen = [];
    for (const id of C.open) for (const b of C.lay.files.get(id).pieces) roofsSeen.push(b);
    roofsSeen.sort((a, b) => b.w * b.h - a.w * a.h);
    for (const b of roofsSeen) {
      if (count >= 400) break;
      if (V.ul * b.w < 40 || V.vl * b.h < 14 || !/\|s0$/.test(b.key)) continue;
      const top = topOf(b);
      const p = proj(A, b.x, b.y, top);
      if (!onScreen(p) || hidden(b.x + b.w * 0.05, b.y + b.h * 0.05, top) || C.faint?.(b.id)) continue;
      const n = T.N[b.id];
      ctx.font = `600 11px ${env.UI_FONT}`;
      const text = env.fitText(ctx, `${n.form === 'ctor' ? 'new' : n.form ?? n.kind} ${n.name}`, Math.min(V.ul * b.w - 10, 200));
      if (!text) continue;
      const w = env.textWidth(ctx, text);
      if (!clear(p[0] + 3, p[1] + 2, w + 10) || !free(p[0] + 3, p[1] + 2, w + 10, 16)) continue;
      take(p[0] + 3, p[1] + 2, w + 10, 16);
      ctx.fillStyle = th.halo;
      ctx.beginPath();
      ctx.roundRect(p[0] + 3, p[1] + 2, w + 10, 16, 4);
      ctx.fill();
      ctx.fillStyle = n.kind === 'type' ? th.series[6] : th.ink;
      ctx.fillText(text, p[0] + 8, p[1] + 10.5);
    }
    // District names at the plinth's front-left corner.
    const dirs = C.lay.districts ??= C.lay.items.filter((b) => b.part === 'dir' && T.depth[b.id] <= 3).sort((a, b) => T.depth[a.id] - T.depth[b.id] || b.w * b.h - a.w * a.h);
    for (const b of dirs) {
      if (count >= 400) break;
      const top = b.z + b.d;
      const p = proj(A, b.x + b.w * 0.02, b.y + b.h * 0.02, top);
      const q = proj(A, b.x + b.w, b.y, top);
      if (!onScreen(p) || Math.hypot(q[0] - p[0], q[1] - p[1]) < 60) continue;
      const n = T.N[b.id];
      const size = T.depth[b.id] <= 2 ? 13 : 11.5;
      ctx.font = `650 ${size}px ${env.UI_FONT}`;
      const text = env.fitText(ctx, n.kind === 'repo' && n.branch ? `${n.name} · ${n.branch}` : n.name, 180);
      const w = env.textWidth(ctx, text);
      if (!clear(p[0], p[1] - 8, w) || !free(p[0], p[1] - 8, w, 16) || hidden(b.x + b.w * 0.02, b.y + b.h * 0.02, top)) continue;
      take(p[0], p[1] - 8, w, 16);
      env.haloText(ctx, text, p[0], p[1], C.faint?.(b.id) ? th.ink3 : th.ink, th);
    }
    // Ghost labels for deleted and new files.
    for (const g of C.lay.ghosts) {
      const p = proj(A, g.x + g.w / 2, g.y + g.h / 2, g.z + g.d);
      if (!onScreen(p) || V.ul * g.w < 40) continue;
      ctx.font = `600 11px ${env.UI_FONT}`;
      const text = `${g.ghost === 'gone' ? 'deleted' : 'new'} · ${g.name}`;
      env.haloText(ctx, text, p[0] - env.textWidth(ctx, text) / 2, p[1], g.ghost === 'gone' ? env.STATUS.critical : env.STATUS.good, th);
    }
    // Finding beacons above roofs, when Color is Issues or a rule is lit.
    if (state.paint === 'issues' || state.spot) beacons(ctx, V);
  }

  function beacons(ctx, V) {
    const T = state.T;
    const A = V.A;
    const sevOf = (id) => {
      if (!state.spot) return T.sev[id];
      let s = 0;
      env.walk(id, (k) => { for (const i of T.issuesOf[k]) { const iss = state.model.issues[i]; if (iss.rule === state.spot && !iss.waived) s = Math.max(s, env.LEVEL_RANK[iss.level]); } });
      return s;
    };
    let drawn = 0;
    const draw = (x, y, z, sev) => {
      if (!sev || drawn > 500) return;
      const p = proj(A, x, y, z);
      if (p[0] < -10 || p[1] < -10 || p[0] > R.W + 10 || p[1] > R.H + 10 || hidden(x, y, z)) return;
      const lv = env.LEVELS[3 - sev];
      const s = 5;
      const cy = p[1] - 9;
      ctx.fillStyle = env.LEVEL_COLOR[lv];
      ctx.strokeStyle = env.theme.halo;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (lv === 'high') { ctx.moveTo(p[0], cy - s); ctx.lineTo(p[0] + s, cy); ctx.lineTo(p[0], cy + s); ctx.lineTo(p[0] - s, cy); ctx.closePath(); }
      else if (lv === 'medium') ctx.rect(p[0] - s * 0.8, cy - s * 0.8, s * 1.6, s * 1.6);
      else ctx.arc(p[0], cy, s * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      ctx.strokeStyle = env.LEVEL_COLOR[lv];
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p[0], cy + s); ctx.lineTo(p[0], p[1]); ctx.stroke();
      drawn++;
    };
    for (const F of C.lay.files.values()) {
      if (C.open.has(F.id)) {
        for (const b of F.pieces) { if (!/\|s0$/.test(b.key)) continue; const own = sevOwn(b.id, sevOf); draw(b.x + b.w / 2, b.y + b.h / 2, topOf(b), own); }
        const lotSev = fileOwnSev(F.id, sevOf);
        if (lotSev) draw(F.sign.x + F.sign.w * 0.85, F.sign.y + F.sign.h / 2, topOf(F.sign), lotSev);
      } else {
        const s = restOf(F.shell);
        draw(s.x + s.w / 2, s.y + s.h / 2, s.z + s.d, sevOf(F.id));
      }
    }
  }
  // A symbol's own findings (not its children's), so beacons don't repeat.
  function sevOwn(id, sevOf) {
    const T = state.T;
    let s = 0;
    for (const i of T.issuesOf[id]) { const iss = state.model.issues[i]; if (!iss.waived && (!state.spot || iss.rule === state.spot)) s = Math.max(s, env.LEVEL_RANK[iss.level]); }
    return s || (T.kids[id].length ? 0 : sevOf(id));
  }
  function fileOwnSev(id, sevOf) {
    const T = state.T;
    let s = 0;
    for (const i of T.issuesOf[id]) { const iss = state.model.issues[i]; if (!iss.waived && (!state.spot || iss.rule === state.spot)) s = Math.max(s, env.LEVEL_RANK[iss.level]); }
    return s;
  }

  // Code on the roofs. Under the orthographic camera each roof plane maps to
  // the screen by an affine transform, so the Map's code renderer draws on it
  // with the canvas transform set to that plane.
  function roofs(ctx, V) {
    const T = state.T;
    const A = V.A;
    const s = V.ul;
    const mini = R.pitch > 1.2;
    const list = [];
    for (const id of C.open) {
      const c = C.lay.map.code.get(id);
      if (!c) continue;
      const vlh = V.vl * c.lh;
      if (vlh < 1.1) continue;
      const F = C.lay.files.get(id);
      const p = proj(A, F.lot.x + F.lot.w / 2, F.lot.y + F.lot.h / 2, F.lotTop);
      if (p[0] < -R.W || p[1] < -R.H || p[0] > 2 * R.W || p[1] > 2 * R.H) continue;
      list.push([vlh * Math.sqrt(F.lot.w * F.lot.h), id, c, vlh]);
    }
    list.sort((a, b) => b[0] - a[0]);
    let budget = 400, bars = 4000;
    for (const [, id, c, vlh] of list.slice(0, 6)) {
      const key = T.N[id].key;
      const text = state.texts.get(key);
      if (!text) { env.wantText(key); continue; }
      const textMode = !mini && vlh >= READ_AT;
      const owner = ownerOf(id);
      const groups = new Map();
      const n = Math.min(text.lines.length, c.cols * c.rows);
      for (let li = 0; li < n; li++) {
        const j = Math.floor(li / c.rows), r = li % c.rows;
        const x = c.x + j * (c.colW + c.gap) + env.CODE.gut * env.CODE.cw * c.lh, y = c.y + (r + 0.5) * c.lh;
        const o = owner[li + 1] ?? id;
        const z = roofOf(id, o);
        const p = proj(A, x, y, z);
        if (p[1] < -20 || p[1] > R.H + 20 || p[0] > R.W + 20 || p[0] + c.colW * s < -20) continue;
        if (textMode) { if (budget <= 0) break; if (hidden(x, y, z)) continue; budget--; }
        else { if (bars-- <= 0) break; }
        let g = groups.get(z);
        if (!g) groups.set(z, (g = new Set()));
        g.add(li);
      }
      for (const [z, only] of groups) {
        ctx.setTransform(R.dpr * A.u[0] / s, R.dpr * A.u[1] / s, R.dpr * A.v[0] / s, R.dpr * A.v[1] / s, R.dpr * (A.O[0] + z * A.w[0]), R.dpr * (A.O[1] + z * A.w[1]));
        ctx.textBaseline = 'middle';
        env.inkCode(ctx, id, c, text, s * c.lh, false, { k: s, x: 0, y: 0 }, { only, vlh, mini: !textMode, roof: true });
      }
      if (budget <= 0) break;
    }
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
  }

  // ───────────── Ink: outlines ─────────────

  // Members are outlined by the convex hull of their boxes' projected corners.
  function hull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
    for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  function outline(ctx, id, color, width) {
    const boxes = boxesFor(id);
    if (!boxes.length) return;
    const A = view().A;
    const pts = [];
    for (const b of boxes) {
      const r = restOf(b);
      for (const x of [r.x, r.x + r.w]) for (const y of [r.y, r.y + r.h]) for (const z of [r.z, r.z + r.d]) pts.push(proj(A, x, y, z));
    }
    const hp = hull(pts);
    if (hp.length < 2 || hp.every((p) => p[0] < 0 || p[1] < 0 || p[0] > R.W || p[1] > R.H)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    hp.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
  }

  function focus(ctx, now) {
    const th = env.theme;
    if (state.spot) {
      const seen = new Set();
      for (const iss of state.model.issues) {
        if (iss.rule !== state.spot || (iss.waived && !state.showWaived) || seen.has(iss.node) || seen.size > 300) continue;
        seen.add(iss.node);
        outline(ctx, iss.node, env.LEVEL_COLOR[iss.level], 1.5);
      }
    }
    for (const [id, until] of state.flash) outline(ctx, id, env.css(env.rgb(th.series[1]), clamp((until - now) / 1200, 0, 1)), 3);
    const hops = state.set.hops ?? {};
    for (const id of env.selIds().slice(0, 400)) { const hop = hops[state.T.N[id].key]; outline(ctx, id, th.accent, hop ? Math.max(1.1, 2.2 - 0.4 * hop) : 2.2); }
    if (state.hover > 0) outline(ctx, state.hover, env.css(env.rgb(th.ink), 0.75), 1.4);
    if (R.dropOn > 0) outline(ctx, R.dropOn, env.STATUS.good, 2.5);
    env.inkGrip(ctx);
  }

  // ───────────── Grip, drop, box select ─────────────

  function grip() {
    const T = state.T;
    const id = env.idOf(state.set.nodes[0]);
    const n = T.N[id];
    if (!n || !C.lay) return null;
    const A = view().A;
    const V = view();
    if (n.kind === 'file') {
      const F = C.lay.files.get(id);
      if (!F || V.ul * F.sign.w < 40) return null;
      const top = topOf(F.sign);
      const p = proj(A, F.sign.x + F.sign.w, F.sign.y + F.sign.h / 2, top);
      const size = 20;
      return { x: p[0] - size - 6, y: p[1] - size / 2, w: size, h: size, id };
    }
    if (n.kind === 'dir') {
      const b = C.lay.byNode.get(id)?.[0];
      if (!b || V.ul * b.w < 60) return null;
      const p = proj(A, b.x + b.w * 0.98, b.y + b.h * 0.02, b.z + b.d);
      return { x: p[0] - 26, y: p[1] - 10, w: 20, h: 20, id };
    }
    const f = T.fileOf[id];
    if (f < 0 || !C.open.has(f)) return null;
    const b = (C.lay.byNode.get(id) ?? [])[0];
    if (!b || V.ul * b.w < 40 || V.vl * b.h < 6) return null;
    const p = proj(A, b.x + b.w, b.y + b.h / 2, topOf(b));
    return { x: p[0] - 22, y: p[1] - 9, w: 18, h: 18, id };
  }

  function dropTarget(sx, sy, dragId) {
    const T = state.T;
    const hit = pick(sx, sy);
    if (!hit || hit.id <= 0) return -1;
    const drag = T.N[dragId];
    if (['type', 'func', 'space', 'part'].includes(drag.kind)) {
      const f = T.fileOf[hit.id];
      return f > 0 && f !== T.fileOf[dragId] ? f : -1;
    }
    let t = hit.id;
    while (t > 0 && !['dir', 'repo'].includes(T.N[t].kind)) t = T.N[t].up;
    return t > 0 && !env.isUnder(t, dragId) && t !== drag.up ? t : -1;
  }

  function boxSelect(r) {
    const T = state.T;
    const A = view().A;
    const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
    const inside = (b) => {
      const g = restOf(b);
      const top = g.z + g.d;
      return [[g.x, g.y], [g.x + g.w, g.y], [g.x, g.y + g.h], [g.x + g.w, g.y + g.h]].every(([x, y]) => { const p = proj(A, x, y, top); return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1; });
    };
    const ids = new Set();
    for (const b of C.lay.items) if ((b.part === 'dir' || b.part === 'lot') && inside(b)) ids.add(b.id);
    for (const id of C.open) for (const b of C.lay.files.get(id).pieces) if (inside(b)) ids.add(b.id);
    return [...ids].filter((id) => !(T.N[id].up > 0 && ids.has(T.N[id].up)));
  }

  function center(id) {
    const a = anchor(id);
    if (!a) return null;
    return proj(view().A, a[0], a[1], a[2]);
  }

  function readable(file) {
    if (!C.lay || !C.open.has(file)) return false;
    const c = C.lay.map.code.get(file);
    return !!c && view().vl * c.lh >= READ_AT && R.pitch <= 1.2;
  }

  // ───────────── Lifecycle ─────────────

  function use(next, prev, motion, dur) {
    C.lay = next;
    C.ownerCache.clear();
    // Open buildings stay open across rebuilds (keys survive rescans).
    C.open = new Set([...C.openKeys].map((k) => env.idOf(k)).filter((id) => id >= 0 && next.files.has(id)));
    C.flat.file = C.flat.key ? env.idOf(C.flat.key) : -1;
    C.cut = new Set();
    C.opaque.visible = C.glass.visible = true;
    sync({ dur: motion ? dur ?? (prev?.kind === 'city' ? 400 : 720) : 0, prev: prev && prev.kind !== 'city' && motion ? prev : null });
    plan();
  }

  function hide() {
    if (!C.opaque) return;
    C.opaque.visible = C.glass.visible = false;
    clearTimeout(C.cutTimer);
    C.cutTimer = 0;
    C.anim = null;
    Object.assign(C.flat, { file: -1, key: null, t: 0, from: 0, to: 0, prevPitch: null });
    uniformsEach((u) => { u.uFlat.value = 0; });
    C.lay = null;
    C.inst = [];
    C.index = new Map();
    C.sky = C.skyAll = null;
  }

  function reheight() {
    if (state.lay?.kind !== 'city') return;
    const next = lay(state.T, state.mapLay);
    state.lay = next;
    use(next, null, true, 400);
    env.relink?.();
  }

  // Called every frame while City is up. Returns true while animating.
  function frame(now) {
    let busy = false;
    const th = env.theme;
    uniformsEach((u) => { u.uBg.value.set(th.bg); });
    if (C.anim) {
      const p = clamp((now - C.anim.t0) / C.anim.dur, 0, 1);
      C.uT = ease(p);
      uniformsEach((u) => { u.uT.value = C.uT; });
      if (p >= 1) {
        C.anim = null;
        if (C.closing.length) { C.closing = []; sync({ dur: 0 }); }
        skyBuild();
        env.relink?.();
      } else busy = true;
    }
    if (updateFlat(now)) busy = true;
    if (C.planTimer && now - C.planAt > 200) { C.planTimer = 0; plan(); }
    return busy;
  }

  // The view moved: plan open buildings every 200 ms while moving, and once
  // more (with the cutaway) when it settles.
  function viewChanged(settled = false) {
    if (state.lay?.kind !== 'city') return;
    if (settled) { plan(); cutSoon(); return; }
    if (performance.now() - C.planAt > 200) plan(); else C.planTimer = 1;
  }

  function setChanged() {
    color();
    plan();
    cutSoon();
  }

  function hoverChanged() {
    flags();
    clearTimeout(C.hoverTimer);
    const T = state.T;
    const f = state.hover > 0 ? T.fileOf[state.hover] : -1;
    if (f === C.hoverOpen) return;
    C.hoverTimer = setTimeout(() => { C.hoverOpen = f; plan(); }, f > 0 ? 260 : 600);
  }

  const busy = () => state.lay?.kind === 'city' && (!!C.anim || !!C.cutTimer || C.flat.t !== C.flat.to);

  const debug = {
    get open() { return [...C.open].map((id) => state.T.N[id].key); },
    get sky() { return { cells: C.sky ? C.sky.nx * C.sky.ny : 0, boxes: C.sky?.count ?? 0, maxZ: C.sky?.maxZ ?? 0 }; },
    get instances() { return C.inst.length; },
    get towers() { return C.inst.filter((b) => b.part === 'tower' && !b.closing).length; },
    get glass() { return C.inst.filter((b, i) => b.part === 'shell' && C.glass[i * 2 + 1] > 0.5).map((b) => state.T.N[b.file].key); },
    get ghosts() { return C.inst.filter((b, i) => C.ghostOf?.[i]).length; },
    get cut() { return C.cut.size; },
    get flat() { return C.flat.file > 0 ? state.T.N[C.flat.file].key : null; },
    get pivot() { return [...R.pivot]; },
    heightOf(key) { const id = env.idOf(key); const b = C.lay?.byNode.get(id)?.find((x) => x.part === 'tower' || x.part === 'shell'); if (!b) return null; const r = restOf(b); return r.d; },
    pick,
    hidden,
  };

  return {
    lay, attach, use, hide, color, flags, frame, plan, pick, anchor, siteAnchor, endOf, route, hidden, ink, focus, grip, dropTarget, boxSelect,
    center, readable, flyTo, angle, turn, orbitStart, viewChanged, setChanged, hoverChanged, reheight, busy, debug,
  };
}
