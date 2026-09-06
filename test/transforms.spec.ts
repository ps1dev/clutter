import { describe, expect, it } from 'vitest';
import {
  copyFromIndex,
  interpolateFrames,
  phaseShift,
  resolveIndex,
  resolveSelection,
  setForAllFrames,
} from '../src/core/transforms.js';
import type { Entry } from '../src/shared/color.js';

const c = (n: number): Entry => ({ r: n, g: n, b: n, a: 255 });
/** A frame's palette rendered as its channel numbers, for readable assertions. */
const row = (pal: Entry[]): number[] => pal.map((e) => e.r);
const grid = (p: Entry[][]): number[][] => p.map(row);

/** frames x entries, value = frame*10 + entry. */
function build(frames: number, entries: number): Entry[][] {
  return Array.from({ length: frames }, (_, f) =>
    Array.from({ length: entries }, (_, e) => c(f * 10 + e)),
  );
}

describe('resolveIndex', () => {
  it('wraps negatives correctly, which % alone does not', () => {
    expect(resolveIndex(-1, 4, 'wrap')).toBe(3);
    expect(resolveIndex(-5, 4, 'wrap')).toBe(3);
    expect(resolveIndex(6, 4, 'wrap')).toBe(2);
  });

  it('holds the edge value under clamp', () => {
    expect(resolveIndex(-3, 4, 'clamp')).toBe(0);
    expect(resolveIndex(9, 4, 'clamp')).toBe(3);
    expect(resolveIndex(2, 4, 'clamp')).toBe(2);
  });
});

describe('resolveSelection', () => {
  it('reads an absent selection as everything, on each axis independently', () => {
    expect(resolveSelection(3, 2, null, null)).toEqual({ frames: [0, 1, 2], entries: [0, 1] });
    expect(resolveSelection(3, 4, [1, 2], null).entries).toEqual([0, 1, 2, 3]);
    expect(resolveSelection(3, 4, null, [2, 0]).frames).toEqual([0, 1, 2]);
  });

  it('normalises a reversed span and an unordered entry set', () => {
    expect(resolveSelection(5, 4, [3, 1], [3, 0, 3]).frames).toEqual([1, 2, 3]);
    expect(resolveSelection(5, 4, [3, 1], [3, 0, 3]).entries).toEqual([0, 3]);
  });

  it('drops entry indices outside the palette', () => {
    expect(resolveSelection(2, 3, null, [1, 99, -1]).entries).toEqual([1]);
  });
});

describe('setForAllFrames', () => {
  it('writes only the selected entries, only into the selected frames', () => {
    const p = build(3, 3);
    const sel = resolveSelection(3, 3, [1, 2], [1]);
    const out = grid(setForAllFrames(p, sel, p[0]));
    expect(out).toEqual([
      [0, 1, 2],
      [10, 1, 12],
      [20, 1, 22],
    ]);
  });

  it('covers every frame when no span is selected', () => {
    const p = build(3, 2);
    const sel = resolveSelection(3, 2, null, [0]);
    expect(grid(setForAllFrames(p, sel, p[2]))).toEqual([
      [20, 1],
      [20, 11],
      [20, 21],
    ]);
  });
});

describe('copyFromIndex', () => {
  it('copies within each frame, so an animating source stays animated', () => {
    // The discriminator against reading the source from one fixed frame:
    // each row must take ITS OWN entry 0.
    const p = build(3, 3);
    const sel = resolveSelection(3, 3, null, [1, 2]);
    expect(grid(copyFromIndex(p, sel, 0))).toEqual([
      [0, 0, 0],
      [10, 10, 10],
      [20, 20, 20],
    ]);
  });

  it('leaves the source entry alone even when it is in the selection', () => {
    const p = build(2, 3);
    const sel = resolveSelection(2, 3, null, [0, 1]);
    const out = grid(copyFromIndex(p, sel, 0));
    expect(out[0][0]).toBe(0);
    expect(out[1][0]).toBe(10);
  });
});

describe('phaseShift', () => {
  it('slides a selected entry through time and wraps', () => {
    const p = build(4, 2);
    const sel = resolveSelection(4, 2, null, [1]);
    // Entry 1 shifted by 1: frame f takes frame f-1's value, 0 takes 3's.
    expect(grid(phaseShift(p, sel, { shift: 1 }))).toEqual([
      [0, 31],
      [10, 1],
      [20, 11],
      [30, 21],
    ]);
  });

  it('holds the edge value under clamp instead of wrapping', () => {
    const p = build(4, 2);
    const sel = resolveSelection(4, 2, null, [1]);
    expect(grid(phaseShift(p, sel, { shift: 1, edge: 'clamp' }))).toEqual([
      [0, 1],
      [10, 1],
      [20, 11],
      [30, 21],
    ]);
  });

  it('follows the worked example for the fractional increment', () => {
    // base 2, increment 0.5: entries 0 and 1 shift by 2, entries 2 and 3 by 3.
    const p = build(8, 4);
    const sel = resolveSelection(8, 4, null, [0, 1, 2, 3]);
    const out = phaseShift(p, sel, { shift: 2, increment: 0.5 });
    // Frame 5 should hold frame 3's value for entries 0,1 and frame 2's for 2,3.
    expect(row(out[5])).toEqual([30, 31, 22, 23]);
  });

  it('mirrors on a negative increment, which is what TRUNCATION buys over flooring', () => {
    // spicyjpeg, 2026-09-06: "always truncate towards zero (floor if positive
    // and ceil if negative)". The assertion is that PROPERTY - a run of -0.5
    // steps at the same moments as +0.5 and in the other direction - rather
    // than a restatement of trunc(). Flooring passes the worked example above
    // and fails this: floor(-2 + k*-0.5) is -2,-3,-3,-4 where trunc is
    // -2,-2,-3,-3, so entry 1 would come from a different frame.
    const p = build(8, 4);
    const sel = resolveSelection(8, 4, null, [0, 1, 2, 3]);
    const pos = phaseShift(p, sel, { shift: 2, increment: 0.5 });
    const neg = phaseShift(p, sel, { shift: -2, increment: -0.5 });
    // Frame 5 under a +2/+3 shift reads frames 3 and 2; under -2/-3 it reads
    // frames 7 and 0 (wrapping), the same distance the other way. Under floor
    // it would read [70, 1, 2, 13] instead - three of the four entries wrong.
    expect(row(pos[5])).toEqual([30, 31, 22, 23]);
    expect(row(neg[5])).toEqual([70, 71, 2, 3]);
  });

  it('shifts backwards on a negative amount', () => {
    const p = build(4, 1);
    const sel = resolveSelection(4, 1, null, null);
    expect(grid(phaseShift(p, sel, { shift: -1 }))).toEqual([[10], [20], [30], [0]]);
  });

  it('is confined to the selected frames', () => {
    const p = build(6, 1);
    const sel = resolveSelection(6, 1, [2, 4], null);
    const out = grid(phaseShift(p, sel, { shift: 1 }));
    // Outside the span, untouched. Inside, rotated among 2..4 only.
    expect(out[0]).toEqual([0]);
    expect(out[1]).toEqual([10]);
    expect(out[5]).toEqual([50]);
    expect([out[2][0], out[3][0], out[4][0]]).toEqual([40, 20, 30]);
  });

  it('is the identity at shift 0', () => {
    const p = build(4, 3);
    const sel = resolveSelection(4, 3, null, null);
    expect(grid(phaseShift(p, sel, { shift: 0, increment: 0 }))).toEqual(grid(p));
  });
});

describe('interpolateFrames', () => {
  /** frames x entries as {palette, hold}, value = frame*10 + entry. */
  const frames = (n: number, entries: number) =>
    build(n, entries).map((palette, i) => ({ palette, hold: i + 1 }));
  const all = (n: number, entries: number) => resolveSelection(n, entries, null, null);

  it('puts count frames in every gap between adjacent selected frames', () => {
    // Three frames have two gaps, so two per gap is four new frames, not six.
    const out = interpolateFrames(frames(3, 1), all(3, 1), { count: 2 });
    expect(out.frames).toHaveLength(7);
    expect(out.indexMap).toEqual([0, 3, 6]);
  });

  it('interpolates the selected entries and COPIES the unselected ones from the left', () => {
    // The discriminator. Entry 1 is not selected, so in the inserted frame it
    // must be the LEFT frame's 1 - not the right frame's, and not a midpoint.
    // A midpoint would be 11, the right frame's would be 11 as well at these
    // numbers, so the fixture spaces the frames out: left 0/1, right 20/21.
    const src = [
      { palette: [c(0), c(1)], hold: 1 },
      { palette: [c(20), c(21)], hold: 1 },
    ];
    const sel = resolveSelection(2, 2, null, [0]);
    const out = interpolateFrames(src, sel, { count: 1 });
    expect(grid(out.frames.map((f) => f.palette))).toEqual([
      [0, 1],
      [10, 1],
      [20, 21],
    ]);
  });

  it('leaves frames outside the selection alone, and inserts nothing beside them', () => {
    const out = interpolateFrames(frames(4, 1), resolveSelection(4, 1, [1, 2], null), { count: 1 });
    expect(grid(out.frames.map((f) => f.palette))).toEqual([[0], [10], [15], [20], [30]]);
    expect(out.indexMap).toEqual([0, 1, 3, 4]);
  });

  it('takes the hold from the frame on the left', () => {
    const out = interpolateFrames(frames(2, 1), all(2, 1), { count: 2 });
    expect(out.frames.map((f) => f.hold)).toEqual([1, 1, 1, 2]);
  });

  it('is a no-op with nothing to sit between', () => {
    for (const [n, count] of [
      [1, 4],
      [3, 0],
    ] as const) {
      const src = frames(n, 1);
      const out = interpolateFrames(src, all(n, 1), { count });
      expect(out.frames).toHaveLength(n);
      expect(out.indexMap).toEqual(src.map((_, i) => i));
    }
  });

  it('eases the inserted frames without moving the frames that were already there', () => {
    const src = frames(2, 1);
    const lin = interpolateFrames(src, all(2, 1), { count: 3, easing: 'linear' });
    const quad = interpolateFrames(src, all(2, 1), { count: 3, easing: 'quad-in' });
    // Endpoints are the originals under any curve...
    expect([quad.frames[0].palette[0].r, quad.frames[4].palette[0].r]).toEqual([0, 10]);
    // ...and every interior frame lags the linear one under quad-in.
    for (let i = 1; i <= 3; i++) {
      expect(quad.frames[i].palette[0].r).toBeLessThan(lin.frames[i].palette[0].r);
    }
  });

  it('carries no generator stamp onto an inserted frame', () => {
    // The stamp is provenance for a run a generator produced. A tween is not
    // part of that run, and inheriting the left frame's stamp would claim it is.
    const src = [
      { palette: [c(0)], hold: 1, from: { kind: 'cycle', params: {}, step: 0 } },
      { palette: [c(20)], hold: 1 },
    ];
    const out = interpolateFrames(src, all(2, 1), { count: 1 });
    expect((out.frames[1] as { from?: unknown }).from).toBeUndefined();
    expect((out.frames[0] as { from?: unknown }).from).toBeDefined();
  });
});
