// devibe force layout for the Graph view: linked parts pull together, every
// part stays near its place on the Map, and none overlap. The client runs it
// in place for small graphs and in a worker (this file, loaded with ?worker)
// for large ones, so input never waits on it.

// nodes: [{ id, r, hx, hy, x, y }], links: [{ source: id, target: id }].
// Moves the nodes in place within `budget` milliseconds.
export function simulate(d3, nodes, links, G, budget = 1100) {
  const deg = new Map();
  for (const e of links) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); }
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d) => d.id).distance((l) => l.source.r + l.target.r + 14).strength((l) => 0.6 / Math.min(deg.get(l.source.id), deg.get(l.target.id))))
    .force('charge', d3.forceManyBody().strength((d) => -12 - d.r * 2.4).distanceMax(G * 0.4).theta(0.95))
    .force('collide', d3.forceCollide((d) => d.r + 2.2).strength(0.9))
    .force('x', d3.forceX((d) => d.hx).strength(0.045))
    .force('y', d3.forceY((d) => d.hy).strength(0.045))
    .alphaDecay(0.028)
    .stop();
  const t0 = performance.now();
  for (let i = 0; i < 360 && performance.now() - t0 < budget; i++) sim.tick();
  return nodes;
}

if (typeof window === 'undefined' && new URL(import.meta.url).searchParams.has('worker')) {
  const ready = import('/lib/d3.js');
  self.onmessage = async (e) => {
    await ready;
    const { id, nodes, links, G, budget } = e.data;
    simulate(globalThis.d3, nodes, links, G, budget);
    const xy = new Float64Array(nodes.length * 2);
    nodes.forEach((n, i) => { xy[i * 2] = n.x; xy[i * 2 + 1] = n.y; });
    self.postMessage({ id, xy }, [xy.buffer]);
  };
}
