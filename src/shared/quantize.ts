/**
 * Colour quantizer.
 *
 * Turns an RGBA truecolour buffer into a palette of at most `maxColors`
 * entries plus one index byte per pixel, targeting one of the three formats
 * in `color.ts`. Four rules, measured on real PS1 assets in a sibling
 * project, shape everything below:
 *
 *   1. Quantize at FULL 8-bit precision, truncate the palette at the end,
 *      then remap against the truncated palette. Pre-rounding the source to
 *      the target format before choosing the palette throws away exactly the
 *      distances a good quantizer needs. So every distance computation here
 *      - the median-cut split, the Lloyd refinement, the final per-pixel
 *      assignment - runs on the original 8-bit-per-channel colours. Only the
 *      chosen palette entries get truncated, at the very end, via
 *      `format.snap`.
 *   2. Truncation can collide two chosen entries onto the same packed value.
 *      Dedupe AFTER snapping and remap; a request for 256 colours can
 *      legitimately come back with fewer.
 *   3. The lossless path is common and must be taken: count distinct colours
 *      IN THE TARGET FORMAT (via `format.pack`) first. If they fit in the
 *      budget, use them directly and never run the quantizer.
 *   4. No dithering. Not a flag, not an option - palette cycling makes an
 *      error-diffused pattern crawl, and that's the one thing this tool must
 *      not do to its own output.
 */

import { PS1_NEAR_BLACK, PS1_TRANSPARENT, type ColorFormat, type Entry, type Rgba } from './color.js';

export interface QuantizeOptions {
  /** 2..256. */
  maxColors: number;
  format: ColorFormat;
  /** Alpha at or below this is treated as fully transparent. Default 32. */
  alphaTransparentAt?: number;
}

export interface QuantizeResult {
  /** <= maxColors, already snapped to `format`. */
  palette: Entry[];
  /** One byte per pixel. */
  indices: Uint8Array;
  /**
   * True when the source had <= maxColors distinct colours in the target
   * format and no quantizer ran.
   */
  lossless: boolean;
  /** Mean per-pixel error in the target format, 0-255 per channel, for the UI. */
  meanError: number;
  /** Max per-pixel error in the target format, 0-255 per channel, for the UI. */
  maxError: number;
  /**
   * rgb5551 only: how many opaque entries collided onto 0x0000 (which the
   * GPU always reads as transparent) and were nudged to PS1_NEAR_BLACK.
   */
  blackNudges: number;
}

/** A palette-generation strategy: full-precision colours in, centroids out. */
export interface PaletteGenerator {
  name: string;
  generate(pixels: Rgba[], maxColors: number): Rgba[];
}

const DEFAULT_ALPHA_TRANSPARENT_AT = 32;

// ---------------------------------------------------------------------------
// Median cut + Lloyd (k-means) refinement.
// ---------------------------------------------------------------------------

interface WeightedColor {
  r: number;
  g: number;
  b: number;
  count: number;
}

/** Full-precision colour histogram: one entry per distinct 8-bit RGB triple. */
function buildHistogram(pixels: readonly Rgba[]): WeightedColor[] {
  const map = new Map<number, WeightedColor>();
  for (const p of pixels) {
    const key = (p.r << 16) | (p.g << 8) | p.b;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, { r: p.r, g: p.g, b: p.b, count: 1 });
    }
  }
  return [...map.values()];
}

interface Box {
  colors: WeightedColor[];
}

function boxPopulation(box: Box): number {
  let n = 0;
  for (const c of box.colors) n += c.count;
  return n;
}

function boxWidestChannel(box: Box): 'r' | 'g' | 'b' {
  let minR = 255,
    maxR = 0,
    minG = 255,
    maxG = 0,
    minB = 255,
    maxB = 0;
  for (const c of box.colors) {
    if (c.r < minR) minR = c.r;
    if (c.r > maxR) maxR = c.r;
    if (c.g < minG) minG = c.g;
    if (c.g > maxG) maxG = c.g;
    if (c.b < minB) minB = c.b;
    if (c.b > maxB) maxB = c.b;
  }
  const rangeR = maxR - minR;
  const rangeG = maxG - minG;
  const rangeB = maxB - minB;
  if (rangeR >= rangeG && rangeR >= rangeB) return 'r';
  if (rangeG >= rangeB) return 'g';
  return 'b';
}

/** Split a box at its population-weighted median along its widest channel. */
function splitBox(box: Box): [Box, Box] {
  const channel = boxWidestChannel(box);
  const sorted = [...box.colors].sort((a, b) => a[channel] - b[channel]);
  const total = sorted.reduce((s, c) => s + c.count, 0);
  let cumulative = 0;
  let splitAt = 1;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i].count;
    if (cumulative >= total / 2) {
      splitAt = i + 1;
      break;
    }
  }
  // Guarantee both halves are non-empty even if the weighted median lands on
  // an edge (e.g. one massively-popular colour dominating the box).
  splitAt = Math.min(Math.max(splitAt, 1), sorted.length - 1);
  return [{ colors: sorted.slice(0, splitAt) }, { colors: sorted.slice(splitAt) }];
}

/** Median-cut box list, deterministic: always splits the largest-population splittable box. */
function medianCutBoxes(histogram: WeightedColor[], maxColors: number): Box[] {
  if (histogram.length === 0) return [];
  const boxes: Box[] = [{ colors: histogram }];
  while (boxes.length < maxColors) {
    let bestIdx = -1;
    let bestPop = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].colors.length < 2) continue; // can't split a single colour
      const pop = boxPopulation(boxes[i]);
      if (pop > bestPop) {
        bestPop = pop;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // nothing left that can be split
    const [a, b] = splitBox(boxes[bestIdx]);
    boxes.splice(bestIdx, 1, a, b);
  }
  return boxes;
}

function boxMeanColor(box: Box): Rgba {
  let sr = 0,
    sg = 0,
    sb = 0,
    sw = 0;
  for (const c of box.colors) {
    sr += c.r * c.count;
    sg += c.g * c.count;
    sb += c.b * c.count;
    sw += c.count;
  }
  return { r: Math.round(sr / sw), g: Math.round(sg / sw), b: Math.round(sb / sw), a: 255 };
}

const LLOYD_MAX_ITERATIONS = 10;

/**
 * Refine median-cut centroids by Lloyd's algorithm over the weighted
 * histogram. Deterministic: nearest-centroid ties always resolve to the
 * lowest centroid index, and an empty cluster keeps its previous position
 * rather than being reseeded (no randomness anywhere in this file).
 */
function lloydRefine(histogram: WeightedColor[], initial: Rgba[]): Rgba[] {
  if (initial.length === 0 || histogram.length === 0) return initial;
  let centroids = initial.map((c) => ({ ...c }));
  for (let iter = 0; iter < LLOYD_MAX_ITERATIONS; iter++) {
    const sums = centroids.map(() => ({ r: 0, g: 0, b: 0, w: 0 }));
    for (const c of histogram) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < centroids.length; i++) {
        const cen = centroids[i];
        const dr = c.r - cen.r;
        const dg = c.g - cen.g;
        const db = c.b - cen.b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      const s = sums[bestIdx];
      s.r += c.r * c.count;
      s.g += c.g * c.count;
      s.b += c.b * c.count;
      s.w += c.count;
    }
    let moved = false;
    const next = centroids.map((cen, i) => {
      const s = sums[i];
      if (s.w === 0) return cen; // empty cluster: hold position
      const r = Math.round(s.r / s.w);
      const g = Math.round(s.g / s.w);
      const b = Math.round(s.b / s.w);
      if (r !== cen.r || g !== cen.g || b !== cen.b) moved = true;
      return { r, g, b, a: 255 };
    });
    centroids = next;
    if (!moved) break;
  }
  return centroids;
}

export const medianCut: PaletteGenerator = {
  name: 'median-cut+lloyd',
  generate(pixels, maxColors) {
    const histogram = buildHistogram(pixels);
    if (histogram.length === 0) return [];
    const boxes = medianCutBoxes(histogram, maxColors);
    const initial = boxes.map(boxMeanColor);
    return lloydRefine(histogram, initial);
  },
};

// ---------------------------------------------------------------------------
// quantize()
// ---------------------------------------------------------------------------

function toRawEntry(c: Rgba): Entry {
  return { r: c.r, g: c.g, b: c.b, a: 255, stp: false };
}

function colorDistSq(a: Rgba, b: Rgba): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

export function quantize(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: QuantizeOptions,
  generator: PaletteGenerator = medianCut,
): QuantizeResult {
  const { format } = opts;
  if (!Number.isInteger(opts.maxColors) || opts.maxColors < 2 || opts.maxColors > 256) {
    throw new Error(`maxColors must be an integer in 2..256, got ${opts.maxColors}`);
  }
  const alphaTransparentAt = opts.alphaTransparentAt ?? DEFAULT_ALPHA_TRANSPARENT_AT;

  const pixelCount = width * height;
  const transparentMask = new Uint8Array(pixelCount);
  const opaquePixels: Rgba[] = [];
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a <= alphaTransparentAt) {
      transparentMask[i] = 1;
    } else {
      // Alpha above the threshold is treated as fully opaque for palette
      // purposes: this quantizer binarizes transparency (see the module
      // doc's alpha handling in the caller-facing spec) rather than treating
      // alpha as a quantized dimension, so a garbage colour under a
      // transparent pixel can never bleed into a centroid (rule under
      // "Transparency" below).
      opaquePixels.push({ r: rgba[o], g: rgba[o + 1], b: rgba[o + 2], a: 255 });
    }
  }
  const hasTransparency = opaquePixels.length < pixelCount;
  const budget = hasTransparency ? opts.maxColors - 1 : opts.maxColors;

  // Lesson 3: count distinct colours IN THE TARGET FORMAT first (format.pack
  // already applies the format's own bit depth), over the full set of full-
  // precision opaque pixels, and skip the quantizer entirely if they fit.
  const distinctPacked = new Map<number, Rgba>();
  for (const p of opaquePixels) {
    const packed = format.pack(toRawEntry(p));
    if (!distinctPacked.has(packed)) distinctPacked.set(packed, p);
  }

  let lossless: boolean;
  let rawOpaqueColors: Rgba[];
  if (distinctPacked.size <= budget) {
    lossless = true;
    rawOpaqueColors = [...distinctPacked.values()];
  } else {
    lossless = false;
    // Lesson 1: the generator sees the ORIGINAL 8-bit opaque pixels, never a
    // pre-truncated version of them.
    rawOpaqueColors = generator.generate(opaquePixels, budget);
  }

  // Lesson 1 (continued) + lesson 2: truncate the chosen colours to the
  // format now, at the very end, then dedupe on the packed value - a
  // request for `budget` colours can legitimately come back shorter.
  const opaqueEntries: Entry[] = [];
  const seenPacked = new Set<number>();
  let blackNudges = 0;
  for (const c of rawOpaqueColors) {
    let snapped = format.snap(toRawEntry(c));
    let packed = format.pack(snapped);
    // PS1 rule (color.ts): 0x0000 always reads as transparent on the GPU. An
    // entry meant to be OPAQUE that collides there is nudged to near-black
    // rather than silently becoming invisible. STP is a draw-time choice for
    // the user, not something the quantizer gets to decide.
    if (format.id === 'rgb5551' && packed === PS1_TRANSPARENT) {
      snapped = format.unpack(PS1_NEAR_BLACK);
      packed = format.pack(snapped);
      blackNudges++;
    }
    if (seenPacked.has(packed)) continue;
    seenPacked.add(packed);
    opaqueEntries.push(snapped);
  }

  const palette: Entry[] = [];
  let transparentIndex = -1;
  if (hasTransparency) {
    // Reserve index 0 for transparency. For rgb5551 this naturally packs to
    // 0x0000, matching the GPU's own transparency rule exactly. For
    // rgb565/rgba8888 it is purely a caller convention: rgb565 carries no
    // real alpha at all (format.snap forces a=255 there), so a consumer must
    // key transparency off the INDEX, never off the stored alpha or packed
    // value, for that format.
    palette.push(format.snap({ r: 0, g: 0, b: 0, a: 0, stp: false }));
    transparentIndex = 0;
  }
  const opaqueStart = palette.length;
  for (const e of opaqueEntries) palette.push(e);

  // Assign every pixel to a palette index and measure error against the
  // FINAL palette (snapped, deduped, nudged) - "measured against the snapped
  // palette, because that is what the hardware shows" (lesson 1).
  const indices = new Uint8Array(pixelCount);
  let errSum = 0;
  let errMax = 0;
  let errCount = 0;
  let opaqueCursor = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (transparentMask[i]) {
      indices[i] = transparentIndex >= 0 ? transparentIndex : 0;
      continue;
    }
    const p = opaquePixels[opaqueCursor++];
    let bestIdx = opaqueStart;
    let bestDist = Infinity;
    for (let k = 0; k < opaqueEntries.length; k++) {
      const d = colorDistSq(p, opaqueEntries[k]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = opaqueStart + k;
      }
    }
    indices[i] = bestIdx;
    const entry = palette[bestIdx];
    const err = (Math.abs(p.r - entry.r) + Math.abs(p.g - entry.g) + Math.abs(p.b - entry.b)) / 3;
    errSum += err;
    if (err > errMax) errMax = err;
    errCount++;
  }

  return {
    palette,
    indices,
    lossless,
    meanError: errCount > 0 ? errSum / errCount : 0,
    maxError: errMax,
    blackNudges,
  };
}
