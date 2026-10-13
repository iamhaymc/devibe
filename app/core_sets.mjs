// devibe sets — the DOM-free core shared by the client and the server: the
// model index, lifting, dependency levels, set growth, set boundaries, find
// queries, color classes, and recipes. No DOM, d3, or three.js, so it runs in
// Node and has its own unit tests (sets.test.mjs).

export const RANK = { root: 0, repo: 1, dir: 2, file: 3, space: 3.5, type: 4, part: 4.5, func: 5 };
export const DETAIL_RANK = { dir: 2, file: 3, type: 4, func: 5 };
export const LEVEL_RANK = { high: 3, medium: 2, low: 1 };
// Links that mean "depends on". Copies and changes-with are left out of loops,
// levels, lifting, and growth unless an operation is about them.
export const STATIC = new Set(['import', 'call', 'use', 'base']);
export const SET_CAP = 5000;
export const PATH_CAP = 200;

// ───────────────────────────── Index ─────────────────────────────

const cache = new WeakMap();

// Children, depth, owning file, symbol depth, key lookup, and link lists per
// node. Cached per model object.
export function index(model) {
  let I = cache.get(model);
  if (I) return I;
  const N = model.nodes;
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
  model.links.forEach((l, i) => { out[l[0]].push(i); inn[l[1]].push(i); });
  I = { model, N, n, kids, depth, fileOf, symDepth, byKey, out, inn, kinds: model.linkKinds, memo: new Map() };
  cache.set(model, I);
  return I;
}

function memo(I, key, fn) {
  if (!I.memo.has(key)) I.memo.set(key, fn());
  return I.memo.get(key);
}

export const idOf = (I, key) => I.byKey.get(key) ?? -1;
export const kindName = (I, li) => I.kinds[I.model.links[li][2]];

export function liftTo(I, id, rank) {
  const N = I.N;
  while (id > 0 && RANK[N[id].kind] > rank) id = N[id].up;
  return id;
}

export function isUnder(I, id, anc) {
  const N = I.N;
  for (let p = id; p >= 0; p = N[p].up) if (p === anc) return true;
  return false;
}

export function walk(I, id, fn, cap = 20000) {
  const stack = [id];
  let seen = 0;
  while (stack.length && seen < cap) {
    const x = stack.pop();
    seen++;
    if (fn(x) === false) continue;
    for (const k of I.kids[x]) stack.push(k);
  }
}

export function pathOf(I, id) {
  const out = [];
  for (let p = id; p > 0; p = I.N[p].up) out.unshift(p);
  return out;
}

// The part on `id`'s side just below the lowest common ancestor with `other`:
// used when lifting would swallow the other end.
function sideOf(I, id, other) {
  let x = id;
  while (x > 0 && !isUnder(I, other, I.N[x].up)) x = I.N[x].up;
  return x;
}

// Lift `id` to `rank`, but never to a part that contains `from`.
export function liftAway(I, id, rank, from) {
  const x = liftTo(I, id, rank);
  return isUnder(I, from, x) ? sideOf(I, id, from) : x;
}

// ───────────────────────────── Facts ─────────────────────────────

const quantile = (sorted, p) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p, lo = Math.floor(i);
  return sorted[lo] + ((sorted[lo + 1] ?? sorted[lo]) - sorted[lo]) * (i - lo);
};

// Issues and measures rolled up the tree, plus the scales colors use.
export function facts(I) {
  return memo(I, 'facts', () => {
    const { N, n, model } = I;
    const issuesOf = Array.from({ length: n }, () => []);
    model.issues.forEach((iss, i) => issuesOf[iss.node].push(i));
    const sev = new Uint8Array(n), count = new Int32Array(n);
    const cxMax = new Float32Array(n), nestMax = new Float32Array(n), argsMax = new Float32Array(n);
    const churn = new Float32Array(n), time = new Float64Array(n);
    for (const iss of model.issues) {
      if (iss.waived) continue;
      sev[iss.node] = Math.max(sev[iss.node], LEVEL_RANK[iss.level] ?? 1);
      count[iss.node]++;
    }
    for (const x of N) {
      if (x.kind === 'func') { cxMax[x.id] = x.cx ?? 0; nestMax[x.id] = x.nest ?? 0; argsMax[x.id] = x.args ?? 0; }
      if (x.kind === 'file') { churn[x.id] = x.churn ?? 0; time[x.id] = x.time ?? 0; }
    }
    for (let i = n - 1; i > 0; i--) {
      const up = N[i].up;
      if (up < 0) continue;
      sev[up] = Math.max(sev[up], sev[i]);
      count[up] += count[i];
      cxMax[up] = Math.max(cxMax[up], cxMax[i]);
      nestMax[up] = Math.max(nestMax[up], nestMax[i]);
      argsMax[up] = Math.max(argsMax[up], argsMax[i]);
      if (N[i].kind === 'file' || N[i].kind === 'dir' || N[i].kind === 'repo') { churn[up] = Math.max(churn[up], churn[i]); time[up] = Math.max(time[up], time[i]); }
    }
    for (const x of N) if (I.fileOf[x.id] >= 0 && x.kind !== 'file') { churn[x.id] = churn[I.fileOf[x.id]]; time[x.id] = time[I.fileOf[x.id]]; }
    const files = N.filter((x) => x.kind === 'file');
    const now = Date.now() / 1000;
    const sorted = (f) => files.map(f).filter((v) => v > 0).sort((a, b) => a - b);
    const scales = {
      lines: quantile(sorted((f) => f.lines), 0.97) || 1,
      cx: Math.max(10, quantile(N.filter((x) => x.kind === 'func').map((x) => x.cx ?? 0).sort((a, b) => a - b), 0.97)),
      churn: Math.max(2, quantile(sorted((f) => f.churn ?? 0), 0.97)),
      age: Math.max(30, quantile(sorted((f) => (f.time ? (now - f.time) / 86400 : 0)), 0.97)),
    };
    return { issuesOf, sev, count, cxMax, nestMax, argsMax, churn, time, scales, now };
  });
}

// ───────────────────────────── Lifted graphs ─────────────────────────────

// Static links lifted to a rank (folders, files, types, functions) and merged.
// Cached per rank on the model index.
export function liftGraph(I, rank) {
  return memo(I, 'lift:' + rank, () => {
    const { N, model } = I;
    const ids = new Set();
    for (const x of N) if (RANK[x.kind] === rank || (rank === 2 && x.kind === 'repo' && I.kids[x.id].some((k) => N[k].kind === 'file'))) ids.add(x.id);
    const merged = new Map();
    for (const [s, t, k, w] of model.links) {
      if (!STATIC.has(I.kinds[k])) continue;
      const a = liftTo(I, s, rank), b = liftTo(I, t, rank);
      if (a === b || a <= 0 || b <= 0 || isUnder(I, a, b) || isUnder(I, b, a)) continue;
      ids.add(a); ids.add(b);
      const key = a * 1e7 + b;
      const e = merged.get(key);
      if (e) e.w += w; else merged.set(key, { a, b, w });
    }
    const links = [...merged.values()];
    const out = new Map(), inn = new Map();
    for (const e of links) {
      if (!out.has(e.a)) out.set(e.a, []);
      if (!inn.has(e.b)) inn.set(e.b, []);
      out.get(e.a).push(e.b);
      inn.get(e.b).push(e.a);
    }
    return { ids: [...ids], links, out, inn };
  });
}

// Every part at a rank: each leaf of the tree lifted to that rank. A folder is
// a part at Folders detail when it holds files directly.
export function partsAt(I, rank) {
  return memo(I, 'parts:' + rank, () => {
    const out = new Set();
    for (const x of I.N) if (x.id > 0 && !I.kids[x.id].length) { const p = liftTo(I, x.id, rank); if (p > 0) out.add(p); }
    return [...out];
  });
}

// Tarjan's strongly connected components; returns groups of size > 1.
export function strongGroups(graph) {
  let index = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const visit = (v) => {
    const work = [[v, [...(graph.get(v) ?? [])], 0]];
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    while (work.length) {
      const top = work.at(-1);
      const [node, next] = top;
      if (top[2] < next.length) {
        const w = next[top[2]++];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++; stack.push(w); on.add(w);
          work.push([w, [...(graph.get(w) ?? [])], 0]);
        } else if (on.has(w)) low.set(node, Math.min(low.get(node), idx.get(w)));
      } else {
        work.pop();
        if (work.length) { const parent = work.at(-1)[0]; low.set(parent, Math.min(low.get(parent), low.get(node))); }
        if (low.get(node) === idx.get(node)) {
          const group = [];
          let w;
          do { w = stack.pop(); on.delete(w); group.push(w); } while (w !== node);
          if (group.length > 1) out.push(group.reverse());
        }
      }
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out;
}

// Dependency levels: strongly connected groups share a level, and each level
// is one more than the highest level it depends on. Base code is level 0.
export function levels(ids, links) {
  const graph = new Map(ids.map((id) => [id, []]));
  for (const e of links) graph.get(e.a)?.push(e.b);
  const comp = new Map();
  let compN = 0;
  for (const g of strongGroups(graph)) { for (const id of g) comp.set(id, compN); compN++; }
  for (const id of ids) if (!comp.has(id)) comp.set(id, compN++);
  const compOut = Array.from({ length: compN }, () => new Set());
  const compSize = new Int32Array(compN);
  for (const id of ids) compSize[comp.get(id)]++;
  for (const e of links) { const a = comp.get(e.a), b = comp.get(e.b); if (a != null && b != null && a !== b) compOut[a].add(b); }
  const level = new Int32Array(compN).fill(-1);
  for (let c = 0; c < compN; c++) {
    const work = [c];
    while (work.length) {
      const x = work.at(-1);
      if (level[x] >= 0) { work.pop(); continue; }
      let ready = true, best = 0;
      for (const y of compOut[x]) { if (level[y] < 0) { ready = false; work.push(y); } else best = Math.max(best, level[y] + 1); }
      if (ready) { level[x] = best; work.pop(); }
    }
  }
  let maxL = 0;
  for (let c = 0; c < compN; c++) maxL = Math.max(maxL, level[c]);
  return { comp, compSize, level, maxL, levelOf: (id) => (comp.has(id) ? level[comp.get(id)] : -1) };
}

// Parts at a rank that sit in a dependency loop, and every part above them.
export function loopsAt(I, rank) {
  return memo(I, 'loops:' + rank, () => {
    const inLoop = new Set(), above = new Set();
    for (const g of strongGroups(liftGraph(I, rank).out)) for (const id of g) {
      inLoop.add(id);
      for (let p = id; p > 0 && !above.has(p); p = I.N[p].up) above.add(p);
    }
    return { inLoop, above };
  });
}

export function levelsAt(I, rank) {
  return memo(I, 'levels:' + rank, () => { const g = liftGraph(I, rank); return levels(g.ids, g.links); });
}

// How many distinct parts at a rank link into each node from outside it.
export function fanin(I, rank) {
  return memo(I, 'fanin:' + rank, () => {
    const { N, n, model } = I;
    const count = new Int32Array(n);
    const stamp = new Int32Array(n).fill(-1);
    const groups = new Map();
    for (let li = 0; li < model.links.length; li++) {
      const [s, , k] = model.links[li];
      if (!STATIC.has(I.kinds[k])) continue;
      const a = liftTo(I, s, rank);
      if (a <= 0) continue;
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push(li);
    }
    for (const [a, list] of groups) {
      for (const li of list) {
        for (let p = model.links[li][1]; p > 0; p = N[p].up) {
          if (stamp[p] === a) break;
          stamp[p] = a;
          if (isUnder(I, a, p)) break;
          if (!isUnder(I, p, a)) count[p]++;
        }
      }
    }
    const vals = partsAt(I, rank).map((id) => count[id]).filter((v) => v > 0).sort((x, y) => x - y);
    return { count, scale: Math.max(3, quantile(vals, 0.97)) };
  });
}

// ───────────────────────────── Sets ─────────────────────────────

export function emptySet() {
  return { nodes: [], links: [], ranges: [], hops: {}, recipe: null, id: null, name: null };
}

export const setSize = (s) => (s ? s.nodes.length + s.links.length + s.ranges.length : 0);
export const linkKey = (l) => `${l[0]}|${l[1]}|${l[2]}`;

export function setSummary(s) {
  const parts = [];
  if (s.nodes.length) parts.push(`${s.nodes.length} part${s.nodes.length === 1 ? '' : 's'}`);
  if (s.links.length) parts.push(`${s.links.length} link${s.links.length === 1 ? '' : 's'}`);
  if (s.ranges.length) parts.push(`${s.ranges.length} line range${s.ranges.length === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'Nothing selected';
}

// Drop members whose keys no longer exist.
export function cleanSet(I, s) {
  return {
    ...s,
    nodes: s.nodes.filter((k) => I.byKey.has(k)),
    links: s.links.filter((l) => I.byKey.has(l[0]) && I.byKey.has(l[1])),
    ranges: s.ranges.filter((r) => I.byKey.has(r[0])),
  };
}

// The deepest symbol (or the file) that holds a line.
export function ownerOfLine(I, fileId, line) {
  let best = fileId;
  walk(I, fileId, (x) => {
    const n = I.N[x];
    if (x === fileId) return true;
    if (!n.from || line < n.from || line > n.to) return false;
    best = x;
    return true;
  }, 5000);
  return best;
}

// Node ids a set starts from: node members, link ends, and range owners.
export function seedIds(I, s) {
  const out = new Set();
  for (const k of s.nodes) { const id = idOf(I, k); if (id >= 0) out.add(id); }
  for (const [a, b] of s.links) for (const k of [a, b]) { const id = idOf(I, k); if (id >= 0) out.add(id); }
  for (const [k, from, to] of s.ranges) {
    const f = idOf(I, k);
    if (f < 0) continue;
    const a = ownerOfLine(I, f, from), b = ownerOfLine(I, f, to);
    out.add(a === b ? a : f);
  }
  return [...out];
}

// The raw links a link member stands for: every link from under its first
// end to under its second, of its kind ('*' is any kind but changes-with).
export function linkIndices(I, member, cap = 4000) {
  const [aKey, bKey, kind] = member;
  const a = idOf(I, aKey), b = idOf(I, bKey);
  if (a < 0 || b < 0) return [];
  const out = [];
  const links = I.model.links;
  const ok = (k) => (kind === '*' ? I.kinds[k] !== 'change' : I.kinds[k] === kind);
  walk(I, a, (x) => {
    if (out.length >= cap) return false;
    for (const li of I.out[x]) if (ok(links[li][2]) && isUnder(I, links[li][1], b)) out.push(li);
    if (kind === 'change') for (const li of I.inn[x]) if (ok(links[li][2]) && isUnder(I, links[li][0], b)) out.push(li);
  });
  return out;
}

// The member (node id) that holds `id`, or -1.
function memberFinder(I, ids) {
  const set = new Set(ids);
  return (id) => { for (let p = id; p >= 0; p = I.N[p].up) if (set.has(p)) return p; return -1; };
}

// The set's interface: links between members, what members use outside, and
// what outside uses members. Outside ends are lifted to the rank.
export function boundary(I, s, rank, { kinds = STATIC } = {}) {
  const ids = s.nodes.map((k) => idOf(I, k)).filter((id) => id >= 0);
  const memberOf = memberFinder(I, ids);
  const links = I.model.links;
  const inside = new Map(), out = new Map(), inn = new Map();
  const add = (map, a, b, li) => {
    const key = a * 1e7 + b;
    let e = map.get(key);
    if (!e) map.set(key, (e = { a, b, w: 0, kinds: new Set(), list: [] }));
    e.w += links[li][3];
    e.kinds.add(I.kinds[links[li][2]]);
    if (e.list.length < 60) e.list.push(li);
  };
  for (const m of ids) {
    walk(I, m, (x) => {
      for (const li of I.out[x]) {
        const [, t, k] = links[li];
        if (!kinds.has(I.kinds[k])) continue;
        const mt = memberOf(t);
        if (mt === m) continue;
        if (mt >= 0) add(inside, m, mt, li);
        else add(out, m, liftAway(I, t, rank, m), li);
      }
      for (const li of I.inn[x]) {
        const [src, , k] = links[li];
        if (!kinds.has(I.kinds[k])) continue;
        if (memberOf(src) >= 0) continue;
        add(inn, liftAway(I, src, rank, m), m, li);
      }
    }, 20000);
  }
  const sort = (map) => [...map.values()].sort((p, q) => q.w - p.w).map((e) => ({ ...e, kinds: [...e.kinds] }));
  return { inside: sort(inside), out: sort(out), in: sort(inn) };
}

// Grow a set along links, at a rank. Ops: out (what it uses), in (what uses
// it), both, path, loop, copies, tests, inside. Returns a new set with the
// step appended to its recipe.
export function grow(I, s, op, { rank = 3, depth = 1 } = {}) {
  const next = { ...s, nodes: [...s.nodes], links: [...s.links], hops: { ...(s.hops ?? {}) } };
  const have = new Set(next.nodes);
  const haveLinks = new Set(next.links.map(linkKey));
  const ids = () => next.nodes.map((k) => idOf(I, k)).filter((id) => id >= 0);
  const addNode = (id, hop) => {
    const key = I.N[id].key;
    if (have.has(key) || next.nodes.length >= SET_CAP) return false;
    have.add(key);
    next.nodes.push(key);
    if (hop) next.hops[key] = hop;
    return true;
  };
  const addLink = (a, b, kind) => {
    const l = [I.N[a].key, I.N[b].key, kind];
    const k = linkKey(l);
    if (haveLinks.has(k)) return;
    haveLinks.add(k);
    next.links.push(l);
  };
  const links = I.model.links;
  if (op === 'out' || op === 'in' || op === 'both') {
    const dirs = op === 'both' ? ['out', 'in'] : [op];
    for (const dir of dirs) {
      let frontier = seedIds(I, s);
      const memberOf = memberFinder(I, ids());
      const max = depth === Infinity ? 64 : depth;
      const start = Math.max(0, ...Object.values(next.hops).map(Math.abs));
      for (let hop = 1; hop <= max && frontier.length; hop++) {
        const found = [];
        for (const f of frontier) {
          walk(I, f, (x) => {
            for (const li of dir === 'out' ? I.out[x] : I.inn[x]) {
              const [src, t, k] = links[li];
              if (!STATIC.has(I.kinds[k])) continue;
              const end = dir === 'out' ? t : src;
              if (isUnder(I, end, f)) continue;
              const p = liftAway(I, end, rank, f);
              if (p <= 0 || memberOf(p) >= 0 || have.has(I.N[p].key)) continue;
              if (addNode(p, start + hop)) found.push(p);
            }
          }, 20000);
        }
        frontier = found;
      }
    }
  } else if (op === 'path') {
    const g = liftGraph(I, rank);
    const groups = ids().slice(0, 12).map((m) => {
      const lifted = liftTo(I, m, rank);
      if (lifted !== m || g.out.has(m) || g.inn.has(m)) return [lifted];
      return g.ids.filter((x) => isUnder(I, x, m));
    }).filter((list) => list.length);
    const bfs = (from, adj) => {
      const dist = new Map(from.map((x) => [x, 0]));
      const queue = [...from];
      for (let i = 0; i < queue.length; i++) for (const y of adj.get(queue[i]) ?? []) if (!dist.has(y)) { dist.set(y, dist.get(queue[i]) + 1); queue.push(y); }
      return dist;
    };
    const onPath = new Set(), pathLinks = [];
    for (let i = 0; i < groups.length; i++) {
      const fwd = bfs(groups[i], g.out);
      for (let j = 0; j < groups.length; j++) {
        if (i === j) continue;
        const d = Math.min(...groups[j].map((x) => fwd.get(x) ?? Infinity));
        if (d === Infinity) continue;
        const back = bfs(groups[j], g.inn);
        for (const [x, dx] of fwd) if (dx + (back.get(x) ?? Infinity) === d) onPath.add(x);
        for (const e of g.links) if (fwd.has(e.a) && back.has(e.b) && fwd.get(e.a) + 1 + back.get(e.b) === d) pathLinks.push(e);
      }
    }
    let added = 0;
    for (const x of onPath) if (added < PATH_CAP && addNode(x, 0)) added++;
    for (const e of pathLinks.slice(0, PATH_CAP)) addLink(e.a, e.b, '*');
  } else if (op === 'loop') {
    const g = liftGraph(I, rank);
    const groups = strongGroups(g.out);
    for (const m of ids()) {
      const p = liftTo(I, m, rank);
      const group = groups.find((list) => list.includes(p) || list.some((x) => isUnder(I, x, m)));
      if (!group) continue;
      const inGroup = new Set(group);
      for (const x of group) addNode(x, 0);
      for (const e of g.links) if (inGroup.has(e.a) && inGroup.has(e.b)) addLink(e.a, e.b, '*');
    }
  } else if (op === 'copies') {
    const queue = ids();
    const seen = new Set(queue);
    for (let i = 0; i < queue.length && seen.size < PATH_CAP; i++) {
      walk(I, queue[i], (x) => {
        for (const li of [...I.out[x], ...I.inn[x]]) {
          const [a, b, k] = links[li];
          if (I.kinds[k] !== 'copy') continue;
          addLink(a, b, 'copy');
          for (const y of [a, b]) if (!seen.has(y) && !isUnder(I, y, queue[i])) { seen.add(y); queue.push(y); addNode(y, 0); }
        }
      }, 20000);
    }
  } else if (op === 'tests') {
    for (const m of ids()) {
      walk(I, m, (x) => {
        for (const li of I.inn[x]) {
          const [src, , k] = links[li];
          if (!STATIC.has(I.kinds[k])) continue;
          const f = I.fileOf[src];
          if (f >= 0 && I.N[f].test && !isUnder(I, f, m)) addNode(f, 0);
        }
      }, 20000);
    }
  } else if (op === 'inside') {
    const keep = [];
    const added = [];
    for (const m of ids()) {
      const kind = I.N[m].kind;
      if (kind !== 'repo' && kind !== 'dir' && kind !== 'file') { keep.push(m); continue; }
      const parts = new Set();
      walk(I, m, (x) => { if (x !== m && !I.kids[x].length) { const p = liftTo(I, x, rank); if (p !== m && isUnder(I, p, m)) parts.add(p); } });
      if (!parts.size) for (const k of I.kids[m]) parts.add(k);
      if (!parts.size) keep.push(m); else added.push(...parts);
    }
    next.nodes = keep.map((id) => I.N[id].key);
    have.clear();
    for (const k of next.nodes) have.add(k);
    for (const id of added) addNode(id, 0);
  } else if (op === 'parent') {
    const ups = new Set(ids().map((id) => (I.N[id].up > 0 ? I.N[id].up : id)));
    next.nodes = [...ups].map((id) => I.N[id].key);
    next.hops = {};
  }
  next.recipe = s.recipe ? [...s.recipe, { grow: op, depth: depth === Infinity ? 'all' : depth, rank }] : null;
  return next;
}

// Hop distance of every part at a rank from the set, through what it uses
// and what uses it. Members (and parts inside them) are distance 0.
export function reach(I, s, rank, maxHops = 8) {
  const seeds = seedIds(I, s);
  const self = new Set();
  for (const m of seeds) { self.add(liftTo(I, m, rank)); walk(I, m, (x) => { self.add(x); }, 20000); }
  const dist = { out: new Map(), in: new Map() };
  const links = I.model.links;
  for (const dir of ['out', 'in']) {
    let frontier = seeds;
    const seen = dist[dir];
    for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
      const found = [];
      for (const f of frontier) {
        walk(I, f, (x) => {
          for (const li of dir === 'out' ? I.out[x] : I.inn[x]) {
            const [src, t, k] = links[li];
            if (!STATIC.has(I.kinds[k])) continue;
            const end = dir === 'out' ? t : src;
            if (isUnder(I, end, f)) continue;
            const p = liftAway(I, end, rank, f);
            if (p <= 0 || self.has(p) || seen.has(p)) continue;
            seen.set(p, hop);
            found.push(p);
          }
        }, 20000);
      }
      frontier = found;
    }
  }
  return { self, out: dist.out, in: dist.in, empty: !seeds.length };
}

// ───────────────────────────── Find queries ─────────────────────────────

const MEASURE_NAMES = ['lines', 'cx', 'nest', 'args', 'churn', 'fanin', 'age'];
const FILTER_NAMES = ['kind', 'in', 'lang', 'rule', 'uses', 'usedby', 'reviewed', 'test', 'gen'];
const KIND_WORDS = { file: 'file', files: 'file', type: 'type', types: 'type', class: 'type', func: 'func', function: 'func', functions: 'func', method: 'func', dir: 'dir', folder: 'dir', folders: 'dir', repo: 'repo', space: 'space', namespace: 'space', part: 'part', section: 'part' };
export const QUERY_HELP = 'Filters: kind:file|type|func|dir · in:path · lang:ts · rule:copy or rule:high · uses:Name · usedby:Name · lines>N cx>N nest>N args>N churn>N fanin>N age<Ndays · staged dirty reviewed:yes|no|stale test:yes|no gen:no';

export function parseQuery(text) {
  const q = { text: text.trim(), words: [], filters: [], errors: [], actions: false };
  if (q.text.startsWith('>')) { q.actions = true; q.words = q.text.slice(1).trim() ? [q.text.slice(1).trim()] : []; return q; }
  for (const tok of q.text.split(/\s+/).filter(Boolean)) {
    let m;
    if ((m = /^([a-z]+)(<=|>=|<|>|=)(\d+(?:\.\d+)?)(?:d|days?)?$/i.exec(tok))) {
      const name = m[1].toLowerCase();
      if (MEASURE_NAMES.includes(name)) q.filters.push({ type: 'measure', name, op: m[2], value: +m[3] });
      else q.errors.push(`Unknown measure "${m[1]}".`);
    } else if ((m = /^([a-z]+):(.*)$/i.exec(tok))) {
      const name = m[1].toLowerCase(), value = m[2];
      if (!FILTER_NAMES.includes(name)) { q.errors.push(`Unknown filter "${name}:".`); continue; }
      if (!value) { q.errors.push(`"${name}:" needs a value.`); continue; }
      if (name === 'kind') {
        const kinds = value.toLowerCase().split(/[|,]/).map((v) => KIND_WORDS[v]);
        if (kinds.some((k) => !k)) { q.errors.push(`kind: takes file, type, func, or dir.`); continue; }
        q.filters.push({ type: 'kind', kinds });
      } else if (name === 'reviewed' && !/^(yes|no|stale)$/i.test(value)) q.errors.push('reviewed: takes yes, no, or stale.');
      else if ((name === 'test' || name === 'gen') && !/^(yes|no)$/i.test(value)) q.errors.push(`${name}: takes yes or no.`);
      else q.filters.push({ type: name, value });
    } else if (/^(staged|dirty)$/i.test(tok)) q.filters.push({ type: tok.toLowerCase() });
    else if (/[<>=:]/.test(tok)) q.errors.push(`Cannot read "${tok}".`);
    else q.words.push(tok);
  }
  return q;
}

// Fuzzy name score: prefix beats word start beats substring beats letters in order.
export function nameScore(name, q) {
  const n = name.toLowerCase();
  const i = n.indexOf(q);
  if (i === 0) return 100 - n.length * 0.1;
  if (i > 0) return 70 - i * 0.5 - n.length * 0.1 + (/[^a-z0-9]/.test(n[i - 1]) || /[A-Z]/.test(name[i]) ? 15 : 0);
  let j = 0, gaps = 0, last = -1;
  for (let k = 0; k < n.length && j < q.length; k++) if (n[k] === q[j]) { if (last >= 0) gaps += k - last - 1; last = k; j++; }
  return j === q.length ? 30 - gaps - n.length * 0.05 : -1;
}

export function findByName(I, q, limit = 400) {
  if (!q) return [];
  q = q.toLowerCase();
  const out = [];
  for (const n of I.N) {
    if (n.id === 0) continue;
    const s = nameScore(n.name, q);
    if (s >= 0) out.push([s + (n.kind === 'file' ? 4 : n.kind === 'type' ? 3 : 0), n.id]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}

// Nodes whose name, or dotted symbol path, matches.
function named(I, value) {
  const v = value.toLowerCase();
  const out = [];
  for (const n of I.N) {
    if (n.id === 0 || n.kind === 'root') continue;
    const chain = (n.key.split('#')[1] ?? '').toLowerCase();
    if (n.name.toLowerCase() === v || chain === v || chain.endsWith('.' + v) || n.key.toLowerCase() === v) out.push(n.id);
  }
  return out;
}

// Mark every node at or above `ids`.
function withAncestors(I, ids) {
  const out = new Set();
  for (const id of ids) for (let p = id; p > 0 && !out.has(p); p = I.N[p].up) out.add(p);
  return out;
}

const compare = (a, op, b) => (op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : op === '<=' ? a <= b : a === b);

// Run a parsed query. ctx: { I, rank, stageIndex? }. Returns matching ids,
// at the rank unless a kind: filter names the kinds.
export function matchQuery(ctx, q) {
  const { I, rank = 3 } = ctx;
  const N = I.N;
  const F = facts(I);
  const kindF = q.filters.find((f) => f.type === 'kind');
  let ids = kindF ? N.filter((n) => kindF.kinds.includes(n.kind)).map((n) => n.id) : partsAt(I, rank);
  const tests = [];
  for (const f of q.filters) {
    if (f.type === 'kind') continue;
    if (f.type === 'in') {
      const v = f.value.replace(/\/+$/, '').toLowerCase();
      const roots = new Set(N.filter((n) => (n.kind === 'dir' || n.kind === 'repo' || n.kind === 'file') && (n.path?.toLowerCase() === v || n.path?.toLowerCase().startsWith(v + '/') || n.key.toLowerCase() === v || n.key.toLowerCase().startsWith(v + '/') || (n.kind === 'dir' && n.name.toLowerCase() === v))).map((n) => n.id));
      tests.push((id) => { for (let p = id; p > 0; p = N[p].up) if (roots.has(p)) return true; return false; });
    } else if (f.type === 'lang') {
      const v = f.value.toLowerCase();
      const langs = new Set(I.model.langs.filter((l) => l.id === v || l.name.toLowerCase() === v).map((l) => l.id));
      langs.add(v);
      tests.push((id) => langs.has(N[id].lang ?? N[I.fileOf[id]]?.lang));
    } else if (f.type === 'rule') {
      const v = f.value.toLowerCase();
      const hits = I.model.issues.filter((i) => !i.waived && (i.rule === v || i.level === v)).map((i) => i.node);
      const marked = withAncestors(I, hits);
      tests.push((id) => marked.has(id));
    } else if (f.type === 'uses' || f.type === 'usedby') {
      const targets = named(I, f.value);
      const ends = [];
      for (const t of targets) {
        walk(I, t, (x) => {
          for (const li of f.type === 'uses' ? I.inn[x] : I.out[x]) {
            const [a, b, k] = I.model.links[li];
            if (!STATIC.has(I.kinds[k])) continue;
            const end = f.type === 'uses' ? a : b;
            if (!isUnder(I, end, t)) ends.push(end);
          }
        }, 20000);
      }
      const marked = withAncestors(I, ends);
      tests.push((id) => marked.has(id) && !targets.some((t) => isUnder(I, t, id)));
    } else if (f.type === 'measure') {
      const fi = f.name === 'fanin' ? fanin(I, rank) : null;
      const val = (id) => {
        const n = N[id];
        if (f.name === 'lines') return n.lines ?? 0;
        if (f.name === 'cx') return F.cxMax[id];
        if (f.name === 'nest') return F.nestMax[id];
        if (f.name === 'args') return F.argsMax[id];
        if (f.name === 'churn') return F.churn[id];
        if (f.name === 'fanin') return fi.count[id];
        return F.time[id] ? (F.now - F.time[id]) / 86400 : Infinity;
      };
      tests.push((id) => compare(val(id), f.op, f.value));
    } else if (f.type === 'staged') {
      const keys = ctx.stageIndex ?? new Map();
      const hits = [...keys.keys()].map((k) => idOf(I, k)).filter((id) => id >= 0);
      const marked = withAncestors(I, hits);
      tests.push((id) => marked.has(id) || (I.fileOf[id] >= 0 && keys.has(N[I.fileOf[id]].key)));
    } else if (f.type === 'dirty') {
      const marked = withAncestors(I, N.filter((n) => n.dirty).map((n) => n.id));
      tests.push((id) => marked.has(id) || !!N[I.fileOf[id]]?.dirty);
    } else if (f.type === 'reviewed') {
      const want = f.value.toLowerCase();
      const marks = I.model.marks ?? {};
      tests.push((id) => {
        let m = null;
        for (let p = id; p > 0 && !m; p = N[p].up) m = marks[N[p].key] ?? null;
        return want === 'yes' ? m === 'ok' : want === 'stale' ? m === 'stale' : !m;
      });
    } else if (f.type === 'test' || f.type === 'gen') {
      const want = f.value.toLowerCase() === 'yes';
      tests.push((id) => !!N[I.fileOf[id]]?.[f.type] === want);
    }
  }
  const words = q.words.map((w) => w.toLowerCase());
  let scored = ids.filter((id) => id > 0 && tests.every((t) => t(id))).map((id) => {
    let s = 0;
    for (const w of words) { const x = nameScore(N[id].name, w); if (x < 0) return null; s += x; }
    return [s, id];
  }).filter(Boolean);
  scored = words.length ? scored.sort((a, b) => b[0] - a[0]) : scored.sort((a, b) => (N[b[1]].lines ?? 0) - (N[a[1]].lines ?? 0));
  return scored.map((x) => x[1]);
}

// ───────────────────────────── Color classes ─────────────────────────────

// A number (for measures) or a category key (for everything else). Painting
// maps it to a color; legend selection matches on it. Category keys nest with
// '/', so the key "lang:ts" also matches "lang:ts/func".
export function classify(ctx, paint, id) {
  const { I } = ctx;
  const n = I.N[id];
  const kind = n.kind;
  if (kind === 'repo' || kind === 'dir' || kind === 'root') return 'dir';
  const F = facts(I);
  if (paint === 'lang') {
    const lang = n.lang ?? I.N[I.fileOf[id]]?.lang ?? 'text';
    if (kind === 'file') return `lang:${lang}${n.gen ? '/gen' : ''}`;
    return `lang:${lang}/${kind}`;
  }
  if (paint === 'issues') return `sev:${F.sev[id]}`;
  if (paint === 'review') {
    const marks = I.model.marks ?? {};
    for (let p = id; p > 0; p = I.N[p].up) { const m = marks[I.N[p].key]; if (m) return m === 'ok' ? 'rev:ok' : 'rev:stale'; }
    if (kind === 'file') {
      let some = false;
      walk(I, id, (k) => { if (marks[I.N[k].key] === 'ok') some = true; }, 5000);
      if (some) return 'rev:some';
    }
    return 'rev:none';
  }
  if (paint === 'stage') {
    const f = I.fileOf[id];
    const st = f >= 0 ? ctx.stageIndex?.get(I.N[f].key) : null;
    if (st) return `stage:${st}`;
    return f >= 0 && I.N[f].dirty ? 'stage:dirty' : 'stage:none';
  }
  if (paint === 'reach') {
    const r = ctx.reach;
    if (!r || r.empty) return 'reach:empty';
    const p = liftTo(I, id, ctx.rank ?? 3);
    if (r.self.has(id) || r.self.has(p)) return 'reach:self';
    const o = r.out.get(p) ?? r.out.get(id), i = r.in.get(p) ?? r.in.get(id);
    if (o && i) return 'reach:both';
    if (o) return `reach:out${Math.min(o, 3)}`;
    if (i) return `reach:in${Math.min(i, 3)}`;
    return 'reach:none';
  }
  if ((kind === 'type' || kind === 'space' || kind === 'part') && paint === 'cx') return 'none';
  return measure(ctx, paint, id);
}

// Measures as 0..~1 against the repo's own scales.
export function measure(ctx, paint, id) {
  const { I } = ctx;
  const F = facts(I);
  const n = I.N[id];
  const s = F.scales;
  if (paint === 'lines') return n.kind === 'func' || n.kind === 'type' ? Math.log1p(n.lines) / Math.log1p(Math.max(60, s.lines / 4)) : Math.log1p(n.lines) / Math.log1p(s.lines);
  if (paint === 'cx') return (n.kind === 'func' ? n.cx ?? 0 : F.cxMax[id]) / s.cx;
  if (paint === 'churn') return I.fileOf[id] >= 0 ? F.churn[id] / s.churn : 0;
  if (paint === 'age') { const t = I.fileOf[id] >= 0 ? F.time[id] : 0; return t ? 1 - ((F.now - t) / 86400) / s.age : 0; }
  if (paint === 'fanin') { const fi = fanin(I, ctx.rank ?? 3); return fi.count[id] / fi.scale; }
  if (paint === 'issues') return F.sev[id] / 3;
  if (paint === 'level') {
    const rank = n.kind === 'func' ? 5 : 3;
    const L = levelsAt(I, rank);
    const lv = L.levelOf(liftTo(I, id, rank));
    return lv < 0 ? 0 : (lv + 1) / (L.maxL + 1);
  }
  return 0;
}

// Does a class match a legend pick? A key (or any of keys) matches itself and
// nested keys; ranges match numbers inside [lo, hi].
export function classMatches(cls, pick) {
  const under = (k) => cls === k || cls.startsWith(k + '/');
  if (pick.keys) return typeof cls === 'string' && pick.keys.some(under);
  if (pick.key != null) return typeof cls === 'string' && under(pick.key);
  return typeof cls === 'number' && cls >= pick.lo && cls <= pick.hi;
}

// ───────────────────────────── Recipes ─────────────────────────────

// Rebuild a set from its recipe on a fresh model. The first step is the
// source (seed keys, query, rule, staged files, legend pick, or level); the
// rest are grow steps. ctx: { I, rank, stageIndex?, classify? }.
export function replay(ctx, recipe, base = emptySet()) {
  const { I } = ctx;
  if (!recipe?.length) return cleanSet(I, base);
  const [first, ...steps] = recipe;
  const rank = first.rank ?? ctx.rank ?? 3;
  let ids = [];
  if (first.seed) ids = first.seed.map((k) => idOf(I, k)).filter((id) => id >= 0);
  else if (first.query != null) ids = matchQuery({ ...ctx, rank }, parseQuery(first.query));
  else if (first.rule) ids = [...new Set(I.model.issues.filter((i) => !i.waived && (i.rule === first.rule || i.level === first.rule)).map((i) => i.node))];
  else if (first.staged) ids = [...(ctx.stageIndex?.keys() ?? [])].map((k) => idOf(I, k)).filter((id) => id >= 0);
  else if (first.legend) {
    const cctx = { ...ctx, rank };
    ids = partsAt(I, rank).filter((id) => classMatches(classify(cctx, first.legend.paint, id), first.legend));
  } else if (first.level != null) {
    const L = levelsAt(I, rank);
    ids = liftGraph(I, rank).ids.filter((id) => L.levelOf(id) === first.level);
  }
  let s = { ...emptySet(), nodes: ids.slice(0, SET_CAP).map((id) => I.N[id].key), recipe: [first], id: base.id, name: base.name };
  for (const step of steps) s = grow(I, s, step.grow, { rank: step.rank ?? rank, depth: step.depth === 'all' ? Infinity : step.depth ?? 1 });
  return s;
}

// A plain description of a recipe, for "Live: …".
export function recipeName(recipe, rules = []) {
  if (!recipe?.length) return '';
  const [first, ...steps] = recipe;
  let base = 'selection';
  if (first.query != null) base = `find "${first.query}"`;
  else if (first.rule) base = `rule ${rules.find((r) => r.id === first.rule)?.name ?? first.rule}`;
  else if (first.staged) base = 'staged changes';
  else if (first.legend) base = `color ${first.legend.label ?? first.legend.key ?? `${Math.round(first.legend.lo * 100)}–${Math.round(first.legend.hi * 100)}%`}`;
  else if (first.level != null) base = `level ${first.level}`;
  const words = { out: 'uses', in: 'used by', both: 'both ways', path: 'path', loop: 'loop', copies: 'copies', tests: 'tests', inside: 'inside', parent: 'parent' };
  // Repeated hops read as one: "+ uses + uses" is "+ uses ×2".
  const runs = [];
  for (const s of steps) {
    const last = runs.at(-1);
    const hops = ['out', 'in', 'both'].includes(s.grow) && s.depth !== 'all' ? s.depth ?? 1 : null;
    if (last && hops && last.grow === s.grow && last.hops) last.hops += hops;
    else runs.push({ grow: s.grow, hops, all: s.depth === 'all' });
  }
  return [base, ...runs.map((s) => `+ ${words[s.grow] ?? s.grow}${s.all ? ' (all)' : s.hops > 1 ? ` ×${s.hops}` : ''}`)].join(' ');
}
