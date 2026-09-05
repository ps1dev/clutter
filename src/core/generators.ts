/**
 * Frame generators. Each one takes a base palette and returns a run of
 * COMPLETE palettes, ready to be inserted into the animation. Nothing stays
 * linked afterwards; see animation.ts for why.
 *
 * OPEN vs CLOSED runs, because getting this wrong is the commonest way an
 * otherwise correct animation stutters at the loop point:
 *   closed  - step k uses t = k/N, so step N would equal step 0 and is not
 *             emitted. This is what you want for anything that returns to
 *             where it started: a full 360 degree hue rotation, a colour cycle.
 *   open    - step k uses t = k/(N-1), so the last frame lands exactly on the
 *             target. This is what you want for a one-shot A to B fade.
 */

import type { Entry } from '../shared/color.js';
import { hsvToRgb, rgbToHsv } from '../shared/hsv.js';

const copy = (p: Entry[]): Entry[] => p.map((e) => ({ ...e }));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function tFor(k: number, steps: number, closed: boolean): number {
  if (steps <= 1) return 0;
  return closed ? k / steps : k / (steps - 1);
}

export interface HsvDelta {
  /** Degrees added to hue. 360 over a closed run is a full rotation. */
  hue?: number;
  /** Multiplier on saturation. 1 leaves it alone. */
  sat?: number;
  /** Multiplier on value. 1 leaves it alone. */
  val?: number;
}

export interface HsvRampOptions {
  base: Entry[];
  /** Which palette entries to touch. Omit for all of them. */
  indices?: number[];
  from: HsvDelta;
  to: HsvDelta;
  steps: number;
  closed?: boolean;
}

const dz = (d: HsvDelta) => ({ hue: d.hue ?? 0, sat: d.sat ?? 1, val: d.val ?? 1 });

/** Ramp an HSV shift from `from` to `to` across `steps` complete palettes. */
export function hsvRamp(opts: HsvRampOptions): Entry[][] {
  const { base, from, to, steps } = opts;
  const closed = opts.closed ?? false;
  const touched = opts.indices ?? base.map((_, i) => i);
  const set = new Set(touched);
  const a = dz(from);
  const b = dz(to);
  const out: Entry[][] = [];
  for (let k = 0; k < steps; k++) {
    const t = tFor(k, steps, closed);
    const dh = lerp(a.hue, b.hue, t);
    const ds = lerp(a.sat, b.sat, t);
    const dv = lerp(a.val, b.val, t);
    const pal = copy(base);
    for (const i of set) {
      const e = base[i];
      if (!e) continue;
      const hsv = rgbToHsv(e.r, e.g, e.b);
      const rgb = hsvToRgb(hsv.h + dh, hsv.s * ds, hsv.v * dv);
      pal[i] = { ...e, r: rgb.r, g: rgb.g, b: rgb.b };
    }
    out.push(pal);
  }
  return out;
}

export interface InterpolateOptions {
  base: Entry[];
  indices: number[];
  /** Target colour each touched entry moves toward. */
  to: Entry;
  steps: number;
  closed?: boolean;
}

/** Straight RGBA interpolation of selected entries toward a single colour. */
export function interpolateTo(opts: InterpolateOptions): Entry[][] {
  const { base, indices, to, steps } = opts;
  const closed = opts.closed ?? false;
  const out: Entry[][] = [];
  for (let k = 0; k < steps; k++) {
    const t = tFor(k, steps, closed);
    const pal = copy(base);
    for (const i of indices) {
      const e = base[i];
      if (!e) continue;
      pal[i] = {
        ...e,
        r: Math.round(lerp(e.r, to.r, t)),
        g: Math.round(lerp(e.g, to.g, t)),
        b: Math.round(lerp(e.b, to.b, t)),
        a: Math.round(lerp(e.a, to.a, t)),
      };
    }
    out.push(pal);
  }
  return out;
}

export type CycleDirection = 'forward' | 'backward';

export interface CycleOptions {
  base: Entry[];
  /** Inclusive range of palette indices to rotate. */
  lo: number;
  hi: number;
  direction?: CycleDirection;
  /** Frames to emit. Defaults to the range length, which is one full loop. */
  steps?: number;
}

/**
 * Deluxe Paint style colour cycling: rotate a contiguous range of palette
 * entries by one position per frame, leaving every other entry alone.
 *
 * `forward` moves colours toward HIGHER indices, which is DPaint's default
 * direction. Step 0 is always the base palette unchanged, and a run of
 * `hi - lo + 1` steps returns to it, so the default run loops seamlessly.
 */
export function cycleRange(opts: CycleOptions): Entry[][] {
  const { base, lo, hi } = opts;
  const dir = opts.direction ?? 'forward';
  const len = hi - lo + 1;
  if (len <= 1) return [copy(base)];
  const steps = Math.max(1, opts.steps ?? len);
  const out: Entry[][] = [];
  for (let k = 0; k < steps; k++) {
    const pal = copy(base);
    for (let i = 0; i < len; i++) {
      const shift = dir === 'forward' ? i - k : i + k;
      const src = ((shift % len) + len) % len;
      pal[lo + i] = { ...base[lo + src] };
    }
    out.push(pal);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection-driven variants (spicyjpeg, 2026-09-04)
//
// The originals all take ONE base palette and emit N copies of it with the
// effect ramped across them. That is right when you are creating frames, and
// wrong when frames already exist: applying a fade to a selected span should
// modify those frames, not replace them with N variations of the first one.
// ---------------------------------------------------------------------------

export interface CycleEntriesOptions {
  base: Entry[];
  /** Palette indices to rotate among each other. Order is normalised to ascending. */
  indices: number[];
  direction?: CycleDirection;
  /**
   * Signed places to shift per frame, fractional allowed. Positive moves
   * colours toward higher indices. 1 is one place per frame; 0.5 is one place
   * every second frame; -0.25 is one place backwards every fourth.
   *
   * Takes precedence over `direction`, which is kept for `cycleRange`.
   */
  increment?: number;
  steps?: number;
  /**
   * Skip step 0, which is the base palette unchanged.
   *
   * The frame you started from already exists in the animation, so emitting it
   * again inserts a duplicate next to itself. With this set, a full loop of N
   * entries is N-1 new frames and the original makes up the Nth.
   */
  skipFirst?: boolean;
}

/**
 * Rotate the colours held at an arbitrary SET of palette indices.
 *
 * A non-contiguous selection is cycled as if it were contiguous: the values
 * move between the selected slots in index order and nothing between them is
 * touched. `cycleRange` is this with a contiguous index list.
 */
export function cycleEntries(opts: CycleEntriesOptions): Entry[][] {
  const { base } = opts;
  const idx = [...new Set(opts.indices)].filter((i) => i >= 0 && i < base.length).sort((a, b) => a - b);
  const dir = opts.direction ?? 'forward';
  const len = idx.length;
  if (len <= 1) return [copy(base)];
  const inc = opts.increment ?? (dir === 'forward' ? 1 : -1);
  const first = opts.skipFirst ? 1 : 0;
  const steps = Math.max(1, opts.steps ?? (opts.skipFirst ? len - 1 : len));
  const out: Entry[][] = [];
  for (let k = first; k < first + steps; k++) {
    // DDA: the integer shift for step k is the rounded value of the exact line
    // k * increment. Evaluated rather than accumulated, so a long run cannot
    // drift the way `acc += inc` does at float precision - same sequence, no
    // error term.
    const pal = copy(base);
    for (let i = 0; i < len; i++) {
      const src = (((i - Math.round(k * inc)) % len) + len) % len;
      pal[idx[i]] = { ...base[idx[src]] };
    }
    out.push(pal);
  }
  return out;
}

export interface OverFramesOptions {
  /** The existing frames to transform, in order. One palette out per frame in. */
  frames: { palette: Entry[] }[];
  indices?: number[];
  closed?: boolean;
}

/** Ramp an HSV shift ACROSS existing frames, transforming each in place. */
export function hsvRampOver(opts: OverFramesOptions & { from: HsvDelta; to: HsvDelta }): Entry[][] {
  const { frames, from, to } = opts;
  const closed = opts.closed ?? false;
  const a = dz(from);
  const b = dz(to);
  return frames.map((f, k) => {
    const t = tFor(k, frames.length, closed);
    const dh = lerp(a.hue, b.hue, t);
    const ds = lerp(a.sat, b.sat, t);
    const dv = lerp(a.val, b.val, t);
    const set = new Set(opts.indices ?? f.palette.map((_, i) => i));
    const pal = copy(f.palette);
    for (const i of set) {
      const e = f.palette[i];
      if (!e) continue;
      const hsv = rgbToHsv(e.r, e.g, e.b);
      const rgb = hsvToRgb(hsv.h + dh, hsv.s * ds, hsv.v * dv);
      pal[i] = { ...e, r: rgb.r, g: rgb.g, b: rgb.b };
    }
    return pal;
  });
}

/** Fade existing frames toward a colour, each frame transformed in place. */
export function interpolateOver(opts: OverFramesOptions & { to: Entry }): Entry[][] {
  const { frames, to } = opts;
  const closed = opts.closed ?? false;
  return frames.map((f, k) => {
    const t = tFor(k, frames.length, closed);
    const set = opts.indices ?? f.palette.map((_, i) => i);
    const pal = copy(f.palette);
    for (const i of set) {
      const e = f.palette[i];
      if (!e) continue;
      pal[i] = {
        ...e,
        r: Math.round(lerp(e.r, to.r, t)),
        g: Math.round(lerp(e.g, to.g, t)),
        b: Math.round(lerp(e.b, to.b, t)),
        a: Math.round(lerp(e.a, to.a, t)),
      };
    }
    return pal;
  });
}
