import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLinks, bestPath, alternatePath, edgeKey, LIGHT_MIN_PER_AU, DEFAULTS } from "../web/js/router.js";

// Deterministic RNG (mulberry32) so every run tests the same graphs.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(rand, n) {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  const links = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (rand() < 0.45) continue;
    links.push({ a: ids[i], b: ids[j], distAU: 0, latencyMin: 1 + rand() * 20,
                 snrDb: rand() * 30, blocked: rand() < 0.15 });
  }
  return { ids, links };
}

const cost = (l, mode) => mode === "reliable"
  ? l.latencyMin + DEFAULTS.lambda * Math.max(0, DEFAULTS.comfortDb - l.snrDb) : l.latencyMin;

// Oracle: enumerate every simple path, return the minimum cost (Infinity if none).
function bruteForce(links, src, dst, mode) {
  const adj = new Map();
  for (const l of links) if (!l.blocked) {
    for (const [u, v] of [[l.a, l.b], [l.b, l.a]]) {
      if (!adj.has(u)) adj.set(u, []); adj.get(u).push([v, cost(l, mode)]);
    }
  }
  let best = Infinity;
  const seen = new Set([src]);
  (function dfs(u, c) {
    if (u === dst) { best = Math.min(best, c); return; }
    for (const [v, w] of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); dfs(v, c + w); seen.delete(v); }
  })(src, 0);
  return best;
}

test("bestPath equals brute force on 1000 random networks (both modes)", () => {
  const rand = rng(42);
  let mismatches = 0, checked = 0;
  for (let g = 0; g < 1000; g++) {
    const { ids, links } = randomGraph(rand, 4 + Math.floor(rand() * 6));
    for (const mode of ["fastest", "reliable"]) {
      const src = ids[0], dst = ids[ids.length - 1];
      const r = bestPath(links, src, dst, mode);
      const oracle = bruteForce(links, src, dst, mode);
      checked++;
      if (oracle === Infinity ? r !== null : !r || Math.abs(r.cost - oracle) > 1e-9) mismatches++;
    }
  }
  console.log(`router vs brute force: ${checked} cases, ${mismatches} mismatches`);
  assert.equal(mismatches, 0);
});

test("routes never use blocked links; alternate differs; independent shares no relay", () => {
  const rand = rng(7);
  let alts = 0, independents = 0;
  for (let g = 0; g < 500; g++) {
    const { ids, links } = randomGraph(rand, 6 + Math.floor(rand() * 4));
    const src = ids[0], dst = ids[ids.length - 1];
    const best = bestPath(links, src, dst);
    if (!best) continue;
    assert.ok(best.links.every((l) => !l.blocked));
    const alt = alternatePath(links, src, dst, best);
    if (!alt) continue;
    alts++;
    assert.ok(alt.links.every((l) => !l.blocked));
    assert.notDeepEqual(alt.nodes, best.nodes);
    assert.ok(alt.cost >= best.cost - 1e-9, "alternate cannot beat the optimum");
    if (alt.independent) {
      independents++;
      const inner = new Set(best.nodes.slice(1, -1));
      assert.ok(alt.nodes.slice(1, -1).every((n) => !inner.has(n)));
      const bestEdges = new Set(best.links.map((l) => edgeKey(l.a, l.b)));
      assert.ok(alt.links.every((l) => !bestEdges.has(edgeKey(l.a, l.b))));
    }
  }
  console.log(`alternates found: ${alts} (${independents} fully independent)`);
  assert.ok(alts > 0);
});

test("returns null when the destination is cut off", () => {
  const links = [{ a: "A", b: "B", latencyMin: 1, snrDb: 20, blocked: false },
                 { a: "B", b: "C", latencyMin: 1, snrDb: 20, blocked: true }];
  assert.equal(bestPath(links, "A", "C"), null);
});

test("buildLinks: latency in light-minutes, jamming and range block links", () => {
  const snap = { nodes: [{ id: "E", x: 1, y: 0 }, { id: "R", x: 2, y: 0 }, { id: "F", x: 5, y: 0 }] };
  const jam = (s, a, b) => (a.id === "E" && b.id === "R" ? 40 : 0);
  const links = buildLinks(snap, jam);
  const er = links.find((l) => l.a === "E" && l.b === "R");
  const rf = links.find((l) => l.a === "R" && l.b === "F");
  assert.ok(Math.abs(er.latencyMin - LIGHT_MIN_PER_AU) < 1e-9);
  assert.equal(er.blocked, true, "40 dB of jamming blocks a 1 AU link");
  assert.equal(rf.blocked, true, "3 AU exceeds max range 2.6 AU");
  assert.equal(buildLinks(snap, null).find((l) => l.a === "E" && l.b === "R").blocked, false);
});

test("timing: 30-node network, links + best + alternate", () => {
  const rand = rng(3);
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, x: rand() * 6 - 3, y: rand() * 6 - 3 }));
  const t = performance.now();
  const runs = 200;
  for (let k = 0; k < runs; k++) {
    const links = buildLinks({ nodes }, null);
    const best = bestPath(links, "n0", "n29");
    alternatePath(links, "n0", "n29", best);
  }
  const ms = (performance.now() - t) / runs;
  console.log(`reroute (30 nodes, links+best+alternate): ${ms.toFixed(3)} ms per step`);
  assert.ok(ms < 16, "must fit in one 60 fps frame");
});
