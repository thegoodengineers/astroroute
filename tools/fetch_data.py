"""Download real NASA light curves once and export them as small JSON files for the web app.

lightkurve is used only for data access and standard cleaning (no models). Run:
  python tools/fetch_data.py
Writes web/data/<slug>.json and web/data/index.json.
"""
import json
import sys
import time
from pathlib import Path

import lightkurve as lk
import numpy as np

OUT = Path(__file__).resolve().parent.parent / "web" / "data"
MAX_POINTS = 6000
FLATTEN_DAYS = 1.5  # > 3x the longest transit we search (0.25 d), so dips survive flattening

# (display name, search id, mission, NASA published period [d], kind) - see docs/TARGETS.md
TARGETS = [
    ("Kepler-6", "KIC 10874614", "Kepler", 3.2346996, "planet"),
    ("Kepler-17", "KIC 10619192", "Kepler", 1.4857108, "planet"),
    ("TrES-2", "KIC 11446443", "Kepler", 2.47063, "planet"),
    ("HAT-P-7", "KIC 10666592", "Kepler", 2.20474, "planet"),
    ("WASP-18", "TIC 100100827", "TESS", 0.94145223, "planet"),
    ("WASP-43", "TIC 36734222", "TESS", 0.813475, "planet"),
    ("KIC 6756669", "KIC 6756669", "Kepler", 5.851520671, "false_positive"),
    ("KIC 8801343", "KIC 8801343", "Kepler", 2.73987398, "false_positive"),
    ("TOI-1163.01", "TIC 375542276", "TESS", 3.0771612, "candidate"),
]


def fetch(search_id, mission):
    if mission == "Kepler":
        res = lk.search_lightcurve(search_id, author="Kepler", exptime=1800)
        return res[:2].download_all().stitch()
    res = lk.search_lightcurve(search_id, author="SPOC", exptime=120)
    return res[0].download()


def clean(lc):
    lc = lc.remove_nans().normalize()
    lc = lc.remove_outliers(sigma_upper=4, sigma_lower=1e9)  # never clip transit dips
    cadence = float(np.nanmedian(np.diff(lc.time.value)))
    window = int(FLATTEN_DAYS / cadence) | 1  # odd number of cadences
    lc = lc.flatten(window_length=window)
    if len(lc) > MAX_POINTS:
        span = float(lc.time.value[-1] - lc.time.value[0])
        lc = lc.bin(time_bin_size=span / MAX_POINTS).remove_nans()
    return lc


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for name, sid, mission, period, kind in TARGETS:
        slug = name.lower().replace(" ", "-").replace(".", "-")
        path = OUT / f"{slug}.json"
        t0 = time.time()
        try:
            if not path.exists():
                lc = clean(fetch(sid, mission))
                data = {
                    "target": name, "searchId": sid, "mission": mission,
                    "publishedPeriod": period, "kind": kind,
                    "time": [round(float(x), 5) for x in lc.time.value],
                    "flux": [round(float(x), 6) for x in lc.flux.value],
                }
                path.write_text(json.dumps(data, separators=(",", ":")))
            n = len(json.loads(path.read_text())["time"])
            index.append({"slug": slug, "target": name, "mission": mission, "kind": kind,
                          "publishedPeriod": period, "points": n})
            print(f"{name:14s} {n:5d} pts  {time.time() - t0:5.1f}s", flush=True)
        except Exception as e:  # one bad target must not stop the rest
            print(f"{name:14s} FAILED {type(e).__name__}: {e}", flush=True)
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    print(f"wrote {len(index)}/{len(TARGETS)} targets", flush=True)
    return 0 if index else 1


if __name__ == "__main__":
    sys.exit(main())
