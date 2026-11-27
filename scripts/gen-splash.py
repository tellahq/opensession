#!/usr/bin/env python3
"""Generate iOS PWA launch images (apple-touch-startup-image).

iOS shows a native launch screen the instant you tap the home-screen icon,
before WebKit loads the page. Without a startup image it's plain black. iOS
only accepts PNGs matched to the exact device resolution via media query, so
we emit one PNG per modern iPhone (portrait).

These images are a redraw of the FIRST FRAME of the `#splash` markup in
src/frontend/index.html, at device pixel scale: same radial background, same
76pt mark, centered. That is the whole point of the file.
iOS shows this PNG, then WebKit paints `#splash` over it, and if the two agree
the handoff is invisible; when they drift you get a visible jump on every cold
launch. So the constants below are read from index.html, not invented here.
Change the splash markup and re-run this, or the two stop matching.

The mark itself is the native app icon (os1-ios's asset catalog), the same
black-and-white artwork the Electron shell and the web app icons use. Do not
paint anything extra behind or below it: an earlier version of this script
added a glow and its own audio bars, which meant the launch image never
matched the shell it handed off to. The shell's shader draws the mark sunk
into the page, but its first frame is the plain icon, which is what this
draws.

    python3 scripts/gen-splash.py

Output: src/frontend/splash/apple-splash-<w>-<h>.png

Re-run after editing #splash or replacing the native artwork, then bump the
?v= cache-buster on the splash hrefs in src/frontend/index.html — installed
PWAs cache these for a day.
"""

import os
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT_DIR = os.path.join(ROOT, "packages", "core", "opensession-server", "src", "frontend", "splash")
# The native app icon's macOS variant: identical artwork to the iOS icon, but
# with transparent corners, so it composites onto the gradient exactly the way
# /mac-app-icon.png does in the HTML shell.
LOGO_PATH = os.path.join(
    ROOT, "packages", "clients", "ios", "OS1", "Assets.xcassets", "AppIcon.appiconset", "mac512@2x.png"
)

# --- constants mirrored from #splash in src/frontend/index.html ---
# background: radial-gradient(120% 90% at 50% 35%, #262626 0%, #1b1b1b 70%)
GRAD_INNER = (38, 38, 38)
GRAD_OUTER = (27, 27, 27)
GRAD_RX, GRAD_RY = 1.20, 0.90
GRAD_CX, GRAD_CY = 0.50, 0.35
GRAD_STOP = 0.70

LOGO_PT = 76  # .splash-logo width/height

# Portrait iPhones, matched by the media queries index.html writes.
# (point_width, point_height, scale)
DEVICES = [
    (320, 568, 2),  # SE 1st gen
    (375, 667, 2),  # 8, SE 2/3
    (414, 896, 2),  # XR, 11
    (375, 812, 3),  # X, XS, 11 Pro, 12/13 mini
    (390, 844, 3),  # 12, 12 Pro, 13, 13 Pro, 14
    (393, 852, 3),  # 14 Pro, 15, 15 Pro, 16
    (402, 874, 3),  # 16 Pro
    (414, 736, 3),  # 8 Plus
    (414, 896, 3),  # XS Max, 11 Pro Max
    (428, 926, 3),  # 12/13 Pro Max, 14 Plus
    (430, 932, 3),  # 15 Plus, 15 Pro Max, 16 Plus
    (440, 956, 3),  # 16 Pro Max
]


def gradient(w, h):
    """The CSS radial-gradient, drawn small and scaled up.

    It is smooth by construction, so a per-pixel pass at 1/8 scale upsamples
    without a visible seam and keeps this script a couple of seconds rather
    than a couple of minutes.
    """
    sw, sh = max(2, w // 8), max(2, h // 8)
    small = Image.new("RGB", (sw, sh))
    px = small.load()
    cx, cy = GRAD_CX * sw, GRAD_CY * sh
    rx, ry = GRAD_RX * sw, GRAD_RY * sh
    for y in range(sh):
        dy = ((y + 0.5) - cy) / ry
        for x in range(sw):
            dx = ((x + 0.5) - cx) / rx
            t = min(1.0, (dx * dx + dy * dy) ** 0.5 / GRAD_STOP)
            px[x, y] = tuple(
                round(a + (b - a) * t) for a, b in zip(GRAD_INNER, GRAD_OUTER)
            )
    return small.resize((w, h), Image.Resampling.BICUBIC)


def render(logo_master, pt_w, pt_h, scale):
    w, h = pt_w * scale, pt_h * scale
    img = gradient(w, h).convert("RGBA")

    # #splash centers the mark on its own.
    logo_px = LOGO_PT * scale
    logo = logo_master.resize((logo_px, logo_px), Image.Resampling.LANCZOS)
    img.alpha_composite(logo, (w // 2 - logo_px // 2, round((h - logo_px) / 2)))
    return img.convert("RGB")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    logo_master = Image.open(LOGO_PATH).convert("RGBA")
    for pt_w, pt_h, scale in DEVICES:
        w, h = pt_w * scale, pt_h * scale
        render(logo_master, pt_w, pt_h, scale).save(
            os.path.join(OUT_DIR, f"apple-splash-{w}-{h}.png")
        )
        print(f"apple-splash-{w}-{h}.png")


if __name__ == "__main__":
    main()
