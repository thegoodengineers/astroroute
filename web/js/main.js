// Main loop: sim -> router -> packets -> detect -> ui. Owner: Ayush.
// Packets carry chunks of a real NASA light curve from the Observatory to Earth along the
// current best path; with no path they wait (buffered) and go out later - nothing is lost.
import * as sim from "./sim.js";
import { buildLinks, buildLinksAhead, forecastSnapshot, bestPath, alternatePath, edgeKey, DEFAULTS } from "./router.js";
import { bls, vet, fold } from "./detect.js";
import { $, setText, drawMap, drawChart, pushLog, renderVerdict, esc, C } from "./ui.js";

const HOURS_PER_SEC = 12;     // simulated hours per wall-clock second at 1x
const N_PACKETS = 240;        // every light curve is streamed as 240 packets
const EMIT_H = 6.4;           // the observatory fills one packet every 6.4 sim hours
const LAUNCH_GAP_H = 1.6;     // buffered packets drain 4x faster than they are produced
const PACKET_AU_PER_H = 0.06; // visual packet speed (true light speed would look instant)
const AHEAD_DAYS = 1;         // predictive routing lookahead
const SWITCH_GAIN = 0.02;     // keep a healthy path unless the new one is >2% better (no flapping)
const DETECT_EVERY_MS = 1500; // BLS on ~6000 points takes 0.1-0.6 s, so run it at most this often
const REROUTED_MS = 5000;     // how long the status pill says REROUTED after a forced reroute
const GHOST_R = { asteroid: 0.35, comet: 0.15 }; // preview radius only; the sim decides the real one
const MODE_TEXT = {
  fastest: "Fastest (minimum light-time)", reliable: "Reliable (penalises weak links)",
  throughput: "Max throughput (widest path: largest bottleneck capacity)",
};
const KIND_TEXT = { planet: "confirmed planet", false_positive: "known false positive", candidate: "TESS candidate" };

const S = {
  index: [], target: null, data: null, mode: "fastest", predictive: true, playing: true, speed: 4,
  tool: null, ghost: null, demo: new URLSearchParams(location.search).get("demo") === "1",
};

// ---------- BLS off the main thread (module worker from a blob), synchronous fallback ----------
let worker = null, jobId = 0;
const jobs = new Map();
try {
  const src = `import { bls, vet } from ${JSON.stringify(new URL("./detect.js", import.meta.url).href)};
onmessage = ({ data: { id, t, f, rs } }) => { const r = bls(t, f); postMessage({ id, r, v: vet(t, f, r.best, rs) }); };`;
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
  worker.onmessage = ({ data }) => { jobs.get(data.id)?.(data); jobs.delete(data.id); };
  worker.onerror = (e) => { e.preventDefault(); worker = null; for (const done of jobs.values()) done(null); jobs.clear(); };
} catch { worker = null; }
function runDetect(t, f, rs) { // rs: host star radius (solar radii, NASA) or null
  const sync = () => { const r = bls(t, f); return { r, v: vet(t, f, r.best, rs) }; };
  if (!worker) return Promise.resolve(sync());
  return new Promise((res) => { const id = ++jobId; jobs.set(id, (d) => res(d || sync())); worker.postMessage({ id, t, f, rs }); });
}

// ---------- helpers ----------
const name = (id) => S.pos.get(id)?.name ?? id;
const same = (a, b) => (!a && !b) || (!!a && !!b && a.nodes.join() === b.nodes.join());
const inner = (r) => r.nodes.slice(1, -1);
const disjoint = (a, b) => { const x = new Set(inner(b)); return inner(a).every((n) => !x.has(n)); };
const via = (r) => (inner(r).length ? inner(r).map(name).join(" → ") : "a direct link");
const pathText = (r) => r.nodes.map(name).join(" → ");
const stamp = () => `T+${(S.snap?.t ?? 0).toFixed(1)}d`;
const log = (kind, msg, tag = "") => pushLog(stamp(), kind, tag, msg);
const buffered = () => S.queue.length + S.packets.filter((p) => p.wait).length;
const linkCost = (l) => l.latencyMin + (S.mode === "reliable" ? DEFAULTS.lambda * Math.max(0, DEFAULTS.comfortDb - l.snrDb) : 0);
// Is route a clearly better than route b in the current mode? (throughput: wider bottleneck)
const better = (a, b) => (S.mode === "throughput" ? a.capacityMbps > b.capacityMbps * (1 + SWITCH_GAIN) : a.cost < b.cost * (1 - SWITCH_GAIN));

// Re-measure a kept route on this frame's links; null if any of its links is unusable.
function refresh(r, byKey) {
  if (!r) return null;
  const ls = [];
  for (let i = 1; i < r.nodes.length; i++) {
    const l = byKey.get(edgeKey(r.nodes[i - 1], r.nodes[i]));
    if (!l || l.blocked) return null;
    ls.push(l);
  }
  const capacity = Math.min(...ls.map((l) => l.capacityMbps));
  return { ...r, links: ls, latencyMin: ls.reduce((s, l) => s + l.latencyMin, 0), minSnrDb: Math.min(...ls.map((l) => l.snrDb)),
    capacityMbps: capacity, cost: S.mode === "throughput" ? -capacity : ls.reduce((s, l) => s + linkCost(l), 0) };
}

// Why is this path unusable? Names the hop and the debris cloud doing most of the jamming.
function blame(nodes) {
  for (let i = 1; i < nodes.length; i++) {
    const l = S.byKey.get(edgeKey(nodes[i - 1], nodes[i]));
    if (l && !l.blocked) continue;
    const ahead = !!l?.forecastBlocked;
    const snap = ahead ? forecastSnapshot(S.prev, S.snap, S.dtDays, AHEAD_DAYS) : S.snap;
    const at = new Map(snap.nodes.map((n) => [n.id, n]));
    let top = null, topDb = 0;
    for (const d of snap.debris) {
      const db = sim.attenuationDb({ ...snap, debris: [d] }, at.get(nodes[i - 1]), at.get(nodes[i]));
      if (db > topDb) { topDb = db; top = d; }
    }
    const hop = `${name(nodes[i - 1])} → ${name(nodes[i])}`;
    if (!top) return ahead ? `${hop} is drifting out of range` : `${hop} drifted out of range`;
    const who = S.labels.get(top.id)?.long ?? top.id;
    return ahead ? `${who} will jam ${hop} within ${AHEAD_DAYS} d` : `${who} jammed ${hop}`;
  }
  return "Path degraded";
}

function labelDebris() {
  for (const d of S.snap.debris) {
    if (S.labels.has(d.id)) continue;
    const n = ++S.counts[d.kind === "comet" ? "comet" : "asteroid"];
    S.labels.set(d.id, d.kind === "comet" ? { short: `C-${n}`, long: `Comet C-${n}` } : { short: `A-${n}`, long: `Swarm A-${n}` });
  }
}

// ---------- routing with hysteresis + forced/proactive bookkeeping ----------
function updateRoute(now) {
  const { src, dst, mode } = S;
  const linksNow = buildLinks(S.snap, sim.attenuationDb);
  const ahead = S.predictive && S.prev && S.dtDays > 0
    ? buildLinksAhead(S.prev, S.snap, sim.attenuationDb, S.dtDays, { aheadDays: AHEAD_DAYS }) : linksNow;
  let links = ahead, fresh = bestPath(ahead, src, dst, mode);
  if (!fresh && ahead !== linksNow) { links = linksNow; fresh = bestPath(linksNow, src, dst, mode); }
  S.links = links;
  S.byKey = new Map(links.map((l) => [edgeKey(l.a, l.b), l]));
  const nowKey = links === linksNow ? S.byKey : new Map(linksNow.map((l) => [edgeKey(l.a, l.b), l]));

  const kept = refresh(S.route, S.byKey);
  const next = kept && !(fresh && better(fresh, kept)) ? kept : fresh;
  if (!same(next, S.route)) onRouteChange(S.route, next, !kept, !refresh(S.route, nowKey), now);
  S.route = next;

  // independent backup path, kept while it stays healthy
  if (!next) { S.alt = null; return; }
  const fa = alternatePath(links, src, dst, next, mode);
  const ka = refresh(S.alt, S.byKey);
  const kaInd = !!ka && disjoint(ka, next);
  const keepAlt = ka && !same(ka, next) && (kaInd || !fa?.independent) && !(fa && better(fa, ka));
  if (S.alt && !ka && !same(S.alt, next)) {
    const why = blame(S.alt.nodes);
    if (/jam/.test(why)) log("warn", `${why} on the backup path; new backup ${fa ? `via ${via(fa)}` : "unavailable"}`, "BACKUP");
  }
  S.alt = keepAlt ? { ...ka, independent: kaInd } : fa;
}

function onRouteChange(old, next, broken, deadNow, now) {
  if (!next) { log("down", `LINK DOWN: ${blame(old.nodes)}. Buffering packets at the Observatory.`, "DOWN"); return; }
  if (!old) {
    if (S.hadRoute) { S.reroutes++; S.forced++; S.lastForced = now; log("ok", `Link restored via ${via(next)}; flushing ${buffered()} buffered packets`, "RESTORED"); }
    else log("ok", `Link up: ${pathText(next)} (${next.latencyMin.toFixed(1)} min one-way)`);
    S.hadRoute = true;
    return;
  }
  S.reroutes++;
  const dl = next.latencyMin - old.latencyMin;
  const delta = `${dl >= 0 ? "+" : "−"}${Math.abs(dl).toFixed(1)} min`;
  const backup = same(next, S.alt) ? " (pre-computed backup)" : "";
  if (broken && deadNow) {
    S.forced++; S.lastForced = now;
    log("jam", `${blame(old.nodes)}; rerouted via ${via(next)}${backup}, ${delta}`, "FORCED");
  } else if (broken) {
    S.proactive++;
    log("pro", `${blame(old.nodes)}; moved traffic early via ${via(next)}${backup}, ${delta}`, "PROACTIVE");
  } else {
    S.proactive++;
    log("pro", `Orbits shifted: ${S.mode === "throughput" ? `wider path (${next.capacityMbps.toFixed(1)} Mbps)` : "better path"} via ${via(next)}, ${delta}`, "PROACTIVE");
  }
}

// ---------- packets ----------
function nextHop(at) {
  const i = S.route ? S.route.nodes.indexOf(at) : -1;
  if (i >= 0 && i < S.route.nodes.length - 1) return S.route.nodes[i + 1];
  const p = bestPath(S.links, at, S.dst, S.mode);
  return p ? p.nodes[1] : null;
}

function deliver(k) {
  const M = S.data.time.length, i0 = k * S.ppp, i1 = Math.min(M, i0 + S.ppp);
  for (let i = i0; i < i1; i++) if (!S.got[i]) { S.got[i] = 1; S.received++; }
  S.delivered++;
  S.det.dirty = true; S.lcDirty = true;
  if (S.received === M && !S.allIn) { S.allIn = true; log("ok", `All ${M.toLocaleString()} points received on Earth`, "DATA"); }
}

function movePackets(dtH) {
  S.emitH += dtH;
  while (S.emitH >= EMIT_H && S.produced < N_PACKETS) { S.queue.push(S.produced++); S.emitH -= EMIT_H; }
  S.launchH += dtH;
  while (S.route && S.queue.length && S.launchH >= LAUNCH_GAP_H) {
    S.launchH -= LAUNCH_GAP_H;
    S.packets.push({ k: S.queue.shift(), at: S.src, to: S.route.nodes[1], d: S.launchH * PACKET_AU_PER_H, wait: false });
  }
  if (!S.route || !S.queue.length) S.launchH = Math.min(S.launchH, LAUNCH_GAP_H);

  for (const p of S.packets) {
    let left = PACKET_AU_PER_H * dtH;
    while (left > 0 && !p.done) {
      if (p.wait) { const nx = nextHop(p.at); if (!nx) break; p.to = nx; p.wait = false; p.d = 0; }
      const A = S.pos.get(p.at), B = S.pos.get(p.to), len = Math.hypot(B.x - A.x, B.y - A.y);
      if (p.d + left < len) { p.d += left; break; }
      left -= len - p.d;
      p.at = p.to; p.d = 0;
      if (p.at === S.dst) { deliver(p.k); p.done = true; break; }
      const nx = nextHop(p.at); // relays re-plan every hop, so packets follow reroutes
      if (nx) p.to = nx; else p.wait = true;
    }
  }
  S.packets = S.packets.filter((p) => !p.done);
}

// ---------- detection ----------
function maybeDetect(now) {
  const D = S.det;
  if (D.busy || !D.dirty || now - D.last < DETECT_EVERY_MS || S.received < 60) return;
  D.busy = true; D.dirty = false; D.last = now;
  const { time, flux } = S.data, t = [], f = [];
  for (let i = 0; i < time.length; i++) if (S.got[i]) { t.push(time[i]); f.push(flux[i]); }
  runDetect(t, f, S.data.starRadius ?? S.target.starRadius ?? null).then(({ r, v }) => {
    if (D !== S.det) return; // target switched or reset meanwhile
    D.busy = false;
    D.res = { r, v, t, f };
    drawDetection();
    if (v.verdict !== D.verdict) {
      D.verdict = v.verdict;
      log("detect", `${v.verdict}${r.best && v.verdict !== "NEED MORE DATA" ? ` at P = ${r.best.period.toFixed(4)} d` : ""} from ${t.length.toLocaleString()} points`, "DETECT");
    }
  });
}

function drawLightCurve() {
  const { time, flux } = S.data, xs = [], ys = [];
  for (let i = 0; i < time.length; i++) if (S.got[i]) { xs.push(time[i]); ys.push(flux[i]); }
  drawChart($("lc"), { ...S.lcBox, dots: [{ x: xs, y: ys, color: "rgba(127,209,255,.75)", size: 1.6 }],
    empty: xs.length ? "" : "Waiting for the first packets…" });
  const M = time.length;
  $("recvBar").style.width = `${(100 * S.received) / M}%`;
  setText($("recvText"), `received ${S.received.toLocaleString()} of ${M.toLocaleString()} points`);
}

function drawDetection() {
  const res = S.det.res, pub = S.target.publishedPeriod;
  if (!res || !res.r.best) {
    drawChart($("pg"), { x0: 0.3, x1: 15, y0: 0, y1: 1, logX: true, noY: true, empty: "no periodogram yet" });
    drawChart($("fold"), { x0: -6, x1: 6, y0: 0.99, y1: 1.01, noY: true, empty: "no transit yet" });
    renderVerdict(res ? res.v.verdict : "NEED MORE DATA", res ? "No transit-like dip found yet." : "Waiting for packets from the Observatory…", res ? res.v.checks : []);
    return;
  }
  const { r, v, t, f } = res, b = r.best;
  let pmax = 0;
  for (const p of r.power) if (p > pmax) pmax = p;
  const pubIn = pub >= r.periods[0] && pub <= r.periods[r.periods.length - 1];
  drawChart($("pg"), {
    x0: r.periods[0], x1: r.periods[r.periods.length - 1], y0: 0, y1: pmax * 1.12 || 1, logX: true, noY: true,
    lines: [{ x: r.periods, y: r.power, color: C.accent, width: 1 }],
    marks: [{ x: b.period, color: C.accent, label: `${b.period.toFixed(3)} d` },
      ...(pubIn ? [{ x: pub, color: C.amber, dash: [3, 3], label: "NASA", row: 1 }] : [])],
  });
  const ph = fold(t, f, b.period, b.t0).phase, W = Math.min(b.period / 2, Math.max(3 * b.duration, 0.12));
  const xs = [], ys = [], NB = 40, sum = new Float64Array(NB), cnt = new Float64Array(NB);
  for (let i = 0; i < ph.length; i++) {
    if (Math.abs(ph[i]) >= W) continue;
    xs.push(ph[i] * 24); ys.push(f[i]);
    const k = Math.min(NB - 1, Math.floor(((ph[i] + W) / (2 * W)) * NB)); sum[k] += f[i]; cnt[k]++;
  }
  const bx = [], by = [];
  for (let k = 0; k < NB; k++) if (cnt[k]) { bx.push((-W + ((k + 0.5) * 2 * W) / NB) * 24); by.push(sum[k] / cnt[k]); }
  const sorted = [...ys].sort((p, q) => p - q), lo = sorted[Math.floor(sorted.length * 0.002)] ?? 0.99, hi = sorted[Math.floor(sorted.length * 0.998)] ?? 1.01, pad = (hi - lo) * 0.12 || 0.001;
  drawChart($("fold"), { x0: -W * 24, x1: W * 24, y0: lo - pad, y1: hi + pad, noY: true, xFmt: (x) => `${x.toFixed(0)}h`,
    dots: [{ x: xs, y: ys, color: "rgba(139,149,167,.55)", size: 1.5 }], lines: [{ x: bx, y: by, color: C.accent, width: 1.8 }] });
  const err = (100 * Math.abs(b.period - pub)) / pub;
  renderVerdict(v.verdict,
    `P = ${b.period.toFixed(4)} d · NASA ${pub.toFixed(4)} d (Δ ${err.toFixed(2)}%) · depth ${(b.depth * 1e6).toFixed(0)} ppm` +
      (v.radiusEarth != null ? ` · Radius ${v.radiusEarth.toFixed(1)} R⊕${v.radiusAssumed ? " (assumed Sun-sized star)" : ""}` : ""),
    v.checks);
}

// ---------- lifecycle ----------
function reset() {
  S.world = sim.createWorld("default");
  S.prev = null; S.dtDays = 0; S.snap = null;
  S.route = S.alt = null; S.hadRoute = false;
  S.reroutes = S.forced = S.proactive = 0; S.lastForced = -1e9;
  S.packets = []; S.queue = []; S.produced = 0; S.emitH = 0; S.launchH = LAUNCH_GAP_H;
  const M = S.data.time.length;
  S.got = new Uint8Array(M); S.received = 0; S.delivered = 0; S.ppp = Math.ceil(M / N_PACKETS); S.allIn = false;
  let y0 = Infinity, y1 = -Infinity;
  for (const v of S.data.flux) { if (v < y0) y0 = v; if (v > y1) y1 = v; }
  const pad = (y1 - y0) * 0.08;
  S.lcBox = { x0: S.data.time[0], x1: S.data.time[M - 1], y0: y0 - pad, y1: y1 + pad };
  S.det = { busy: false, dirty: false, last: 0, res: null, verdict: null };
  S.labels = new Map(); S.counts = { asteroid: 0, comet: 0 };
  S.demoT = 0; S.demoStep = 0;
  $("log").innerHTML = "";
  setText($("targetMeta"), `${S.target.mission} · ${KIND_TEXT[S.target.kind] ?? S.target.kind}`);
  log("info", `Observatory streaming ${S.target.target} (${S.target.mission}, real NASA photometry) to Earth in ${N_PACKETS} packets`, "START");
  tick(0, performance.now());
  drawLightCurve(); drawDetection();
}

async function loadTarget(slug) {
  const entry = S.index.find((e) => e.slug === slug);
  try {
    const res = await fetch(`data/${slug}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.data = await res.json();
  } catch (e) { log("down", `Could not load ${slug}: ${e.message}`); return; }
  S.target = entry;
  setText($("pickerLabel"), entry.target);
  setText($("pickerSub"), `${entry.mission} · ${entry.points.toLocaleString()} pts`);
  for (const b of $("pickerMenu").children) b.classList.toggle("sel", b.dataset.slug === slug);
  reset();
}

function tick(dtH, now) {
  if (dtH > 0) { S.prev = S.snap; sim.step(S.world, dtH); S.dtDays = dtH / 24; }
  S.snap = sim.snapshot(S.world);
  S.pos = new Map(S.snap.nodes.map((n) => [n.id, n]));
  S.src = S.snap.nodes.find((n) => n.kind === "observatory").id;
  S.dst = S.snap.nodes.find((n) => n.kind === "earth").id;
  labelDebris();
  updateRoute(now);
  movePackets(dtH);
}

// ?demo=1 story: swarm on the best path at ~10 s, comet across the backup at ~25 s.
function dropOn(route, kind) {
  let best = null;
  for (let i = 1; i < route.nodes.length; i++) {
    const A = S.pos.get(route.nodes[i - 1]), B = S.pos.get(route.nodes[i]), d = Math.hypot(B.x - A.x, B.y - A.y);
    if (!best || d > best.d) best = { d, x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  }
  sim.addDebris(S.world, best.x, best.y, kind);
}
let captionTimer = 0;
function caption(text) {
  const el = $("caption");
  el.textContent = text; el.hidden = false;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { el.hidden = true; }, 6500);
}
function demoStory(wallDt) {
  S.demoT += wallDt;
  if (S.demoStep === 0 && S.demoT > 1) { caption(`Streaming ${S.target.target}'s light curve from the Observatory to Earth`); S.demoStep = 1; }
  if (S.demoStep === 1 && S.demoT > 10 && S.route) {
    dropOn(S.route, "asteroid"); log("warn", "Asteroid swarm dropped on the best path", "DEMO");
    caption("An asteroid swarm drifts onto the best path…"); S.demoStep = 2;
  }
  if (S.demoStep === 2 && S.demoT > 25) {
    dropOn(S.alt || S.route, "comet"); log("warn", `Comet launched across the ${S.alt ? "backup" : "best"} path`, "DEMO");
    caption("A comet cuts across the backup path…"); S.demoStep = 3;
  }
  if (S.demoStep === 3 && S.allIn && S.det.res && !S.det.dirty && !S.det.busy) {
    caption(`Every packet delivered. Verdict: ${S.det.res.v.verdict}`); S.demoStep = 4;
  }
}

// ---------- frame ----------
let lastFrame = performance.now(), lcLast = 0;
function frame(now) {
  const wallDt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (S.data) {
    tick(S.playing ? wallDt * S.speed * HOURS_PER_SEC : 0, now);
    if (S.demo && S.playing) demoStory(wallDt);
    maybeDetect(now);
    render(now);
    if (S.lcDirty && now - lcLast > 200) { S.lcDirty = false; lcLast = now; drawLightCurve(); }
  }
  requestAnimationFrame(frame);
}

function render(now) {
  const waiting = new Map();
  if (S.queue.length) waiting.set(S.src, S.queue.length);
  const packets = [];
  for (const p of S.packets) {
    if (p.wait) { waiting.set(p.at, (waiting.get(p.at) || 0) + 1); continue; }
    const A = S.pos.get(p.at), B = S.pos.get(p.to), len = Math.hypot(B.x - A.x, B.y - A.y) || 1, u = Math.min(1, p.d / len);
    packets.push({ x: A.x + (B.x - A.x) * u, y: A.y + (B.y - A.y) * u });
  }
  const shortLabels = new Map([...S.labels].map(([id, l]) => [id, l.short]));
  S.view = drawMap($("map"), { snap: S.snap, links: S.links, route: S.route, alt: S.alt, packets, waiting,
    labels: shortLabels, ghost: S.tool && S.ghost ? { ...S.ghost, r: GHOST_R[S.tool] } : null, t: now / 1000 });

  setText($("clock"), `${stamp()} · ${S.playing ? `${S.speed}x` : "paused"}`);
  const r = S.route;
  setText($("latency"), r ? r.latencyMin.toFixed(1) : "—");
  setText($("capacity"), r ? r.capacityMbps.toFixed(1) : "—");
  setText($("hops"), r ? String(r.nodes.length - 1) : "—");
  setText($("snr"), r ? r.minSnrDb.toFixed(1) : "—");
  setText($("reroutes"), String(S.reroutes));
  setText($("rerouteSplit"), `${S.proactive} proactive · ${S.forced} forced`);
  const pill = $("pill"), st = !r ? "down" : now - S.lastForced < REROUTED_MS ? "re" : "up";
  pill.className = `pill ${st}`;
  setText(pill, st === "down" ? "LINK DOWN – buffering" : st === "re" ? "REROUTED" : "LINK UP");
  setText($("path"), r ? pathText(r) : "No path from the Observatory to Earth");
  setText($("alt"), S.alt ? `Backup: ${pathText(S.alt)} · ${S.alt.latencyMin.toFixed(1)} min${S.alt.independent ? " · independent" : " · shares a relay"}` : "Backup: none available");
  setText($("buffered"), String(buffered()));
  setText($("inflight"), String(packets.length));
  setText($("delivered"), `${S.delivered}/${N_PACKETS}`);
}

// ---------- controls ----------
function setSpeed(x) { S.speed = x; for (const b of $("speed").children) b.classList.toggle("on", +b.dataset.speed === x); }
function setPlaying(p) {
  S.playing = p;
  $("play").classList.toggle("on", p);
  $("play").innerHTML = p ? '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9.5" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4.5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.4 2.7a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>';
  $("play").title = p ? "Pause (Space)" : "Play (Space)";
}
function setTool(t) {
  S.tool = S.tool === t ? null : t;
  for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === S.tool);
  $("mapPanel").classList.toggle("armed", !!S.tool);
  $("hint").hidden = !S.tool;
  if (S.tool) $("hint").textContent = `Click the map to ${S.tool === "comet" ? "launch a comet" : "drop an asteroid swarm"} · Esc cancels`;
}
function toAU(e) {
  const rect = $("map").getBoundingClientRect(), v = S.view;
  return { x: (e.clientX - rect.left - v.cx) / v.s, y: -(e.clientY - rect.top - v.cy) / v.s };
}

function buildPicker() {
  $("pickerMenu").innerHTML = S.index.map((e) => `<button type="button" role="option" data-slug="${esc(e.slug)}">
    <span><b>${esc(e.target)}</b><small>${esc(e.mission)} · P ${e.publishedPeriod.toFixed(3)} d · ${e.points.toLocaleString()} pts</small></span>
    <span class="kind ${esc(e.kind)}">${esc(KIND_TEXT[e.kind] ?? e.kind)}</span></button>`).join("");
  const open = (o) => { $("pickerMenu").hidden = !o; $("pickerBtn").setAttribute("aria-expanded", String(o)); };
  $("pickerBtn").onclick = (e) => { e.stopPropagation(); open($("pickerMenu").hidden); };
  $("pickerMenu").onclick = (e) => { const b = e.target.closest("[data-slug]"); if (b) { open(false); loadTarget(b.dataset.slug); } };
  document.addEventListener("click", (e) => { if (!e.target.closest("#picker")) open(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") open(false); });
}

function wire() {
  $("play").onclick = () => setPlaying(!S.playing);
  $("speed").onclick = (e) => { const b = e.target.closest("[data-speed]"); if (b) setSpeed(+b.dataset.speed); };
  for (const b of document.querySelectorAll("[data-tool]")) b.onclick = () => setTool(b.dataset.tool);
  $("reset").onclick = () => { if (S.data) reset(); };
  $("mode").onclick = (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || b.dataset.mode === S.mode) return;
    S.mode = b.dataset.mode;
    for (const x of $("mode").children) x.classList.toggle("on", x === b);
    S.route = bestPath(S.links, S.src, S.dst, S.mode); S.alt = null;
    log("info", `Routing mode: ${MODE_TEXT[S.mode]}${S.route ? `; route ${pathText(S.route)}` : ""}`, "MODE");
  };
  $("predictive").onchange = (e) => {
    S.predictive = e.target.checked;
    log("info", `Predictive routing ${S.predictive ? `on: links forecast to jam within ${AHEAD_DAYS} d are avoided now` : "off: reroute only when a link fails"}`, "MODE");
  };
  const map = $("map");
  map.addEventListener("mousemove", (e) => { if (S.tool && S.view) S.ghost = toAU(e); });
  map.addEventListener("mouseleave", () => { S.ghost = null; });
  map.addEventListener("click", (e) => {
    if (!S.tool || !S.view || !S.world) return;
    const { x, y } = toAU(e);
    sim.addDebris(S.world, x, y, S.tool);
    log("warn", `${S.tool === "comet" ? "Comet launched" : "Asteroid swarm dropped"} at ${Math.hypot(x, y).toFixed(2)} AU from the Sun`, "USER");
    setTool(S.tool);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.tool) setTool(S.tool);
    if (e.code === "Space" && !e.target.closest("button, input")) { e.preventDefault(); setPlaying(!S.playing); }
  });
  new ResizeObserver(() => { if (S.data) { S.lcDirty = true; drawDetection(); } }).observe($("side"));
}

wire();
setPlaying(true);
setSpeed(4);
try {
  S.index = await (await fetch("data/index.json")).json();
  buildPicker();
  await loadTarget(S.index[0].slug);
} catch (e) { log("down", `Could not load data/index.json: ${e.message}`); }
requestAnimationFrame(frame);
