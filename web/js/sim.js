// Space simulation: orbits, relays, debris swarm, jamming. Owner: Bhumika. See docs/PLAN.md "Interfaces".
// 2-D, sun at (0,0), units AU/days. Deterministic via seeded RNG.

// Mulberry32 seeded RNG — same seed → same sequence.
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Kepler's third law: period in days for a circular orbit at a AU.
function keplerPeriodDays(a) {
  return 365.25 * Math.pow(a, 1.5);
}

// Relay definitions: name, semi-major axis (AU), initial angle offset (radians).
// phi0 values are chosen so that at t=0 a viable relay chain connects Observatory→Earth.
// The target star lies in the +x direction; relays fan out from the x-axis.
const RELAY_DEFS = [
  { id: "Venus-Relay",   a: 0.72, phi0: 0.3 },
  { id: "Relay-L4",      a: 1.00, phi0:  Math.PI / 3 },
  { id: "Relay-L5",      a: 1.00, phi0: -Math.PI / 3 },
  { id: "Mars-Relay-1",  a: 1.52, phi0: 0.0 },   // near x-axis → chain node
  { id: "Mars-Relay-2",  a: 1.52, phi0: 2.8 },
  { id: "Belt-Relay-1",  a: 2.00, phi0: 0.0 },   // near x-axis → chain node
  { id: "Belt-Relay-2",  a: 2.40, phi0: 0.1 },
  { id: "Outer-Relay",   a: 3.20, phi0: 0.0 },   // near x-axis → bridges to Observatory
];

// Observatory: slow orbit at ~4.5 AU aimed toward the target star (+x direction).
const OBS_DEF = { id: "Observatory", a: 4.5, phi0: 0.0 };

// Build orbit node from definition.
function makeOrbiter(def, kind) {
  const period = keplerPeriodDays(def.a);
  const omega = (2 * Math.PI) / period; // rad/day
  return { id: def.id, name: def.id, kind, a: def.a, phi: def.phi0, omega };
}

// Debris particle cluster: centre + individual offsets.
function makeDebrisCluster(id, x, y, kind, r, strength, vx, vy, rand, n) {
  const particles = [];
  for (let i = 0; i < n; i++) {
    const angle = rand() * 2 * Math.PI;
    const dist = rand() * r;
    particles.push({ dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist });
  }
  return { id, kind, x, y, r, strength, vx, vy, particles };
}

// Debris scenarios — deterministic given seed.
function buildDebris(scenario, rand) {
  const debris = [];
  if (scenario === "default" || scenario === "storm" || scenario === "comet-rain") {
    // One asteroid swarm between Observatory (~4.5 AU, angle~0) and Earth (1 AU, angle~0) = place near 2 AU.
    debris.push(makeDebrisCluster("swarm-0", 2.1, 0.3, "asteroid", 0.35, 30,
      0.0002, -0.0001, rand, 40));
  }
  if (scenario === "storm") {
    debris.push(makeDebrisCluster("swarm-1", 1.5, -0.4, "asteroid", 0.35, 30,
      -0.0001, 0.0002, rand, 40));
    debris.push(makeDebrisCluster("swarm-2", 2.8, 0.6, "asteroid", 0.35, 30,
      0.0001, 0.0001, rand, 40));
  }
  if (scenario === "comet-rain") {
    // Two fast comets with small radius, high attenuation.
    debris.push(makeDebrisCluster("comet-0", -1.0, 3.0, "comet", 0.15, 40,
      0.004, -0.005, rand, 15));
    debris.push(makeDebrisCluster("comet-1",  1.0, -3.0, "comet", 0.15, 40,
      -0.003, 0.006, rand, 15));
  }
  return debris;
}

export function createWorld(scenario = "default") {
  const rand = mkRng(scenario === "default" ? 1 : scenario === "storm" ? 2 : scenario === "comet-rain" ? 3 : 1);

  // Earth at 1 AU.
  const earth = makeOrbiter({ id: "earth", a: 1.0, phi0: 0.0 }, "earth");
  earth.name = "Earth";

  const relays = RELAY_DEFS.map(d => makeOrbiter(d, "relay"));
  const obs = makeOrbiter(OBS_DEF, "observatory");
  obs.name = "Observatory";

  const nodes = [earth, ...relays, obs];
  const debris = buildDebris(scenario, rand);

  return { t: 0, scenario, nodes, debris, _rand: rand };
}

export function step(world, dtHours) {
  const dtDays = dtHours / 24;
  world.t += dtDays;

  // Advance orbital angles.
  for (const n of world.nodes) {
    n.phi += n.omega * dtDays;
  }

  // Drift debris.
  for (const d of world.debris) {
    d.x += d.vx * dtDays;
    d.y += d.vy * dtDays;
  }
}

export function snapshot(world) {
  const nodes = world.nodes.map(n => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    x: n.a * Math.cos(n.phi),
    y: n.a * Math.sin(n.phi),
  }));

  const debris = world.debris.map(d => ({
    id: d.id,
    kind: d.kind,
    x: d.x,
    y: d.y,
    r: d.r,
    strength: d.strength,
    vx: d.vx,
    vy: d.vy,
    particles: d.particles.map(p => ({ dx: p.dx, dy: p.dy })),
  }));

  return { t: world.t, nodes, debris };
}

// Closest distance from point (cx,cy) to segment (ax,ay)→(bx,by).
function pointSegDist(cx, cy, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(cx - ax, cy - ay);
  const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lenSq));
  return Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy));
}

export function attenuationDb(snap, nodeA, nodeB) {
  const na = typeof nodeA === "string" ? snap.nodes.find(n => n.id === nodeA) : nodeA;
  const nb = typeof nodeB === "string" ? snap.nodes.find(n => n.id === nodeB) : nodeB;
  let total = 0;
  for (const d of snap.debris) {
    const s = pointSegDist(d.x, d.y, na.x, na.y, nb.x, nb.y);
    if (s < d.r) {
      total += d.strength * Math.pow(1 - s / d.r, 2);
    }
  }
  return total;
}

export function addDebris(world, x, y, kind) {
  const r = kind === "comet" ? 0.15 : 0.35;
  const strength = kind === "comet" ? 40 : 30;
  const vx = kind === "comet" ? 0.004 : 0.0002;
  const vy = kind === "comet" ? -0.005 : -0.0001;
  const id = `user-${kind}-${world.debris.length}`;
  const n = kind === "comet" ? 15 : 40;
  world.debris.push(makeDebrisCluster(id, x, y, kind, r, strength, vx, vy, world._rand, n));
}
