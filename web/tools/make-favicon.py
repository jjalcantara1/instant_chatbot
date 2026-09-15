#!/usr/bin/env python3
"""Generate web/public/favicon.ico and apple-touch-icon.png.

The source of truth for the artwork is web/public/favicon.svg; this redraws the
same geometry with Pillow because browsers still want a raster .ico, and an
apple-touch-icon must be a PNG.

    pip install Pillow
    python web/tools/make-favicon.py

Glyph is after Lucide's `message-square-text` (ISC). See favicon.svg for the
full attribution and for why it is filled geometry rather than strokes.
"""
import os

from PIL import Image, ImageDraw

ACCENT = (0x5B, 0x2A, 0x86, 255)   # --accent in web/src/index.css
PAPER = (0xF7, 0xF5, 0xF1, 255)    # --paper

GRID = 24.0        # the coordinate space favicon.svg is drawn in
SUPERSAMPLE = 32   # drawn large, then downsampled, so edges stay clean

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.normpath(os.path.join(HERE, '..', 'public'))

# Sizes below this drop to a single text slot. Two slots inside a bubble only
# 12.5 units tall land about a pixel apart once downsampled to 16px and smear
# into one grey band; one thicker slot survives.
SIMPLIFY_BELOW = 24


def draw(scale=SUPERSAMPLE, simplify=False):
    px = int(GRID * scale)
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def u(v):
        return v * scale

    d.rounded_rectangle([0, 0, px - 1, px - 1], radius=u(5.0), fill=ACCENT)
    # Tail first, so the bubble body covers its top edge and the two fuse.
    d.polygon([(u(6.0), u(12.5)), (u(4.0), u(20.8)), (u(12.2), u(15.6))], fill=PAPER)
    d.rounded_rectangle([u(3.4), u(3.6), u(20.6), u(16.1)], radius=u(3.2), fill=PAPER)

    slots = [(9.9, 16.9, 2.6)] if simplify else [(8.3, 17.2, 2.0), (12.4, 14.4, 2.0)]
    for y, x2, h in slots:
        d.rounded_rectangle(
            [u(6.8), u(y - h / 2), u(x2), u(y + h / 2)],
            radius=u(h / 2), fill=ACCENT,
        )
    return img


def render(size):
    return draw(simplify=size < SIMPLIFY_BELOW).resize((size, size), Image.LANCZOS)


def main():
    ico_sizes = [16, 24, 32, 48, 64]
    frames = [render(s) for s in ico_sizes]
    ico_path = os.path.join(PUBLIC, 'favicon.ico')
    # Save from the LARGEST frame: for any size it cannot match in
    # append_images, Pillow resizes the base image, and basing this on the 16px
    # frame would upscale that blur into every other size.
    largest = frames[-1]
    largest.save(ico_path, format='ICO', sizes=[(s, s) for s in ico_sizes],
                 append_images=frames[:-1])
    print(f'wrote {ico_path} ({", ".join(f"{s}x{s}" for s in ico_sizes)})')

    touch_path = os.path.join(PUBLIC, 'apple-touch-icon.png')
    # iOS ignores transparency and composites onto black, so flatten onto the
    # accent rather than shipping a ring of dark pixels around the rounding.
    touch = Image.new('RGB', (180, 180), ACCENT[:3])
    glyph = render(180)
    touch.paste(glyph, (0, 0), glyph)
    touch.save(touch_path, format='PNG')
    print(f'wrote {touch_path} (180x180)')


if __name__ == '__main__':
    main()
