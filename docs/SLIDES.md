# AstroRoute — Slide Deck

---

## Slide 1 — Hook: Signal Lost

**The moment the signal dies.**

An observatory 4.5 AU from Earth is watching a star.
A transit begins — a planet crossing the face of its sun.
Then an asteroid swarm drifts into the relay chain and jams three links at once.

The fixed route is gone.

*[live demo: map shows swarm drifting in, links turning red, packet counter dropping]*

The question is: can we find another way through — fast enough to not miss the transit?

---

## Slide 2 — Live Demo

**Watch the router fight the swarm in real time.**

- Solar system map: Earth, 8 relays, observatory, debris swarm in motion.
- Active path highlighted in blue. Alternate path in orange — pre-computed, one hop different, ready instantly.
- As links jam, the router reroutes in < 1 ms. Packets keep flowing.
- Every packet received: the light-curve panel ticks upward. The transit dip emerges from the noise.

*[point at the canvas — swarm moving, path shifting, BLS signal growing]*

Scenario controls: Default (one swarm) / Storm (three swarms) / Comet rain.
Drop your own swarm: click anywhere on the map.

---

## Slide 3 — How It Works

**Three modules, written from scratch.**

**sim.js** — 2-D solar system. Circular orbits (Kepler P = a^1.5). 8 relays from Venus orbit to 3.2 AU. One observatory at 4.5 AU aimed at the target star. Debris: asteroid swarms (slow drift, 30 dB, r 0.35 AU) and comets (fast, 40 dB, r 0.15 AU). Jamming = `strength × (1 − s/r)²` for closest distance s to the link segment.

**router.js** — Toy link budget (tx − 20·log₁₀(d) − jamming). Dijkstra best path. Independent alternate: shortest path sharing no intermediate node with the best (instant failover). Verified against brute-force on 1 000 random networks: **0 mismatches**.

**detect.js** — Box Least Squares (BLS) period search on the received flux stream. Phase folding, transit depth/duration/SNR. Vetting: even/odd check, secondary eclipse, centroid shift. Verdict: PLANET CANDIDATE / LIKELY FALSE POSITIVE / NO CONVINCING SIGNAL / NEED MORE DATA.

No ML. No routing library. No BLS library.

---

## Slide 4 — Proof, Limits and Team

**The numbers.**

| What | Result |
|---|---|
| Router vs brute force (1 000 networks) | 0 mismatches |
| Packets delivered — rerouting vs fixed route | 100% vs 81.8% |
| BLS: NASA periods recovered within 1% | see validation.csv |

**Simplifications we own:**
- 2-D, circular orbits. Real orbits are 3-D and elliptical.
- Toy link budget — not RF-engineering.
- Light curves replayed as packets, not a live feed.
- Debris modelled as jamming discs with linear drift.

**The point:** the routing logic and detection-under-disruption are real and verified. The physics simplifications are deliberate and declared.

**Team:**

| | |
|---|---|
| Chirag | router, integration, hosting |
| Abhijeet | BLS detector |
| Ayush | UI/canvas |
| Bhumika | simulation, validation, slides |
