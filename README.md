# clutter

A browser-based palette animation editor for indexed-colour images. Load an
indexed PNG, build a sequence of palettes, and watch the image animate without a
single pixel changing.

Builds to a single self-contained `dist/index.html`. No server, no install, no
network.

```
npm install
npm run dev      # dev server
npm run build    # -> dist/index.html, one file
npm test         # typecheck + unit tests
```

## What it does

- **Import** an indexed PNG and keep its indices, or import anything truecolour
  and quantize to a 2-256 colour palette in the app.
- **Pick a target format**: RGBA8888, RGB565, or the PlayStation's RGB5551 with
  the semi-transparency bit. Every colour you see is shown as that format will
  actually store it.
- **Build an animation** out of complete palettes, with insert, delete,
  duplicate, reorder and an optional loop point, and play it back in real time.
- **Generate frames** in bulk: hue/saturation/brightness ramps, fades toward a
  colour, and Deluxe Paint style colour cycling over a range of entries.

## Why the palette is the animation

Cycling a palette under a fixed image is the cheapest animation there is. The
pixels never move, so on hardware you upload a new CLUT and nothing else. That
is how DPaint waterfalls, lava and marquee lights worked, and it is why the
model here is a flat list of pre-baked palettes rather than a set of live
cycling rules: a list of palettes packs into a texture page and needs no
manipulation at runtime.

The consequence, which the tool leans on: after a cycle, a given colour is at a
different palette index in every frame. So editing across frames is two separate
operations. Writing one slot in every frame is right for a background colour
that never moves; a cycled colour has to be tracked by value, or the edit
flattens the cycle it was part of.

## The format is a lens, not a conversion

Colours are stored at full 8-bit precision and shown through the target format.
Switching RGBA8888 to RGB5551 and back loses nothing, so you can compare formats
by toggling one dropdown.

This matters more than it sounds. Interpolate a hue ramp at 8 bits, pack it to
five bits per channel, and some consecutive frames land on the same value: the
animation stalls on some steps and not others, unevenly, and you cannot see why
unless the preview shows the truncated colour. So the preview always shows the
truncated colour, and the generators tell you how many distinct frames the
format can actually produce before you ask for more than that.

Black to white in RGB5551 is 32 distinct steps. Asking for 64 buys duplicates.

## The PlayStation cases

RGB5551 is not RGBA5551. Two consequences, both of which will otherwise
surface as a wrong-looking image on hardware:

- Bit 15 is the semi-transparency flag, not alpha. It only does anything while
  the primitive is drawn with semi-transparency enabled; with blending off, an
  STP pixel draws solid.
- `0x0000` is always read as fully transparent. Opaque black is therefore not
  representable. You either accept `0x8000`, which is solid black only while
  blending is off, or nudge to `0x0421`.

The editor says so, per entry, at the moment it happens rather than after you
have exported something wrong.

## Building

Vanilla TypeScript, no framework, no runtime dependencies. Vite inlines
everything into one HTML file, which is packaging convenience and also removes a
failure class: a browser refuses to load ES modules from a `file://` origin, and
it fails by drawing the page correctly and then ignoring every click.

The PNG codec is hand-rolled because the browser's own decoder throws away
palette indices, which are the entire point here. Its tests read the encoder's
output back through Pillow rather than through the decoder in the same file, so
the workflow installs Pillow before running them.
