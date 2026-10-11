// devibe client — one hardware-accelerated view (three.js + d3) with panels
// around it. Everything flows through messages: server messages and UI actions
// both go through the same hub.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const d3 = window.d3;

// ───────────────────────────── Vocabulary ─────────────────────────────

const LAYOUTS = [
  { id: 'map', name: 'Map', key: '1', about: 'Folders, files, and code, nested and sized by lines.' },
  { id: 'graph', name: 'Graph', key: '2', about: 'Parts pulled together by their links.' },
  { id: 'layers', name: 'Layers', key: '3', about: 'Parts stacked by dependency. Base code sits at the bottom.' },
  { id: 'city', name: 'City', key: '4', about: 'The map in 3D. Height shows the color measure.' },
];
const PAINTS = [
  { id: 'lang', name: 'Language' },
  { id: 'lines', name: 'Size', unit: 'lines' },
  { id: 'cx', name: 'Complexity', unit: 'branches' },
  { id: 'churn', name: 'Churn', unit: 'commits' },
  { id: 'age', name: 'Age', unit: 'days old' },
  { id: 'issues', name: 'Issues' },
  { id: 'review', name: 'Review' },
  { id: 'stage', name: 'Changes' },
];
const DETAILS = [
  { id: 'dir', name: 'Folders', rank: 2 },
  { id: 'file', name: 'Files', rank: 3 },
  { id: 'type', name: 'Types', rank: 4 },
  { id: 'func', name: 'Functions', rank: 5 },
];
const LINK_MODES = [{ id: 'none', name: 'Off' }, { id: 'focus', name: 'Focus' }, { id: 'all', name: 'All' }];
const LINK_NAMES = { import: 'imports', call: 'calls', use: 'uses', base: 'extends', copy: 'copies' };
const RANK = { root: 0, repo: 1, dir: 2, file: 3, space: 3.5, type: 4, part: 4.5, func: 5 };
const KIND_NAME = { root: 'all', repo: 'repo', dir: 'folder', file: 'file', space: 'space', type: 'type', part: 'part', func: 'func' };
const LEVELS = ['high', 'medium', 'low'];
const LEVEL_RANK = { high: 3, medium: 2, low: 1 };
const LEVEL_NAME = { high: 'High', medium: 'Medium', low: 'Low' };
const STATUS = { good: '#0ca30c', warn: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
const LEVEL_COLOR = { high: STATUS.critical, medium: STATUS.serious, low: STATUS.warn };

// Code inside files is laid out in columns. Units are line heights.
const CODE = { cw: 0.5, chars: 84, gut: 4, gap: 2 };
const COLW = CODE.cw * CODE.chars;

const THEMES = {
  dark: {
    bg: '#121211', surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', ink3: '#8f8e84', edge: '#2f2f2c', accent: '#3987e5',
    dirs: ['#191918', '#1f1f1d', '#242422', '#292927', '#2e2e2b', '#33332f', '#383834'],
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    other: '#6f6e66', neutral: '#3b3b37', quiet: '#2a2a27',
    ramp: ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'],
    tokens: ['#d2d1c8', '#a99ff0', '#3fb68b', '#e0a43a', '#77766d', '#6da7ec', '#e8b86d', '#9a998f'],
    halo: 'rgba(18,18,17,0.92)',
  },
  light: {
    bg: '#efeeea', surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', ink3: '#78776f', edge: '#dedcd5', accent: '#2a78d6',
    dirs: ['#f7f7f5', '#efeee9', '#e7e6e0', '#dfded7', '#d8d7cf', '#d1d0c7', '#cac9bf'],
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    other: '#a3a198', neutral: '#d6d4cc', quiet: '#e4e3dd',
    ramp: ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'],
    tokens: ['#262624', '#5b45c9', '#0e7a52', '#a35f00', '#8a897f', '#1c5cab', '#8a4d00', '#6b6a64'],
    halo: 'rgba(252,252,251,0.94)',
  },
};
const LINK_COLOR = { out: 0, in: 1, import: 0, call: 2, use: 6, base: 3, copy: 4 };
const TK = { txt: 0, kw: 1, str: 2, num: 3, com: 4, type: 5, fn: 6, pun: 7 };

const UI_FONT = 'Inter, "SF Pro Text", -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO_FONT = '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

const ICONS = {
  open: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z',
  setup: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.5M12 16.8v.1',
  check: 'M12 3l7 3v5.5c0 4.4-3 7.8-7 9.5-4-1.7-7-5.1-7-9.5V6zM9 11.8l2.2 2.2L15.5 9.7',
  change: 'M12 3.5l1.7 4.3L18 9.5l-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7zM18.5 15l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.8v.1',
  view: 'M12 3.5l8.5 4.5-8.5 4.5L3.5 8zM3.5 12.5l8.5 4.5 8.5-4.5M3.5 16.5l8.5 4.5 8.5-4.5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  fit: 'M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4',
  undo: 'M9 14L4.5 9.5 9 5M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3',
  up: 'M12 19V5M6 11l6-6 6 6',
  review: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.3 12.3l2.6 2.6 4.9-5',
  trash: 'M4.5 7h15M10 11v6M14 11v6M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7M9.5 7V4.5h5V7',
  move: 'M4 12h14M14 8l4 4-4 4M4 5v14',
  rename: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14 8l3 3',
  zoom: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20.5 20.5l-4.5-4.5M11 8v6M8 11h6',
  send: 'M5 12h13M13 6.5l5.5 5.5-5.5 5.5',
  stop: 'M8 8h8v8H8z',
  plus: 'M12 5v14M5 12h14',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  edit: 'M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  ask: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  waive: 'M5 12.5l4.5 4.5L19 7.5',
  chev: 'M9.5 6l6 6-6 6',
};

// ───────────────────────────── Small helpers ─────────────────────────────

const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = d3.format(',');
const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : fmt(n));
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
const store = {
  load(key, fallback) { try { const v = localStorage.getItem('devibe.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  save(key, value) { try { localStorage.setItem('devibe.' + key, JSON.stringify(value)); } catch { /* private mode */ } },
};

function ago(sec) {
  if (!sec) return 'unknown';
  const d = Date.now() / 1000 - sec;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 60) return `${Math.round(d / 86400)} days ago`;
  if (d < 86400 * 365 * 2) return `${Math.round(d / 86400 / 30)} months ago`;
  return `${Math.round(d / 86400 / 365)} years ago`;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function icon(name, cls = 'i') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  svg.append(p);
  return svg;
}

const rgbCache = new Map();
function rgb(hex) {
  let c = rgbCache.get(hex);
  if (!c) { const v = parseInt(hex.slice(1), 16); c = [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; rgbCache.set(hex, c); }
  return c;
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

// ───────────────────────────── State, hub, wire ─────────────────────────────

const state = {
  live: false,
  model: null,
  T: null,
  lay: null,
  t: d3.zoomIdentity,
  layout: store.load('layout', 'map'),
  paint: store.load('paint', 'lang'),
  links: store.load('links', 'focus'),
  detail: store.load('detail', 'file'),
  theme: store.load('theme', 'dark'),
  dock: store.load('dock', 'check'),
  sel: [],
  hover: -1,
  hoverLine: 0,
  spot: null,
  query: '',
  matches: null,
  findHits: null,
  findPick: 0,
  stage: { items: [], undo: 0, preview: false },
  agent: { busy: false, log: [] },
  config: {},
  texts: new Map(),
  wanted: new Set(),
  scan: null,
  showWaived: false,
  slots: new Map(),
  flash: new Map(),
  narrow: false,
  sheet: null,
  pending: 0,
};

const hub = (() => {
  const subs = new Map();
  return {
    on(type, fn) { if (!subs.has(type)) subs.set(type, []); subs.get(type).push(fn); },
    emit(type, data) {
      for (const fn of subs.get(type) ?? []) {
        try { fn(data); } catch (err) { console.error(`[${type}]`, err); }
      }
    },
  };
})();

const wire = {
  ws: null, seq: 0, waits: new Map(), queue: [],
  open() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      hub.emit('link.up');
      for (const raw of this.queue.splice(0)) ws.send(raw);
    };
    ws.onclose = () => { hub.emit('link.down'); setTimeout(() => this.open(), 1500); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const wait = msg.re && this.waits.get(msg.re);
      if (wait) { this.waits.delete(msg.re); state.pending--; wait(msg.type === 'note' && msg.data.level === 'error' ? { error: msg.data.text } : msg.data); }
      hub.emit(msg.type, msg.data);
    };
  },
  ask(type, data = {}) {
    const id = ++this.seq;
    const raw = JSON.stringify({ type, data, id });
    state.pending++;
    return new Promise((resolve) => {
      this.waits.set(id, resolve);
      if (this.ws?.readyState === 1) this.ws.send(raw); else this.queue.push(raw);
    });
  },
};

// ───────────────────────────── Model ─────────────────────────────

function prep(m) {
  const N = m.nodes;
  const n = N.length;
  const kids = Array.from({ length: n }, () => []);
  const depth = new Int16Array(n);
  const fileOf = new Int32Array(n).fill(-1);
  const symDepth = new Int8Array(n);
  for (const x of N) {
    if (x.up >= 0) { kids[x.up].push(x.id); depth[x.id] = depth[x.up] + 1; }
    if (x.kind === 'file') fileOf[x.id] = x.id;
    else if (x.up >= 0 && fileOf[x.up] >= 0) { fileOf[x.id] = fileOf[x.up]; symDepth[x.id] = N[x.up].kind === 'file' ? 0 : symDepth[x.up] + 1; }
  }
  const byKey = new Map(N.map((x) => [x.key, x.id]));
  const out = Array.from({ length: n }, () => []);
  const inn = Array.from({ length: n }, () => []);
  m.links.forEach((l, i) => { out[l[0]].push(i); inn[l[1]].push(i); });
  const issuesOf = Array.from({ length: n }, () => []);
  m.issues.forEach((iss, i) => issuesOf[iss.node].push(i));
  const sev = new Uint8Array(n);
  const count = new Int32Array(n);
  const cxMax = new Float32Array(n);
  for (const iss of m.issues) {
    if (iss.waived) continue;
    sev[iss.node] = Math.max(sev[iss.node], LEVEL_RANK[iss.level]);
    count[iss.node]++;
  }
  for (const x of N) if (x.kind === 'func') cxMax[x.id] = x.cx ?? 0;
  for (let i = n - 1; i > 0; i--) {
    const up = N[i].up;
    if (up < 0) continue;
    sev[up] = Math.max(sev[up], sev[i]);
    count[up] += count[i];
    cxMax[up] = Math.max(cxMax[up], cxMax[i]);
  }
  const files = N.filter((x) => x.kind === 'file');
  const q = (arr, p) => (arr.length ? d3.quantileSorted(arr, p) : 0);
  const sorted = (f) => files.map(f).filter((v) => v > 0).sort((a, b) => a - b);
  const now = Date.now() / 1000;
  const scales = {
    lines: q(sorted((f) => f.lines), 0.97) || 1,
    cx: Math.max(10, q(N.filter((x) => x.kind === 'func').map((x) => x.cx ?? 0).sort((a, b) => a - b), 0.97)),
    churn: Math.max(2, q(sorted((f) => f.churn ?? 0), 0.97)),
    age: Math.max(30, q(sorted((f) => (f.time ? (now - f.time) / 86400 : 0)), 0.97)),
  };
  for (const l of m.langs) if (!state.slots.has(l.id) && state.slots.size < 7) state.slots.set(l.id, state.slots.size);
  return { N, kids, depth, fileOf, symDepth, byKey, out, inn, issuesOf, sev, count, cxMax, scales, now };
}

const node = (id) => state.T?.N[id];
const idOf = (key) => state.T?.byKey.get(key) ?? -1;
const selIds = () => state.sel.map(idOf).filter((id) => id >= 0);
const detailRank = () => DETAILS.find((d) => d.id === state.detail)?.rank ?? 3;

function liftTo(id, rank) {
  const N = state.T.N;
  while (id > 0 && RANK[N[id].kind] > rank) id = N[id].up;
  return id;
}

function isUnder(id, anc) {
  const N = state.T.N;
  for (let p = id; p >= 0; p = N[p].up) if (p === anc) return true;
  return false;
}

function walk(id, fn, cap = 20000) {
  const T = state.T;
  const stack = [id];
  let seen = 0;
  while (stack.length && seen < cap) {
    const x = stack.pop();
    seen++;
    if (fn(x) === false) continue;
    for (const k of T.kids[x]) stack.push(k);
  }
}

function pathOf(id) {
  const N = state.T.N;
  const out = [];
  for (let p = id; p > 0; p = N[p].up) out.unshift(p);
  return out;
}

function where(id) {
  const n = node(id);
  if (!n) return '';
  const repo = n.key.split('/')[0];
  const file = n.path ?? '';
  const many = state.T.kids[0].length > 1 || !file;
  return `${many ? repo + (file ? '/' : '') : ''}${file}${n.from ? `:${n.from}` : ''}`;
}

// ───────────────────────────── Paint ─────────────────────────────

const theme = () => THEMES[document.documentElement.dataset.resolved ?? 'dark'];

function rampColor(t) {
  const r = theme().ramp;
  const x = clamp(t, 0, 1) * (r.length - 1);
  const i = Math.floor(x);
  return mix(rgb(r[i]), rgb(r[Math.min(r.length - 1, i + 1)]), x - i);
}

function langColor(lang) {
  const th = theme();
  const slot = state.slots.get(lang);
  return rgb(slot == null ? th.other : th.series[slot]);
}

function metricOf(id, paint) {
  const T = state.T;
  const n = T.N[id];
  const f = T.fileOf[id] >= 0 ? T.N[T.fileOf[id]] : null;
  if (paint === 'lines') return n.kind === 'func' || n.kind === 'type' ? Math.log1p(n.lines) / Math.log1p(Math.max(60, T.scales.lines / 4)) : Math.log1p(n.lines) / Math.log1p(T.scales.lines);
  if (paint === 'cx') return (n.kind === 'func' ? n.cx ?? 0 : T.cxMax[id]) / T.scales.cx;
  if (paint === 'churn') return (f?.churn ?? 0) / T.scales.churn;
  if (paint === 'age') { const time = f?.time; return time ? 1 - ((T.now - time) / 86400) / T.scales.age : 0; }
  return 0;
}

function reviewOf(id) {
  const marks = state.model?.marks ?? {};
  const N = state.T.N;
  for (let p = id; p > 0; p = N[p].up) {
    const m = marks[N[p].key];
    if (m) return m;
  }
  return null;
}

function stageOf(id) {
  const f = state.T.fileOf[id];
  if (f < 0) return null;
  return state.stageIndex?.get(state.T.N[f].key) ?? null;
}

// Fill color for a node, by the current paint.
function paintOf(id) {
  const th = theme();
  const T = state.T;
  const n = T.N[id];
  const p = state.paint;
  const kind = n.kind;
  if (kind === 'repo' || kind === 'dir') return rgb(th.dirs[Math.min(T.depth[id] - 1, th.dirs.length - 1)]);
  const neutral = rgb(th.neutral);
  if (p === 'lang') {
    if (kind === 'file') return n.gen ? mix(langColor(n.lang), rgb(th.bg), 0.55) : langColor(n.lang);
    return kind === 'type' ? rgb(th.series[6]) : kind === 'part' ? rgb(th.series[2]) : kind === 'space' ? rgb(th.other) : rgb(th.series[0]);
  }
  if (p === 'issues') {
    const s = T.sev[id];
    return s === 3 ? rgb(STATUS.critical) : s === 2 ? rgb(STATUS.serious) : s === 1 ? rgb(STATUS.warn) : neutral;
  }
  if (p === 'review') {
    const r = reviewOf(id);
    if (r === 'ok') return rgb(STATUS.good);
    if (r === 'stale') return rgb(STATUS.warn);
    if (kind === 'file') {
      let some = false;
      walk(id, (k) => { if (state.model.marks[T.N[k].key] === 'ok') some = true; });
      if (some) return mix(neutral, rgb(STATUS.good), 0.45);
    }
    return neutral;
  }
  if (p === 'stage') {
    const s = stageOf(id);
    if (s === 'add') return rgb(STATUS.good);
    if (s === 'edit') return rgb(th.accent);
    if (s === 'delete') return rgb(STATUS.critical);
    const f = T.fileOf[id] >= 0 ? T.N[T.fileOf[id]] : null;
    return f?.dirty ? mix(neutral, rgb(STATUS.warn), 0.55) : neutral;
  }
  if (kind === 'type' || kind === 'space' || kind === 'part') return p === 'cx' ? neutral : rampColor(metricOf(id, p));
  return rampColor(metricOf(id, p));
}

// Dimming for find results and spotlighted rules.
function makeLit() {
  const T = state.T;
  let hits = null;
  if (state.matches) hits = state.matches;
  else if (state.spot) {
    hits = new Set();
    for (const iss of state.model.issues) if (iss.rule === state.spot && (!iss.waived || state.showWaived)) hits.add(iss.node);
  }
  if (!hits) return null;
  const above = new Set();
  for (const id of hits) for (let p = T.N[id].up; p >= 0; p = T.N[p].up) { if (above.has(p)) break; above.add(p); }
  return (id) => {
    if (hits.has(id) || above.has(id)) return true;
    for (let p = T.N[id].up; p > 0; p = T.N[p].up) if (hits.has(p)) return true;
    return false;
  };
}

// ───────────────────────────── Layouts ─────────────────────────────
// Each layout returns { items, rect, bounds, ... }. Items are drawn tiles:
// { key, id, part, x, y, w, h, r (corner px), z, h3 (city height) }.

const fileArea = (lines) => (Math.max(lines, 3) + 5) * (COLW + CODE.gap);

function fitCode(x, y, w, h, lines) {
  lines = Math.max(lines, 1);
  let best = null;
  for (let c = 1; c <= 24; c++) {
    const rows = Math.ceil(lines / c);
    const lh = Math.min(h / rows, w / (c * COLW + (c - 1) * CODE.gap));
    if (!best || lh > best.lh * 1.0001) best = { cols: c, rows, lh };
    if (rows === 1) break;
  }
  return { x, y, cols: best.cols, rows: best.rows, lh: best.lh, colW: COLW * best.lh, gap: CODE.gap * best.lh };
}

function codePieces(c, from, to, indent) {
  const out = [];
  const gut = CODE.gut * CODE.cw * c.lh;
  for (let j = 0; j < c.cols; j++) {
    const r0 = j * c.rows;
    const a = Math.max(from - 1, r0), b = Math.min(to, r0 + c.rows);
    if (a >= b) continue;
    const x = c.x + j * (c.colW + c.gap) + gut + indent * c.lh;
    out.push({ x, y: c.y + (a - r0) * c.lh, w: Math.max(c.lh, c.colW - gut - indent * c.lh - 0.4 * c.lh), h: (b - a) * c.lh });
  }
  return out;
}

function layMap(T) {
  const N = T.N;
  const tree = d3.hierarchy(N[0], (x) => {
    let out = null;
    for (const c of T.kids[x.id]) { const k = N[c].kind; if (k === 'repo' || k === 'dir' || k === 'file') (out ??= []).push(N[c]); }
    return out;
  });
  tree.sum((x) => (x.kind === 'file' ? fileArea(x.lines) : 0)).sort((a, b) => b.value - a.value || a.data.name.localeCompare(b.data.name));
  const v = R.W ? viewport() : { w: 1.55, h: 1 };
  const aspect = clamp(v.w / v.h, 0.55, 2.2);
  const W = Math.sqrt(Math.max(tree.value, 1000) * aspect) * 1.12, H = W / aspect;
  // File areas follow line counts, so code lines come out about the same height
  // in every file. Headers use one size tied to that height: a file's name
  // becomes readable just as its code turns into a minimap, and a folder's
  // header is never smaller than the headers of the files inside it.
  const F = 4.6 * Math.sqrt((W * H) / Math.max(tree.value, 1000));
  const headOf = (d) => clamp(0.04 * Math.sqrt((d.x1 - d.x0) * (d.y1 - d.y0)), F, F * 18);
  d3.treemap().size([W, H]).tile(d3.treemapSquarify.ratio(1.2)).round(false)
    .paddingInner((d) => (d.depth ? headOf(d) * 0.22 : W * 0.006))
    .paddingOuter((d) => (d.depth ? headOf(d) * 0.24 : 0))
    .paddingTop((d) => (d.depth ? headOf(d) : 0))(tree);
  const items = [], rect = new Map(), code = new Map(), pieces = new Map();
  tree.each((d) => {
    const x = d.data;
    if (x.kind === 'root') return;
    const r = { x: d.x0, y: d.y0, w: Math.max(0, d.x1 - d.x0), h: Math.max(0, d.y1 - d.y0) };
    if (x.kind !== 'file') {
      r.head = headOf(d);
      rect.set(x.id, r);
      items.push({ key: x.id + 'd', id: x.id, part: 'dir', ...r, r: 3 });
      return;
    }
    const fh = Math.min(F, r.h * 0.3);
    r.head = fh;
    rect.set(x.id, r);
    items.push({ key: x.id + 'b', id: x.id, part: 'body', ...r, r: 2 });
    items.push({ key: x.id + 'h', id: x.id, part: 'head', x: r.x, y: r.y, w: r.w, h: fh, r: 2 });
    const pad = Math.min(fh * 0.3, r.w * 0.05);
    const c = fitCode(r.x + pad, r.y + fh + pad, Math.max(0.1, r.w - 2 * pad), Math.max(0.1, r.h - fh - 2 * pad), x.lines);
    code.set(x.id, c);
    const list = [];
    walk(x.id, (k) => {
      if (k === x.id) return;
      const s = N[k];
      if (!s.from) return;
      codePieces(c, s.from, s.to, T.symDepth[k] * 0.9).forEach((p, j) => {
        const it = { key: `${k}s${j}`, id: k, part: 'sym', ...p, r: 1.5 };
        items.push(it);
        list.push(it);
      });
    });
    pieces.set(x.id, list);
  });
  return { kind: 'map', items, rect, code, pieces, aspect, bounds: { x: 0, y: 0, w: W, h: H } };
}

// Links lifted to a rank (folders, files, types, functions) and merged.
function liftGraph(T, rank) {
  const m = state.model;
  const N = T.N;
  const ids = new Set();
  for (const x of N) if (RANK[x.kind] === rank || (rank === 2 && x.kind === 'repo' && T.kids[x.id].some((k) => N[k].kind === 'file'))) ids.add(x.id);
  const merged = new Map();
  for (const [s, t, k, w] of m.links) {
    if (m.linkKinds[k] === 'copy') continue;
    const a = liftTo(s, rank), b = liftTo(t, rank);
    if (a === b || a <= 0 || b <= 0 || isUnder(a, b) || isUnder(b, a)) continue;
    ids.add(a); ids.add(b);
    const key = a * 1e7 + b;
    const e = merged.get(key);
    if (e) e.w += w; else merged.set(key, { a, b, w });
  }
  let list = [...ids];
  if (list.length > 4000) {
    const linked = new Set();
    for (const e of merged.values()) { linked.add(e.a); linked.add(e.b); }
    list = list.filter((id) => linked.has(id)).sort((a, b) => N[b].lines - N[a].lines).slice(0, 4000);
  }
  const keep = new Set(list);
  return { ids: list, links: [...merged.values()].filter((e) => keep.has(e.a) && keep.has(e.b)) };
}

function homeOf(T, id, mapLay) {
  for (let p = id; p > 0; p = T.N[p].up) {
    const r = mapLay.rect.get(p);
    if (r) {
      if (p === id || T.N[id].kind === 'file') return [r.x + r.w / 2, r.y + r.h / 2];
      const pc = mapLay.pieces.get(T.fileOf[id])?.find((it) => it.id === id);
      return pc ? [pc.x + pc.w / 2, pc.y + pc.h / 2] : [r.x + r.w / 2, r.y + r.h / 2];
    }
  }
  return [0, 0];
}

function layGraph(T, mapLay) {
  const N = T.N;
  const { ids, links } = liftGraph(T, detailRank());
  const radius = (id) => 2.2 + Math.sqrt(Math.max(1, N[id].lines)) * 0.85;
  let area = 0;
  const nodes = ids.map((id) => { const r = radius(id); area += r * r * Math.PI; return { id, r }; });
  const G = Math.sqrt(area * 7) + 60;
  const mb = mapLay.bounds;
  const s = G / Math.max(mb.w, mb.h);
  for (const nd of nodes) {
    const [hx, hy] = homeOf(T, nd.id, mapLay);
    nd.hx = hx * s; nd.hy = hy * s;
    const jitter = (seed) => ((Math.sin(seed * 12.9898) * 43758.5453) % 1);
    nd.x = nd.hx + jitter(nd.id) * 2; nd.y = nd.hy + jitter(nd.id + 7.7) * 2;
  }
  const deg = new Map();
  for (const e of links) { deg.set(e.a, (deg.get(e.a) ?? 0) + 1); deg.set(e.b, (deg.get(e.b) ?? 0) + 1); }
  const simLinks = links.map((e) => ({ source: e.a, target: e.b, w: e.w }));
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(simLinks).id((d) => d.id).distance((l) => l.source.r + l.target.r + 14).strength((l) => 0.6 / Math.min(deg.get(l.source.id), deg.get(l.target.id))))
    .force('charge', d3.forceManyBody().strength((d) => -12 - d.r * 2.4).distanceMax(G * 0.4).theta(0.95))
    .force('collide', d3.forceCollide((d) => d.r + 2.2).strength(0.9))
    .force('x', d3.forceX((d) => d.hx).strength(0.045))
    .force('y', d3.forceY((d) => d.hy).strength(0.045))
    .alphaDecay(0.028)
    .stop();
  const t0 = performance.now();
  for (let i = 0; i < 360 && performance.now() - t0 < 1100; i++) sim.tick();
  const items = [], rect = new Map();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const nd of nodes) {
    const r = { x: nd.x - nd.r, y: nd.y - nd.r, w: nd.r * 2, h: nd.r * 2 };
    rect.set(nd.id, r);
    items.push({ key: nd.id + 'n', id: nd.id, part: 'node', ...r, r: 999 });
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  items.sort((a, b) => b.w - a.w);
  const quad = d3.quadtree(nodes, (d) => d.x, (d) => d.y);
  if (!nodes.length) { x0 = y0 = 0; x1 = y1 = 100; }
  return { kind: 'graph', items, rect, quad, nodes, links, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

function layLayers(T) {
  const N = T.N;
  const { ids, links } = liftGraph(T, detailRank());
  const out = new Map(ids.map((id) => [id, []]));
  for (const e of links) out.get(e.a)?.push(e.b);
  // Strongly connected groups share a level; levels count up from the base.
  let index = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], comp = new Map();
  let compN = 0;
  for (const v of ids) {
    if (idx.has(v)) continue;
    const work = [[v, 0]];
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    while (work.length) {
      const top = work.at(-1);
      const [x] = top;
      const next = out.get(x) ?? [];
      if (top[1] < next.length) {
        const w = next[top[1]++];
        if (!idx.has(w)) { idx.set(w, index); low.set(w, index); index++; stack.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(x, Math.min(low.get(x), idx.get(w)));
      } else {
        work.pop();
        if (work.length) { const p = work.at(-1)[0]; low.set(p, Math.min(low.get(p), low.get(x))); }
        if (low.get(x) === idx.get(x)) {
          let w;
          do { w = stack.pop(); on.delete(w); comp.set(w, compN); } while (w !== x);
          compN++;
        }
      }
    }
  }
  const compOut = Array.from({ length: compN }, () => new Set());
  const compSize = new Int32Array(compN);
  for (const id of ids) compSize[comp.get(id)]++;
  for (const e of links) { const a = comp.get(e.a), b = comp.get(e.b); if (a !== b) compOut[a].add(b); }
  const level = new Int32Array(compN).fill(-1);
  const levelOf = (c) => {
    const work = [c];
    while (work.length) {
      const x = work.at(-1);
      if (level[x] >= 0) { work.pop(); continue; }
      let ready = true, best = 0;
      for (const y of compOut[x]) { if (level[y] < 0) { ready = false; work.push(y); } else best = Math.max(best, level[y] + 1); }
      if (ready) { level[x] = best; work.pop(); }
    }
    return level[c];
  };
  let maxL = 0;
  for (let c = 0; c < compN; c++) maxL = Math.max(maxL, levelOf(c));
  const rows = Array.from({ length: maxL + 1 }, () => []);
  const top = (id) => { const p = pathOf(id); return p[Math.min(1, p.length - 1)] ?? 0; };
  for (const id of ids) rows[level[comp.get(id)]].push(id);
  for (const row of rows) row.sort((a, b) => top(a) - top(b) || comp.get(a) - comp.get(b) || N[a].name.localeCompare(N[b].name));
  const width = (id) => clamp(9 + N[id].name.length * 3.1, 22, 120);
  const BOX_H = 9, GAP = 4, ROW = 34;
  const nbrs = new Map(ids.map((id) => [id, []]));
  for (const e of links) { nbrs.get(e.a).push(e.b); nbrs.get(e.b).push(e.a); }
  const xs = new Map();
  const place = () => {
    for (const row of rows) { let x = 0; for (const id of row) { xs.set(id, x + width(id) / 2); x += width(id) + GAP; } const shift = x / 2; for (const id of row) xs.set(id, xs.get(id) - shift); }
  };
  place();
  for (let pass = 0; pass < 4; pass++) {
    const order = pass % 2 ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
    for (const L of order) {
      const key = new Map(rows[L].map((id) => { const ns = nbrs.get(id).filter((x) => xs.has(x)); return [id, ns.length ? d3.mean(ns, (x) => xs.get(x)) : xs.get(id)]; }));
      rows[L].sort((a, b) => key.get(a) - key.get(b));
      place();
    }
  }
  const total = d3.sum(ids, (id) => width(id) + GAP);
  const maxW = Math.max(420, Math.sqrt(total * ROW * 1.6) * 1.3);
  const items = [], rect = new Map(), bands = [];
  let y = 0;
  for (let L = maxL; L >= 0; L--) {
    const row = rows[L];
    const lines = [[]];
    let w = 0;
    for (const id of row) {
      if (w + width(id) > maxW && lines.at(-1).length) { lines.push([]); w = 0; }
      lines.at(-1).push(id);
      w += width(id) + GAP;
    }
    const y0 = y;
    for (const line of lines) {
      const lw = d3.sum(line, (id) => width(id) + GAP) - GAP;
      let x = -lw / 2;
      for (const id of line) {
        const r = { x, y, w: width(id), h: BOX_H };
        rect.set(id, r);
        items.push({ key: id + 'n', id, part: 'node', ...r, r: 4, loop: compSize[comp.get(id)] > 1 });
        x += width(id) + GAP;
      }
      y += BOX_H + 10;
    }
    bands.push({ level: L, y0: y0 - 6, y1: y - 4, count: row.length });
    y += ROW - BOX_H - 10;
  }
  let x0 = Infinity, x1 = -Infinity;
  for (const r of rect.values()) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.w); }
  if (!rect.size) { x0 = 0; x1 = 100; }
  const quad = d3.quadtree([...rect.entries()], ([, r]) => r.x + r.w / 2, ([, r]) => r.y + r.h / 2);
  return { kind: 'layers', items, rect, quad, links, bands, bounds: { x: x0 - 40, y: -10, w: x1 - x0 + 80, h: y + 10 } };
}

function layCity(T, mapLay) {
  const N = T.N;
  const W = mapLay.bounds.w;
  const items = [];
  const plinth = W * 0.0018;
  const tall = W * 0.09;
  const paint = PAINTS.find((p) => p.id === state.paint);
  const numeric = paint.unit != null;
  const heightOf = (id) => {
    const v = numeric ? metricOf(id, state.paint) : Math.log1p(N[id].lines) / Math.log1p(T.scales.lines);
    return Math.max(plinth * 1.5, tall * clamp(v, 0, 1.15) ** 1.25);
  };
  for (const it of mapLay.items) {
    if (it.part === 'dir') {
      const d = T.depth[it.id];
      items.push({ key: it.id + 'c', id: it.id, part: 'dir', x: it.x, y: it.y, w: it.w, h: it.h, z: (d - 1) * plinth, h3: plinth });
    } else if (it.part === 'body') {
      const d = T.depth[it.id];
      const inset = Math.min(it.w, it.h) * 0.06;
      items.push({ key: it.id + 'c', id: it.id, part: 'block', x: it.x + inset, y: it.y + inset, w: it.w - 2 * inset, h: it.h - 2 * inset, z: (d - 1) * plinth, h3: heightOf(it.id) });
    }
  }
  return { kind: 'city', items, rect: mapLay.rect, map: mapLay, bounds: mapLay.bounds, tall };
}

// ───────────────────────────── Renderer ─────────────────────────────

const R = {};

const TILE_VERT = `
attribute vec4 iRect;
attribute vec4 iColor;
attribute vec4 iStyle;
uniform float uScale;
varying vec2 vP;
varying vec2 vHalf;
varying vec4 vColor;
varying vec4 vStyle;
void main() {
  vec2 local = position.xy;
  vec2 wpos = iRect.xy + local * iRect.zw;
  vHalf = iRect.zw * 0.5 * uScale;
  vP = (local - 0.5) * iRect.zw * uScale;
  vColor = iColor;
  vStyle = iStyle;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wpos, 0.0, 1.0);
}`;

const TILE_FRAG = `
precision highp float;
uniform float uScale;
uniform vec3 uBg;
varying vec2 vP;
varying vec2 vHalf;
varying vec4 vColor;
varying vec4 vStyle;
float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  float r = min(vStyle.x, min(vHalf.x, vHalf.y));
  float d = box(vP, vHalf, r);
  float a = clamp(0.5 - d, 0.0, 1.0);
  if (a <= 0.0) discard;
  vec3 c = vColor.rgb;
  float mode = vStyle.y;
  if (mode > 0.5 && mode < 1.5) {
    float px = vStyle.z * uScale;
    c = mix(c, uBg, smoothstep(2.0, 9.0, px) * 0.84);
  }
  if (mode > 1.5 && mode < 2.5) {
    float px = vStyle.z * uScale;
    c = mix(uBg, c, mix(0.55, 0.22, smoothstep(2.0, 9.0, px)));
  }
  float edge = clamp(-d / 1.2, 0.0, 1.0);
  c *= mix(0.78, 1.0, edge);
  gl_FragColor = vec4(c, vColor.a * a);
}`;

function setupGL() {
  const canvas = $('#gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -1e7, 1e7);
  const view = new THREE.Group();
  const tilt = new THREE.Group();
  const base = new THREE.Group();
  scene.add(view); view.add(tilt); tilt.add(base);
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const tileMat = new THREE.ShaderMaterial({
    vertexShader: TILE_VERT, fragmentShader: TILE_FRAG,
    uniforms: { uScale: { value: 1 }, uBg: { value: new THREE.Color() } },
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const tiles = new THREE.Mesh(quad, tileMat);
  tiles.frustumCulled = false;
  base.add(tiles);
  const blockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), blockMat, 1);
  blocks.frustumCulled = false;
  blocks.visible = false;
  base.add(blocks);
  const lineMat = new LineMaterial({ linewidth: 1.6, vertexColors: true, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, worldUnits: false });
  const lines = new LineSegments2(new LineSegmentsGeometry(), lineMat);
  lines.frustumCulled = false;
  lines.renderOrder = 5;
  base.add(lines);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.25));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-0.45, 0.6, 1);
  scene.add(sun);
  Object.assign(R, { renderer, scene, camera, view, tilt, base, quad, tiles, tileMat, blocks, blockMat, lines, lineMat, cap: 0, blockCap: 1, pitch: 0, yaw: 0, grow: 1, raycaster: new THREE.Raycaster() });
}

function sizeGL() {
  const el = $('#view');
  const W = el.clientWidth, H = el.clientHeight;
  R.W = W; R.H = H;
  R.renderer.setSize(W, H, false);
  Object.assign(R.camera, { left: 0, right: W, top: 0, bottom: -H });
  R.camera.updateProjectionMatrix();
  R.lineMat.resolution.set(W, H);
  const ink = $('#ink');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ink.width = Math.round(W * dpr);
  ink.height = Math.round(H * dpr);
  R.ink = ink.getContext('2d');
  R.dpr = dpr;
}

function ensureTiles(n) {
  if (n <= R.cap) return;
  const cap = Math.max(1024, Math.ceil(n * 1.25));
  const q = R.quad;
  for (const name of ['iRect', 'iColor', 'iStyle']) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    q.setAttribute(name, a);
  }
  R.cap = cap;
}

function ensureBlocks(n) {
  if (n <= R.blockCap) return;
  const cap = Math.max(256, Math.ceil(n * 1.25));
  R.base.remove(R.blocks);
  R.blocks.dispose();
  R.blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), R.blockMat, cap);
  R.blocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  R.blocks.frustumCulled = false;
  R.blocks.count = 0;
  R.base.add(R.blocks);
  R.blockCap = cap;
}

const MODE = { dir: 0, head: 0, body: 1, sym: 2, node: 0, block: 0 };

// Write item colors to the GPU (also used after paint, selection, or find changes).
function colorItems() {
  const lay = state.lay;
  if (!lay) return;
  const th = theme();
  const lit = makeLit();
  const bg = rgb(th.bg);
  if (lay.kind === 'city') {
    const blocks = R.blocks;
    const c = new THREE.Color();
    lay.items.forEach((it, i) => {
      let col = paintOf(it.id);
      if (it.part === 'dir') col = mix(col, rgb(th.ink3), 0.12);
      if (lit && !lit(it.id)) col = mix(col, bg, 0.78);
      c.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace);
      blocks.setColorAt(i, c);
    });
    if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
    return;
  }
  const col = R.quad.getAttribute('iColor').array;
  const sty = R.quad.getAttribute('iStyle').array;
  lay.items.forEach((it, i) => {
    let c = paintOf(it.id);
    let a = 1;
    if (it.part === 'head') c = mix(c, [1, 1, 1], 0.08);
    else if (it.part === 'sym') a = 1;
    if (it.part === 'node' && it.loop) c = mix(c, rgb(STATUS.critical), 0.25);
    if (lit && !lit(it.id)) c = mix(c, bg, it.part === 'dir' ? 0.45 : 0.8);
    col.set([c[0], c[1], c[2], a], i * 4);
    const lh = it.part === 'body' || it.part === 'sym' ? lay.code?.get(state.T.fileOf[it.id])?.lh ?? 0 : 0;
    sty.set([it.r ?? 2, MODE[it.part] ?? 0, lh, 0], i * 4);
  });
  R.quad.getAttribute('iColor').needsUpdate = true;
  R.quad.getAttribute('iStyle').needsUpdate = true;
}

// Rects for the current frame (morphing between layouts when animating).
function placeItems(t) {
  const lay = state.lay;
  if (!lay) return;
  const morph = R.morph;
  const e = morph ? d3.easeCubicInOut(t) : 1;
  if (lay.kind === 'city') {
    const m = new THREE.Matrix4();
    const grow = morph ? e : 1;
    lay.items.forEach((it, i) => {
      let x = it.x, y = it.y, w = it.w, hh = it.h;
      const f = morph?.from[i];
      if (f) { x = f[0] + (x - f[0]) * e; y = f[1] + (y - f[1]) * e; w = f[2] + (w - f[2]) * e; hh = f[3] + (hh - f[3]) * e; }
      const zh = Math.max(0.0001, it.h3 * grow);
      m.makeScale(Math.max(w, 1e-4), Math.max(hh, 1e-4), zh);
      m.setPosition(x + w / 2, -(y + hh / 2), it.z * grow + zh / 2);
      R.blocks.setMatrixAt(i, m);
    });
    R.blocks.count = lay.items.length;
    R.blocks.instanceMatrix.needsUpdate = true;
    return;
  }
  const arr = R.quad.getAttribute('iRect').array;
  lay.items.forEach((it, i) => {
    let x = it.x, y = it.y, w = it.w, hh = it.h;
    const f = morph?.from[i];
    if (f) { x = f[0] + (x - f[0]) * e; y = f[1] + (y - f[1]) * e; w = f[2] + (w - f[2]) * e; hh = f[3] + (hh - f[3]) * e; }
    arr[i * 4] = x; arr[i * 4 + 1] = -(y + hh); arr[i * 4 + 2] = w; arr[i * 4 + 3] = hh;
  });
  R.quad.getAttribute('iRect').needsUpdate = true;
  R.quad.instanceCount = lay.items.length;
}

function useLayout(next, { animate = true, fit = false } = {}) {
  const prev = state.lay;
  if (next.kind === 'city') ensureBlocks(next.items.length); else ensureTiles(next.items.length);
  let from = null;
  if (animate && prev && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const old = new Map(prev.items.map((it) => [it.key, it]));
    const oldNode = new Map();
    for (const it of prev.items) if (!oldNode.has(it.id) || it.part === 'body' || it.part === 'dir' || it.part === 'node' || it.part === 'block') oldNode.set(it.id, it);
    const N = state.T.N;
    from = next.items.map((it) => {
      const o = old.get(it.key) ?? old.get(it.id + (next.kind === 'map' ? 'b' : 'n'));
      if (o) return [o.x, o.y, o.w, o.h];
      let p = oldNode.get(it.id);
      for (let a = N[it.id]?.up ?? -1; !p && a > 0; a = N[a].up) p = oldNode.get(a);
      if (p) return [p.x + p.w / 2, p.y + p.h / 2, 0, 0];
      return [it.x + it.w / 2, it.y + it.h / 2, 0, 0];
    });
    if (prev.kind === 'city' && next.kind !== 'city') from = null;
  }
  state.lay = next;
  R.tiles.visible = next.kind !== 'city';
  R.blocks.visible = next.kind === 'city';
  const toPitch = next.kind === 'city' ? 0.95 : 0, toYaw = next.kind === 'city' ? -0.5 : 0;
  const fromPitch = R.pitch, fromYaw = R.yaw;
  R.morph = from || fromPitch !== toPitch ? { from: from ?? [], t0: performance.now(), dur: 720, fromPitch, toPitch, fromYaw, toYaw } : null;
  if (!R.morph) { R.pitch = toPitch; R.yaw = toYaw; }
  const b = next.bounds;
  R.tilt.position.set(b.x + b.w / 2, -(b.y + b.h / 2), 0);
  R.base.position.set(-(b.x + b.w / 2), b.y + b.h / 2, 0);
  colorItems();
  placeItems(R.morph ? 0 : 1);
  setZoomRange();
  if (fit) fitAll(animate ? 720 : 0);
  buildLinks();
  requestDraw();
}

function relayout(opts = {}) {
  const T = state.T;
  if (!T) return;
  const map = state.mapLay ?? (state.mapLay = layMap(T));
  let next;
  if (state.layout === 'graph') next = layGraph(T, map);
  else if (state.layout === 'layers') next = layLayers(T);
  else if (state.layout === 'city') next = layCity(T, map);
  else next = map;
  useLayout(next, opts);
}

// ───────────────────────────── Links ─────────────────────────────

function focusIds() {
  const ids = selIds();
  if (state.hover > 0 && !ids.includes(state.hover)) ids.push(state.hover);
  return ids;
}

function anchorOf(id) {
  const lay = state.lay;
  if (!lay) return null;
  if (lay.kind === 'map' || lay.kind === 'city') {
    const T = state.T;
    const f = T.fileOf[id];
    if (f >= 0 && f !== id) {
      const pc = lay.kind === 'map' ? lay.pieces.get(f)?.find((it) => it.id === id) : null;
      if (pc) return [pc.x + Math.min(pc.w, 6 * (lay.code.get(f)?.lh ?? 1)) / 2, pc.y + Math.min(pc.h, lay.code.get(f)?.lh ?? 1) / 2];
      const r = (lay.map ?? lay).rect.get(f);
      return r ? [r.x + r.w / 2, r.y + r.h / 2] : null;
    }
    const r = (lay.map ?? lay).rect.get(id);
    if (!r) return null;
    const kind = state.T.N[id].kind;
    return kind === 'dir' || kind === 'repo' ? [r.x + Math.min(r.w / 2, r.head * 4), r.y + r.head / 2] : [r.x + r.w / 2, r.y + r.h / 2];
  }
  const r = lay.rect.get(id);
  return r ? [r.x + r.w / 2, r.y + r.h / 2] : null;
}

function linkSet() {
  const T = state.T;
  const m = state.model;
  if (!T || state.links === 'none') return [];
  const lay = state.lay;
  const rank = detailRank();
  const flat = lay.kind === 'graph' || lay.kind === 'layers';
  const visible = (id) => (flat ? lay.rect.has(id) : true);
  const merged = new Map();
  const put = (a, b, kind, w, dir) => {
    if (a === b || a <= 0 || b <= 0 || !visible(a) || !visible(b)) return;
    const key = `${a},${b},${dir ?? kind}`;
    const e = merged.get(key);
    if (e) e.w += w; else merged.set(key, { a, b, kind, w, dir });
  };
  if (state.links === 'focus' && flat) {
    if (lay.dim?.rank !== rank) {
      const dim = new Map();
      for (const e of lay.links ?? []) dim.set(`${e.a},${e.b},dim`, { a: e.a, b: e.b, kind: 'dim', w: e.w, dir: 'dim' });
      lay.dim = { rank, list: dim };
    }
    for (const [key, e] of lay.dim.list) merged.set(key, { ...e });
  }
  if (state.links === 'focus') {
    for (const f of focusIds()) {
      const self = flat ? liftTo(f, rank) : f;
      walk(f, (id) => {
        for (const li of T.out[id]) {
          const [, t, k, w] = m.links[li];
          if (isUnder(t, f)) continue;
          put(self, flat ? liftTo(t, rank) : liftTo(t, Math.max(rank, Math.min(RANK[T.N[t].kind], 3))), m.linkKinds[k], w, 'out');
        }
        for (const li of T.inn[id]) {
          const [s, , k, w] = m.links[li];
          if (isUnder(s, f)) continue;
          put(flat ? liftTo(s, rank) : liftTo(s, Math.max(rank, Math.min(RANK[T.N[s].kind], 3))), self, m.linkKinds[k], w, 'in');
        }
      }, 6000);
    }
  } else {
    for (const [s, t, k, w] of m.links) {
      const kind = m.linkKinds[k];
      if (kind === 'copy') continue;
      const a = liftTo(s, rank), b = liftTo(t, rank);
      if (isUnder(a, b) || isUnder(b, a)) continue;
      put(a, b, kind, w);
    }
  }
  const list = [...merged.values()];
  const dim = list.filter((e) => e.dir === 'dim'), bright = list.filter((e) => e.dir !== 'dim');
  const lit = new Set(bright.map((e) => `${e.a},${e.b}`));
  return [...dim.filter((e) => !lit.has(`${e.a},${e.b}`) && !lit.has(`${e.b},${e.a}`)).sort((p, q) => q.w - p.w).slice(0, 6000), ...bright.sort((p, q) => q.w - p.w).slice(0, 4000)];
}

// Sample a d3 curve into points by drawing it into a recording context.
function sampleCurve(points, curve, steps = 6) {
  const out = [];
  let cx = 0, cy = 0;
  const ctx = {
    moveTo(x, y) { out.push([x, y]); cx = x; cy = y; },
    lineTo(x, y) { out.push([x, y]); cx = x; cy = y; },
    bezierCurveTo(x1, y1, x2, y2, x, y) {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        out.push([u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y]);
      }
      cx = x; cy = y;
    },
    closePath() {},
  };
  d3.line().curve(curve).context(ctx)(points);
  return out;
}

function routeOf(e) {
  const lay = state.lay;
  const a = anchorOf(e.a), b = anchorOf(e.b);
  if (!a || !b) return null;
  if (lay.kind === 'map') {
    const pa = pathOf(e.a), pb = pathOf(e.b);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    const via = [...pa.slice(Math.max(i - 1, 0), -1).reverse(), ...pb.slice(Math.max(i - 1, 0), -1)].map(anchorOf).filter(Boolean);
    const pts = [a, ...via.slice(0, 8), b];
    return pts.length > 2 ? sampleCurve(pts, d3.curveBundle.beta(0.82), 5).map((p) => [p[0], p[1], 0]) : [[...a, 0], [...b, 0]];
  }
  if (lay.kind === 'layers') {
    const ra = lay.rect.get(e.a), rb = lay.rect.get(e.b);
    if (Math.abs(ra.y - rb.y) < 1) {
      const lift = 14 + Math.abs(a[0] - b[0]) * 0.08;
      return sampleCurve([[a[0], ra.y], [(a[0] + b[0]) / 2, ra.y - lift], [b[0], rb.y]], d3.curveNatural, 6).map((p) => [p[0], p[1], 0]);
    }
    const down = ra.y < rb.y;
    const y0 = down ? ra.y + ra.h : ra.y, y1 = down ? rb.y : rb.y + rb.h;
    const out = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, u = 1 - t;
      const my = (y0 + y1) / 2;
      out.push([u * u * u * a[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t * t * t * b[0], u * u * u * y0 + 3 * u * u * t * my + 3 * u * t * t * my + t * t * t * y1, 0]);
    }
    return out;
  }
  if (lay.kind === 'city') {
    const top = (id) => { const it = lay.items.find((x) => x.id === liftTo(id, 3)); return it ? (it.z + it.h3) : 0; };
    const za = top(e.a), zb = top(e.b);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const out = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, za + (zb - za) * t + Math.sin(Math.PI * t) * (len * 0.22 + lay.tall * 0.2)]);
    }
    return out;
  }
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const mx = (a[0] + b[0]) / 2 - dy * 0.12, my = (a[1] + b[1]) / 2 + dx * 0.12;
  const out = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * mx + t * t * b[0], u * u * a[1] + 2 * u * t * my + t * t * b[1], 0]);
  }
  return out;
}

function buildLinks() {
  const th = theme();
  const list = state.lay ? linkSet() : [];
  state.linkList = list;
  const pos = [], col = [];
  const bg = rgb(th.bg);
  const maxW = d3.max(list, (e) => e.w) ?? 1;
  for (const e of list) {
    const pts = routeOf(e);
    if (!pts) continue;
    const base = e.dir === 'dim' ? rgb(th.ink3) : rgb(th.series[LINK_COLOR[e.dir ?? e.kind] ?? 0]);
    const strength = e.dir === 'dim' ? 0.3 + 0.25 * Math.sqrt(e.w / maxW) : 0.45 + 0.55 * Math.sqrt(e.w / maxW);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      pos.push(p[0], -p[1], p[2], q[0], -q[1], q[2]);
      const c0 = mix(bg, base, (0.25 + 0.75 * ((i - 1) / (pts.length - 1))) * strength);
      const c1 = mix(bg, base, (0.25 + 0.75 * (i / (pts.length - 1))) * strength);
      col.push(...c0, ...c1);
    }
  }
  R.base.remove(R.lines);
  R.lines.geometry.dispose();
  const geo = new LineSegmentsGeometry();
  if (pos.length) { geo.setPositions(pos); geo.setColors(col); }
  R.lines = new LineSegments2(geo, R.lineMat);
  R.lines.frustumCulled = false;
  R.lines.renderOrder = 5;
  R.lines.visible = pos.length > 0;
  R.lineMat.linewidth = state.links === 'all' ? 1.1 : 1.8;
  R.lineMat.depthTest = state.lay?.kind === 'city';
  R.base.add(R.lines);
}

// ───────────────────────────── Frame ─────────────────────────────

let frameAsked = false;
function requestDraw() {
  if (frameAsked) return;
  frameAsked = true;
  requestAnimationFrame(drawFrame);
}

function drawFrame(now) {
  frameAsked = false;
  if (!R.renderer) return;
  const th = theme();
  const t = state.t;
  let busy = false;
  if (R.morph) {
    const p = clamp((now - R.morph.t0) / R.morph.dur, 0, 1);
    const e = d3.easeCubicInOut(p);
    R.pitch = R.morph.fromPitch + (R.morph.toPitch - R.morph.fromPitch) * e;
    R.yaw = R.morph.fromYaw + (R.morph.toYaw - R.morph.fromYaw) * e;
    placeItems(p);
    if (p >= 1) { R.morph = null; buildLinks(); } else busy = true;
  }
  R.renderer.setClearColor(th.bg, 1);
  R.tileMat.uniforms.uBg.value.set(th.bg);
  R.tileMat.uniforms.uScale.value = t.k;
  R.view.position.set(t.x, -t.y, 0);
  R.view.scale.set(t.k, t.k, t.k);
  R.tilt.rotation.set(-R.pitch, 0, R.yaw);
  R.lines.visible = !R.morph && (R.lines.geometry.attributes.instanceStart?.count ?? 0) > 0;
  R.lineMat.opacity = readingCode() ? 0.3 : 0.85;
  R.renderer.render(R.scene, R.camera);
  drawInk(now);
  if (state.flash.size) {
    for (const [id, until] of state.flash) if (until < now) state.flash.delete(id);
    if (state.flash.size) busy = true;
  }
  if (busy) requestDraw();
}

// True when the selected code is zoomed in far enough to read as text.
function readingCode() {
  const lay = state.lay;
  if (lay?.kind !== 'map') return false;
  const f = state.T.fileOf[selIds()[0] ?? -1];
  const c = f >= 0 ? lay.code.get(f) : null;
  return !!c && c.lh * state.t.k >= 7.5;
}

// World (layout units) → screen pixels.
function toScreen(x, y, z = 0) {
  if (state.lay?.kind !== 'city' && !R.pitch) {
    const t = state.t;
    return [x * t.k + t.x, y * t.k + t.y];
  }
  const v = new THREE.Vector3(x, -y, z);
  R.base.updateMatrixWorld(true);
  v.applyMatrix4(R.base.matrixWorld).project(R.camera);
  return [(v.x + 1) / 2 * R.W, (1 - v.y) / 2 * R.H];
}

// ───────────────────────────── Ink (text and outlines) ─────────────────────────────

const widths = new Map();
function textWidth(ctx, s) {
  const key = ctx.font + '|' + s;
  let w = widths.get(key);
  if (w == null) { w = ctx.measureText(s).width; if (widths.size > 40000) widths.clear(); widths.set(key, w); }
  return w;
}

function fitText(ctx, s, max) {
  if (max <= 6) return '';
  if (textWidth(ctx, s) <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(ctx, s.slice(0, mid) + '…') <= max) lo = mid; else hi = mid - 1;
  }
  return lo ? s.slice(0, lo) + '…' : '';
}

let monoRatio = 0.6;
function measureMono() {
  const c = document.createElement('canvas').getContext('2d');
  c.font = `100px ${MONO_FONT}`;
  monoRatio = c.measureText('0123456789').width / 1000 || 0.6;
}

function haloText(ctx, text, x, y, color, th) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = th.halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawInk(now) {
  const ctx = R.ink;
  if (!ctx) return;
  ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
  ctx.clearRect(0, 0, R.W, R.H);
  const lay = state.lay;
  if (!lay || !state.T) return;
  ctx.textBaseline = 'middle';
  if (lay.kind === 'map') inkMap(ctx, now);
  else if (lay.kind === 'city') inkCity(ctx);
  else inkGraph(ctx);
  inkFocus(ctx, now);
  if (R.box) {
    const b = R.box;
    ctx.fillStyle = css(rgb(theme().accent), 0.12);
    ctx.strokeStyle = theme().accent;
    ctx.lineWidth = 1;
    ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    ctx.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
  }
  if (R.drag) inkDrag(ctx);
}

function inkMap(ctx) {
  const th = theme();
  const T = state.T, N = T.N, lay = state.lay;
  const { k, x: tx, y: ty } = state.t;
  const vx0 = -tx / k, vy0 = -ty / k, vx1 = (R.W - tx) / k, vy1 = (R.H - ty) / k;
  const stack = [[0, false]];
  const files = [];
  while (stack.length) {
    const [id, quiet] = stack.pop();
    for (const c of T.kids[id]) {
      const n = N[c];
      if (RANK[n.kind] > 3) continue;
      const r = lay.rect.get(c);
      if (!r || r.x > vx1 || r.y > vy1 || r.x + r.w < vx0 || r.y + r.h < vy0) continue;
      const sw = r.w * k, sh = r.h * k;
      if (sw < 4 || sh < 4) continue;
      const sx = r.x * k + tx, sy = r.y * k + ty;
      if (n.kind === 'file') { files.push([c, r, sx, sy, sw, sh, quiet]); continue; }
      const hp = r.head * k;
      let calm = quiet;
      if (hp >= 8.5 && sw > 34) {
        const size = clamp(hp * 0.62, 9.5, 22);
        ctx.font = `${n.kind === 'repo' ? 650 : 560} ${size}px ${UI_FONT}`;
        const label = n.kind === 'repo' && n.branch ? `${n.name}  ·  ${n.branch}` : n.name;
        const lx = Math.max(sx + hp * 0.35, Math.min(8, sx + sw - 40));
        const max = sx + sw - lx - hp * 0.3;
        const text = fitText(ctx, label, max - (T.count[c] ? 30 : 0));
        ctx.fillStyle = n.kind === 'repo' ? th.ink : th.ink2;
        ctx.fillText(text, lx, sy + hp * 0.52);
        if (T.count[c] && state.paint === 'issues' && sw > 90) {
          ctx.font = `600 ${Math.min(size, 12)}px ${UI_FONT}`;
          ctx.fillStyle = LEVEL_COLOR[LEVELS[3 - T.sev[c]]] ?? th.ink3;
          const s = short(T.count[c]);
          ctx.fillText(s, sx + sw - hp * 0.3 - textWidth(ctx, s), sy + hp * 0.52);
        }
      } else if (!quiet && sw > 56 && sh > 26 && !kidsReadable(c, k)) {
        const size = clamp(Math.min(sh * 0.2, (sw / Math.max(4, n.name.length)) * 1.45), 10, 26);
        ctx.font = `620 ${size}px ${UI_FONT}`;
        const text = fitText(ctx, n.name, sw - 10);
        if (text) {
          const w = textWidth(ctx, text);
          haloText(ctx, text, sx + (sw - w) / 2, sy + sh / 2, th.ink, th);
          calm = true;
        }
      }
      stack.push([c, calm]);
    }
  }
  for (const f of files) inkFile(ctx, ...f);
}

// True when some child of a folder is big enough on screen to carry its own label.
function kidsReadable(id, k) {
  const lay = state.lay, T = state.T;
  for (const c of T.kids[id]) {
    const r = lay.rect.get(c);
    if (r && (r.head ?? 0) * k >= 9 && r.w * k > 40) return true;
  }
  return false;
}

function inkFile(ctx, id, r, sx, sy, sw, sh, quiet) {
  const th = theme();
  const T = state.T, n = T.N[id], lay = state.lay;
  const { k } = state.t;
  const hp = r.head * k;
  if (hp >= 9 && sw > 30) {
    const size = clamp(hp * 0.6, 9.5, 17);
    ctx.font = `600 ${size}px ${UI_FONT}`;
    const right = sw > 120 ? short(n.lines) : '';
    ctx.font = `500 ${size * 0.9}px ${UI_FONT}`;
    const rw = right ? textWidth(ctx, right) + 8 : 0;
    ctx.fillStyle = css(rgb(th.bg), 0.62);
    if (right) ctx.fillText(right, sx + sw - rw - 2, sy + hp * 0.52);
    ctx.font = `600 ${size}px ${UI_FONT}`;
    ctx.fillStyle = state.paint === 'lang' || state.paint === 'issues' || state.paint === 'review' || state.paint === 'stage' ? '#0d0d0c' : th.ink;
    const lum = paintOf(id);
    const dark = lum[0] * 0.3 + lum[1] * 0.59 + lum[2] * 0.11 > 0.55;
    ctx.fillStyle = dark ? '#111110' : '#f6f5f2';
    ctx.fillText(fitText(ctx, n.name, sw - hp * 0.5 - rw), sx + hp * 0.3, sy + hp * 0.52);
    const st = stageOf(id);
    if (st) {
      const s = { add: '+', edit: '~', delete: '−' }[st];
      ctx.font = `700 ${size}px ${MONO_FONT}`;
      ctx.fillStyle = dark ? '#111110' : '#ffffff';
      ctx.fillText(s, sx + sw - rw - hp * 0.6 - 4, sy + hp * 0.52);
    }
  } else if (!quiet && sw > 64 && sh > 22 && (lay.code.get(id)?.lh ?? 0) * k < 1.6) {
    const size = clamp(Math.min(sh * 0.24, (sw / Math.max(4, n.name.length)) * 1.5), 9.5, 17);
    ctx.font = `600 ${size}px ${UI_FONT}`;
    const text = fitText(ctx, n.name, sw - 8);
    if (text) haloText(ctx, text, sx + (sw - textWidth(ctx, text)) / 2, sy + sh / 2, th.ink, th);
  }
  const c = lay.code.get(id);
  if (!c) return;
  const lhPx = c.lh * k;
  if (lhPx < 1.1) return;
  const text = state.texts.get(n.key);
  if (!text) { wantText(n.key); return; }
  inkCode(ctx, id, c, text, lhPx, quiet);
}

function inkCode(ctx, id, c, text, lhPx, quiet = false) {
  const th = theme();
  const T = state.T, lay = state.lay;
  const { k, x: tx, y: ty } = state.t;
  const cwPx = CODE.cw * lhPx;
  const gutPx = CODE.gut * cwPx;
  const tokens = th.tokens;
  const textMode = lhPx >= 7.5;
  const fontPx = Math.min(lhPx * 0.84, cwPx / monoRatio);
  const issues = T.issuesOf;
  const marks = new Map();
  walk(id, (x) => { for (const i of issues[x]) { const iss = state.model.issues[i]; if (iss.waived && !state.showWaived) continue; const prev = marks.get(iss.line); if (!prev || LEVEL_RANK[iss.level] > LEVEL_RANK[prev]) marks.set(iss.line, iss.level); } });
  const sel = selIds();
  const picked = sel.filter((s) => T.fileOf[s] === id && s !== id).map((s) => T.N[s]);
  for (let j = 0; j < c.cols; j++) {
    const colX = (c.x + j * (c.colW + c.gap)) * k + tx;
    const colY = c.y * k + ty;
    const colW = c.colW * k;
    if (colX > R.W || colX + colW < 0) continue;
    const r0 = Math.max(0, Math.floor(-colY / lhPx));
    const r1 = Math.min(c.rows, Math.ceil((R.H - colY) / lhPx));
    if (r0 >= r1) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(colX, colY + r0 * lhPx, colW, (r1 - r0) * lhPx);
    ctx.clip();
    if (textMode) ctx.font = `${fontPx}px ${MONO_FONT}`;
    for (let r = r0; r < r1; r++) {
      const li = j * c.rows + r;
      if (li >= text.lines.length) break;
      const y = colY + r * lhPx;
      const line = li + 1;
      if (picked.some((s) => line >= s.from && line <= s.to) || line === state.hoverLine && state.hover >= 0 && T.fileOf[state.hover] === id) {
        ctx.fillStyle = css(rgb(th.accent), line === state.hoverLine ? 0.16 : 0.09);
        ctx.fillRect(colX, y, colW, lhPx);
      }
      const lv = marks.get(line);
      if (lv) {
        ctx.fillStyle = css(rgb(LEVEL_COLOR[lv]), 0.13);
        ctx.fillRect(colX + gutPx, y, colW - gutPx, lhPx);
        ctx.fillStyle = LEVEL_COLOR[lv];
        ctx.fillRect(colX + gutPx * 0.15, y + lhPx * 0.15, Math.max(1.5, cwPx * 0.6), lhPx * 0.7);
      }
      const spans = text.spans[li];
      const str = text.lines[li];
      if (textMode) {
        if (lhPx >= 10) {
          ctx.fillStyle = th.ink3;
          const num = String(line);
          ctx.globalAlpha = 0.7;
          ctx.fillText(num, colX + gutPx - cwPx * 0.8 - num.length * cwPx * (fontPx * monoRatio / cwPx), y + lhPx * 0.55);
          ctx.globalAlpha = 1;
        }
        const scale = (fontPx * monoRatio) / cwPx;
        for (let s = 0; s < spans.length; s += 3) {
          const start = spans[s], len = spans[s + 1];
          const x = colX + gutPx + start * cwPx * scale;
          if (x > colX + colW) break;
          ctx.fillStyle = tokens[spans[s + 2]];
          ctx.fillText(str.substr(start, len), x, y + lhPx * 0.55);
        }
      } else {
        ctx.globalAlpha = 0.62;
        for (let s = 0; s < spans.length; s += 3) {
          const cls = spans[s + 2];
          if (cls === TK.pun && spans[s + 1] < 2) continue;
          ctx.fillStyle = tokens[cls];
          const x = colX + gutPx + spans[s] * cwPx;
          if (x > colX + colW) break;
          ctx.fillRect(x, y + lhPx * 0.22, Math.max(0.6, spans[s + 1] * cwPx - 0.4), Math.max(0.6, lhPx * 0.56));
        }
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }
  if (!textMode && lhPx >= 1.6 && !quiet) {
    const taken = [];
    for (const it of lay.pieces.get(id) ?? []) {
      const ph = it.h * k;
      if (ph < 16 || !/s0$/.test(it.key)) continue;
      const s = T.N[it.id];
      if (s.kind === 'space') continue;
      const px = it.x * k + tx, py = it.y * k + ty;
      if (px > R.W || py > R.H || px + it.w * k < 0 || py + ph < 0) continue;
      ctx.font = `600 11px ${UI_FONT}`;
      const label = fitText(ctx, `${s.form === 'ctor' ? 'new' : s.form ?? s.kind} ${s.name}`, it.w * k - 12);
      if (!label) continue;
      const w = textWidth(ctx, label);
      const box = [px + 3, py + 2, w + 10, 16];
      if (taken.some((b) => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])) continue;
      taken.push(box);
      ctx.fillStyle = th.halo;
      ctx.beginPath();
      ctx.roundRect(...box, 4);
      ctx.fill();
      ctx.fillStyle = s.kind === 'type' ? th.series[6] : th.ink;
      ctx.fillText(label, px + 8, py + 10.5);
    }
  }
}

function inkGraph(ctx) {
  const th = theme();
  const T = state.T, N = T.N, lay = state.lay;
  const { k } = state.t;
  if (lay.kind === 'layers') {
    ctx.font = `600 11px ${UI_FONT}`;
    for (const b of lay.bands) {
      const [, y0] = toScreen(0, b.y0);
      const [, y1] = toScreen(0, b.y1);
      if (y1 < 0 || y0 > R.H) continue;
      ctx.fillStyle = css(rgb(th.ink3), 0.06);
      ctx.fillRect(0, y0, R.W, y1 - y0);
      ctx.fillStyle = th.ink3;
      const label = b.level === 0 ? 'Level 0 · base' : `Level ${b.level}`;
      ctx.fillText(`${label}  ·  ${b.count}`, viewport().x + 12, (y0 + y1) / 2);
    }
  }
  const grid = new Set();
  const cell = 14;
  const free = (x, y, w, hgt) => {
    for (let gx = Math.floor(x / cell); gx <= Math.floor((x + w) / cell); gx++) for (let gy = Math.floor(y / cell); gy <= Math.floor((y + hgt) / cell); gy++) if (grid.has(gx * 4096 + gy)) return false;
    return true;
  };
  const take = (x, y, w, hgt) => {
    for (let gx = Math.floor(x / cell); gx <= Math.floor((x + w) / cell); gx++) for (let gy = Math.floor(y / cell); gy <= Math.floor((y + hgt) / cell); gy++) grid.add(gx * 4096 + gy);
  };
  const focus = new Set(focusIds().map((id) => (lay.rect.has(id) ? id : liftTo(id, detailRank()))));
  for (const e of state.linkList ?? []) if (focus.has(e.a) || focus.has(e.b)) { focus.add(e.a); focus.add(e.b); }
  const order = [...lay.rect.keys()].sort((a, b) => (focus.has(b) - focus.has(a)) || N[b].lines - N[a].lines);
  let drawn = 0;
  for (const id of order) {
    const r = lay.rect.get(id);
    const [sx, sy] = toScreen(r.x, r.y);
    const sw = r.w * k, sh = r.h * k;
    if (sx > R.W || sy > R.H || sx + sw < 0 || sy + sh < 0) continue;
    const important = focus.has(id);
    if (!important && (sw < 9 || drawn > 700)) continue;
    const n = N[id];
    if (lay.kind === 'layers' && sh >= 11) {
      const size = clamp(sh * 0.55, 9, 14);
      ctx.font = `600 ${size}px ${UI_FONT}`;
      const text = fitText(ctx, n.name, sw - 6);
      if (text) {
        const col = paintOf(id);
        ctx.fillStyle = col[0] * 0.3 + col[1] * 0.59 + col[2] * 0.11 > 0.55 ? '#111110' : '#f6f5f2';
        ctx.fillText(text, sx + 4, sy + sh / 2);
        drawn++;
        continue;
      }
    }
    const size = important ? 12.5 : clamp(sw * 0.3, 10, 13);
    ctx.font = `${important ? 650 : 550} ${size}px ${UI_FONT}`;
    const text = fitText(ctx, n.name, 180);
    const w = textWidth(ctx, text);
    const lx = sx + sw / 2 - w / 2, ly = sy + sh + size * 0.85;
    if (!important && !free(lx, ly - size / 2, w, size)) continue;
    take(lx, ly - size / 2, w, size);
    haloText(ctx, text, lx, ly, important ? th.ink : th.ink2, th);
    drawn++;
  }
}

function inkCity(ctx) {
  const th = theme();
  const T = state.T, N = T.N, lay = state.lay;
  const grid = new Set();
  const cell = 16;
  const list = lay.items.filter((it) => it.part === 'dir' ? T.depth[it.id] <= 3 : true).sort((a, b) => (b.part === 'dir') - (a.part === 'dir') || b.w * b.h - a.w * a.h).slice(0, 400);
  for (const it of list) {
    const top = it.z + it.h3;
    const [sx, sy] = it.part === 'dir' ? toScreen(it.x + it.w * 0.02, it.y + it.h * 0.02, top) : toScreen(it.x + it.w / 2, it.y + it.h / 2, top);
    if (sx < 0 || sy < 0 || sx > R.W || sy > R.H) continue;
    const [ex] = toScreen(it.x + it.w, it.y, top);
    const span = Math.abs(ex - sx);
    if (span < (it.part === 'dir' ? 60 : 26)) continue;
    const n = N[it.id];
    const size = it.part === 'dir' ? (T.depth[it.id] <= 2 ? 13 : 11.5) : 11;
    ctx.font = `${it.part === 'dir' ? 650 : 550} ${size}px ${UI_FONT}`;
    const text = fitText(ctx, n.name, 160);
    const w = textWidth(ctx, text);
    const lx = it.part === 'dir' ? sx : sx - w / 2;
    const gx0 = Math.floor(lx / cell), gx1 = Math.floor((lx + w) / cell), gy0 = Math.floor((sy - 8) / cell), gy1 = Math.floor((sy + 8) / cell);
    let ok = true;
    for (let g = gx0; g <= gx1 && ok; g++) for (let gy = gy0; gy <= gy1; gy++) if (grid.has(g * 4096 + gy)) ok = false;
    if (!ok) continue;
    for (let g = gx0; g <= gx1; g++) for (let gy = gy0; gy <= gy1; gy++) grid.add(g * 4096 + gy);
    haloText(ctx, text, lx, sy, it.part === 'dir' ? th.ink : th.ink2, th);
  }
}

function rectsOf(id) {
  const lay = state.lay;
  if (!lay) return [];
  if (lay.kind === 'map') {
    const T = state.T;
    const f = T.fileOf[id];
    if (f >= 0 && f !== id) return lay.pieces.get(f)?.filter((it) => it.id === id) ?? [];
    const r = lay.rect.get(id);
    return r ? [r] : [];
  }
  if (lay.kind === 'city') return [];
  const r = lay.rect.get(id) ?? lay.rect.get(liftTo(id, detailRank()));
  return r ? [r] : [];
}

function strokeRects(ctx, rects, color, width, round = false) {
  const { k } = state.t;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (const r of rects) {
    const [sx, sy] = toScreen(r.x, r.y);
    const sw = r.w * k, sh = r.h * k;
    if (sx > R.W || sy > R.H || sx + sw < 0 || sy + sh < 0) continue;
    ctx.beginPath();
    if (round) ctx.arc(sx + sw / 2, sy + sh / 2, Math.max(sw / 2 + width, 3), 0, Math.PI * 2);
    else ctx.roundRect(sx - width / 2, sy - width / 2, Math.max(sw + width, 2), Math.max(sh + width, 2), 3);
    ctx.stroke();
  }
}

function inkFocus(ctx, now) {
  const th = theme();
  const lay = state.lay;
  const round = lay.kind === 'graph';
  if (lay.kind === 'city') {
    for (const id of [...selIds(), state.hover].filter((x) => x > 0)) {
      const f = liftTo(id, 3);
      const it = lay.items.find((x) => x.id === f);
      if (!it) continue;
      const pts = [[it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.h], [it.x, it.y + it.h]].map(([x, y]) => toScreen(x, y, it.z + it.h3));
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.strokeStyle = id === state.hover ? th.ink : th.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    return;
  }
  if (state.spot) {
    const seen = new Set();
    for (const iss of state.model.issues) {
      if (iss.rule !== state.spot || (iss.waived && !state.showWaived) || seen.has(iss.node)) continue;
      seen.add(iss.node);
      strokeRects(ctx, rectsOf(iss.node), LEVEL_COLOR[iss.level], 1.5, round);
    }
  }
  for (const [id, until] of state.flash) {
    const a = clamp((until - now) / 1200, 0, 1);
    strokeRects(ctx, rectsOf(id), css(rgb(th.series[1]), a), 3, round);
  }
  for (const id of selIds()) strokeRects(ctx, rectsOf(id), th.accent, 2.2, round);
  if (state.hover > 0) strokeRects(ctx, rectsOf(state.hover), css(rgb(th.ink), 0.75), 1.4, round);
  if (R.dropOn > 0) strokeRects(ctx, rectsOf(R.dropOn), STATUS.good, 2.5, round);
  const grip = gripRect();
  if (grip) {
    ctx.fillStyle = th.accent;
    ctx.beginPath();
    ctx.roundRect(grip.x, grip.y, grip.w, grip.h, 5);
    ctx.fill();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) ctx.fillRect(grip.x + grip.w / 2 - 3 + j * 4, grip.y + grip.h / 2 - 5 + i * 4, 2, 2);
  }
}

function inkDrag(ctx) {
  const th = theme();
  const d = R.drag;
  ctx.font = `600 12px ${UI_FONT}`;
  const target = R.dropOn > 0 ? ` → ${node(R.dropOn).name}/` : '';
  const text = `${node(d.id).name}${target}`;
  const w = textWidth(ctx, text);
  ctx.fillStyle = th.accent;
  ctx.beginPath();
  ctx.roundRect(d.x + 14, d.y + 10, w + 16, 24, 7);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, d.x + 22, d.y + 22);
}

// ───────────────────────────── Code text ─────────────────────────────

const KW = new Set(`abstract and as assert async await base break case catch class const continue crate def default defer del delete do dyn elif else enum except export extends extern false final finally fn for foreach from func function get go goto if impl implements import in init instanceof interface internal is lambda let loop match mod module mut namespace new nil none not null of operator or out override package pass private protected pub public raise readonly record ref return sealed select self set static struct super switch this throw throws trait true try type typeof union unsafe use using val var virtual void volatile when where while with yield None True False Self`.split(/\s+/));
const SYNTAX = {
  c: { line: ['//'], block: [['/*', '*/']], quotes: '"\'`' },
  hash: { line: ['#'], block: [], quotes: '"\'' },
  py: { line: ['#'], block: [], quotes: '"\'', triple: true },
  sql: { line: ['--'], block: [['/*', '*/']], quotes: '\'"' },
  lua: { line: ['--'], block: [['--[[', ']]']], quotes: '"\'' },
  xml: { line: [], block: [['<!--', '-->']], quotes: '"\'' },
  css: { line: [], block: [['/*', '*/']], quotes: '"\'' },
  json: { line: [], block: [], quotes: '"' },
  md: { line: [], block: [], quotes: '' },
};
const SYNTAX_OF = { py: 'py', rb: 'hash', sh: 'hash', yaml: 'hash', toml: 'hash', text: 'md', md: 'md', sql: 'sql', lua: 'lua', html: 'xml', xml: 'xml', css: 'css', json: 'json', php: 'c' };

function tokenize(raw, lang) {
  const syn = SYNTAX[SYNTAX_OF[lang] ?? 'c'];
  const data = lang === 'json' || lang === 'yaml' || lang === 'toml';
  const lines = raw.replace(/\t/g, '    ').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const spans = new Array(lines.length);
  let inBlock = null, inStr = null;
  for (let li = 0; li < lines.length; li++) {
    const s = lines[li];
    const out = [];
    const push = (start, len, cls) => { if (len > 0) out.push(start, len, cls); };
    let i = 0;
    if (lang === 'md') {
      const m = /^(\s*)(#{1,6}\s.*|```.*|[-*]\s|\d+\.\s)?/.exec(s);
      if (m[2]?.startsWith('#')) push(m[1].length, s.length - m[1].length, TK.kw);
      else if (m[2]?.startsWith('```')) push(0, s.length, TK.str);
      else push(0, s.length, TK.txt);
      spans[li] = out;
      continue;
    }
    while (i < s.length) {
      if (inBlock) {
        const j = s.indexOf(inBlock, i);
        const end = j < 0 ? s.length : j + inBlock.length;
        push(i, end - i, TK.com);
        i = end;
        if (j >= 0) inBlock = null;
        continue;
      }
      if (inStr) {
        let j = i;
        while (j < s.length) {
          if (s[j] === '\\' && inStr.length === 1) { j += 2; continue; }
          if (s.startsWith(inStr, j)) { j += inStr.length; inStr = inStr + '!'; break; }
          j++;
        }
        push(i, j - i, TK.str);
        i = j;
        if (inStr.endsWith('!')) inStr = null;
        else if (inStr.length === 1 && inStr !== '`') inStr = null;
        continue;
      }
      const c = s[i];
      if (c === ' ') { let j = i; while (s[j] === ' ') j++; i = j; continue; }
      let hit = false;
      for (const [a, b] of syn.block) if (s.startsWith(a, i)) { inBlock = b; push(i, a.length, TK.com); i += a.length; hit = true; break; }
      if (hit) continue;
      for (const t of syn.line) if (s.startsWith(t, i) && (t !== '#' || i === 0 || /\s/.test(s[i - 1]))) { push(i, s.length - i, TK.com); i = s.length; hit = true; break; }
      if (hit) continue;
      if (syn.quotes.includes(c)) {
        const triple = (syn.triple || c === '"') && s.startsWith(c + c + c, i) ? c + c + c : null;
        inStr = triple ?? c;
        push(i, triple ? 3 : 1, TK.str);
        i += triple ? 3 : 1;
        if (data && c === '"') {
          const j = s.indexOf('"', i);
          if (j > 0 && /^\s*:/.test(s.slice(j + 1))) { out.splice(-3); push(i - 1, j - i + 2, TK.type); i = j + 1; inStr = null; }
        }
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
        const m = /^(?:0x[\da-f_]+|[\d_]*\.?[\d_]+(?:e[+-]?\d+)?)[a-z]*/i.exec(s.slice(i));
        push(i, m[0].length || 1, TK.num);
        i += m[0].length || 1;
        continue;
      }
      if (/[A-Za-z_$@]/.test(c)) {
        const m = /^[A-Za-z_$@][\w$]*/.exec(s.slice(i));
        const w = m[0];
        let cls = TK.txt;
        if (KW.has(w)) cls = TK.kw;
        else if (data && /^\s*:/.test(s.slice(i + w.length)) && /^\s*$/.test(s.slice(0, i).replace(/-\s*$/, ''))) cls = TK.type;
        else if (/^\s*\(/.test(s.slice(i + w.length, i + w.length + 3))) cls = TK.fn;
        else if (/^[A-Z][a-z0-9]/.test(w)) cls = TK.type;
        push(i, w.length, cls);
        i += w.length;
        continue;
      }
      let j = i + 1;
      while (j < s.length && /[^\w\s"'`$@]/.test(s[j]) && !syn.line.some((t) => s.startsWith(t, j)) && !syn.block.some(([a]) => s.startsWith(a, j))) j++;
      push(i, j - i, TK.pun);
      i = j;
    }
    spans[li] = out;
  }
  return { lines, spans };
}

let textTimer = 0;
function wantText(key) {
  if (state.texts.has(key) || state.wanted.has(key)) return;
  state.wanted.add(key);
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    const keys = [...state.wanted].filter((k) => !state.texts.has(k)).slice(0, 60);
    for (const k of keys) wire.ask('file.read', { key: k });
  }, 60);
}

// ───────────────────────────── Picking ─────────────────────────────

function toWorld(sx, sy) {
  const t = state.t;
  return [(sx - t.x) / t.k, (sy - t.y) / t.k];
}

function pickAt(sx, sy) {
  const lay = state.lay;
  const T = state.T;
  if (!lay || !T) return null;
  if (lay.kind === 'city') {
    const ndc = new THREE.Vector2(sx / R.W * 2 - 1, -(sy / R.H) * 2 + 1);
    R.raycaster.setFromCamera(ndc, R.camera);
    R.scene.updateMatrixWorld(true);
    const hit = R.raycaster.intersectObject(R.blocks, false)[0];
    return hit ? { id: lay.items[hit.instanceId]?.id } : null;
  }
  const [wx, wy] = toWorld(sx, sy);
  if (lay.kind === 'map') {
    let id = 0;
    let found = true;
    while (found) {
      found = false;
      for (const c of T.kids[id]) {
        const k = T.N[c].kind;
        if (k !== 'repo' && k !== 'dir' && k !== 'file') continue;
        const r = lay.rect.get(c);
        if (r && wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) { id = c; found = k !== 'file'; break; }
      }
    }
    if (id <= 0) return null;
    if (T.N[id].kind !== 'file') return { id };
    const c = lay.code.get(id);
    let line = 0;
    if (c && wy >= c.y) {
      const col = Math.floor((wx - c.x) / (c.colW + c.gap));
      const row = Math.floor((wy - c.y) / c.lh);
      if (col >= 0 && col < c.cols && row >= 0 && row < c.rows) line = col * c.rows + row + 1;
      if (line > T.N[id].lines) line = 0;
    }
    const list = lay.pieces.get(id) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (wx >= p.x - c.lh * 2 && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h) return { id: p.id, line };
    }
    return { id, line };
  }
  const reach = 10 / state.t.k;
  let best = null, bestD = Infinity;
  if (lay.kind === 'graph') {
    lay.quad.visit((q, x0, y0, x1, y1) => {
      if (!q.length) {
        let d = q;
        do {
          const nd = d.data;
          const dist = Math.hypot(nd.x - wx, nd.y - wy) - nd.r;
          if (dist < reach && dist < bestD) { bestD = dist; best = nd.id; }
        } while ((d = d.next));
      }
      return x0 > wx + reach + 120 || x1 < wx - reach - 120 || y0 > wy + reach + 120 || y1 < wy - reach - 120;
    });
    return best ? { id: best } : null;
  }
  for (const [id, r] of lay.rect) {
    if (wx >= r.x - reach && wx <= r.x + r.w + reach && wy >= r.y - reach && wy <= r.y + r.h + reach) {
      const d = Math.hypot(Math.max(r.x - wx, 0, wx - r.x - r.w), Math.max(r.y - wy, 0, wy - r.y - r.h));
      if (d < bestD) { bestD = d; best = id; }
    }
  }
  return best ? { id: best } : null;
}

// ───────────────────────────── View control ─────────────────────────────

let zoom;
function setupZoom() {
  const el = $('#view');
  zoom = d3.zoom()
    .scaleExtent([0.001, 1000])
    .filter((e) => {
      if (e.type === 'dblclick') return false;
      if (e.type === 'mousedown' && (e.shiftKey || e.button !== 0 || R.gripHit)) return false;
      if (e.type === 'touchstart' && R.drag) return false;
      return true;
    })
    .on('start', () => { el.classList.add('grab'); })
    .on('zoom', (e) => { state.t = e.transform; hideTip(); requestDraw(); })
    .on('end', () => { el.classList.remove('grab'); drawCrumbs(); });
  d3.select(el).call(zoom).on('dblclick.zoom', null);
}

function setZoomRange() {
  const lay = state.lay;
  if (!lay) return;
  const b = lay.bounds;
  const fit = Math.min(R.W / Math.max(b.w, 1), R.H / Math.max(b.h, 1));
  let max = fit * 60;
  if (lay.kind === 'map') {
    let minLh = Infinity;
    for (const c of lay.code.values()) minLh = Math.min(minLh, c.lh);
    max = Math.max(fit * 8, 26 / (minLh || 1));
  }
  zoom.scaleExtent([fit * 0.35, Math.max(max, fit * 4)]);
}

function viewport() {
  const left = !state.narrow && state.dock ? 368 + 20 : 0;
  const right = !state.narrow && !$('#info').hidden ? 344 + 20 : 0;
  const top = 64, bottom = state.narrow ? (state.sheet ? window.innerHeight * 0.6 + 56 : 96) : 52;
  return { x: left, y: top, w: Math.max(120, R.W - left - right), h: Math.max(120, R.H - top - bottom) };
}

function fitRect(r, pad = 0.9, ms = 650, minK = 0) {
  const v = viewport();
  const lay = state.lay;
  let w = r.w, hh = r.h;
  if (lay?.kind === 'city') { w *= 1.1; hh = hh * Math.cos(0.95) + lay.tall * 0.9; }
  let k = Math.min(v.w * pad / Math.max(w, 1e-6), v.h * pad / Math.max(hh, 1e-6));
  const [lo, hi] = zoom.scaleExtent();
  k = clamp(Math.max(k, minK), lo, hi);
  let cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  if (lay?.kind === 'city') cy = lay.bounds.y + lay.bounds.h / 2 + (cy - lay.bounds.y - lay.bounds.h / 2) * Math.cos(0.95);
  const t = d3.zoomIdentity.translate(v.x + v.w / 2 - cx * k, v.y + v.h / 2 - cy * k).scale(k);
  const sel = d3.select('#view');
  if (ms) sel.transition().duration(ms).ease(d3.easeCubicInOut).call(zoom.transform, t);
  else sel.call(zoom.transform, t);
}

function fitAll(ms = 650) {
  if (!state.lay) return;
  fitRect(state.lay.bounds, 0.94, ms);
}

function flyTo(id, ms = 700) {
  const lay = state.lay;
  if (!lay || id <= 0) return;
  const T = state.T;
  if (lay.kind === 'map') {
    const f = T.fileOf[id];
    if (f >= 0 && f !== id) {
      const list = lay.pieces.get(f)?.filter((it) => it.id === id) ?? [];
      if (!list.length) return flyTo(f, ms);
      const x0 = d3.min(list, (p) => p.x), y0 = d3.min(list, (p) => p.y), x1 = d3.max(list, (p) => p.x + p.w), y1 = d3.max(list, (p) => p.y + p.h);
      const c = lay.code.get(f);
      const r = { x: x0 - c.lh * 3, y: y0 - c.lh * 2, w: x1 - x0 + c.lh * 4, h: Math.min(y1 - y0 + c.lh * 4, c.lh * 60) };
      return fitRect(r, 0.92, ms, Math.min(13 / c.lh, viewport().w * 0.95 / (c.colW + c.lh * 4)));
    }
    const r = lay.rect.get(id);
    if (r) fitRect(r, 0.9, ms);
    return;
  }
  if (lay.kind === 'city') {
    const r = lay.rect.get(liftTo(id, 3));
    if (r) fitRect(r, 0.6, ms);
    return;
  }
  const r = lay.rect.get(id) ?? lay.rect.get(liftTo(id, detailRank()));
  if (r) fitRect({ x: r.x - r.w * 3, y: r.y - r.h * 3, w: r.w * 7, h: r.h * 7 }, 0.9, ms);
}

// Selected file or folder shows a grip on its header; drag it to move.
function gripRect() {
  const lay = state.lay;
  if (!lay || lay.kind !== 'map' || state.sel.length !== 1) return null;
  const id = idOf(state.sel[0]);
  const n = node(id);
  if (!n || (n.kind !== 'file' && n.kind !== 'dir')) return null;
  const r = lay.rect.get(id);
  if (!r) return null;
  const { k } = state.t;
  const hp = r.head * k;
  if (hp < 9 || r.w * k < 50) return null;
  const [sx, sy] = toScreen(r.x + r.w, r.y);
  const size = clamp(hp * 0.8, 16, 26);
  return { x: sx - size - 4, y: sy + (hp - size) / 2, w: size, h: size, id };
}

function setupPointer() {
  const el = $('#view');
  let down = null, lastTap = null, press = 0;
  el.addEventListener('pointerdown', (e) => {
    const g = gripRect();
    R.gripHit = !!(g && e.offsetX >= g.x && e.offsetX <= g.x + g.w && e.offsetY >= g.y && e.offsetY <= g.y + g.h);
    down = { x: e.offsetX, y: e.offsetY, t: performance.now(), type: e.pointerType, moved: false };
    if (R.gripHit) {
      R.drag = { id: g.id, x: e.offsetX, y: e.offsetY };
      el.setPointerCapture(e.pointerId);
      el.classList.add('drop');
      requestDraw();
    } else if (e.shiftKey && e.pointerType === 'mouse') {
      R.box = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY };
      el.setPointerCapture(e.pointerId);
    }
    clearTimeout(press);
    if (e.pointerType === 'touch') {
      press = setTimeout(() => {
        if (!down || down.moved) return;
        const hit = pickAt(down.x, down.y);
        if (hit?.id) { hub.emit('pick.set', { ids: [hit.id], add: true }); down.moved = true; navigator.vibrate?.(10); }
      }, 520);
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 6) down.moved = true;
    if (R.drag) {
      R.drag.x = e.offsetX; R.drag.y = e.offsetY;
      const hit = pickAt(e.offsetX, e.offsetY);
      let target = hit?.id ?? -1;
      while (target > 0 && !['dir', 'repo'].includes(node(target).kind)) target = node(target).up;
      const from = idOf(state.sel[0]);
      R.dropOn = target > 0 && !isUnder(target, from) && target !== node(from).up ? target : -1;
      requestDraw();
      return;
    }
    if (R.box) { R.box.x1 = e.offsetX; R.box.y1 = e.offsetY; requestDraw(); return; }
    if (e.pointerType !== 'mouse' || e.buttons) return;
    hoverAt(e.offsetX, e.offsetY, e.clientX, e.clientY);
  });
  el.addEventListener('pointerleave', () => { if (!R.drag) { hub.emit('pick.hover', { id: -1 }); hideTip(); } });
  el.addEventListener('pointerup', (e) => {
    clearTimeout(press);
    if (R.drag) {
      const drag = R.drag;
      const target = R.dropOn;
      R.drag = null; R.dropOn = -1; R.gripHit = false;
      el.classList.remove('drop');
      requestDraw();
      if (target > 0) askMove(idOf(state.sel[0]) === drag.id ? drag.id : drag.id, target, e.clientX, e.clientY);
      return;
    }
    R.gripHit = false;
    if (R.box) {
      const b = R.box;
      R.box = null;
      requestDraw();
      if (Math.abs(b.x1 - b.x0) > 6 || Math.abs(b.y1 - b.y0) > 6) {
        boxSelect(b, e.ctrlKey || e.metaKey);
        down = null;
        return;
      }
      if (down) down.moved = false;
    }
    if (!down || down.moved) { down = null; return; }
    const hit = pickAt(e.offsetX, e.offsetY);
    const now = performance.now();
    const twice = lastTap && now - lastTap.t < 340 && Math.hypot(lastTap.x - e.offsetX, lastTap.y - e.offsetY) < 12;
    lastTap = twice ? null : { t: now, x: e.offsetX, y: e.offsetY };
    if (twice) { if (hit?.id) { hub.emit('pick.set', { ids: [hit.id], line: hit.line }); flyTo(hit.id); } else fitAll(); }
    else if (hit?.id) hub.emit('pick.set', { ids: [hit.id], add: e.shiftKey || e.ctrlKey || e.metaKey, line: hit.line });
    else hub.emit('pick.clear');
    down = null;
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

let hoverTimer = 0;
function hoverAt(sx, sy, cx, cy) {
  cancelAnimationFrame(hoverTimer);
  hoverTimer = requestAnimationFrame(() => {
    const hit = pickAt(sx, sy);
    const id = hit?.id ?? -1;
    const line = hit?.line ?? 0;
    if (id !== state.hover || line !== state.hoverLine) hub.emit('pick.hover', { id, line });
    if (id > 0) showTip(id, line, cx, cy); else hideTip();
    $('#view').classList.toggle('point', id > 0);
  });
}

function boxSelect(b, add) {
  const lay = state.lay;
  if (!lay || lay.kind === 'city') return;
  const [x0, y0] = toWorld(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1));
  const [x1, y1] = toWorld(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
  const ids = [];
  for (const [id, r] of lay.rect) {
    if (r.x >= x0 && r.y >= y0 && r.x + r.w <= x1 && r.y + r.h <= y1) {
      const n = node(id);
      if (lay.kind === 'map' && n.up > 0 && (() => { const pr = lay.rect.get(n.up); return pr && pr.x >= x0 && pr.y >= y0 && pr.x + pr.w <= x1 && pr.y + pr.h <= y1; })()) continue;
      ids.push(id);
    }
  }
  if (ids.length) hub.emit('pick.set', { ids: ids.slice(0, 500), add });
}

// ───────────────────────────── Tip ─────────────────────────────

function showTip(id, line, cx, cy) {
  const tip = $('#tip');
  const n = node(id);
  if (!n || state.narrow) return;
  const T = state.T;
  const nums = [];
  nums.push(plural(n.lines, 'line'));
  if (n.cx) nums.push(`${n.cx} branches`);
  if (n.kind === 'file' && n.churn) nums.push(plural(n.churn, 'commit'));
  if (T.count[id]) nums.push(plural(T.count[id], 'issue'));
  const st = stageOf(id);
  tip.replaceChildren(
    h('b', null, n.kind === 'func' ? `${n.name}()` : n.name),
    h('div', { class: 'muted' }, `${KIND_NAME[n.kind]}${n.form && n.form !== n.kind ? ' · ' + n.form : ''} · ${where(id)}${line && T.N[id].kind === 'file' ? ':' + line : ''}`),
    h('div', { class: 'nums' }, nums.map((x) => h('span', null, x)), st ? h('span', { style: { color: STATUS[st === 'add' ? 'good' : st === 'delete' ? 'critical' : 'warn'] } }, `staged ${st}`) : null),
  );
  tip.hidden = false;
  const w = tip.offsetWidth, hh = tip.offsetHeight;
  tip.style.left = `${Math.min(cx + 16, window.innerWidth - w - 8)}px`;
  tip.style.top = `${cy + 18 + hh > window.innerHeight - 8 ? cy - hh - 12 : cy + 18}px`;
}

function hideTip() { $('#tip').hidden = true; }

// ───────────────────────────── Bar ─────────────────────────────

function seg(options, value, pick, { label, cls = '', title } = {}) {
  return h('div', { class: `seg ${cls}`, role: 'group', 'aria-label': title ?? label },
    label ? h('span', { class: 'label' }, label) : null,
    options.map((o) => h('button', { 'aria-pressed': String(o.id === value), title: o.about ? `${o.about}${o.key ? ` (${o.key})` : ''}` : o.name, onclick: () => pick(o.id) }, o.name)));
}

function picker(options, value, pick, { label, cls = '' } = {}) {
  return h('label', { class: `seg ${cls}` },
    h('span', { class: 'label' }, label),
    h('select', { onchange: (e) => pick(e.target.value), 'aria-label': label }, options.map((o) => h('option', { value: o.id, selected: o.id === value }, o.name))));
}

function drawBar() {
  const tools = $('#tools');
  tools.replaceChildren(
    seg(LAYOUTS, state.layout, (id) => hub.emit('view.layout', id), { cls: 'wide', title: 'Layout' }),
    picker(DETAILS, state.detail, (id) => hub.emit('view.detail', id), { label: 'Detail', cls: 'wide opt' }),
    picker(PAINTS, state.paint, (id) => hub.emit('view.paint', id), { label: 'Color', cls: 'wide opt' }),
    seg(LINK_MODES, state.links, (id) => hub.emit('view.links', id), { label: 'Links', cls: 'wide opt' }),
    h('button', { class: 'icon-btn wide view-btn', title: 'View options', 'aria-label': 'View options', 'aria-pressed': String(state.dock === 'view'), onclick: () => hub.emit('dock.show', state.dock === 'view' ? 'check' : 'view') }, icon('view')),
    h('button', { class: 'icon-btn wide', title: 'Fit all (F)', 'aria-label': 'Fit all', onclick: () => fitAll() }, icon('fit')),
    h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: () => hub.emit('box.open', 'setup') }, icon('setup')),
    h('button', { class: 'icon-btn wide', title: 'Keys and help (?)', 'aria-label': 'Help', onclick: () => hub.emit('box.open', 'keys') }, icon('help')),
  );
  const tabs = $('#tabs');
  const tab = (id, name, ic) => h('button', { 'aria-pressed': String(state.sheet === id), onclick: () => hub.emit('sheet.toggle', id) }, icon(ic), name);
  tabs.replaceChildren(tab('view', 'View', 'view'), tab('check', 'Check', 'check'), tab('change', 'Change', 'change'), tab('info', 'Info', 'info'));
}

function drawCrumbs() {
  const el = $('#crumbs');
  const T = state.T;
  if (!T) { el.replaceChildren(); return; }
  let id = selIds()[0] ?? -1;
  if (id < 0 && state.lay?.kind === 'map') {
    const v = viewport();
    const hit = pickAt(v.x + v.w / 2, v.y + v.h / 2);
    id = hit?.id ?? -1;
    if (id > 0 && T.N[id].kind !== 'dir' && T.N[id].kind !== 'repo') id = T.N[id].up;
  }
  const path = id > 0 ? pathOf(id) : [];
  const parts = [];
  path.forEach((p, i) => {
    if (i) parts.push(h('span', { class: 'sep' }, '/'));
    parts.push(h('button', { title: where(p), onclick: () => { hub.emit('pick.set', { ids: [p] }); flyTo(p); } }, T.N[p].name));
  });
  el.replaceChildren(...(parts.length ? parts : [h('button', { onclick: () => fitAll() }, `${state.model?.nodes.filter((n) => n.kind === 'repo').map((n) => n.name).join(', ') || 'workspace'}`)]));
}

// ───────────────────────────── Find ─────────────────────────────

function score(name, q) {
  const n = name.toLowerCase();
  const i = n.indexOf(q);
  if (i === 0) return 100 - n.length * 0.1;
  if (i > 0) return 70 - i * 0.5 - n.length * 0.1 + (/[^a-z0-9]/.test(n[i - 1]) || /[A-Z]/.test(name[i]) ? 15 : 0);
  let j = 0, gaps = 0, last = -1;
  for (let k = 0; k < n.length && j < q.length; k++) if (n[k] === q[j]) { if (last >= 0) gaps += k - last - 1; last = k; j++; }
  return j === q.length ? 30 - gaps - n.length * 0.05 : -1;
}

function findNodes(q) {
  const T = state.T;
  if (!T || !q) return [];
  q = q.toLowerCase();
  const out = [];
  for (const n of T.N) {
    if (n.id === 0) continue;
    const s = score(n.name, q);
    if (s >= 0) out.push([s + (n.kind === 'file' ? 4 : n.kind === 'type' ? 3 : 0), n.id]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, 400).map((x) => x[1]);
}

function highlight(name, q) {
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return name;
  return [name.slice(0, i), h('mark', null, name.slice(i, i + q.length)), name.slice(i + q.length)];
}

function drawFind() {
  const list = $('#find-list');
  const q = state.query;
  if (!q) { list.hidden = true; return; }
  const ids = findNodes(q);
  const groups = [['Files', (n) => n.kind === 'file'], ['Types', (n) => n.kind === 'type' || n.kind === 'space'], ['Functions', (n) => n.kind === 'func'], ['Folders', (n) => n.kind === 'dir' || n.kind === 'repo'], ['Sections', (n) => n.kind === 'part']];
  const rows = [];
  let index = 0;
  const item = (props, ...kids) => { const i = index++; return h('button', { class: 'hit', role: 'option', 'aria-selected': String(i === state.findPick), ...props }, ...kids); };
  for (const [title, test] of groups) {
    const hits = ids.filter((id) => test(node(id))).slice(0, 8);
    if (!hits.length) continue;
    rows.push(h('h4', null, title));
    for (const id of hits) {
      const n = node(id);
      rows.push(item({ onclick: () => pickFound(id), onmouseenter: () => hub.emit('pick.hover', { id }) },
        h('span', { class: 'dot', style: { background: css(paintOf(id)) } }),
        h('span', { class: 'name' }, highlight(n.kind === 'func' ? n.name + '()' : n.name, q)),
        h('span', { class: 'where' }, where(id))));
    }
  }
  rows.push(h('h4', null, 'Text'));
  rows.push(item({ onclick: () => hub.emit('find.text', q) }, icon('zoom'), h('span', { class: 'name' }, `Search file contents for “${q}”`), h('span', { class: 'where' }, 'Enter ↵ on this row')));
  if (state.findHits?.query === q) {
    for (const hit of state.findHits.hits.slice(0, 80)) {
      const id = idOf(hit.key);
      rows.push(item({ onclick: () => pickFound(id, hit.line) },
        h('span', { class: 'dot', style: { background: id >= 0 ? css(paintOf(id)) : 'transparent' } }),
        h('span', { class: 'text' }, highlight(hit.text, q)),
        h('span', { class: 'where' }, `${state.T.kids[0].length > 1 ? hit.key : hit.key.split('/').slice(1).join('/')}:${hit.line}`)));
    }
    if (!state.findHits.hits.length) rows.push(h('div', { class: 'empty' }, 'No text matches.'));
  }
  list.replaceChildren(...rows);
  list.hidden = false;
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function pickFound(id, line) {
  if (id < 0) return;
  let target = id;
  if (line) {
    const T = state.T;
    walk(id, (k) => { const n = T.N[k]; if (k !== id && n.from && line >= n.from && line <= n.to) target = k; });
  }
  hub.emit('pick.set', { ids: [target], line });
  flyTo(target);
  $('#find-list').hidden = true;
  $('#find-box').blur();
}

function setupFind() {
  const box = $('#find-box');
  box.addEventListener('input', () => hub.emit('find.query', box.value.trim()));
  box.addEventListener('focus', () => { if (state.query) drawFind(); });
  box.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== box) $('#find-list').hidden = true; }, 150));
  box.addEventListener('keydown', (e) => {
    const rows = [...$('#find-list').querySelectorAll('.hit')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      state.findPick = clamp(state.findPick + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1);
      drawFind();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      rows[state.findPick]?.click();
    } else if (e.key === 'Escape') {
      box.value = '';
      hub.emit('find.query', '');
      box.blur();
    }
  });
}

// ───────────────────────────── Panels ─────────────────────────────

function drawDock() {
  const dock = $('#dock');
  const open = state.narrow ? state.sheet === 'check' || state.sheet === 'change' || state.sheet === 'view' : !!state.dock;
  dock.classList.toggle('shut', !open);
  if (!open) { dock.replaceChildren(); return; }
  const which = state.narrow ? state.sheet : state.dock;
  if (which === 'view') {
    dock.replaceChildren(...(state.narrow ? [] : [h('div', { class: 'panel-head' }, h('b', null, 'View'), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost small', 'aria-label': 'Close panel', onclick: () => hub.emit('dock.show', 'check') }, icon('close')))]), viewSheet());
    return;
  }
  const head = h('div', { class: 'panel-head' },
    seg([{ id: 'check', name: 'Check' }, { id: 'change', name: 'Change' }], which, (id) => hub.emit('dock.show', id)),
    h('span', { class: 'spacer' }),
    which === 'check' ? h('button', { class: 'btn ghost small', title: 'Show issues marked as fine', 'aria-pressed': String(state.showWaived), onclick: () => hub.emit('check.waived', !state.showWaived) }, state.showWaived ? 'Hide waived' : 'Show waived') : null,
    which === 'change' && state.agent.log.length ? h('button', { class: 'btn ghost small', title: 'Start a new conversation', onclick: () => hub.emit('agent.reset') }, 'New chat') : null,
    h('button', { class: 'btn ghost small', title: 'Close panel', 'aria-label': 'Close panel', onclick: () => hub.emit('dock.show', null) }, icon('close')));
  if (which === 'check') dock.replaceChildren(head, drawCheck());
  else dock.replaceChildren(head, ...drawChange());
}

function viewSheet() {
  return h('div', { class: 'panel-body view-sheet' },
    h('div', { class: 'section' }, h('h3', null, 'Layout'), seg(LAYOUTS, state.layout, (id) => hub.emit('view.layout', id))),
    h('div', { class: 'section' }, h('h3', null, 'Color'), seg(PAINTS, state.paint, (id) => hub.emit('view.paint', id))),
    h('div', { class: 'section' }, h('h3', null, 'Detail'), seg(DETAILS, state.detail, (id) => hub.emit('view.detail', id))),
    h('div', { class: 'section' }, h('h3', null, 'Links'), seg(LINK_MODES, state.links, (id) => hub.emit('view.links', id))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => fitAll() }, icon('fit'), 'Fit all'), h('button', { class: 'btn', onclick: () => hub.emit('box.open', 'open') }, icon('open'), 'Open folder'), h('button', { class: 'btn', onclick: () => hub.emit('box.open', 'keys') }, icon('help'), 'Help')));
}

function coverage() {
  const T = state.T;
  const marks = state.model.marks;
  let total = 0, done = 0;
  for (const n of T.N) {
    if (n.kind !== 'file' || n.gen) continue;
    total += n.lines;
    if (marks[n.key] === 'ok') { done += n.lines; continue; }
    const ranges = [];
    walk(n.id, (k) => {
      if (k === n.id) return;
      if (marks[T.N[k].key] === 'ok') { ranges.push([T.N[k].from, T.N[k].to]); return false; }
    });
    ranges.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [a, b] of ranges) { if (b > end) { done += b - Math.max(a, end + 1) + 1; end = b; } }
  }
  return { total, done };
}

function drawCheck() {
  const body = h('div', { class: 'panel-body' });
  const m = state.model;
  if (!m) { body.append(h('div', { class: 'empty' }, 'Open a folder to check it.')); return body; }
  const issues = m.issues.filter((i) => state.showWaived || !i.waived);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const i of issues) if (!i.waived) counts[i.level]++;
  body.append(h('div', { class: 'levels' }, LEVELS.map((lv) => h('div', { class: 'level' }, h('b', null, fmt(counts[lv])), h('span', null, h('i', { class: `dot lv-${lv} shape-${lv}` }), LEVEL_NAME[lv])))));
  const cov = coverage();
  const pct = cov.total ? Math.round((cov.done / cov.total) * 100) : 0;
  body.append(h('div', { class: 'section' },
    h('h3', null, 'Review', h('span', { class: 'count' }, `${pct}%`)),
    h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: `${pct}%` } })),
    h('div', { class: 'note' }, `${fmt(cov.done)} of ${fmt(cov.total)} lines marked reviewed. Select something and press R to mark it.`)));
  const byRule = d3.group(issues, (i) => i.rule);
  const rules = m.rules.filter((r) => byRule.has(r.id)).map((r) => {
    const list = byRule.get(r.id);
    const worst = d3.max(list, (i) => LEVEL_RANK[i.level]);
    return { ...r, list, worst };
  }).sort((a, b) => b.worst - a.worst || b.list.length - a.list.length);
  const section = h('div', { class: 'section' }, h('h3', null, 'Findings', h('span', { class: 'count' }, fmt(issues.length))));
  if (!rules.length) section.append(h('div', { class: 'empty' }, 'Nothing found. Nice.'));
  for (const r of rules) {
    const on = state.spot === r.id;
    const lv = LEVELS[3 - r.worst];
    const el = h('div', { class: `rule${on ? ' on' : ''}` },
      h('button', { class: 'rule-row', 'aria-expanded': String(on), onclick: () => hub.emit('check.spot', on ? null : r.id) },
        h('i', { class: `dot lv-${lv} shape-${lv}` }),
        h('span', { class: 'rule-name' }, r.name),
        h('span', { class: 'rule-count' }, fmt(r.list.length)),
        icon('chev', 'i chev')));
    if (on) {
      el.append(h('div', { class: 'rule-about' }, r.about));
      const acts = h('div', { class: 'row', style: { padding: '0 10px 8px 28px' } },
        h('button', { class: 'btn small', onclick: () => fixIssues(r.list.filter((i) => !i.waived), r) }, icon('change'), 'Fix with agent'));
      if (r.id === 'unused') acts.append(h('button', { class: 'btn small danger', onclick: () => hub.emit('stage.delete', { keys: [...new Set(r.list.filter((i) => !i.waived).map((i) => node(i.node).key))] }) }, icon('trash'), 'Remove all'));
      el.append(acts);
      const items = h('div', { class: 'rule-items' });
      const sorted = [...r.list].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || where(a.node).localeCompare(where(b.node)));
      for (const iss of sorted.slice(0, state.expanded === r.id ? 2000 : 60)) {
        const n = node(iss.node);
        items.append(h('div', { class: `item${iss.waived ? ' waived' : ''}`, tabindex: 0, onclick: () => { hub.emit('pick.set', { ids: [iss.node], line: iss.line }); flyTo(iss.node); }, onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); }, onmouseenter: () => hub.emit('pick.hover', { id: iss.node }) },
          h('div', { class: 'what' }, h('i', { class: `dot lv-${iss.level} shape-${iss.level}`, style: { marginRight: '7px' } }), n.kind === 'func' ? `${n.name}()` : n.name),
          h('div', { class: 'where' }, `${where(iss.node).replace(/:\d+$/, '')}:${iss.line}`),
          h('div', { class: 'why' }, iss.note),
          h('div', { class: 'acts' },
            h('button', { class: 'btn tiny ghost', title: 'Fix with agent', 'aria-label': 'Fix with agent', onclick: (e) => { e.stopPropagation(); fixIssues([iss], r); } }, icon('change')),
            h('button', { class: 'btn tiny ghost', title: iss.waived ? 'Restore' : 'Mark as fine', 'aria-label': iss.waived ? 'Restore' : 'Mark as fine', onclick: (e) => { e.stopPropagation(); wire.ask('issue.waive', { rule: iss.rule, key: n.key, on: !iss.waived }); } }, icon(iss.waived ? 'undo' : 'waive')))));
      }
      if (r.list.length > 60 && state.expanded !== r.id) items.append(h('button', { class: 'btn ghost small', onclick: () => { state.expanded = r.id; drawDock(); } }, `Show all ${fmt(r.list.length)}`));
      el.append(items);
    }
    section.append(el);
  }
  body.append(section);
  return body;
}

function fixIssues(list, rule) {
  if (!list.length) return;
  const keys = [...new Set(list.map((i) => node(i.node).key))].slice(0, 40);
  const lines = list.slice(0, 40).map((i) => `- ${where(i.node).replace(/:\d+$/, '')}:${i.line} ${node(i.node).name}: ${i.note}`);
  const prompt = `Fix these "${rule.name}" findings (${rule.about}). Keep behavior the same.\n${lines.join('\n')}`;
  hub.emit('agent.ask', { prompt, focus: keys });
}

const QUICK = [
  { name: 'Explain', prompt: 'Explain what the focused code does, how it fits into the rest of the codebase, and anything surprising. Do not edit.' },
  { name: 'Tidy', prompt: 'Tidy the focused code: clearer names, simpler logic, remove dead code and leftovers. Keep behavior the same.' },
  { name: 'Split', prompt: 'Split the focused code into smaller, well-named parts. Put each part where it belongs. Update all references.' },
  { name: 'Fix findings', prompt: 'Fix the findings listed for the focused code. Keep behavior the same.' },
  { name: 'Add tests', prompt: 'Add focused unit tests for the selected code, following the test style already used in this repo.' },
  { name: 'Document', prompt: 'Add short doc comments to the public parts of the focused code. Plain words, no filler.' },
];

function drawChange() {
  const body = h('div', { class: 'panel-body' });
  const cfg = state.config;
  if (!cfg.hasKey) body.append(h('div', { class: 'notice' }, 'No API key set. The agent needs an endpoint, a model, and a key. ', h('button', { class: 'btn small', onclick: () => hub.emit('box.open', 'setup') }, 'Open settings')));
  const focus = selIds();
  body.append(h('div', { class: 'section' },
    h('h3', null, 'Focus', h('span', { class: 'count' }, focus.length ? fmt(focus.length) : '')),
    focus.length
      ? h('div', { class: 'chips' }, focus.slice(0, 12).map((id) => h('span', { class: 'chip', title: where(id) }, h('span', null, node(id).kind === 'func' ? node(id).name + '()' : node(id).name), h('button', { 'aria-label': `Remove ${node(id).name}`, onclick: () => hub.emit('pick.drop', id) }, '×'))), focus.length > 12 ? h('span', { class: 'chip' }, `+${focus.length - 12}`) : null)
      : h('div', { class: 'note' }, 'Select parts of the map to focus the agent. Without a focus it sees the whole workspace.')));
  body.append(h('div', { class: 'section' }, h('h3', null, 'Quick asks'), h('div', { class: 'quick' }, QUICK.map((q) => h('button', { class: 'btn small', disabled: state.agent.busy, onclick: () => hub.emit('agent.ask', { prompt: q.prompt, focus: state.sel }) }, q.name)))));
  const st = state.stage;
  if (st.items.length || st.undo) {
    const sec = h('div', { class: 'section' }, h('h3', null, 'Staged changes', h('span', { class: 'count' }, fmt(st.items.length))));
    if (st.items.length) {
      sec.append(h('div', { class: 'row', style: { marginBottom: '8px' } },
        h('button', { class: 'btn primary small', onclick: () => hub.emit('stage.apply', {}) }, 'Apply all'),
        h('button', { class: 'btn small', onclick: () => hub.emit('stage.discard', {}) }, 'Discard all'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost small', 'aria-pressed': String(st.preview), title: 'Show the map as it would look after applying', onclick: () => wire.ask('stage.preview', { on: !st.preview }) }, icon('eye'), st.preview ? 'Previewing' : 'Preview')));
      const list = h('div', { class: 'changes' });
      for (const it of st.items) {
        list.append(h('button', { class: 'change', title: it.from ? `Moved from ${it.from}` : it.key, onclick: () => hub.emit('diff.open', it.key) },
          h('span', { class: `badge ${it.state}` }, { add: '+', edit: '~', delete: '−' }[it.state]),
          h('span', { class: 'path' }, h('bdi', null, it.key)),
          h('span', { class: 'nums' }, h('span', { class: 'add-n' }, `+${it.adds}`), ' ', h('span', { class: 'del-n' }, `−${it.dels}`))));
      }
      sec.append(list);
    }
    if (st.undo) sec.append(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn small', onclick: () => hub.emit('stage.undo') }, icon('undo'), 'Undo last apply')));
    body.append(sec);
  }
  const log = h('div', { class: 'log' });
  for (const entry of state.agent.log) log.append(logEntry(entry));
  if (state.agent.busy) log.append(h('div', { class: 'step' }, h('span', { class: 'busy' }, h('i'), h('i'), h('i')), 'Working…'));
  body.append(h('div', { class: 'section' }, h('h3', null, 'Agent'), state.agent.log.length ? log : h('div', { class: 'note' }, 'Ask for a change in plain words. Edits are staged here for review before anything is written.')));
  const box = h('textarea', { id: 'prompt', placeholder: focus.length ? `Ask about or change the ${focus.length} selected part${focus.length > 1 ? 's' : ''}…` : 'Ask about or change the code…', rows: 3, 'aria-label': 'Message to the agent', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } });
  box.value = state.draft ?? '';
  box.addEventListener('input', () => { state.draft = box.value; });
  const send = () => { const text = box.value.trim(); if (!text || state.agent.busy) return; state.draft = ''; hub.emit('agent.ask', { prompt: text, focus: state.sel }); };
  const prompt = h('div', { class: 'prompt' }, box, h('div', { class: 'row end' },
    h('span', { class: 'muted', style: { fontSize: '12px', marginRight: 'auto' } }, cfg.model ? `${cfg.model}` : ''),
    state.agent.busy ? h('button', { class: 'btn small', onclick: () => wire.ask('agent.stop') }, icon('stop'), 'Stop') : h('button', { class: 'btn primary small', onclick: send }, icon('send'), 'Send')));
  setTimeout(() => { body.scrollTop = body.scrollHeight; }, 0);
  return [body, prompt];
}

function logEntry(e) {
  if (e.kind === 'user') return h('div', { class: 'msg user' }, e.text.length > 600 ? e.text.slice(0, 600) + '…' : e.text);
  if (e.kind === 'error') return h('div', { class: 'msg error' }, e.text);
  if (e.kind === 'tool') {
    const write = /write|edit|move|delete/.test(e.name);
    const path = e.args?.path ?? e.args?.from ?? e.args?.pattern ?? e.args?.name ?? e.args?.dir ?? '';
    const verb = { list_files: 'list', read_file: 'read', find_text: 'find', show_outline: 'outline', find_refs: 'refs', write_file: 'write', edit_file: 'edit', move_file: 'move', delete_file: 'delete' }[e.name] ?? e.name;
    return h('div', { class: `step${write ? ' write' : ''}` }, h('span', { class: 'tag' }, verb), h('code', { title: String(path) }, String(path).replace(/^[^/]+\//, '')), h('span', { class: 'muted' }, e.note ?? ''));
  }
  const el = h('div', { class: 'msg agent' });
  renderText(el, e.text);
  e.el = el;
  return el;
}

// Minimal, safe Markdown: paragraphs, bullets, code blocks, inline code, bold.
function renderText(el, text) {
  el.replaceChildren();
  const inline = (s) => {
    const out = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      out.push(s.slice(last, m.index));
      out.push(m[0][0] === '`' ? h('code', null, m[0].slice(1, -1)) : h('b', null, m[0].slice(2, -2)));
      last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return out;
  };
  const blocks = text.split(/```/);
  blocks.forEach((b, i) => {
    if (i % 2) { el.append(h('pre', null, b.replace(/^[\w-]*\n/, ''))); return; }
    for (const para of b.split(/\n{2,}/)) {
      const lines = para.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*(?:[-*]|\d+\.)\s/.test(l))) el.append(h('ul', null, lines.map((l) => h('li', null, inline(l.replace(/^\s*(?:[-*]|\d+\.)\s/, ''))))));
      else el.append(h('p', null, inline(lines.join(' ').replace(/^#+\s*/, ''))));
    }
  });
}

function drawInfo() {
  const info = $('#info');
  const ids = selIds();
  const show = state.narrow ? state.sheet === 'info' : ids.length > 0;
  info.hidden = !show;
  if (!show) return;
  const body = h('div', { class: 'panel-body' });
  if (!ids.length) {
    body.append(h('div', { class: 'empty' }, 'Tap something on the map to see its details.'));
    info.replaceChildren(body);
    return;
  }
  const T = state.T;
  if (ids.length > 1) {
    const lines = d3.sum(ids, (id) => T.N[id].lines);
    body.append(h('div', { class: 'title' }, h('span', { class: 'kind' }, fmt(ids.length)), h('div', null, h('h2', null, `${ids.length} selected`), h('div', { class: 'path' }, plural(lines, 'line')))));
    body.append(h('div', { class: 'section', style: { marginTop: '12px' } }, h('div', { class: 'refs' }, ids.slice(0, 80).map((id) => refRow(id)))));
    body.append(actsFor(ids));
    info.replaceChildren(head('Selection'), body);
    return;
  }
  const id = ids[0];
  const n = T.N[id];
  const f = T.fileOf[id] >= 0 ? T.N[T.fileOf[id]] : null;
  body.append(h('div', { class: 'title' },
    h('span', { class: 'kind' }, n.form && n.form.length <= 9 ? n.form : KIND_NAME[n.kind]),
    h('div', null, h('h2', null, n.kind === 'func' ? `${n.name}()` : n.name), h('div', { class: 'path' }, where(id) + (n.to && n.to !== n.from ? `–${n.to}` : '')))));
  const facts = [['Lines', fmt(n.lines)]];
  if (n.kind === 'func') facts.push(['Branches', n.cx ?? 0], ['Nesting', n.nest ?? 0], ['Parameters', n.args ?? 0]);
  else if (T.cxMax[id]) facts.push(['Most branches', T.cxMax[id]]);
  if (f) facts.push(['Language', state.model.langs.find((l) => l.id === f.lang)?.name ?? f.lang], ['Commits', f.churn ?? 0], ['Changed', ago(f.time)]);
  if (n.kind === 'dir' || n.kind === 'repo') facts.push(['Files', fmt(countFiles(id))]);
  const rv = reviewOf(id);
  facts.push(['Review', rv === 'ok' ? 'Reviewed' : rv === 'stale' ? 'Changed since review' : 'Not reviewed']);
  if (T.count[id]) facts.push(['Issues', fmt(T.count[id])]);
  if (f?.gen) facts.push(['Generated', 'Yes']);
  body.append(h('div', { class: 'facts' }, facts.map(([a, b]) => h('div', { class: 'fact' }, h('span', null, a), h('b', null, String(b))))));
  if (n.head && n.kind !== 'part') body.append(h('div', { class: 'sig' }, n.head));
  if (n.bases?.length) body.append(h('div', { class: 'section' }, h('h3', null, 'Extends'), h('div', { class: 'note' }, n.bases.join(', '))));
  body.append(actsFor([id]));
  const own = [];
  walk(id, (k) => { for (const i of T.issuesOf[k]) own.push(state.model.issues[i]); }, 3000);
  const shown = own.filter((i) => state.showWaived || !i.waived);
  if (shown.length) {
    const rules = new Map(state.model.rules.map((r) => [r.id, r]));
    body.append(h('div', { class: 'section', style: { marginTop: '14px' } }, h('h3', null, 'Findings', h('span', { class: 'count' }, fmt(shown.length))),
      shown.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]).slice(0, 30).map((iss) => h('div', { class: `item${iss.waived ? ' waived' : ''}`, onclick: () => { hub.emit('pick.set', { ids: [iss.node], line: iss.line }); flyTo(iss.node); } },
        h('div', { class: 'what' }, h('i', { class: `dot lv-${iss.level} shape-${iss.level}`, style: { marginRight: '7px' } }), rules.get(iss.rule)?.name ?? iss.rule),
        h('div', { class: 'why' }, `${iss.note} · line ${iss.line}`)))));
  }
  const { uses, users } = refsOf(id);
  if (uses.length) body.append(h('div', { class: 'section' }, h('h3', null, 'Uses', h('span', { class: 'count' }, fmt(uses.length))), h('div', { class: 'refs' }, uses.slice(0, 14).map(([x, w, kinds]) => refRow(x, w, kinds, 'out')))));
  if (users.length) body.append(h('div', { class: 'section' }, h('h3', null, 'Used by', h('span', { class: 'count' }, fmt(users.length))), h('div', { class: 'refs' }, users.slice(0, 14).map(([x, w, kinds]) => refRow(x, w, kinds, 'in')))));
  if (n.kind === 'file' && T.kids[id].length) {
    const rows = [];
    walk(id, (k) => { if (k !== id && rows.length < 120) rows.push(k); });
    rows.sort((a, b) => T.N[a].from - T.N[b].from);
    body.append(h('div', { class: 'section' }, h('h3', null, 'Outline'), h('div', { class: 'refs outline' }, rows.map((k) => h('button', { class: 'ref', style: { '--d': T.symDepth[k] }, onclick: () => { hub.emit('pick.set', { ids: [k] }); flyTo(k); } },
      h('span', { class: 'k' }, T.N[k].form === 'ctor' ? 'new' : T.N[k].form === 'function' ? 'func' : T.N[k].form ?? T.N[k].kind), h('span', { class: 'name' }, T.N[k].name), h('span', { class: 'n' }, T.N[k].from))))));
  }
  if (n.kind === 'dir' || n.kind === 'repo') {
    const files = [];
    walk(id, (k) => { if (T.N[k].kind === 'file') files.push(k); return T.N[k].kind !== 'file'; });
    files.sort((a, b) => T.N[b].lines - T.N[a].lines);
    body.append(h('div', { class: 'section' }, h('h3', null, 'Largest files'), h('div', { class: 'refs' }, files.slice(0, 10).map((k) => refRow(k)))));
  }
  if (n.ext?.length) body.append(h('div', { class: 'section' }, h('h3', null, 'Packages'), h('div', { class: 'note mono' }, n.ext.join('  '))));
  info.replaceChildren(head(KIND_NAME[n.kind]), body);
}

function head(title) {
  return h('div', { class: 'panel-head' }, h('b', { style: { textTransform: 'capitalize' } }, title), h('span', { class: 'spacer' }),
    h('button', { class: 'btn ghost small', 'aria-label': 'Close details', title: 'Close (Esc)', onclick: () => hub.emit('pick.clear') }, icon('close')));
}

function countFiles(id) {
  let n = 0;
  walk(id, (k) => { if (state.T.N[k].kind === 'file') { n++; return false; } });
  return n;
}

function refRow(id, w, kinds, dir) {
  const n = node(id);
  const th = theme();
  return h('button', { class: 'ref', title: where(id), onclick: () => { hub.emit('pick.set', { ids: [id] }); flyTo(id); }, onmouseenter: () => hub.emit('pick.hover', { id }) },
    h('span', { class: 'sw', style: { background: dir ? th.series[dir === 'out' ? 0 : 1] : css(paintOf(id)) } }),
    h('span', { class: 'name' }, n.kind === 'func' ? `${n.name}()` : n.name),
    kinds ? h('span', { class: 'n' }, [...kinds].map((k) => LINK_NAMES[k]).join(', ')) : null,
    h('span', { class: 'n' }, w ? `×${w}` : short(n.lines)));
}

function refsOf(id) {
  const T = state.T, m = state.model;
  const lift = (x) => { const r = Math.max(3, Math.min(RANK[T.N[x].kind], 4)); return liftTo(x, r); };
  const uses = new Map(), users = new Map();
  const add = (map, x, w, kind) => { const e = map.get(x) ?? [x, 0, new Set()]; e[1] += w; e[2].add(kind); map.set(x, e); };
  walk(id, (k) => {
    for (const li of T.out[k]) { const [, t, kk, w] = m.links[li]; if (!isUnder(t, id)) add(uses, lift(t), w, m.linkKinds[kk]); }
    for (const li of T.inn[k]) { const [s, , kk, w] = m.links[li]; if (!isUnder(s, id)) add(users, lift(s), w, m.linkKinds[kk]); }
  }, 5000);
  const sort = (map) => [...map.values()].sort((a, b) => b[1] - a[1]);
  return { uses: sort(uses), users: sort(users) };
}

function actsFor(ids) {
  const T = state.T;
  const n = T.N[ids[0]];
  const one = ids.length === 1;
  const reviewed = ids.every((id) => reviewOf(id) === 'ok');
  const bar = h('div', { class: 'acts-bar' },
    one ? h('button', { class: 'btn small', onclick: () => flyTo(ids[0]) }, icon('zoom'), 'Zoom') : null,
    h('button', { class: 'btn small', title: 'Mark as reviewed (R)', onclick: () => hub.emit('review.mark', { ids, on: !reviewed }) }, icon('review'), reviewed ? 'Unmark' : 'Reviewed'),
    h('button', { class: 'btn small', title: 'Ask the agent about this (E)', onclick: () => { hub.emit('dock.show', 'change'); setTimeout(() => $('#prompt')?.focus(), 30); } }, icon('ask'), 'Ask'),
  );
  if (one && ['type', 'func', 'space'].includes(n.kind)) bar.append(h('button', { class: 'btn small', title: 'Rename everywhere (F2)', onclick: () => askRename(ids[0]) }, icon('rename'), 'Rename'));
  if (one && ['file', 'dir'].includes(n.kind)) bar.append(h('button', { class: 'btn small', title: 'Move: drag the grip on the map, or pick a folder', onclick: () => askMovePick(ids[0]) }, icon('move'), 'Move'));
  if (ids.every((id) => T.N[id].kind !== 'repo')) bar.append(h('button', { class: 'btn small danger', title: 'Stage a delete (Del)', onclick: () => askDelete(ids) }, icon('trash'), 'Delete'));
  const f = one && T.fileOf[ids[0]] >= 0 ? T.N[T.fileOf[ids[0]]] : null;
  const repo = f ? state.model.nodes.find((x) => x.kind === 'repo' && f.key.startsWith(x.key + '/')) : null;
  if (f && repo?.root) bar.append(h('a', { class: 'btn small ghost', href: `vscode://file${repo.root}/${f.path}:${n.from ?? state.selLine ?? 1}`, title: 'Open in VS Code' }, icon('edit'), 'Editor'));
  return bar;
}

// ───────────────────────────── Reshape prompts ─────────────────────────────

function pop(x, y, ...kids) {
  const el = $('#ask');
  el.replaceChildren(...kids);
  el.hidden = false;
  const w = 300;
  el.style.left = `${clamp(x - w / 2, 8, window.innerWidth - w - 8)}px`;
  el.style.top = `${clamp(y + 12, 60, window.innerHeight - el.offsetHeight - 70)}px`;
  el.querySelector('input,button')?.focus();
}
const unpop = () => { $('#ask').hidden = true; };

function anchorPoint(id) {
  const r = rectsOf(id)[0];
  if (!r) return [window.innerWidth / 2, window.innerHeight / 3];
  const [sx, sy] = toScreen(r.x, r.y);
  return [clamp(sx + (r.w * state.t.k) / 2, 20, window.innerWidth - 20), clamp(sy + 20, 70, window.innerHeight - 200)];
}

function askMove(id, target, x, y) {
  const n = node(id), t = node(target);
  pop(x, y,
    h('p', null, 'Move ', h('b', null, n.name), ' into ', h('b', null, `${t.path || t.name}/`), '?'),
    h('div', { class: 'note' }, 'The move is staged. Ask the agent to fix imports and references too.'),
    h('div', { class: 'row end' },
      h('button', { class: 'btn small ghost', onclick: unpop }, 'Cancel'),
      h('button', { class: 'btn small', onclick: () => { unpop(); hub.emit('stage.move', { key: n.key, to: t.key }); } }, 'Move only'),
      h('button', { class: 'btn small primary', onclick: async () => {
        unpop();
        await wire.ask('stage.move', { key: n.key, to: t.key });
        hub.emit('agent.ask', { prompt: `I moved ${n.key} into ${t.key}/ (staged). Update every import and reference so the code still works.`, focus: [t.key] });
      } }, 'Move + fix')));
}

function askMovePick(id) {
  const n = node(id);
  const dirs = state.T.N.filter((x) => (x.kind === 'dir' || x.kind === 'repo') && !isUnder(x.id, id) && x.id !== n.up);
  const input = h('input', { type: 'text', placeholder: 'Folder path', list: 'move-dirs', value: '' });
  const [x, y] = anchorPoint(id);
  pop(x, y,
    h('p', null, 'Move ', h('b', null, n.name), ' to folder:'),
    input,
    h('datalist', { id: 'move-dirs' }, dirs.slice(0, 500).map((d) => h('option', { value: d.key }))),
    h('div', { class: 'note' }, 'Tip: drag the blue grip on the map onto a folder.'),
    h('div', { class: 'row end' },
      h('button', { class: 'btn small ghost', onclick: unpop }, 'Cancel'),
      h('button', { class: 'btn small primary', onclick: () => { const t = idOf(input.value.trim()); if (t < 0) { toast('Pick a folder from the list.', 'error'); return; } unpop(); askMove(id, t, x, y); } }, 'Next')));
}

function askRename(id) {
  const n = node(id);
  const input = h('input', { type: 'text', value: n.name.split('::').pop(), 'aria-label': 'New name' });
  const go = () => { const name = input.value.trim(); if (!name || name === n.name) return unpop(); unpop(); hub.emit('stage.rename', { key: n.key, name }); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') unpop(); });
  const [x, y] = anchorPoint(id);
  pop(x, y, h('p', null, 'Rename ', h('b', null, n.name), ' everywhere'), input, h('div', { class: 'note' }, 'Whole-word rename in code (not in strings or comments). Staged for review.'),
    h('div', { class: 'row end' }, h('button', { class: 'btn small ghost', onclick: unpop }, 'Cancel'), h('button', { class: 'btn small primary', onclick: go }, 'Rename')));
  setTimeout(() => input.select(), 10);
}

function askDelete(ids) {
  const names = ids.slice(0, 3).map((id) => node(id).name).join(', ') + (ids.length > 3 ? ` +${ids.length - 3}` : '');
  const [x, y] = anchorPoint(ids[0]);
  pop(x, y, h('p', null, 'Delete ', h('b', null, names), '?'), h('div', { class: 'note' }, 'Staged for review. Nothing is removed until you apply.'),
    h('div', { class: 'row end' }, h('button', { class: 'btn small ghost', onclick: unpop }, 'Cancel'), h('button', { class: 'btn small primary', onclick: () => { unpop(); hub.emit('stage.delete', { keys: ids.map((id) => node(id).key) }); } }, 'Stage delete')));
}

// ───────────────────────────── Diff ─────────────────────────────

async function drawDiff(key) {
  const el = $('#diff');
  const data = await wire.ask('stage.diff', { key });
  if (!data || data.error || !data.hunks) { el.hidden = true; return; }
  const items = state.stage.items;
  const at = items.findIndex((it) => it.key === key);
  const go = (d) => { const next = items[(at + d + items.length) % items.length]; if (next) hub.emit('diff.open', next.key); };
  const item = items[at];
  const rows = [];
  data.hunks.forEach((hk, i) => {
    rows.push(h('tr', { class: 'gap' }, h('td', { colspan: 4 }, i ? '⋯' : `@@ line ${hk.a || hk.b}`)));
    for (const [t, a, b, text] of hk.lines) {
      const tk = tokenize(text ?? '', data.lang);
      const code = h('td', null, (tk.spans[0] ?? []).length ? spansToNodes(tk.lines[0], tk.spans[0]) : text);
      rows.push(h('tr', { class: t === '+' ? 'add' : t === '-' ? 'del' : '' }, h('td', { class: 'no' }, a ?? ''), h('td', { class: 'no' }, b ?? ''), h('td', { class: 'sign' }, t === ' ' ? '' : t === '-' ? '−' : '+'), code));
    }
  });
  el.replaceChildren(
    h('div', { class: 'diff-head' },
      h('span', { class: `badge ${data.state}` }, { add: '+', edit: '~', delete: '−' }[data.state]),
      h('span', { class: 'path', title: key }, key, data.from ? h('span', { class: 'muted' }, `  ← ${data.from}`) : null),
      item ? h('span', { class: 'mono' }, h('span', { class: 'add-n' }, `+${item.adds}`), ' ', h('span', { class: 'del-n' }, `−${item.dels}`)) : null,
      items.length > 1 ? h('span', { class: 'row' }, h('button', { class: 'btn small ghost', onclick: () => go(-1), 'aria-label': 'Previous file' }, '‹'), h('span', { class: 'muted' }, `${at + 1} / ${items.length}`), h('button', { class: 'btn small ghost', onclick: () => go(1), 'aria-label': 'Next file' }, '›')) : null,
      h('button', { class: 'btn small', onclick: () => { hub.emit('stage.discard', { keys: [key] }); go(1); } }, 'Discard'),
      h('button', { class: 'btn small primary', onclick: () => { hub.emit('stage.apply', { keys: [key] }); } }, 'Apply'),
      h('button', { class: 'btn small ghost', 'aria-label': 'Close diff', onclick: () => hub.emit('diff.close') }, icon('close'))),
    h('div', { class: 'diff-body' }, rows.length ? h('table', null, rows) : h('div', { class: 'empty' }, data.state === 'delete' ? 'File is deleted.' : 'No line changes (moved only).')));
  el.hidden = false;
}

function spansToNodes(line, spans) {
  const cls = ['', 'tk-kw', 'tk-str', 'tk-num', 'tk-com', 'tk-type', 'tk-fn', ''];
  const out = [];
  let at = 0;
  for (let s = 0; s < spans.length; s += 3) {
    const start = spans[s], len = spans[s + 1];
    if (start > at) out.push(line.slice(at, start));
    const c = cls[spans[s + 2]];
    out.push(c ? h('span', { class: c }, line.substr(start, len)) : line.substr(start, len));
    at = start + len;
  }
  out.push(line.slice(at));
  return out;
}

// ───────────────────────────── Dialogs ─────────────────────────────

async function drawOpenBox(dir) {
  const box = $('#open-box');
  const listing = await wire.ask('dir.list', { path: dir ?? state.openDir ?? state.config.recent?.[0] ?? '' });
  if (listing.error) { toast(listing.error, 'error'); }
  const data = listing.error ? { path: dir ?? '', items: [], up: null } : listing;
  state.openDir = data.path;
  const input = h('input', { type: 'text', value: data.path, 'aria-label': 'Folder path', spellcheck: false });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); drawOpenBox(input.value.trim()); } });
  const open = async (p) => {
    box.close();
    toast(`Opening ${p}…`);
    const res = await wire.ask('repo.open', { path: p });
    if (res?.error) hub.emit('box.open', 'open');
  };
  const repos = state.config.repos ?? [];
  const welcome = !repos.length;
  box.replaceChildren(
    h('div', { class: 'box-head' }, welcome
      ? h('div', { class: 'welcome' }, h('h1', null, 'devibe'), h('p', null, 'See how a codebase is built, check it for problems, and reshape it with an agent. Open a folder to begin.'))
      : h('div', null, h('h2', null, 'Open a folder'), h('p', null, 'Add a local repo to the workspace. You can open several.'))),
    h('div', { class: 'box-body' },
      h('div', { class: 'field' }, h('div', { class: 'path-row' }, data.up ? h('button', { class: 'btn', title: 'Up one folder', 'aria-label': 'Up one folder', onclick: () => drawOpenBox(data.up) }, icon('up')) : null, input, h('button', { class: 'btn', onclick: () => drawOpenBox(input.value.trim()) }, 'Go'))),
      h('div', { class: 'dirs' }, data.items.length ? data.items.map((d) => h('button', { class: 'dir', ondblclick: () => open(d.path), onclick: () => drawOpenBox(d.path) }, icon('open'), d.name, d.repo ? h('span', { class: 'tag' }, 'git') : null)) : h('div', { class: 'empty' }, 'No folders here.')),
      repos.length ? h('div', { class: 'section', style: { marginTop: '14px' } }, h('h3', null, 'Open now'), repos.map((r) => h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '3px 0' } }, h('span', { class: 'mono', title: r.root }, r.name), h('button', { class: 'btn tiny', onclick: async () => { await wire.ask('repo.shut', { name: r.name }); drawOpenBox(data.path); } }, 'Close')))) : null,
      (state.config.recent ?? []).filter((r) => !repos.some((x) => x.root === r)).length ? h('div', { class: 'section', style: { marginTop: '14px' } }, h('h3', null, 'Recent'), state.config.recent.filter((r) => !repos.some((x) => x.root === r)).slice(0, 6).map((r) => h('button', { class: 'dir', onclick: () => open(r) }, icon('open'), h('span', { class: 'mono' }, r)))) : null),
    h('div', { class: 'box-foot' },
      welcome ? h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: () => { box.close(); wire.ask('repo.demo'); } }, 'Try the demo') : null,
      h('button', { class: 'btn ghost', onclick: () => box.close() }, welcome ? 'Later' : 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => open(input.value.trim()) }, data.repo ? 'Open this repo' : 'Open this folder')));
  if (!box.open) box.showModal();
}

function drawSetupBox() {
  const box = $('#setup-box');
  const c = state.config;
  const f = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label, input), hint ? h('div', { class: 'hint' }, hint) : null);
  const endpoint = h('input', { type: 'url', value: c.endpoint ?? '', placeholder: 'https://openrouter.ai/api/v1' });
  const model = h('input', { type: 'text', value: c.model ?? '', placeholder: 'deepseek/deepseek-v4.1-flash', spellcheck: false });
  const key = h('input', { type: 'password', value: '', placeholder: c.hasKey ? 'Saved. Type to replace.' : 'sk-…', autocomplete: 'off' });
  const turns = h('input', { type: 'number', value: c.maxTurns ?? 40, min: 1, max: 200 });
  const style = h('textarea', { rows: 5, placeholder: 'How you like code shaped. Example: Small files. One class per file. Guard clauses over nesting. No abbreviations.' });
  style.value = c.style ?? '';
  const result = h('div', { class: 'note' });
  const themeSeg = seg([{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }, { id: 'system', name: 'System' }], state.theme, (id) => { hub.emit('view.theme', id); drawSetupBox(); });
  themeSeg.style.background = 'var(--raise)';
  themeSeg.style.borderRadius = '9px';
  const patch = () => ({ endpoint: endpoint.value.trim(), model: model.value.trim(), style: style.value, maxTurns: +turns.value || 40, ...(key.value ? { apiKey: key.value.trim() } : {}) });
  box.replaceChildren(
    h('div', { class: 'box-head' }, h('h2', null, 'Settings'), h('p', null, 'The agent talks to any OpenAI-compatible endpoint.')),
    h('div', { class: 'box-body' },
      f('Endpoint', endpoint, 'Example: https://openrouter.ai/api/v1'),
      f('Model', model, 'Example: deepseek/deepseek-v4.1-flash. Use a model that supports tool calls.'),
      f('API key', key, 'Stored in ~/.devibe/config.json on this machine. DEVIBE_API_KEY overrides it.'),
      f('Max steps', turns, 'Upper limit on agent turns per request.'),
      f('Style guide', style, 'Sent with every request. The agent follows it when it edits.'),
      h('div', { class: 'field' }, h('label', null, 'Theme'), themeSeg),
      result),
    h('div', { class: 'box-foot' },
      h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: async () => { await wire.ask('config.set', patch()); result.textContent = 'Testing…'; const r = await wire.ask('agent.test'); result.textContent = r.ok ? `Connected. Model replied: ${r.text}` : `Failed: ${r.text}`; result.style.color = r.ok ? STATUS.good : STATUS.critical; } }, 'Test'),
      h('button', { class: 'btn ghost', onclick: () => box.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => { await wire.ask('config.set', patch()); box.close(); toast('Settings saved.'); } }, 'Save')));
  if (!box.open) box.showModal();
}

const KEYS = [
  ['/', 'Find files, types, functions, or text'],
  ['1 2 3 4', 'Map, Graph, Layers, City'],
  ['C', 'Next color (Shift+C: previous)'],
  ['D', 'Next detail level'],
  ['L', 'Links: off, focus, all'],
  ['F', 'Fit everything in view'],
  ['Enter', 'Zoom to the selection'],
  ['U', 'Select the parent'],
  ['Esc', 'Clear find, then selection, then zoom out'],
  ['R', 'Mark selection reviewed'],
  ['E', 'Ask the agent about the selection'],
  ['F2', 'Rename the selected type or function'],
  ['M', 'Move the selected file or folder'],
  ['Delete', 'Stage a delete of the selection'],
  ['O', 'Open a folder'],
  ['?', 'This help'],
];

function drawKeysBox() {
  const box = $('#keys-box');
  box.replaceChildren(
    h('div', { class: 'box-head' }, h('h2', null, 'Keys and mouse')),
    h('div', { class: 'box-body' },
      h('div', { class: 'keys' }, KEYS.flatMap(([k, d]) => [h('kbd', null, k), h('span', null, d)])),
      h('div', { class: 'section', style: { marginTop: '16px' } }, h('h3', null, 'Mouse and touch'),
        h('div', { class: 'keys' },
          h('kbd', null, 'Scroll / pinch'), h('span', null, 'Zoom. Keep zooming into a file to read its code.'),
          h('kbd', null, 'Drag'), h('span', null, 'Pan'),
          h('kbd', null, 'Click / tap'), h('span', null, 'Select. Shift or Ctrl adds. Long-press adds on touch.'),
          h('kbd', null, 'Double-click'), h('span', null, 'Zoom to it'),
          h('kbd', null, 'Shift + drag'), h('span', null, 'Box select'),
          h('kbd', null, 'Drag grip'), h('span', null, 'Move a selected file or folder into another folder'))),
      h('div', { class: 'section' }, h('h3', null, 'Layouts'), LAYOUTS.map((l) => h('div', { class: 'note' }, h('b', null, l.name), ' — ', l.about)))),
    h('div', { class: 'box-foot' }, h('button', { class: 'btn primary', onclick: () => box.close() }, 'Done')));
  if (!box.open) box.showModal();
}

// ───────────────────────────── Foot ─────────────────────────────

function drawFoot() {
  const legend = $('#legend');
  const th = theme();
  const keys = [];
  const key = (color, label, shape) => h('span', { class: 'key' }, h('i', { class: `sw${shape ? ' ' + shape : ''}`, style: { background: color } }), label);
  const paint = PAINTS.find((p) => p.id === state.paint);
  if (state.model) {
    keys.push(h('span', { class: 'title' }, paint.name));
    if (state.paint === 'lang') {
      const total = d3.sum(state.model.langs, (l) => l.lines) || 1;
      const langs = state.model.langs.filter((l) => state.slots.has(l.id)).slice(0, 7);
      for (const l of langs) keys.push(key(th.series[state.slots.get(l.id)], `${l.name} ${Math.round((l.lines / total) * 100)}%`));
      if (state.model.langs.length > langs.length) keys.push(key(th.other, 'Other'));
    } else if (paint.unit) {
      const T = state.T;
      const max = { lines: T.scales.lines, cx: T.scales.cx, churn: T.scales.churn, age: T.scales.age }[state.paint];
      const lo = state.paint === 'age' ? `${Math.round(max)}+ days` : '0';
      const hi = state.paint === 'age' ? 'today' : `${short(Math.round(max))}+ ${paint.unit}`;
      keys.push(h('span', null, lo), h('i', { class: 'ramp', style: { background: `linear-gradient(90deg, ${th.ramp.join(',')})` } }), h('span', null, hi));
    } else if (state.paint === 'issues') {
      keys.push(key(STATUS.critical, 'High'), key(STATUS.serious, 'Medium'), key(STATUS.warn, 'Low'), key(th.neutral, 'None'));
    } else if (state.paint === 'review') {
      keys.push(key(STATUS.good, 'Reviewed'), key(STATUS.warn, 'Changed since'), key(th.neutral, 'Not yet'));
    } else if (state.paint === 'stage') {
      keys.push(key(STATUS.good, 'Staged new'), key(th.accent, 'Staged edit'), key(STATUS.critical, 'Staged delete'), key(css(mix(rgb(th.neutral), rgb(STATUS.warn), 0.55)), 'Uncommitted'));
    }
    if (state.links !== 'none' && state.linkList?.length) {
      keys.push(h('span', { class: 'title', style: { marginLeft: '8px' } }, 'Links'));
      if (state.links === 'focus') keys.push(key(th.series[0], 'uses'), key(th.series[1], 'used by'));
      else for (const kind of ['import', 'call', 'use', 'base']) keys.push(key(th.series[LINK_COLOR[kind]], LINK_NAMES[kind]));
    }
  }
  legend.replaceChildren(...keys);
  const status = $('#status');
  const s = state.model?.stats;
  const parts = [];
  if (state.scan && state.scan.done < state.scan.total) parts.push(h('span', null, `Scanning ${state.scan.repo}`), h('span', { class: 'bar' }, h('i', { style: { width: `${(state.scan.done / state.scan.total) * 100}%` } })));
  if (s) parts.push(h('span', null, `${short(s.files)} files · ${short(s.lines)} lines · ${short(s.symbols)} parts · ${short(s.links)} links`));
  if (state.model?.preview) parts.push(h('span', { style: { color: STATUS.warn } }, 'Preview'));
  parts.push(h('span', { class: `live${state.live ? '' : ' off'}`, title: state.live ? 'Connected' : 'Disconnected' }));
  status.replaceChildren(...parts);
}

// ───────────────────────────── Toasts ─────────────────────────────

function toast(text, level = 'info') {
  const el = h('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status' }, level === 'error' ? h('i', { class: 'dot lv-high' }) : level === 'good' ? h('i', { class: 'dot', style: { background: STATUS.good } }) : null, text);
  if (/^Opening /.test(text)) el.dataset.opening = '1';
  $('#toasts').append(el);
  setTimeout(() => el.remove(), level === 'error' ? 6000 : 3200);
}

// ───────────────────────────── Theme ─────────────────────────────

function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = state.theme;
  const dark = state.theme === 'dark' || (state.theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  root.dataset.resolved = dark ? 'dark' : 'light';
}

// ───────────────────────────── Messages ─────────────────────────────

function savePrefs() {
  for (const k of ['layout', 'paint', 'links', 'detail', 'theme', 'dock']) store.save(k, state[k]);
}

function refresh() {
  colorItems();
  buildLinks();
  drawInfo();
  drawFoot();
  requestDraw();
}

hub.on('link.up', () => { state.live = true; drawFoot(); wire.ask('hello'); });
hub.on('link.down', () => { state.live = false; drawFoot(); });

hub.on('hello', (d) => {
  state.config = d.config ?? {};
  state.stage = d.stage ?? state.stage;
  state.stageIndex = new Map(state.stage.items.map((it) => [it.key, it.state]));
  state.agent.busy = !!d.busy;
  if (d.model) hub.emit('repo.model', d.model);
  else if (!state.model) hub.emit('box.open', 'open');
  drawDock();
});

hub.on('repo.model', (m) => {
  for (const el of document.querySelectorAll('.toast[data-opening]')) el.remove();
  const first = !state.model;
  const sameShape = state.model && state.model.nodes.length === m.nodes.length;
  state.model = m;
  state.T = prep(m);
  state.mapLay = null;
  for (const [key, t] of [...state.texts]) if (!state.T.byKey.has(key)) state.texts.delete(key);
  state.texts.clear();
  state.wanted.clear();
  state.sel = state.sel.filter((k) => state.T.byKey.has(k));
  if (state.hover >= m.nodes.length) state.hover = -1;
  relayout({ animate: !first, fit: first });
  if (!first && !sameShape) drawCrumbs();
  drawCrumbs();
  drawDock();
  drawInfo();
  drawFoot();
  if (state.query) { state.matches = new Set(findNodes(state.query)); drawFind(); }
  $('#open-box').open && state.config.repos?.length && $('#open-box').close();
});

hub.on('scan.step', (d) => { state.scan = d; drawFoot(); });
hub.on('config.state', (d) => { state.config = d; drawDock(); if ($('#open-box').open) drawOpenBox(state.openDir); });
hub.on('file.text', ({ key, text }) => {
  state.wanted.delete(key);
  if (text == null) return;
  const id = idOf(key);
  state.texts.set(key, tokenize(text, id >= 0 ? node(id).lang : 'text'));
  if (state.texts.size > 400) state.texts.delete(state.texts.keys().next().value);
  requestDraw();
});
hub.on('find.hits', (d) => { state.findHits = d; drawFind(); });
hub.on('note', (d) => toast(d.text, d.level));

hub.on('stage.state', (d) => {
  state.stage = d;
  state.stageIndex = new Map(d.items.map((it) => [it.key, it.state]));
  if (state.paint === 'stage') colorItems();
  if (!$('#diff').hidden && state.diffKey && !d.items.some((it) => it.key === state.diffKey)) hub.emit('diff.close');
  drawDock();
  drawFoot();
  requestDraw();
});

hub.on('agent.step', (d) => {
  const log = state.agent.log;
  if (d.kind === 'start') { state.agent.busy = true; log.push({ kind: 'user', text: d.text }); }
  else if (d.kind === 'text') {
    const last = log.at(-1);
    if (last?.kind === 'text') { last.text += d.text; if (last.el?.isConnected) { renderText(last.el, last.text); return; } }
    else log.push({ kind: 'text', text: d.text });
  } else if (d.kind === 'tool') {
    log.push(d);
    const key = d.args?.path ?? d.args?.to;
    const id = key ? idOf(String(key).split('#')[0]) : -1;
    if (id >= 0) { state.flash.set(id, performance.now() + 1200); requestDraw(); }
  }
  if (state.dock === 'change' || state.sheet === 'change') drawDock();
});

hub.on('agent.done', (d) => {
  state.agent.busy = false;
  const log = state.agent.log;
  if (d.error) log.push({ kind: 'error', text: d.error });
  else if (d.text && log.at(-1)?.kind !== 'text') log.push({ kind: 'text', text: d.text });
  else if (d.text && log.at(-1)?.kind === 'text') log.at(-1).text = d.text;
  drawDock();
});

hub.on('agent.ask', ({ prompt, focus }) => {
  if (state.agent.busy) { toast('The agent is still working.', 'error'); return; }
  if (state.narrow) state.sheet = 'change'; else state.dock = 'change';
  savePrefs();
  wire.ask('agent.run', { prompt, focus: (focus ?? []).filter((k) => typeof k === 'string') });
  drawBar();
  drawDock();
});
hub.on('agent.reset', () => { state.agent.log = []; wire.ask('agent.reset'); drawDock(); });

hub.on('view.layout', (id) => {
  if (!LAYOUTS.some((l) => l.id === id) || id === state.layout) return;
  state.layout = id;
  savePrefs();
  drawBar();
  relayout({ animate: true, fit: true });
  drawFoot();
  if ((id === 'graph' || id === 'layers') && state.lay?.rect.size > 900 && state.detail !== 'dir') toast(`${fmt(state.lay.rect.size)} parts shown. Set Detail to Folders (press D) for a clearer picture.`);
});
hub.on('view.paint', (id) => {
  state.paint = id;
  savePrefs();
  drawBar();
  if (state.layout === 'city') relayout({ animate: false }); else colorItems();
  drawFoot();
  requestDraw();
});
hub.on('view.detail', (id) => {
  state.detail = id;
  savePrefs();
  drawBar();
  if (state.layout === 'graph' || state.layout === 'layers') relayout({ animate: true, fit: true });
  else { buildLinks(); requestDraw(); }
  drawFoot();
});
hub.on('view.links', (id) => { state.links = id; savePrefs(); drawBar(); buildLinks(); drawFoot(); requestDraw(); });
hub.on('view.theme', (id) => { state.theme = id; savePrefs(); applyTheme(); refresh(); drawBar(); });

hub.on('pick.hover', ({ id, line = 0 }) => {
  state.hover = id;
  state.hoverLine = line;
  if (state.links === 'focus') buildLinks();
  requestDraw();
});
hub.on('pick.set', ({ ids, add = false, line }) => {
  const keys = ids.map((id) => node(id)?.key).filter((k) => k != null);
  if (add) {
    const set = new Set(state.sel);
    for (const k of keys) { if (set.has(k)) set.delete(k); else set.add(k); }
    state.sel = [...set];
  } else state.sel = keys;
  state.selLine = line;
  if (state.narrow && state.sel.length && !state.sheet) { state.sheet = 'info'; document.body.classList.add('sheet-open'); }
  buildLinks();
  drawInfo();
  drawCrumbs();
  if (state.dock === 'change' || state.sheet === 'change') drawDock();
  if (state.narrow) { drawBar(); drawDock(); }
  requestDraw();
});
hub.on('pick.drop', (id) => { state.sel = state.sel.filter((k) => k !== node(id)?.key); hub.emit('pick.set', { ids: selIds() }); });
hub.on('pick.clear', () => {
  if (!state.sel.length) return;
  state.sel = [];
  if (state.narrow && state.sheet === 'info') { state.sheet = null; document.body.classList.remove('sheet-open'); }
  buildLinks();
  drawInfo();
  drawCrumbs();
  drawBar();
  drawDock();
  requestDraw();
});

hub.on('find.query', (q) => {
  state.query = q;
  state.findPick = 0;
  state.matches = q ? new Set(findNodes(q).slice(0, 400)) : null;
  if (q && state.findHits?.query !== q) state.findHits = null;
  colorItems();
  drawFind();
  requestDraw();
});
hub.on('find.text', (q) => wire.ask('text.find', { query: q }));

hub.on('check.spot', (rule) => {
  state.spot = rule;
  state.expanded = null;
  colorItems();
  drawDock();
  requestDraw();
});
hub.on('check.waived', (on) => { state.showWaived = on; colorItems(); drawDock(); drawInfo(); requestDraw(); });

hub.on('dock.show', (id) => {
  if (state.narrow) state.sheet = id; else state.dock = id;
  savePrefs();
  drawBar();
  drawDock();
});
hub.on('sheet.toggle', (id) => {
  state.sheet = state.sheet === id ? null : id;
  document.body.classList.toggle('sheet-open', !!state.sheet);
  drawBar();
  drawDock();
  drawInfo();
  const ids = selIds();
  if (ids.length) flyTo(ids[0], 450); else fitAll(450);
});

hub.on('box.open', (which) => {
  if (which === 'open') drawOpenBox();
  else if (which === 'setup') drawSetupBox();
  else if (which === 'keys') drawKeysBox();
});

hub.on('diff.open', (key) => { state.diffKey = key; drawDiff(key); });
hub.on('diff.close', () => { state.diffKey = null; $('#diff').hidden = true; });

hub.on('review.mark', ({ ids, on }) => wire.ask('review.mark', { keys: ids.map((id) => node(id).key), on }));
hub.on('stage.apply', (d) => wire.ask('stage.apply', d));
hub.on('stage.discard', (d) => wire.ask('stage.discard', d));
hub.on('stage.undo', () => wire.ask('stage.undo'));
hub.on('stage.move', (d) => wire.ask('stage.move', d));
hub.on('stage.rename', (d) => wire.ask('stage.rename', d));
hub.on('stage.delete', (d) => wire.ask('stage.delete', d));

// ───────────────────────────── Keys ─────────────────────────────

function setupKeys() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); $('#find-box').focus(); $('#find-box').select(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    const ids = selIds();
    const k = e.key;
    const cycle = (list, cur, d) => list[(list.findIndex((x) => x.id === cur) + d + list.length) % list.length].id;
    if (k >= '1' && k <= '4') hub.emit('view.layout', LAYOUTS[+k - 1].id);
    else if (k === 'c' || k === 'C') hub.emit('view.paint', cycle(PAINTS, state.paint, e.shiftKey ? -1 : 1));
    else if (k === 'd' || k === 'D') hub.emit('view.detail', cycle(DETAILS, state.detail, e.shiftKey ? -1 : 1));
    else if (k === 'l' || k === 'L') hub.emit('view.links', cycle(LINK_MODES, state.links, 1));
    else if (k === 'f' || k === 'F' || k === '0') fitAll();
    else if (k === 'Enter' && ids.length) flyTo(ids[0]);
    else if ((k === 'u' || k === 'U' || k === 'Backspace') && ids.length) { const up = node(ids[0]).up; if (up > 0) { hub.emit('pick.set', { ids: [up] }); flyTo(up); } }
    else if (k === 'r' || k === 'R') { if (ids.length) hub.emit('review.mark', { ids, on: !ids.every((id) => reviewOf(id) === 'ok') }); }
    else if (k === 'e' || k === 'E') { hub.emit('dock.show', 'change'); setTimeout(() => $('#prompt')?.focus(), 30); }
    else if (k === 'F2' && ids.length === 1) askRename(ids[0]);
    else if ((k === 'm' || k === 'M') && ids.length === 1) askMovePick(ids[0]);
    else if ((k === 'Delete') && ids.length) askDelete(ids);
    else if (k === 'o' || k === 'O') hub.emit('box.open', 'open');
    else if (k === '?') hub.emit('box.open', 'keys');
    else if (k === '+' || k === '=') d3.select('#view').transition().duration(200).call(zoom.scaleBy, 1.5);
    else if (k === '-') d3.select('#view').transition().duration(200).call(zoom.scaleBy, 1 / 1.5);
    else if (k.startsWith('Arrow')) {
      const step = 120;
      const [dx, dy] = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[k];
      d3.select('#view').transition().duration(150).call(zoom.translateBy, dx / state.t.k, dy / state.t.k);
    } else if (k === 'Escape') {
      if (!$('#ask').hidden) unpop();
      else if (!$('#diff').hidden) hub.emit('diff.close');
      else if (state.query) { $('#find-box').value = ''; hub.emit('find.query', ''); }
      else if (state.spot) hub.emit('check.spot', null);
      else if (ids.length) hub.emit('pick.clear');
      else fitAll();
    } else return;
    e.preventDefault();
  });
}

// ───────────────────────────── Boot ─────────────────────────────

function resize() {
  state.narrow = matchMedia('(max-width: 760px)').matches;
  document.body.classList.toggle('narrow', state.narrow);
  sizeGL();
  const map = state.mapLay;
  if (map) {
    const v = viewport();
    const aspect = clamp(v.w / v.h, 0.55, 2.2);
    if (Math.abs(Math.log(aspect / map.aspect)) > 0.3) {
      state.mapLay = null;
      clearTimeout(resize.timer);
      resize.timer = setTimeout(() => relayout({ animate: true, fit: true }), 250);
    }
  }
  setZoomRange();
  drawBar();
  drawDock();
  drawInfo();
  requestDraw();
}

function idle() {
  return new Promise((resolve) => {
    const check = () => {
      const view = document.querySelector('#view');
      const moving = view.__transition && Object.keys(view.__transition).length > 0;
      const busy = R.morph || frameAsked || state.pending > 0 || state.wanted.size > 0 || moving;
      if (busy) setTimeout(check, 50);
      else requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    };
    setTimeout(check, 30);
  });
}

function boot() {
  applyTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (state.theme === 'system') { applyTheme(); refresh(); } });
  measureMono();
  setupGL();
  setupZoom();
  setupPointer();
  setupFind();
  setupKeys();
  resize();
  window.addEventListener('resize', () => { resize(); });
  $('#brand').addEventListener('click', () => hub.emit('box.open', 'open'));
  document.addEventListener('pointerdown', (e) => { if (!$('#ask').hidden && !$('#ask').contains(e.target)) unpop(); }, true);
  for (const box of document.querySelectorAll('dialog')) box.addEventListener('click', (e) => { if (e.target === box) box.close(); });
  document.fonts?.ready.then(() => { measureMono(); widths.clear(); requestDraw(); });
  drawFoot();
  wire.open();
}

// Hooks for tests and the console.
function centerOf(key) {
  const id = idOf(key);
  const r = rectsOf(id)[0] ?? (state.lay?.kind === 'city' ? state.lay.items.find((it) => it.id === id) : null);
  if (!r) return null;
  if (state.lay.kind === 'city') return toScreen(r.x + r.w / 2, r.y + r.h / 2, r.z + r.h3);
  return toScreen(r.x + r.w / 2, r.y + Math.min(r.h / 2, (r.head ?? r.h) / 2 + 1));
}
window.devibe = { state, hub, wire, idle, flyTo, fitAll, pickAt, toScreen, centerOf, grip: gripRect, R };
boot();
