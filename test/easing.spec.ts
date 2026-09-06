import { describe, expect, it } from 'vitest';
import { EASINGS, EASING_IDS, ease, isEasingId } from '../src/shared/easing.js';

const SAMPLES = Array.from({ length: 101 }, (_, i) => i / 100);

describe('easing curves', () => {
  it('every curve hits its endpoints', () => {
    // The tolerance is chosen to DISCRIMINATE rather than to pass. 2^(10t-10)
    // is 2^-10 at t = 0, so an exponential written without its endpoint cases
    // misses by 9.8e-4 and this fails; sine misses by 6e-17 because cos(PI/2)
    // is not exactly zero in double, and that is a fact about libm rather than
    // about the curve. 1e-9 sits between the two by three orders of magnitude
    // either way.
    for (const id of EASING_IDS) {
      expect([id, Math.abs(EASINGS[id].fn(0)) < 1e-9]).toEqual([id, true]);
      expect([id, Math.abs(EASINGS[id].fn(1) - 1) < 1e-9]).toEqual([id, true]);
    }
  });

  it('every curve is non-decreasing across the run', () => {
    for (const id of EASING_IDS) {
      const ys = SAMPLES.map(EASINGS[id].fn);
      for (let i = 1; i < ys.length; i++) {
        expect([id, ys[i] >= ys[i - 1] - 1e-12]).toEqual([id, true]);
      }
    }
  });

  it('every non-linear curve actually differs from linear', () => {
    // The failure this catches is a wiring one: a copy-paste in the table that
    // points two ids at the same function would leave a dropdown entry that
    // silently does nothing, and no other assertion here would notice.
    for (const id of EASING_IDS) {
      if (id === 'linear') continue;
      const maxDelta = Math.max(...SAMPLES.map((t) => Math.abs(EASINGS[id].fn(t) - t)));
      expect([id, maxDelta > 0.01]).toEqual([id, true]);
    }
  });

  it('all thirteen are distinct from each other', () => {
    const sigs = new Set(EASING_IDS.map((id) => SAMPLES.map((t) => EASINGS[id].fn(t).toFixed(6)).join(',')));
    expect(sigs.size).toBe(EASING_IDS.length);
  });

  it('out is the reflection of in, for every family that has both', () => {
    for (const family of ['quad', 'cubic', 'sine', 'expo'] as const) {
      const fin = EASINGS[`${family}-in`].fn;
      const fout = EASINGS[`${family}-out`].fn;
      for (const t of SAMPLES) {
        expect(fout(t)).toBeCloseTo(1 - fin(1 - t), 10);
      }
    }
  });

  it('in-out passes through the middle', () => {
    for (const id of EASING_IDS) {
      if (!id.endsWith('-in-out')) continue;
      expect([id, Math.abs(EASINGS[id].fn(0.5) - 0.5) < 1e-9]).toEqual([id, true]);
    }
  });

  it('an unknown id is linear rather than a crash', () => {
    expect(ease(undefined, 0.3)).toBe(0.3);
    expect(isEasingId('cubic-in')).toBe(true);
    expect(isEasingId('bounce-in')).toBe(false);
  });
});
