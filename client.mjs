// devibe client — one hardware-accelerated view (three.js + d3) with panels
// around it. Everything flows through messages: server messages and UI actions
// both go through the same hub.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import * as S from './sets.mjs';
import { makeCity } from './city.mjs';

const d3 = window.d3;

// ───────────────────────────── Vocabulary ─────────────────────────────

const LAYOUTS = [
  { id: 'map', name: 'Map', key: '1', about: 'Folders, files, and code, nested and sized by lines.' },
  { id: 'graph', name: 'Graph', key: '2', about: 'Parts pulled together by their links.' },
  { id: 'layers', name: 'Layers', key: '3', about: 'Parts stacked by dependency. Base code sits at the bottom.' },
  { id: 'city', name: 'City', key: '4', about: 'The map in 3D. Buildings open into towers (functions) on podiums (types) as you zoom in; the code is on the roofs.' },
];
const PAINTS = [
  { id: 'lang', name: 'Language' },
  { id: 'lines', name: 'Size', unit: 'lines' },
  { id: 'cx', name: 'Complexity', unit: 'branches' },
  { id: 'churn', name: 'Churn', unit: 'commits' },
  { id: 'age', name: 'Age', unit: 'days old' },
  { id: 'fanin', name: 'Used by', unit: 'users' },
  { id: 'issues', name: 'Issues' },
  { id: 'review', name: 'Review' },
  { id: 'stage', name: 'Changes' },
  { id: 'reach', name: 'Reach' },
];
const HEIGHTS = [
  { id: 'same', name: 'Same as color' },
  { id: 'lines', name: 'Lines' },
  { id: 'cx', name: 'Complexity' },
  { id: 'churn', name: 'Churn' },
  { id: 'age', name: 'Age' },
  { id: 'fanin', name: 'Used by' },
  { id: 'level', name: 'Level' },
  { id: 'issues', name: 'Issues' },
];
const ANGLES = [
  { id: 'tilt', name: 'Tilt', pitch: 0.95, yaw: -0.5 },
  { id: 'top', name: 'Top', pitch: 0, yaw: 0 },
  { id: 'low', name: 'Low', pitch: 1.2, yaw: null },
];
const DETAILS = [
  { id: 'dir', name: 'Folders', rank: 2 },
  { id: 'file', name: 'Files', rank: 3 },
  { id: 'type', name: 'Types', rank: 4 },
  { id: 'func', name: 'Functions', rank: 5 },
];
const LINK_MODES = [{ id: 'none', name: 'Off' }, { id: 'focus', name: 'Focus' }, { id: 'all', name: 'All' }];
const LINK_NAMES = { import: 'imports', call: 'calls', use: 'uses', base: 'extends', copy: 'copies', change: 'changes with' };
const KIND_ORDER = ['import', 'call', 'use', 'base', 'copy', 'change'];
const RANK = S.RANK;
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
const LINK_COLOR = { out: 0, in: 1, inside: 6, import: 0, call: 2, use: 6, base: 3, copy: 4 };
// Line widths per kind, in pixels; changes-with links are thin and faint.
const LINK_WIDTH = { import: 1.6, call: 1.8, use: 1.3, base: 2.2, copy: 1.3, change: 1.0 };
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
  grow: 'M12 4v16M4 12h16M7 7l10 10M17 7L7 17',
  isolate: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 3v2M12 19v2M3 12h2M19 12h2',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
  angle: 'M4 18l8-12 8 12zM4 18h16',
  each: 'M5 6h14M5 12h14M5 18h14M3 6h.01M3 12h.01M3 18h.01',
  link: 'M10 14l4-4M8.5 16.5l-1 1a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M15.5 7.5l1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0',
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
  kinds: store.load('kinds', {}),
  height: store.load('height', 'same'),
  mode: store.load('mode', 'together'),
  angle: 'tilt',
  set: S.emptySet(),
  setVer: 0,
  saved: [],
  acts: [],
  isolate: false,
  sites: new Map(),
  base: null,
  hoverLink: null,
  hoverSite: null,
  bundle: null,
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
  wantedSites: new Set(),
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
  const I = S.index(m);
  const F = S.facts(I);
  for (const l of m.langs) if (!state.slots.has(l.id) && state.slots.size < 7) state.slots.set(l.id, state.slots.size);
  return { ...I, I, issuesOf: F.issuesOf, sev: F.sev, count: F.count, cxMax: F.cxMax, scales: F.scales, now: F.now };
}

const node = (id) => state.T?.N[id];
const idOf = (key) => state.T?.byKey.get(key) ?? -1;
const selIds = () => state.set.nodes.map(idOf).filter((id) => id >= 0);
const detailRank = () => DETAILS.find((d) => d.id === state.detail)?.rank ?? 3;
const setEmpty = () => S.setSize(state.set) === 0;

const liftTo = (id, rank) => S.liftTo(state.T.I, id, rank);
const isUnder = (id, anc) => S.isUnder(state.T.I, id, anc);
const walk = (id, fn, cap) => S.walk(state.T.I, id, fn, cap);
const pathOf = (id) => S.pathOf(state.T.I, id);
const nameOf = (id) => { const n = node(id); return n ? (n.kind === 'func' ? `${n.name}()` : n.name) : '?'; };

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

// Hop distances from the current set, for the Reach color. Cached per set
// version, model, and detail.
function currentReach() {
  const T = state.T;
  const key = `${state.setVer}|${state.model?.made}|${detailRank()}`;
  if (state.reach?.key !== key) state.reach = { key, value: S.reach(T.I, state.set, detailRank()) };
  return state.reach.value;
}

const classCtx = () => ({ I: state.T.I, rank: detailRank(), stageIndex: state.stageIndex, reach: state.paint === 'reach' ? currentReach() : null });
const classOf = (id, paint = state.paint, ctx = classCtx()) => S.classify(ctx, paint, id);
const metricOf = (id, paint) => S.measure({ I: state.T.I, rank: detailRank() }, paint, id);

// The color of a class (a category key or a measure).
function colorOf(cls, id) {
  const th = theme();
  const neutral = rgb(th.neutral);
  if (typeof cls === 'number') return rampColor(cls);
  if (cls === 'dir') return rgb(th.dirs[Math.min(state.T.depth[id] - 1, th.dirs.length - 1)]);
  const [group, value = ''] = cls.split(':');
  if (group === 'lang') {
    const [lang, sub] = value.split('/');
    if (sub === 'gen') return mix(langColor(lang), rgb(th.bg), 0.55);
    if (sub === 'type') return rgb(th.series[6]);
    if (sub === 'part') return rgb(th.series[2]);
    if (sub === 'space') return rgb(th.other);
    if (sub === 'func') return rgb(th.series[0]);
    return langColor(lang);
  }
  if (group === 'sev') return value === '3' ? rgb(STATUS.critical) : value === '2' ? rgb(STATUS.serious) : value === '1' ? rgb(STATUS.warn) : neutral;
  if (group === 'rev') return value === 'ok' ? rgb(STATUS.good) : value === 'stale' ? rgb(STATUS.warn) : value === 'some' ? mix(neutral, rgb(STATUS.good), 0.45) : neutral;
  if (group === 'stage') return value === 'add' ? rgb(STATUS.good) : value === 'edit' ? rgb(th.accent) : value === 'delete' ? rgb(STATUS.critical) : value === 'dirty' ? mix(neutral, rgb(STATUS.warn), 0.55) : neutral;
  if (group === 'reach') {
    if (value === 'self') return rgb(th.ink);
    if (value === 'both') return rgb(th.series[6]);
    const m = /^(out|in)(\d)$/.exec(value);
    if (m) return mix(rgb(th.series[m[1] === 'out' ? 0 : 1]), neutral, (+m[2] - 1) * 0.36);
    return neutral;
  }
  return neutral;
}

// Fill color for a node, by the current paint.
const paintOf = (id) => colorOf(classOf(id), id);

// Dimming: find results while typing, then isolate, then a spotlighted rule.
function makeLit() {
  const T = state.T;
  let hits = null;
  if (state.matches) hits = state.matches;
  else if (state.isolate && !setEmpty()) hits = new Set(S.seedIds(T.I, state.set));
  else if (state.spot) {
    hits = new Set();
    for (const iss of state.model.issues) if (iss.rule === state.spot && (!iss.waived || state.showWaived)) hits.add(iss.node);
  }
  if (!hits) return null;
  const above = new Set();
  for (const id of hits) for (let p = T.N[id].up; p >= 0; p = T.N[p].up) { if (above.has(p)) break; above.add(p); }
  return (id) => {
    if (hits.has(id) || above.has(id)) return true;
    for (let p = T.N[id]?.up ?? -1; p > 0; p = T.N[p].up) if (hits.has(p)) return true;
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
    out.push({ col: j, x, y: c.y + (a - r0) * c.lh, w: Math.max(c.lh, c.colW - gut - indent * c.lh - 0.4 * c.lh), h: (b - a) * c.lh });
  }
  return out;
}

// Sizes for a stable layout while changes are staged: every file that exists
// before or after, at the larger of its two sizes, so toggling Preview moves
// nothing. Files that exist on one side only become ghosts: staged new files
// outside preview, deleted files in preview.
function shapeOf(T) {
  const items = state.stage.items ?? [];
  if (!items.length) return null;
  const preview = !!state.model?.preview;
  const base = preview ? state.base ?? state.model : state.model;
  const baseLines = new Map();
  for (const n of base?.nodes ?? []) if (n.kind === 'file') baseLines.set(n.key, n.lines);
  const size = new Map(), ghosts = [];
  for (const it of items) {
    const before = baseLines.get(it.key) ?? 0;
    const after = it.state === 'delete' ? 0 : it.state === 'add' ? it.adds : before + it.adds - it.dels;
    size.set(it.key, Math.max(before, after, 1));
    if (T.byKey.has(it.key)) continue;
    if (it.state === 'delete' && preview) ghosts.push({ key: it.key, kind: 'gone' });
    else if (it.state !== 'delete' && !preview) ghosts.push({ key: it.key, kind: 'new' });
  }
  return { size, ghosts, sig: [...size].map(([k, v]) => `${k}:${v}`).join('|') + '#' + ghosts.map((g) => g.key).join('|') };
}

function layMap(T) {
  const N = T.N;
  const shape = shapeOf(T);
  const vt = (n) => ({ id: n.id, key: n.key, kind: n.kind, name: n.name, lines: shape?.size.get(n.key) ?? n.lines, kids: [] });
  const root = vt(N[0]);
  const byKey = new Map([['', root]]);
  const grow = (id, parent) => {
    for (const c of T.kids[id]) {
      const k = N[c].kind;
      if (k !== 'repo' && k !== 'dir' && k !== 'file') continue;
      const v = vt(N[c]);
      parent.kids.push(v);
      byKey.set(v.key, v);
      if (k !== 'file') grow(c, v);
    }
  };
  grow(0, root);
  for (const g of shape?.ghosts ?? []) {
    const parts = g.key.split('/');
    let parent = byKey.get(parts[0]);
    if (!parent) continue;
    for (let i = 1; i < parts.length - 1; i++) {
      const k = parts.slice(0, i + 1).join('/');
      let d = byKey.get(k);
      if (!d) { d = { id: -1, key: k, kind: 'dir', name: parts[i], lines: 0, kids: [], ghost: g.kind }; parent.kids.push(d); byKey.set(k, d); }
      parent = d;
    }
    parent.kids.push({ id: -1, key: g.key, kind: 'file', name: parts.at(-1), lines: shape.size.get(g.key) ?? 1, kids: [], ghost: g.kind });
  }
  const tree = d3.hierarchy(root, (x) => (x.kids.length ? x.kids : null));
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
  const items = [], rect = new Map(), code = new Map(), pieces = new Map(), ghosts = [];
  tree.each((d) => {
    const x = d.data;
    if (x.kind === 'root') return;
    const r = { x: d.x0, y: d.y0, w: Math.max(0, d.x1 - d.x0), h: Math.max(0, d.y1 - d.y0) };
    if (x.id < 0) {
      r.head = x.kind === 'file' ? Math.min(F, r.h * 0.3) : headOf(d);
      ghosts.push({ key: x.key, name: x.name, kind: x.kind, ghost: x.ghost, ...r });
      items.push({ key: x.key + '|g', nk: x.key, id: -1, part: x.kind === 'file' ? 'ghost' : 'gdir', ghost: x.ghost, ...r, r: 2 });
      return;
    }
    if (x.kind !== 'file') {
      r.head = headOf(d);
      rect.set(x.id, r);
      items.push({ key: x.key + '|d', nk: x.key, id: x.id, part: 'dir', ...r, r: 3 });
      return;
    }
    const fh = Math.min(F, r.h * 0.3);
    r.head = fh;
    rect.set(x.id, r);
    items.push({ key: x.key + '|b', nk: x.key, id: x.id, part: 'body', ...r, r: 2 });
    items.push({ key: x.key + '|h', nk: x.key, id: x.id, part: 'head', x: r.x, y: r.y, w: r.w, h: fh, r: 2 });
    const pad = Math.min(fh * 0.3, r.w * 0.05);
    const c = fitCode(r.x + pad, r.y + fh + pad, Math.max(0.1, r.w - 2 * pad), Math.max(0.1, r.h - fh - 2 * pad), N[x.id].lines);
    c.pad = pad;
    code.set(x.id, c);
    const list = [];
    walk(x.id, (k) => {
      if (k === x.id) return;
      const s = N[k];
      if (!s.from) return;
      codePieces(c, s.from, s.to, T.symDepth[k] * 0.9).forEach((p, j) => {
        const it = { key: `${s.key}|s${j}`, nk: s.key, id: k, part: 'sym', first: j === 0, ...p, r: 1.5 };
        items.push(it);
        list.push(it);
      });
    });
    pieces.set(x.id, list);
  });
  return { kind: 'map', items, rect, code, pieces, ghosts, aspect, shape: shape?.sig ?? '', bounds: { x: 0, y: 0, w: W, h: H } };
}

// Links lifted to a rank and merged (sets.mjs), capped at 4,000 parts for
// Graph and Layers: the most linked and largest are kept.
function liftGraph(T, rank) {
  const g = S.liftGraph(T.I, rank);
  if (g.ids.length <= 4000) return g;
  const linked = new Set();
  for (const e of g.links) { linked.add(e.a); linked.add(e.b); }
  const ids = g.ids.filter((id) => linked.has(id)).sort((a, b) => T.N[b].lines - T.N[a].lines).slice(0, 4000);
  const keep = new Set(ids);
  return { ids, links: g.links.filter((e) => keep.has(e.a) && keep.has(e.b)) };
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
    items.push({ key: T.N[nd.id].key + '|n', nk: T.N[nd.id].key, id: nd.id, part: 'node', ...r, r: 999 });
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
  // Strongly connected groups share a level; levels count up from the base.
  const L = S.levels(ids, links);
  const comp = L.comp, compSize = L.compSize, maxL = L.maxL;
  const level = (id) => L.levelOf(id);
  const rows = Array.from({ length: maxL + 1 }, () => []);
  const top = (id) => { const p = pathOf(id); return p[Math.min(1, p.length - 1)] ?? 0; };
  for (const id of ids) rows[level(id)].push(id);
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
  for (let Lv = maxL; Lv >= 0; Lv--) {
    const row = rows[Lv];
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
        items.push({ key: N[id].key + '|n', nk: N[id].key, id, part: 'node', ...r, r: 4, loop: compSize[comp.get(id)] > 1 });
        x += width(id) + GAP;
      }
      y += BOX_H + 10;
    }
    bands.push({ level: Lv, y0: y0 - 6, y1: y - 4, count: row.length });
    y += ROW - BOX_H - 10;
  }
  let x0 = Infinity, x1 = -Infinity;
  for (const r of rect.values()) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.w); }
  if (!rect.size) { x0 = 0; x1 = 100; }
  const quad = d3.quadtree([...rect.entries()], ([, r]) => r.x + r.w / 2, ([, r]) => r.y + r.h / 2);
  return { kind: 'layers', items, rect, quad, links, bands, levelOf: level, bounds: { x: x0 - 40, y: -10, w: x1 - x0 + 80, h: y + 10 } };
}

// ───────────────────────────── Renderer ─────────────────────────────

const R = { pitch: 0, yaw: 0, pivot: [0, 0, 0] };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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

// Modes: 0 plain, 1 file body (fades as code becomes readable), 2 symbol
// band, 3 ghost file (hatched), 4 ghost folder (faint).
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
  if (mode > 2.5 && mode < 3.5) {
    float stripe = step(0.62, fract((gl_FragCoord.x + gl_FragCoord.y) / 9.0));
    c = mix(uBg, c, 0.14 + 0.3 * stripe);
  }
  if (mode > 3.5) c = mix(uBg, c, 0.1);
  float edge = clamp(-d / 1.2, 0.0, 1.0);
  c *= mix(0.78, 1.0, edge);
  gl_FragColor = vec4(c, vColor.a * a);
}`;

const city = makeCity({
  state, R, d3, S, get theme() { return theme(); }, rgb, mix, css, clamp, paintOf, colorOf, classOf, classCtx, makeLit, detailRank, idOf, node,
  liftTo, isUnder, walk, pathOf, selIds, requestDraw: () => requestDraw(), inkCode: (...a) => inkCode(...a), wantText: (k) => wantText(k), wantSites: (k) => wantSites(k),
  textWidth: (...a) => textWidth(...a), fitText: (...a) => fitText(...a), haloText: (...a) => haloText(...a), affine: (...a) => affine(...a), toScreen: (...a) => toScreen(...a),
  viewport: () => viewport(), stageOf: (id) => stageOf(id), LEVEL_COLOR, LEVELS, LEVEL_RANK, STATUS, CODE, UI_FONT, MONO_FONT,
  fitBox: (...a) => fitBox(...a), relink: () => buildLinks(), inkGrip: (ctx) => inkGrip(ctx),
  setTransform: (x, y, k) => d3.select('#view').interrupt().call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(k)),
});

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
  const links = new THREE.Group();
  links.renderOrder = 5;
  base.add(links);
  Object.assign(R, { renderer, scene, camera, view, tilt, base, quad, tiles, tileMat, links, lineMats: new Map(), cap: 0, raycaster: new THREE.Raycaster() });
  city.attach();
}

function sizeGL() {
  const el = $('#view');
  const W = el.clientWidth, H = el.clientHeight;
  R.W = W; R.H = H;
  R.renderer.setSize(W, H, false);
  Object.assign(R.camera, { left: 0, right: W, top: 0, bottom: -H });
  R.camera.updateProjectionMatrix();
  for (const m of R.lineMats.values()) m.resolution.set(W, H);
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

const MODE = { dir: 0, head: 0, body: 1, sym: 2, node: 0, ghost: 3, gdir: 4 };

// Write item colors to the GPU (also used after paint, selection, or find changes).
function colorItems() {
  const lay = state.lay;
  if (!lay) return;
  if (lay.kind === 'city') { city.color(); return; }
  const th = theme();
  const lit = makeLit();
  const bg = rgb(th.bg);
  const col = R.quad.getAttribute('iColor').array;
  const sty = R.quad.getAttribute('iStyle').array;
  const ctx = classCtx();
  lay.items.forEach((it, i) => {
    let c;
    if (it.id < 0) c = it.ghost === 'gone' ? rgb(STATUS.critical) : it.ghost === 'new' ? rgb(STATUS.good) : rgb(th.neutral);
    else c = colorOf(classOf(it.id, state.paint, ctx), it.id);
    if (it.part === 'head') c = mix(c, [1, 1, 1], 0.08);
    if (it.part === 'node' && it.loop) c = mix(c, rgb(STATUS.critical), 0.25);
    if (lit && it.id > 0 && !lit(it.id)) c = mix(c, bg, it.part === 'dir' ? 0.45 : 0.8);
    col.set([c[0], c[1], c[2], 1], i * 4);
    const lh = it.part === 'body' || it.part === 'sym' ? lay.code?.get(state.T.fileOf[it.id])?.lh ?? 0 : 0;
    sty.set([it.r ?? 2, MODE[it.part] ?? 0, lh, 0], i * 4);
  });
  R.quad.getAttribute('iColor').needsUpdate = true;
  R.quad.getAttribute('iStyle').needsUpdate = true;
}

// Rects for the current frame (morphing between layouts when animating).
function placeItems(t) {
  const lay = state.lay;
  if (!lay || lay.kind === 'city') return;
  const morph = R.morph;
  const e = morph ? d3.easeCubicInOut(t) : 1;
  const arr = R.quad.getAttribute('iRect').array;
  lay.items.forEach((it, i) => {
    let x = it.x, y = it.y, w = it.w, hh = it.h;
    const f = morph?.from?.[i];
    if (f) { x = f[0] + (x - f[0]) * e; y = f[1] + (y - f[1]) * e; w = f[2] + (w - f[2]) * e; hh = f[3] + (hh - f[3]) * e; }
    arr[i * 4] = x; arr[i * 4 + 1] = -(y + hh); arr[i * 4 + 2] = w; arr[i * 4 + 3] = hh;
  });
  R.quad.getAttribute('iRect').needsUpdate = true;
  R.quad.instanceCount = lay.items.length;
}

// The camera's resting angles: where a running morph or turn will end.
const camAngles = () => ({ pitch: R.morph?.toPitch ?? R.cam?.to.pitch ?? R.pitch, yaw: R.morph?.toYaw ?? R.cam?.to.yaw ?? R.yaw });

function useLayout(next, { animate = true, fit = false } = {}) {
  const prev = state.lay;
  const isCity = next.kind === 'city';
  if (!isCity) ensureTiles(next.items.length);
  const motion = animate && !!prev && !reduced();
  let from = null;
  if (!isCity && motion && prev.kind !== 'city') {
    const old = new Map(prev.items.map((it) => [it.key, it]));
    const oldNode = new Map();
    for (const it of prev.items) if (!oldNode.has(it.nk) || it.part === 'body' || it.part === 'dir' || it.part === 'node') oldNode.set(it.nk, it);
    const N = state.T.N;
    from = next.items.map((it) => {
      const o = old.get(it.key) ?? old.get(it.nk + (next.kind === 'map' ? '|b' : '|n'));
      if (o) return [o.x, o.y, o.w, o.h];
      let p = oldNode.get(it.nk);
      for (let a = it.id > 0 ? N[it.id].up : -1; !p && a > 0; a = N[a].up) p = oldNode.get(N[a].key);
      if (p) return [p.x + p.w / 2, p.y + p.h / 2, 0, 0];
      return [it.x + it.w / 2, it.y + it.h / 2, 0, 0];
    });
  }
  const switched = prev?.kind !== next.kind;
  state.lay = next;
  R.tiles.visible = !isCity;
  if (isCity) city.use(next, prev, motion); else city.hide();
  // Orbit resets when the layout changes; the pivot goes back to the middle.
  const b = next.bounds;
  if (switched || !isCity) {
    R.pivot = [b.x + b.w / 2, b.y + b.h / 2, 0];
    if (switched) state.angle = 'tilt';
  }
  const tilt = ANGLES[0];
  const toPitch = isCity ? (switched ? tilt.pitch : camAngles().pitch) : 0;
  const toYaw = isCity ? (switched ? tilt.yaw : camAngles().yaw) : 0;
  R.cam = null;
  R.morph = motion && (from || R.pitch !== toPitch || R.yaw !== toYaw) ? { from, t0: performance.now(), dur: 720, fromPitch: R.pitch, toPitch, fromYaw: R.yaw, toYaw } : null;
  if (!R.morph) { R.pitch = toPitch; R.yaw = toYaw; }
  colorItems();
  placeItems(R.morph ? 0 : 1);
  setZoomRange();
  if (fit) fitAll(motion ? 720 : 0);
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
  else if (state.layout === 'city') next = city.lay(T, map);
  else next = map;
  useLayout(next, opts);
}

// ───────────────────────────── Links ─────────────────────────────

function focusIds() {
  const ids = selIds();
  if (state.hover > 0 && !ids.includes(state.hover)) ids.push(state.hover);
  return ids;
}

// Is a link kind shown? Copies and changes-with show in Focus and hide in All
// unless the legend says otherwise.
const kindOn = (kind) => state.kinds[kind] ?? (kind === 'change' || kind === 'copy' ? state.links === 'focus' : true);

// The node a link end attaches to in the current layout.
function endOf(id, rank = detailRank()) {
  const lay = state.lay;
  if (lay.kind === 'graph' || lay.kind === 'layers') return liftTo(id, rank);
  if (lay.kind === 'city') return city.endOf(id, rank);
  return liftTo(id, Math.max(rank, Math.min(RANK[state.T.N[id].kind], 3)));
}

function anchorOf(id) {
  const lay = state.lay;
  if (!lay) return null;
  if (lay.kind === 'city') return city.anchor(id);
  if (lay.kind === 'map') {
    const T = state.T;
    const f = T.fileOf[id];
    if (f >= 0 && f !== id) {
      const pc = lay.pieces.get(f)?.find((it) => it.id === id);
      if (pc) return [pc.x + Math.min(pc.w, 6 * (lay.code.get(f)?.lh ?? 1)) / 2, pc.y + Math.min(pc.h, lay.code.get(f)?.lh ?? 1) / 2];
      const r = lay.rect.get(f);
      return r ? [r.x + r.w / 2, r.y + r.h / 2] : null;
    }
    const r = lay.rect.get(id);
    if (!r) return null;
    const kind = state.T.N[id].kind;
    return kind === 'dir' || kind === 'repo' ? [r.x + Math.min(r.w / 2, r.head * 4), r.y + r.head / 2] : [r.x + r.w / 2, r.y + r.h / 2];
  }
  const r = lay.rect.get(id);
  return r ? [r.x + r.w / 2, r.y + r.h / 2] : null;
}

// Where a code line sits in the layout: the start of its text in its column.
function siteAnchor(fileId, line) {
  const lay = state.lay;
  if (lay.kind === 'city') return city.siteAnchor(fileId, line);
  const c = lay.kind === 'map' ? lay.code.get(fileId) : null;
  if (!c) return null;
  const j = Math.floor((line - 1) / c.rows), r = (line - 1) % c.rows;
  return [c.x + j * (c.colW + c.gap) + CODE.gut * CODE.cw * c.lh, c.y + (r + 0.5) * c.lh];
}

// Is a file's code readable as text right now?
function readable(fileId) {
  const lay = state.lay;
  if (lay?.kind === 'city') return city.readable(fileId);
  const c = lay?.kind === 'map' ? lay.code.get(fileId) : null;
  return !!c && c.lh * state.t.k >= 7.5;
}

// Lines in a source file where a raw link happens (from file.links).
function siteLines(li) {
  const T = state.T, m = state.model;
  const [s, t, k] = m.links[li];
  const f = T.fileOf[s];
  const sites = f >= 0 ? state.sites.get(T.N[f].key) : null;
  if (!sites) { if (f >= 0) wantSites(T.N[f].key); return []; }
  const from = T.N[s].key, to = T.N[t].key, kind = m.linkKinds[k];
  return sites.out.filter((x) => x.from === from && x.to === to && x.kind === kind).map((x) => x.line);
}

function linkSet() {
  const T = state.T;
  const m = state.model;
  const lay = state.lay;
  if (!T || !lay) return [];
  const rank = detailRank();
  const flat = lay.kind === 'graph' || lay.kind === 'layers';
  const visible = (id) => (flat ? lay.rect.has(id) : true);
  const end = (id) => endOf(id, rank);
  const merged = new Map();
  const put = (a, b, kind, w, dir, extra) => {
    if (a === b || a <= 0 || b <= 0 || !visible(a) || !visible(b)) return;
    const key = `${a},${b},${dir ?? kind}${extra?.tag ?? ''}`;
    let e = merged.get(key);
    if (!e) merged.set(key, (e = { a, b, kind, w: 0, dir, kinds: new Set(), ...extra }));
    e.w += w;
    e.kinds.add(kind);
  };
  if (state.links === 'focus' && flat) {
    if (lay.dim?.rank !== rank) {
      const dim = new Map();
      for (const e of lay.links ?? []) dim.set(`${e.a},${e.b},dim`, { a: e.a, b: e.b, kind: 'dim', w: e.w, dir: 'dim', kinds: new Set(['dim']) });
      lay.dim = { rank, list: dim };
    }
    for (const [key, e] of lay.dim.list) merged.set(key, { ...e });
  }
  if (state.links === 'focus') {
    // The set's boundary: links inside it, what it uses, and what uses it.
    const members = selIds();
    const memberSet = new Set(members);
    const memberOf = (id) => { for (let p = id; p >= 0; p = T.N[p].up) if (memberSet.has(p)) return p; return -1; };
    for (const f of members) {
      const self = flat ? liftTo(f, rank) : f;
      walk(f, (id) => {
        for (const li of T.out[id]) {
          const [, t, k, w] = m.links[li];
          const kind = m.linkKinds[k];
          if (!kindOn(kind) || isUnder(t, f)) continue;
          const mt = memberOf(t);
          if (mt >= 0) put(self, flat ? liftTo(mt, rank) : mt, kind, w, 'inside');
          else put(self, end(t), kind, w, 'out');
        }
        for (const li of T.inn[id]) {
          const [src, , k, w] = m.links[li];
          const kind = m.linkKinds[k];
          if (!kindOn(kind) || isUnder(src, f) || memberOf(src) >= 0) continue;
          put(end(src), self, kind, w, 'in');
        }
      }, 6000);
    }
    const site = state.hoverSite;
    if (site) {
      // A hovered code line shows only that line's links, from the line itself.
      const sites = state.sites.get(T.N[site.file].key);
      const at = siteAnchor(site.file, site.line);
      for (const x of sites?.out ?? []) {
        if (x.line !== site.line) continue;
        const s = idOf(x.from), t = idOf(x.to);
        if (s >= 0 && t >= 0 && kindOn(x.kind)) put(s, end(t), x.kind, 1, 'out', { pa: at, tag: '@' + site.line });
      }
      for (const x of sites?.in ?? []) {
        const t = idOf(x.to), s = idOf(x.from);
        if (t < 0 || s < 0 || T.N[t].from !== site.line || T.fileOf[t] !== site.file || !kindOn(x.kind)) continue;
        put(end(s), t, x.kind, 1, 'in', { pb: at, tag: '@' + site.line });
      }
    } else if (state.hover > 0 && !memberSet.has(state.hover)) {
      const f = state.hover;
      const self = flat ? liftTo(f, rank) : f;
      walk(f, (id) => {
        for (const li of T.out[id]) { const [, t, k, w] = m.links[li]; const kind = m.linkKinds[k]; if (kindOn(kind) && !isUnder(t, f)) put(self, end(t), kind, w, 'out'); }
        for (const li of T.inn[id]) { const [src, , k, w] = m.links[li]; const kind = m.linkKinds[k]; if (kindOn(kind) && !isUnder(src, f)) put(end(src), self, kind, w, 'in'); }
      }, 6000);
    }
  } else if (state.links === 'all') {
    for (const [s, t, k, w] of m.links) {
      const kind = m.linkKinds[k];
      if (!kindOn(kind)) continue;
      const a = liftTo(s, rank), b = liftTo(t, rank);
      if (isUnder(a, b) || isUnder(b, a)) continue;
      put(a, b, kind, w);
    }
  }
  // Link members of the set always show. At reading zoom they leave from the
  // exact lines where they happen.
  for (const l of state.set.links) {
    for (const li of S.linkIndices(T.I, l, 400)) {
      const [s, t, k, w] = m.links[li];
      const kind = m.linkKinds[k];
      const f = T.fileOf[s];
      const lines = !flat && f >= 0 && readable(f) ? siteLines(li) : [];
      if (lines.length) for (const line of lines) put(s, end(t), kind, w, 'pick', { member: l, pa: siteAnchor(f, line), tag: '@' + line });
      else put(end(s), end(t), kind, w, 'pick', { member: l });
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
  if (lay.kind === 'city') return city.route(e);
  const a = e.pa ?? anchorOf(e.a), b = e.pb ?? anchorOf(e.b);
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
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const mx = (a[0] + b[0]) / 2 - dy * 0.12, my = (a[1] + b[1]) / 2 + dx * 0.12;
  const out = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * mx + t * t * b[0], u * u * a[1] + 2 * u * t * my + t * t * b[1], 0]);
  }
  return out;
}

// The color, width, and strength a drawn link gets.
function linkStyle(e, maxW) {
  const th = theme();
  const strength = e.dir === 'dim' ? 0.3 + 0.25 * Math.sqrt(e.w / maxW) : 0.45 + 0.55 * Math.sqrt(e.w / maxW);
  if (e.dir === 'dim') return { color: rgb(th.ink3), width: 1.1, strength };
  if (e.dir === 'pick') return { color: rgb(th.accent), width: 2.6, strength: 1 };
  if (e.dir) return { color: rgb(th.series[LINK_COLOR[e.dir]]), width: e.kind === 'change' && e.kinds.size === 1 ? 1 : 1.8, strength: e.kind === 'change' && e.kinds.size === 1 ? strength * 0.5 : strength };
  if (e.kind === 'change') return { color: rgb(th.ink2), width: LINK_WIDTH.change, strength: strength * 0.5 };
  return { color: rgb(th.series[LINK_COLOR[e.kind] ?? 0]), width: LINK_WIDTH[e.kind] ?? 1.4, strength };
}

function lineMat(width) {
  let m = R.lineMats.get(width);
  if (!m) {
    m = new LineMaterial({ linewidth: width, vertexColors: true, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, worldUnits: false });
    m.resolution.set(R.W || 1, R.H || 1);
    R.lineMats.set(width, m);
  }
  return m;
}

function buildLinks() {
  const th = theme();
  const list = state.lay ? linkSet() : [];
  state.linkList = list;
  state.linkVer = (state.linkVer ?? 0) + 1;
  state.hoverLink = null;
  const groups = new Map();
  const bg = rgb(th.bg);
  const maxW = d3.max(list, (e) => e.w) ?? 1;
  for (const e of list) {
    const pts = routeOf(e);
    e.pts = pts;
    if (!pts) continue;
    const st = linkStyle(e, maxW);
    e.color = st.color;
    let g = groups.get(st.width);
    if (!g) groups.set(st.width, (g = { pos: [], col: [] }));
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      g.pos.push(p[0], -p[1], p[2], q[0], -q[1], q[2]);
      const c0 = mix(bg, st.color, (0.25 + 0.75 * ((i - 1) / (pts.length - 1))) * st.strength);
      const c1 = mix(bg, st.color, (0.25 + 0.75 * (i / (pts.length - 1))) * st.strength);
      g.col.push(...c0, ...c1);
    }
  }
  for (const old of [...R.links.children]) { R.links.remove(old); old.geometry.dispose(); }
  const depth = state.lay?.kind === 'city';
  for (const [width, g] of groups) {
    if (!g.pos.length) continue;
    const geo = new LineSegmentsGeometry();
    geo.setPositions(g.pos);
    geo.setColors(g.col);
    const mat = lineMat(width);
    mat.depthTest = depth;
    const lines = new LineSegments2(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    R.links.add(lines);
  }
}

// Bright links projected to the screen, cached while the view stays put.
// Used for arrowheads and for picking links.
function linkScreens() {
  const t = state.t;
  const sig = `${t.k},${t.x},${t.y},${R.pitch},${R.yaw},${R.pivot},${state.linkVer},${R.W},${R.H}`;
  if (R.linkScreens?.sig === sig) return R.linkScreens.list;
  const A = affine();
  const list = [];
  for (const e of state.linkList ?? []) {
    if (!e.pts || e.dir === 'dim') continue;
    const xy = new Float32Array(e.pts.length * 2);
    e.pts.forEach((p, i) => { xy[i * 2] = A.O[0] + p[0] * A.u[0] + p[1] * A.v[0] + p[2] * A.w[0]; xy[i * 2 + 1] = A.O[1] + p[0] * A.u[1] + p[1] * A.v[1] + p[2] * A.w[1]; });
    list.push({ e, xy });
  }
  R.linkScreens = { sig, list };
  return list;
}

// The drawn link nearest a screen point, within `tol` pixels.
function pickLink(sx, sy, tol = 5) {
  if (R.morph) return null;
  let best = null, bestD = tol;
  for (const { e, xy } of linkScreens()) {
    for (let i = 2; i < xy.length; i += 2) {
      const ax = xy[i - 2], ay = xy[i - 1], bx = xy[i], by = xy[i + 1];
      const dx = bx - ax, dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len ? clamp(((sx - ax) * dx + (sy - ay) * dy) / len, 0, 1) : 0;
      const d = Math.hypot(sx - ax - dx * t, sy - ay - dy * t);
      if (d < bestD) { bestD = d; best = e; }
    }
  }
  return best;
}

// A link member for a drawn link: [from key, to key, kind or '*'].
function memberOfLink(e) {
  const T = state.T;
  if (e.member) return e.member;
  const kind = e.kinds?.size === 1 ? [...e.kinds][0] : '*';
  return [T.N[e.a].key, T.N[e.b].key, kind === 'dim' ? '*' : kind];
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
  if (R.cam) {
    const p = clamp((now - R.cam.t0) / Math.max(1, R.cam.dur), 0, 1);
    const e = d3.easeCubicInOut(p);
    R.pitch = R.cam.from.pitch + (R.cam.to.pitch - R.cam.from.pitch) * e;
    R.yaw = R.cam.from.yaw + (R.cam.to.yaw - R.cam.from.yaw) * e;
    if (p >= 1) { R.cam = null; city.viewChanged(true); } else busy = true;
  }
  if (state.lay?.kind === 'city' && city.frame(now)) busy = true;
  R.renderer.setClearColor(th.bg, 1);
  R.tileMat.uniforms.uBg.value.set(th.bg);
  R.tileMat.uniforms.uScale.value = t.k;
  R.view.position.set(t.x, -t.y, 0);
  R.view.scale.set(t.k, t.k, t.k);
  R.tilt.position.set(R.pivot[0], -R.pivot[1], R.pivot[2]);
  R.base.position.set(-R.pivot[0], R.pivot[1], -R.pivot[2]);
  R.tilt.rotation.set(-R.pitch, 0, R.yaw);
  R.links.visible = !R.morph && R.links.children.length > 0;
  const quiet = readingCode();
  for (const m of R.lineMats.values()) m.opacity = quiet ? 0.3 : 0.85;
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
  const f = state.T?.fileOf[selIds()[0] ?? -1] ?? -1;
  if (f < 0) return false;
  if (lay?.kind === 'city') return city.readable(f);
  if (lay?.kind !== 'map') return false;
  const c = lay.code.get(f);
  return !!c && c.lh * state.t.k >= 7.5;
}

// Layout units → screen pixels is affine under the orthographic camera:
// screen = O + x·u + y·v + z·w. The four vectors follow the view transform,
// the City's yaw and pitch, and its pivot.
function affine(t = state.t, pitch = R.pitch, yaw = R.yaw, pivot = R.pivot) {
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const [px, py, pz] = pivot;
  const k = t.k;
  return {
    O: [t.x + k * (-c * px - s * py + px), t.y - k * ((-s * px + c * py) * cp - pz * sp - py)],
    u: [k * c, -k * s * cp],
    v: [k * s, k * c * cp],
    w: [0, -k * sp],
  };
}

function toScreen(x, y, z = 0) {
  if (!R.pitch && !R.yaw) {
    const t = state.t;
    return [x * t.k + t.x, y * t.k + t.y];
  }
  const A = affine();
  return [A.O[0] + x * A.u[0] + y * A.v[0] + z * A.w[0], A.O[1] + x * A.u[1] + y * A.v[1] + z * A.w[1]];
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
  else if (lay.kind === 'city') city.ink(ctx, now);
  else inkGraph(ctx);
  inkFocus(ctx, now);
  inkLinks(ctx);
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
  inkGhosts(ctx);
}

// Staged files that exist on one side only: deleted files in preview (red,
// hatched), new files outside preview (green, dashed). New files in preview
// get a green outline.
function inkGhosts(ctx) {
  const lay = state.lay;
  const th = theme();
  const { k } = state.t;
  ctx.save();
  for (const g of lay.ghosts ?? []) {
    if (g.kind !== 'file') continue;
    const [sx, sy] = toScreen(g.x, g.y);
    const sw = g.w * k, sh = g.h * k;
    if (sx > R.W || sy > R.H || sx + sw < 0 || sy + sh < 0 || sw < 3) continue;
    ctx.setLineDash(g.ghost === 'new' ? [5, 4] : []);
    ctx.strokeStyle = g.ghost === 'gone' ? STATUS.critical : STATUS.good;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx + 0.75, sy + 0.75, sw - 1.5, sh - 1.5);
    if (sw > 50 && sh > 16) {
      ctx.font = `600 ${clamp(sh * 0.2, 10, 13)}px ${UI_FONT}`;
      const label = fitText(ctx, `${g.ghost === 'gone' ? 'deleted' : 'new'} · ${g.name}`, sw - 10);
      if (label) haloText(ctx, label, sx + 6, sy + Math.min(sh / 2, 14), g.ghost === 'gone' ? STATUS.critical : STATUS.good, th);
    }
  }
  ctx.setLineDash([]);
  if (state.model?.preview && state.base) {
    const before = new Set(state.base.nodes.filter((n) => n.kind === 'file').map((n) => n.key));
    ctx.strokeStyle = STATUS.good;
    ctx.lineWidth = 2;
    for (const [id, r] of lay.rect) {
      const n = state.T.N[id];
      if (n.kind !== 'file' || before.has(n.key)) continue;
      const [sx, sy] = toScreen(r.x, r.y);
      if (r.w * k > 3) ctx.strokeRect(sx, sy, r.w * k, r.h * k);
    }
  }
  ctx.restore();
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

// Code text or minimap bars for one file. `view` maps layout units to the
// canvas ({ k, x, y }); the City passes a roof plane's view with the canvas
// transform set to that plane. Options: `only` (line indexes to draw, skips
// screen culling), `vlh` (on-screen line height for the text threshold),
// `mini` (force bars), `roof` (no symbol labels).
function inkCode(ctx, id, c, text, lhPx, quiet = false, view = state.t, opts = {}) {
  const th = theme();
  const T = state.T, lay = state.lay;
  const { k, x: tx, y: ty } = view;
  const cwPx = CODE.cw * lhPx;
  const gutPx = CODE.gut * cwPx;
  const tokens = th.tokens;
  const textMode = !opts.mini && (opts.vlh ?? lhPx) >= 7.5;
  const fontPx = Math.min(lhPx * 0.84, cwPx / monoRatio);
  const issues = T.issuesOf;
  const key = T.N[id].key;
  const marks = new Map();
  walk(id, (x) => { for (const i of issues[x]) { const iss = state.model.issues[i]; if (iss.waived && !state.showWaived) continue; const prev = marks.get(iss.line); if (!prev || LEVEL_RANK[iss.level] > LEVEL_RANK[prev]) marks.set(iss.line, iss.level); } });
  const sel = selIds();
  const picked = sel.filter((s) => T.fileOf[s] === id && s !== id).map((s) => T.N[s]);
  const ranges = state.set.ranges.filter((r) => r[0] === key);
  if (R.rangeDrag?.file === id) ranges.push([key, Math.min(R.rangeDrag.from, R.rangeDrag.to), Math.max(R.rangeDrag.from, R.rangeDrag.to)]);
  // Call sites: → on lines that link out, ←n on declarations others link to.
  let outs = null, ins = null;
  if (textMode) {
    const sites = state.sites.get(key);
    if (!sites) wantSites(key);
    else {
      outs = new Set(sites.out.filter((x) => x.kind !== 'copy').map((x) => x.line));
      ins = new Map();
      for (const x of sites.in) { const t = idOf(x.to); const line = t >= 0 ? T.N[t].from ?? 0 : 0; if (line && x.kind !== 'copy') ins.set(line, (ins.get(line) ?? 0) + 1); }
    }
  }
  const hoverHere = state.hover >= 0 && T.fileOf[state.hover] === id;
  for (let j = 0; j < c.cols; j++) {
    const colX = (c.x + j * (c.colW + c.gap)) * k + tx;
    const colY = c.y * k + ty;
    const colW = c.colW * k;
    let r0 = 0, r1 = c.rows;
    if (!opts.only) {
      if (colX > R.W || colX + colW < 0) continue;
      r0 = Math.max(0, Math.floor(-colY / lhPx));
      r1 = Math.min(c.rows, Math.ceil((R.H - colY) / lhPx));
    }
    if (r0 >= r1) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(colX, colY + r0 * lhPx, colW, (r1 - r0) * lhPx);
    ctx.clip();
    if (textMode) ctx.font = `${fontPx}px ${MONO_FONT}`;
    for (let r = r0; r < r1; r++) {
      const li = j * c.rows + r;
      if (li >= text.lines.length) break;
      if (opts.only && !opts.only.has(li)) continue;
      const y = colY + r * lhPx;
      const line = li + 1;
      const inRange = ranges.some((g) => line >= g[1] && line <= g[2]);
      if (inRange || picked.some((s) => line >= s.from && line <= s.to) || (line === state.hoverLine && hoverHere)) {
        ctx.fillStyle = css(rgb(th.accent), inRange ? 0.2 : line === state.hoverLine && hoverHere ? 0.16 : 0.09);
        ctx.fillRect(colX, y, colW, lhPx);
        if (inRange) { ctx.fillStyle = th.accent; ctx.fillRect(colX, y, Math.max(2, cwPx * 0.35), lhPx); }
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
        const inN = ins?.get(line), out = outs?.has(line);
        if (inN || out) {
          const mark = `${out ? '→' : ''}${inN ? `←${inN}` : ''}`;
          const mx = colX + colW - (mark.length + 0.6) * cwPx * scale;
          ctx.fillStyle = th.halo;
          ctx.fillRect(mx - cwPx * 0.3, y + lhPx * 0.08, (mark.length + 0.6) * cwPx * scale, lhPx * 0.84);
          if (out) { ctx.fillStyle = th.series[0]; ctx.fillText('→', mx, y + lhPx * 0.55); }
          if (inN) { ctx.fillStyle = th.series[1]; ctx.fillText(`←${inN}`, mx + (out ? cwPx * scale : 0), y + lhPx * 0.55); }
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
  if (!textMode && lhPx >= 1.6 && !quiet && !opts.roof) {
    const taken = [];
    for (const it of lay.pieces?.get(id) ?? []) {
      const ph = it.h * k;
      if (ph < 16 || !it.first) continue;
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
    R.bandHits = [];
    for (const b of lay.bands) {
      const [, y0] = toScreen(0, b.y0);
      const [, y1] = toScreen(0, b.y1);
      if (y1 < 0 || y0 > R.H) continue;
      ctx.fillStyle = css(rgb(th.ink3), 0.06);
      ctx.fillRect(0, y0, R.W, y1 - y0);
      ctx.fillStyle = th.ink3;
      const label = `${b.level === 0 ? 'Level 0 · base' : `Level ${b.level}`}  ·  ${b.count}`;
      const lx = viewport().x + 12, ly = (y0 + y1) / 2;
      const w = textWidth(ctx, label);
      if (R.hoverBand === b.level) { ctx.fillStyle = css(rgb(th.accent), 0.16); ctx.beginPath(); ctx.roundRect(lx - 5, ly - 10, w + 10, 20, 5); ctx.fill(); }
      ctx.fillStyle = R.hoverBand === b.level ? th.ink : th.ink3;
      ctx.fillText(label, lx, ly);
      R.bandHits.push({ level: b.level, x: lx - 5, y: ly - 10, w: w + 10, h: 20 });
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
  if (lay.kind === 'city') { city.focus(ctx, now); return; }
  const round = lay.kind === 'graph';
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
  // Members drawn by grow get thinner outlines the more hops away they are.
  const hops = state.set.hops ?? {};
  for (const id of selIds()) strokeRects(ctx, rectsOf(id), th.accent, hopWidth(hops[node(id).key]), round);
  if (state.hover > 0) strokeRects(ctx, rectsOf(state.hover), css(rgb(th.ink), 0.75), 1.4, round);
  if (R.dropOn > 0) strokeRects(ctx, rectsOf(R.dropOn), STATUS.good, 2.5, round);
  inkGrip(ctx);
}

const hopWidth = (hop) => (hop ? Math.max(1.1, 2.2 - 0.4 * hop) : 2.2);

function inkGrip(ctx) {
  const th = theme();
  const grip = gripRect();
  if (!grip) return;
  ctx.fillStyle = th.accent;
  ctx.beginPath();
  ctx.roundRect(grip.x, grip.y, grip.w, grip.h, 5);
  ctx.fill();
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) ctx.fillRect(grip.x + grip.w / 2 - 3 + j * 4, grip.y + grip.h / 2 - 5 + i * 4, 2, 2);
}

// Arrowheads at 92% along each bright link (600 at most, heaviest first),
// and the hovered link drawn thicker. Changes-with links have no direction.
function inkLinks(ctx) {
  if (R.morph || !state.linkList?.length) return;
  const list = linkScreens();
  const city3d = state.lay.kind === 'city';
  const quiet = readingCode() ? 0.45 : 1;
  let drawn = 0;
  for (const { e, xy } of [...list].sort((p, q) => q.e.w - p.e.w)) {
    if (drawn >= 600) break;
    if (e.kind === 'change' && e.kinds?.size === 1) continue;
    const n = xy.length / 2;
    if (n < 2) continue;
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(xy[i * 2] - xy[i * 2 - 2], xy[i * 2 + 1] - xy[i * 2 - 1]);
    if (total < 14) continue;
    let goal = total * 0.92, i = 1;
    for (; i < n; i++) {
      const seg = Math.hypot(xy[i * 2] - xy[i * 2 - 2], xy[i * 2 + 1] - xy[i * 2 - 1]);
      if (goal <= seg) break;
      goal -= seg;
    }
    if (i >= n) i = n - 1;
    const ax = xy[i * 2 - 2], ay = xy[i * 2 - 1], bx = xy[i * 2], by = xy[i * 2 + 1];
    const seg = Math.hypot(bx - ax, by - ay) || 1;
    const t = Math.min(1, goal / seg);
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
    if (x < -10 || y < -10 || x > R.W + 10 || y > R.H + 10) continue;
    if (city3d) {
      const p = e.pts[i - 1], q = e.pts[i];
      if (city.hidden(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t)) continue;
    }
    const dx = (bx - ax) / seg, dy = (by - ay) / seg;
    const size = e.dir === 'pick' ? 9 : 7;
    ctx.fillStyle = css(e.color ?? rgb(theme().accent), quiet);
    ctx.beginPath();
    ctx.moveTo(x + dx * size * 0.6, y + dy * size * 0.6);
    ctx.lineTo(x - dx * size * 0.6 - dy * size * 0.45, y - dy * size * 0.6 + dx * size * 0.45);
    ctx.lineTo(x - dx * size * 0.6 + dy * size * 0.45, y - dy * size * 0.6 - dx * size * 0.45);
    ctx.closePath();
    ctx.fill();
    drawn++;
  }
  const hv = state.hoverLink && list.find((x) => x.e === state.hoverLink);
  if (hv) {
    ctx.strokeStyle = css(hv.e.color ?? rgb(theme().accent), 0.95);
    ctx.lineWidth = 3.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < hv.xy.length; i += 2) (i ? ctx.lineTo(hv.xy[i], hv.xy[i + 1]) : ctx.moveTo(hv.xy[i], hv.xy[i + 1]));
    ctx.stroke();
  }
}

function inkDrag(ctx) {
  const th = theme();
  const d = R.drag;
  ctx.font = `600 12px ${UI_FONT}`;
  const target = R.dropOn > 0 ? ` → ${node(R.dropOn).name}${node(R.dropOn).kind === 'file' ? '' : '/'}` : '';
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

// Link sites for a file (file.links), cached per model.
function wantSites(key) {
  if (state.sites.has(key) || state.wantedSites.has(key)) return;
  state.wantedSites.add(key);
  wire.ask('file.links', { key }).then((d) => { if (d?.error) state.sites.set(key, { key, out: [], in: [] }); state.wantedSites.delete(key); });
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

// What is under a screen point: { id, line, gutter, mark } for a part (and
// the code line under the pointer), { link } for a drawn link, or null.
// Symbols and towers win over links; links win over folders, files, lots.
function pickAt(sx, sy, { links = true, tol = 5 } = {}) {
  const lay = state.lay;
  const T = state.T;
  if (!lay || !T) return null;
  const linkHit = () => { const e = links && state.links !== 'none' || state.set.links.length ? pickLink(sx, sy, tol) : null; return e ? { link: e } : null; };
  if (lay.kind === 'city') {
    const hit = city.pick(sx, sy);
    if (hit && (hit.part === 'tower' || hit.part === 'podium')) return hit;
    return (links && linkHit()) || hit;
  }
  const [wx, wy] = toWorld(sx, sy);
  if (lay.kind === 'map') {
    let id = 0;
    let found = true;
    let head = false;
    while (found) {
      found = false;
      for (const c of T.kids[id]) {
        const k = T.N[c].kind;
        if (k !== 'repo' && k !== 'dir' && k !== 'file') continue;
        const r = lay.rect.get(c);
        if (r && wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) { id = c; found = k !== 'file'; head = wy <= r.y + r.head; break; }
      }
    }
    if (id <= 0) return (links && linkHit()) || null;
    // Names win over links: bundled links pass through folder headers.
    if (head) return { id };
    if (T.N[id].kind !== 'file') return (links && linkHit()) || { id };
    const c = lay.code.get(id);
    let line = 0, gutter = false, mark = false;
    if (c && wy >= c.y) {
      const col = Math.floor((wx - c.x) / (c.colW + c.gap));
      const row = Math.floor((wy - c.y) / c.lh);
      if (col >= 0 && col < c.cols && row >= 0 && row < c.rows) {
        line = col * c.rows + row + 1;
        const inCol = wx - c.x - col * (c.colW + c.gap);
        gutter = inCol >= 0 && inCol < CODE.gut * CODE.cw * c.lh;
        mark = inCol > c.colW - 5 * CODE.cw * c.lh && inCol <= c.colW;
      }
      if (line > T.N[id].lines) line = 0;
    }
    const list = lay.pieces.get(id) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (wx >= p.x - c.lh * 2 && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h) return { id: p.id, line, gutter, mark };
    }
    return (links && linkHit()) || { id, line, gutter, mark };
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
    return best ? { id: best } : (links && linkHit()) || null;
  }
  for (const [id, r] of lay.rect) {
    if (wx >= r.x - reach && wx <= r.x + r.w + reach && wy >= r.y - reach && wy <= r.y + r.h + reach) {
      const d = Math.hypot(Math.max(r.x - wx, 0, wx - r.x - r.w), Math.max(r.y - wy, 0, wy - r.y - r.h));
      if (d < bestD) { bestD = d; best = id; }
    }
  }
  return best ? { id: best } : (links && linkHit()) || null;
}

// ───────────────────────────── View control ─────────────────────────────

let zoom;
function setupZoom() {
  const el = $('#view');
  zoom = d3.zoom()
    .scaleExtent([0.001, 1000])
    .filter((e) => {
      if (e.type === 'dblclick') return false;
      if (e.type === 'mousedown' && (e.shiftKey || e.altKey || e.button !== 0 || R.gripHit)) return false;
      if (e.type === 'touchstart' && R.drag) return false;
      return true;
    })
    .on('start', () => { el.classList.add('grab'); })
    .on('zoom', (e) => { state.t = e.transform; hideTip(); if (state.lay?.kind === 'city') city.viewChanged(); requestDraw(); })
    .on('end', () => { el.classList.remove('grab'); if (state.lay?.kind === 'city') city.viewChanged(true); drawCrumbs(); });
  d3.select(el).call(zoom).on('dblclick.zoom', null);
}

function setZoomRange() {
  const lay = state.lay;
  if (!lay) return;
  const b = lay.bounds;
  const fit = Math.min(R.W / Math.max(b.w, 1), R.H / Math.max(b.h, 1));
  let max = fit * 60;
  const code = lay.kind === 'city' ? lay.map.code : lay.code;
  if (code) {
    let minLh = Infinity;
    for (const c of code.values()) minLh = Math.min(minLh, c.lh);
    max = Math.max(fit * 8, 26 / (minLh || 1));
  }
  zoom.scaleExtent([fit * 0.35, Math.max(max, fit * 4)]);
}

function viewport() {
  const left = !state.narrow && state.dock ? 368 + 20 : 0;
  const right = !state.narrow && !$('#info').hidden ? 344 + 20 : 0;
  const top = 64, bottom = state.narrow ? (state.sheet ? window.innerHeight * 0.6 + 56 : 96) : 52 + (setEmpty() ? 0 : 52);
  return { x: left, y: top, w: Math.max(120, R.W - left - right), h: Math.max(120, R.H - top - bottom) };
}

// Fit a box (layout units; `z` and `d` give its height range in City) into
// the free part of the screen, at the camera's resting angles: its 8 corners
// are projected and their screen bounds fitted.
function fitBox(box, pad = 0.9, ms = 650, minK = 0) {
  const v = viewport();
  const { pitch, yaw } = camAngles();
  const A = affine({ k: 1, x: 0, y: 0 }, pitch, yaw, R.pivot);
  const z0 = box.z ?? 0, z1 = z0 + (box.d ?? 0);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const x of [box.x, box.x + box.w]) for (const y of [box.y, box.y + box.h]) for (const z of [z0, z1]) {
    const sx = A.O[0] + x * A.u[0] + y * A.v[0] + z * A.w[0], sy = A.O[1] + x * A.u[1] + y * A.v[1] + z * A.w[1];
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  let k = Math.min(v.w * pad / Math.max(x1 - x0, 1e-6), v.h * pad / Math.max(y1 - y0, 1e-6));
  const [lo, hi] = zoom.scaleExtent();
  k = clamp(Math.max(k, minK), lo, hi);
  const t = d3.zoomIdentity.translate(v.x + v.w / 2 - k * (x0 + x1) / 2, v.y + v.h / 2 - k * (y0 + y1) / 2).scale(k);
  const sel = d3.select('#view');
  if (ms && !reduced()) sel.transition().duration(ms).ease(d3.easeCubicInOut).call(zoom.transform, t);
  else sel.interrupt().call(zoom.transform, t);
}

const fitRect = (r, pad = 0.9, ms = 650, minK = 0) => fitBox(r, pad, ms, minK);

function fitAll(ms = 650) {
  const lay = state.lay;
  if (!lay) return;
  fitBox({ ...lay.bounds, z: 0, d: lay.kind === 'city' ? lay.top * 0.6 : 0 }, 0.94, ms);
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
  if (lay.kind === 'city') { city.flyTo(id, ms); return; }
  const r = lay.rect.get(id) ?? lay.rect.get(liftTo(id, detailRank()));
  if (r) fitRect({ x: r.x - r.w * 3, y: r.y - r.h * 3, w: r.w * 7, h: r.h * 7 }, 0.9, ms);
}

// Fly to one code line and pick it as a range.
function flyToLine(fileId, line) {
  const lay = state.lay;
  const T = state.T;
  const owner = S.ownerOfLine(T.I, fileId, line);
  if (lay.kind === 'map') {
    const c = lay.code.get(fileId);
    const at = siteAnchor(fileId, line);
    if (c && at) fitRect({ x: at[0] - c.lh * 6, y: at[1] - c.lh * 8, w: c.colW + c.lh * 8, h: c.lh * 16 }, 0.92, 650, 13 / c.lh);
  } else flyTo(owner);
  return owner;
}

// A selected file or folder shows a grip on its header, a selected type or
// function on its band (or its roof in City); drag it to move.
function gripRect() {
  const lay = state.lay;
  if (!lay || state.set.nodes.length !== 1 || state.set.links.length || state.set.ranges.length) return null;
  if (lay.kind === 'city') return city.grip();
  if (lay.kind !== 'map') return null;
  const id = idOf(state.set.nodes[0]);
  const n = node(id);
  if (!n) return null;
  const { k } = state.t;
  if (n.kind === 'file' || n.kind === 'dir') {
    const r = lay.rect.get(id);
    if (!r) return null;
    const hp = r.head * k;
    if (hp < 9 || r.w * k < 50) return null;
    const [sx, sy] = toScreen(r.x + r.w, r.y);
    const size = clamp(hp * 0.8, 16, 26);
    return { x: sx - size - 4, y: sy + (hp - size) / 2, w: size, h: size, id };
  }
  if (!['type', 'func', 'space', 'part'].includes(n.kind)) return null;
  const p = lay.pieces.get(state.T.fileOf[id])?.find((it) => it.id === id);
  if (!p || p.w * k < 40 || p.h * k < 4) return null;
  const [sx, sy] = toScreen(p.x + p.w, p.y + p.h / 2);
  const size = clamp(p.h * k * 0.8, 14, 22);
  return { x: sx - size - 3, y: sy - size / 2, w: size, h: size, id };
}

// Where a dragged part would land: folders for files and folders, files for
// types and functions.
function dropTarget(sx, sy, dragId) {
  const drag = node(dragId);
  if (state.lay.kind === 'city') return city.dropTarget(sx, sy, dragId);
  const hit = pickAt(sx, sy, { links: false });
  let target = hit?.id ?? -1;
  if (['type', 'func', 'space', 'part'].includes(drag.kind)) {
    target = target > 0 ? state.T.fileOf[target] : -1;
    return target > 0 && target !== state.T.fileOf[dragId] ? target : -1;
  }
  while (target > 0 && !['dir', 'repo'].includes(node(target).kind)) target = node(target).up;
  return target > 0 && !isUnder(target, dragId) && target !== drag.up ? target : -1;
}

function setupPointer() {
  const el = $('#view');
  let down = null, lastTap = null, press = 0;
  const touches = new Map();
  const twistAngle = () => { const [a, b] = [...touches.values()]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  el.addEventListener('pointerdown', (e) => {
    const g = gripRect();
    R.gripHit = !!(g && e.offsetX >= g.x && e.offsetX <= g.x + g.w && e.offsetY >= g.y && e.offsetY <= g.y + g.h);
    down = { x: e.offsetX, y: e.offsetY, t: performance.now(), type: e.pointerType, moved: false };
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (touches.size === 2 && state.lay?.kind === 'city') { R.twist = { angle: twistAngle(), yaw: R.yaw }; city.orbitStart(); }
    }
    const orbit = state.lay?.kind === 'city' && e.pointerType === 'mouse' && (e.button === 2 || (e.button === 0 && e.altKey));
    if (orbit) {
      city.orbitStart();
      R.orbit = { x: e.offsetX, y: e.offsetY, yaw: R.yaw, pitch: R.pitch };
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (R.gripHit) {
      R.drag = { id: g.id, x: e.offsetX, y: e.offsetY };
      el.setPointerCapture(e.pointerId);
      el.classList.add('drop');
      requestDraw();
    } else if (e.shiftKey && e.pointerType === 'mouse') {
      const hit = pickAt(e.offsetX, e.offsetY, { links: false });
      const f = hit?.id > 0 ? state.T.fileOf[hit.id] : -1;
      if (hit?.line && f >= 0 && readable(f) && !hit.gutter) R.rangeDrag = { file: f, from: hit.line, to: hit.line, x: e.offsetX, y: e.offsetY };
      else R.box = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY };
      el.setPointerCapture(e.pointerId);
    }
    clearTimeout(press);
    if (e.pointerType === 'touch') {
      press = setTimeout(() => {
        if (!down || down.moved) return;
        const hit = pickAt(down.x, down.y, { tol: 12 });
        if (hit?.link) { hub.emit('pick.link', { link: hit.link, add: true }); down.moved = true; navigator.vibrate?.(10); }
        else if (hit?.id) { hub.emit('pick.set', { ids: [hit.id], add: true }); down.moved = true; navigator.vibrate?.(10); }
      }, 520);
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 6) down.moved = true;
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (R.twist && touches.size === 2) {
        let d = twistAngle() - R.twist.angle;
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        if (Math.abs(d) > 0.05) { R.yaw = R.twist.yaw + d; R.orbitAt = performance.now(); state.angle = 'custom'; city.viewChanged(); requestDraw(); }
      }
      if (touches.size > 1) return;
    }
    if (R.orbit) {
      R.yaw = R.orbit.yaw + (e.offsetX - R.orbit.x) * 0.008;
      R.pitch = clamp(R.orbit.pitch + (e.offsetY - R.orbit.y) * 0.006, 0, 1.35);
      R.orbitAt = performance.now();
      R.cam = null;
      state.angle = 'custom';
      city.viewChanged();
      requestDraw();
      return;
    }
    if (R.drag) {
      R.drag.x = e.offsetX; R.drag.y = e.offsetY;
      R.dropOn = dropTarget(e.offsetX, e.offsetY, R.drag.id);
      requestDraw();
      return;
    }
    if (R.rangeDrag) {
      const hit = pickAt(e.offsetX, e.offsetY, { links: false });
      if (hit?.line && state.T.fileOf[hit.id] === R.rangeDrag.file) R.rangeDrag.to = hit.line;
      requestDraw();
      return;
    }
    if (R.box) { R.box.x1 = e.offsetX; R.box.y1 = e.offsetY; requestDraw(); return; }
    if (e.pointerType !== 'mouse' || e.buttons) return;
    hoverAt(e.offsetX, e.offsetY, e.clientX, e.clientY);
  });
  const lift = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2 && R.twist) { R.twist = null; city.viewChanged(true); }
  };
  el.addEventListener('pointercancel', lift);
  el.addEventListener('pointerleave', () => { if (!R.drag && !R.orbit) { hub.emit('pick.hover', { id: -1 }); hideTip(); } });
  el.addEventListener('pointerup', (e) => {
    clearTimeout(press);
    lift(e);
    if (R.orbit) { R.orbit = null; city.viewChanged(true); down = null; return; }
    if (R.drag) {
      const drag = R.drag;
      const target = R.dropOn;
      R.drag = null; R.dropOn = -1; R.gripHit = false;
      el.classList.remove('drop');
      requestDraw();
      if (target > 0) askMove(drag.id, target, e.clientX, e.clientY);
      return;
    }
    R.gripHit = false;
    if (R.rangeDrag) {
      const r = R.rangeDrag;
      R.rangeDrag = null;
      requestDraw();
      if (down?.moved || r.from !== r.to) { hub.emit('pick.range', { file: r.file, from: Math.min(r.from, r.to), to: Math.max(r.from, r.to), add: e.ctrlKey || e.metaKey }); down = null; return; }
    }
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
    const band = state.lay?.kind === 'layers' && R.bandHits?.find((b) => e.offsetX >= b.x && e.offsetX <= b.x + b.w && e.offsetY >= b.y && e.offsetY <= b.y + b.h);
    if (band) { selectLevel(band.level); down = null; return; }
    const hit = pickAt(e.offsetX, e.offsetY, { tol: e.pointerType === 'touch' ? 12 : 5 });
    const now = performance.now();
    const twice = lastTap && now - lastTap.t < 340 && Math.hypot(lastTap.x - e.offsetX, lastTap.y - e.offsetY) < 12;
    lastTap = twice ? null : { t: now, x: e.offsetX, y: e.offsetY };
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const T = state.T;
    if (twice) {
      if (hit?.id) {
        const f = T.fileOf[hit.id];
        // Zooming past reading means "open": a part already readable opens in the Code sheet.
        if (f >= 0 && readable(f) && selIds().includes(hit.id)) { openCode(hit.id); down = null; return; }
        hub.emit('pick.set', { ids: [hit.id], line: hit.line });
        flyTo(hit.id);
      } else if (!hit?.link) fitAll();
    } else if (hit?.link) hub.emit('pick.link', { link: hit.link, add, bundle: e.altKey });
    else if (hit?.id && hit.line && T.fileOf[hit.id] >= 0 && readable(T.fileOf[hit.id]) && (hit.gutter || hit.mark)) {
      const f = T.fileOf[hit.id];
      const marks = hit.mark ? siteMembers(f, hit.line) : [];
      if (marks.length) hub.emit('pick.links', { links: marks, add });
      else if (e.shiftKey) {
        const last = [...state.set.ranges].reverse().find((r) => r[0] === T.N[f].key);
        const anchor = last ? (hit.line < last[1] ? last[2] : last[1]) : hit.line;
        hub.emit('pick.range', { file: f, from: Math.min(anchor, hit.line), to: Math.max(anchor, hit.line), replaceLast: !!last });
      } else hub.emit('pick.range', { file: f, from: hit.line, to: hit.line, add: e.ctrlKey || e.metaKey });
    } else if (hit?.id) hub.emit('pick.set', { ids: [hit.id], add, line: hit.line });
    else hub.emit('pick.clear');
    down = null;
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Link members for a code line's call-site marks: what the line links to,
// and (on a declaration) what links to it.
function siteMembers(fileId, line) {
  const T = state.T;
  const sites = state.sites.get(T.N[fileId].key);
  if (!sites) return [];
  const out = [];
  const seen = new Set();
  const add = (l) => { const k = S.linkKey(l); if (!seen.has(k)) { seen.add(k); out.push(l); } };
  for (const x of sites.out) if (x.line === line && x.kind !== 'copy') add([x.from, x.to, x.kind]);
  for (const x of sites.in) { const t = idOf(x.to); if (t >= 0 && T.N[t].from === line && T.fileOf[t] === fileId && x.kind !== 'copy') add([x.from, x.to, x.kind]); }
  return out;
}

let hoverTimer = 0;
function hoverAt(sx, sy, cx, cy) {
  cancelAnimationFrame(hoverTimer);
  hoverTimer = requestAnimationFrame(() => {
    const hit = pickAt(sx, sy);
    if (hit?.link) {
      if (state.hoverLink !== hit.link) { state.hoverLink = hit.link; requestDraw(); }
      if (state.hover !== -1) hub.emit('pick.hover', { id: -1 });
      showLinkTip(hit.link, cx, cy);
      $('#view').classList.add('point');
      return;
    }
    if (state.hoverLink) { state.hoverLink = null; requestDraw(); }
    const id = hit?.id ?? -1;
    const line = hit?.line ?? 0;
    const f = id > 0 ? state.T.fileOf[id] : -1;
    const site = line && f >= 0 && readable(f) && siteMembers(f, line).length ? { file: f, line } : null;
    const siteChanged = (site?.line ?? 0) !== (state.hoverSite?.line ?? 0) || site?.file !== state.hoverSite?.file;
    if (id !== state.hover || line !== state.hoverLine || siteChanged) hub.emit('pick.hover', { id, line, site });
    if (id > 0) showTip(id, line, cx, cy); else hideTip();
    $('#view').classList.toggle('point', id > 0);
  });
}

function boxSelect(b, add) {
  const lay = state.lay;
  if (!lay) return;
  let ids = [];
  if (lay.kind === 'city') ids = city.boxSelect(b);
  else {
    const [x0, y0] = toWorld(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1));
    const [x1, y1] = toWorld(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
    for (const [id, r] of lay.rect) {
      if (r.x >= x0 && r.y >= y0 && r.x + r.w <= x1 && r.y + r.h <= y1) {
        const n = node(id);
        if (lay.kind === 'map' && n.up > 0 && (() => { const pr = lay.rect.get(n.up); return pr && pr.x >= x0 && pr.y >= y0 && pr.x + pr.w <= x1 && pr.y + pr.h <= y1; })()) continue;
        ids.push(id);
      }
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
  placeTip(tip, cx, cy);
}

function showLinkTip(e, cx, cy) {
  const tip = $('#tip');
  if (state.narrow) return;
  const kinds = [...e.kinds].filter((k) => k !== 'dim').map((k) => LINK_NAMES[k] ?? k);
  const arrow = e.kind === 'change' ? '↔' : '→';
  const dir = { out: 'uses', in: 'used by', inside: 'inside the set', pick: 'selected' }[e.dir];
  tip.replaceChildren(
    h('b', null, `${nameOf(e.a)} ${arrow} ${nameOf(e.b)}`),
    h('div', { class: 'muted' }, [kinds.join(', '), e.w > 1 ? `×${fmt(e.w)}` : '', dir].filter(Boolean).join(' · ')),
    h('div', { class: 'nums' }, h('span', null, 'Click to select · Alt+click for the folders around it')),
  );
  placeTip(tip, cx, cy);
}

function placeTip(tip, cx, cy) {
  tip.hidden = false;
  const w = tip.offsetWidth, hh = tip.offsetHeight;
  const v = viewport();
  // Keep the tip over the canvas: flip to the cursor's left before it would
  // cover the Selection panel or run off the screen.
  const right = Math.min(window.innerWidth - 8, cx < v.x + v.w ? v.x + v.w : window.innerWidth - 8);
  tip.style.left = `${Math.max(8, cx + 16 + w <= right ? cx + 16 : cx - 16 - w)}px`;
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
  document.body.classList.toggle('city', state.layout === 'city');
  const tools = $('#tools');
  tools.replaceChildren(...[
    seg(LAYOUTS, state.layout, (id) => hub.emit('view.layout', id), { cls: 'wide', title: 'Layout' }),
    picker(DETAILS, state.detail, (id) => hub.emit('view.detail', id), { label: 'Detail', cls: 'wide opt' }),
    picker(PAINTS, state.paint, (id) => hub.emit('view.paint', id), { label: 'Color', cls: 'wide opt' }),
    state.layout === 'city' ? picker(HEIGHTS, state.height, (id) => hub.emit('view.height', id), { label: 'Height', cls: 'wide opt' }) : null,
    seg(LINK_MODES, state.links, (id) => hub.emit('view.links', id), { label: 'Links', cls: 'wide opt' }),
    h('button', { class: 'icon-btn wide view-btn', title: 'View options', 'aria-label': 'View options', 'aria-pressed': String(state.dock === 'view'), onclick: () => hub.emit('dock.show', state.dock === 'view' ? 'check' : 'view') }, icon('view')),
    h('button', { class: 'icon-btn wide', title: 'Fit all (F)', 'aria-label': 'Fit all', onclick: () => fitAll() }, icon('fit')),
    h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: () => hub.emit('box.open', 'setup') }, icon('setup')),
    h('button', { class: 'icon-btn wide', title: 'Keys and help (?)', 'aria-label': 'Help', onclick: () => hub.emit('box.open', 'keys') }, icon('help')),
  ].filter(Boolean));
  const tabs = $('#tabs');
  const tab = (id, name, ic) => h('button', { 'aria-pressed': String(state.sheet === id), onclick: () => hub.emit('sheet.toggle', id) }, icon(ic), name);
  tabs.replaceChildren(tab('view', 'View', 'view'), tab('check', 'Check', 'check'), tab('change', 'Change', 'change'), tab('info', 'Selection', 'info'));
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

const findNodes = (q) => (state.T ? S.findByName(state.T.I, q) : []);
const detailName = () => DETAILS.find((d) => d.id === state.detail)?.name.toLowerCase() ?? 'parts';

function highlight(name, q) {
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return name;
  return [name.slice(0, i), h('mark', null, name.slice(i, i + q.length)), name.slice(i + q.length)];
}

// Run the current query: plain words fuzzy-match names; filters (kind:,
// in:, cx>10 …) pick parts at the current Detail. `>` lists actions.
function runFind(q) {
  state.found = null;
  if (!q || !state.T) return null;
  const parsed = S.parseQuery(q);
  if (parsed.actions) { state.found = { query: q, parsed, ids: [] }; return null; }
  const ids = parsed.errors.length && !parsed.filters.length && !parsed.words.length ? [] : S.matchQuery({ I: state.T.I, rank: detailRank(), stageIndex: state.stageIndex }, parsed);
  state.found = { query: q, parsed, ids };
  if (parsed.filters.length) return new Set(ids.slice(0, 20000));
  return parsed.words.length ? new Set(findNodes(parsed.words.join(' ')).slice(0, 400)) : null;
}

function selectFound() {
  const f = state.found;
  if (!f?.ids.length) { toast('Nothing to select.'); return; }
  setFrom(f.ids, { recipe: [{ query: f.query, rank: detailRank() }] });
  $('#find-box').value = '';
  hub.emit('find.query', '');
  $('#find-box').blur();
}

function drawFind() {
  const list = $('#find-list');
  const q = state.query;
  const focused = document.activeElement === $('#find-box');
  const rows = [];
  let index = 0;
  const item = (props, ...kids) => { const i = index++; return h('button', { class: 'hit', role: 'option', 'aria-selected': String(i === state.findPick), ...props }, ...kids); };
  if (!q) {
    if (!focused || !state.saved.length) { list.hidden = true; return; }
    rows.push(h('h4', null, 'Sets'));
    for (const st of state.saved.slice(0, 40)) rows.push(item({ onclick: () => loadSet(st) }, icon('save'), h('span', { class: 'name' }, st.name), h('span', { class: 'where' }, `${S.setSummary(st)} · ${st.repo}`)));
    rows.push(h('div', { class: 'help' }, 'Type a name, or a query like ', h('code', null, 'kind:func cx>10'), '. Start with ', h('code', null, '>'), ' for actions.'));
    list.replaceChildren(...rows);
    list.hidden = false;
    return;
  }
  const parsed = state.found?.parsed ?? S.parseQuery(q);
  if (parsed.actions) {
    const text = parsed.words[0]?.toLowerCase() ?? '';
    rows.push(h('h4', null, `Actions · ${S.setSummary(state.set)}`));
    const acts = actions().map((a) => [a, text ? S.nameScore(a.name, text) : 0]).filter(([, s]) => s >= 0).sort((x, y) => (text ? y[1] - x[1] : 0));
    for (const [a] of acts) {
      const reason = whyNot(a);
      rows.push(item({ class: `hit${reason ? ' off' : ''}`, 'aria-disabled': reason ? 'true' : null, title: reason ?? a.about ?? '', onclick: () => { if (reason) { toast(reason); return; } closeFind(); runAct(a.id); } },
        icon(a.icon ?? (a.agent ? 'change' : 'chev')), h('span', { class: 'name' }, highlight(a.name, text)), h('span', { class: 'where' }, reason ?? (a.key ? a.key : a.about ?? ''))));
    }
    if (!acts.length) rows.push(h('div', { class: 'empty' }, 'No action by that name.'));
    list.replaceChildren(...rows);
    list.hidden = false;
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (parsed.errors.length) rows.push(h('div', { class: 'help error' }, h('b', null, parsed.errors.join(' ')), h('div', null, S.QUERY_HELP)));
  const ids = state.found?.ids ?? [];
  const kindF = parsed.filters.find((f) => f.type === 'kind');
  const what = kindF ? kindF.kinds.map((k) => KIND_NAME[k] + 's').join(', ') : detailName();
  if (ids.length) rows.push(item({ onclick: selectFound, title: 'Select all (Alt+Enter)' }, icon('plus'), h('span', { class: 'name' }, `Select all · ${fmt(ids.length)} ${what}`), h('span', { class: 'where' }, 'Alt+Enter')));
  if (parsed.filters.length) {
    rows.push(h('h4', null, `${fmt(ids.length)} part${ids.length === 1 ? '' : 's'} match`));
    for (const id of ids.slice(0, 60)) {
      const n = node(id);
      rows.push(item({ onclick: () => pickFound(id), onmouseenter: () => hub.emit('pick.hover', { id }) },
        h('span', { class: 'dot', style: { background: css(paintOf(id)) } }),
        h('span', { class: 'name' }, parsed.words.length ? highlight(nameOf(id), parsed.words[0]) : nameOf(id)),
        h('span', { class: 'where' }, where(id))));
    }
    if (!ids.length && !parsed.errors.length) rows.push(h('div', { class: 'empty' }, 'Nothing matches.'));
  } else if (parsed.words.length) {
    const word = parsed.words.join(' ');
    const hits = findNodes(word);
    const groups = [['Files', (n) => n.kind === 'file'], ['Types', (n) => n.kind === 'type' || n.kind === 'space'], ['Functions', (n) => n.kind === 'func'], ['Folders', (n) => n.kind === 'dir' || n.kind === 'repo'], ['Sections', (n) => n.kind === 'part']];
    for (const [title, test] of groups) {
      const shown = hits.filter((id) => test(node(id))).slice(0, 8);
      if (!shown.length) continue;
      rows.push(h('h4', null, title));
      for (const id of shown) {
        rows.push(item({ onclick: () => pickFound(id), onmouseenter: () => hub.emit('pick.hover', { id }) },
          h('span', { class: 'dot', style: { background: css(paintOf(id)) } }),
          h('span', { class: 'name' }, highlight(nameOf(id), word)),
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
  }
  list.replaceChildren(...rows);
  list.hidden = false;
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function closeFind() {
  const box = $('#find-box');
  box.value = '';
  hub.emit('find.query', '');
  box.blur();
  $('#find-list').hidden = true;
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
  box.addEventListener('focus', () => drawFind());
  box.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== box) $('#find-list').hidden = true; }, 150));
  box.addEventListener('keydown', (e) => {
    const rows = [...$('#find-list').querySelectorAll('.hit')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      state.findPick = clamp(state.findPick + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1);
      drawFind();
    } else if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      selectFound();
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
  const cityOn = state.layout === 'city';
  return h('div', { class: 'panel-body view-sheet' },
    h('div', { class: 'section' }, h('h3', null, 'Layout'), seg(LAYOUTS, state.layout, (id) => hub.emit('view.layout', id))),
    h('div', { class: 'section' }, h('h3', null, 'Color'), seg(PAINTS, state.paint, (id) => hub.emit('view.paint', id))),
    cityOn ? h('div', { class: 'section' }, h('h3', null, 'Height'), seg(HEIGHTS, state.height, (id) => hub.emit('view.height', id))) : null,
    cityOn ? h('div', { class: 'section' }, h('h3', null, 'Angle'), seg(ANGLES, state.angle, (id) => hub.emit('view.angle', id))) : null,
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
      el.append(h('div', { class: 'row', style: { padding: '0 10px 8px 28px' } },
        h('button', { class: 'btn small', title: 'Select every part with this finding. The Act bar then offers Fix, Delete, and more.', onclick: () => selectRule(r.id) }, icon('plus'), 'Select all')));
      const items = h('div', { class: 'rule-items' });
      const sorted = [...r.list].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || where(a.node).localeCompare(where(b.node)));
      for (const iss of sorted.slice(0, state.expanded === r.id ? 2000 : 60)) {
        const n = node(iss.node);
        items.append(h('div', { class: `item${iss.waived ? ' waived' : ''}`, tabindex: 0, onclick: () => { hub.emit('pick.set', { ids: [iss.node], line: iss.line }); flyTo(iss.node); }, onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); }, onmouseenter: () => hub.emit('pick.hover', { id: iss.node }) },
          h('div', { class: 'what' }, h('i', { class: `dot lv-${iss.level} shape-${iss.level}`, style: { marginRight: '7px' } }), nameOf(iss.node)),
          h('div', { class: 'where' }, `${where(iss.node).replace(/:\d+$/, '')}:${iss.line}`),
          h('div', { class: 'why' }, iss.note),
          h('div', { class: 'acts' },
            h('button', { class: 'btn tiny ghost', title: 'Fix with agent', 'aria-label': 'Fix with agent', onclick: (e) => { e.stopPropagation(); runActOn('fix', { ...S.emptySet(), nodes: [n.key] }); } }, icon('change')),
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

// Select the parts that hold a rule's open findings. The set stays live: it
// is rebuilt from the rule after every rescan.
function selectRule(rule) {
  const ids = [...new Set(state.model.issues.filter((i) => i.rule === rule && !i.waived).map((i) => i.node))];
  setFrom(ids, { recipe: [{ rule }] });
}

function drawChange() {
  const body = h('div', { class: 'panel-body' });
  const cfg = state.config;
  if (!cfg.hasKey) body.append(h('div', { class: 'notice' }, 'No API key set. The agent needs an endpoint, a model, and a key. ', h('button', { class: 'btn small', onclick: () => hub.emit('box.open', 'setup') }, 'Open settings')));
  const st = state.stage;
  if (st.items.length || st.undo) {
    const sec = h('div', { class: 'section' }, h('h3', null, 'Staged changes', h('span', { class: 'count' }, fmt(st.items.length))));
    if (st.items.length) {
      sec.append(h('div', { class: 'row', style: { marginBottom: '8px' } },
        h('button', { class: 'btn primary small', onclick: () => hub.emit('stage.apply', {}) }, 'Apply all'),
        h('button', { class: 'btn small', onclick: () => hub.emit('stage.discard', {}) }, 'Discard all'),
        h('button', { class: 'btn small', title: 'Select the changed files, then act on them as a group', onclick: () => selectChanged() }, 'Select changed'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost small', 'aria-pressed': String(st.preview), title: 'Show the map as it would look after applying', onclick: () => wire.ask('stage.preview', { on: !st.preview }) }, icon('eye'), st.preview ? 'Previewing' : 'Preview')));
      const list = h('div', { class: 'changes' });
      for (const it of st.items) {
        list.append(h('button', { class: 'change', title: it.from ? `Moved from ${it.from}` : it.key, onclick: () => hub.emit('code.open', { key: it.key, tab: 'diff' }) },
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
  if (state.agent.busy && state.agent.log.at(-1)?.kind !== 'batch') log.append(h('div', { class: 'step' }, h('span', { class: 'busy' }, h('i'), h('i'), h('i')), 'Working…'));
  body.append(h('div', { class: 'section' }, h('h3', null, 'Agent'), state.agent.log.length ? log : h('div', { class: 'note' }, 'Select parts and pick an action in the Act bar, or ask in plain words. Edits are staged here for review before anything is written.')));
  const empty = setEmpty();
  const box = h('textarea', { id: 'prompt', placeholder: empty ? 'Ask about or change the code…' : `Ask about or change the ${S.setSummary(state.set)}…`, rows: 3, 'aria-label': 'Message to the agent', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } });
  box.value = state.draft ?? '';
  box.addEventListener('input', () => { state.draft = box.value; });
  const send = () => { const text = box.value.trim(); if (!text || state.agent.busy) return; state.draft = ''; hub.emit('agent.ask', { prompt: text }); };
  const scope = h('div', { class: 'scope' },
    h('span', { class: 'muted' }, 'Scope: '),
    h('button', { class: 'linkish', title: empty ? 'Select parts to narrow the scope' : 'Show the selection', onclick: () => { if (!empty) showSelection(); } }, empty ? 'the whole workspace' : state.set.name ?? S.setSummary(state.set)),
    h('span', { class: 'spacer' }),
    modeToggle());
  const prompt = h('div', { class: 'prompt' }, scope, box, h('div', { class: 'row end' },
    h('span', { class: 'muted', style: { fontSize: '12px', marginRight: 'auto' } }, cfg.model ? `${cfg.model}` : ''),
    state.agent.busy ? h('button', { class: 'btn small', onclick: () => wire.ask('agent.stop') }, icon('stop'), state.agent.halting ? 'Stop now' : 'Stop') : h('button', { class: 'btn primary small', onclick: send }, icon('send'), 'Send')));
  setTimeout(() => { body.scrollTop = body.scrollHeight; }, 0);
  return [body, prompt];
}

function modeToggle() {
  return seg([{ id: 'together', name: 'All at once', about: 'One run with the whole set in focus' }, { id: 'each', name: 'One by one', about: 'One run per member, each with a fresh conversation' }], state.mode, (id) => hub.emit('act.mode', id), { cls: 'mode', title: 'Run mode' });
}

function selectChanged() {
  const ids = state.stage.items.map((it) => idOf(it.key)).filter((id) => id >= 0);
  if (!ids.length) { toast('No changed file is on the map. Turn on Preview to see new files.'); return; }
  setFrom(ids, { recipe: [{ staged: true }] });
}

function logEntry(e) {
  if (e.kind === 'user') return h('div', { class: 'msg user' }, e.text.length > 600 ? e.text.slice(0, 600) + '…' : e.text, e.scope ? h('div', { class: 'scope-tag' }, e.scope) : null);
  if (e.kind === 'error') return h('div', { class: 'msg error' }, e.text);
  if (e.kind === 'batch') {
    const done = e.items.filter((x) => x && x.state !== 'run').length;
    const mark = { run: '⋯', staged: '✓', none: '–', error: '✗' };
    return h('div', { class: 'batch' },
      h('div', { class: 'batch-head' }, h('b', null, e.title), h('span', { class: 'muted' }, ` · one by one · ${done} of ${e.total}`), e.halting && !e.done ? h('span', { class: 'muted' }, ' · stopping after this item') : null),
      h('div', { class: 'batch-items' }, e.items.map((x, i) => x ? h('div', { class: `batch-item ${x.state}`, title: x.error ?? '' },
        h('span', { class: 'mark' }, mark[x.state] ?? '·'),
        h('span', { class: 'label' }, x.label),
        h('span', { class: 'muted' }, x.state === 'staged' ? `staged ${plural(x.files, 'file')}` : x.state === 'none' ? 'no change' : x.state === 'error' ? x.error ?? 'error' : (e.text?.[i] ? e.text[i].slice(-80) : 'working…'))) : null)));
  }
  if (e.kind === 'tool') {
    const write = /write|edit|move|delete/.test(e.name);
    const path = e.args?.path ?? e.args?.from ?? e.args?.pattern ?? e.args?.name ?? e.args?.dir ?? '';
    const verb = { list_files: 'list', read_file: 'read', find_text: 'find', show_outline: 'outline', find_refs: 'refs', show_links: 'links', write_file: 'write', edit_file: 'edit', move_file: 'move', delete_file: 'delete' }[e.name] ?? e.name;
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

// ───────────────────────────── Selection ─────────────────────────────
// The Selection panel (was Info) sits on the right and opens while the set is
// not empty: one part shows its details, several show members, interface,
// findings, and growth; one link shows its ends and the lines where it happens.

function showSelection() {
  if (state.narrow) { hub.emit('sheet.toggle', state.sheet === 'info' ? null : 'info'); return; }
  $('#info').hidden = false;
  drawSelection();
}

function drawSelection() {
  const info = $('#info');
  const s = state.set;
  const show = state.narrow ? state.sheet === 'info' : !setEmpty();
  info.hidden = !show;
  state.panelFiles = new Set();
  if (!show) return;
  const body = h('div', { class: 'panel-body' });
  if (setEmpty()) {
    body.append(h('div', { class: 'empty' }, 'Tap something on the map to see its details.'));
    info.replaceChildren(selHead(), body);
    return;
  }
  const ids = selIds();
  if (ids.length === 1 && !s.links.length && !s.ranges.length) drawOne(body, ids[0]);
  else if (!ids.length && s.links.length === 1 && !s.ranges.length) drawLink(body, s.links[0]);
  else drawMany(body, ids);
  info.replaceChildren(selHead(), body);
}

function selHead() {
  const s = state.set;
  const T = state.T;
  const ids = selIds();
  const lines = d3.sum(ids, (id) => T.N[id].lines) + d3.sum(s.ranges, (r) => r[2] - r[1] + 1);
  const live = s.recipe && (s.recipe.length > 1 || !s.recipe[0].seed) ? S.recipeName(s.recipe, state.model?.rules) : '';
  return h('div', { class: 'panel-head sel-head' },
    h('div', { class: 'sel-title' },
      h('b', null, s.name ?? (setEmpty() ? 'Selection' : S.setSummary(s))),
      h('span', { class: 'muted' }, setEmpty() || !lines ? '' : plural(lines, 'line')),
      live ? h('div', { class: 'live' }, h('span', null, `Live: ${live}`), h('button', { class: 'btn tiny ghost', title: 'Stop following the recipe; keep these members as they are', onclick: () => hub.emit('set.freeze') }, 'Freeze')) : null),
    h('button', { class: 'btn ghost small', title: 'Saved sets', 'aria-label': 'Saved sets', onclick: (e) => askSets(e.currentTarget) }, icon('save'), state.saved.length ? h('span', { class: 'count' }, fmt(state.saved.length)) : null),
    setEmpty() ? null : h('button', { class: 'btn ghost small', title: 'Save this set', onclick: (e) => askSave(e.currentTarget) }, 'Save'),
    setEmpty() ? null : h('button', { class: 'btn ghost small', title: 'Isolate: dim everything else (I)', 'aria-pressed': String(state.isolate), onclick: () => hub.emit('set.isolate', !state.isolate) }, icon('isolate')),
    h('button', { class: 'btn ghost small', 'aria-label': 'Clear the selection', title: 'Clear (Esc)', onclick: () => hub.emit('pick.clear') }, icon('close')));
}

function drawOne(body, id) {
  const T = state.T;
  const n = T.N[id];
  const f = T.fileOf[id] >= 0 ? T.N[T.fileOf[id]] : null;
  body.append(h('div', { class: 'title' },
    h('span', { class: 'kind' }, n.form && n.form.length <= 9 ? n.form : KIND_NAME[n.kind]),
    h('div', null, h('h2', null, nameOf(id)), h('div', { class: 'path' }, where(id) + (n.to && n.to !== n.from ? `–${n.to}` : '')))));
  const facts = [['Lines', fmt(n.lines)]];
  if (n.kind === 'func') facts.push(['Branches', n.cx ?? 0], ['Nesting', n.nest ?? 0], ['Parameters', n.args ?? 0]);
  else if (T.cxMax[id]) facts.push(['Most branches', T.cxMax[id]]);
  if (f) facts.push(['Language', state.model.langs.find((l) => l.id === f.lang)?.name ?? f.lang], ['Commits', f.churn ?? 0], ['Changed', ago(f.time)]);
  if (n.kind === 'dir' || n.kind === 'repo') facts.push(['Files', fmt(countFiles(id))]);
  const fi = S.fanin(T.I, detailRank()).count[id];
  if (fi) facts.push(['Used by', `${fmt(fi)} ${fi === 1 ? detailName().replace(/s$/, '') : detailName()}`]);
  const rv = reviewOf(id);
  facts.push(['Review', rv === 'ok' ? 'Reviewed' : rv === 'stale' ? 'Changed since review' : 'Not reviewed']);
  if (T.count[id]) facts.push(['Issues', fmt(T.count[id])]);
  if (f?.gen) facts.push(['Generated', 'Yes']);
  body.append(h('div', { class: 'facts' }, facts.map(([a, b]) => h('div', { class: 'fact' }, h('span', null, a), h('b', null, String(b))))));
  if (n.head && n.kind !== 'part' && !f) body.append(h('div', { class: 'sig' }, n.head));
  if (f && n.kind !== 'repo' && n.kind !== 'dir') body.append(codePeek(id));
  if (n.bases?.length) body.append(h('div', { class: 'section' }, h('h3', null, 'Extends'), h('div', { class: 'note' }, n.bases.join(', '))));
  const repo = f ? state.model.nodes.find((x) => x.kind === 'repo' && f.key.startsWith(x.key + '/')) : null;
  body.append(h('div', { class: 'acts-bar' },
    h('button', { class: 'btn small', onclick: () => flyTo(id) }, icon('zoom'), 'Zoom'),
    f ? h('button', { class: 'btn small', title: 'Open in the Code sheet (Shift+Enter)', onclick: () => openCode(id) }, icon('code'), 'Code') : null,
    f && repo?.root ? h('a', { class: 'btn small ghost', href: `vscode://file${repo.root}/${f.path}:${n.from ?? state.selLine ?? 1}`, title: 'Open in VS Code' }, icon('edit'), 'Editor') : null));
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
  // Same-named parts (a struct and its impl) get their kind as a label.
  const twin = (list) => { const seen = d3.rollup(list, (v) => v.length, ([x]) => nameOf(x)); return (x) => seen.get(nameOf(x)) > 1 ? formOf(x) : undefined; };
  const tu = twin(uses.slice(0, 14)), tb = twin(users.slice(0, 14));
  if (uses.length) body.append(h('div', { class: 'section' }, h('h3', null, 'Uses', h('span', { class: 'count' }, fmt(uses.length))), h('div', { class: 'refs' }, uses.slice(0, 14).map(([x, w, kinds]) => refRow(x, w, kinds, 'out', tu(x))))));
  if (users.length) body.append(h('div', { class: 'section' }, h('h3', null, 'Used by', h('span', { class: 'count' }, fmt(users.length))), h('div', { class: 'refs' }, users.slice(0, 14).map(([x, w, kinds]) => refRow(x, w, kinds, 'in', tb(x))))));
  body.append(growRow());
  if (n.kind === 'file' && T.kids[id].length) {
    const rows = [];
    walk(id, (k) => { if (k !== id && rows.length < 120) rows.push(k); });
    rows.sort((a, b) => T.N[a].from - T.N[b].from);
    body.append(h('div', { class: 'section' }, h('h3', null, 'Outline'), h('div', { class: 'refs outline' }, rows.map((k) => h('button', { class: 'ref', style: { '--d': T.symDepth[k] }, onclick: () => { hub.emit('pick.set', { ids: [k] }); flyTo(k); } },
      h('span', { class: 'k' }, formOf(k)), h('span', { class: 'name' }, T.N[k].name), h('span', { class: 'n' }, T.N[k].from))))));
  }
  if (n.kind === 'dir' || n.kind === 'repo') {
    const files = [];
    walk(id, (k) => { if (T.N[k].kind === 'file') files.push(k); return T.N[k].kind !== 'file'; });
    files.sort((a, b) => T.N[b].lines - T.N[a].lines);
    body.append(h('div', { class: 'section' }, h('h3', null, 'Largest files'), h('div', { class: 'refs' }, files.slice(0, 10).map((k) => refRow(k)))));
  }
  if (n.ext?.length) body.append(h('div', { class: 'section' }, h('h3', null, 'Packages'), h('div', { class: 'note mono' }, n.ext.join('  '))));
}

// The first 12 lines of a part, with syntax colors. Click to open the Code sheet.
function codePeek(id) {
  const T = state.T;
  const n = T.N[id];
  const f = T.N[T.fileOf[id]];
  const text = state.texts.get(f.key);
  state.panelFiles.add(f.key);
  if (!text) { wantText(f.key); return h('div', { class: 'peek empty' }, 'Loading code…'); }
  const from = n.from ?? 1;
  const rows = [];
  for (let li = from - 1; li < Math.min(text.lines.length, from + 11); li++) rows.push(h('div', { class: 'peek-line' }, h('span', { class: 'no' }, li + 1), h('span', null, spansToNodes(text.lines[li], text.spans[li]))));
  return h('button', { class: 'peek', title: 'Open in the Code sheet (Shift+Enter)', onclick: () => openCode(id) }, rows);
}

function drawMany(body, ids) {
  const T = state.T;
  const s = state.set;
  // Members, grouped by folder (or file, for symbols).
  if (ids.length) {
    const groups = d3.group(ids, (id) => { const n = T.N[id]; const p = T.fileOf[id] >= 0 && n.kind !== 'file' ? T.fileOf[id] : n.up; return p > 0 ? where(p) : 'workspace'; });
    const list = h('div', { class: 'members', role: 'list' });
    for (const [title, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      list.append(h('div', { class: 'member-group' }, title));
      for (const id of members.slice(0, 80)) {
        list.append(h('div', { class: 'member', role: 'listitem' },
          h('button', { class: 'ref', title: where(id), onclick: () => flyTo(id), onmouseenter: () => hub.emit('pick.hover', { id }) },
            h('span', { class: 'sw', style: { background: css(paintOf(id)) } }),
            h('span', { class: 'name' }, nameOf(id)),
            s.hops?.[T.N[id].key] ? h('span', { class: 'n', title: 'Hops from the start' }, `+${s.hops[T.N[id].key]}`) : null,
            h('span', { class: 'n' }, short(T.N[id].lines))),
          h('button', { class: 'x', 'aria-label': `Remove ${T.N[id].name}`, title: 'Remove from the set', onclick: () => hub.emit('pick.drop', { key: T.N[id].key }) }, '×')));
      }
      if (members.length > 80) list.append(h('div', { class: 'note' }, `+${members.length - 80} more`));
    }
    body.append(h('div', { class: 'section' }, h('h3', null, 'Members', h('span', { class: 'count' }, fmt(ids.length))), list));
  }
  if (s.links.length) {
    body.append(h('div', { class: 'section' }, h('h3', null, 'Links', h('span', { class: 'count' }, fmt(s.links.length))),
      h('div', { class: 'members' }, s.links.slice(0, 60).map((l) => h('div', { class: 'member' },
        h('button', { class: 'ref', onclick: () => hub.emit('pick.links', { links: [l] }) }, icon('link'), h('span', { class: 'name' }, `${keyName(l[0])} → ${keyName(l[1])}`), h('span', { class: 'n' }, l[2] === '*' ? 'any' : LINK_NAMES[l[2]] ?? l[2])),
        h('button', { class: 'x', 'aria-label': 'Remove link', onclick: () => hub.emit('pick.drop', { link: l }) }, '×'))))));
  }
  if (s.ranges.length) {
    body.append(h('div', { class: 'section' }, h('h3', null, 'Lines', h('span', { class: 'count' }, fmt(s.ranges.length))),
      h('div', { class: 'members' }, s.ranges.map((r) => h('div', { class: 'member' },
        h('button', { class: 'ref', onclick: () => { const f = idOf(r[0]); if (f >= 0) flyToLine(f, r[1]); } }, icon('code'), h('span', { class: 'name' }, `${keyName(r[0])}:${r[1]}${r[2] !== r[1] ? `–${r[2]}` : ''}`), h('span', { class: 'n' }, plural(r[2] - r[1] + 1, 'line'))),
        h('button', { class: 'x', 'aria-label': 'Remove lines', onclick: () => hub.emit('pick.drop', { range: r }) }, '×'))))));
  }
  if (ids.length) {
    const b = S.boundary(T.I, s, detailRank());
    const row = (e, dir) => {
      const text = dir === 'inside' ? `${nameOf(e.a)} → ${nameOf(e.b)}` : dir === 'out' ? `${nameOf(e.a)} → ${nameOf(e.b)}` : `${nameOf(e.a)} → ${nameOf(e.b)}`;
      return h('button', { class: 'ref', title: 'Select this link bundle', onclick: () => hub.emit('pick.links', { links: [[T.N[e.a].key, T.N[e.b].key, '*']] }), onmouseenter: () => hub.emit('pick.hover', { id: dir === 'in' ? e.a : e.b }) },
        h('span', { class: 'sw', style: { background: theme().series[LINK_COLOR[dir]] } }), h('span', { class: 'name' }, text), h('span', { class: 'n' }, e.kinds.map((k) => LINK_NAMES[k]).join(', ')), h('span', { class: 'n' }, `×${e.w}`));
    };
    const sec = h('div', { class: 'section' }, h('h3', null, 'Interface'));
    if (b.inside.length) sec.append(h('div', { class: 'sub' }, `Inside the set · ${b.inside.length}`), h('div', { class: 'refs' }, b.inside.slice(0, 14).map((e) => row(e, 'inside'))));
    if (b.out.length) sec.append(h('div', { class: 'sub' }, `Uses outside · ${b.out.length}`), h('div', { class: 'refs' }, b.out.slice(0, 14).map((e) => row(e, 'out'))));
    if (b.in.length) sec.append(h('div', { class: 'sub' }, `Used from outside · ${b.in.length}`), h('div', { class: 'refs' }, b.in.slice(0, 14).map((e) => row(e, 'in'))));
    if (!b.inside.length && !b.out.length && !b.in.length) sec.append(h('div', { class: 'note' }, 'No links in or out.'));
    body.append(sec);
    const counts = new Map();
    const memberSet = new Set(ids);
    for (const iss of state.model.issues) {
      if (iss.waived) continue;
      for (let p = iss.node; p > 0; p = T.N[p].up) if (memberSet.has(p)) { counts.set(iss.rule, (counts.get(iss.rule) ?? 0) + 1); break; }
    }
    if (counts.size) {
      const rules = new Map(state.model.rules.map((r) => [r.id, r]));
      body.append(h('div', { class: 'section' }, h('h3', null, 'Findings', h('span', { class: 'count' }, fmt(d3.sum(counts.values())))),
        h('div', { class: 'refs' }, [...counts].sort((a, b) => b[1] - a[1]).map(([rule, n]) => h('button', { class: 'ref', title: 'Narrow the set to the parts with these findings', onclick: () => narrowTo(rule) },
          h('span', { class: 'name' }, rules.get(rule)?.name ?? rule), h('span', { class: 'n' }, fmt(n)))))));
    }
  }
  body.append(growRow());
}

// One link: its ends, kinds, weight, and the lines where it happens.
function drawLink(body, l) {
  const T = state.T, m = state.model;
  const a = idOf(l[0]), b = idOf(l[1]);
  const lis = S.linkIndices(T.I, l, 2000);
  const kinds = new Map();
  for (const li of lis) { const k = m.linkKinds[m.links[li][2]]; kinds.set(k, (kinds.get(k) ?? 0) + m.links[li][3]); }
  body.append(h('div', { class: 'title' }, h('span', { class: 'kind' }, 'link'), h('div', null, h('h2', null, `${nameOf(a)} → ${nameOf(b)}`), h('div', { class: 'path' }, l[2] === '*' ? 'Every link between them' : `${LINK_NAMES[l[2]] ?? l[2]} links`))));
  body.append(h('div', { class: 'refs', style: { margin: '10px 0' } }, refRow(a, 0, null, 'out', 'From'), refRow(b, 0, null, 'in', 'To')));
  body.append(h('div', { class: 'facts' }, [...kinds].map(([k, w]) => h('div', { class: 'fact' }, h('span', null, LINK_NAMES[k] ?? k), h('b', null, `×${fmt(w)}`))), kinds.size ? null : h('div', { class: 'fact' }, h('span', null, 'Links'), h('b', null, 'none now'))));
  const sites = h('div', { class: 'sites' });
  const listed = new Set();
  let shown = 0;
  for (const li of lis) {
    if (shown >= 60) break;
    const [s, t, k] = m.links[li];
    const f = T.fileOf[s];
    if (f < 0) continue;
    const fk = T.N[f].key;
    state.panelFiles.add(fk);
    if (!state.sites.has(fk)) { wantSites(fk); continue; }
    const text = state.texts.get(fk);
    if (!text) wantText(fk);
    for (const line of siteLines(li)) {
      if (listed.has(`${f}:${line}`)) continue;
      listed.add(`${f}:${line}`);
      if (shown++ >= 60) break;
      sites.append(h('button', { class: 'site', title: `${T.N[s].name} → ${T.N[t].name} (${LINK_NAMES[m.linkKinds[k]]})`, onclick: () => { flyToLine(f, line); hub.emit('pick.hover', { id: s, line }); } },
        h('span', { class: 'where' }, `${T.N[f].name}:${line}`),
        h('code', null, text?.lines[line - 1]?.trim() ?? '')));
    }
  }
  body.append(h('div', { class: 'section' }, h('h3', null, 'Where', h('span', { class: 'count' }, shown ? fmt(shown) : '')), shown ? sites : h('div', { class: 'note' }, m.linkKinds.includes('change') && l[2] === 'change' ? 'They change in the same commits; no line links them.' : 'Loading the lines…')));
  body.append(growRow());
}

const keyName = (key) => { const id = idOf(key); return id >= 0 ? nameOf(id) : key.split(/[/#]/).pop(); };

function narrowTo(rule) {
  const T = state.T;
  const members = new Set(selIds());
  const ids = new Set();
  for (const iss of state.model.issues) {
    if (iss.waived || iss.rule !== rule) continue;
    for (let p = iss.node; p > 0; p = T.N[p].up) if (members.has(p)) { ids.add(liftTo(iss.node, Math.max(detailRank(), RANK[T.N[p].kind]))); break; }
  }
  setFrom([...ids]);
}

// Grow buttons: Uses · Used by · Both · Path · Loop · Copies · Tests · Inside.
function growRow() {
  const ops = [['out', 'Uses', ']'], ['in', 'Used by', '['], ['both', 'Both', ''], ['path', 'Path', ''], ['loop', 'Loop', ''], ['copies', 'Copies', ''], ['tests', 'Tests', ''], ['inside', 'Inside', '']];
  return h('div', { class: 'section' }, h('h3', null, 'Grow'), h('div', { class: 'grow' }, ops.map(([op, name, key]) => {
    const a = actions().find((x) => x.id === `grow-${op}`);
    const reason = a ? whyNot(a) : null;
    return h('button', { class: 'btn small', disabled: !!reason, title: reason ?? `${a?.about ?? name}${key ? ` (${key})` : ''}`, onclick: () => hub.emit('set.grow', { op }) }, name);
  })));
}

function countFiles(id) {
  let n = 0;
  walk(id, (k) => { if (state.T.N[k].kind === 'file') { n++; return false; } });
  return n;
}

// A part's short kind label: func, class, struct, new, file …
function formOf(id) {
  const n = state.T.N[id];
  return n.form === 'ctor' ? 'new' : n.form === 'function' ? 'func' : n.form ?? n.kind;
}

function refRow(id, w, kinds, dir, label) {
  const n = node(id);
  const th = theme();
  if (!n) return null;
  return h('div', { class: 'member' },
    h('button', { class: 'ref', title: where(id), onclick: () => { hub.emit('pick.set', { ids: [id] }); flyTo(id); }, onmouseenter: () => hub.emit('pick.hover', { id }) },
      h('span', { class: 'sw', style: { background: dir ? th.series[dir === 'out' ? 0 : 1] : css(paintOf(id)) } }),
      label ? h('span', { class: 'k' }, label) : null,
      h('span', { class: 'name' }, nameOf(id)),
      kinds ? h('span', { class: 'n' }, [...kinds].map((k) => LINK_NAMES[k]).join(', ')) : null,
      h('span', { class: 'n' }, w ? `×${w}` : short(n.lines))),
    h('button', { class: 'x add', 'aria-label': `Add ${n.name} to the set`, title: 'Add to the set', onclick: () => hub.emit('pick.set', { ids: [id], add: true, keep: true }) }, '+'));
}

function refsOf(id) {
  const T = state.T, m = state.model;
  const lift = (x) => { const r = Math.max(3, Math.min(RANK[T.N[x].kind], 4)); return liftTo(x, r); };
  const uses = new Map(), users = new Map();
  const add = (map, x, w, kind) => { const e = map.get(x) ?? [x, 0, new Set()]; e[1] += w; e[2].add(kind); map.set(x, e); };
  walk(id, (k) => {
    for (const li of T.out[k]) { const [, t, kk, w] = m.links[li]; if (!isUnder(t, id) && m.linkKinds[kk] !== 'change') add(uses, lift(t), w, m.linkKinds[kk]); }
    for (const li of T.inn[k]) { const [s, , kk, w] = m.links[li]; if (!isUnder(s, id) && m.linkKinds[kk] !== 'change') add(users, lift(s), w, m.linkKinds[kk]); }
  }, 5000);
  const sort = (map) => [...map.values()].sort((a, b) => b[1] - a[1]);
  return { uses: sort(uses), users: sort(users) };
}

// ───────────────────────────── Act ─────────────────────────────
// One registry for every action on the set: the server's agent actions (sent
// in hello) and the client's own. The Act bar, the > palette in Find, and the
// help dialog all render from it, so an action is defined in one place.

const CLIENT_ACTS = [
  { id: 'ask', name: 'Ask', key: 'E', icon: 'ask', takes: 'none', about: 'Ask the agent about the set in your own words.', run: () => openAsk() },
  { id: 'review', name: 'Review', key: 'R', icon: 'review', takes: 'nodes', about: 'Mark every part reviewed, or unmark.', run: () => markReviewed() },
  { id: 'rename', name: 'Rename', key: 'F2', icon: 'rename', takes: 'symbol', about: 'Rename a type or function everywhere.', run: () => askRename(selIds()[0]) },
  { id: 'move', name: 'Move', key: 'M', icon: 'move', takes: 'movable', about: 'Move a file or folder into a folder, or a type or function into a file.', run: () => askMovePick(selIds()[0]) },
  { id: 'delete', name: 'Delete', key: 'Del', icon: 'trash', takes: 'nodes', about: 'Stage a delete of every part.', run: () => askDelete(selIds()) },
  { id: 'edit', name: 'Edit', key: 'Shift+Enter', icon: 'code', takes: 'editable', about: 'Open the code in the Code sheet to read and edit it.', run: () => openCode() },
  { id: 'isolate', name: 'Isolate', key: 'I', icon: 'isolate', takes: 'any', about: 'Dim everything outside the set.', run: () => hub.emit('set.isolate', !state.isolate) },
  { id: 'save', name: 'Save set', icon: 'save', takes: 'any', about: 'Save the set by name. It stays live if it came from a query, rule, or grow.', run: () => askSave() },
  { id: 'grow-out', name: 'Grow: uses', key: ']', icon: 'grow', takes: 'seed', about: 'Add what the set uses, one hop. } adds all hops.', run: () => hub.emit('set.grow', { op: 'out' }) },
  { id: 'grow-in', name: 'Grow: used by', key: '[', icon: 'grow', takes: 'seed', about: 'Add what uses the set, one hop. { adds all hops.', run: () => hub.emit('set.grow', { op: 'in' }) },
  { id: 'grow-both', name: 'Grow: both ways', icon: 'grow', takes: 'seed', about: 'Add what the set uses and what uses it, one hop.', run: () => hub.emit('set.grow', { op: 'both' }) },
  { id: 'grow-path', name: 'Grow: path', icon: 'grow', takes: 'group', about: 'Add every part and link on the shortest paths between members.', run: () => hub.emit('set.grow', { op: 'path' }) },
  { id: 'grow-loop', name: 'Grow: loop', icon: 'grow', takes: 'loop', about: 'Add the rest of the loop a member is in.', run: () => hub.emit('set.grow', { op: 'loop' }) },
  { id: 'grow-copies', name: 'Grow: copies', icon: 'grow', takes: 'copies', about: 'Add the other copies of copied code.', run: () => hub.emit('set.grow', { op: 'copies' }) },
  { id: 'grow-tests', name: 'Grow: tests', icon: 'grow', takes: 'seed', about: 'Add the test files that link into the set.', run: () => hub.emit('set.grow', { op: 'tests' }) },
  { id: 'grow-inside', name: 'Grow: inside', icon: 'grow', takes: 'container', about: 'Turn folders and files into their parts at the current Detail.', run: () => hub.emit('set.grow', { op: 'inside' }) },
];

function actions() {
  const agent = state.acts.map((a) => ({ ...a, agent: true, icon: 'change', key: a.id === 'explain' ? 'X' : undefined }));
  return [...agent, ...CLIENT_ACTS];
}

const actionById = (id) => actions().find((a) => a.id === id);

// Does the set touch an open finding (members' subtrees, or lines in ranges)?
function touchesFindings(set = state.set) {
  const T = state.T;
  const members = new Set(set.nodes.map(idOf).filter((id) => id >= 0));
  for (const iss of state.model.issues) {
    if (iss.waived) continue;
    for (let p = iss.node; p > 0; p = T.N[p].up) if (members.has(p)) return true;
    const f = T.fileOf[iss.node];
    if (f >= 0 && set.ranges.some((r) => r[0] === T.N[f].key && iss.line >= r[1] && iss.line <= r[2])) return true;
  }
  return false;
}

function hasCopies(set = state.set) {
  const T = state.T, m = state.model;
  if (set.links.some((l) => l[2] === 'copy' || (l[2] === '*' && S.linkIndices(T.I, l, 400).some((li) => m.linkKinds[m.links[li][2]] === 'copy')))) return true;
  let found = false;
  for (const id of set.nodes.map(idOf).filter((x) => x >= 0)) {
    walk(id, (x) => { if (found) return false; for (const li of [...T.out[x], ...T.inn[x]]) if (m.linkKinds[m.links[li][2]] === 'copy') { found = true; return false; } }, 5000);
    if (found) return true;
  }
  return state.model.issues.some((i) => i.rule === 'copy' && !i.waived && set.nodes.some((k) => { const id = idOf(k); return id >= 0 && isUnder(i.node, id); }));
}

function inLoop(set = state.set) {
  const T = state.T;
  const rank = detailRank();
  const groups = S.strongGroups(S.liftGraph(T.I, rank).out);
  const ids = set.nodes.map(idOf).filter((x) => x >= 0);
  return groups.some((g) => ids.some((m) => g.includes(liftTo(m, rank)) || g.some((x) => isUnder(x, m))));
}

// Why an action does not apply to a set, or null when it does.
function whyNot(a, set = state.set) {
  const T = state.T;
  if (!T) return 'Open a folder first';
  const ids = set.nodes.map(idOf).filter((id) => id >= 0);
  const nodes = ids.map((id) => T.N[id]);
  const empty = !S.setSize(set);
  switch (a.takes) {
    case 'none': return null;
    case 'any': return empty ? 'Select something first' : null;
    case 'seed': return empty ? 'Select something first' : null;
    case 'code': return ids.length || set.ranges.length ? null : 'Needs a file, type, function, or lines';
    case 'one': return ids.length === 1 && !set.links.length && !set.ranges.length && ['file', 'type', 'func', 'space'].includes(nodes[0].kind) ? null : 'Needs one function, type, or file';
    case 'issues': return touchesFindings(set) ? null : 'Needs a part with open findings';
    case 'link': return set.links.some((l) => l[2] !== 'copy' && l[2] !== 'change') ? null : 'Needs a selected link: click one on the map';
    case 'copy': return hasCopies(set) ? null : 'Needs copied code: a copy link, or a part with a Copied code finding';
    case 'group': return ids.length >= 2 ? null : 'Needs two or more parts';
    case 'nodes': return ids.length ? null : set.ranges.length ? 'Line ranges cannot be marked or deleted; select parts' : 'Select parts first';
    case 'symbol': return ids.length === 1 && ['type', 'func', 'space'].includes(nodes[0].kind) ? null : 'Needs one type or function';
    case 'movable': return ids.length === 1 && ['file', 'dir', 'type', 'func', 'space'].includes(nodes[0].kind) ? null : 'Needs one file, folder, type, or function';
    case 'editable': return set.ranges.length || nodes.some((n) => T.fileOf[n.id] >= 0) ? null : 'Needs a file, part, or lines';
    case 'loop': return ids.length && inLoop(set) ? null : 'Needs a part inside a loop';
    case 'copies': return ids.length && hasCopies(set) ? null : 'Needs a part with copied code';
    case 'container': return nodes.some((n) => ['repo', 'dir', 'file'].includes(n.kind)) ? null : 'Needs a folder or file';
    default: return null;
  }
}

// The top five actions that apply, by the shape of the set.
function barActions() {
  const s = state.set;
  const T = state.T;
  const ids = selIds();
  let order;
  if (!ids.length && !s.ranges.length && s.links.length) order = ['explain', s.links.some((l) => l[2] === 'copy') ? 'merge' : 'decouple', 'decouple', 'merge', 'tests', 'fix'];
  else if (ids.length === 1 && !s.links.length && ['type', 'func', 'space'].includes(T.N[ids[0]].kind)) order = ['explain', 'tidy', 'split', 'tests', 'rename'];
  else if (ids.length >= 2) order = ['explain', 'tidy', 'tests', 'extract', 'review'];
  else order = ['explain', 'tidy', 'tests', 'docs', 'review'];
  if (touchesFindings()) order = ['fix', ...order.filter((x) => x !== 'fix')];
  order = [...order, 'docs', 'split', 'tests', 'decouple', 'merge', 'extract', 'review', 'move', 'edit', 'delete'];
  const out = [];
  for (const id of new Set(order)) {
    const a = actionById(id);
    if (a && !whyNot(a)) out.push(a);
    if (out.length >= 5) break;
  }
  return out;
}

function drawAct() {
  const el = $('#act');
  if (setEmpty() || !state.T) { el.hidden = true; return; }
  el.hidden = false;
  const v = viewport();
  el.style.left = state.narrow ? '' : `${v.x + v.w / 2}px`;
  el.replaceChildren(
    h('button', { class: 'act-sum', title: 'Show the selection', onclick: showSelection }, h('b', null, state.set.name ?? S.setSummary(state.set))),
    h('span', { class: 'act-sep' }),
    ...barActions().map((a) => h('button', { class: `btn small act-btn${a.agent ? ' agent' : ''}`, 'data-act': a.id, title: `${a.agent ? 'Agent: ' : ''}${a.about ?? a.name}${a.key ? ` (${a.key})` : ''}`, onclick: () => runAct(a.id) }, a.name)),
    h('button', { class: 'btn small ghost', title: 'All actions for the set (A)', onclick: () => openPalette() }, icon('more'), 'More'),
    h('span', { class: 'act-sep' }),
    h('button', { class: 'btn small ghost act-mode', 'aria-pressed': String(state.mode === 'each'), 'aria-label': state.mode === 'each' ? 'Mode: one by one' : 'Mode: all at once', title: state.mode === 'each' ? 'One by one: one agent run per member, each with a fresh conversation. Click for all at once.' : 'All at once: one agent run with the whole set. Click for one by one.', onclick: () => hub.emit('act.mode', state.mode === 'each' ? 'together' : 'each') }, icon('each'), state.mode === 'each' ? 'Each' : 'All'),
    h('button', { class: 'btn small ghost', 'aria-label': 'Clear the selection', title: 'Clear (Esc)', onclick: () => hub.emit('pick.clear') }, icon('close')));
}

function openPalette() {
  const box = $('#find-box');
  box.value = '>';
  box.focus();
  hub.emit('find.query', '>');
}

const payload = (s) => ({ nodes: s.nodes, links: s.links, ranges: s.ranges });

function runAct(id, { set = state.set, mode = state.mode } = {}) {
  const a = actionById(id);
  if (!a) return;
  const reason = whyNot(a, set);
  if (reason) { toast(reason, 'error'); return; }
  if (!a.agent) { a.run(); return; }
  if (state.agent.busy) { toast('The agent is still working.', 'error'); return; }
  const size = S.setSize(set);
  const go = () => hub.emit('act.run', { id, mode, set });
  if ((mode === 'each' && size > 10) || (mode !== 'each' && set.nodes.length > 40)) confirmRun(a, mode, set, go);
  else go();
}

const runActOn = (id, set) => runAct(id, { set, mode: 'together' });

function confirmRun(a, mode, set, go) {
  const size = S.setSize(set);
  const [x, y] = [window.innerWidth / 2, window.innerHeight - 260];
  pop(x, y,
    h('p', null, h('b', null, a.name), mode === 'each' ? ` one by one on ${fmt(Math.min(size, 50))} items?` : ` on ${fmt(set.nodes.length)} parts at once?`),
    h('div', { class: 'note' }, mode === 'each'
      ? `That is ${fmt(Math.min(size, 50))} agent runs${size > 50 ? ` (the first 50 of ${fmt(size)})` : ''}. Stop finishes the current item, then stops.`
      : 'A large set makes a long prompt. One by one may work better.'),
    h('div', { class: 'row end' }, h('button', { class: 'btn small ghost', onclick: unpop }, 'Cancel'), h('button', { class: 'btn small primary', onclick: () => { unpop(); go(); } }, 'Run')));
}

function openChange() {
  if (state.narrow) state.sheet = 'change'; else state.dock = 'change';
  document.body.classList.toggle('sheet-open', !!state.sheet);
  savePrefs();
  drawBar();
  drawDock();
}

function openAsk() {
  openChange();
  setTimeout(() => $('#prompt')?.focus(), 30);
}

function markReviewed() {
  const ids = selIds();
  if (!ids.length) { toast('Line ranges cannot be marked; select parts.', 'error'); return; }
  hub.emit('review.mark', { ids, on: !ids.every((id) => reviewOf(id) === 'ok') });
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
  if (state.lay?.kind === 'city') {
    const p = city.center(id);
    return p ? [clamp(p[0], 20, window.innerWidth - 20), clamp(p[1] + 20, 70, window.innerHeight - 200)] : [window.innerWidth / 2, window.innerHeight / 3];
  }
  const r = rectsOf(id)[0];
  if (!r) return [window.innerWidth / 2, window.innerHeight / 3];
  const [sx, sy] = toScreen(r.x, r.y);
  return [clamp(sx + (r.w * state.t.k) / 2, 20, window.innerWidth - 20), clamp(sy + 20, 70, window.innerHeight - 200)];
}

const isSymbol = (n) => ['type', 'func', 'space', 'part'].includes(n?.kind);

function askMove(id, target, x, y) {
  const n = node(id), t = node(target);
  const symbol = isSymbol(n);
  const from = symbol ? node(state.T.fileOf[id]) : null;
  pop(x, y,
    symbol ? h('p', null, 'Move ', h('b', null, nameOf(id)), ' from ', h('b', null, from.name), ' to ', h('b', null, t.name), '?')
      : h('p', null, 'Move ', h('b', null, n.name), ' into ', h('b', null, `${t.path || t.name}/`), '?'),
    h('div', { class: 'note' }, symbol ? 'Its doc comments and decorators go with it. Both files are staged.' : 'The move is staged. Ask the agent to fix imports and references too.'),
    h('div', { class: 'row end' },
      h('button', { class: 'btn small ghost', onclick: unpop }, 'Cancel'),
      h('button', { class: 'btn small', onclick: () => { unpop(); hub.emit('stage.move', { key: n.key, to: t.key }); } }, 'Move only'),
      h('button', { class: 'btn small primary', onclick: async () => {
        unpop();
        const r = await wire.ask('stage.move', { key: n.key, to: t.key });
        if (r?.error) return;
        const prompt = symbol
          ? `I moved ${n.name} from ${from.key} to ${t.key} (staged). Update every import and reference so the code still works.`
          : `I moved ${n.key} into ${t.key}/ (staged). Update every import and reference so the code still works.`;
        hub.emit('agent.ask', { prompt, set: { ...S.emptySet(), nodes: symbol ? [from.key, t.key] : [t.key] } });
      } }, 'Move + fix')));
}

function askMovePick(id) {
  const n = node(id);
  const symbol = isSymbol(n);
  const T = state.T;
  const targets = symbol
    ? T.N.filter((x) => x.kind === 'file' && x.id !== T.fileOf[id] && !x.gen)
    : T.N.filter((x) => (x.kind === 'dir' || x.kind === 'repo') && !isUnder(x.id, id) && x.id !== n.up);
  const input = h('input', { type: 'text', placeholder: symbol ? 'File path' : 'Folder path', list: 'move-targets', value: '' });
  const [x, y] = anchorPoint(id);
  pop(x, y,
    h('p', null, 'Move ', h('b', null, nameOf(id)), symbol ? ' to file:' : ' to folder:'),
    input,
    h('datalist', { id: 'move-targets' }, targets.slice(0, 800).map((d) => h('option', { value: d.key }))),
    h('div', { class: 'note' }, `Tip: drag the blue grip on the map onto a ${symbol ? 'file' : 'folder'}.`),
    h('div', { class: 'row end' },
      h('button', { class: 'btn small ghost', onclick: unpop }, 'Cancel'),
      h('button', { class: 'btn small primary', onclick: () => { const t = idOf(input.value.trim()); if (t < 0) { toast(`Pick a ${symbol ? 'file' : 'folder'} from the list.`, 'error'); return; } unpop(); askMove(id, t, x, y); } }, 'Next')));
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

function popNear(el) {
  const r = el?.getBoundingClientRect?.();
  return r ? [r.left + r.width / 2, r.bottom] : [window.innerWidth / 2, window.innerHeight / 3];
}

function askSave(anchor) {
  if (setEmpty()) { toast('Select something first.', 'error'); return; }
  const input = h('input', { type: 'text', value: state.set.name ?? '', placeholder: 'Name, like Checkout flow', 'aria-label': 'Set name' });
  const go = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    unpop();
    const r = await wire.ask('set.save', { set: { ...payload(state.set), id: state.set.id, name, recipe: state.set.recipe } });
    if (r?.error) return;
    state.set = { ...state.set, id: r.id, name };
    toast(`Saved “${name}”.`, 'good');
    drawSelection();
    drawAct();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') unpop(); });
  const [x, y] = popNear(anchor);
  const live = state.set.recipe && (state.set.recipe.length > 1 || !state.set.recipe[0].seed);
  pop(x, y, h('p', null, state.set.id ? 'Save the set' : 'Save as a new set'), input,
    h('div', { class: 'note' }, live ? 'It stays live: the recipe runs again after every rescan.' : 'Saved in this repo’s ledger. Find lists it when the box is empty.'),
    h('div', { class: 'row end' }, h('button', { class: 'btn small ghost', onclick: unpop }, 'Cancel'), h('button', { class: 'btn small primary', onclick: go }, 'Save')));
  setTimeout(() => input.select(), 10);
}

function askSets(anchor) {
  const [x, y] = popNear(anchor);
  if (!state.saved.length) { pop(x, y, h('p', null, 'No saved sets yet.'), h('div', { class: 'note' }, 'Select parts, then Save. Sets live in each repo’s ledger.'), h('div', { class: 'row end' }, h('button', { class: 'btn small', onclick: unpop }, 'OK'))); return; }
  pop(x, y, h('p', null, h('b', null, 'Saved sets')),
    h('div', { class: 'sets' }, state.saved.map((st) => h('div', { class: 'member' },
      h('button', { class: 'ref', onclick: () => { unpop(); loadSet(st); } }, h('span', { class: 'name' }, st.name), h('span', { class: 'n' }, S.setSummary(st))),
      h('button', { class: 'x', 'aria-label': `Remove ${st.name}`, title: 'Remove this saved set', onclick: async () => { await wire.ask('set.drop', { id: st.id }); unpop(); } }, '×')))));
}

// ───────────────────────────── Code sheet ─────────────────────────────
// Read a file (its staged text when staged) with the set's range in view,
// edit a range in place, and review the staged diff with per-hunk revert.

function openCode(id) {
  const T = state.T;
  let key, from, to;
  if (id != null && id >= 0) {
    const f = T.fileOf[id];
    if (f < 0) return;
    key = T.N[f].key;
    if (id !== f) { from = T.N[id].from; to = T.N[id].to; }
  } else {
    const r = state.set.ranges[0];
    const n = selIds().map((x) => T.N[x]).find((x) => T.fileOf[x.id] >= 0);
    if (r && (!n || state.set.nodes.indexOf(n.key) > 0)) { key = r[0]; from = r[1]; to = r[2]; }
    else if (n) { const f = T.N[T.fileOf[n.id]]; key = f.key; if (n.id !== f.id) { from = n.from; to = n.to; } }
    else if (r) { key = r[0]; from = r[1]; to = r[2]; }
  }
  if (!key) { toast('Select a file, a part, or lines to open.', 'error'); return; }
  hub.emit('code.open', { key, from, to, tab: 'code' });
}

async function drawCode() {
  const c = state.code;
  const el = $('#code');
  if (!c) { el.hidden = true; return; }
  const items = state.stage.items;
  const item = items.find((it) => it.key === c.key);
  if (c.tab === 'diff' && !item) c.tab = 'code';
  const [file, diff] = await Promise.all([wire.ask('file.read', { key: c.key, staged: true }), item ? wire.ask('stage.diff', { key: c.key }) : null]);
  if (state.code !== c) return;
  const id = idOf(c.key);
  const lang = diff?.lang ?? (id >= 0 ? node(id).lang : 'text');
  const text = file?.text ?? null;
  const at = items.findIndex((it) => it.key === c.key);
  const go = (d) => { const next = items[(at + d + items.length) % items.length]; if (next) hub.emit('code.open', { key: next.key, tab: c.tab }); };
  const tab = (name, label) => h('button', { 'aria-pressed': String(c.tab === name), onclick: () => { c.tab = name; c.editing = false; drawCode(); } }, label);
  const head = h('div', { class: 'diff-head' },
    item ? h('span', { class: `badge ${item.state}` }, { add: '+', edit: '~', delete: '−' }[item.state]) : null,
    h('span', { class: 'path', title: c.key }, c.key, item?.from ? h('span', { class: 'muted' }, `  ← ${item.from}`) : null),
    item ? h('span', { class: 'mono' }, h('span', { class: 'add-n' }, `+${item.adds}`), ' ', h('span', { class: 'del-n' }, `−${item.dels}`)) : null,
    items.length > 1 && item ? h('span', { class: 'row' }, h('button', { class: 'btn small ghost', onclick: () => go(-1), 'aria-label': 'Previous staged file' }, '‹'), h('span', { class: 'muted' }, `${at + 1} / ${items.length}`), h('button', { class: 'btn small ghost', onclick: () => go(1), 'aria-label': 'Next staged file' }, '›')) : null,
    h('div', { class: 'seg tabs-code' }, tab('code', 'Code'), item ? tab('diff', 'Diff') : null),
    c.tab === 'code' && text != null && !c.editing ? h('button', { class: 'btn small', title: 'Edit these lines in place', onclick: () => { c.editing = true; drawCode(); } }, icon('rename'), c.from ? `Edit ${c.from}–${c.to}` : 'Edit file') : null,
    c.tab === 'diff' ? h('button', { class: 'btn small', onclick: () => { hub.emit('stage.discard', { keys: [c.key] }); } }, 'Discard') : null,
    c.tab === 'diff' ? h('button', { class: 'btn small primary', onclick: () => { hub.emit('stage.apply', { keys: [c.key] }); } }, 'Apply') : null,
    h('button', { class: 'btn small ghost', 'aria-label': 'Close the Code sheet', title: 'Close (Esc)', onclick: () => hub.emit('code.close') }, icon('close')));
  let bodyEl;
  if (c.tab === 'diff' && diff?.hunks) {
    const rows = [];
    diff.hunks.forEach((hk, i) => {
      rows.push(h('tr', { class: 'gap' }, h('td', { colspan: 4 }, h('span', null, i ? '⋯' : `@@ line ${hk.a || hk.b}`), h('button', { class: 'btn tiny ghost revert', title: 'Revert this change', onclick: async () => { await wire.ask('stage.hunk', { key: c.key, index: i }); } }, icon('undo'), 'Revert'))));
      for (const [t, a, b, line] of hk.lines) {
        const tk = tokenize(line ?? '', lang);
        rows.push(h('tr', { class: t === '+' ? 'add' : t === '-' ? 'del' : '' }, h('td', { class: 'no' }, a ?? ''), h('td', { class: 'no' }, b ?? ''), h('td', { class: 'sign' }, t === ' ' ? '' : t === '-' ? '−' : '+'), h('td', null, (tk.spans[0] ?? []).length ? spansToNodes(tk.lines[0], tk.spans[0]) : line)));
      }
    });
    bodyEl = h('div', { class: 'diff-body' }, rows.length ? h('table', null, rows) : h('div', { class: 'empty' }, diff.state === 'delete' ? 'File is deleted.' : 'No line changes (moved only).'));
  } else if (text == null) {
    bodyEl = h('div', { class: 'diff-body' }, h('div', { class: 'empty' }, 'This file is deleted in the stage.'));
  } else {
    const tk = tokenize(text, lang);
    const from = c.from ?? 1, to = c.to ?? tk.lines.length;
    const rows = [];
    let edit = null;
    for (let li = 0; li < tk.lines.length; li++) {
      const line = li + 1;
      if (c.editing && line === from) {
        const lines = text.split('\n');
        const area = h('textarea', { class: 'code-edit', spellcheck: false, rows: Math.max(1, to - from + 1), 'aria-label': `Edit lines ${from} to ${to}` });
        area.value = lines.slice(from - 1, to).join('\n');
        const stage = async () => {
          const r = await wire.ask('stage.edit', { key: c.key, from, to, text: area.value });
          if (r?.error) return;
          c.editing = false;
          c.to = from + Math.max(0, area.value.replace(/\n$/, '').split('\n').length - 1);
          drawCode();
        };
        area.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); stage(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); c.editing = false; drawCode(); }
          else if (e.key === 'Tab') { e.preventDefault(); area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end'); }
        });
        edit = area;
        rows.push(h('tr', { class: 'edit' }, h('td', { class: 'no' }, `${from}–${to}`), h('td', null, area, h('div', { class: 'row end edit-acts' }, h('span', { class: 'muted' }, 'Ctrl/Cmd+S stages · Esc cancels'), h('button', { class: 'btn small ghost', onclick: () => { c.editing = false; drawCode(); } }, 'Cancel'), h('button', { class: 'btn small primary', onclick: stage }, 'Stage')))));
        li = to - 1;
        continue;
      }
      rows.push(h('tr', { class: line >= from && line <= to && c.from ? 'hl' : '', id: `code-l${line}` }, h('td', { class: 'no' }, line), h('td', null, spansToNodes(tk.lines[li], tk.spans[li]))));
    }
    bodyEl = h('div', { class: 'diff-body code-body' }, h('table', null, rows));
    if (edit) setTimeout(() => { edit.focus(); edit.style.height = `${edit.scrollHeight + 4}px`; }, 0);
  }
  el.replaceChildren(head, bodyEl);
  el.hidden = false;
  if (c.tab === 'code' && c.from && !c.scrolled) {
    c.scrolled = true;
    setTimeout(() => el.querySelector(`#code-l${Math.max(1, c.from - 3)}`)?.scrollIntoView({ block: 'start' }), 0);
  }
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
  ['/', 'Find files, types, functions, text, or a query (kind:func cx>10)'],
  ['Alt+Enter', 'In Find: select all results'],
  ['1 2 3 4', 'Map, Graph, Layers, City'],
  ['C', 'Next color (Shift+C: previous)'],
  ['D', 'Next detail level'],
  ['L', 'Links: off, focus, all'],
  ['F', 'Fit everything in view'],
  ['Enter', 'Zoom to the selection'],
  ['Shift+Enter', 'Open the selection in the Code sheet'],
  ['U', 'Select the parent'],
  [']  [', 'Grow the set by what it uses / what uses it, one hop'],
  ['}  {', 'The same, all hops'],
  ['X', 'Explain the set (read-only agent run)'],
  ['A', 'All actions for the set (Find in > mode)'],
  ['I', 'Isolate the set'],
  ['V', 'City: next angle (Tilt, Top, Low)'],
  [',  .', 'City: turn left or right'],
  ['Esc', 'Close a popover or the Code sheet, then clear find, spotlight, isolate, and the set; then zoom out'],
  ['O', 'Open a folder'],
  ['?', 'This help'],
];

function drawKeysBox() {
  const box = $('#keys-box');
  const acts = actions().filter((a) => a.key || a.agent);
  box.replaceChildren(
    h('div', { class: 'box-head' }, h('h2', null, 'Keys and mouse')),
    h('div', { class: 'box-body' },
      h('div', { class: 'keys' }, KEYS.flatMap(([k, d]) => [h('kbd', null, k), h('span', null, d)])),
      h('div', { class: 'section', style: { marginTop: '16px' } }, h('h3', null, 'Actions on the set'),
        h('div', { class: 'note', style: { marginBottom: '8px' } }, 'The Act bar shows the actions that fit the set. Agent actions run all at once or one by one.'),
        h('div', { class: 'keys' }, acts.flatMap((a) => [h('kbd', null, a.key ?? (a.agent ? 'Act bar' : '—')), h('span', null, h('b', null, a.name), ` — ${a.about ?? ''}`)]))),
      h('div', { class: 'section', style: { marginTop: '16px' } }, h('h3', null, 'Mouse and touch'),
        h('div', { class: 'keys' },
          h('kbd', null, 'Scroll / pinch'), h('span', null, 'Zoom. Keep zooming into a file to read its code.'),
          h('kbd', null, 'Drag'), h('span', null, 'Pan'),
          h('kbd', null, 'Click / tap'), h('span', null, 'Select. Shift or Ctrl adds. Long-press adds on touch.'),
          h('kbd', null, 'Click a link'), h('span', null, 'Select the link. Alt+click selects the bundle between the folders around it; again goes up a level.'),
          h('kbd', null, 'Click a gutter'), h('span', null, 'At reading zoom: pick a line. Shift+click extends; Shift+drag picks lines.'),
          h('kbd', null, '→  ←n'), h('span', null, 'Call sites: this line uses something; n places use what is declared here. Hover to see them, click to select them.'),
          h('kbd', null, 'Double-click'), h('span', null, 'Zoom to it. On code you can already read: open it in the Code sheet.'),
          h('kbd', null, 'Shift + drag'), h('span', null, 'Box select'),
          h('kbd', null, 'Drag grip'), h('span', null, 'Move a selected file or folder into a folder, or a type or function into a file'),
          h('kbd', null, 'Legend'), h('span', null, 'Click a color to select every part with it; drag across a gradient for a range. Click a link kind to show or hide it.'),
          h('kbd', null, 'Right-drag, Alt+drag'), h('span', null, 'City: orbit. Two-finger twist turns on touch.'))),
      h('div', { class: 'section' }, h('h3', null, 'Layouts'), LAYOUTS.map((l) => h('div', { class: 'note' }, h('b', null, l.name), ' — ', l.about)))),
    h('div', { class: 'box-foot' }, h('button', { class: 'btn primary', onclick: () => box.close() }, 'Done')));
  if (!box.open) box.showModal();
}

// ───────────────────────────── Foot ─────────────────────────────

// Approximate units for a measure value, for the gradient brush label.
function measureLabel(paint, v) {
  const sc = state.T.scales;
  if (paint === 'lines') return `${short(Math.round(Math.expm1(v * Math.log1p(sc.lines))))} lines`;
  if (paint === 'cx') return `${Math.round(v * sc.cx)} branches`;
  if (paint === 'churn') return `${Math.round(v * sc.churn)} commits`;
  if (paint === 'age') return `${Math.round((1 - v) * sc.age)} days`;
  if (paint === 'fanin') return `${Math.round(v * S.fanin(state.T.I, detailRank()).scale)} users`;
  return `${Math.round(v * 100)}%`;
}

// Every color is a group: select the parts at the current Detail that have
// it. Shift adds to the set.
function selectLegend(pick, label, add = false) {
  const T = state.T;
  const rank = detailRank();
  if (state.paint === 'reach') {
    const m = /^reach:(out|in)(\d)$/.exec(pick.key ?? '');
    if (m) { hub.emit('set.grow', { op: m[1], depth: +m[2] === 3 ? Infinity : +m[2] }); return; }
    if (pick.key === 'reach:both') {
      const r = currentReach();
      const ids = [...r.out.keys()].filter((id) => r.in.has(id));
      if (ids.length) hub.emit('pick.set', { ids, add: true, keep: true });
      return;
    }
    return;
  }
  const ctx = classCtx();
  const ids = S.partsAt(T.I, rank).filter((id) => S.classMatches(classOf(id, state.paint, ctx), pick));
  if (!ids.length) { toast(`No ${detailName()} are ${label}.`); return; }
  if (add) { hub.emit('pick.set', { ids, add: true, keep: true }); return; }
  setFrom(ids, { recipe: [{ legend: { paint: state.paint, ...pick, label }, rank }] });
}

function rampBrush(paint) {
  const th = theme();
  const ramp = h('i', { class: 'ramp', title: 'Click or drag to select a range', style: { background: `linear-gradient(90deg, ${th.ramp.join(',')})` } });
  const band = h('b', { class: 'band', hidden: true });
  const wrap = h('span', { class: 'ramp-wrap' }, ramp, band);
  let brush = null;
  const range = () => {
    const r = ramp.getBoundingClientRect();
    const a = clamp((Math.min(brush.x0, brush.x1) - r.left) / r.width, 0, 1), b = clamp((Math.max(brush.x0, brush.x1) - r.left) / r.width, 0, 1);
    return b - a < 0.02 ? [Math.max(0, a - 0.1), Math.min(1, a + 0.1)] : [a, b];
  };
  const update = () => {
    const [lo, hi] = range();
    const r = ramp.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    band.hidden = false;
    band.style.left = `${r.left - wr.left + lo * r.width}px`;
    band.style.width = `${Math.max(2, (hi - lo) * r.width)}px`;
    const ctx = classCtx();
    const top = hi >= 0.98 ? Infinity : hi;
    const n = S.partsAt(state.T.I, detailRank()).filter((id) => S.classMatches(classOf(id, paint, ctx), { lo, hi: top })).length;
    const tip = $('#tip');
    tip.replaceChildren(h('b', null, `${measureLabel(paint, lo)} – ${top === Infinity ? 'max' : measureLabel(paint, hi)}`), h('div', { class: 'muted' }, `${fmt(n)} ${detailName()} · release to select`));
    tip.hidden = false;
    const tr = tip.getBoundingClientRect();
    tip.style.left = `${clamp(r.left + ((lo + hi) / 2) * r.width - tr.width / 2, 8, window.innerWidth - tr.width - 8)}px`;
    tip.style.top = `${r.top - tr.height - 12}px`;
  };
  ramp.addEventListener('pointerdown', (e) => { brush = { x0: e.clientX, x1: e.clientX }; ramp.setPointerCapture(e.pointerId); update(); });
  ramp.addEventListener('pointermove', (e) => { if (!brush) return; brush.x1 = e.clientX; update(); });
  ramp.addEventListener('pointerup', (e) => {
    if (!brush) return;
    const [lo, hi] = range();
    brush = null;
    band.hidden = true;
    hideTip();
    selectLegend({ lo, hi: hi >= 0.98 ? 1e9 : hi }, `${measureLabel(paint, lo)}–${hi >= 0.98 ? 'max' : measureLabel(paint, hi)}`, e.shiftKey);
  });
  return wrap;
}

// Fade the legend's right edge while more keys are scrolled out of view.
function legendFade() {
  const l = $('#legend');
  l.classList.toggle('more', l.scrollLeft + l.clientWidth < l.scrollWidth - 2);
}

function drawFoot() {
  const legend = $('#legend');
  const th = theme();
  const keys = [];
  const rank = DETAILS.find((d) => d.id === state.detail)?.name.toLowerCase() ?? 'parts';
  const key = (color, label, pick, shape) => h('button', { class: 'key', 'data-key': pick?.key ?? null, title: pick ? (state.paint === 'reach' ? `Add the ${rank} within ${label} hop${label === '1' ? '' : 's'}` : `Select the ${rank} colored “${label}” (Shift adds)`) : label, onclick: pick ? (e) => selectLegend(pick, label, e.shiftKey) : null },
    h('i', { class: `sw${shape ? ' ' + shape : ''}`, style: { background: color } }), label);
  const paint = PAINTS.find((p) => p.id === state.paint);
  if (state.model) {
    keys.push(h('span', { class: 'title' }, paint.name));
    if (state.paint === 'lang') {
      const total = d3.sum(state.model.langs, (l) => l.lines) || 1;
      const langs = state.model.langs.filter((l) => state.slots.has(l.id)).slice(0, 7);
      for (const l of langs) keys.push(key(th.series[state.slots.get(l.id)], `${l.name} ${Math.round((l.lines / total) * 100)}%`, { key: `lang:${l.id}` }));
      const other = state.model.langs.filter((l) => !langs.includes(l));
      if (other.length) keys.push(key(th.other, 'Other', { keys: other.map((l) => `lang:${l.id}`) }));
    } else if (paint.unit) {
      const T = state.T;
      const max = { lines: T.scales.lines, cx: T.scales.cx, churn: T.scales.churn, age: T.scales.age, fanin: S.fanin(T.I, detailRank()).scale }[state.paint];
      const lo = state.paint === 'age' ? `${Math.round(max)}+ days` : '0';
      const hi = state.paint === 'age' ? 'today' : `${short(Math.round(max))}+ ${paint.unit}`;
      keys.push(h('span', null, lo), rampBrush(state.paint), h('span', null, hi));
    } else if (state.paint === 'issues') {
      keys.push(key(STATUS.critical, 'High', { key: 'sev:3' }), key(STATUS.serious, 'Medium', { key: 'sev:2' }), key(STATUS.warn, 'Low', { key: 'sev:1' }), key(th.neutral, 'None', { key: 'sev:0' }));
    } else if (state.paint === 'review') {
      keys.push(key(STATUS.good, 'Reviewed', { key: 'rev:ok' }), key(STATUS.warn, 'Changed since', { key: 'rev:stale' }), key(th.neutral, 'Not yet', { keys: ['rev:none', 'rev:some'] }));
    } else if (state.paint === 'stage') {
      keys.push(key(STATUS.good, 'Staged new', { key: 'stage:add' }), key(th.accent, 'Staged edit', { key: 'stage:edit' }), key(STATUS.critical, 'Staged delete', { key: 'stage:delete' }), key(css(mix(rgb(th.neutral), rgb(STATUS.warn), 0.55)), 'Uncommitted', { key: 'stage:dirty' }));
    } else if (state.paint === 'reach') {
      if (setEmpty()) keys.push(h('span', { class: 'muted' }, 'Select something to see its reach'));
      else {
        const step = (dir, n) => key(css(colorOf(`reach:${dir}${n}`, 0)), n === 3 ? '3+' : String(n), { key: `reach:${dir}${n}` });
        keys.push(key(th.ink, 'Selection', null), h('span', { class: 'muted' }, 'Uses'), step('out', 1), step('out', 2), step('out', 3), h('span', { class: 'muted' }, 'Used by'), step('in', 1), step('in', 2), step('in', 3), key(th.series[6], 'Both', { key: 'reach:both' }));
      }
    }
    if (state.links !== 'none' && (state.linkList?.length || !setEmpty())) {
      keys.push(h('span', { class: 'title', style: { marginLeft: '8px' } }, 'Links'));
      if (state.links === 'focus') {
        keys.push(h('span', { class: 'key', title: 'Links from the selection' }, h('i', { class: 'sw', style: { background: th.series[0] } }), 'outgoing'), h('span', { class: 'key', title: 'Links into the selection' }, h('i', { class: 'sw', style: { background: th.series[1] } }), 'incoming'));
        if (selIds().length > 1) keys.push(h('span', { class: 'key' }, h('i', { class: 'sw', style: { background: th.series[6] } }), 'inside'));
      }
      for (const kind of KIND_ORDER) {
        if (!state.model.linkKinds.includes(kind)) continue;
        const on = kindOn(kind);
        const color = state.links === 'all' ? (kind === 'change' ? th.ink2 : th.series[LINK_COLOR[kind]]) : th.ink3;
        keys.push(h('button', { class: `key kind${on ? '' : ' off'}`, 'aria-pressed': String(on), title: `${on ? 'Hide' : 'Show'} ${LINK_NAMES[kind]} links`, onclick: () => hub.emit('view.kinds', { kind, on: !on }) },
          h('i', { class: 'sw line', style: { background: color } }), LINK_NAMES[kind]));
      }
    }
  }
  legend.replaceChildren(...keys);
  if (!legendFade.soon) legendFade.soon = requestAnimationFrame(() => { legendFade.soon = 0; legendFade(); });
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
  const box = $('#toasts');
  box.append(el);
  // Keep the stack short: the newest two plus any errors.
  const quiet = [...box.children].filter((t) => !t.classList.contains('error'));
  for (const t of quiet.slice(0, -2)) t.remove();
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
  for (const k of ['layout', 'paint', 'links', 'detail', 'theme', 'dock', 'kinds', 'height', 'mode']) store.save(k, state[k]);
}

function refresh() {
  colorItems();
  buildLinks();
  drawSelection();
  drawFoot();
  drawAct();
  requestDraw();
}

const replayCtx = () => ({ I: state.T.I, rank: detailRank(), stageIndex: state.stageIndex });
const isLive = (s) => !!s.recipe && (s.recipe.length > 1 || !s.recipe[0].seed);

// Make `s` the current set and redraw what depends on it.
function commitSet(s, { line } = {}) {
  state.set = s;
  state.setVer++;
  state.selLine = line;
  if (setEmpty()) state.isolate = false;
  if (state.narrow) {
    if (!setEmpty() && !state.sheet) { state.sheet = 'info'; document.body.classList.add('sheet-open'); }
    if (setEmpty() && state.sheet === 'info') { state.sheet = null; document.body.classList.remove('sheet-open'); }
  }
  if (state.isolate || state.paint === 'reach') colorItems();
  if (state.lay?.kind === 'city') city.setChanged();
  buildLinks();
  drawSelection();
  drawCrumbs();
  drawAct();
  drawFoot();
  if (state.dock === 'change' || state.sheet === 'change' || state.narrow) { drawBar(); drawDock(); }
  $('#live').textContent = setEmpty() ? 'Selection cleared' : `${state.set.name ?? S.setSummary(state.set)} selected`;
  requestDraw();
}

// A new set from node ids, optionally with a recipe that keeps it live.
function setFrom(ids, { recipe = null } = {}) {
  const keys = [...new Set(ids)].map((id) => node(id)?.key).filter((k) => k != null);
  if (keys.length > S.SET_CAP) toast(`Selected the first ${fmt(S.SET_CAP)} of ${fmt(keys.length)}.`);
  commitSet({ ...S.emptySet(), nodes: keys.slice(0, S.SET_CAP), recipe });
}

function loadSet(st) {
  const open = new Set((state.config.repos ?? []).map((r) => r.name));
  const keys = [...st.nodes, ...st.links.flatMap((l) => [l[0], l[1]]), ...st.ranges.map((r) => r[0])];
  const missing = [...new Set(keys.map((k) => k.split('/')[0]))].filter((r) => !open.has(r));
  if (missing.length) { toast(`Open ${missing.join(', ')} to load “${st.name}”.`, 'error'); return; }
  let s = { ...S.emptySet(), nodes: st.nodes, links: st.links, ranges: st.ranges, recipe: st.recipe ?? null, id: st.id, name: st.name };
  if (isLive(s)) s = S.replay(replayCtx(), s.recipe, s);
  else {
    const before = S.setSize(s);
    s = S.cleanSet(state.T.I, s);
    const dropped = before - S.setSize(s);
    if (dropped) toast(`${plural(dropped, 'member')} no longer exist${dropped === 1 ? 's' : ''} and ${dropped === 1 ? 'was' : 'were'} left out.`);
  }
  commitSet(s);
  const first = selIds()[0];
  if (first > 0) flyTo(first);
}

function selectLevel(level) {
  const lay = state.lay;
  const ids = [...lay.rect.keys()].filter((id) => lay.levelOf?.(id) === level);
  setFrom(ids, { recipe: [{ level, rank: detailRank() }] });
}

// Climb both ends of a link one folder level per step while they stay apart.
function climb(a, b, level) {
  const N = state.T.N;
  let pa = a, pb = b;
  for (let i = 0; i < level; i++) {
    const na = N[pa].up, nb = N[pb].up;
    if (na <= 0 || nb <= 0 || na === nb || isUnder(na, nb) || isUnder(nb, na)) return i ? [pa, pb] : null;
    pa = na; pb = nb;
  }
  return [pa, pb];
}

hub.on('link.up', () => { state.live = true; drawFoot(); wire.ask('hello'); });
hub.on('link.down', () => { state.live = false; drawFoot(); });

hub.on('hello', (d) => {
  state.config = d.config ?? {};
  state.stage = d.stage ?? state.stage;
  state.stageIndex = new Map(state.stage.items.map((it) => [it.key, it.state]));
  state.agent.busy = !!d.busy;
  state.acts = d.acts ?? [];
  state.saved = d.sets ?? [];
  if (d.model) hub.emit('repo.model', d.model);
  else if (!state.model) hub.emit('box.open', 'open');
  drawDock();
});

hub.on('repo.model', (m) => {
  for (const el of document.querySelectorAll('.toast[data-opening]')) el.remove();
  const first = !state.model;
  if (!m.preview) state.base = m;
  state.model = m;
  state.T = prep(m);
  state.mapLay = null;
  state.texts.clear();
  state.wanted.clear();
  state.sites.clear();
  state.wantedSites.clear();
  // Live sets replay their recipe on every new model; others drop keys that
  // no longer exist.
  const s = state.set;
  state.set = isLive(s) ? S.replay(replayCtx(), s.recipe, s) : S.cleanSet(state.T.I, s);
  state.setVer++;
  if (state.hover >= m.nodes.length) state.hover = -1;
  state.hoverSite = null;
  relayout({ animate: !first, fit: first });
  drawCrumbs();
  drawDock();
  drawSelection();
  drawFoot();
  drawAct();
  if (state.query) { state.matches = runFind(state.query); drawFind(); }
  if (state.code) drawCode();
  $('#open-box').open && state.config.repos?.length && $('#open-box').close();
});

hub.on('scan.step', (d) => { state.scan = d; drawFoot(); });
hub.on('config.state', (d) => { state.config = d; drawDock(); if ($('#open-box').open) drawOpenBox(state.openDir); });
hub.on('file.text', ({ key, text, staged }) => {
  if (staged) return;
  state.wanted.delete(key);
  if (text == null) return;
  const id = idOf(key);
  state.texts.set(key, tokenize(text, id >= 0 ? node(id).lang : 'text'));
  if (state.texts.size > 400) state.texts.delete(state.texts.keys().next().value);
  if (state.panelFiles?.has(key)) drawSelection();
  requestDraw();
});
hub.on('file.links', (d) => {
  if (!d?.key) return;
  state.sites.set(d.key, d);
  state.wantedSites.delete(d.key);
  if (state.set.links.length) buildLinks();
  if (state.panelFiles?.has(d.key)) drawSelection();
  requestDraw();
});
hub.on('sets.state', (d) => { state.saved = d.sets ?? []; if (!$('#info').hidden) drawSelection(); if (!$('#find-list').hidden) drawFind(); });
hub.on('find.hits', (d) => { state.findHits = d; drawFind(); });
hub.on('note', (d) => toast(d.text, d.level));

hub.on('stage.state', (d) => {
  state.stage = d;
  state.stageIndex = new Map(d.items.map((it) => [it.key, it.state]));
  // Staged sizes shape the Map, so a new staged change can move things once;
  // toggling Preview never does.
  const sig = state.T ? shapeOf(state.T)?.sig ?? '' : '';
  if (state.T && state.mapLay && sig !== state.mapLay.shape) { state.mapLay = null; relayout({ animate: true }); }
  else if (state.paint === 'stage') colorItems();
  if (state.code) drawCode();
  drawDock();
  drawFoot();
  requestDraw();
});

hub.on('agent.step', (d) => {
  const log = state.agent.log;
  const batch = state.agent.batch;
  if (d.kind === 'start') {
    state.agent.busy = true;
    state.agent.halting = false;
    const act = state.acts.find((a) => a.id === d.act);
    const name = act?.name ?? 'Ask';
    if (d.mode === 'each') {
      state.agent.batch = { kind: 'batch', title: d.text && d.text !== name ? `${name}: ${d.text}` : name, total: d.total, items: [], text: [] };
      log.push(state.agent.batch);
    } else {
      state.agent.batch = null;
      log.push({ kind: 'user', text: act ? (d.text && d.text !== act.name ? `${act.name}: ${d.text}` : act.name) : d.text, scope: d.set && S.setSize(d.set) ? S.setSummary(d.set) : '' });
    }
  } else if (d.kind === 'item' && batch) {
    batch.items[d.index] = { label: d.label, state: d.state, files: d.files, error: d.error };
  } else if (d.kind === 'halt' && batch) {
    batch.halting = true;
    state.agent.halting = true;
  } else if (d.kind === 'text') {
    if (batch && d.index != null) { batch.text[d.index] = (batch.text[d.index] ?? '') + d.text; return; }
    const last = log.at(-1);
    if (last?.kind === 'text') { last.text += d.text; if (last.el?.isConnected) { renderText(last.el, last.text); return; } }
    else log.push({ kind: 'text', text: d.text });
  } else if (d.kind === 'tool') {
    if (!batch) log.push(d);
    const key = d.args?.path ?? d.args?.to;
    const id = key ? idOf(String(key).split('#')[0]) : -1;
    if (id >= 0) { state.flash.set(id, performance.now() + 1200); requestDraw(); }
  }
  if (state.dock === 'change' || state.sheet === 'change') drawDock();
});

hub.on('agent.done', (d) => {
  state.agent.busy = false;
  state.agent.done = (state.agent.done ?? 0) + 1;
  state.agent.halting = false;
  const log = state.agent.log;
  if (d.batch && state.agent.batch) { state.agent.batch.done = true; state.agent.batch = null; }
  else if (d.error) log.push({ kind: 'error', text: d.error });
  else if (d.text && log.at(-1)?.kind !== 'text') log.push({ kind: 'text', text: d.text });
  else if (d.text && log.at(-1)?.kind === 'text') log.at(-1).text = d.text;
  if (d.batch && d.error) log.push({ kind: 'error', text: d.error });
  drawDock();
});

// A free prompt: the agent sees the current set (or the given one).
hub.on('agent.ask', ({ prompt, set }) => {
  if (state.agent.busy) { toast('The agent is still working.', 'error'); return; }
  openChange();
  wire.ask('agent.run', { prompt, set: payload(set ?? state.set), mode: set ? 'together' : state.mode });
});
hub.on('act.run', ({ id, mode, set }) => {
  openChange();
  wire.ask('agent.run', { act: id, set: payload(set ?? state.set), mode: mode ?? state.mode });
});
hub.on('act.mode', (mode) => { state.mode = mode === 'each' ? 'each' : 'together'; savePrefs(); drawAct(); drawDock(); });
hub.on('agent.reset', () => { state.agent.log = []; state.agent.batch = null; wire.ask('agent.reset'); drawDock(); });

hub.on('view.layout', (id) => {
  if (!LAYOUTS.some((l) => l.id === id) || id === state.layout) return;
  state.layout = id;
  savePrefs();
  drawBar();
  relayout({ animate: true, fit: true });
  drawFoot();
  drawDock();
  if ((id === 'graph' || id === 'layers') && state.lay?.rect.size > 900 && state.detail !== 'dir') toast(`${fmt(state.lay.rect.size)} parts shown. Set Detail to Folders (press D) for a clearer picture.`);
});
hub.on('view.paint', (id) => {
  state.paint = id;
  savePrefs();
  drawBar();
  colorItems();
  if (state.layout === 'city' && state.height === 'same') city.reheight();
  drawFoot();
  requestDraw();
});
hub.on('view.height', (id) => {
  if (!HEIGHTS.some((x) => x.id === id)) return;
  state.height = id;
  savePrefs();
  drawBar();
  drawDock();
  if (state.layout === 'city') city.reheight();
  requestDraw();
});
hub.on('view.angle', (id) => { if (state.layout === 'city') { city.angle(id); drawDock(); } });
hub.on('view.kinds', ({ kind, on }) => { state.kinds = { ...state.kinds, [kind]: on }; savePrefs(); buildLinks(); drawFoot(); requestDraw(); });
hub.on('view.detail', (id) => {
  state.detail = id;
  savePrefs();
  drawBar();
  if (state.layout === 'graph' || state.layout === 'layers') relayout({ animate: true, fit: true });
  else { if (state.paint === 'reach' || state.paint === 'fanin') colorItems(); if (state.layout === 'city' && ['fanin', 'same'].includes(state.height)) city.reheight(); buildLinks(); requestDraw(); }
  drawFoot();
});
hub.on('view.links', (id) => { state.links = id; savePrefs(); drawBar(); buildLinks(); drawFoot(); requestDraw(); });
hub.on('view.theme', (id) => { state.theme = id; savePrefs(); applyTheme(); refresh(); drawBar(); });

hub.on('pick.hover', ({ id, line = 0, site = null }) => {
  state.hover = id;
  state.hoverLine = line;
  state.hoverSite = site;
  if (state.links === 'focus') buildLinks();
  if (state.lay?.kind === 'city') city.hoverChanged();
  requestDraw();
});
hub.on('pick.set', ({ ids, add = false, line, keep = false }) => {
  const keys = ids.map((id) => node(id)?.key).filter((k) => k != null);
  let s = state.set;
  if (add) {
    const set = new Set(s.nodes);
    for (const k of keys) { if (set.has(k) && !keep) set.delete(k); else set.add(k); }
    s = { ...s, nodes: [...set], recipe: null };
  } else s = { ...S.emptySet(), nodes: keys };
  commitSet(s, { line });
});
hub.on('pick.link', ({ link: e, add = false, bundle = false }) => {
  let member = memberOfLink(e);
  if (bundle) {
    const k = S.linkKey(member);
    const level = state.bundle?.base === k ? state.bundle.level + 1 : 1;
    const ends = climb(e.a, e.b, level);
    if (!ends) { toast('These two are already as far apart as folders go.'); return; }
    if (state.bundle?.base === k && ends[0] === state.bundle.ends?.[0] && ends[1] === state.bundle.ends?.[1]) { toast('That is the top folder level.'); return; }
    state.bundle = { base: k, level, ends };
    member = [node(ends[0]).key, node(ends[1]).key, '*'];
  } else state.bundle = null;
  hub.emit('pick.links', { links: [member], add, keepBundle: bundle });
});
hub.on('pick.links', ({ links, add = false, keepBundle = false }) => {
  if (!keepBundle) state.bundle = null;
  const s = state.set;
  if (add) {
    const have = new Set(s.links.map(S.linkKey));
    commitSet({ ...s, links: [...s.links, ...links.filter((l) => !have.has(S.linkKey(l)))], recipe: null });
  } else commitSet({ ...S.emptySet(), links });
  for (const l of links) { const a = idOf(l[0]); const f = a >= 0 ? state.T.fileOf[a] : -1; if (f >= 0) wantSites(node(f).key); }
});
hub.on('pick.range', ({ file, from, to, add = false, replaceLast = false }) => {
  const key = node(file)?.key;
  if (!key) return;
  const range = [key, from, to];
  const s = state.set;
  if (replaceLast) {
    const i = s.ranges.map((r) => r[0]).lastIndexOf(key);
    const ranges = [...s.ranges];
    if (i >= 0) ranges[i] = range; else ranges.push(range);
    commitSet({ ...s, ranges, recipe: null });
  } else if (add) commitSet({ ...s, ranges: [...s.ranges, range], recipe: null });
  else commitSet({ ...S.emptySet(), ranges: [range] });
});
hub.on('pick.drop', ({ key, link, range }) => {
  const s = state.set;
  commitSet({
    ...s,
    nodes: key ? s.nodes.filter((k) => k !== key) : s.nodes,
    links: link ? s.links.filter((l) => S.linkKey(l) !== S.linkKey(link)) : s.links,
    ranges: range ? s.ranges.filter((r) => r.join('|') !== range.join('|')) : s.ranges,
    recipe: null,
  });
});
hub.on('pick.clear', () => {
  if (setEmpty()) return;
  state.bundle = null;
  commitSet(S.emptySet());
  drawBar();
  drawDock();
});
hub.on('set.grow', ({ op, depth = 1 }) => {
  if (setEmpty()) { toast('Select something to grow from.'); return; }
  const base = state.set.recipe ? state.set : { ...state.set, recipe: [{ seed: [...state.set.nodes] }] };
  const next = S.grow(state.T.I, base, op, { rank: detailRank(), depth });
  const added = S.setSize(next) - S.setSize(state.set);
  if (op !== 'inside' && op !== 'parent' && added <= 0) { toast('Nothing more to add.'); return; }
  commitSet(next);
  if (added > 0) toast(`Added ${plural(added, op === 'path' || op === 'loop' || op === 'copies' ? 'member' : 'part')}.`);
});
hub.on('set.isolate', (on) => {
  state.isolate = !!on && !setEmpty();
  colorItems();
  if (state.lay?.kind === 'city') city.setChanged();
  drawSelection();
  requestDraw();
});
hub.on('set.freeze', () => { state.set = { ...state.set, recipe: null }; drawSelection(); });
hub.on('set.load', (st) => loadSet(st));

hub.on('find.query', (q) => {
  state.query = q;
  state.findPick = 0;
  state.matches = runFind(q);
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
hub.on('check.waived', (on) => { state.showWaived = on; colorItems(); drawDock(); drawSelection(); requestDraw(); });

hub.on('dock.show', (id) => {
  if (state.narrow) state.sheet = id; else state.dock = id;
  savePrefs();
  drawBar();
  drawDock();
  drawAct();
});
hub.on('sheet.toggle', (id) => {
  state.sheet = state.sheet === id ? null : id;
  document.body.classList.toggle('sheet-open', !!state.sheet);
  drawBar();
  drawDock();
  drawSelection();
  drawAct();
  const ids = selIds();
  if (ids.length) flyTo(ids[0], 450); else fitAll(450);
});

hub.on('box.open', (which) => {
  if (which === 'open') drawOpenBox();
  else if (which === 'setup') drawSetupBox();
  else if (which === 'keys') drawKeysBox();
});

hub.on('code.open', ({ key, from, to, tab = 'code' }) => { state.code = { key, from, to, tab, editing: false }; drawCode(); });
hub.on('code.close', () => { state.code = null; $('#code').hidden = true; });

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
    const cityOn = state.lay?.kind === 'city';
    const cycle = (list, cur, d) => list[(list.findIndex((x) => x.id === cur) + d + list.length) % list.length].id;
    if (k >= '1' && k <= '4') hub.emit('view.layout', LAYOUTS[+k - 1].id);
    else if (k === 'c' || k === 'C') hub.emit('view.paint', cycle(PAINTS, state.paint, e.shiftKey ? -1 : 1));
    else if (k === 'd' || k === 'D') hub.emit('view.detail', cycle(DETAILS, state.detail, e.shiftKey ? -1 : 1));
    else if (k === 'l' || k === 'L') hub.emit('view.links', cycle(LINK_MODES, state.links, 1));
    else if (k === 'f' || k === 'F' || k === '0') fitAll();
    else if (k === 'Enter' && e.shiftKey) openCode();
    else if (k === 'Enter' && ids.length) flyTo(ids[0]);
    else if ((k === 'u' || k === 'U' || k === 'Backspace') && ids.length) { const up = node(ids[0]).up; if (up > 0) { hub.emit('pick.set', { ids: [up] }); flyTo(up); } }
    else if (k === ']') hub.emit('set.grow', { op: 'out' });
    else if (k === '[') hub.emit('set.grow', { op: 'in' });
    else if (k === '}') hub.emit('set.grow', { op: 'out', depth: Infinity });
    else if (k === '{') hub.emit('set.grow', { op: 'in', depth: Infinity });
    else if (k === 'x' || k === 'X') runAct('explain');
    else if (k === 'a' || k === 'A') openPalette();
    else if (k === 'i' || k === 'I') hub.emit('set.isolate', !state.isolate);
    else if ((k === 'v' || k === 'V') && cityOn) hub.emit('view.angle', cycle(ANGLES, ANGLES.some((a) => a.id === state.angle) ? state.angle : 'low', 1));
    else if ((k === ',' || k === '.') && cityOn) city.turn(k === ',' ? -1 : 1);
    else if (k === 'r' || k === 'R') { if (!setEmpty()) runAct('review'); }
    else if (k === 'e' || k === 'E') openAsk();
    else if (k === 'F2' && ids.length === 1) runAct('rename');
    else if ((k === 'm' || k === 'M') && ids.length === 1) runAct('move');
    else if ((k === 'Delete') && ids.length) runAct('delete');
    else if (k === 'o' || k === 'O') hub.emit('box.open', 'open');
    else if (k === '?') hub.emit('box.open', 'keys');
    else if (k === '+' || k === '=') d3.select('#view').transition().duration(200).call(zoom.scaleBy, 1.5);
    else if (k === '-') d3.select('#view').transition().duration(200).call(zoom.scaleBy, 1 / 1.5);
    else if (k.startsWith('Arrow')) {
      const step = 120;
      const [dx, dy] = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[k];
      d3.select('#view').transition().duration(150).call(zoom.translateBy, dx / state.t.k, dy / state.t.k);
    } else if (k === 'Escape') {
      // Popover, Code sheet, find, rule spotlight, isolate, the set, then fit.
      if (!$('#ask').hidden) unpop();
      else if (state.code) { if (state.code.editing) { state.code.editing = false; drawCode(); } else hub.emit('code.close'); }
      else if (state.query) { $('#find-box').value = ''; hub.emit('find.query', ''); }
      else if (state.spot) hub.emit('check.spot', null);
      else if (state.isolate) hub.emit('set.isolate', false);
      else if (!setEmpty()) hub.emit('pick.clear');
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
  drawSelection();
  drawAct();
  requestDraw();
}

function idle() {
  return new Promise((resolve) => {
    const check = () => {
      const view = document.querySelector('#view');
      const moving = view.__transition && Object.keys(view.__transition).length > 0;
      const busy = R.morph || R.cam || frameAsked || state.pending > 0 || state.wanted.size > 0 || state.wantedSites.size > 0 || moving || city.busy();
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
  window.addEventListener('resize', () => { resize(); legendFade(); });
  const legend = $('#legend');
  legend.addEventListener('scroll', legendFade);
  legend.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || legend.scrollWidth <= legend.clientWidth) return;
    legend.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
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
  if (id < 0) return null;
  if (state.lay?.kind === 'city') return city.center(id);
  const r = rectsOf(id)[0];
  if (!r) return null;
  return toScreen(r.x + r.w / 2, r.y + Math.min(r.h / 2, (r.head ?? r.h) / 2 + 1));
}

// The drawn link between two keys, as screen points.
function linkPoints(aKey, bKey) {
  const a = idOf(aKey), b = idOf(bKey);
  const hit = linkScreens().find(({ e }) => e.a === a && e.b === b);
  if (!hit) return null;
  const out = [];
  for (let i = 0; i < hit.xy.length; i += 2) out.push([hit.xy[i], hit.xy[i + 1]]);
  return out;
}

// The screen point halfway along the drawn link between two keys.
function linkPoint(aKey, bKey) {
  const a = idOf(aKey), b = idOf(bKey);
  for (const { e, xy } of linkScreens()) {
    if (e.a !== a || e.b !== b) continue;
    const i = Math.floor(xy.length / 4) * 2;
    return [xy[i], xy[i + 1]];
  }
  return null;
}

window.devibe = {
  state, hub, wire, idle, flyTo, fitAll, pickAt, toScreen, centerOf, linkPoint, linkPoints, grip: gripRect, R, actions, runAct, barActions: () => barActions().map((a) => a.id),
  linePoint: (key, line, chars = 6) => { const f = idOf(key); const at = f >= 0 ? siteAnchor(f, line) : null; if (!at) return null; const c = (state.lay.map ?? state.lay).code.get(f); return toScreen(at[0] + chars * CODE.cw * c.lh, at[1], at[2] ?? 0); },
  pickLink: (sx, sy) => { const e = pickLink(sx, sy, 6); return e ? memberOfLink(e) : null; },
  setOf: () => state.set,
  viewport: () => viewport(),
  city: city.debug,
};
boot();
