/**
 * The animation model: a flat list of PRE-BAKED palettes.
 *
 * Decided with spicyjpeg 2026-09-04, in his words: "Our data model is strictly
 * pre-baked palettes for now: it makes things simpler as they can be packed
 * into texture pages with no additional manipulation at runtime."
 *
 * So there is deliberately no procedural layer here. A generator is a one-way
 * stamp that produces a run of complete palettes and inserts them; nothing
 * stays linked afterwards. The generator's parameters are kept on the frames
 * it produced only so the UI can offer "regenerate with different numbers",
 * which re-stamps rather than re-evaluates.
 *
 * TIMING. `fps` is the tick rate and `hold` is how many ticks a frame stays up.
 * The default is 60/1, which is one palette per vblank on PlayStation, so
 * `hold` reads directly as a vblank count: hold 6 at 60 fps is ten swaps a
 * second. That mapping is the reason for the units.
 */

import type { ColorFormat, Entry, FormatId } from '../shared/color.js';

export interface Frame {
  palette: Entry[];
  /** Ticks this frame stays on screen. Minimum 1. */
  hold: number;
  /** Provenance, for a re-runnable generator stamp. Not evaluated at playback. */
  from?: GeneratorStamp;
}

export interface GeneratorStamp {
  kind: string;
  params: Record<string, unknown>;
  /** Index of this frame within the run the generator produced. */
  step: number;
}

export interface Animation {
  formatId: FormatId;
  paletteSize: number;
  frames: Frame[];
  /** Index playback returns to at the end, or null to play once and stop. */
  loopStart: number | null;
  fps: number;
}

export function createAnimation(
  formatId: FormatId,
  palette: Entry[],
  fps = 60,
): Animation {
  return {
    formatId,
    paletteSize: palette.length,
    frames: [{ palette: palette.map((e) => ({ ...e })), hold: 1 }],
    loopStart: 0,
    fps,
  };
}

const clampIndex = (i: number, len: number): number => Math.min(len - 1, Math.max(0, i));

/**
 * Move a loop point across an edit. Kept in one place on purpose: a loop start
 * that silently drifts when you delete an earlier frame is the kind of bug that
 * only shows up as "the animation looks slightly wrong now".
 */
function shiftLoop(loopStart: number | null, at: number, delta: number, newLen: number): number | null {
  if (loopStart === null) return null;
  if (newLen === 0) return null;
  let next = loopStart;
  if (delta > 0 && loopStart >= at) next = loopStart + delta;
  else if (delta < 0 && loopStart > at) next = loopStart + delta;
  return clampIndex(next, newLen);
}

export function insertFrames(anim: Animation, at: number, frames: Frame[]): Animation {
  const idx = Math.min(anim.frames.length, Math.max(0, at));
  const next = [...anim.frames.slice(0, idx), ...frames, ...anim.frames.slice(idx)];
  return { ...anim, frames: next, loopStart: shiftLoop(anim.loopStart, idx, frames.length, next.length) };
}

export function deleteFrame(anim: Animation, at: number): Animation {
  if (anim.frames.length <= 1) return anim;
  if (at < 0 || at >= anim.frames.length) return anim;
  const next = anim.frames.filter((_, i) => i !== at);
  return { ...anim, frames: next, loopStart: shiftLoop(anim.loopStart, at, -1, next.length) };
}

export function duplicateFrame(anim: Animation, at: number): Animation {
  const src = anim.frames[at];
  if (!src) return anim;
  const copy: Frame = { palette: src.palette.map((e) => ({ ...e })), hold: src.hold };
  return insertFrames(anim, at + 1, [copy]);
}

export function moveFrame(anim: Animation, from: number, to: number): Animation {
  if (from === to) return anim;
  if (from < 0 || from >= anim.frames.length) return anim;
  const dest = clampIndex(to, anim.frames.length);
  const rest = anim.frames.filter((_, i) => i !== from);
  const moved = anim.frames[from];
  const next = [...rest.slice(0, dest), moved, ...rest.slice(dest)];
  let loopStart = anim.loopStart;
  if (loopStart !== null) {
    if (loopStart === from) loopStart = dest;
    else {
      const afterRemove = loopStart > from ? loopStart - 1 : loopStart;
      loopStart = afterRemove >= dest ? afterRemove + 1 : afterRemove;
    }
    loopStart = clampIndex(loopStart, next.length);
  }
  return { ...anim, frames: next, loopStart };
}

export function setEntry(anim: Animation, frame: number, index: number, entry: Entry): Animation {
  const f = anim.frames[frame];
  if (!f || index < 0 || index >= f.palette.length) return anim;
  const palette = f.palette.slice();
  palette[index] = { ...entry };
  const frames = anim.frames.slice();
  // The stamp described a palette this frame no longer has.
  frames[frame] = { palette, hold: f.hold };
  return { ...anim, frames };
}

export function setHold(anim: Animation, frame: number, hold: number): Animation {
  const f = anim.frames[frame];
  if (!f) return anim;
  const frames = anim.frames.slice();
  frames[frame] = { ...f, hold: Math.max(1, Math.round(hold)) };
  return { ...anim, frames };
}

export function setLoopStart(anim: Animation, at: number | null): Animation {
  if (at === null) return { ...anim, loopStart: null };
  return { ...anim, loopStart: clampIndex(at, anim.frames.length) };
}

/** Total ticks in one pass through every frame. */
export function totalTicks(anim: Animation): number {
  return anim.frames.reduce((n, f) => n + Math.max(1, f.hold), 0);
}

/**
 * Which frame is showing at tick `t`. Returns null once a non-looping
 * animation has run out, so the caller can stop the clock rather than hold the
 * last frame forever and call it playback.
 */
export function frameAtTick(anim: Animation, t: number): number | null {
  const total = totalTicks(anim);
  if (total === 0) return null;
  let tick = Math.max(0, Math.floor(t));
  if (tick >= total) {
    if (anim.loopStart === null) return null;
    const head = anim.frames
      .slice(0, anim.loopStart)
      .reduce((n, f) => n + Math.max(1, f.hold), 0);
    const loopLen = total - head;
    if (loopLen <= 0) return anim.frames.length - 1;
    tick = head + ((tick - head) % loopLen);
  }
  let acc = 0;
  for (let i = 0; i < anim.frames.length; i++) {
    acc += Math.max(1, anim.frames[i].hold);
    if (tick < acc) return i;
  }
  return anim.frames.length - 1;
}

/**
 * Editing across frames.
 *
 * Pre-baked palettes have one ergonomic hole: a colour you got wrong is wrong
 * in every frame, and fixing it slot by slot across thirty-two frames is not a
 * thing anyone will do. But "the same slot in every frame" and "the same colour
 * in every frame" are DIFFERENT operations here, and picking the wrong one
 * quietly destroys the animation:
 *
 *   - After a colour cycle, index 5 holds a different colour in every frame.
 *     Writing one value into index 5 everywhere flattens the cycle.
 *   - A background colour that never moves lives at a fixed index and wants
 *     exactly that write.
 *
 * So both exist, and `entryIsStatic` tells the UI which one to offer.
 */


/** True when this palette index holds the same packed value in every frame. */
export function entryIsStatic(anim: Animation, fmt: ColorFormat, index: number): boolean {
  const first = anim.frames[0]?.palette[index];
  if (!first) return false;
  const want = fmt.pack(first);
  return anim.frames.every((f) => {
    const e = f.palette[index];
    return e !== undefined && fmt.pack(e) === want;
  });
}

/** Write one entry into the same slot in every frame, or in a frame range. */
export function setEntryAcrossFrames(
  anim: Animation,
  index: number,
  entry: Entry,
  range?: { from: number; to: number },
): Animation {
  const lo = range ? Math.max(0, Math.min(range.from, range.to)) : 0;
  const hi = range ? Math.min(anim.frames.length - 1, Math.max(range.from, range.to)) : anim.frames.length - 1;
  const frames = anim.frames.map((f, i) => {
    if (i < lo || i > hi) return f;
    if (index < 0 || index >= f.palette.length) return f;
    const palette = f.palette.slice();
    palette[index] = { ...entry };
    return { palette, hold: f.hold };
  });
  return { ...anim, frames };
}

/**
 * Replace one COLOUR wherever it appears, in any slot, in any frame. This is
 * the one that survives cycling: the colour moves between indices frame to
 * frame, so it has to be tracked by value rather than by slot.
 *
 * Matching is on the packed value in `fmt`, so two entries that are
 * indistinguishable on the target hardware are treated as the same colour even
 * if their 8-bit authoring values differ.
 */
export function remapColorAcrossFrames(
  anim: Animation,
  fmt: ColorFormat,
  from: Entry,
  to: Entry,
): { animation: Animation; replaced: number } {
  const want = fmt.pack(from);
  let replaced = 0;
  const frames = anim.frames.map((f) => {
    let touched = false;
    const palette = f.palette.map((e) => {
      if (fmt.pack(e) !== want) return e;
      touched = true;
      replaced++;
      return { ...to };
    });
    return touched ? { palette, hold: f.hold } : f;
  });
  return { animation: { ...anim, frames }, replaced };
}
