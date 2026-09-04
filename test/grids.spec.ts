import { describe, expect, it } from 'vitest';
import {
  frameHitTest,
  frameStripLayout,
  paletteHitTest,
  paletteLayout,
} from '../src/ui/grids.js';

/**
 * The grids became canvases for performance, and the thing that gets silently
 * lost when DOM nodes become drawn rectangles is the hit-test: a click that
 * lands on the wrong index still selects SOMETHING, so it fails quietly.
 */

describe('palette grid geometry', () => {
  it('fills as many columns as fit and rounds rows up', () => {
    // cell 32 + gap 2 = 34 per column. 260 wide fits 7 (7*34 - 2 = 236).
    const l = paletteLayout(20, 260);
    expect(l.cols).toBe(7);
    expect(l.rows).toBe(3);
    expect(l.width).toBe(7 * 34 - 2);
    expect(l.height).toBe(3 * 34 - 2);
  });

  it('never reports zero columns on a narrow container', () => {
    expect(paletteLayout(16, 1).cols).toBe(1);
  });

  it('maps the centre of every cell back to its own index', () => {
    const count = 40;
    const l = paletteLayout(count, 300);
    for (let i = 0; i < count; i++) {
      const x = (i % l.cols) * (l.cell + l.gap) + l.cell / 2;
      const y = Math.floor(i / l.cols) * (l.cell + l.gap) + l.cell / 2;
      expect(paletteHitTest(l, count, x, y)).toBe(i);
    }
  });

  it('returns null in the gaps rather than the neighbouring swatch', () => {
    const l = paletteLayout(40, 300);
    // One pixel into the gap after column 0.
    expect(paletteHitTest(l, 40, l.cell + 1, 8)).toBeNull();
    expect(paletteHitTest(l, 40, 8, l.cell + 1)).toBeNull();
  });

  it('returns null past the end of the palette, not a wrapped index', () => {
    const l = paletteLayout(3, 300);
    const x = 3 * (l.cell + l.gap) + l.cell / 2;
    expect(paletteHitTest(l, 3, x, l.cell / 2)).toBeNull();
    expect(paletteHitTest(l, 3, -4, l.cell / 2)).toBeNull();
  });
});

describe('frame strip geometry', () => {
  it('grows with the frame count and leaves the padding out of cell 0', () => {
    const a = frameStripLayout(1);
    const b = frameStripLayout(9);
    expect(b.width).toBeGreaterThan(a.width);
    expect(frameHitTest(b, 9, a.pad + 1)).toBe(0);
  });

  it('maps each cell centre to its own frame', () => {
    const l = frameStripLayout(9);
    for (let i = 0; i < 9; i++) {
      expect(frameHitTest(l, 9, l.pad + i * (l.cell + l.gap) + l.cell / 2)).toBe(i);
    }
  });

  it('returns null before the first cell and past the last', () => {
    const l = frameStripLayout(4);
    expect(frameHitTest(l, 4, 0)).toBeNull();
    expect(frameHitTest(l, 4, l.pad + 4 * (l.cell + l.gap) + 1)).toBeNull();
  });
});
