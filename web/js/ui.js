// Canvas drawing helpers (network map + small charts) and DOM renderers. Owner: Ayush.
// No chart library: plain Canvas 2D.
import { DEFAULTS } from "./router.js";

export const C = {
  bg: "#05070D", panel: "#0B1020", line: "#1C2540", text: "#E6EDF3", muted: "#8B95A7",
  accent: "#7FD1FF", amber: "#FFB547", red: "#FF6B6B", green: "#69D39A",
};
const MONO = '10px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const $ = (id) => document.getElementById(id);
export function setText(el, v) { if (el.textContent !== v) el.textContent = v; }

// Size a canvas to its CSS box at device pixel ratio; returns a context in CSS pixels.
export function fit(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const RGB = { red: [255, 107, 107], amber: [255, 181, 71], green: [105, 211, 154] };
// Link colour by SNR: red at the 6 dB threshold -> amber -> green at 26 dB and above.
function snrColor(snr, a) {
  const t = Math.max(0, Math.min(1, (snr - DEFAULTS.thresholdDb) / 20));
  const [p, q, u] = t < 0.5 ? [RGB.red, RGB.amber, t * 2] : [RGB.amber, RGB.green, t * 2 - 1];
  const c = p.map((v, i) => Math.round(v + (q[i] - v) * u));
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

// Zoom to the sun + every node (padding leaves room for labels, header and legend); eased so the
// view glides as the planets move instead of jumping.
let cam = null;
function camera(nodes, w, h) {
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (const n of nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
  const pl = 90, pr = 110, pt = 64, pb = 78;
  const s = Math.min((w - pl - pr) / (x1 - x0 || 1), (h - pt - pb) / (y1 - y0 || 1));
  const t = { s, cx: pl + (w - pl - pr) / 2 - ((x0 + x1) / 2) * s, cy: pt + (h - pt - pb) / 2 + ((y0 + y1) / 2) * s };
  if (!cam || cam.w !== w || cam.h !== h) cam = { ...t, w, h };
  else for (const k of ["s", "cx", "cy"]) cam[k] += (t[k] - cam[k]) * 0.04;
  return cam;
}

let stars = null;
function starfield(w, h) {
  if (stars && stars.w === w && stars.h === h) return stars.cv;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < (w * h) / 2600; i++) {
    const a = 0.15 + rnd() * 0.5;
    ctx.fillStyle = `rgba(${200 + rnd() * 55 | 0},${215 + rnd() * 40 | 0},255,${a})`;
    ctx.fillRect(rnd() * w, rnd() * h, rnd() < 0.08 ? 1.6 : 1, rnd() < 0.08 ? 1.6 : 1);
  }
  stars = { w, h, cv };
  return cv;
}

const labelSpot = new Map();

function trace(ctx, ids, P) {
  ctx.beginPath();
  ids.forEach((id, i) => { const [x, y] = P(id); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
}

function badge(ctx, x, y, text, color) {
  ctx.font = `600 10.5px ${SANS}`;
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = "rgba(11,16,32,.92)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y - 9, w, 18, 9) : ctx.rect(x, y - 9, w, 18);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(text, x + 6, y + 0.5);
}

// v: { snap, links, route, alt, packets:[{x,y}], waiting: Map(nodeId -> n), labels: Map(debrisId -> short),
//      ghost: {x, y, r} | null, t: seconds }. Returns the view transform for click mapping.
export function drawMap(cv, v) {
  const { ctx, w, h } = fit(cv);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(starfield(w, h), 0, 0, w, h);
  const { snap } = v;
  const { s, cx, cy } = camera(snap.nodes, w, h);
  const toPx = (x, y) => [cx + x * s, cy - y * s];
  const pos = new Map(snap.nodes.map((n) => [n.id, n]));
  const P = (id) => { const n = pos.get(id); return toPx(n.x, n.y); };

  // orbits
  const radii = [...new Set(snap.nodes.map((n) => Math.hypot(n.x, n.y).toFixed(3)))];
  for (const r of radii) {
    const kind = snap.nodes.find((n) => Math.hypot(n.x, n.y).toFixed(3) === r).kind;
    ctx.beginPath();
    ctx.arc(cx, cy, +r * s, 0, Math.PI * 2);
    ctx.strokeStyle = kind === "earth" ? "rgba(127,209,255,.16)" : "rgba(139,149,167,.10)";
    ctx.setLineDash(kind === "observatory" ? [3, 5] : []);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // sun
  const sun = ctx.createRadialGradient(cx, cy, 0, cx, cy, 26);
  sun.addColorStop(0, "rgba(255,226,160,.95)");
  sun.addColorStop(0.25, "rgba(255,190,90,.35)");
  sun.addColorStop(1, "rgba(255,170,60,0)");
  ctx.fillStyle = sun;
  ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#FFE2A8";
  ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, Math.PI * 2); ctx.fill();

  // jamming halos
  for (const d of snap.debris) {
    const [x, y] = toPx(d.x, d.y), rp = d.r * s;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rp);
    g.addColorStop(0, "rgba(255,107,107,.34)");
    g.addColorStop(0.35, "rgba(255,107,107,.16)");
    g.addColorStop(1, "rgba(255,107,107,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rp, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,107,107,.28)";
    ctx.setLineDash([2, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // links: usable ones faint by SNR; jammed-now and forecast-jammed ones as dotted red
  ctx.lineWidth = 1;
  for (const l of v.links) {
    const [ax, ay] = P(l.a), [bx, by] = P(l.b);
    if (!l.blocked) ctx.strokeStyle = snrColor(l.snrDb, 0.26);
    else if (l.forecastBlocked) { ctx.strokeStyle = "rgba(255,107,107,.55)"; ctx.setLineDash([1.5, 4]); }
    else if (l.jammingDb > 0 && l.distAU <= DEFAULTS.maxRangeAU && l.snrDb + l.jammingDb >= DEFAULTS.thresholdDb) {
      ctx.strokeStyle = "rgba(255,107,107,.35)"; ctx.setLineDash([4, 5]);
    } else continue;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
  }

  // alternate path: dashed amber, marching
  if (v.alt) {
    trace(ctx, v.alt.nodes, P);
    ctx.strokeStyle = "rgba(255,181,71,.9)";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = -v.t * 18;
    ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
  }
  // best path: thick cyan with glow
  if (v.route) {
    trace(ctx, v.route.nodes, P);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(127,209,255,.16)"; ctx.lineWidth = 10; ctx.stroke();
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2.8; ctx.stroke();
  }

  // debris particles (offsets come from the sim), comet tails point away from the sun
  for (const d of snap.debris) {
    const [x, y] = toPx(d.x, d.y);
    if (d.kind === "comet") {
      const R0 = Math.hypot(d.x, d.y) || 1, ux = d.x / R0, uy = -d.y / R0, L = Math.max(36, d.r * s * 3.2);
      const tg = ctx.createLinearGradient(x, y, x + ux * L, y + uy * L);
      tg.addColorStop(0, "rgba(190,235,255,.55)"); tg.addColorStop(1, "rgba(190,235,255,0)");
      ctx.fillStyle = tg;
      ctx.beginPath();
      ctx.moveTo(x - uy * 5, y + ux * 5); ctx.lineTo(x + ux * L - uy * 14, y + uy * L + ux * 14);
      ctx.lineTo(x + ux * L + uy * 14, y + uy * L - ux * 14); ctx.lineTo(x + uy * 5, y - ux * 5);
      ctx.fill();
    }
    const parts = d.particles || [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i], tw = 0.55 + 0.45 * Math.sin(v.t * 1.7 + i * 2.3);
      ctx.fillStyle = d.kind === "comet" ? `rgba(200,236,255,${0.5 + 0.4 * tw})` : `rgba(${196 - (i % 3) * 18},${178 - (i % 3) * 14},${160 - (i % 3) * 8},${0.55 + 0.35 * tw})`;
      const z = 1.1 + (i % 4) * 0.45;
      ctx.fillRect(x + p.dx * s - z / 2, y - p.dy * s - z / 2, z, z);
    }
    if (d.kind === "comet") {
      ctx.shadowColor = C.accent; ctx.shadowBlur = 12;
      ctx.fillStyle = "#F2FBFF";
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.font = MONO; ctx.fillStyle = "rgba(255,140,140,.9)";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(v.labels.get(d.id) || d.id, x, y - d.r * s - 3);
  }

  // packets
  ctx.shadowColor = C.accent; ctx.shadowBlur = 9; ctx.fillStyle = "#E4F7FF";
  for (const p of v.packets) {
    const [x, y] = toPx(p.x, p.y);
    ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0;

  // nodes + labels
  const onBest = new Set(v.route ? v.route.nodes : []), onAlt = new Set(v.alt ? v.alt.nodes : []);
  for (const n of snap.nodes) {
    const [x, y] = toPx(n.x, n.y);
    if (n.kind === "earth") {
      const g = ctx.createRadialGradient(x - 2, y - 2, 0, x, y, 7);
      g.addColorStop(0, "#9FD8FF"); g.addColorStop(1, "#2F6FD6");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(105,211,154,.85)"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
    } else if (n.kind === "observatory") {
      const pulse = (v.t * 0.8) % 1;
      ctx.strokeStyle = `rgba(127,209,255,${0.5 * (1 - pulse)})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 9 + pulse * 14, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = C.panel; ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.accent;
      ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
    } else {
      const k = 5;
      ctx.fillStyle = onBest.has(n.id) ? "rgba(127,209,255,.3)" : onAlt.has(n.id) ? "rgba(255,181,71,.25)" : C.panel;
      ctx.strokeStyle = onBest.has(n.id) ? C.accent : onAlt.has(n.id) ? C.amber : "#B9C4D6";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y - k); ctx.lineTo(x + k, y); ctx.lineTo(x, y + k); ctx.lineTo(x - k, y); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
  }
  // labels: first free spot among 8 around the node (sticky per node, so they don't flicker)
  const boxes = snap.nodes.map((n) => { const [x, y] = toPx(n.x, n.y); return [x - 8, y - 8, x + 8, y + 8]; });
  const hit = (r) => r[0] < 4 || r[2] > w - 4 || r[1] < 40 || boxes.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
  const order = [...snap.nodes].sort((a, b) => (b.kind !== "relay") - (a.kind !== "relay") || onBest.has(b.id) - onBest.has(a.id));
  for (const n of order) {
    const [x, y] = toPx(n.x, n.y);
    ctx.font = `${n.kind === "relay" ? 500 : 600} ${n.kind === "relay" ? 10.5 : 11.5}px ${SANS}`;
    const tw = ctx.measureText(n.name).width, th = 13;
    const spots = [[12, -th / 2], [-12 - tw, -th / 2], [-tw / 2, -13 - th], [-tw / 2, 12], [9, -th - 7], [9, 7], [-9 - tw, -th - 7], [-9 - tw, 7]];
    const prev = labelSpot.get(n.id) ?? 0;
    let k = [prev, ...spots.keys()].find((i) => { const [dx, dy] = spots[i]; return !hit([x + dx, y + dy, x + dx + tw, y + dy + th]); });
    if (k === undefined) k = prev;
    labelSpot.set(n.id, k);
    const [dx, dy] = spots[k];
    boxes.push([x + dx, y + dy, x + dx + tw, y + dy + th]);
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = n.kind === "relay" ? (onBest.has(n.id) ? "#CFEFFF" : "rgba(170,181,199,.85)") : C.text;
    ctx.fillText(n.name, x + dx, y + dy + 1);
    const wait = v.waiting.get(n.id);
    if (wait) badge(ctx, x - 20, y + (dy < 0 ? 22 : -22), n.kind === "observatory" ? `${wait} buffered` : `${wait} waiting`, C.amber);
  }

  // tool preview
  if (v.ghost) {
    const [x, y] = toPx(v.ghost.x, v.ghost.y);
    ctx.strokeStyle = "rgba(255,107,107,.8)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(x, y, v.ghost.r * s, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
  }

  // scale bar
  const bx = w - 24 - s, by = h - 22;
  ctx.strokeStyle = "rgba(139,149,167,.7)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + s, by); ctx.lineTo(bx + s, by - 4); ctx.stroke();
  ctx.font = MONO; ctx.fillStyle = C.muted; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText("1 AU", bx + s / 2, by - 4);
  return { s, cx, cy };
}

// ---------- charts ----------
function niceTicks(a, b, n) {
  const span = b - a;
  if (!(span > 0)) return { ticks: [a], dec: 2 };
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const ticks = [];
  for (let t = Math.ceil(a / step) * step; t <= b + step * 1e-9; t += step) ticks.push(t);
  return { ticks, dec: Math.max(0, -Math.floor(Math.log10(step))) };
}

// o: { x0, x1, y0, y1, logX, noY, xFmt, dots:[{x, y, color, size}], lines:[{x, y, color, width}],
//      marks:[{x, color, dash, label}], empty: "message" }
export function drawChart(cv, o) {
  const { ctx, w, h } = fit(cv);
  ctx.clearRect(0, 0, w, h);
  const L = o.noY ? 8 : 42, Rm = 8, T = 6, B = 17;
  const pw = w - L - Rm, ph = h - T - B;
  const fx = (x) => (o.logX ? Math.log(x) : x);
  const X0 = fx(o.x0), X1 = fx(o.x1);
  const X = (x) => L + ((fx(x) - X0) / (X1 - X0 || 1)) * pw;
  const Y = (y) => T + (1 - (y - o.y0) / (o.y1 - o.y0 || 1)) * ph;

  ctx.font = MONO; ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(28,37,64,.9)";
  ctx.strokeRect(L + 0.5, T + 0.5, pw, ph);
  const xt = o.logX ? { ticks: [0.3, 0.5, 1, 2, 3, 5, 10, 20].filter((t) => t >= o.x0 && t <= o.x1), dec: 1 } : niceTicks(o.x0, o.x1, Math.max(3, Math.floor(pw / 60)));
  ctx.fillStyle = C.muted; ctx.textAlign = "center"; ctx.textBaseline = "top";
  let lastX = -1e9;
  for (const t of xt.ticks) {
    const x = Math.round(X(t)) + 0.5;
    if (x - lastX < 30) continue; // keep tick labels from colliding
    lastX = x;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
    ctx.fillText(o.xFmt ? o.xFmt(t) : o.logX ? String(t) : t.toFixed(xt.dec), x, T + ph + 4);
  }
  if (!o.noY) {
    const yt = niceTicks(o.y0, o.y1, Math.max(2, Math.floor(ph / 32)));
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const t of yt.ticks) {
      const y = Math.round(Y(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillText(t.toFixed(yt.dec), L - 5, y);
    }
  }
  if (o.empty) {
    ctx.fillStyle = "rgba(139,149,167,.8)"; ctx.font = `11px ${SANS}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(o.empty, L + pw / 2, T + ph / 2);
    return;
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  for (const d of o.dots || []) {
    ctx.fillStyle = d.color;
    const z = d.size || 1.5;
    for (let i = 0; i < d.x.length; i++) ctx.fillRect(X(d.x[i]) - z / 2, Y(d.y[i]) - z / 2, z, z);
  }
  for (const ln of o.lines || []) {
    ctx.beginPath();
    for (let i = 0; i < ln.x.length; i++) i ? ctx.lineTo(X(ln.x[i]), Y(ln.y[i])) : ctx.moveTo(X(ln.x[i]), Y(ln.y[i]));
    ctx.strokeStyle = ln.color; ctx.lineWidth = ln.width || 1.2; ctx.lineJoin = "round";
    ctx.stroke();
  }
  for (const m of o.marks || []) {
    const x = Math.round(X(m.x)) + 0.5;
    ctx.strokeStyle = m.color; ctx.lineWidth = 1; ctx.setLineDash(m.dash || []);
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
    ctx.setLineDash([]);
    if (m.label) {
      ctx.fillStyle = m.color; ctx.font = MONO; ctx.textBaseline = "top";
      const right = x > L + pw - 70;
      ctx.textAlign = right ? "right" : "left";
      ctx.fillText(m.label, x + (right ? -4 : 4), T + 3 + (m.row || 0) * 12);
    }
  }
  ctx.restore();
}

// ---------- DOM renderers ----------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

export function pushLog(when, kind, tag, msg) {
  const li = document.createElement("li");
  li.className = `${kind} new`;
  li.innerHTML = `<time>${esc(when)}</time><i></i><p>${tag ? `<em>${esc(tag)}</em>` : ""}${esc(msg)}</p>`;
  const ol = $("log");
  ol.prepend(li);
  while (ol.children.length > 60) ol.lastChild.remove();
}

const VERDICT_CLASS = {
  "PLANET CANDIDATE": "planet", "LIKELY FALSE POSITIVE": "fp", "NO CONVINCING SIGNAL": "weak", "NEED MORE DATA": "wait",
};
export function renderVerdict(verdict, sub, checks) {
  const card = $("verdict");
  card.className = `verdict ${VERDICT_CLASS[verdict] || "wait"}`;
  setText($("vWord"), verdict);
  setText($("vSub"), sub);
  $("checks").innerHTML = checks.length
    ? checks.map((c) => `<li><span class="${c.passed ? "ok" : "bad"}">${c.passed ? "✓" : "✕"}</span><b>${esc(c.name)}</b><span>${esc(c.detail)}</span></li>`).join("")
    : `<li class="none"><span></span><b></b><span>Vetting checks run as soon as enough points arrive.</span></li>`;
}
