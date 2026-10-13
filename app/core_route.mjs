// devibe link routes for the flat layouts, with no DOM, d3, or three.js.
// Graph links are gentle arcs cut at the edges of their circles; Layers and
// Map links run from box edge to box edge, leaving and arriving at right
// angles; links between two lines of one code column bend through the gutter.
// All draw A→B and B→A as one curve (so a two-way pair never makes a loop) and
// end where the target's edge is, so the arrowhead touches the part it points
// to. Points are [x, y] in layout units.

// A point on a quadratic or cubic Bézier curve.
function bezier(P, t) {
  const u = 1 - t;
  if (P.length === 3) {
    const a = u * u, b = 2 * u * t, c = t * t;
    return [a * P[0][0] + b * P[1][0] + c * P[2][0], a * P[0][1] + b * P[1][1] + c * P[2][1]];
  }
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * P[0][0] + b * P[1][0] + c * P[2][0] + d * P[3][0], a * P[0][1] + b * P[1][1] + c * P[2][1] + d * P[3][1]];
}

// Where the curve leaves `inside`, walking from t = `from` toward t = `to`:
// coarse steps, then bisection. Returns `to` when it never leaves.
function leave(P, inside, from, to) {
  let last = from;
  for (let i = 1; i <= 32; i++) {
    const t = from + ((to - from) * i) / 32;
    if (!inside(bezier(P, t))) {
      let tin = last, tout = t;
      for (let k = 0; k < 24; k++) { const m = (tin + tout) / 2; if (inside(bezier(P, m))) tin = m; else tout = m; }
      return tout;
    }
    last = t;
  }
  return to;
}

// Sample a curve evenly, from t0 to t1.
function sample(P, steps, t0 = 0, t1 = 1) {
  const out = [];
  for (let i = 0; i <= steps; i++) out.push(bezier(P, t0 + ((t1 - t0) * i) / steps));
  return out;
}

// The part of a curve outside both of its end shapes, or null when the shapes
// cover all of it.
export function clipCurve(P, inA, inB, steps = 12) {
  const t0 = inA(P[0]) ? leave(P, inA, 0, 1) : 0;
  const t1 = inB(P.at(-1)) ? leave(P, inB, 1, 0) : 1;
  return t1 > t0 ? sample(P, steps, t0, t1) : null;
}

// Graph: an arc from circle (a, ra) to circle (b, rb), `gap` off each edge.
// The arc always bows to the same side of the pair, whichever way it points.
// Circles that cover the whole arc get it uncut; one point gets null.
export function arcRoute(a, ra, b, rb, { bend = 0.12, gap = 0.8, steps = 12 } = {}) {
  const flip = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  const [p, q] = flip ? [b, a] : [a, b];
  const dx = q[0] - p[0], dy = q[1] - p[1];
  if (!dx && !dy) return null;
  const P = [a, [(p[0] + q[0]) / 2 - dy * bend, (p[1] + q[1]) / 2 + dx * bend], b];
  const inA = (pt) => Math.hypot(pt[0] - a[0], pt[1] - a[1]) < ra + gap;
  const inB = (pt) => Math.hypot(pt[0] - b[0], pt[1] - b[1]) < rb + gap;
  return clipCurve(P, inA, inB, steps) ?? sample(P, steps);
}

// Where a link meets a box's edge: the middle, slid toward the other end so
// the links of one box fan out in the order of where they go.
function port(r, toward, spread) {
  const cx = r.x + r.w / 2;
  const room = Math.max(0, r.w / 2 - Math.min(4, r.w / 4));
  return cx + room * Math.tanh((toward - cx) / spread);
}

// Layers: from box ra to box rb ({ x, y, w, h }, y down). Rows apart: an
// S-curve from the facing edges, leaving and arriving vertically. Same row: an
// arch over the tops of both boxes.
export function layerRoute(ra, rb, { spread = 160, steps = 14 } = {}) {
  const ax = port(ra, rb.x + rb.w / 2, spread), bx = port(rb, ra.x + ra.w / 2, spread);
  if (Math.abs(ra.y - rb.y) < 1) {
    const y = Math.min(ra.y, rb.y);
    const lift = Math.min(12 + Math.abs(bx - ax) * 0.1, 30);
    return sample([[ax, y], [ax, y - lift], [bx, y - lift], [bx, y]], steps);
  }
  const down = ra.y < rb.y;
  const y0 = down ? ra.y + ra.h : ra.y, y1 = down ? rb.y : rb.y + rb.h;
  const my = (y0 + y1) / 2;
  return sample([[ax, y0], [ax, my], [bx, my], [bx, y1]], steps);
}

// ───────────── Map and code ─────────────

const NORMAL = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };

// Where a link leaves box r ({ x, y, w, h, sides }) heading for point q: the
// side the line from r's middle to q crosses, at right angles to that side.
// `sides: 'h'` keeps to the left or right side at mid height (code lines and
// symbols, so links leave beside the text, not across it). The port keeps
// clear of the corners. Returns { p, n, side }.
export function exitOf(r, q) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const dx = q[0] - cx, dy = q[1] - cy;
  if (r.sides === 'h') {
    const side = dx >= 0 ? 'r' : 'l';
    return { p: [side === 'r' ? r.x + r.w : r.x, cy], n: NORMAL[side], side };
  }
  const tx = dx ? r.w / 2 / Math.abs(dx) : Infinity, ty = dy ? r.h / 2 / Math.abs(dy) : Infinity;
  if (tx === Infinity && ty === Infinity) return { p: [r.x + r.w, cy], n: NORMAL.r, side: 'r' };
  const inset = (len) => Math.min(len * 0.15, 6);
  if (tx <= ty) {
    const side = dx > 0 ? 'r' : 'l';
    const y = Math.min(Math.max(cy + dy * tx, r.y + inset(r.h)), r.y + r.h - inset(r.h));
    return { p: [side === 'r' ? r.x + r.w : r.x, y], n: NORMAL[side], side };
  }
  const side = dy > 0 ? 'b' : 't';
  const x = Math.min(Math.max(cx + dx * ty, r.x + inset(r.w)), r.x + r.w - inset(r.w));
  return { p: [x, side === 'b' ? r.y + r.h : r.y], n: NORMAL[side], side };
}

const mid = (r) => [r.x + r.w / 2, r.y + r.h / 2];

// Map: a smooth link from box A to box B, from edge to edge, leaving and
// arriving at right angles to the sides it uses (a cubic Bézier whose handles
// grow with the distance). Its last point is on B's border. Neighbors whose
// facing edges nearly touch get a link at least half the smaller box long,
// starting and ending inside them, so it still shows which way it points.
export function boxRoute(A, B, { bend = 0.4, steps = 32 } = {}) {
  const ea = exitOf(A, mid(B)), eb = exitOf(B, mid(A));
  let p = ea.p, q = eb.p;
  const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const least = 0.5 * Math.min(A.w, A.h, B.w, B.h);
  if (d < least) {
    const s = (least - d) / 2;
    p = [p[0] - ea.n[0] * s, p[1] - ea.n[1] * s];
    q = [q[0] - eb.n[0] * s, q[1] - eb.n[1] * s];
  }
  const h = bend * Math.max(d, least);
  return sample([p, [p[0] + ea.n[0] * h, p[1] + ea.n[1] * h], [q[0] + eb.n[0] * h, q[1] + eb.n[1] * h], q], steps);
}

// Code: a link between two lines of one column, as a bracket in the gutter to
// the left of the column (x, its left edge; ya, yb, the lines' middles). It
// reaches out further for lines further apart, between `min` and `max`.
export function gutterRoute(x, ya, yb, { min = 1, max = 3, steps = 24 } = {}) {
  const reach = Math.min(max, min + 0.08 * Math.abs(yb - ya));
  return sample([[x, ya], [x - reach, ya], [x - reach, yb], [x, yb]], steps);
}

// Code to elsewhere: a code end (sides 'h') in file box FA leaves beside its
// line and runs level to FA's edge before it curves away, so links from one
// line share one trunk instead of fanning across the code beside it. FB does
// the same for a code end at B. Pass null for an end that is not code in
// another file than the other end.
export function codeRoute(A, B, FA, FB, { bend = 0.4, steps = 32 } = {}) {
  const ea = exitOf(A, mid(FB ?? B)), eb = exitOf(B, mid(FA ?? A));
  const edge = (F, e) => [e.side === 'r' ? F.x + F.w : e.side === 'l' ? F.x : e.p[0], e.p[1]];
  const p = FA ? edge(FA, ea) : ea.p, q = FB ? edge(FB, eb) : eb.p;
  const h = bend * Math.hypot(q[0] - p[0], q[1] - p[1]);
  const curve = sample([p, [p[0] + ea.n[0] * h, p[1] + ea.n[1] * h], [q[0] + eb.n[0] * h, q[1] + eb.n[1] * h], q], steps);
  return [...(FA ? [ea.p] : []), ...curve, ...(FB ? [eb.p] : [])];
}
