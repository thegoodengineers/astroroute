// Main loop: sim -> router -> packets -> detect -> ui. Owner: Ayush.
import * as router from "./router.js";
import * as realSim from "./sim.js";
import * as realDetect from "./detect.js";
import { COLORS, drawChart, renderRoute, renderLog, renderProgress, renderVerdict,
  renderHopThreats, renderTransitWindows, drawHeatmap, latestOnly } from "./ui.js";
import { Map3D } from "./map3d.js";

// sim.js and detect.js are implemented on main, so the real modules run. The small mocks below
// follow docs/PLAN.md "Interfaces" exactly; flip this to true to run the UI without them.
const USE_MOCKS = false;

// ============================================================== mocks (USE_MOCKS)

const mockSim = (() => {
  // [id, name, kind, orbit radius AU, angle offset from Earth rad]. The network co-rotates with
  // Earth (station-keeping relays) so the geometry stays readable; debris drifts inertially.
  const LAYOUT = [
    ["earth", "Earth", "earth", 1.0, 0], ["relay-1", "Relay-1", "relay", 1.5, 0.5],
    ["relay-2", "Relay-2", "relay", 1.75, -0.15], ["relay-3", "Relay-3", "relay", 2.2, 0.95],
    ["relay-4", "Relay-4", "relay", 2.6, 0.35], ["relay-5", "Relay-5", "relay", 1.35, 1.35],
    ["relay-6", "Relay-6", "relay", 2.55, 1.75], ["observatory", "Observatory", "observatory", 3.3, 1.15],
  ];
  const OMEGA = (2 * Math.PI) / 365.25; // rad per day
  const KINDS = {
    asteroid: { r: 0.34, strength: 32, speed: 0.01 },  // slow, wide swarm
    comet: { r: 0.25, strength: 40, speed: 0.12 },     // fast, dense coma
  };
  let seq = 0;

  function createWorld() { return { t: 0, angle: -0.35, debris: [] }; }

  function step(world, dtHours) {
    const dtD = dtHours / 24;
    world.t += dtD;
    world.angle += OMEGA * dtD;
    for (const d of world.debris) { d.x += d.vx * dtD; d.y += d.vy * dtD; }
    world.debris = world.debris.filter((d) => Math.hypot(d.x, d.y) < 6);
  }

  function snapshot(world) {
    return {
      t: world.t,
      nodes: LAYOUT.map(([id, name, kind, r, off]) => ({
        id, name, kind, x: r * Math.cos(world.angle + off), y: r * Math.sin(world.angle + off),
      })),
      debris: world.debris.map((d) => ({ ...d })),
    };
  }

  // PLAN: for each debris, closest distance s from its centre to segment A-B;
  // if s < r add strength * (1 - s/r)^2 dB.
  function attenuationDb(snap, a, b) {
    let db = 0;
    const ex = b.x - a.x, ey = b.y - a.y, len2 = ex * ex + ey * ey || 1e-12;
    for (const d of snap.debris) {
      const u = Math.max(0, Math.min(1, ((d.x - a.x) * ex + (d.y - a.y) * ey) / len2));
      const s = Math.hypot(a.x + u * ex - d.x, a.y + u * ey - d.y);
      if (s < d.r) db += d.strength * (1 - s / d.r) ** 2;
    }
    return db;
  }

  function addDebris(world, x, y, kind = "asteroid") {
    const k = KINDS[kind] || KINDS.asteroid, rr = Math.hypot(x, y) || 1;
    // drift prograde, tangential to the Sun
    world.debris.push({ id: `d${++seq}`, kind, x, y, r: k.r, strength: k.strength,
      vx: (-y / rr) * k.speed, vy: (x / rr) * k.speed });
  }

  return { createWorld, step, snapshot, attenuationDb, addDebris };
})();

const mockDetect = (() => {
  const stats = (a) => {
    let m = 0; for (const v of a) m += v; m /= a.length || 1;
    let s = 0; for (const v of a) s += (v - m) ** 2;
    return [m, Math.sqrt(s / Math.max(1, a.length - 1))];
  };

  // Coarse box search: phase-bin at each trial period, slide 1-4 bin boxes, score by SNR.
  function bls(time, flux, opts = {}) {
    const n = time.length, span = time[n - 1] - time[0];
    const pMin = opts.pMin ?? 0.5, pMax = opts.pMax ?? Math.max(pMin * 1.5, Math.min(12, span / 2));
    const NP = 320, NB = 64, [mean, sd] = stats(flux);
    const periods = [], power = [];
    let best = { period: pMin, t0: time[0], duration: 0, depth: 0, depthErr: sd, snr: 0 };
    const sums = new Float64Array(NB), cnt = new Uint32Array(NB);
    for (let k = 0; k < NP; k++) {
      const P = pMin * (pMax / pMin) ** (k / (NP - 1));
      sums.fill(0); cnt.fill(0);
      for (let i = 0; i < n; i++) {
        const ph = ((time[i] - time[0]) / P) % 1, b = Math.min(NB - 1, (ph * NB) | 0);
        sums[b] += flux[i]; cnt[b]++;
      }
      let top = 0;
      for (let w = 1; w <= 4; w++) for (let b0 = 0; b0 < NB; b0++) {
        let s = 0, c = 0;
        for (let j = 0; j < w; j++) { const b = (b0 + j) % NB; s += sums[b]; c += cnt[b]; }
        if (c < 3) continue;
        const depth = mean - s / c, err = sd / Math.sqrt(c), snr = depth / err;
        if (snr > top) top = snr;
        if (snr > best.snr) best = { period: P, t0: time[0] + ((b0 + w / 2) / NB) * P, duration: (w / NB) * P, depth, depthErr: err, snr };
      }
      periods.push(P); power.push(top);
    }
    return { periods, power, best };
  }

  // phase in days from mid-transit, (-P/2, P/2], same convention as detect.js
  function fold(time, flux, period, t0) {
    const phase = time.map((t) => { const x = (t - t0) / period; return (x - Math.round(x)) * period; });
    return { phase, flux: flux.slice() };
  }

  function vet(time, flux, best, starRadius = null) {
    const { period: P, t0, duration: D, depth } = best;
    const [mean] = stats(flux);
    const odd = [], even = [], sec = [], epochs = new Set();
    for (let i = 0; i < time.length; i++) {
      const e = Math.round((time[i] - t0) / P), dt = time[i] - (t0 + e * P);
      if (Math.abs(dt) < D / 2) { epochs.add(e); (e % 2 ? odd : even).push(flux[i]); }
      const dt2 = time[i] - (t0 + (Math.round((time[i] - t0) / P - 0.5) + 0.5) * P);
      if (Math.abs(dt2) < D / 2) sec.push(flux[i]);
    }
    const [mo, so] = stats(odd), [me, se] = stats(even), [ms, ss] = stats(sec);
    const eo = so / Math.sqrt(odd.length || 1), ee = se / Math.sqrt(even.length || 1);
    const diff = Math.abs(mo - me), lim = 3 * Math.hypot(eo, ee);
    const d2 = mean - ms, e2 = ss / Math.sqrt(sec.length || 1);
    const pct = (v) => `${(v * 100).toFixed(3)}%`;
    const checks = [
      { name: "Transits observed", passed: epochs.size >= 3, value: epochs.size,
        detail: `${epochs.size} transit${epochs.size === 1 ? "" : "s"} in the received data (need 3)` },
      { name: "Signal-to-noise", passed: best.snr >= 7.1, value: best.snr,
        detail: `SNR ${best.snr.toFixed(1)} against the 7.1 detection threshold` },
      { name: "Odd/even depths", passed: odd.length > 2 && even.length > 2 && diff < lim, value: diff,
        detail: `odd ${pct(mean - mo)} vs even ${pct(mean - me)}; a binary star would differ` },
      { name: "No secondary eclipse", passed: sec.length < 3 || d2 < Math.max(3 * e2, 0.1 * depth), value: d2,
        detail: `dip at phase 0.5 is ${pct(Math.max(0, d2))} vs transit ${pct(depth)}` },
    ];
    let verdict = "PLANET CANDIDATE";
    if (!checks[0].passed) verdict = "NEED MORE DATA";
    else if (!checks[1].passed) verdict = "NO CONVINCING SIGNAL";
    else if (!checks[2].passed || !checks[3].passed) verdict = "LIKELY FALSE POSITIVE";
    const radiusAssumed = !(starRadius > 0); // Rp = R* sqrt(depth), R_sun = 109.1 R_earth
    const radiusEarth = (radiusAssumed ? 1 : starRadius) * Math.sqrt(Math.max(0, depth)) * 109.1;
    return { checks, verdict, radiusEarth, radiusAssumed };
  }

  return { bls, fold, vet };
})();

const sim = USE_MOCKS ? mockSim : realSim;
const detect = USE_MOCKS ? mockDetect : realDetect;

// ============================================================== constants + state

const SIM_HOURS_PER_SEC = 1;    // at 1x: one simulated hour per real second
const PACKETS_PER_TARGET = 240; // each light curve is split into this many packets
const LAUNCH_SEC = 0.6;         // one packet per 0.6 s at 1x
const PACKET_AU_PER_SEC = 0.5;  // visual packet speed at 1x
const DETECT_EVERY = 10;        // run BLS + vetting every N delivered packets
const SWITCH_MARGIN = 0.03;     // only leave a working route for one >3% better (no flapping)
const AHEAD_DAYS = 1;           // predictive routing horizon

const $ = (id) => document.getElementById(id);
const els = { map: $("map"), lc: $("chart-lc"), pg: $("chart-pg"), fold: $("chart-fold") };
const params = new URLSearchParams(location.search);

const S = {
  playing: false, speed: 1, mode: "fastest", predictive: true, tool: null, hover: null,
  heatmap: false,
  timeSec: 0, wallPlay: 0,
  world: null, snap: null, prevSnap: null, links: [], nowLinks: [], best: null, alt: null,
  status: "up", reroutes: 0, forced: 0, everLinked: false,
  src: null, dst: null, names: new Map(), debrisLabels: new Map(), debrisCount: { asteroid: 0, comet: 0 },
  targets: [], target: null, lc: null, chunkSize: 1, nChunks: 0,
  produced: 0, launched: 0, backlog: 0, launchAcc: 0, packets: [], chunks: [], delivered: 0, receivedPoints: 0,
  det: null, detBls: null, detError: null, done: false, lcDirty: true, yRange: [0.99, 1.01],
  events: [], logDirty: true,
  demo: params.get("demo") === "1" ? { swarm: false, comet: false } : null,
  transitWindows: [], mapT: null,
};

const nameOf = (id) => S.names.get(id) || id;

// ============================================================== events

function stamp() {
  const t = S.world ? (S.snap?.t ?? 0) : 0;
  const d = Math.floor(t), m = Math.round((t - d) * 1440), hh = Math.floor(m / 60) % 24, mm = m % 60;
  return `T+${d}d ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function log(text, level = "") {
  S.events.unshift({ stamp: stamp(), text, level });
  if (S.events.length > 200) S.events.length = 200;
  S.logDirty = true;
}

// ============================================================== world + routing

function resetWorld() {
  S.world = sim.createWorld("default");
  S.snap = sim.snapshot(S.world);
  S.names = new Map(S.snap.nodes.map((n) => [n.id, n.name || n.id]));
  S.src = S.snap.nodes.find((n) => n.kind === "observatory")?.id;
  S.dst = S.snap.nodes.find((n) => n.kind === "earth")?.id;
  S.prevSnap = null; S.best = null; S.alt = null; S.reroutes = 0; S.forced = 0; S.everLinked = false;
  S.debrisLabels.clear(); S.debrisCount = { asteroid: 0, comet: 0 };
}

function linkIndex(links) {
  const m = new Map();
  for (const l of links) m.set(router.edgeKey(l.a, l.b), l);
  return m;
}

// Re-evaluate an existing route on the current links; null if any of its links is now blocked.
function revalidate(nodes, idx) {
  const used = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const l = idx.get(router.edgeKey(nodes[i], nodes[i + 1]));
    if (!l || l.blocked) return null;
    used.push(l);
  }
  const o = router.DEFAULTS;
  const capacity = Math.min(...used.map((l) => l.capacityMbps ?? router.capacityMbps(l.snrDb)));
  const cost = S.mode === "throughput" ? -capacity : used.reduce((s, l) => s + l.latencyMin +
    (S.mode === "reliable" ? o.lambda * Math.max(0, o.comfortDb - l.snrDb) : 0), 0);
  return { nodes, links: used, cost, capacityMbps: capacity, latencyMin: used.reduce((s, l) => s + l.latencyMin, 0),
    minSnrDb: Math.min(...used.map((l) => l.snrDb)) };
}

const pathKey = (p) => (p ? p.nodes.join(">") : "");

// Which debris (by label) is responsible for blocking link A-B in `snap`: every cloud adding at
// least a quarter of the strongest one's jamming, e.g. "Swarm A-1 + Comet C-1"; null if none.
function culprit(a, b, snap = S.snap) {
  const A = snap.nodes.find((n) => n.id === a), B = snap.nodes.find((n) => n.id === b);
  if (!A || !B) return null;
  const hits = (snap.debris || []).map((d) => [d, sim.attenuationDb({ ...snap, debris: [d] }, A, B)])
    .filter(([, db]) => db > 0).sort((x, y) => y[1] - x[1]);
  if (!hits.length) return null;
  return hits.filter(([, db]) => db >= hits[0][1] / 4).map(([d]) => labelOf(d)).join(" + ");
}

function labelOf(d) {
  if (!S.debrisLabels.has(d.id)) {
    const kind = d.kind === "comet" ? "comet" : "asteroid";
    const n = ++S.debrisCount[kind];
    S.debrisLabels.set(d.id, kind === "comet" ? `Comet C-${n}` : `Swarm A-${n}`);
  }
  return S.debrisLabels.get(d.id);
}

// Why `route` is no longer usable. forced: a link is jammed right now (packets interrupted);
// otherwise a link is forecast to be jammed within AHEAD_DAYS and we leave it proactively.
function describeBreak(route) {
  const now = linkIndex(S.nowLinks), used = linkIndex(S.links);
  const hops = route.nodes.slice(1).map((b, i) => [route.nodes[i], b]);
  for (const [a, b] of hops) {
    const l = now.get(router.edgeKey(a, b));
    if (l && !l.blocked) continue;
    const who = l && culprit(a, b);
    return { forced: true, text: who ? `${who} jammed ${nameOf(a)} -> ${nameOf(b)}` : `${nameOf(a)} -> ${nameOf(b)} went out of range` };
  }
  for (const [a, b] of hops) {
    if (!used.get(router.edgeKey(a, b))?.forecastBlocked) continue;
    const who = S.prevSnap && culprit(a, b, router.forecastSnapshot(S.prevSnap, S.snap, S.snap.t - S.prevSnap.t, AHEAD_DAYS));
    return { forced: false, text: `${who || "Debris"} will jam ${nameOf(a)} -> ${nameOf(b)} within ${AHEAD_DAYS} d` };
  }
  return null;
}

// Links to route on. Predictive: avoid links that are blocked now OR forecast to be blocked
// within AHEAD_DAYS (router.buildLinksAhead); if that leaves no path, fall back to links as
// they are now. The same links feed bestPath and alternatePath.
function routingLinks() {
  S.nowLinks = router.buildLinks(S.snap, sim.attenuationDb);
  const dtDays = S.prevSnap ? S.snap.t - S.prevSnap.t : 0;
  if (!S.predictive || !(dtDays > 0)) return S.nowLinks;
  const ahead = router.buildLinksAhead(S.prevSnap, S.snap, sim.attenuationDb, dtDays, { aheadDays: AHEAD_DAYS });
  return S.src && S.dst && !router.bestPath(ahead, S.src, S.dst, S.mode) ? S.nowLinks : ahead;
}

function updateRouting(reason = "") {
  S.links = routingLinks();
  const fresh = S.src && S.dst ? router.bestPath(S.links, S.src, S.dst, S.mode) : null;
  const cur = S.best ? revalidate(S.best.nodes, linkIndex(S.links)) : null;
  let next = fresh;
  if (cur && fresh && pathKey(cur) !== pathKey(fresh) && !reason &&
    cur.cost - fresh.cost <= Math.abs(cur.cost) * SWITCH_MARGIN) next = cur;
  const prev = S.best, prevAlt = S.alt;
  S.best = next;
  S.alt = next ? router.alternatePath(S.links, S.src, S.dst, next, S.mode) : null;

  const nominal = router.bestPath(router.buildLinks(S.snap, null), S.src, S.dst, S.mode);
  S.status = !next ? "down" : pathKey(nominal) === pathKey(next) ? "up" : "rerouted";

  const via = (p) => (p.nodes.length > 2 ? p.nodes.slice(1, -1).map(nameOf).join(", ") : "direct link");
  if (pathKey(prev) === pathKey(next)) {
    // the failover route was hit while the main route survived
    const cause = prevAlt && pathKey(prevAlt) !== pathKey(S.alt) && describeBreak(prevAlt);
    if (cause) log(`${cause.text} on the alternate; ${S.alt ? `new alternate via ${via(S.alt)}` : "no alternate left"}`, "warn");
    return;
  }
  if (!prev && next) {
    if (!S.everLinked) log(`Link established: ${next.nodes.map(nameOf).join(" -> ")} (${next.latencyMin.toFixed(1)} min)`, "info");
    else log(`Link restored via ${via(next)}; flushing ${S.backlog} buffered packet${S.backlog === 1 ? "" : "s"}`, "good");
    S.everLinked = true;
  } else if (prev && !next) {
    log(`LINK DOWN: ${describeBreak(prev)?.text || "no route to Earth"}; buffering at ${nameOf(S.src)}`, "bad");
  } else {
    S.reroutes++;
    const dl = next.latencyMin - prev.latencyMin, delta = `${dl >= 0 ? "+" : "-"}${Math.abs(dl).toFixed(1)} min`;
    const cause = describeBreak(prev);
    if (cause?.forced) S.forced++;
    if (cause) log(`${cause.text}; ${cause.forced ? "forced" : "proactive"} reroute via ${via(next)}, ${delta}`, cause.forced ? "bad" : "warn");
    else if (reason) log(`${reason}: route via ${via(next)}, ${delta}`, "info");
    else if (S.mode === "throughput") log(`Wider route via ${via(next)}: ${next.capacityMbps.toFixed(1)} Mbps (was ${prev.capacityMbps.toFixed(1)})`, "info");
    else log(`Path cleared; switched to cheaper route via ${via(next)}, ${delta}`, "info");
  }
  rerouteInFlight();
}

// ============================================================== packets

function nodePos(id) { return S.snap.nodes.find((n) => n.id === id); }

// Route a packet from node `from` to Earth along the current best path (or the best path from there).
function routeFrom(from) {
  if (S.best) { const i = S.best.nodes.indexOf(from); if (i >= 0) return S.best.nodes.slice(i); }
  return router.bestPath(S.nowLinks, from, S.dst, S.mode)?.nodes || null;
}

function rerouteInFlight() {
  for (const p of S.packets) {
    const here = p.route[p.hop], nextHop = p.route[p.hop + 1];
    const r = routeFrom(here);
    if (!r) { p.held = true; continue; }
    if (r[1] !== nextHop) p.frac = 0; // turning around: restart from the last relay reached
    p.route = r; p.hop = 0; p.held = false;
  }
}

function launchTick() {
  if (S.produced < S.nChunks) { S.produced++; S.backlog++; }
  if (!S.best) return;
  // drain a backlog faster after an outage
  for (let k = 0; k < 3 && S.backlog > 0; k++) {
    S.backlog--;
    S.packets.push({ chunk: S.launched++, route: S.best.nodes.slice(), hop: 0, frac: 0, held: false, x: 0, y: 0 });
  }
}

function movePackets(dtSec) {
  const idx = linkIndex(S.nowLinks); // packets only stop for links that are jammed now
  const keep = [];
  for (const p of S.packets) {
    let adv = PACKET_AU_PER_SEC * S.speed * dtSec, delivered = false;
    while (adv > 0) {
      if (p.hop >= p.route.length - 1) { delivered = true; break; }
      const a = p.route[p.hop], b = p.route[p.hop + 1];
      const l = idx.get(router.edgeKey(a, b));
      if (!l || l.blocked) {
        const r = routeFrom(a);
        if (!r || r.length < 2) { p.held = true; p.frac = 0; break; }
        p.route = r; p.hop = 0; p.frac = 0; p.held = false;
        continue;
      }
      p.held = false;
      const len = l.distAU;
      if (p.frac + adv >= len) { adv -= len - p.frac; p.hop++; p.frac = 0; } else { p.frac += adv; adv = 0; }
    }
    if (delivered || p.hop >= p.route.length - 1) { deliver(p.chunk); continue; }
    const A = nodePos(p.route[p.hop]), B = nodePos(p.route[p.hop + 1]);
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1, u = Math.min(1, p.frac / len);
    p.x = A.x + (B.x - A.x) * u; p.y = A.y + (B.y - A.y) * u;
    keep.push(p);
  }
  S.packets = keep;
}

function deliver(chunk) {
  if (S.chunks[chunk]) return;
  const lo = chunk * S.chunkSize, hi = Math.min(S.lc.time.length, lo + S.chunkSize);
  S.chunks[chunk] = { time: S.lc.time.slice(lo, hi), flux: S.lc.flux.slice(lo, hi) };
  S.delivered++; S.receivedPoints += hi - lo; S.lcDirty = true;
  if (S.delivered % DETECT_EVERY === 0 || S.delivered === S.nChunks) runDetect();
}

// ============================================================== detection

function receivedArrays() {
  const time = [], flux = [];
  for (const c of S.chunks) if (c) { for (const v of c.time) time.push(v); for (const v of c.flux) flux.push(v); }
  return { time, flux };
}

function detectAll(time, flux, starRadius) {
  const b = detect.bls(time, flux, {});
  const v = detect.vet(time, flux, b.best, starRadius);
  const f = b.best ? detect.fold(time, flux, b.best.period, b.best.t0) : null;
  return { b, v, f };
}

// The real BLS takes ~1 s on a full light curve, so it runs in a module worker to keep the map
// animating. Built from a Blob so it imports the same detect.js; falls back to the main thread.
function makeDetectWorker() {
  if (USE_MOCKS || typeof Worker === "undefined") return null;
  const src = `import * as detect from ${JSON.stringify(new URL("./detect.js", import.meta.url).href)};
onmessage = (e) => {
  const { gen, time, flux, starRadius } = e.data;
  try {
    const b = detect.bls(time, flux, {});
    const v = detect.vet(time, flux, b.best, starRadius);
    const f = b.best ? detect.fold(time, flux, b.best.period, b.best.t0) : null;
    postMessage({ gen, b, v, f });
  } catch (err) { postMessage({ gen, error: err.message }); }
};`;
  try {
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
    w.onmessage = (e) => onDetectResult(e.data);
    w.onerror = (e) => { e.preventDefault(); detectWorker = null; job.busy = false; runDetect(); };
    return w;
  } catch { return null; }
}
let detectWorker = null;
const job = { gen: 0, busy: false, again: false, final: false };

// Host star radius in solar radii (data file, else index.json); null -> vet assumes 1 R_sun.
const starRadius = () => S.lc?.starRadius ?? S.target?.starRadius ?? null;

function runDetect() {
  const { time, flux } = receivedArrays();
  if (time.length < 100) return;
  if (job.busy) { job.again = true; return; } // coalesce: rerun on the newest data when done
  job.final = S.delivered === S.nChunks;
  if (detectWorker) {
    job.busy = true;
    detectWorker.postMessage({ gen: job.gen, time, flux, starRadius: starRadius() });
    return;
  }
  let res;
  try { res = { gen: job.gen, ...detectAll(time, flux, starRadius()) }; } catch (e) { res = { gen: job.gen, error: e.message }; }
  onDetectResult(res);
}

function onDetectResult({ gen, b, v, f, error }) {
  if (gen !== job.gen) return; // a result for a target or run that was reset meanwhile
  job.busy = false;
  if (error) {
    if (!S.detError) log(`Detector error: ${error}`, "bad");
    S.detError = error;
  } else {
    S.detBls = b; S.det = v; S.fold = f; S.detError = null;
    // Update transit windows when we have a new BLS result
    if (b?.best && S.snap) {
      S.transitWindows = realSim.predictTransitWindows
        ? realSim.predictTransitWindows(S.snap, b.best.period, b.best.t0, 6, b.best.duration)
        : [];
    }
  }
  drawDetection();
  if (job.again) { job.again = false; runDetect(); return; }
  if (job.final && !S.done) {
    S.done = true;
    const v = S.det?.verdict || "no verdict";
    log(`All ${S.receivedPoints.toLocaleString()} points received; verdict: ${v}`,
      v === "PLANET CANDIDATE" ? "good" : v === "LIKELY FALSE POSITIVE" ? "bad" : "info");
  }
}

function binned(x, y, lo, hi, nb) {
  const s = new Float64Array(nb), c = new Uint32Array(nb);
  for (let i = 0; i < x.length; i++) {
    const b = Math.floor(((x[i] - lo) / (hi - lo)) * nb);
    if (b >= 0 && b < nb) { s[b] += y[i]; c[b]++; }
  }
  const bx = [], by = [];
  for (let b = 0; b < nb; b++) { bx.push(lo + ((b + 0.5) / nb) * (hi - lo)); by.push(c[b] ? s[b] / c[b] : NaN); }
  return { x: bx, y: by };
}

function drawLightCurve() {
  if (!S.lc) return;
  const t = S.lc.time, { time, flux } = receivedArrays();
  drawChart(els.lc, {
    xRange: [t[0], t[t.length - 1]], yRange: S.yRange, xLabel: "time (days)", yLabel: "flux",
    series: [{ type: "scatter", x: time, y: flux, color: COLORS.accent, size: 1.4, alpha: 0.8 }],
    empty: time.length ? "" : "waiting for packets…",
  });
  renderProgress(S.receivedPoints, t.length);
  S.lcDirty = false;
}

// ── Network Intelligence panel ────────────────────────────────────────────────
let _intelCache = { snapT: -999, result: null };
let _intelWorking = false;

function renderIntelPanel(snap) {
  if (!snap) return;
  if (_intelWorking) return;
  // Recompute at most every 5 simulated days (keeps frame loop smooth)
  if (Math.abs(snap.t - _intelCache.snapT) < 5 && _intelCache.result) {
    _applyIntelUI(_intelCache.result); return;
  }
  _intelWorking = true;
  setTimeout(() => {
    const risk = realSim.monteCarloPartitionRisk(snap, 300, 24, 0.25);
    const relayRank = realSim.relayVulnerabilityRanking(snap);
    const collisions = realSim.debrisCollisionForecast(snap, 72, 2);
    const optRelay = realSim.optimalRelayPosition(snap, 0.4, 2.6);
    const div = realSim.pathDiversity(snap);
    // FEC for best route min SNR
    const minSnr = S.best ? Math.min(...(S.best.links ?? []).map(l => l.snrDb ?? 30)) : null;
    const fec = minSnr != null ? realSim.adaptiveFecRate(minSnr) : null;
    const result = { risk, relayRank, collisions, optRelay, div, fec, minSnr };
    _intelCache = { snapT: snap.t, result };
    _intelWorking = false;
    _applyIntelUI(result);
  }, 0);
}

function _applyIntelUI({ risk, relayRank, collisions, optRelay, div, fec, minSnr }) {
  // Risk gauge
  const riskPct = Math.round(risk.risk * 100);
  const riskEl = $("intel-risk"), riskPill = $("intel-risk-pill"), riskSub = $("intel-risk-sub");
  if (riskEl) riskEl.textContent = riskPct + "%";
  if (riskSub) riskSub.textContent = `${risk.disconnectedTrials}/${risk.trials} trials disconnected`;
  if (riskPill) {
    riskPill.textContent = riskPct < 10 ? "LOW" : riskPct < 40 ? "MODERATE" : "HIGH";
    riskPill.className = "pill " + (riskPct < 10 ? "up" : riskPct < 40 ? "rerouted" : "down");
  }

  // Diversity
  const divEl = $("intel-div");
  if (divEl) divEl.textContent = `${"●".repeat(div)}${"○".repeat(Math.max(0,5-div))} ${div}`;

  // Relay ranking
  const rl = $("intel-relays");
  if (rl) {
    const maxCrit = relayRank[0]?.criticality || 1;
    rl.innerHTML = relayRank.slice(0,5).map(r => `
      <li class="intel-relay-row">
        <span class="intel-relay-name" title="${r.name}">${r.name}</span>
        <span class="intel-relay-bar"><span class="intel-relay-fill" style="width:${Math.round(r.criticality/maxCrit*100)}%"></span></span>
        <span class="intel-relay-score">${r.lostNodes}</span>
        ${r.disconnectsEarth ? '<span class="intel-relay-flag">⚠ critical</span>' : ''}
      </li>`).join('');
  }

  // FEC
  const fecEl = $("intel-fec");
  if (fecEl && fec) {
    const cls = fec.effectiveFraction > 0.7 ? '' : fec.effectiveFraction > 0.4 ? ' warn' : ' bad';
    fecEl.className = "intel-fec mono" + cls;
    fecEl.textContent = `${fec.name} · rate ${fec.rate.toFixed(2)} · ${Math.round(fec.overheadFraction*100)}% overhead · +${fec.margindB} dB margin`;
  } else if (fecEl) {
    fecEl.textContent = "awaiting route";
  }

  // Collisions
  const cl = $("intel-collisions");
  if (cl) {
    if (!collisions.length) {
      cl.innerHTML = '<li class="intel-muted">No convergence detected</li>';
    } else {
      cl.innerHTML = collisions.map(c => {
        const cls = c.merging ? "merging" : c.minDistAU < (c.combinedRadius * 1.2) ? "close" : "";
        const icon = c.merging ? "⚠ MERGE" : "→";
        return `<li class="intel-collision-row ${cls}">${icon} ${c.idA} + ${c.idB} · ${c.minDistAU} AU in ${Math.round(c.inHours)}h · strength ${c.combinedStrength} dB</li>`;
      }).join('');
    }
  }

  // Optimal relay
  const orEl = $("intel-relay-hint");
  if (orEl) {
    if (optRelay.candidates.length) {
      const best = optRelay.candidates[0];
      const gain = best.diversity - optRelay.baseDiversity;
      orEl.textContent = gain > 0
        ? `(${best.x.toFixed(1)}, ${best.y.toFixed(1)}) AU → +${gain} path${gain>1?'s':''} (div ${best.diversity})`
        : `No improvement over current div ${optRelay.baseDiversity}`;
    } else {
      orEl.textContent = "—";
    }
  }
}

function drawDetection() {
  const b = S.detBls, pub = S.target?.publishedPeriod;
  if (b?.best && b.periods?.length) {
    const pmax = Math.max(...b.power.filter(Number.isFinite), 1e-9);
    drawChart(els.pg, {
      xRange: [b.periods[0], b.periods[b.periods.length - 1]], yRange: [0, pmax * 1.15],
      xLabel: "period (d)", yLabel: "power",
      series: [{ type: "line", x: b.periods, y: b.power, color: COLORS.accent, width: 1.2 }],
      marks: [{ x: b.best.period, color: COLORS.green, label: `${b.best.period.toFixed(3)} d` },
        { x: pub, color: COLORS.amber, dash: [3, 3], label: "NASA", row: 1 }],
    });
  } else {
    drawChart(els.pg, { xRange: [0, 10], yRange: [0, 1], xLabel: "period (d)", empty: S.detError ? "detector unavailable" : "needs more data" });
  }

  if (S.fold && b?.best) {
    // fold() gives days from mid-transit; plot hours, zoomed to a few transit durations
    const ph = S.fold.phase.map((p) => p * 24);
    const win = 24 * Math.min(b.best.period / 2, Math.max(0.1, 3 * b.best.duration));
    const bin = binned(ph, S.fold.flux, -win, win, 40);
    drawChart(els.fold, {
      xRange: [-win, win], yRange: S.yRange, xLabel: "hours from mid-transit", yLabel: "flux",
      series: [{ type: "scatter", x: ph, y: S.fold.flux, color: COLORS.muted, size: 1.3, alpha: 0.6 },
        { type: "line", x: bin.x, y: bin.y, color: COLORS.accent, width: 2 }],
    });
  } else {
    drawChart(els.fold, { xRange: [-6, 6], yRange: S.yRange, xLabel: "hours from mid-transit", empty: "no fold yet" });
  }

  let sub = "";
  if (S.detError) sub = `detector error: ${S.detError}`;
  else if (b?.best) {
    const bb = b.best;
    sub = `P = ${bb.period.toFixed(4)} d` + (pub ? ` (NASA ${pub.toFixed(4)} d)` : "") +
      ` · depth ${(bb.depth * 100).toFixed(3)}% · SNR ${bb.snr.toFixed(1)}`;
    const v = S.det;
    if (Number.isFinite(v?.radiusEarth)) sub += ` · Radius ${v.radiusEarth.toFixed(1)} R⊕${v.radiusAssumed ? " (assumed)" : ""}`;
  }
  renderVerdict(S.detError ? null : S.det, sub);
}

// ============================================================== targets + reset

function robustRange(a) {
  const s = Float64Array.from(a).sort(), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const lo = q(0.003), hi = q(0.997), pad = (hi - lo) * 0.08 || 0.001;
  return [lo - pad, hi + pad];
}

function resetTransmission() {
  S.produced = 0; S.launched = 0; S.backlog = 0; S.launchAcc = 0; S.packets = [];
  S.chunks = []; S.delivered = 0; S.receivedPoints = 0; S.done = false;
  S.det = null; S.detBls = null; S.fold = null; S.detError = null; S.lcDirty = true;
  job.gen++; job.busy = false; job.again = false; job.final = false;
  if (S.lc) {
    S.chunkSize = Math.ceil(S.lc.time.length / PACKETS_PER_TARGET);
    S.nChunks = Math.ceil(S.lc.time.length / S.chunkSize);
    S.yRange = robustRange(S.lc.flux);
  }
}

function resetAll() {
  S.events = []; S.timeSec = 0; S.wallPlay = 0;
  if (S.demo) S.demo = { swarm: false, comet: false };
  resetWorld();
  resetTransmission();
  updateRouting();
  drawLightCurve(); drawDetection();
  if (S.target) log(`Observing ${S.target.target} (${S.target.mission}); ${S.lc.time.length.toLocaleString()} points in ${S.nChunks} packets`, "info");
}

// Every place that names the current target; only called once that target's data is loaded.
function showTarget(meta) {
  $("picker-label").textContent = meta ? meta.target : "—";
  $("det-target").textContent = meta ? `${meta.target} · ${meta.mission}` : "—";
  document.querySelectorAll(".picker-item").forEach((b) => {
    const on = b.dataset.slug === meta?.slug;
    b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on));
  });
}

// Picking targets quickly overlaps fetches; a slower, older response must not replace the
// newer pick (it used to: label "TrES-2" while Kepler-17's light curve was being analysed).
const targetLoads = latestOnly();

async function loadTarget(slug) {
  const meta = S.targets.find((t) => t.slug === slug);
  if (!meta) return;
  const isCurrent = targetLoads();
  $("picker-label").textContent = `Loading ${meta.target}…`;
  let lc;
  try {
    const res = await fetch(`data/${slug}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lc = await res.json();
  } catch (e) {
    if (!isCurrent()) return;
    log(`Could not load data/${slug}.json: ${e.message}`, "bad");
    showTarget(S.target); // keep naming the target whose data is still loaded
    return;
  }
  if (!isCurrent()) return; // superseded by a newer pick
  S.lc = lc; S.target = meta;
  showTarget(meta);
  resetAll();
}

const KIND_COLOR = { planet: COLORS.green, false_positive: COLORS.red, candidate: COLORS.amber };

async function loadTargets() {
  try {
    const res = await fetch("data/index.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.targets = await res.json();
  } catch (e) {
    $("picker-label").textContent = "no data";
    log(`Could not load data/index.json: ${e.message}`, "bad");
    return;
  }
  const menu = $("picker-menu");
  menu.replaceChildren(...S.targets.map((t) => {
    const b = document.createElement("button");
    b.className = "picker-item"; b.dataset.slug = t.slug; b.setAttribute("role", "option"); b.tabIndex = -1;
    const dot = document.createElement("span"); dot.className = "kind-dot"; dot.style.background = KIND_COLOR[t.kind] || COLORS.muted;
    const name = document.createElement("span"); name.textContent = t.target;
    const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = `${t.mission} · ${t.kind.replace("_", " ")}`;
    b.append(dot, name, tag);
    b.addEventListener("click", () => { togglePicker(false); loadTarget(t.slug); });
    return b;
  }));
  await loadTarget(S.targets[0].slug);
}

// ============================================================== controls

function togglePicker(open, focusItem = false) {
  const menu = $("picker-menu"), btn = $("picker-btn");
  const show = open ?? menu.hidden;
  if (!show && menu.hidden) return;
  const hadFocus = menu.contains(document.activeElement);
  menu.hidden = !show; btn.setAttribute("aria-expanded", String(show));
  if (show && focusItem) (menu.querySelector(".picker-item.active") || menu.querySelector(".picker-item"))?.focus();
  else if (!show && hadFocus) btn.focus();
}

// Listbox keys: arrows / Home / End move between targets, Enter or Space picks, Esc closes.
function pickerKeys(e) {
  const items = [...$("picker-menu").querySelectorAll(".picker-item")];
  const i = items.indexOf(document.activeElement);
  const go = (k) => { e.preventDefault(); items[(k + items.length) % items.length]?.focus(); };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(-1);
  else if (e.key === "Tab") togglePicker(false);
}

function setPlaying(on) {
  S.playing = on;
  const b = $("play-btn");
  b.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play");
  b.querySelector(".btn-label").textContent = on ? "Pause" : "Play";
  b.setAttribute("aria-pressed", String(on));
}

function setSpeed(v) {
  S.speed = v;
  document.querySelectorAll("#speed-seg .seg-btn").forEach((b) => b.classList.toggle("active", +b.dataset.speed === v));
}

const MODE_NAMES = { fastest: "Fastest", reliable: "Reliable", throughput: "Max throughput" };

function setMode(m) {
  if (S.mode === m) return;
  S.mode = m;
  document.querySelectorAll("#mode-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  if (S.snap) updateRouting(`Mode ${MODE_NAMES[m]}`);
}

function setPredictive(on) {
  S.predictive = on;
  const b = $("predict-btn");
  b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  if (S.snap) updateRouting(`Predictive routing ${on ? "on" : "off"}`);
}

function setTool(t) {
  S.tool = S.tool === t ? null : t;
  document.querySelectorAll(".tool").forEach((b) => {
    const on = b.dataset.tool === S.tool;
    b.classList.toggle("armed", on); b.setAttribute("aria-pressed", String(on));
  });
  els.map.classList.toggle("armed", !!S.tool);
  const hint = $("map-hint");
  hint.hidden = !S.tool;
  const verb = matchMedia("(pointer: coarse)").matches ? "Tap" : "Click";
  hint.textContent = S.tool === "comet" ? `${verb} the map to launch a comet · Esc cancels` : `${verb} the map to drop an asteroid swarm · Esc cancels`;
}

function addDebrisAt(x, y, kind) {
  const before = new Set((S.snap.debris || []).map((d) => d.id));
  sim.addDebris(S.world, x, y, kind);
  S.snap = sim.snapshot(S.world);
  const near = S.snap.nodes.reduce((a, n) => (Math.hypot(n.x - x, n.y - y) < Math.hypot(a.x - x, a.y - y) ? n : a));
  for (const d of S.snap.debris) if (!before.has(d.id)) log(`${labelOf(d)} ${kind === "comet" ? "launched" : "dropped"} near ${near.name}`, "warn");
  updateRouting();
}

// Midpoint of the longest link of a route: where the demo aims its debris.
function aimAt(route) {
  let bestL = null;
  for (let i = 0; i + 1 < route.nodes.length; i++) {
    const a = nodePos(route.nodes[i]), b = nodePos(route.nodes[i + 1]), len = Math.hypot(a.x - b.x, a.y - b.y);
    if (!bestL || len > bestL.len) bestL = { len, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return bestL;
}

let mapT = null;
let _map3d = null;

function getMap3D() {
  if (!_map3d) {
    _map3d = new Map3D(els.map);
    els.map.addEventListener('mousemove', e => _map3d.onMouseMove(e.clientX, e.clientY));
  }
  return _map3d;
}

// Jamming heatmap: a 2D overlay above the 3D map. Each screen cell is projected onto the
// ecliptic plane (Map3D.toWorld) and coloured by the debris jamming at that point, using the
// same falloff as sim.attenuationDb: strength * (1 - s/r)^2 inside radius r.
const HEAT_EVERY_MS = 250;
function jamAt(x, y) {
  let db = 0;
  for (const d of S.snap?.debris || []) {
    const s = Math.hypot(x - d.x, y - d.y);
    if (s < d.r) db += d.strength * (1 - s / d.r) ** 2;
  }
  return db;
}
function drawJamHeatmap() {
  if (!mapT?.toWorld) return;
  drawHeatmap($("heat"), mapT, jamAt, 20);
}
function setHeatmap(on) {
  S.heatmap = on;
  const b = $("heatmap-btn"), heat = $("heat");
  b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
  heat.hidden = !on;
  if (on) drawJamHeatmap(); else heat.getContext("2d").clearRect(0, 0, heat.width, heat.height);
}

// Disjoint-path count on the map overlay: a five-dot meter plus the number.
const DIVERSITY_MAX = 5;
function renderDiversity(n) {
  $("diversity").textContent = String(n);
  const dots = $("diversity-dots");
  if (dots.childElementCount !== DIVERSITY_MAX) dots.replaceChildren(...Array.from({ length: DIVERSITY_MAX }, () => document.createElement("i")));
  [...dots.children].forEach((d, i) => d.classList.toggle("on", i < n));
}

function bindControls() {
  $("picker-btn").addEventListener("click", (e) => { e.stopPropagation(); togglePicker(undefined, e.detail === 0); });
  $("picker-btn").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); togglePicker(true, true); }
  });
  $("picker-menu").addEventListener("keydown", pickerKeys);
  document.addEventListener("click", (e) => { if (!$("picker").contains(e.target)) togglePicker(false); });
  $("play-btn").addEventListener("click", () => setPlaying(!S.playing));
  document.querySelectorAll("#speed-seg .seg-btn").forEach((b) => b.addEventListener("click", () => setSpeed(+b.dataset.speed)));
  document.querySelectorAll("#mode-seg .seg-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("predict-btn").addEventListener("click", () => setPredictive(!S.predictive));
  $("heatmap-btn").addEventListener("click", () => setHeatmap(!S.heatmap));
  document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("reset-btn").addEventListener("click", () => { setTool(null); resetAll(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { setTool(null); togglePicker(false); }
    else if (e.key === " " && e.target === document.body) { e.preventDefault(); setPlaying(!S.playing); }
  });
  els.map.addEventListener("mousemove", (e) => { const r = els.map.getBoundingClientRect(); S.hover = [e.clientX - r.left, e.clientY - r.top]; });
  els.map.addEventListener("mouseleave", () => { S.hover = null; });
  els.map.addEventListener("click", (e) => {
    if (!S.tool || !mapT || !S.world) return;
    const r = els.map.getBoundingClientRect();
    const [x, y] = mapT.toWorld(e.clientX - r.left, e.clientY - r.top);
    addDebrisAt(x, y, S.tool);
    setTool(null);
  });
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { drawLightCurve(); drawDetection(); }, 100); });
}

// ============================================================== demo story (?demo=1)

// Point on `route` farthest from every link of `avoid`, so a comet aimed there hits the
// alternate without also cutting the best path (the two often share their first node).
function aimAway(route, avoid) {
  const segDist = (px, py, a, b) => {
    const ex = b.x - a.x, ey = b.y - a.y, u = Math.max(0, Math.min(1, ((px - a.x) * ex + (py - a.y) * ey) / (ex * ex + ey * ey || 1e-12)));
    return Math.hypot(a.x + u * ex - px, a.y + u * ey - py);
  };
  let pick = null;
  for (let i = 0; i + 1 < route.nodes.length; i++) {
    const a = nodePos(route.nodes[i]), b = nodePos(route.nodes[i + 1]);
    for (let k = 1; k < 10; k++) {
      const x = a.x + (b.x - a.x) * k / 10, y = a.y + (b.y - a.y) * k / 10;
      let d = Infinity;
      for (let j = 0; j + 1 < avoid.nodes.length; j++) d = Math.min(d, segDist(x, y, nodePos(avoid.nodes[j]), nodePos(avoid.nodes[j + 1])));
      if (!pick || d > pick.d) pick = { x, y, d };
    }
  }
  return pick;
}

function demoTick() {
  if (!S.demo || !S.best) return;
  if (!S.demo.swarm && S.wallPlay >= 10) {
    S.demo.swarm = true;
    const p = aimAt(S.best);
    if (p) addDebrisAt(p.x, p.y, "asteroid");
  }
  if (!S.demo.comet && S.wallPlay >= 25 && S.alt) {
    S.demo.comet = true;
    const p = aimAway(S.alt, S.best);
    if (p) addDebrisAt(p.x, p.y, "comet");
  }
}

// ============================================================== main loop

let last = performance.now(), lcDrawAt = 0, heatDrawAt = 0, crashed = false;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  try {
    if (S.playing && S.world && S.lc) {
      S.timeSec += dt * S.speed;
      S.wallPlay += dt;
      S.prevSnap = S.snap;
      sim.step(S.world, dt * S.speed * SIM_HOURS_PER_SEC);
      S.snap = sim.snapshot(S.world);
      updateRouting();
      S.launchAcc += dt * S.speed;
      while (S.launchAcc >= LAUNCH_SEC) { S.launchAcc -= LAUNCH_SEC; launchTick(); }
      movePackets(dt);
      demoTick();
    }
    if (S.snap) {
      const snap = { ...S.snap, debris: (S.snap.debris || []).map((d) => ({ ...d, label: labelOf(d) })) };
      const held = S.packets.filter((p) => p.held && p.route[p.hop] === S.src).length;
      const m3 = getMap3D();
      m3.update({ snap, links: S.links, best: S.best, alt: S.alt, packets: S.packets,
        buffered: S.backlog + held, srcId: S.src, timeSec: S.timeSec });
      mapT = m3;
      renderRoute({ best: S.best, alt: S.alt, status: S.status, reroutes: S.reroutes, forced: S.forced, nameOf });
      renderHopThreats($("hop-threats"), S.best, S.links, nameOf);
      // Path diversity
      const div = realSim.pathDiversity ? realSim.pathDiversity(snap) : null;
      if (div != null) renderDiversity(div);
      // Transit windows (refresh each frame so countdown stays live)
      if (S.detBls?.best && S.snap && realSim.predictTransitWindows) {
        S.transitWindows = realSim.predictTransitWindows(S.snap, S.detBls.best.period, S.detBls.best.t0, 6, S.detBls.best.duration);
        renderTransitWindows($("transit-list"), $("transit-period"), S.transitWindows, S.detBls.best.period, S.snap.t);
      }
      $("clock").textContent = `T+${(S.snap.t ?? 0).toFixed(2)} d`;
      $("inflight").textContent = String(S.packets.length);
      renderIntelPanel(S.snap);
      if (S.heatmap && now - heatDrawAt > HEAT_EVERY_MS) { drawJamHeatmap(); heatDrawAt = now; }
    }
    if (S.lcDirty && now - lcDrawAt > 150) { drawLightCurve(); lcDrawAt = now; }
    if (S.logDirty) { renderLog(S.events); S.logDirty = false; }
  } catch (e) {
    if (!crashed) { crashed = true; console.error(e); log(`Simulation error: ${e.message}`, "bad"); setPlaying(false); renderLog(S.events); }
  }
  requestAnimationFrame(frame);
}

async function init() {
  detectWorker = makeDetectWorker();
  bindControls();
  renderLog(S.events);
  try { resetWorld(); updateRouting(); } catch (e) { console.error(e); log(`Simulation error: ${e.message}`, "bad"); crashed = true; }
  drawDetection();
  requestAnimationFrame(frame);
  await loadTargets();
  if (S.demo && S.lc) { setSpeed(4); setPlaying(true); log("Demo: playing at 4x", "info"); }
}

init();
