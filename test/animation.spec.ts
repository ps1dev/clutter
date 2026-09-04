import { describe, expect, it } from 'vitest';
import {
  createAnimation,
  deleteFrame,
  duplicateFrame,
  frameAtTick,
  insertFrames,
  moveFrame,
  setHold,
  setLoopStart,
  totalTicks,
  type Animation,
  type Frame,
} from '../src/core/animation.js';
import { cycleRange, hsvRamp, interpolateTo } from '../src/core/generators.js';
import type { Entry } from '../src/shared/color.js';

const e = (r: number, g: number, b: number): Entry => ({ r, g, b, a: 255 });
const A = e(255, 0, 0);
const B = e(0, 255, 0);
const C = e(0, 0, 255);
const D = e(255, 255, 0);

const frame = (tag: number, hold = 1): Frame => ({ palette: [e(tag, tag, tag)], hold });
const tags = (a: Animation): number[] => a.frames.map((f) => f.palette[0].r);

function withFrames(n: number): Animation {
  let anim = createAnimation('rgb5551', [e(0, 0, 0)]);
  anim = { ...anim, frames: Array.from({ length: n }, (_, i) => frame(i)) };
  return anim;
}

describe('frame list edits keep the loop point on the same frame', () => {
  it('shifts the loop forward when frames are inserted before it', () => {
    const anim = setLoopStart(withFrames(4), 2);
    const next = insertFrames(anim, 0, [frame(90), frame(91)]);
    expect(next.loopStart).toBe(4);
    expect(tags(next)[next.loopStart!]).toBe(2);
  });

  it('leaves the loop alone when frames are inserted after it', () => {
    const anim = setLoopStart(withFrames(4), 1);
    const next = insertFrames(anim, 3, [frame(90)]);
    expect(next.loopStart).toBe(1);
    expect(tags(next)[next.loopStart!]).toBe(1);
  });

  it('pulls the loop back when an earlier frame is deleted', () => {
    const anim = setLoopStart(withFrames(4), 2);
    const next = deleteFrame(anim, 0);
    expect(next.loopStart).toBe(1);
    // The discriminator: the loop must still point at the SAME frame, not just
    // at a valid index.
    expect(tags(next)[next.loopStart!]).toBe(2);
  });

  it('follows the loop frame when it is dragged elsewhere', () => {
    const anim = setLoopStart(withFrames(4), 1);
    const next = moveFrame(anim, 1, 3);
    expect(tags(next)).toEqual([0, 2, 3, 1]);
    expect(tags(next)[next.loopStart!]).toBe(1);
  });

  it('keeps pointing at the same frame when an unrelated frame moves past it', () => {
    const anim = setLoopStart(withFrames(4), 2);
    const next = moveFrame(anim, 0, 3);
    expect(tags(next)).toEqual([1, 2, 3, 0]);
    expect(tags(next)[next.loopStart!]).toBe(2);
  });

  it('refuses to delete the last remaining frame', () => {
    const anim = withFrames(1);
    expect(deleteFrame(anim, 0).frames).toHaveLength(1);
  });

  it('duplicates in place without disturbing the loop frame', () => {
    const anim = setLoopStart(withFrames(3), 2);
    const next = duplicateFrame(anim, 0);
    expect(tags(next)).toEqual([0, 0, 1, 2]);
    expect(tags(next)[next.loopStart!]).toBe(2);
  });
});

describe('playback clock', () => {
  it('honours per-frame hold counts', () => {
    let anim = withFrames(3);
    anim = setHold(anim, 1, 4);
    expect(totalTicks(anim)).toBe(6);
    expect([0, 1, 2, 3, 4, 5].map((t) => frameAtTick(anim, t))).toEqual([0, 1, 1, 1, 1, 2]);
  });

  it('stops at the end when there is no loop point', () => {
    const anim = setLoopStart(withFrames(3), null);
    expect(frameAtTick(anim, 2)).toBe(2);
    // Null, not 2. Holding the last frame forever is not playback, and the two
    // are indistinguishable to a caller that only ever gets an index back.
    expect(frameAtTick(anim, 3)).toBeNull();
  });

  it('returns to the loop point rather than to the start', () => {
    const anim = setLoopStart(withFrames(4), 2);
    expect(frameAtTick(anim, 4)).toBe(2);
    expect(frameAtTick(anim, 5)).toBe(3);
    expect(frameAtTick(anim, 6)).toBe(2);
  });
});

describe('cycleRange', () => {
  const base = [A, B, C, D];

  it('moves colours toward higher indices when going forward', () => {
    const out = cycleRange({ base, lo: 0, hi: 2, steps: 3 });
    expect(out[0].slice(0, 3)).toEqual([A, B, C]);
    expect(out[1].slice(0, 3)).toEqual([C, A, B]);
    expect(out[2].slice(0, 3)).toEqual([B, C, A]);
  });

  it('goes the other way backward', () => {
    const fwd = cycleRange({ base, lo: 0, hi: 2, steps: 3, direction: 'forward' });
    const bwd = cycleRange({ base, lo: 0, hi: 2, steps: 3, direction: 'backward' });
    expect(bwd[1].slice(0, 3)).toEqual([B, C, A]);
    // The discriminator: the two directions must actually differ.
    expect(bwd[1]).not.toEqual(fwd[1]);
  });

  it('returns to the base after a full range length, so the run loops', () => {
    const out = cycleRange({ base, lo: 0, hi: 2, steps: 4 });
    expect(out[3]).toEqual(out[0]);
  });

  it('leaves entries outside the range untouched', () => {
    const out = cycleRange({ base, lo: 1, hi: 2, steps: 2 });
    for (const pal of out) {
      expect(pal[0]).toEqual(A);
      expect(pal[3]).toEqual(D);
    }
  });
});

describe('ramp step maths', () => {
  it('closed runs never repeat the first frame', () => {
    const out = hsvRamp({ base: [A], from: { hue: 0 }, to: { hue: 360 }, steps: 4, closed: true });
    expect(out).toHaveLength(4);
    expect(out[0][0]).toEqual(A);
    expect(out[3][0]).not.toEqual(A);
  });

  it('open runs land exactly on the target', () => {
    const out = interpolateTo({ base: [A], indices: [0], to: B, steps: 5, closed: false });
    expect(out[0][0]).toEqual(A);
    expect(out[4][0]).toEqual({ ...B, stp: undefined, a: 255 });
  });

  it('a closed interpolation stops short of the target on purpose', () => {
    const out = interpolateTo({ base: [A], indices: [0], to: B, steps: 5, closed: true });
    expect(out[4][0]).not.toEqual(B);
  });
});
