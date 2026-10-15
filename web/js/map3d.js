// 3-D solar-system map — Three.js renderer.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const NODE_COLOR = { earth: 0x4fa3ff, observatory: 0xc9a7ff, relay: 0x7fb8d4 };
const NODE_R     = { earth: 0.095, observatory: 0.088, relay: 0.054 };
const NODE_GLOW  = { earth: 0.26,  observatory: 0.22,  relay: 0.16 };
const NODE_EMIT  = { earth: 1.2,   observatory: 1.4,   relay: 0.55 };
const Z_OFFSET   = { sun: 0, earth: 0.06, observatory: 0.14, relay: 0.04 };

// Camera orbit params
const CAM_R = 6.8, CAM_Y = 5.4, CAM_ORBIT_SPEED = 0.018; // rad/s

function auToWorld(n) {
  return new THREE.Vector3(n.x, Z_OFFSET[n.kind] ?? 0.04, -n.y);
}

function nodeColor(kind) { return new THREE.Color(NODE_COLOR[kind] ?? 0x7fb8d4); }

// Shared canvas textures (built once). A soft radial falloff for glows, coronae and jamming
// discs, and a linear fade for comet tails: smoother than stacked translucent spheres, which band.
let _glowTex = null, _tailTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return (_glowTex = new THREE.CanvasTexture(c));
}
function tailTexture() {
  if (_tailTex) return _tailTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  const along = g.createLinearGradient(0, 0, 256, 0);
  along.addColorStop(0, 'rgba(255,255,255,0.9)'); along.addColorStop(0.35, 'rgba(255,255,255,0.35)'); along.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = along; g.fillRect(0, 0, 256, 64);
  g.globalCompositeOperation = 'destination-in'; // taper across the tail
  const across = g.createLinearGradient(0, 0, 0, 64);
  across.addColorStop(0, 'rgba(0,0,0,0)'); across.addColorStop(0.5, 'rgba(0,0,0,1)'); across.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = across; g.fillRect(0, 0, 256, 64);
  return (_tailTex = new THREE.CanvasTexture(c));
}
function glowSprite(color, size, opacity) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  sp.scale.setScalar(size);
  sp.userData.size = size;
  return sp;
}

// Deterministic per-id random numbers, so a swarm keeps its shape from frame to frame.
function seeded(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Map3D {
  constructor(canvas) {
    this._canvas = canvas;
    this._debrisMeshes = [];
    this._packetMeshes = [];
    this._labelEls = [];
    this._mouse = new THREE.Vector2(0, 0);
    this._raycaster = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._orbitAngle = Math.PI * 0.55;
    this._userDrag = false;
    this._dragLast = null;
    this._pulseLine = null;
    this._pulseMarker = null;
    this._focus = new THREE.Vector3(0, 0, 0); // camera target: centre of the network
    this._extent = 4.6;                        // network radius around _focus (AU)
    this._reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

    this._initRenderer();
    this._initScene();
    this._initLabels();
    this._bindResize();
    this._bindDrag();
    this.renderer.setAnimationLoop(t => this._frame(t));
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x030508, 1);
    this.renderer.shadowMap.enabled = false;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x030508, 0.012);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 140);
    this._updateCamera();
  }

  _updateCamera() {
    const mx = this._mouse.x * 0.14, my = this._mouse.y * 0.07;
    this.camera.position.set(
      Math.sin(this._orbitAngle) * CAM_R + mx,
      CAM_Y + my,
      Math.cos(this._orbitAngle) * CAM_R
    );
    this.camera.lookAt(0, 0, 0);
  }

  _initScene() {
    this.scene.add(new THREE.AmbientLight(0x0a1830, 4));
    const sunLight = new THREE.PointLight(0xffd580, 4, 28, 1.4);
    sunLight.position.set(0, 0.3, 0);
    this.scene.add(sunLight);

    // Stars — 3 layers
    for (const [n, rMin, rMax, sz, col, op] of [
      [2400, 18, 55, 0.05,  0xeef8ff, 0.9],
      [700,  12, 18, 0.095, 0xc8e4ff, 0.8],
      [200,  9,  12, 0.14,  0xfff0e8, 0.7],
    ]) {
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = rMin + Math.random() * (rMax - rMin);
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
        pos[i*3+1] = r * Math.sin(ph) * Math.sin(th);
        pos[i*3+2] = r * Math.cos(ph);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: col, size: sz, sizeAttenuation: true, transparent: true, opacity: op })));
    }

    // Sun core + corona
    const sunGeo = new THREE.SphereGeometry(0.17, 28, 28);
    this._sunMesh = new THREE.Mesh(sunGeo,
      new THREE.MeshStandardMaterial({ color: 0xffe8a3, emissive: 0xffd060, emissiveIntensity: 4, roughness: 0.05 }));
    this.scene.add(this._sunMesh);
    this._sunHalos = [];
    for (const [size, op, col] of [[0.95, 0.9, 0xffd27a], [2.1, 0.45, 0xff9a3c], [4.2, 0.16, 0xff6a20]]) {
      const h = glowSprite(col, size, op);
      this.scene.add(h);
      this._sunHalos.push(h);
    }

    // Ecliptic grid
    this._buildGrid();

    this._staticGroup = new THREE.Group();
    this._dynamicGroup = new THREE.Group();
    this.scene.add(this._staticGroup, this._dynamicGroup);
  }

  _buildGrid() {
    const GRID_R = 4.2, RINGS = 8, SPOKES = 24;
    const pts = [];
    // Concentric rings
    for (let ri = 1; ri <= RINGS; ri++) {
      const r = (ri / RINGS) * GRID_R;
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push(Math.cos(a) * r, 0, Math.sin(a) * r);
        if (i > 0) pts.push(Math.cos(a) * r, 0, Math.sin(a) * r); // line segment pairs
      }
    }
    // Spokes
    for (let s = 0; s < SPOKES; s++) {
      const a = (s / SPOKES) * Math.PI * 2;
      pts.push(0, 0, 0, Math.cos(a) * GRID_R, 0, Math.sin(a) * GRID_R);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x0d2040, transparent: true, opacity: 0.45 });
    this.scene.add(new THREE.LineSegments(geo, mat));
  }

  _initLabels() {
    // Overlay container for HTML node labels
    const wrap = this._canvas.parentElement;
    this._labelContainer = document.createElement('div');
    this._labelContainer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    wrap.appendChild(this._labelContainer);
  }

  _bindResize() {
    const obs = new ResizeObserver(() => this._resize());
    obs.observe(this._canvas);
    this._resize();
  }

  _resize() {
    const w = this._canvas.clientWidth, h = this._canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _bindDrag() {
    // Pointer events so a finger rotates the view as well as a mouse.
    this._canvas.addEventListener('pointerdown', e => { this._userDrag = true; this._dragLast = e.clientX; });
    window.addEventListener('pointerup', () => { this._userDrag = false; this._dragLast = null; });
    window.addEventListener('pointercancel', () => { this._userDrag = false; this._dragLast = null; });
    window.addEventListener('pointermove', e => {
      if (this._userDrag && this._dragLast != null) {
        this._orbitAngle -= (e.clientX - this._dragLast) * 0.004;
        this._dragLast = e.clientX;
      }
    });
  }

  update({ snap, links = [], best, alt, packets = [], buffered = 0, srcId, timeSec = 0 }) {
    this._frameNetwork(snap.nodes);
    this._snap = snap;
    this._links = links;
    this._best = best;
    this._alt = alt;
    this._buffered = buffered;
    this._srcId = srcId;
    this._simTimeSec = timeSec;
    this._lastPackets = packets;
    this._rebuild();
    // _rebuild() recreates the label elements; place them now, or the browser paints them
    // unpositioned (off-screen) before the next animation frame moves them.
    this._updateLabels();
  }

  _rebuild() {
    // Clear dynamic group
    while (this._dynamicGroup.children.length) {
      const c = this._dynamicGroup.children[0];
      if (!c.isSprite) c.geometry?.dispose(); // sprites share one geometry; textures are shared too
      c.material?.dispose?.();
      this._dynamicGroup.remove(c);
    }
    this._debrisMeshes = [];
    this._pulseLine = null;

    // Clear old packet meshes
    for (const c of this._packetMeshes) {
      this._dynamicGroup.remove(c);
      c.geometry?.dispose(); c.material?.dispose?.();
    }
    this._packetMeshes = [];

    // Clear HTML labels
    this._labelContainer.innerHTML = '';
    this._labelEls = [];

    const snap = this._snap;
    if (!snap) return;

    const byId = new Map(snap.nodes.map(n => [n.id, n]));
    const onPath = new Set(this._best?.nodes ?? []);
    const routeSet = new Set();
    if (this._best) for (let i = 1; i < this._best.nodes.length; i++) {
      routeSet.add(`${this._best.nodes[i-1]}|${this._best.nodes[i]}`);
      routeSet.add(`${this._best.nodes[i]}|${this._best.nodes[i-1]}`);
    }

    // Orbit rings
    const seen = new Set();
    for (const n of snap.nodes) {
      const r = +Math.hypot(n.x, n.y).toFixed(3);
      if (r < 0.05 || seen.has(r)) continue;
      seen.add(r);
      const geo = new THREE.RingGeometry(r - 0.009, r + 0.009, 160);
      const mat = new THREE.MeshBasicMaterial({
        color: onPath.has(n.id) ? 0x1a4070 : 0x0d1e35,
        side: THREE.DoubleSide, transparent: true, opacity: onPath.has(n.id) ? 0.55 : 0.28
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;
      this._dynamicGroup.add(ring);
    }

    // Background links (SNR-colored)
    for (const l of this._links) {
      if (routeSet.has(`${l.a}|${l.b}`)) continue;
      const a = byId.get(l.a), b = byId.get(l.b);
      if (!a || !b) continue;
      const snr = l.snrDb ?? 30;
      const t = Math.min(1, Math.max(0, (snr - 6) / 22));
      const color = new THREE.Color().setHSL(t * 0.33, 0.8, 0.35);
      const pts = [auToWorld(a), auToWorld(b)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: l.blocked ? 0 : (l.forecastBlocked ? 0.12 : 0.22) });
      this._dynamicGroup.add(new THREE.Line(geo, mat));
      // Blocked overlay (red)
      if (l.blocked) {
        const bm = new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.35, linewidth: 2 });
        this._dynamicGroup.add(new THREE.Line(geo.clone(), bm));
      }
    }

    // Alternate path — amber dashes
    if (this._alt) {
      const pts = this._alt.nodes.map(id => byId.get(id)).filter(Boolean).map(auToWorld);
      for (const [col, op] of [[0xffb547, 0.6],[0xffcc88, 0.22]]) {
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineDashedMaterial({ color: col, dashSize: 0.14, gapSize: 0.09, transparent: true, opacity: op });
        const line = new THREE.Line(geo, mat); line.computeLineDistances();
        this._dynamicGroup.add(line);
      }
    }

    // Best path — 5-layer glow
    if (this._best) {
      const pts = this._best.nodes.map(id => byId.get(id)).filter(Boolean).map(n => {
        const v = auToWorld(n); v.y += 0.015; return v;
      });
      for (const [col, op, w] of [
        [0x002244, 1.0, 1], [0x0044aa, 0.12, 1], [0x1a88ff, 0.28, 1],
        [0x7fd1ff, 0.65, 1], [0xffffff, 1.0, 1],
      ]) {
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color: col, transparent: op < 1, opacity: op });
        this._dynamicGroup.add(new THREE.Line(geo, mat));
      }
      this._pulseLine = { pts, progress: 0 };

      // Traveling pulse marker
      const pmGeo = new THREE.SphereGeometry(0.048, 10, 10);
      const pmMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      this._pulseMarker = new THREE.Mesh(pmGeo, pmMat);
      this._dynamicGroup.add(this._pulseMarker);
      // Pulse glow
      const pgGeo = new THREE.SphereGeometry(0.13, 10, 10);
      const pgMat = new THREE.MeshBasicMaterial({ color: 0x7fd1ff, transparent: true, opacity: 0.35, side: THREE.BackSide });
      this._pulseGlow = new THREE.Mesh(pgGeo, pgMat);
      this._dynamicGroup.add(this._pulseGlow);
    } else {
      this._pulseMarker = null; this._pulseGlow = null;
    }

    // Nodes
    for (const n of snap.nodes) {
      if (n.kind === 'sun') continue;
      const pos = auToWorld(n);
      const col = NODE_COLOR[n.kind] ?? 0x7fb8d4;
      const r = NODE_R[n.kind] ?? 0.054;
      const active = onPath.has(n.id);
      const emit = (NODE_EMIT[n.kind] ?? 0.55) * (active ? 2.5 : 1);

      // Core. Earth is a lit, rougher sphere so the Sun gives it a day and a night side;
      // relays and the observatory stay as small emissive beacons.
      const isEarth = n.kind === 'earth';
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(isEarth ? r * 1.15 : r, 32, 32),
        isEarth
          ? new THREE.MeshStandardMaterial({ color: 0x2f7fe0, emissive: 0x0b2a5a, emissiveIntensity: active ? 1.1 : 0.7, roughness: 0.55, metalness: 0.05 })
          : new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: emit, roughness: 0.12, metalness: 0.7 })
      );
      mesh.position.copy(pos);
      this._dynamicGroup.add(mesh);
      if (isEarth) { // thin atmosphere
        const atm = glowSprite(0x7fd1ff, r * 4.2, active ? 0.75 : 0.55);
        atm.position.copy(pos); this._dynamicGroup.add(atm);
      }

      // Glow: one soft sprite (brighter on the live route)
      const glow = glowSprite(col, (NODE_GLOW[n.kind] ?? 0.16) * (active ? 3.4 : 2.4), active ? 0.5 : 0.22);
      glow.position.copy(pos); this._dynamicGroup.add(glow);

      // Buffered indicator ring
      if (n.id === this._srcId && this._buffered > 0) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(r + 0.07, r + 0.12, 48),
          new THREE.MeshBasicMaterial({ color: 0xff5555, side: THREE.DoubleSide, transparent: true, opacity: 0.75 })
        );
        ring.position.copy(pos); ring.rotation.x = -Math.PI / 2;
        ring.userData.pulse = true;
        this._dynamicGroup.add(ring);
      }

      // HTML label
      this._addLabel(n, pos, active);
    }

    // Debris
    for (const d of snap.debris ?? []) {
      const comet = d.kind === 'comet';
      const rnd = seeded(d.id);

      // Jamming footprint: a soft red disc of radius r on the ecliptic (legend: "Jamming")
      const disc = new THREE.Mesh(new THREE.CircleGeometry(d.r, 48),
        new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xff5a5a, transparent: true, opacity: comet ? 0.35 : 0.45,
          depthWrite: false, blending: THREE.AdditiveBlending }));
      disc.rotation.x = -Math.PI / 2; disc.position.set(d.x, -0.005, -d.y);
      this._dynamicGroup.add(disc);

      // Particles: fine dust plus fewer, larger rocks of varied tone (asteroids) or ice (comets).
      // Positions come from a per-id seed so a swarm keeps its shape; _frame() spins it.
      const layers = comet
        ? [[70, 0.025, 0.45, [0xd8e8ff, 0xb8c8ff]]]
        : [[200, 0.018, 0.9, [0x8a7a68, 0x6f6458]], [55, 0.045, 0.85, [0xb39a7c, 0x8f7a63, 0x6d6157, 0xc2a882]]];
      for (const [n, sz, spread, palette] of layers) {
        const pos = new Float32Array(n * 3), colors = new Float32Array(n * 3);
        const angles = new Float32Array(n), dists = new Float32Array(n);
        const c = new THREE.Color();
        for (let i = 0; i < n; i++) {
          const a = rnd() * Math.PI * 2, dist = Math.sqrt(rnd()) * d.r * spread;
          angles[i] = a; dists[i] = dist;
          pos[i*3] = d.x + Math.cos(a) * dist; pos[i*3+1] = (rnd() - 0.5) * 0.06; pos[i*3+2] = -(d.y + Math.sin(a) * dist);
          c.setHex(palette[Math.floor(rnd() * palette.length)]).multiplyScalar(0.8 + rnd() * 0.4);
          colors[i*3] = c.r; colors[i*3+1] = c.g; colors[i*3+2] = c.b;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: sz, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95 }));
        pts.userData.debris = { d, angles, dists };
        this._dynamicGroup.add(pts);
        this._debrisMeshes.push(pts);
      }

      if (comet) {
        const at = new THREE.Vector3(d.x, 0.05, -d.y);
        const nuc = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 12),
          new THREE.MeshStandardMaterial({ color: 0xf2f6ff, emissive: 0xbcd4ff, emissiveIntensity: 2.2 }));
        nuc.position.copy(at); this._dynamicGroup.add(nuc);
        const coma = glowSprite(0xbfd8ff, 0.42, 0.75);
        coma.position.copy(at); this._dynamicGroup.add(coma);
        // Tail points away from the Sun (the origin), as real comet tails do
        const len = 0.9 + d.r * 2, dir = Math.atan2(d.y, d.x);
        const tailGeo = new THREE.PlaneGeometry(len, 0.22);
        tailGeo.translate(len / 2, 0, 0); tailGeo.rotateX(-Math.PI / 2);
        const tail = new THREE.Mesh(tailGeo, new THREE.MeshBasicMaterial({ map: tailTexture(), color: 0xa8c8ff, transparent: true, opacity: 0.8,
          depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
        tail.position.copy(at); tail.rotation.y = dir;
        this._dynamicGroup.add(tail);
      }
    }
  }

  _addLabel(n, worldPos, active) {
    const el = document.createElement('div');
    el.className = 'node-label' + (active ? ' active' : '');
    el.textContent = n.name || n.id;
    el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap;';
    this._labelContainer.appendChild(el);
    this._labelEls.push({ el, worldPos: worldPos.clone(), kind: n.kind });
  }

  // Centre on the nodes' bounding box and size it from the farthest node, so the whole relay
  // chain stays on screen however the camera orbits (the Observatory sits at 4.5 AU).
  _frameNetwork(nodes) {
    if (!nodes?.length) return;
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    this._focus.set(cx, 0, -cy);
    this._extent = Math.max(1.5, ...nodes.map(n => Math.hypot(n.x - cx, n.y - cy))) + 0.35;
  }

  // Camera distance that keeps a disc of radius _extent inside the view from any orbit angle,
  // with perspective: the point nearest the camera (distance D - R·cos e) projects lowest, so
  // R·sin e / (D - R·cos e) must stay within FILL of the half-height; side points sit at about
  // D and need R / D within FILL of the half-width. FILL leaves room for the map overlays.
  _fitDistance() {
    const FILL = 0.8;
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const e = Math.atan2(CAM_Y, CAM_R), R = this._extent;
    const nearFit = R * Math.cos(e) + R * Math.sin(e) / (FILL * Math.tan(vHalf));
    const sideFit = R / (FILL * Math.tan(hHalf));
    return Math.max(nearFit, sideFit, 3);
  }

  _frame(t) {
    const dt = t * 0.001; // seconds

    // Slow auto-orbit when not dragging (off when the user prefers reduced motion)
    if (!this._userDrag && !this._reduceMotion.matches) this._orbitAngle += CAM_ORBIT_SPEED * (1 / 60);

    // Camera: orbit the network's centre at a distance that keeps every node in view,
    // plus a little mouse parallax
    const k = this._fitDistance() / Math.hypot(CAM_R, CAM_Y);
    const mx = this._mouse.x * 0.14, my = this._mouse.y * 0.07;
    const tx = this._focus.x + Math.sin(this._orbitAngle) * CAM_R * k + mx;
    const tz = this._focus.z + Math.cos(this._orbitAngle) * CAM_R * k;
    const ty = CAM_Y * k + my;
    this.camera.position.x += (tx - this.camera.position.x) * 0.06;
    this.camera.position.y += (ty - this.camera.position.y) * 0.06;
    this.camera.position.z += (tz - this.camera.position.z) * 0.06;
    this.camera.lookAt(this._focus);

    // Sun pulsate
    if (this._sunMesh) {
      const s = 1 + 0.012 * Math.sin(dt * 1.1);
      this._sunMesh.scale.setScalar(s);
      if (this._sunHalos?.[0]) this._sunHalos[0].scale.setScalar(this._sunHalos[0].userData.size * (1 + 0.04 * Math.sin(dt * 0.7)));
    }

    // Spin debris
    for (const pts of this._debrisMeshes) {
      const { d, angles, dists } = pts.userData.debris;
      const arr = pts.geometry.attributes.position.array;
      const spin = dt * (d.kind === 'comet' ? 0.18 : 0.07);
      for (let i = 0, n = dists.length; i < n; i++) {
        const a = angles[i] + spin;
        arr[i*3]   = d.x + Math.cos(a) * dists[i];
        arr[i*3+2] = -(d.y + Math.sin(a) * dists[i]);
      }
      pts.geometry.attributes.position.needsUpdate = true;
    }

    // Pulse rings
    for (const c of this._dynamicGroup.children) {
      if (c.userData.pulse) {
        c.material.opacity = 0.4 + 0.35 * Math.sin(dt * 5);
        c.scale.setScalar(1 + 0.15 * Math.abs(Math.sin(dt * 2.5)));
      }
    }

    // Traveling pulse marker along best route
    if (this._pulseLine && this._pulseMarker) {
      const { pts } = this._pulseLine;
      // Total path length
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i-1]);
      // Speed: traverse full route in ~3s
      this._pulseLine.progress = (this._pulseLine.progress + (total / 3) * (1/60)) % total;
      // Position on path
      let rem = this._pulseLine.progress, pos = pts[0].clone();
      for (let i = 1; i < pts.length; i++) {
        const seg = pts[i].distanceTo(pts[i-1]);
        if (rem <= seg) { pos = pts[i-1].clone().lerp(pts[i], rem / seg); break; }
        rem -= seg;
      }
      this._pulseMarker.position.copy(pos);
      this._pulseGlow.position.copy(pos);
      const pulse = 0.8 + 0.2 * Math.sin(dt * 8);
      this._pulseMarker.scale.setScalar(pulse);
      this._pulseGlow.scale.setScalar(pulse * 1.2);
    }

    // Rebuild packets each frame
    for (const c of this._packetMeshes) {
      this._dynamicGroup.remove(c);
      c.geometry?.dispose(); c.material?.dispose?.();
    }
    this._packetMeshes = [];
    for (const p of this._lastPackets ?? []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const pos = new THREE.Vector3(p.x, 0.09, -p.y);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8),
        new THREE.MeshBasicMaterial({ color: p.held ? 0xffb547 : 0xeafaff }));
      mesh.position.copy(pos); this._dynamicGroup.add(mesh); this._packetMeshes.push(mesh);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.072, 8, 8),
        new THREE.MeshBasicMaterial({ color: p.held ? 0xffcc80 : 0x7fd1ff, transparent: true, opacity: 0.28, side: THREE.BackSide }));
      glow.position.copy(pos); this._dynamicGroup.add(glow); this._packetMeshes.push(glow);
    }

    // Update HTML labels
    this._updateLabels();

    this.renderer.render(this.scene, this.camera);
  }

  _updateLabels() {
    const w = this._canvas.clientWidth, h = this._canvas.clientHeight;
    const tmp = new THREE.Vector3();
    for (const { el, worldPos } of this._labelEls) {
      tmp.copy(worldPos).project(this.camera);
      const x = (tmp.x * 0.5 + 0.5) * w;
      const y = (-tmp.y * 0.5 + 0.5) * h;
      // Hide if behind camera
      if (tmp.z > 1) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.left = x + 'px';
      el.style.top  = (y - 10) + 'px';
    }
  }

  onMouseMove(clientX, clientY) {
    const r = this._canvas.getBoundingClientRect();
    this._mouse.x = ((clientX - r.left) / r.width)  *  2 - 1;
    this._mouse.y = -((clientY - r.top)  / r.height) * 2 + 1;
  }

  toWorld(sx, sy) {
    const r = this._canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(sx / r.width * 2 - 1, -(sy / r.height) * 2 + 1);
    this._raycaster.setFromCamera(ndc, this.camera);
    const pt = new THREE.Vector3();
    if (this._raycaster.ray.intersectPlane(this._plane, pt)) return [pt.x, -pt.z];
    return [0, 0];
  }

  dispose() { this.renderer.dispose(); this._labelContainer.remove(); }
}
