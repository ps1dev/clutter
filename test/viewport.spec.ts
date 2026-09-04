import { describe, expect, it } from 'vitest';
import {
  clampView,
  createView,
  DEFAULT_MAX_SCALE,
  DEFAULT_MIN_SCALE,
  OVERSCROLL_FRACTION,
  fitView,
  hitTest,
  panBy,
  render,
  toImage,
  toScreen,
  zoomAt,
  type RenderInput,
  type ViewState,
} from '../src/shared/viewport.js';

// ---------------------------------------------------------------------------
// A tiny deterministic PRNG so property-style tests are reproducible without
// pulling in a fuzzing dependency.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randRange(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

// ---------------------------------------------------------------------------
// toScreen / toImage
// ---------------------------------------------------------------------------

describe('toScreen / toImage round-trip', () => {
  // These are pure CSS-pixel <-> image-pixel maths and are intentionally
  // dpr-INVARIANT by design (see the header comment in viewport.ts): dpr
  // only ever enters at the render() transform boundary. The values 1, 2,
  // 1.5 below are the dpr values the task calls out; here they stand in for
  // representative view scales, exercising exactly the range a dpr-aware
  // caller could plausibly produce (an integer-snapped >=1x zoom next to a
  // fractional one), to show the round-trip holds independent of whether the
  // scale happens to coincide with a common dpr value.
  const dprLikeScales = [1, 2, 1.5];

  it.each(dprLikeScales)('round-trips at scale=%d for fixed points', (scale) => {
    const view: ViewState = { originX: 12.5, originY: -4, scale };
    for (const [ix, iy] of [
      [0, 0],
      [100, 50],
      [-30, 17.25],
      [1000, 1000],
    ]) {
      const s = toScreen(view, ix, iy);
      const back = toImage(view, s.x, s.y);
      expect(back.x).toBeCloseTo(ix, 9);
      expect(back.y).toBeCloseTo(iy, 9);
    }
  });

  it('round-trips for random views and points', () => {
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < 500; i++) {
      const view: ViewState = {
        originX: randRange(rng, -1000, 1000),
        originY: randRange(rng, -1000, 1000),
        scale: randRange(rng, 0.05, 40),
      };
      const ix = randRange(rng, -5000, 5000);
      const iy = randRange(rng, -5000, 5000);
      const s = toScreen(view, ix, iy);
      const back = toImage(view, s.x, s.y);
      expect(back.x).toBeCloseTo(ix, 6);
      expect(back.y).toBeCloseTo(iy, 6);
    }
  });

  it('toScreen places the origin pixel at screen (0,0) when scale=1 and origin=0,0', () => {
    const view: ViewState = { originX: 0, originY: 0, scale: 1 };
    expect(toScreen(view, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// hitTest
// ---------------------------------------------------------------------------

describe('hitTest', () => {
  it('returns the floored image pixel under a screen point inside the image', () => {
    const view: ViewState = { originX: 0, originY: 0, scale: 4 };
    // screen (10, 10) -> image (2.5, 2.5) -> pixel (2, 2)
    expect(hitTest(view, 100, 100, 10, 10)).toEqual({ x: 2, y: 2 });
  });

  it('returns null outside the image bounds, on every edge', () => {
    const view: ViewState = { originX: 0, originY: 0, scale: 1 };
    expect(hitTest(view, 10, 10, -1, 5)).toBeNull(); // left of image
    expect(hitTest(view, 10, 10, 5, -1)).toBeNull(); // above image
    expect(hitTest(view, 10, 10, 10, 5)).toBeNull(); // exactly at right edge (exclusive)
    expect(hitTest(view, 10, 10, 5, 10)).toBeNull(); // exactly at bottom edge (exclusive)
  });

  it('is exact at the last in-bounds pixel just inside the edge', () => {
    const view: ViewState = { originX: 0, originY: 0, scale: 1 };
    expect(hitTest(view, 10, 10, 9.999, 9.999)).toEqual({ x: 9, y: 9 });
  });

  it.each([1, 2, 1.5])('agrees with toImage at scale=%d', (scale) => {
    const view: ViewState = { originX: 3, originY: -2, scale };
    const sx = 37;
    const sy = 21;
    const p = toImage(view, sx, sy);
    expect(hitTest(view, 1000, 1000, sx, sy)).toEqual({
      x: Math.floor(p.x),
      y: Math.floor(p.y),
    });
  });
});

// ---------------------------------------------------------------------------
// zoomAt: the cursor's image point must stay fixed under it
// ---------------------------------------------------------------------------

describe('zoomAt', () => {
  it.each([1, 2, 1.5])(
    'keeps the image point under the cursor fixed on screen, at scale-context=%d',
    (baseScale) => {
      const view: ViewState = { originX: 40, originY: -15, scale: baseScale };
      const sx = 123.4;
      const sy = 88.1;
      const before = toImage(view, sx, sy);

      const zoomed = zoomAt(view, sx, sy, 1.37, { snapIntegerZoom: false });
      const after = toImage(zoomed, sx, sy);

      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
      // And the screen position of that same image point is unchanged too.
      const screenAfter = toScreen(zoomed, before.x, before.y);
      expect(screenAfter.x).toBeCloseTo(sx, 6);
      expect(screenAfter.y).toBeCloseTo(sy, 6);
    },
  );

  it('zooming out is the inverse of zooming in at the same point', () => {
    const view: ViewState = { originX: 5, originY: 5, scale: 3 };
    const zoomedIn = zoomAt(view, 50, 50, 2, { snapIntegerZoom: false });
    const back = zoomAt(zoomedIn, 50, 50, 0.5, { snapIntegerZoom: false });
    expect(back.scale).toBeCloseTo(view.scale, 9);
    expect(back.originX).toBeCloseTo(view.originX, 9);
    expect(back.originY).toBeCloseTo(view.originY, 9);
  });

  it('clamps to minScale/maxScale', () => {
    const view: ViewState = { originX: 0, originY: 0, scale: 1 };
    const tooFar = zoomAt(view, 0, 0, 1000, { maxScale: 16, snapIntegerZoom: false });
    expect(tooFar.scale).toBe(16);
    const tooClose = zoomAt(view, 0, 0, 0.0001, { minScale: 0.2, snapIntegerZoom: false });
    expect(tooClose.scale).toBe(0.2);
  });

  it('snaps to an integer scale at or above 1x by default', () => {
    const view: ViewState = { originX: 0, originY: 0, scale: 1 };
    const zoomed = zoomAt(view, 0, 0, 2.4); // 1 * 2.4 = 2.4 -> snaps to 2
    expect(zoomed.scale).toBe(2);
  });

  it('does not snap below 1x', () => {
    const view: ViewState = { originX: 0, originY: 0, scale: 1 };
    const zoomed = zoomAt(view, 0, 0, 0.3);
    expect(zoomed.scale).toBeCloseTo(0.3, 9);
  });
});

// ---------------------------------------------------------------------------
// panBy
// ---------------------------------------------------------------------------

describe('panBy', () => {
  it('moves the image point at screen origin by exactly the pan delta on screen', () => {
    const view: ViewState = { originX: 0, originY: 0, scale: 2 };
    const before = toScreen(view, 10, 10);
    const panned = panBy(view, 30, -12);
    const after = toScreen(panned, 10, 10);
    expect(after.x - before.x).toBeCloseTo(30, 9);
    expect(after.y - before.y).toBeCloseTo(-12, 9);
  });

  it('is a pure function: does not mutate its input', () => {
    const view: ViewState = { originX: 1, originY: 2, scale: 3 };
    const snapshot = { ...view };
    panBy(view, 5, 5);
    expect(view).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// fitView
// ---------------------------------------------------------------------------

describe('fitView', () => {
  it('picks the limiting dimension and centres the image', () => {
    const view = createView(100, 50);
    const fitted = fitView(view, 100, 50, 400, 300);
    // width-limited: 400/100=4, height-limited: 300/50=6 -> scale=4
    expect(fitted.scale).toBe(4);
    // image is 400x200 at scale 4, viewport is 400x300 -> centred vertically,
    // exactly filling horizontally.
    const topLeft = toScreen(fitted, 0, 0);
    const bottomRight = toScreen(fitted, 100, 50);
    expect(topLeft.x).toBeCloseTo(0, 9);
    expect(bottomRight.x).toBeCloseTo(400, 9);
    expect(topLeft.y).toBeCloseTo(50, 9); // (300-200)/2
    expect(bottomRight.y).toBeCloseTo(250, 9);
  });

  it('fits a portrait image into a landscape viewport', () => {
    const view = createView(50, 200);
    const fitted = fitView(view, 50, 200, 400, 300);
    // width-limited: 400/50=8, height-limited: 300/200=1.5 -> scale=1.5
    expect(fitted.scale).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// clampView
// ---------------------------------------------------------------------------

describe('clampView', () => {
  it('bounds an image smaller than the viewport by the overscroll allowance', () => {
    // viewW = 200/1 = 200, image 50 wide. The window may run half a viewport
    // past either side of the legal range, and no further.
    const slack = 200 * OVERSCROLL_FRACTION;
    const far = clampView({ originX: 999, originY: 999, scale: 1 }, 50, 50, 200, 200);
    expect(far.originX).toBeCloseTo(50 - 200 + slack, 9);
    const near = clampView({ originX: -999, originY: -999, scale: 1 }, 50, 50, 200, 200);
    expect(near.originX).toBeCloseTo(-slack, 9);
    // Some of the image is still on screen at both extremes.
    expect(far.originX).toBeLessThan(50);
    expect(near.originX + 200).toBeGreaterThan(0);
  });

  it('allows a bounded overscroll on a larger image', () => {
    // viewW = 200/2 = 100 image px, so the legal range is [0, 900] and the
    // allowance is half a viewport, 50, either side.
    const slack = 100 * OVERSCROLL_FRACTION;
    const clamped = clampView({ originX: -50, originY: 99999, scale: 2 }, 1000, 1000, 200, 200);
    expect(clamped.originX).toBe(-50);
    expect(clamped.originY).toBe(900 + slack);
    const beyond = clampView({ originX: -99999, originY: 0, scale: 2 }, 1000, 1000, 200, 200);
    expect(beyond.originX).toBe(-slack);
  });

  it('leaves an already-valid origin untouched', () => {
    const view: ViewState = { originX: 100, originY: 100, scale: 2 };
    const clamped = clampView(view, 1000, 1000, 200, 200);
    expect(clamped.originX).toBe(100);
    expect(clamped.originY).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// render(): a fake CanvasRenderingContext2D that actually tracks the
// transform stack, so we can assert on the ABSOLUTE matrix in effect at
// each draw call - not just that a call happened with some arguments.
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number]; // a b c d e f

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  // m1 is the existing (outer) transform, m2 is applied on top of it -
  // matches CanvasRenderingContext2D's translate/scale semantics, which
  // post-multiply onto the current transform.
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = m;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

interface RecordedCall {
  method: string;
  args: unknown[];
  /** Absolute transform in effect WHEN this call was made. */
  matrix: Matrix;
}

class FakeCanvasContext {
  calls: RecordedCall[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  imageSmoothingEnabled = true;

  private matrix: Matrix = IDENTITY;
  private stack: Matrix[] = [];

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args, matrix: this.matrix });
  }

  save(): void {
    this.stack.push(this.matrix);
    this.record('save', []);
  }

  restore(): void {
    const m = this.stack.pop();
    if (m) this.matrix = m;
    this.record('restore', []);
  }

  translate(x: number, y: number): void {
    this.matrix = multiply(this.matrix, [1, 0, 0, 1, x, y]);
    this.record('translate', [x, y]);
  }

  scale(x: number, y: number): void {
    this.matrix = multiply(this.matrix, [x, 0, 0, y, 0, 0]);
    this.record('scale', [x, y]);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.matrix = [a, b, c, d, e, f];
    this.record('setTransform', [a, b, c, d, e, f]);
  }

  resetTransform(): void {
    this.matrix = IDENTITY;
    this.record('resetTransform', []);
  }

  drawImage(...args: unknown[]): void {
    this.record('drawImage', args);
  }

  fillRect(...args: unknown[]): void {
    this.record('fillRect', args);
  }

  strokeRect(...args: unknown[]): void {
    this.record('strokeRect', args);
  }

  beginPath(): void {
    this.record('beginPath', []);
  }

  moveTo(x: number, y: number): void {
    this.record('moveTo', [x, y]);
  }

  lineTo(x: number, y: number): void {
    this.record('lineTo', [x, y]);
  }

  stroke(): void {
    this.record('stroke', []);
  }

  /** Absolute transform right now, for assertions that don't hang off a call. */
  currentMatrix(): Matrix {
    return this.matrix;
  }
}

function fakeImageSource(): CanvasImageSource {
  // render() only ever passes this through to ctx.drawImage on the fake, so
  // its actual shape doesn't matter - it just has to not be an ImageData.
  return { width: 16, height: 16 } as unknown as CanvasImageSource;
}

function baseInput(view: ViewState): RenderInput {
  return {
    source: fakeImageSource(),
    imageW: 16,
    imageH: 16,
    view,
    cssW: 200,
    cssH: 150,
  };
}

describe('render()', () => {
  it('draws the image via a single drawImage call at the expected image-space args', () => {
    const ctx = new FakeCanvasContext();
    const view: ViewState = { originX: 0, originY: 0, scale: 2 };
    render(ctx as unknown as CanvasRenderingContext2D, baseInput(view));

    const draws = ctx.calls.filter((c) => c.method === 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0].args.slice(1)).toEqual([0, 0, 16, 16]);
  });

  it('sets imageSmoothingEnabled=false at or above 1x, true below 1x', () => {
    const ctxA = new FakeCanvasContext();
    render(ctxA as unknown as CanvasRenderingContext2D, baseInput({ originX: 0, originY: 0, scale: 4 }));
    expect(ctxA.imageSmoothingEnabled).toBe(false);

    const ctxB = new FakeCanvasContext();
    render(ctxB as unknown as CanvasRenderingContext2D, baseInput({ originX: 0, originY: 0, scale: 0.5 }));
    expect(ctxB.imageSmoothingEnabled).toBe(true);
  });

  it('draws the checkerboard before the image, in screen space (unaffected by scale)', () => {
    const ctx = new FakeCanvasContext();
    const view: ViewState = { originX: 0, originY: 0, scale: 5 };
    render(ctx as unknown as CanvasRenderingContext2D, {
      ...baseInput(view),
      checkerboard: true,
    });

    const fillIdx = ctx.calls.findIndex((c) => c.method === 'fillRect');
    const drawIdx = ctx.calls.findIndex((c) => c.method === 'drawImage');
    expect(fillIdx).toBeGreaterThanOrEqual(0);
    expect(fillIdx).toBeLessThan(drawIdx);

    // Checker squares are drawn under the ambient (pre-view-scale) transform:
    // the matrix active during the fillRect call must NOT include the 5x
    // view scale.
    const call = ctx.calls[fillIdx];
    expect(call.matrix).toEqual(IDENTITY);
  });

  it('omits the grid below gridMinScale and draws it at/above it', () => {
    const low = new FakeCanvasContext();
    render(low as unknown as CanvasRenderingContext2D, {
      ...baseInput({ originX: 0, originY: 0, scale: 4 }),
      showGrid: true,
      gridMinScale: 8,
    });
    expect(low.calls.some((c) => c.method === 'stroke')).toBe(false);

    const high = new FakeCanvasContext();
    render(high as unknown as CanvasRenderingContext2D, {
      ...baseInput({ originX: 0, originY: 0, scale: 8 }),
      showGrid: true,
      gridMinScale: 8,
    });
    expect(high.calls.some((c) => c.method === 'stroke')).toBe(true);
  });

  it('never calls setTransform or resetTransform (the dpr contract)', () => {
    const ctx = new FakeCanvasContext();
    render(ctx as unknown as CanvasRenderingContext2D, {
      ...baseInput({ originX: 3, originY: 4, scale: 2 }),
      showGrid: true,
      checkerboard: true,
    });
    expect(ctx.calls.some((c) => c.method === 'setTransform')).toBe(false);
    expect(ctx.calls.some((c) => c.method === 'resetTransform')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // THE load-bearing dpr regression test.
  //
  // Simulates exactly what a real caller does: size the canvas backing store
  // in device pixels, then set ctx.setTransform(dpr, 0, 0, dpr, 0, 0) BEFORE
  // calling render() (see timweb/src/main.ts draw()). render() must compose
  // its own translate/scale on TOP of that, never replace it - so the
  // absolute matrix active during the image draw call must equal
  // view.scale * dpr, not just view.scale.
  //
  // This is the actual instrument for the bug described in the task: at
  // dpr=1 this test cannot distinguish "composed correctly" from "reset to
  // identity", which is exactly why the real bug shipped invisibly at dpr=1
  // and broke only at dpr!=1. Parameterising over {1, 2, 1.5} is what makes
  // dpr=2 and dpr=1.5 the cases that actually exercise the contract.
  // -------------------------------------------------------------------------
  it.each([1, 2, 1.5])('composes onto a pre-set dpr=%d transform instead of resetting it', (dpr) => {
    const ctx = new FakeCanvasContext();
    // What the caller does, once, before render():
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const view: ViewState = { originX: 10, originY: -5, scale: 3 };
    render(ctx as unknown as CanvasRenderingContext2D, baseInput(view));

    const draws = ctx.calls.filter((c) => c.method === 'drawImage');
    expect(draws).toHaveLength(1);

    // The image's own (0,0) corner, run through the matrix active at the
    // moment it was drawn, must land at device pixel
    // (-originX*scale*dpr, -originY*scale*dpr).
    const devicePoint = applyMatrix(draws[0].matrix, 0, 0);
    expect(devicePoint.x).toBeCloseTo(-view.originX * view.scale * dpr, 9);
    expect(devicePoint.y).toBeCloseTo(-view.originY * view.scale * dpr, 9);

    // And the effective total scale factor baked into that matrix is
    // view.scale * dpr on both axes.
    expect(draws[0].matrix[0]).toBeCloseTo(view.scale * dpr, 9);
    expect(draws[0].matrix[3]).toBeCloseTo(view.scale * dpr, 9);
  });

  it('grid line width stays ~1 CSS pixel regardless of dpr (1/view.scale, dpr composes separately)', () => {
    for (const dpr of [1, 2, 1.5]) {
      const ctx = new FakeCanvasContext();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const view: ViewState = { originX: 0, originY: 0, scale: 10 };
      render(ctx as unknown as CanvasRenderingContext2D, {
        ...baseInput(view),
        showGrid: true,
        gridMinScale: 8,
      });
      // lineWidth is set in image-space (1/scale); combined with the matrix
      // scale factor (view.scale*dpr) at stroke time, the drawn line width
      // in device pixels is dpr CSS px - i.e. exactly 1 CSS pixel wide.
      const strokeCall = ctx.calls.find((c) => c.method === 'stroke')!;
      const deviceLineWidth = ctx.lineWidth * strokeCall.matrix[0];
      expect(deviceLineWidth).toBeCloseTo(dpr, 9);
    }
  });
});

describe('zooming never cancels itself (spicyjpeg, 2026-09-04)', () => {
  // Reported as two separate symptoms: "in fit-to-window mode it was impossible
  // to zoom out past 300%" and "in 1:1 mode I couldn't zoom in past 100%".
  // One cause: Math.round plus a 1.2 factor is a no-op below the snap
  // granularity, so the scale returns to where it started.
  const at = (scale: number, factor: number): number =>
    zoomAt({ originX: 0, originY: 0, scale }, 100, 100, factor).scale;

  it('zooms out from 3x instead of rounding back to 3x', () => {
    expect(at(3, 1 / 1.2)).toBeLessThan(3);
    expect(at(3, 1 / 1.2)).toBe(2);
  });

  it('zooms in from 1x instead of rounding back to 1x', () => {
    expect(at(1, 1.2)).toBeGreaterThan(1);
    expect(at(1, 1.2)).toBe(2);
  });

  it('leaves a step that already moves alone', () => {
    // 8 * 1.2 = 9.6 -> 10, a real move, so no stepping correction applies.
    expect(at(8, 1.2)).toBe(10);
  });

  it('still moves out of a fractional fit scale', () => {
    expect(at(3.4, 1 / 1.2)).toBe(3);
    expect(at(3, 1 / 1.2)).toBe(2);
  });

  it('drops below 1x smoothly, where there is no snapping', () => {
    expect(at(1, 1 / 1.2)).toBeCloseTo(1 / 1.2, 5);
  });

  it('never runs past the configured bounds', () => {
    const hi = zoomAt({ originX: 0, originY: 0, scale: 64 }, 0, 0, 1.2).scale;
    expect(hi).toBeLessThanOrEqual(DEFAULT_MAX_SCALE);
    const lo = zoomAt({ originX: 0, originY: 0, scale: DEFAULT_MIN_SCALE }, 0, 0, 1 / 1.2).scale;
    expect(lo).toBeGreaterThanOrEqual(DEFAULT_MIN_SCALE);
  });
});

describe('panning past the edges', () => {
  it('lets a corner pixel be brought inboard', () => {
    // 100x100 image at 4x in a 200x200 window: the viewport covers 50 image
    // pixels, so without overscroll the origin stops at 50 and pixel (99,99)
    // sits under the window edge forever.
    const v = clampView({ originX: 999, originY: 999, scale: 4 }, 100, 100, 200, 200);
    expect(v.originX).toBeGreaterThan(50);
    expect(v.originY).toBeGreaterThan(50);
  });

  it('still refuses to lose the image entirely', () => {
    const v = clampView({ originX: 1e6, originY: 1e6, scale: 4 }, 100, 100, 200, 200);
    // Viewport is 50 image px wide; the far edge must still overlap the image.
    expect(v.originX).toBeLessThan(100);
    const back = clampView({ originX: -1e6, originY: -1e6, scale: 4 }, 100, 100, 200, 200);
    expect(back.originX).toBeGreaterThan(-50);
  });
});
