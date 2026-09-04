import { describe, expect, it } from 'vitest';
import {
  countStalledFrames,
  distinctRampSteps,
  formatById,
  levelOf,
  PS1_NEAR_BLACK,
  PS1_STP_BLACK,
  PS1_TRANSPARENT,
  type Entry,
} from '../src/shared/color.js';

const e = (r: number, g: number, b: number, a = 255, stp = false): Entry => ({ r, g, b, a, stp });

describe('rgb5551 (PlayStation)', () => {
  const f = formatById('rgb5551');

  it('puts red in the LOW bits and blue in the high ones', () => {
    // The discriminator against an RGB/BGR swap: these three must differ, and
    // differ in the specific direction the GPU reads.
    expect(f.pack(e(255, 0, 0))).toBe(0x001f);
    expect(f.pack(e(0, 255, 0))).toBe(0x03e0);
    expect(f.pack(e(0, 0, 255))).toBe(0x7c00);
  });

  it('sets bit 15 for STP and nothing else', () => {
    expect(f.pack(e(0, 0, 0, 255, true))).toBe(PS1_STP_BLACK);
    expect(f.pack(e(255, 255, 255, 255, true))).toBe(0xffff);
  });

  it('reports opaque black as transparent, because the GPU does', () => {
    const black = e(0, 0, 0, 255);
    expect(f.pack(black)).toBe(PS1_TRANSPARENT);
    const snapped = f.snap(black);
    expect(snapped.a).toBe(0);
    expect(f.diagnose(black)).toMatch(/transparent/i);
  });

  it('does NOT report STP black as transparent', () => {
    // The discriminator for the rule above: it must be about the packed value
    // being 0x0000, not about the colour being black.
    const stpBlack = e(0, 0, 0, 255, true);
    expect(f.snap(stpBlack).a).toBe(255);
    expect(f.diagnose(stpBlack)).toBeNull();
    expect(f.diagnose(f.unpack(PS1_NEAR_BLACK))).toBeNull();
  });

  it('round-trips every representable value', () => {
    for (let v = 0; v <= 0xffff; v++) {
      expect(f.pack(f.unpack(v))).toBe(v);
    }
  });
});

describe('rgb565', () => {
  const f = formatById('rgb565');

  it('gives green six bits and the others five', () => {
    // 4 is one green level apart at 6 bits and collapses at 5, so this fails
    // if green were quantized like red.
    expect(f.pack(e(0, 4, 0))).not.toBe(f.pack(e(0, 0, 0)));
    expect(f.pack(e(4, 0, 0))).toBe(f.pack(e(0, 0, 0)));
    expect(levelOf(255, 6)).toBe(63);
  });

  it('has no alpha and says so', () => {
    expect(f.snap(e(10, 20, 30, 0)).a).toBe(255);
    expect(f.diagnose(e(10, 20, 30, 0))).toMatch(/alpha/i);
  });
});

describe('ramp resolution', () => {
  it('knows a black-to-white ramp has 32 distinct steps at 5 bits', () => {
    const f = formatById('rgb5551');
    expect(distinctRampSteps(f, e(0, 0, 0), e(255, 255, 255))).toBe(32);
  });

  it('counts the frames a too-long ramp wastes', () => {
    const f = formatById('rgb5551');
    const frames: Entry[][] = [];
    const steps = 64;
    for (let k = 0; k < steps; k++) {
      const v = Math.round((k / (steps - 1)) * 255);
      frames.push([e(v, v, v)]);
    }
    // 64 requested, 32 distinct available, so half of the transitions are dead.
    expect(countStalledFrames(f, frames)).toBe(steps - 32);
  });

  it('finds no stalls when the ramp is sized to the format', () => {
    const f = formatById('rgb5551');
    const frames: Entry[][] = [];
    for (let k = 0; k < 32; k++) {
      const v = Math.round((k / 31) * 255);
      frames.push([e(v, v, v)]);
    }
    expect(countStalledFrames(f, frames)).toBe(0);
  });
});

describe('rgba8888', () => {
  it('snaps to itself', () => {
    const f = formatById('rgba8888');
    const c = e(1, 2, 3, 4);
    expect(f.snap(c)).toEqual({ r: 1, g: 2, b: 3, a: 4 });
    expect(f.unpack(f.pack(c))).toEqual({ r: 1, g: 2, b: 3, a: 4 });
  });
});
