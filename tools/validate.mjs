#!/usr/bin/env node
// Headless validation: sim delivery stats + BLS period recovery.
// Writes results/validation.csv.
import { createWorld, step, snapshot, attenuationDb } from "../web/js/sim.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// --- Router stub until router.js is on main ---
let bestPath, buildLinks;
try {
  ({ bestPath, buildLinks } = await import("../web/js/router.js"));
} catch {
  buildLinks = () => [];
  bestPath = () => null;
}

// --- BLS detect stub until detect.js is on main ---
let bls;
try {
  ({ bls } = await import("../web/js/detect.js"));
} catch {
  bls = () => ({ best: null });
}

// ---- Sim delivery stats ----
async function deliveryStats(scenario, steps) {
  const SIM_DT = 1; // hours per step
  const SRC = "Observatory";
  const DST = "earth";

  const world = createWorld(scenario);
  let snap = snapshot(world);

  const srcId = snap.nodes.find(n => n.kind === "observatory")?.id ?? SRC;
  const dstId = snap.nodes.find(n => n.kind === "earth")?.id ?? DST;

  // Fixed route: compute once at t=0.
  const linksT0 = buildLinks(snap, (s, a, b) => attenuationDb(s, a, b));
  const fixedRoute = bestPath(linksT0, srcId, dstId);
  const fixedNodes = fixedRoute ? new Set(fixedRoute.nodes) : null;

  let deliveredLive = 0, deliveredFixed = 0;

  for (let i = 0; i < steps; i++) {
    step(world, SIM_DT);
    snap = snapshot(world);

    const links = buildLinks(snap, (s, a, b) => attenuationDb(s, a, b));

    // Live rerouting: best path each step.
    const live = bestPath(links, srcId, dstId);
    if (live) deliveredLive++;

    // Fixed route: check if all its links are still unblocked.
    if (fixedRoute) {
      const fixedOk = fixedRoute.nodes.length >= 2 && fixedRoute.nodes.every((nid, idx) => {
        if (idx === 0) return true;
        const a = fixedRoute.nodes[idx - 1], b = nid;
        const lnk = links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
        return lnk && !lnk.blocked;
      });
      if (fixedOk) deliveredFixed++;
    }
  }

  const pct = n => ((n / steps) * 100).toFixed(1);
  return { scenario, steps, deliveredLive, deliveredFixed,
    livePercent: pct(deliveredLive), fixedPercent: pct(deliveredFixed) };
}

// ---- BLS period recovery ----
async function blsStats() {
  const indexPath = join(ROOT, "web", "data", "index.json");
  if (!existsSync(indexPath)) return [];

  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const rows = [];

  for (const entry of index) {
    const dataPath = join(ROOT, "web", "data", `${entry.slug}.json`);
    if (!existsSync(dataPath)) { rows.push({ ...entry, recovered: "miss", note: "file missing" }); continue; }

    const data = JSON.parse(await readFile(dataPath, "utf8"));
    const { time, flux, publishedPeriod: pub } = { ...entry, ...data };

    let result = { best: null };
    try { result = bls(time, flux); } catch { /* stub throws */ }

    if (!result.best) {
      rows.push({ slug: entry.slug, target: entry.target, publishedPeriod: entry.publishedPeriod,
        recoveredPeriod: "N/A", status: "miss", note: "no signal (stub or data)" });
      continue;
    }

    const p = result.best.period;
    const tol = 0.01;
    let status = "miss";
    let note = "";

    // Exact within 1%
    if (Math.abs(p - entry.publishedPeriod) / entry.publishedPeriod <= tol) {
      status = "exact"; note = `within 1% (${p.toFixed(5)} vs ${entry.publishedPeriod})`;
    }
    // Harmonics 0.5x, 2x, 3x
    for (const h of [0.5, 2, 3]) {
      const harmonic = entry.publishedPeriod * h;
      if (Math.abs(p - harmonic) / harmonic <= tol) {
        status = "harmonic"; note = `harmonic ${h}x (${p.toFixed(5)} vs ${harmonic.toFixed(5)})`;
        break;
      }
    }
    if (status === "miss") note = `recovered ${p.toFixed(5)}, published ${entry.publishedPeriod}`;

    rows.push({ slug: entry.slug, target: entry.target,
      publishedPeriod: entry.publishedPeriod, recoveredPeriod: p, status, note });
  }

  return rows;
}

// ---- Main ----
const STEPS = 500;

const [statsDefault, statsStorm] = await Promise.all([
  deliveryStats("default", STEPS),
  deliveryStats("storm", STEPS),
]);

console.log(`\nDelivered with rerouting ${statsDefault.livePercent}% vs fixed route ${statsDefault.fixedPercent}% (scenario default)`);
console.log(`Delivered with rerouting ${statsStorm.livePercent}% vs fixed route ${statsStorm.fixedPercent}% (scenario storm)`);

const blsRows = await blsStats();

let blsA = 0, blsB = blsRows.length;
for (const r of blsRows) {
  if (r.status === "exact" || r.status === "harmonic") blsA++;
  else console.log(`  MISS: ${r.target} — ${r.note}`);
}
if (blsB > 0) console.log(`\nBLS recovered ${blsA}/${blsB} periods`);

// Write CSV.
const resultsDir = join(ROOT, "results");
await mkdir(resultsDir, { recursive: true });

const csvRows = [
  "type,scenario,metric,value",
  `delivery,default,live_percent,${statsDefault.livePercent}`,
  `delivery,default,fixed_percent,${statsDefault.fixedPercent}`,
  `delivery,storm,live_percent,${statsStorm.livePercent}`,
  `delivery,storm,fixed_percent,${statsStorm.fixedPercent}`,
  ...blsRows.map(r =>
    `bls,${r.slug ?? ""},${r.status ?? "miss"},${r.recoveredPeriod ?? "N/A"}`
  ),
];
await writeFile(join(resultsDir, "validation.csv"), csvRows.join("\n") + "\n", "utf8");
console.log("\nWrote results/validation.csv");
