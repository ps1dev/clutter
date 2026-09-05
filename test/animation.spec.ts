import { describe, expect, it } from 'vitest';
import {
  createAnimation,
  deleteFrame,
  duplicateFrame,
  frameAtTick,
  insertFrames,
  moveFrame,
  entryIsStatic,
  remapColorAcrossFrames,
  setEntryAcrossFrames,
  setHold,
  setLoopStart,
  totalTicks,
  type Animation,
  type Frame,
} from '../src/core/animation.js';
import {
  cycleEntries,
  cycleRange,
  hsvRamp,
  hsvRampOver,
  interpolateOver,
  interpolateTo,
} from '../src/core/generators.js';
import { formatById, type Entry } from '../src/shared/color.js';

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

describe('editing across frames', () => {
  const fmt = formatById('rgb5551');
  const base = [A, B, C, D];
  const cycled: Animation = {
    formatId: 'rgb5551',
    paletteSize: 4,
    frames: cycleRange({ base, lo: 0, hi: 2, steps: 3 }).map((p) => ({ palette: p, hold: 1 })),
    loopStart: 0,
    fps: 60,
  };

  it('knows which entries animate and which do not', () => {
    // Index 3 sits outside the cycled range, so it never moves.
    expect(entryIsStatic(cycled, fmt, 3)).toBe(true);
    expect(entryIsStatic(cycled, fmt, 0)).toBe(false);
  });

  it('writes a slot in every frame', () => {
    const next = setEntryAcrossFrames(cycled, 3, A);
    expect(next.frames.every((f) => f.palette[3].r === 255 && f.palette[3].g === 0)).toBe(true);
  });

  it('honours a frame range', () => {
    const next = setEntryAcrossFrames(cycled, 3, A, { from: 1, to: 1 });
    expect(next.frames[0].palette[3]).toEqual(D);
    expect(next.frames[1].palette[3]).toEqual(A);
    expect(next.frames[2].palette[3]).toEqual(D);
  });

  it('follows a colour through a cycle when remapping by value', () => {
    const white = e(255, 255, 255);
    const { animation, replaced } = remapColorAcrossFrames(cycled, fmt, A, white);
    // A appears once per frame, at a different index each time. The
    // discriminator against the slot-based edit: the index differs per frame.
    expect(replaced).toBe(3);
    const where = animation.frames.map((f) => f.palette.findIndex((x) => x.r === 255 && x.g === 255));
    expect(where).toEqual([0, 1, 2]);
  });

  it('leaves the cycle intact when remapping by value', () => {
    const white = e(255, 255, 255);
    const { animation } = remapColorAcrossFrames(cycled, fmt, A, white);
    // Every frame still holds three distinct colours in the cycled range.
    for (const f of animation.frames) {
      const packed = new Set(f.palette.slice(0, 3).map((x) => fmt.pack(x)));
      expect(packed.size).toBe(3);
    }
  });

  it('flattens the cycle when the slot edit is used instead, which is why both exist', () => {
    const next = setEntryAcrossFrames(cycled, 0, e(255, 255, 255));
    const atZero = new Set(next.frames.map((f) => fmt.pack(f.palette[0])));
    expect(atZero.size).toBe(1);
  });
});

describe('selection-driven generators', () => {
  const base = [A, B, C, D];

  it('cycles a non-contiguous selection as if it were contiguous', () => {
    // Indices 0 and 3 only: their values swap, and 1 and 2 never move.
    const out = cycleEntries({ base, indices: [3, 0], steps: 2 });
    expect(out[0]).toEqual([A, B, C, D]);
    expect(out[1]).toEqual([D, B, C, A]);
  });

  it('normalises selection order to index order', () => {
    const asc = cycleEntries({ base, indices: [0, 1, 2], steps: 3 });
    const desc = cycleEntries({ base, indices: [2, 1, 0], steps: 3 });
    // The discriminator against "cycles in click order": these must agree.
    expect(desc).toEqual(asc);
  });

  it('agrees with cycleRange on a contiguous selection', () => {
    expect(cycleEntries({ base, indices: [0, 1, 2], steps: 3 })).toEqual(
      cycleRange({ base, lo: 0, hi: 2, steps: 3 }),
    );
  });

  it('ramps across EXISTING frames rather than copying the first', () => {
    const frames = [{ palette: [A] }, { palette: [B] }, { palette: [C] }];
    const out = hsvRampOver({ frames, from: { val: 1 }, to: { val: 1 }, closed: false });
    // A zero-strength ramp must leave each frame as ITSELF. If the generator
    // were copying frame 0, all three would come back red.
    expect(out[0][0].r).toBe(255);
    expect(out[1][0].g).toBe(255);
    expect(out[2][0].b).toBe(255);
  });

  it('fades each frame from its own colour', () => {
    const frames = [{ palette: [A] }, { palette: [B] }];
    const out = interpolateOver({ frames, to: e(0, 0, 0), closed: false });
    expect(out[0][0]).toEqual({ ...A });
    // Fully faded to the target, whose alpha is 255 - the fade covers colour,
    // not opacity, unless the target says otherwise.
    expect(out[1][0]).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it('emits exactly one palette per input frame', () => {
    const frames = [{ palette: [A] }, { palette: [B] }, { palette: [C] }, { palette: [D] }];
    expect(interpolateOver({ frames, to: A }).length).toBe(4);
    expect(hsvRampOver({ frames, from: {}, to: { hue: 180 } }).length).toBe(4);
  });
});

describe('fractional cycle increment', () => {
  const base = [A, B, C, D];
  const first = (pal: Entry[]): Entry => pal[0];

  it('shifts one place per frame at increment 1', () => {
    const out = cycleEntries({ base, indices: [0, 1, 2, 3], increment: 1, steps: 4 });
    expect(out.map(first)).toEqual([A, D, C, B]);
  });

  it('holds for two frames at increment 0.5', () => {
    const out = cycleEntries({ base, indices: [0, 1, 2, 3], increment: 0.5, steps: 5 });
    // round(k*0.5) is 0,1,1,2,2 - JS rounds .5 up, so step 1 already moves.
    // Compare by value: the generator copies entries, so identity never matches.
    const key = (e: Entry) => `${e.r},${e.g},${e.b}`;
    const shifts = out.map((p) => base.findIndex((e) => key(e) === key(p[0])));
    expect(shifts).toEqual([0, 3, 3, 2, 2]);
  });

  it('runs backwards on a negative increment', () => {
    const fwd = cycleEntries({ base, indices: [0, 1, 2, 3], increment: 1, steps: 3 });
    const back = cycleEntries({ base, indices: [0, 1, 2, 3], increment: -1, steps: 3 });
    expect(back[1]).not.toEqual(fwd[1]);
    expect(back.map(first)).toEqual([A, B, C]);
  });

  it('does not drift over a long run', () => {
    // The property a DDA buys: step 400 at 0.25 is exactly 100 places, which
    // on a 4-entry palette is the identity. An accumulating float would be off.
    const out = cycleEntries({ base, indices: [0, 1, 2, 3], increment: 0.25, steps: 401 });
    expect(out[400]).toEqual(out[0]);
  });

  it('stands still at increment 0', () => {
    const out = cycleEntries({ base, indices: [0, 1, 2, 3], increment: 0, steps: 4 });
    for (const pal of out) expect(pal).toEqual(base);
  });
});
