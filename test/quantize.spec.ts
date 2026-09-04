import { describe, expect, it } from 'vitest';
import { formatById, type Rgba } from '../src/shared/color.js';
import { medianCut, quantize, type PaletteGenerator } from '../src/shared/quantize.js';

const rgba8888 = formatById('rgba8888');
const rgb5551 = formatById('rgb5551');
const rgb565 = formatById('rgb565');

/** Builds an RGBA8888 pixel buffer from a flat list of [r,g,b,a?] tuples, one per pixel. */
function makeBuffer(pixels: readonly (readonly [number, number, number, number?])[]): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a = 255], i) => {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  });
  return buf;
}

describe('quantize: lossless path', () => {
  const colors: [number, number, number, number][] = [
    [10, 20, 30, 255],
    [40, 50, 60, 255],
    [70, 80, 90, 255],
    [100, 110, 120, 255],
    [130, 140, 150, 255],
    [160, 170, 180, 255],
    [190, 200, 210, 255],
    [220, 230, 240, 255],
  ];
  const buf = makeBuffer(colors);

  it('is taken when 8 distinct colours fit a budget of 16, and every source colour survives exactly', () => {
    const res = quantize(buf, colors.length, 1, { maxColors: 16, format: rgba8888 });
    expect(res.lossless).toBe(true);
    expect(res.palette).toHaveLength(8);
    expect(res.maxError).toBe(0);
    expect(res.meanError).toBe(0);
    // Every original colour is reachable as some palette entry, in order.
    const paletteSet = new Set(res.palette.map((e) => rgba8888.pack(e)));
    for (const [r, g, b, a] of colors) {
      expect(paletteSet.has(rgba8888.pack({ r, g, b, a }))).toBe(true);
    }
    // Every pixel maps to the palette entry that reproduces it exactly.
    for (let i = 0; i < colors.length; i++) {
      const entry = res.palette[res.indices[i]];
      const [r, g, b, a] = colors[i];
      expect([entry.r, entry.g, entry.b, entry.a]).toEqual([r, g, b, a]);
    }
  });

  it('is NOT taken when the same 8 colours are asked to fit a budget of 4', () => {
    const res = quantize(buf, colors.length, 1, { maxColors: 4, format: rgba8888 });
    expect(res.lossless).toBe(false);
    expect(res.palette.length).toBeLessThanOrEqual(4);
  });
});

describe('quantize: full-precision-then-truncate beats pre-truncate-then-quantize', () => {
  // Six rgb5551-bound pixels, budget 2. Two of the raw 8-bit values (251 and
  // 246) sit close enough to the 250/103 level boundary that snap()ping every
  // pixel to 5-bit precision BEFORE running median cut collapses [251,170,233]
  // onto the same truncated value as a different true cluster, which drags
  // median cut's widest-channel choice off the axis that actually separates
  // the two true colour groups. Quantizing at full precision and truncating
  // only the two chosen centroids at the end avoids that distortion.
  const trueColors: [number, number, number][] = [
    [222, 170, 234],
    [222, 170, 233],
    [248, 170, 238],
    [251, 170, 233],
    [250, 170, 237],
    [246, 170, 237],
  ];
  const buf = makeBuffer(trueColors.map(([r, g, b]) => [r, g, b, 255] as const));

  /**
   * Re-implements the WRONG pipeline this quantizer must not take: snap every
   * pixel to the target format first, run median-cut+Lloyd on the truncated
   * values, then snap+dedupe the resulting centroids - the same final step
   * `quantize()` itself uses, so this isolates exactly the "truncate first"
   * mistake and nothing else.
   */
  function preTruncateThenQuantize(generator: PaletteGenerator, budget: number): { mean: number; max: number } {
    const preTruncated: Rgba[] = trueColors.map(([r, g, b]) => {
      const s = rgb5551.snap({ r, g, b, a: 255 });
      return { r: s.r, g: s.g, b: s.b, a: 255 };
    });
    const centroids = generator.generate(preTruncated, budget);
    const palette: Rgba[] = [];
    const seen = new Set<number>();
    for (const c of centroids) {
      const snapped = rgb5551.snap({ ...c, a: 255, stp: false });
      const packed = rgb5551.pack(snapped);
      if (seen.has(packed)) continue;
      seen.add(packed);
      palette.push(snapped);
    }
    let sum = 0;
    let max = 0;
    for (const [r, g, b] of trueColors) {
      let bestDist = Infinity;
      let best = palette[0];
      for (const entry of palette) {
        const dr = r - entry.r;
        const dg = g - entry.g;
        const db = b - entry.b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) {
          bestDist = d;
          best = entry;
        }
      }
      const err = (Math.abs(r - best.r) + Math.abs(g - best.g) + Math.abs(b - best.b)) / 3;
      sum += err;
      if (err > max) max = err;
    }
    return { mean: sum / trueColors.length, max };
  }

  it('produces a strictly lower error than truncating before quantizing', () => {
    const res = quantize(buf, trueColors.length, 1, { maxColors: 2, format: rgb5551 });
    expect(res.lossless).toBe(false);

    const wrong = preTruncateThenQuantize(medianCut, 2);

    // Measured: correct pipeline meanError 2.5, wrong (pre-truncate-first)
    // pipeline meanError ~5.611 - more than double.
    expect(res.meanError).toBeCloseTo(2.5, 5);
    expect(wrong.mean).toBeCloseTo(5.611111111111111, 5);
    expect(res.meanError).toBeLessThan(wrong.mean);
  });
});

describe('quantize: truncation collisions get deduped', () => {
  it('collapses distinct 8-bit greys that pack identically in rgb5551, and never emits a duplicate pack()', () => {
    // 100..102 all truncate to 5-bit level 12, 103..105 all truncate to level
    // 13: 6 distinct 8-bit source colours, 2 distinct rgb5551 colours.
    const greys = [100, 101, 102, 103, 104, 105];
    const buf = makeBuffer(greys.map((v) => [v, v, v, 255] as const));
    const res = quantize(buf, greys.length, 1, { maxColors: 256, format: rgb5551 });

    expect(res.lossless).toBe(true);
    expect(res.palette.length).toBeLessThan(greys.length);
    expect(res.palette).toHaveLength(2);

    const packedValues = res.palette.map((e) => rgb5551.pack(e));
    expect(new Set(packedValues).size).toBe(packedValues.length);

    // Every pixel is assigned to one of the (deduped) palette entries, and
    // both entries are actually used - the collision didn't just shrink the
    // palette, it produced a palette that still covers every pixel.
    const usedIndices = new Set(res.indices);
    expect(usedIndices.size).toBe(2);
    for (const idx of res.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(res.palette.length);
    }
  });
});

describe('quantize: transparency does not pollute the palette', () => {
  it('excludes colour hidden under transparent pixels from every palette entry', () => {
    // Two opaque red pixels, two transparent pixels whose RGB channels carry
    // green - a colour that must never leak into the palette or the error
    // measurement.
    const buf = makeBuffer([
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 10],
      [0, 255, 0, 10],
    ]);
    const res = quantize(buf, 4, 1, { maxColors: 4, format: rgba8888 });

    expect(res.lossless).toBe(true);
    expect(res.meanError).toBe(0);
    // Index 0 is reserved for transparency; every OTHER entry must be free of
    // green (the colour that was only ever visible under a transparent pixel).
    for (const entry of res.palette.slice(1)) {
      expect(entry.g).toBe(0);
    }
    expect(res.palette[0].a).toBe(0);
    expect(res.indices[2]).toBe(0);
    expect(res.indices[3]).toBe(0);
  });
});

describe('quantize: rgb5551 black nudge', () => {
  it('nudges an opaque colour that collides onto 0x0000 to PS1_NEAR_BLACK, and counts it', () => {
    const buf = makeBuffer([[0, 0, 0, 255]]);
    const res = quantize(buf, 1, 1, { maxColors: 4, format: rgb5551 });

    expect(res.blackNudges).toBeGreaterThanOrEqual(1);
    for (const entry of res.palette) {
      const packed = rgb5551.pack(entry);
      // No OPAQUE entry may pack to 0x0000: that value always reads as
      // transparent on the GPU regardless of the STP bit.
      if (entry.a !== 0) {
        expect(packed).not.toBe(0x0000);
      }
    }
    expect(res.palette[0]).toEqual({ r: 8, g: 8, b: 8, a: 255, stp: false });
  });

  it('never uses the STP bit to solve the collision', () => {
    const buf = makeBuffer([[0, 0, 0, 255]]);
    const res = quantize(buf, 1, 1, { maxColors: 4, format: rgb5551 });
    expect(res.palette[0].stp).toBe(false);
  });
});

describe('quantize: rgb565 has no alpha but still reserves an index for transparency', () => {
  it('keeps index 0 for the transparent source pixels even though the format cannot store alpha', () => {
    const buf = makeBuffer([
      [200, 0, 0, 255],
      [0, 0, 0, 0],
    ]);
    const res = quantize(buf, 2, 1, { maxColors: 4, format: rgb565 });
    expect(res.indices[1]).toBe(0);
    expect(res.indices[0]).not.toBe(0);
    // rgb565 forces every entry, including the reserved one, to a=255: a
    // consumer must key transparency off the INDEX for this format, not alpha.
    expect(res.palette[0].a).toBe(255);
  });
});

describe('quantize: maxColors bounds', () => {
  const buf = makeBuffer([[1, 2, 3, 255]]);

  it('accepts the boundary values 2 and 256', () => {
    expect(() => quantize(buf, 1, 1, { maxColors: 2, format: rgba8888 })).not.toThrow();
    expect(() => quantize(buf, 1, 1, { maxColors: 256, format: rgba8888 })).not.toThrow();
  });

  it('throws a clear error outside 2..256', () => {
    for (const bad of [0, 1, 1.5, 257, -1, NaN]) {
      expect(() => quantize(buf, 1, 1, { maxColors: bad, format: rgba8888 })).toThrow(/maxColors/);
    }
  });
});

describe('quantize: determinism', () => {
  it('produces byte-identical output across repeated runs on the same input', () => {
    const colors: [number, number, number, number][] = [
      [10, 200, 40, 255],
      [220, 20, 210, 255],
      [5, 5, 250, 255],
      [128, 128, 128, 255],
      [30, 220, 10, 255],
      [200, 200, 10, 255],
      [90, 40, 240, 255],
      [12, 90, 130, 255],
      [250, 250, 250, 255],
      [0, 0, 0, 0],
    ];
    const buf = makeBuffer(colors);
    const a = quantize(buf, colors.length, 1, { maxColors: 3, format: rgb5551 });
    const b = quantize(buf, colors.length, 1, { maxColors: 3, format: rgb5551 });

    expect([...a.indices]).toEqual([...b.indices]);
    expect(a.palette).toEqual(b.palette);
    expect(a.lossless).toBe(b.lossless);
    expect(a.meanError).toBe(b.meanError);
    expect(a.maxError).toBe(b.maxError);
    expect(a.blackNudges).toBe(b.blackNudges);
  });
});
