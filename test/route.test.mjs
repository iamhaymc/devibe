// Unit tests for core_route.mjs: Graph arcs, Layers curves, and Map routes end
// on their shapes' edges, never loop, and draw A→B and B→A as one curve.
// Run: node --test test/route.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { arcRoute, layerRoute, exitOf, boxRoute, gutterRoute, bundleRoute, codeRoute } from '../app/core_route.mjs';

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const reversed = (pts) => [...pts].reverse();
const samePts = (p, q) => p.length === q.length && p.every((pt, i) => near(pt[0], q[i][0]) && near(pt[1], q[i][1]));
// Progress along an axis never goes back (no loops or hooks).
const monotone = (pts, f) => pts.every((p, i) => !i || f(p) >= f(pts[i - 1]) - 1e-9);

describe('arcRoute', () => {
  const a = [0, 0], b = [100, 20];

  test('ends on both circle edges, outside the gap', () => {
    const pts = arcRoute(a, 10, b, 25, { gap: 1 });
    assert.ok(near(dist(pts[0], a), 11, 1e-2), `start ${dist(pts[0], a)}`);
    assert.ok(near(dist(pts.at(-1), b), 26, 1e-2), `end ${dist(pts.at(-1), b)}`);
  });

  test('the last segment points into the target', () => {
    const pts = arcRoute(a, 10, b, 25);
    const [p, q] = pts.slice(-2);
    const d = [q[0] - p[0], q[1] - p[1]], to = [b[0] - q[0], b[1] - q[1]];
    assert.ok(d[0] * to[0] + d[1] * to[1] > 0.9 * Math.hypot(...d) * Math.hypot(...to));
  });

  test('A→B and B→A are one curve, not a loop', () => {
    assert.ok(samePts(arcRoute(b, 25, a, 10), reversed(arcRoute(a, 10, b, 25))));
  });

  test('bows gently to one side and moves steadily toward the target', () => {
    const pts = arcRoute(a, 2, b, 2);
    const ux = (b[0] - a[0]) / dist(a, b), uy = (b[1] - a[1]) / dist(a, b);
    const side = (p) => (p[0] - a[0]) * -uy + (p[1] - a[1]) * ux;
    const bow = side(pts[pts.length >> 1]);
    assert.ok(Math.abs(bow) > 3 && Math.abs(bow) < 20, `bow ${bow}`);
    assert.ok(pts.every((p) => Math.sign(side(p)) !== -Math.sign(bow)));
    assert.ok(monotone(pts, (p) => p[0] * ux + p[1] * uy));
  });

  test('overlapping circles still get a curve; one point gets none', () => {
    assert.ok(arcRoute([0, 0], 30, [10, 0], 30).length >= 2);
    assert.equal(arcRoute([5, 5], 3, [5, 5], 3), null);
  });
});

describe('layerRoute', () => {
  const box = (x, y, w = 40, h = 9) => ({ x, y, w, h });

  test('a downward link leaves the bottom edge and lands on the top edge', () => {
    const ra = box(0, 0), rb = box(200, 68);
    const pts = layerRoute(ra, rb);
    assert.ok(near(pts[0][1], ra.y + ra.h) && near(pts.at(-1)[1], rb.y));
    assert.ok(pts[0][0] >= ra.x && pts[0][0] <= ra.x + ra.w);
    assert.ok(pts.at(-1)[0] >= rb.x && pts.at(-1)[0] <= rb.x + rb.w);
    assert.ok(monotone(pts, (p) => p[1]) && monotone(pts, (p) => p[0]));
    const [p, q] = pts.slice(-2);
    assert.ok(q[1] > p[1] && Math.abs(q[0] - p[0]) < q[1] - p[1], 'arrives heading down');
  });

  test('an upward link leaves the top edge and lands on the bottom edge', () => {
    const ra = box(0, 68), rb = box(-150, 0);
    const pts = layerRoute(ra, rb);
    assert.ok(near(pts[0][1], ra.y) && near(pts.at(-1)[1], rb.y + rb.h));
    assert.ok(monotone(pts, (p) => -p[1]));
  });

  test('links from one box fan out toward their targets', () => {
    const ra = box(0, 0, 80);
    const xs = [box(-300, 68), box(20, 68), box(300, 68)].map((rb) => layerRoute(ra, rb)[0][0]);
    assert.ok(xs[0] < xs[1] && xs[1] < xs[2], xs.join(' < '));
    assert.ok(xs.every((x) => x > ra.x && x < ra.x + ra.w));
  });

  test('a link within a row arches over the tops, and back is the same arch', () => {
    const ra = box(0, 0), rb = box(120, 0);
    const pts = layerRoute(ra, rb);
    assert.ok(near(pts[0][1], 0) && near(pts.at(-1)[1], 0));
    assert.ok(pts.every((p) => p[1] <= 1e-9));
    assert.ok(Math.min(...pts.map((p) => p[1])) < -6);
    assert.ok(monotone(pts, (p) => p[0]));
    assert.ok(samePts(layerRoute(rb, ra), reversed(pts)));
  });

  test('a link between rows, both ways, is one curve', () => {
    const ra = box(0, 0), rb = box(90, 34);
    assert.ok(samePts(layerRoute(rb, ra), reversed(layerRoute(ra, rb))));
  });
});

describe('Map routes', () => {
  const box = (x, y, w, h, sides) => ({ x, y, w, h, sides });
  const onBorder = (p, r) => {
    const inX = p[0] >= r.x - 1e-6 && p[0] <= r.x + r.w + 1e-6, inY = p[1] >= r.y - 1e-6 && p[1] <= r.y + r.h + 1e-6;
    return inX && inY && (near(p[0], r.x) || near(p[0], r.x + r.w) || near(p[1], r.y) || near(p[1], r.y + r.h));
  };

  test('exitOf leaves by the side facing the target, at right angles', () => {
    const r = box(0, 0, 100, 40);
    assert.deepEqual(exitOf(r, [300, 25]).side, 'r');
    assert.deepEqual(exitOf(r, [-300, 25]).side, 'l');
    assert.deepEqual(exitOf(r, [50, 400]).side, 'b');
    const top = exitOf(r, [60, -400]);
    assert.equal(top.side, 't');
    assert.deepEqual(top.n, [0, -1]);
    assert.ok(near(top.p[1], 0) && top.p[0] > 50 && top.p[0] < 85, `${top.p}`);
  });

  test('exitOf keeps code ends beside the text, at mid height', () => {
    const line = box(0, 10, 80, 2, 'h');
    for (const q of [[50, -500], [50, 500], [300, 11]]) {
      const e = exitOf(line, q);
      assert.ok(e.side === 'r' && near(e.p[0], 80) && near(e.p[1], 11), JSON.stringify(e));
    }
    assert.equal(exitOf(line, [-5, -500]).side, 'l');
  });

  test('boxRoute runs from border to border and is the same curve both ways', () => {
    const A = box(0, 0, 60, 40), B = box(200, 120, 50, 30);
    const pts = boxRoute(A, B);
    assert.ok(onBorder(pts[0], A) && onBorder(pts.at(-1), B));
    assert.ok(samePts(boxRoute(B, A), reversed(pts)));
    assert.ok(pts.slice(1, -1).every((p) => !(p[0] > A.x && p[0] < A.x + A.w && p[1] > A.y && p[1] < A.y + A.h)), 'never back inside A');
  });

  test('boxRoute arrives at right angles to the target side', () => {
    const pts = boxRoute(box(0, 0, 40, 40), box(300, 10, 40, 20));
    const [p, q] = pts.slice(-2);
    assert.ok(q[0] > p[0] && Math.abs(q[1] - p[1]) < 0.2 * (q[0] - p[0]), 'arrives heading right');
  });

  test('neighbors get a link long enough to show its direction', () => {
    const A = box(0, 0, 40, 40), B = box(41, 0, 40, 40);
    const pts = boxRoute(A, B);
    assert.ok(dist(pts[0], pts.at(-1)) >= 20 - 1e-6, `${dist(pts[0], pts.at(-1))}`);
    assert.ok(pts[0][0] < 40 && pts.at(-1)[0] > 41);
    assert.ok(monotone(pts, (p) => p[0]));
  });

  test('gutterRoute bends left of the column and comes back', () => {
    const pts = gutterRoute(100, 10, 50, { min: 1, max: 3 });
    assert.deepEqual(pts[0], [100, 10]);
    assert.deepEqual(pts.at(-1), [100, 50]);
    assert.ok(pts.every((p) => p[0] <= 100));
    assert.ok(Math.min(...pts.map((p) => p[0])) < 99 && Math.min(...pts.map((p) => p[0])) > 96);
    assert.ok(monotone(pts, (p) => p[1]));
  });

  test('bundleRoute crosses folder borders, ends on the boxes, and is one curve both ways', () => {
    const left = box(0, 0, 200, 200), right = box(400, 0, 200, 200);
    const A = box(20, 80, 40, 40), B = box(500, 60, 40, 40);
    const pts = bundleRoute(A, B, [left], [right]);
    assert.ok(onBorder(pts[0], A) && onBorder(pts.at(-1), B));
    assert.ok(samePts(bundleRoute(B, A, [right], [left]), reversed(pts)));
    assert.ok(monotone(pts, (p) => p[0]));
    const mids = pts.filter((p) => p[0] > 200 && p[0] < 400);
    assert.ok(mids.length && mids.every((p) => p[1] > 40 && p[1] < 160), 'stays between the folders');
  });

  test('codeRoute runs level from a code line to its file edge, then curves to the target', () => {
    const F = box(0, 0, 200, 100), line = box(10, 40, 80, 4, 'h'), B = box(400, 0, 60, 40);
    const pts = codeRoute(line, B, F, null);
    assert.deepEqual(pts[0], [90, 42]);
    assert.deepEqual(pts[1], [200, 42]);
    assert.ok(onBorder(pts.at(-1), B));
    assert.ok(pts.slice(1).every((p) => p[0] >= 200 - 1e-9), 'leaves the file before it bends');
    assert.ok(samePts(codeRoute(B, line, null, F), reversed(pts)));
  });

  test('bundleRoute with no folders between is a box route', () => {
    const A = box(0, 0, 40, 40), B = box(100, 0, 40, 40);
    assert.ok(samePts(bundleRoute(A, B, [], []), boxRoute(A, B)));
  });
});
