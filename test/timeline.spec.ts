import { describe, expect, it } from 'vitest';
import {
  drawTimeline,
  frameAtX,
  PX_PER_TICK_STEPS,
  tickAtX,
  timelineLayout,
  xForTick,
  zoomPxPerTick,
  type TimelineInput,
  type TimelineLayout,
} from '../src/ui/timeline.js';
import { formatById, type Entry } from '../src/shared/color.js';

const e = (r: number, g: number, b: number): Entry => ({ r, g, b, a: 255 });

// The varying-hold fixture called out in the brief: a uniform-hold fixture
// cannot distinguish proportional layout from the old fixed-width strip,
// which is the entire point of this component.
const VARYING_HOLDS = [{ hold: 1 }, { hold: 6 }, { hold: 1 }, { hold: 30 }, { hold: 2 }];

describe('timelineLayout: span geometry', () => {
  it('every span centre maps back to its own index (no floor active)', () => {
    // pxPerTick=4, default minSpanW=3: the narrowest natural width is
    // 1*4=4 > 3, so nothing is floored here - a pure proportionality check.
    const l = timelineLayout(VARYING_HOLDS, 4);
    for (const s of l.spans) {
      expect(frameAtX(l, s.x + s.w / 2)).toBe(s.index);
    }
  });

  it('every span centre maps back to its own index (floor active on some)', () => {
    // pxPerTick=1: hold-1 frames (natural width 1) and the hold-2 frame
    // (natural width 2) are floored to minSpanW=3; hold-6 (6) and hold-30
    // (30) are not. Centre-mapping must hold regardless: frameAtX works off
    // the laid-out spans, not off hold directly.
    const l = timelineLayout(VARYING_HOLDS, 1);
    for (const s of l.spans) {
      expect(frameAtX(l, s.x + s.w / 2)).toBe(s.index);
    }
  });

  it('returns null before the first span and at/after the last', () => {
    const l = timelineLayout(VARYING_HOLDS, 4);
    expect(frameAtX(l, l.pad - 1)).toBeNull();
    expect(frameAtX(l, 0)).toBeNull();
    const last = l.spans[l.spans.length - 1];
    expect(frameAtX(l, last.x + last.w)).toBeNull();
    expect(frameAtX(l, last.x + last.w + 50)).toBeNull();
  });

  it('a hold-30 span is exactly 30x a hold-1 span when neither hits the floor', () => {
    const frames = [{ hold: 1 }, { hold: 30 }];
    // pxPerTick=4: hold-1 -> 4px (>3, unfloored), hold-30 -> 120px.
    const l = timelineLayout(frames, 4);
    expect(l.spans[0].w).toBeCloseTo(4);
    expect(l.spans[1].w).toBeCloseTo(120);
    expect(l.spans[1].w).toBeCloseTo(30 * l.spans[0].w);
  });

  it('a hold-30 span is NOT 30x a hold-1 span once the floor kicks in on the short one', () => {
    const frames = [{ hold: 1 }, { hold: 30 }];
    // pxPerTick=0.5: hold-1 natural=0.5 -> floored to minSpanW=3.
    // hold-30 natural=15 -> unfloored, stays 15.
    const l = timelineLayout(frames, 0.5);
    expect(l.spans[0].w).toBeCloseTo(3); // the floor, not 0.5
    expect(l.spans[1].w).toBeCloseTo(15);
    expect(l.spans[1].w).not.toBeCloseTo(30 * l.spans[0].w);
    expect(l.spans[1].w / l.spans[0].w).toBeLessThan(30);
  });

  it('total width equals the sum of span widths plus padding on both sides', () => {
    for (const pxPerTick of [0.25, 1, 4, 16]) {
      const l = timelineLayout(VARYING_HOLDS, pxPerTick);
      const sum = l.spans.reduce((n, s) => n + s.w, 0);
      expect(l.width).toBeCloseTo(sum + l.pad * 2);
    }
  });

  it('applies custom pad / laneH / minSpanW and folds them into height/width', () => {
    const l = timelineLayout(VARYING_HOLDS, 4, { pad: 20, laneH: 50, minSpanW: 10 });
    expect(l.pad).toBe(20);
    expect(l.laneH).toBe(50);
    expect(l.minSpanW).toBe(10);
    expect(l.height).toBe(l.laneY + l.laneH + 12); // ruler + lane + label row
    const sum = l.spans.reduce((n, s) => n + s.w, 0);
    expect(l.width).toBeCloseTo(sum + 40);
  });

  it('handles zero frames without throwing and reports an empty span list', () => {
    const l = timelineLayout([], 4);
    expect(l.spans).toHaveLength(0);
    expect(l.totalTicks).toBe(0);
    expect(frameAtX(l, l.pad)).toBeNull();
  });
});

describe('tickAtX / xForTick: round trip, floor-aware', () => {
  // pxPerTick=1 on VARYING_HOLDS floors the hold-1 and hold-2 frames
  // (natural widths 1 and 2 < minSpanW 3) while leaving hold-6 and hold-30
  // unfloored - exactly the mixed regime the mapping has to stay correct in.
  const l = timelineLayout(VARYING_HOLDS, 1);

  it('xForTick(tickAtX(x)) round-trips across the full content width', () => {
    const last = l.spans[l.spans.length - 1];
    const x0 = l.pad;
    const x1 = last.x + last.w;
    for (let x = x0; x <= x1; x += 0.7) {
      const t = tickAtX(l, x);
      const back = xForTick(l, t);
      expect(back).toBeCloseTo(x, 5);
    }
  });

  it('tickAtX(xForTick(t)) round-trips across every tick', () => {
    for (let t = 0; t <= l.totalTicks; t += 0.3) {
      const x = xForTick(l, t);
      const back = tickAtX(l, x);
      expect(back).toBeCloseTo(t, 5);
    }
  });

  it('tickAtX clamps to [0, totalTicks] outside the content', () => {
    expect(tickAtX(l, -1000)).toBe(0);
    expect(tickAtX(l, 1_000_000)).toBe(l.totalTicks);
  });

  it('xForTick clamps to the content span for out-of-range ticks', () => {
    const last = l.spans[l.spans.length - 1];
    expect(xForTick(l, -50)).toBeCloseTo(l.spans[0].x);
    expect(xForTick(l, l.totalTicks + 50)).toBeCloseTo(last.x + last.w);
  });

  it('xForTick maps each startTick exactly to its span origin', () => {
    for (const s of l.spans) {
      expect(xForTick(l, s.startTick)).toBeCloseTo(s.x, 6);
    }
  });

  it('an empty layout does not throw and maps everything to pad', () => {
    const empty = timelineLayout([], 4);
    expect(tickAtX(empty, 100)).toBe(0);
    expect(xForTick(empty, 0)).toBe(empty.pad);
  });
});

describe('zoomPxPerTick', () => {
  it('steps up through PX_PER_TICK_STEPS', () => {
    const first = PX_PER_TICK_STEPS[0];
    const second = PX_PER_TICK_STEPS[1];
    expect(zoomPxPerTick(first, 1)).toBe(second);
  });

  it('steps down through PX_PER_TICK_STEPS', () => {
    const last = PX_PER_TICK_STEPS[PX_PER_TICK_STEPS.length - 1];
    const secondLast = PX_PER_TICK_STEPS[PX_PER_TICK_STEPS.length - 2];
    expect(zoomPxPerTick(last, -1)).toBe(secondLast);
  });

  it('does not run off the bottom end', () => {
    const first = PX_PER_TICK_STEPS[0];
    expect(zoomPxPerTick(first, -1)).toBe(first);
  });

  it('does not run off the top end', () => {
    const last = PX_PER_TICK_STEPS[PX_PER_TICK_STEPS.length - 1];
    expect(zoomPxPerTick(last, 1)).toBe(last);
  });

  it('snaps a value that is not itself a step to the nearest one first', () => {
    // 5 sits between steps 4 and 6; nearest is 4, one step down from 4 is 3.
    expect(zoomPxPerTick(5, -1)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// drawTimeline: a hand-rolled fake context recording calls, same approach
// grids.ts's own tests take (they don't cover drawing either). No DOM.
// ---------------------------------------------------------------------------

interface Call {
  m: string;
  a: unknown[];
  fillStyle: string;
  strokeStyle: string;
}

function makeFakeCtx() {
  const calls: Call[] = [];
  const state = { fillStyle: '', strokeStyle: '' };
  const rec =
    (m: string) =>
    (...a: unknown[]) => {
      calls.push({ m, a, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle });
    };
  const ctx = {
    lineWidth: 1,
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    clearRect: rec('clearRect'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    drawImage: rec('drawImage'),
    fillText: rec('fillText'),
    measureText: (text: string) => {
      calls.push({ m: 'measureText', a: [text], fillStyle: state.fillStyle, strokeStyle: state.strokeStyle });
      return { width: text.length * 6 } as TextMetrics;
    },
  };
  Object.defineProperty(ctx, 'fillStyle', {
    get: () => state.fillStyle,
    set: (v: string) => {
      state.fillStyle = v;
    },
  });
  Object.defineProperty(ctx, 'strokeStyle', {
    get: () => state.strokeStyle,
    set: (v: string) => {
      state.strokeStyle = v;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const fmt = formatById('rgba8888');

function buildInput(overrides: Partial<TimelineInput> = {}): { input: TimelineInput; layout: TimelineLayout } {
  const frames = [
    { palette: [e(255, 0, 0), e(0, 255, 0)], hold: 1 },
    { palette: [e(0, 0, 255), e(255, 255, 0)], hold: 6 },
    { palette: [e(1, 2, 3), e(4, 5, 6)], hold: 1 },
    { palette: [e(9, 9, 9), e(8, 8, 8)], hold: 30 },
  ];
  const layout = timelineLayout(frames, 4);
  const input: TimelineInput = {
    frames,
    fmt,
    layout,
    current: 0,
    playheadTick: null,
    selection: null,
    loopStart: null,
    ...overrides,
  };
  return { input, layout };
}

describe('drawTimeline', () => {
  it('does not throw for an empty animation', () => {
    const layout = timelineLayout([], 4);
    const { ctx } = makeFakeCtx();
    expect(() =>
      drawTimeline(ctx, {
        frames: [],
        fmt,
        layout,
        current: 0,
        playheadTick: null,
        selection: null,
        loopStart: null,
      }),
    ).not.toThrow();
  });

  it('clears the canvas to layout.width/height first', () => {
    const { input, layout } = buildInput();
    const { ctx, calls } = makeFakeCtx();
    drawTimeline(ctx, input);
    expect(calls[0].m).toBe('clearRect');
    expect(calls[0].a).toEqual([0, 0, layout.width, layout.height]);
  });

  it('draws a frame index label only for spans wide enough to fit the text', () => {
    // pxPerTick=4: hold-1 spans are 4px wide, far narrower than a measured
    // label ("0" -> 6px + 4px margin = 10px), so they must be skipped;
    // hold-6 (24px) and hold-30 (120px) are wide enough.
    const { input, layout } = buildInput();
    const { ctx, calls } = makeFakeCtx();
    drawTimeline(ctx, input);

    // Ruler tick labels are also numeric fillText calls (e.g. tick "0"), so
    // disambiguate by the y coordinate: only frame labels are drawn at
    // labelY, below the lane.
    const labelY = layout.laneY + layout.laneH + 2;
    const labelledIndices = calls
      .filter((c) => c.m === 'fillText' && c.a[2] === labelY)
      .map((c) => Number(c.a[0] as string));

    expect(labelledIndices).not.toContain(0); // hold-1, 4px, floored-narrow
    expect(labelledIndices).not.toContain(2); // hold-1, 4px, floored-narrow
    expect(labelledIndices).toContain(1); // hold-6, 24px
    expect(labelledIndices).toContain(3); // hold-30, 120px
  });

  it('draws the playhead at the current frame start when playheadTick is null', () => {
    const { input, layout } = buildInput({ current: 2, playheadTick: null });
    const { ctx, calls } = makeFakeCtx();
    drawTimeline(ctx, input);
    const expectedX = xForTick(layout, layout.spans[2].startTick);
    const moves = calls.filter((c) => c.m === 'moveTo');
    const atExpected = moves.some((c) => Math.abs((c.a[0] as number) - (expectedX + 0.5)) < 1e-6);
    expect(atExpected).toBe(true);
  });

  it('draws the playhead at the explicit tick when playing', () => {
    const { input, layout } = buildInput({ current: 0, playheadTick: 20 });
    const { ctx, calls } = makeFakeCtx();
    drawTimeline(ctx, input);
    const expectedX = xForTick(layout, 20);
    const moves = calls.filter((c) => c.m === 'moveTo');
    const atExpected = moves.some((c) => Math.abs((c.a[0] as number) - (expectedX + 0.5)) < 1e-6);
    expect(atExpected).toBe(true);
  });

  it('draws a selection overlay and border', () => {
    const { input } = buildInput({ current: 0, selection: [1, 3] });
    const { ctx, calls } = makeFakeCtx();
    drawTimeline(ctx, input);

    const selectionFill = calls.find((c) => c.m === 'fillRect' && c.fillStyle.includes('88,166,255'));
    const selectionBorder = calls.find((c) => c.m === 'strokeRect' && c.strokeStyle === '#58a6ff');
    expect(selectionFill).toBeDefined();
    expect(selectionBorder).toBeDefined();
  });

  it('draws NO border around the current frame', () => {
    // Removed 2026-09-04: it duplicated the playhead, which already says where
    // the current frame is. Asserted rather than deleted, because "we took the
    // marker out" and "the marker silently stopped drawing" look identical in
    // a suite that only checks what IS drawn.
    const { input } = buildInput({ current: 2, selection: null });
    const { ctx, calls } = makeFakeCtx();
    drawTimeline(ctx, input);
    expect(calls.find((c) => c.m === 'strokeRect' && c.strokeStyle === '#7ee787')).toBeUndefined();
  });

  it('dims spans before loopStart', () => {
    const { input, layout } = buildInput({ loopStart: 2 });
    const { ctx, calls } = makeFakeCtx();
    drawTimeline(ctx, input);
    const dimRects = calls.filter(
      (c) => c.m === 'fillRect' && c.a[0] === layout.spans[0].x && c.a[1] === layout.laneY,
    );
    expect(dimRects.length).toBeGreaterThan(0);
  });
});
