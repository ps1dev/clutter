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
import { ease, type EasingId } from '../shared/easing.js';

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
   * Extra frames of shift per selected entry, fractional allowed, TRUNCATED
   * TOWARDS ZERO.
   *
   * spicyjpeg's worked example pins the positive half: base 2 with increment
   * 0.5 shifts the first and second selected entries by 2 and the third and
   * fourth by 3. trunc(2 + k * 0.5) for k = 0..3 gives 2, 2, 3, 3; rounding
   * would give 2, 3, 3, 4.
   *
   * His 2026-09-06 ruling pins the negative half too - "floor if positive and
   * ceil if negative" - so a run of -0.5 mirrors it at -2, -2, -3, -3 rather
   * than flooring away to -2, -3, -3, -4. The colour cycle truncates the same
   * way; the two used to disagree.
   */
  increment?: number;
  edge?: EdgeMode;
}

/**
 * Slide selected entries along the TIME axis, each by its own amount.
 *
 * Entry k of the selection takes its colour from `trunc(shift + k*increment)`
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
    const by = Math.trunc(opts.shift + k * inc);
    for (let i = 0; i < n; i++) {
      const from = sel.frames[resolveIndex(i - by, n, edge)];
      const src = palettes[from]?.[e];
      const dst = out[sel.frames[i]];
      if (src && dst) dst[e] = { ...src };
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Interpolate: the one tool here that changes the frame COUNT.
 *
 * Everything above rewrites the matrix in place. This inserts `count` new
 * frames into every gap between adjacent selected frames, tweening the
 * selected entries from the left frame's colour to the right frame's in RGB
 * space. It replaced the old "fade to colour" tool on spicyjpeg's call: an HSB
 * ramp with saturation and brightness multipliers already does what a fade to
 * black or to grey did, and tweening between two frames you actually have is
 * the operation that was missing.
 *
 * Unselected entries are COPIED FROM THE LEFT FRAME, his rule. That is what
 * makes a partial selection usable: tween the four colours of a flame and the
 * background holds still through the inserted frames instead of ghosting.
 * ------------------------------------------------------------------------- */

export interface InterpolateFramesOptions {
  /** New frames to put in each gap. 0 is a no-op. */
  count: number;
  easing?: EasingId;
}

export interface InterpolateFramesResult<F> {
  frames: F[];
  /**
   * Where each ORIGINAL frame ended up. The loop point and the cursor are
   * indices into a list this operation just made longer, and re-deriving them
   * by counting insertions at the call site is the same arithmetic done twice.
   */
  indexMap: number[];
}

/**
 * Insert tween frames between adjacent selected frames.
 *
 * The selection is a contiguous run (see `resolveSelection`), so "adjacent
 * pairs within the selection" and "adjacent pairs in the frame list, both ends
 * selected" are the same set. Nothing is inserted before the first selected
 * frame or after the last: N selected frames have N-1 gaps.
 */
export function interpolateFrames<F extends { palette: Entry[]; hold: number }>(
  frames: F[],
  sel: Selection,
  opts: InterpolateFramesOptions,
): InterpolateFramesResult<F> {
  const count = Math.max(0, Math.floor(opts.count));
  const indexMap = frames.map((_, i) => i);
  if (count === 0 || sel.frames.length < 2) return { frames: frames.slice(), indexMap };

  const gapAfter = new Set(sel.frames.slice(0, -1));
  const out: F[] = [];
  for (let i = 0; i < frames.length; i++) {
    indexMap[i] = out.length;
    const left = frames[i];
    out.push(left);
    if (!gapAfter.has(i)) continue;
    const right = frames[i + 1];
    if (!right) continue;
    for (let j = 1; j <= count; j++) {
      const t = ease(opts.easing, j / (count + 1));
      // Start from a copy of the LEFT frame, so every entry outside the
      // selection is already correct and only the selected ones are written.
      const palette = left.palette.map((e) => ({ ...e }));
      for (const e of sel.entries) {
        const a = left.palette[e];
        const b = right.palette[e];
        if (!a || !b) continue;
        palette[e] = {
          ...a,
          r: Math.round(a.r + (b.r - a.r) * t),
          g: Math.round(a.g + (b.g - a.g) * t),
          b: Math.round(a.b + (b.b - a.b) * t),
          a: Math.round(a.a + (b.a - a.a) * t),
        };
      }
      // `hold` and the STP flag come from the left frame. Neither has a
      // meaningful midpoint - a boolean cannot be tweened, and splitting the
      // hold would change how long the animation runs for, which is not what
      // "insert frames between these two" asks for.
      out.push({ ...left, palette, hold: left.hold, from: undefined } as F);
    }
  }
  return { frames: out, indexMap };
}
