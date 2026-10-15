"""Record the product demo video with Playwright, then convert it to MP4 with ffmpeg.

Usage: python tools/record_demo.py [--url URL] [--seconds 120] [--out demo.mp4] [--zoom 1.25]
Without --url it serves web/ on http://localhost:8765 itself and records /?demo=1.
"""
import argparse
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765
SIZE = {"width": 1920, "height": 1080}


def wait_for(url, timeout=10):
    end = time.monotonic() + timeout
    while True:
        try:
            urllib.request.urlopen(url, timeout=1).close()
            return
        except OSError:
            if time.monotonic() > end:
                raise


def record(url, seconds, zoom, video_dir):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport=SIZE, record_video_dir=video_dir, record_video_size=SIZE)
        page = ctx.new_page()
        t0 = time.monotonic()  # video starts with the page; trim the blank load later
        page.goto(url, wait_until="load")
        if zoom:
            page.add_style_tag(content=f"html {{ zoom: {zoom}; }}")
        page.evaluate("document.fonts.ready.then(() => true)")
        lead = time.monotonic() - t0
        page.wait_for_timeout(seconds * 1000)
        webm = page.video.path()
        ctx.close()  # finalises the webm
        browser.close()
    return webm, lead


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", help=f"page to record (default: serve web/ on :{PORT}, ?demo=1)")
    ap.add_argument("--seconds", type=float, default=120)
    ap.add_argument("--out", default="demo.mp4")
    ap.add_argument("--zoom", type=float, help="CSS zoom applied to the page, e.g. 1.25")
    args = ap.parse_args()

    server = None
    url = args.url
    if not url:
        server = subprocess.Popen(
            [sys.executable, "-m", "http.server", str(PORT), "-d", "web", "--bind", "127.0.0.1"],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = f"http://localhost:{PORT}/?demo=1"
    try:
        if server:
            wait_for(f"http://127.0.0.1:{PORT}/")
        with tempfile.TemporaryDirectory() as tmp:
            webm, lead = record(url, args.seconds, args.zoom, tmp)
            out = Path(args.out).resolve()
            subprocess.run(
                # -t: Playwright can pad the tail while closing (seen 4 s -> 11.8 s on a cold start)
                ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{lead:.3f}", "-i", webm, "-t", str(args.seconds), "-an",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", str(out)],
                check=True)
    finally:
        if server:
            server.terminate()
            server.wait()

    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(out)],
        check=True, capture_output=True, text=True).stdout.strip()
    print(out)
    print(f"duration {float(dur):.2f} s")


if __name__ == "__main__":
    main()
