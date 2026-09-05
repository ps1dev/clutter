import { describe, expect, it } from 'vitest';
import { isZoomNoop, resolveMagnitude } from '../src/shared/zoom.js';

const snapped = { min: 0.1, max: 64, snapIntegersAboveOne: true };
const plain = { min: 4, max: 400 };

describe('resolveMagnitude', () => {
  it('never cancels its own move under integer snapping', () => {
    // The 2026-09-04 bug: round(3 / 1.2) is 3 and round(1 * 1.2) is 1.
    expect(resolveMagnitude(3, 1 / 1.2, snapped)).toBe(2);
    expect(resolveMagnitude(1, 1.2, snapped)).toBe(2);
  });

  it('leaves a move that already works alone', () => {
    expect(resolveMagnitude(8, 1.2, snapped)).toBe(10);
    expect(resolveMagnitude(100, 1.25, plain)).toBe(125);
  });

  it('reports STUCK by returning the input, at both limits', () => {
    expect(resolveMagnitude(64, 1.2, snapped)).toBe(64);
    expect(resolveMagnitude(400, 1.25, plain)).toBe(400);
    expect(resolveMagnitude(4, 0.8, plain)).toBe(4);
  });

  it('drives isZoomNoop, which is the property both callers key on', () => {
    // The 2026-09-05 bug: at the limit the timeline still recentred on the
    // cursor, so a wheel that could not zoom panned instead.
    expect(isZoomNoop(400, 1.25, plain)).toBe(true);
    expect(isZoomNoop(4, 0.8, plain)).toBe(true);
    expect(isZoomNoop(100, 1.25, plain)).toBe(false);
    expect(isZoomNoop(3, 1 / 1.2, snapped)).toBe(false);
  });

  it('moves in the direction asked for whenever it moves at all', () => {
    for (const start of [0.2, 0.5, 1, 1.4, 3, 7.9, 30, 63]) {
      const up = resolveMagnitude(start, 1.2, snapped);
      const down = resolveMagnitude(start, 1 / 1.2, snapped);
      if (up !== start) expect(up).toBeGreaterThan(start);
      if (down !== start) expect(down).toBeLessThan(start);
    }
  });
});
