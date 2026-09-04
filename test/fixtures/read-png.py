#!/usr/bin/env python3
"""
Reads a PNG with Pillow and dumps its pixels/palette as JSON on stdout.

Used by the encoder round-trip tests: png.spec.ts writes a PNG with our own
TypeScript encoder, then shells out to THIS script so the readback comes from
an implementation we did not write, never from decodePng() itself.
"""
import json
import sys

import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

from PIL import Image


def main() -> None:
    path = sys.argv[1]
    im = Image.open(path)
    im.load()
    out = {"width": im.width, "height": im.height, "mode": im.mode}
    if im.mode == "P":
        raw_palette = im.getpalette() or []
        num_colors = len(raw_palette) // 3
        transparency = im.info.get("transparency")
        palette = []
        for i in range(num_colors):
            r, g, b = raw_palette[i * 3 : i * 3 + 3]
            if isinstance(transparency, (bytes, bytearray)):
                a = transparency[i] if i < len(transparency) else 255
            else:
                a = 255
            palette.append([r, g, b, a])
        out["indices"] = list(im.getdata())
        out["palette"] = palette
    else:
        rgba = im.convert("RGBA")
        pixels = list(rgba.getdata())
        out["rgba"] = [c for px in pixels for c in px]
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
