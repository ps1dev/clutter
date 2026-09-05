/**
 * Palette transforms over the (frame, entry) grid.
 *
 * An animation of pre-baked palettes is a matrix: `M[frame][entry]`. Every tool
 * that edits existing frames rather than creating new ones is a function over
 * that matrix restricted to a selection of frames and a selection of entries,
 * and once you write them that way they stop having anything in common except
 * the two things that genuinely ARE common:
 *
 *   1. THE SELECTION. Frames come from the timeline span or the whole
 *      animation; entries come from the palette selection or all of them.
 *      Resolved once, in `resolveSelection`, so "no selection means everything"
 *      is decided in one place instead of per tool.
 *
 *   2. THE EDGE MODE. Anything that shifts along an axis has to say what
 *      happens at the ends. `wrap` rotates; `clamp` holds the edge value, which
 *      is what "fill the vacant slots with the neighbouring colour" means.
 *      Shared because the colour cycle shifts along the ENTRY axis and the
 *      phase shift along the FRAME axis, and they want identical semantics.
 *
 * Generators (the ones that create frames) live in generators.ts and stay
 * there: producing N frames from one palette is a different shape from
 * rewriting N frames in place, and merging the two would need a mode flag
 * threaded through everything to buy nothing.
 */

import type { Entry } from '../shared/color.js';

export type EdgeMode = 'wrap' | 'clamp';

/**
 * Bring an out-of-range position into `[0, n)`.
 *
 * `wrap` is modulo, correct for negatives. `clamp` holds the end value, so a
 * slot shifted in from beyond the edge repeats its neighbour rather than going
 * blank - there is no such thing as an empty palette entry, so "vacant" has to
 * mean something and this is the only thing it can usefully mean.
 */
export function resolveIndex(i: number, n: number, mode: EdgeMode): number {
  if (n <= 0) return 0;
  if (mode === 'clamp') return Math.max(0, Math.min(n - 1, i));
  return ((i % n) + n) % n;
}

export interface Selection {
  /** Frame indices, ascending. */
  frames: number[];
  /** Palette entry indices, ascending. */
  entries: number[];
}

/**
 * Turn "the current selection, or everything" into explicit index lists.
 * `null`/empty means everything on that axis, which is the rule every tool
 * follows and none of them should be restating.
 */
export function resolveSelection(
  frameCount: number,
  paletteSize: number,
  frameSpan: [number, number] | null,
  entrySelection: Iterable<number> | null,
): Selection {
  const frames: number[] = [];
  const lo = frameSpan ? Math.max(0, Math.min(frameSpan[0], frameSpan[1])) : 0;
  const hi = frameSpan ? Math.min(frameCount - 1, Math.max(frameSpan[0], frameSpan[1])) : frameCount - 1;
  for (let i = lo; i <= hi; i++) frames.push(i);

  const picked = entrySelection ? [...entrySelection].filter((i) => i >= 0 && i < paletteSize) : [];
  const entries = picked.length
    ? [...new Set(picked)].sort((a, b) => a - b)
    : Array.from({ length: paletteSize }, (_, i) => i);

  return { frames, entries };
}

type Palettes = Entry[][];

const cloneAll = (p: Palettes): Palettes => p.map((pal) => pal.map((e) => ({ ...e })));

/**
 * Write one palette's colours, at the selected entries, into every selected
 * frame. The "make this entry the same everywhere" operation.
 */
export function setForAllFrames(palettes: Palettes, sel: Selection, source: Entry[]): Palettes {
  const out = cloneAll(palettes);
  for (const f of sel.frames) {
    const pal = out[f];
    if (!pal) continue;
    for (const e of sel.entries) {
      const src = source[e];
      if (src) pal[e] = { ...src };
    }
  }
  return out;
}

/**
 * Copy one entry's colour onto the selected entries, per frame.
 *
 * Per frame is the point: the source index is read from the SAME frame it is
 * written into, so a colour that animates carries its animation across to the
 * entries it is copied onto.
 */
export function copyFromIndex(palettes: Palettes, sel: Selection, sourceIndex: number): Palettes {
  const out = cloneAll(palettes);
  for (const f of sel.frames) {
    const pal = out[f];
    const src = palettes[f]?.[sourceIndex];
    if (!pal || !src) continue;
    for (const e of sel.entries) {
      if (e === sourceIndex) continue;
      pal[e] = { ...src };
    }
  }
  return out;
}

export interface PhaseShiftOptions {
  /** Frames to shift the first selected entry by. May be negative. */
  shift: number;
  /**
   * Extra frames of shift per selected entry, fractional allowed, FLOORED.
   *
   * spicyjpeg's worked example, which pins the rounding: base 2 with increment
   * 0.5 shifts the first and second selected entries by 2 and the third and
   * fourth by 3. floor(2 + k * 0.5) for k = 0..3 gives 2, 2, 3, 3. Rounding
   * would give 2, 3, 3, 4.
   */
  increment?: number;
  edge?: EdgeMode;
}

/**
 * Slide selected entries along the TIME axis, each by its own amount.
 *
 * Entry k of the selection takes its colour from `floor(shift + k*increment)`
 * frames earlier, within the selected frame range. Everything outside the
 * selection is untouched, which is what makes this composable with the frame
 * span rather than being a whole-animation operation.
 */
export function phaseShift(palettes: Palettes, sel: Selection, opts: PhaseShiftOptions): Palettes {
  const edge = opts.edge ?? 'wrap';
  const inc = opts.increment ?? 0;
  const out = cloneAll(palettes);
  const n = sel.frames.length;
  if (n === 0) return out;

  for (let k = 0; k < sel.entries.length; k++) {
    const e = sel.entries[k];
    const by = Math.floor(opts.shift + k * inc);
    for (let i = 0; i < n; i++) {
      const from = sel.frames[resolveIndex(i - by, n, edge)];
      const src = palettes[from]?.[e];
      const dst = out[sel.frames[i]];
      if (src && dst) dst[e] = { ...src };
    }
  }
  return out;
}
