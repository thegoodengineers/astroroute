import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, step, snapshot, attenuationDb, addDebris } from "../web/js/sim.js";

test("attenuation is 0 when debris is far from segment", () => {
  const world = createWorld("default");
  const snap = snapshot(world);
  // Place a debris far from any node pair and verify 0 attenuation manually.
  const farSnap = {
    nodes: [{ id: "A", x: 0, y: 0 }, { id: "B", x: 1, y: 0 }],
    debris: [{ id: "d", x: 0, y: 5, r: 0.1, strength: 30 }],
  };
  assert.strictEqual(attenuationDb(farSnap, "A", "B"), 0);
});

test("attenuation is max (strength) when debris centre is on segment", () => {
  const snap = {
    nodes: [{ id: "A", x: 0, y: 0 }, { id: "B", x: 2, y: 0 }],
    debris: [{ id: "d", x: 1, y: 0, r: 0.5, strength: 30 }],
  };
  // s=0, so strength*(1-0)^2 = 30
  assert.strictEqual(attenuationDb(snap, "A", "B"), 30);
});

test("attenuation is symmetric: A->B equals B->A", () => {
  const snap = {
    nodes: [{ id: "A", x: -1, y: 0 }, { id: "B", x: 1, y: 0 }],
    debris: [{ id: "d", x: 0, y: 0.2, r: 0.5, strength: 20 }],
  };
  const ab = attenuationDb(snap, "A", "B");
  const ba = attenuationDb(snap, "B", "A");
  assert.ok(Math.abs(ab - ba) < 1e-10, `symmetric: ${ab} vs ${ba}`);
  assert.ok(ab > 0, "should have non-zero attenuation");
});

test("orbits keep radius after 1000 steps", () => {
  const world = createWorld("default");
  const snap0 = snapshot(world);
  const radii0 = snap0.nodes.map(n => Math.hypot(n.x, n.y));

  for (let i = 0; i < 1000; i++) step(world, 1); // 1000 hours

  const snap1 = snapshot(world);
  const radii1 = snap1.nodes.map(n => Math.hypot(n.x, n.y));

  for (let i = 0; i < radii0.length; i++) {
    assert.ok(Math.abs(radii0[i] - radii1[i]) < 1e-9,
      `node ${snap0.nodes[i].id} radius changed from ${radii0[i]} to ${radii1[i]}`);
  }
});

test("same seed produces same snapshot", () => {
  const w1 = createWorld("default");
  const w2 = createWorld("default");
  for (let i = 0; i < 50; i++) { step(w1, 24); step(w2, 24); }
  const s1 = snapshot(w1);
  const s2 = snapshot(w2);
  for (let i = 0; i < s1.nodes.length; i++) {
    assert.ok(Math.abs(s1.nodes[i].x - s2.nodes[i].x) < 1e-12);
    assert.ok(Math.abs(s1.nodes[i].y - s2.nodes[i].y) < 1e-12);
  }
  for (let i = 0; i < s1.debris.length; i++) {
    assert.ok(Math.abs(s1.debris[i].x - s2.debris[i].x) < 1e-12);
    assert.ok(Math.abs(s1.debris[i].y - s2.debris[i].y) < 1e-12);
  }
});

test("addDebris adds a new debris entry", () => {
  const world = createWorld("default");
  const before = world.debris.length;
  addDebris(world, 1.5, 0.5, "comet");
  assert.strictEqual(world.debris.length, before + 1);
  const d = world.debris[world.debris.length - 1];
  assert.strictEqual(d.kind, "comet");
  assert.ok(Math.abs(d.x - 1.5) < 1e-12);
  assert.ok(Math.abs(d.y - 0.5) < 1e-12);
});

test("snapshot includes all expected fields", () => {
  const world = createWorld("default");
  const snap = snapshot(world);
  assert.ok(typeof snap.t === "number");
  assert.ok(Array.isArray(snap.nodes));
  assert.ok(Array.isArray(snap.debris));
  const earth = snap.nodes.find(n => n.id === "earth");
  assert.ok(earth, "earth node missing");
  assert.ok(typeof earth.x === "number" && typeof earth.y === "number");
  const obs = snap.nodes.find(n => n.kind === "observatory");
  assert.ok(obs, "observatory node missing");
});

test("storm scenario has 3 debris swarms", () => {
  const world = createWorld("storm");
  assert.strictEqual(world.debris.length, 3);
});

test("default scenario debris moves after steps", () => {
  const w = createWorld("default");
  const snap0 = snapshot(w);
  for (let i = 0; i < 100; i++) step(w, 24);
  const snap1 = snapshot(w);
  assert.ok(snap0.debris[0].x !== snap1.debris[0].x || snap0.debris[0].y !== snap1.debris[0].y,
    "debris should have drifted");
});
