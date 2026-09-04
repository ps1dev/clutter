/**
 * The frame timeline: thin vertical strips whose width is proportional to
 * each frame's `hold`, replacing the fixed-48px frame strip in grids.ts.
 *
 * Sibling of grids.ts and deliberately matches its conventions: pure layout
 * functions kept apart from the one impure `draw*` function, hit-testing via
 * layout maths on CSS-pixel coordinates (never DOM), and an offscreen cache
 * for the expensive repeated drawing - the same measured reason grids.ts
 * caches its thumbnails applies here even harder, since playback repaints
 * this at 60 fps: 4,352 fillRect calls on a 17-frame, 256-colour animation
 * if every band were redrawn every frame.
 *
 * THE FLOOR AND THE TICK MAPPING. `hold` can be small (down to 1 tick) and
 * `pxPerTick` can be small too (zoomed out), so a literal `hold * pxPerTick`
 * span can be sub-pixel and unclickable. `minSpanW` floors it. That floor
 * means a span's on-screen width is no longer proportional to its tick
 * length, so `x = tick * pxPerTick` is WRONG once any span in front of it has
 * been floored - the error accumulates. `tickAtX`/`xForTick` instead walk the
 * actual laid-out spans and interpolate within whichever one contains the
 * point, so they stay exactly consistent with what is drawn (and with each
 * other: they are exact inverses, mismatched only at floating-point noise).
 * Get this wrong and the playhead drifts away from the highlighted frame the
 * longer a played-back animation runs at low zoom.
 */

import type { ColorFormat, Entry } from '../shared/color.js';

const DEFAULT_PAD = 8;
const DEFAULT_LANE_H = 32;
const DEFAULT_MIN_SPAN_W = 3;
const RULER_H = 14;
/** Span width at or above which the between-frames grid is worth drawing. */
const GRID_MIN_SPAN_W = 6;
/** Bounds on how far the widget will zoom, in CSS pixels per tick. */
export const MIN_PX_PER_TICK = 0.1;
export const MAX_PX_PER_TICK = 50;
const LABEL_H = 12;

// "Nice" tick-ruler intervals, in ticks. The first one whose on-screen extent
// clears MIN_LABEL_PX is used, so labels never overlap however far zoomed in.
const TICK_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const MIN_LABEL_PX = 36;

export interface TimelineSpan {
  index: number;
  x: number;
  w: number;
  startTick: number;
}

export interface TimelineLayout {
  pxPerTick: number;
  pad: number; // left/right padding in CSS px
  laneY: number; // top of the strip lane
  laneH: number; // height of the strip lane
  height: number; // total canvas height (lane + ruler + labels)
  width: number; // total content width
  totalTicks: number;
  spans: TimelineSpan[]; // one per frame, in order
  minSpanW: number; // floor applied to a 1-tick frame so it stays clickable
}

export function timelineLayout(
  frames: { hold: number }[],
  pxPerTick: number,
  opts: { pad?: number; laneH?: number; minSpanW?: number } = {},
): TimelineLayout {
  const pad = opts.pad ?? DEFAULT_PAD;
  const laneH = opts.laneH ?? DEFAULT_LANE_H;
  const minSpanW = opts.minSpanW ?? DEFAULT_MIN_SPAN_W;

  const spans: TimelineSpan[] = [];
  let x = pad;
  let startTick = 0;
  for (let i = 0; i < frames.length; i++) {
    const hold = Math.max(1, frames[i].hold);
    const w = Math.max(minSpanW, hold * pxPerTick);
    spans.push({ index: i, x, w, startTick });
    x += w;
    startTick += hold;
  }

  return {
    pxPerTick,
    pad,
    laneY: RULER_H,
    laneH,
    height: RULER_H + laneH + LABEL_H,
    width: x + pad,
    totalTicks: startTick,
    spans,
    minSpanW,
  };
}

/** Which frame's span this CSS x falls in, or null outside the content. */
export function frameAtX(layout: TimelineLayout, x: number): number | null {
  const { spans } = layout;
  if (spans.length === 0) return null;
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (x < first.x || x >= last.x + last.w) return null;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (x >= s.x && x < s.x + s.w) return i;
  }
  return null;
}

/** Tick length spanned by span i, derived from the next span's startTick (or totalTicks for the last one) rather than stored, since it always equals the frame's actual (unfloored) hold. */
function spanTickLen(layout: TimelineLayout, i: number): number {
  const s = layout.spans[i];
  const next = layout.spans[i + 1];
  const end = next ? next.startTick : layout.totalTicks;
  return Math.max(1e-9, end - s.startTick);
}

/** Continuous tick position for a CSS x, clamped to [0, totalTicks]. */
export function tickAtX(layout: TimelineLayout, x: number): number {
  const { spans, totalTicks } = layout;
  if (spans.length === 0 || totalTicks <= 0) return 0;
  const first = spans[0];
  const last = spans[spans.length - 1];
  const cx = Math.min(Math.max(x, first.x), last.x + last.w);

  let i = spans.length - 1;
  for (let k = 0; k < spans.length; k++) {
    if (cx < spans[k].x + spans[k].w) {
      i = k;
      break;
    }
  }
  const s = spans[i];
  const frac = s.w > 0 ? (cx - s.x) / s.w : 0;
  const tick = s.startTick + frac * spanTickLen(layout, i);
  return Math.min(totalTicks, Math.max(0, tick));
}

/** Inverse of tickAtX. */
export function xForTick(layout: TimelineLayout, tick: number): number {
  const { spans, totalTicks, pad } = layout;
  if (spans.length === 0) return pad;
  const t = Math.min(totalTicks, Math.max(0, tick));

  let i = spans.length - 1;
  for (let k = 0; k < spans.length; k++) {
    const tickLen = spanTickLen(layout, k);
    if (t < spans[k].startTick + tickLen || k === spans.length - 1) {
      i = k;
      break;
    }
  }
  const s = spans[i];
  const tickLen = spanTickLen(layout, i);
  const frac = tickLen > 0 ? (t - s.startTick) / tickLen : 0;
  return s.x + frac * s.w;
}

export interface TimelineInput {
  frames: { palette: Entry[]; hold: number }[];
  fmt: ColorFormat;
  layout: TimelineLayout;
  current: number; // current frame index
  playheadTick: number | null; // null when not playing; draw at the current frame's start instead
  selection: [number, number] | null; // inclusive frame index span
  loopStart: number | null;
}

/**
 * The palette bands, cached. Playback repaints every band 60 times a second
 * and they only change when the frames, the zoom, or the layout do - see the
 * header comment. Everything that DOES change every frame (playhead,
 * selection, current-frame marker, loop dimming) is drawn fresh on top of the
 * blit, since those are a handful of rects, not thousands of fills.
 */
let bandCache: HTMLCanvasElement | null = null;
let bandKey = '';

function bandCacheKey(input: TimelineInput): string {
  const { frames, fmt, layout } = input;
  let h = 0;
  for (const f of frames) {
    for (const e of f.palette) h = (Math.imul(h, 31) + fmt.pack(e)) | 0;
    h = (Math.imul(h, 31) + f.palette.length) | 0;
  }
  // Spans already encode pxPerTick, every hold, and the minSpanW floor
  // together, so hashing them covers all of that without repeating it.
  let sh = 0;
  for (const s of layout.spans) {
    sh = (Math.imul(sh, 31) + Math.round(s.x * 4)) | 0;
    sh = (Math.imul(sh, 31) + Math.round(s.w * 4)) | 0;
  }
  return `${frames.length}:${layout.width}:${layout.laneH}:${fmt.id}:${h}:${sh}`;
}

function drawBands(
  target: {
    fillStyle: string | CanvasGradient | CanvasPattern;
    fillRect(x: number, y: number, w: number, h: number): void;
  },
  input: TimelineInput,
  yOffset: number,
): void {
  const { frames, fmt, layout } = input;
  for (let i = 0; i < frames.length; i++) {
    const span = layout.spans[i];
    if (!span) continue;
    const palette = frames[i].palette;
    const n = Math.max(1, palette.length);
    const bandH = layout.laneH / n;
    for (let k = 0; k < n; k++) {
      const d = fmt.display(palette[k]);
      target.fillStyle = d.a === 0 ? '#1b1f24' : `rgb(${d.r},${d.g},${d.b})`;
      target.fillRect(span.x, yOffset + k * bandH, span.w, Math.max(1, bandH));
    }
  }
}

function ensureBandCache(input: TimelineInput): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const key = bandCacheKey(input);
  if (bandCache && bandKey === key) return bandCache;

  const { layout } = input;
  if (!bandCache) bandCache = document.createElement('canvas');
  bandCache.width = Math.max(1, layout.width);
  bandCache.height = Math.max(1, layout.laneH);
  const c = bandCache.getContext('2d');
  if (!c) return null;
  c.clearRect(0, 0, bandCache.width, bandCache.height);
  drawBands(c, input, 0);
  bandKey = key;
  return bandCache;
}

function chooseTickStep(pxPerTick: number, minPx = MIN_LABEL_PX): number {
  for (const s of TICK_STEPS) {
    if (s * pxPerTick >= minPx) return s;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

function drawRuler(ctx: CanvasRenderingContext2D, layout: TimelineLayout): void {
  const { width, totalTicks, pxPerTick } = layout;

  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H - 0.5);
  ctx.lineTo(width, RULER_H - 0.5);
  ctx.stroke();

  if (totalTicks <= 0) return;
  const step = chooseTickStep(pxPerTick);
  ctx.font = '8px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#8b949e';
  for (let t = 0; t <= totalTicks; t += step) {
    const x = xForTick(layout, t);
    ctx.strokeStyle = '#30363d';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_H - 5);
    ctx.lineTo(x + 0.5, RULER_H - 0.5);
    ctx.stroke();
    ctx.fillText(String(t), x + 2, 1);
  }
}

export function drawTimeline(ctx: CanvasRenderingContext2D, input: TimelineInput): void {
  const { layout, current, playheadTick, selection, loopStart } = input;
  const { laneY, laneH, width, height } = layout;

  ctx.clearRect(0, 0, width, height);

  drawRuler(ctx, layout);

  const cached = ensureBandCache(input);
  if (cached) {
    ctx.drawImage(cached, 0, laneY);
  } else {
    drawBands(ctx, input, laneY);
  }

  // Loop dimming: frames before loopStart read as inactive, same as grids.ts.
  if (loopStart !== null) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    for (let i = 0; i < loopStart && i < layout.spans.length; i++) {
      const s = layout.spans[i];
      ctx.fillRect(s.x, laneY, s.w, laneH);
    }
  }

  // Selection: translucent overlay + a distinct-coloured border across the
  // inclusive span, visually different from the current-frame marker below
  // since both can be on screen at once and mean different things.
  if (selection) {
    const lo = Math.max(0, Math.min(selection[0], selection[1]));
    const hi = Math.min(layout.spans.length - 1, Math.max(selection[0], selection[1]));
    const from = layout.spans[lo];
    const to = layout.spans[hi];
    if (from && to) {
      const x0 = from.x;
      const x1 = to.x + to.w;
      ctx.fillStyle = 'rgba(88,166,255,0.22)';
      ctx.fillRect(x0, laneY, x1 - x0, laneH);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#58a6ff';
      ctx.strokeRect(x0 + 0.5, laneY + 0.5, Math.max(0, x1 - x0 - 1), laneH - 1);
    }
  }

  // The current frame gets no border: the playhead already says where it is,
  // and two markers for one fact is one marker too many (spicyjpeg, 2026-09-04).
  //
  // What replaces it is a frame grid, drawn only once the spans are wide enough
  // for the lines to separate rather than smear - the same rule the image
  // viewport uses for its pixel grid.
  if (layout.spans.length > 1) {
    const narrowest = Math.min(...layout.spans.map((sp) => sp.w));
    if (narrowest >= GRID_MIN_SPAN_W) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(180, 190, 200, 0.35)';
      ctx.beginPath();
      for (let i = 1; i < layout.spans.length; i++) {
        const gx = Math.round(layout.spans[i].x) + 0.5;
        ctx.moveTo(gx, laneY);
        ctx.lineTo(gx, laneY + laneH);
      }
      ctx.stroke();
    }
  }

  // Loop marker flag, same corner-triangle idea as grids.ts.
  if (loopStart !== null) {
    const s = layout.spans[loopStart];
    if (s) {
      ctx.fillStyle = '#e3b341';
      ctx.beginPath();
      ctx.moveTo(s.x, laneY);
      ctx.lineTo(s.x + Math.min(8, s.w), laneY);
      ctx.lineTo(s.x, laneY + Math.min(8, laneH));
      ctx.closePath();
      ctx.fill();
    }
  }

  // Frame index labels, only where the span is wide enough that a neighbour
  // can't collide with it - measured, not assumed.
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  const labelY = laneY + laneH + 2;
  for (let i = 0; i < layout.spans.length; i++) {
    const s = layout.spans[i];
    const text = String(i);
    const textW = ctx.measureText(text).width;
    if (textW + 4 > s.w) continue;
    ctx.fillStyle = i === current ? '#7ee787' : '#8b949e';
    ctx.fillText(text, s.x + (s.w - textW) / 2, labelY);
  }

  // Playhead: a line through the ruler and lane with a small triangular
  // handle at the top so it reads as draggable. Falls back to the current
  // frame's start tick when nothing is playing.
  const headTick = playheadTick ?? layout.spans[current]?.startTick ?? 0;
  const hx = xForTick(layout, headTick);
  ctx.strokeStyle = '#f78166';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hx + 0.5, 0);
  ctx.lineTo(hx + 0.5, laneY + laneH);
  ctx.stroke();
  ctx.fillStyle = '#f78166';
  ctx.beginPath();
  ctx.moveTo(hx - 4, 0);
  ctx.lineTo(hx + 4, 0);
  ctx.lineTo(hx, 6);
  ctx.closePath();
  ctx.fill();
}

/** Zoom steps, so the caller does not invent its own. */
export const PX_PER_TICK_STEPS: readonly number[] = [
  0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64,
];

export function zoomPxPerTick(current: number, direction: 1 | -1): number {
  const steps = PX_PER_TICK_STEPS;
  let nearest = 0;
  let nearestDiff = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const diff = Math.abs(steps[i] - current);
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearest = i;
    }
  }
  const next = Math.min(steps.length - 1, Math.max(0, nearest + direction));
  return steps[next];
}

// ---------------------------------------------------------------------------
// TimelineView: the widget, with its own interaction.
//
// Shape borrowed from loopy's `WaveformView` (`loop-editor/src/ui/waveform.ts`),
// on spicyjpeg's pointer. Three things it does better than the version this
// file started as:
//
//   - Zoom and pan are a VIEW WINDOW over the tick axis, not a zoom-step
//     ladder. Panning falls out for free and zoom-about-the-cursor is the
//     natural operation rather than a special case.
//   - The interaction lives in the component. The app wires callbacks and
//     never sees a pointer event, so there is one place where a gesture can be
//     wrong.
//   - A BAND test on the y coordinate, so the ruler and the lane can mean
//     different things on one canvas without a mode flag.
//
// What did not transfer: the peak pyramid, because a palette has no
// level-of-detail problem, and the waveform drawing itself.
// ---------------------------------------------------------------------------

export type TimelineBand = 'ruler' | 'lane' | 'labels';

export type TimelineDrag =
  | { kind: 'scrub' }
  | { kind: 'loop' }
  | { kind: 'select'; anchor: number; moved: boolean }
  | { kind: 'pan'; x: number; startTick: number };

/** Grab radius around the loop marker, in CSS pixels. */
const LOOP_HANDLE_PX = 6;

export interface TimelineContent {
  frames: { palette: Entry[]; hold: number }[];
  fmt: ColorFormat;
}

const MIN_WINDOW_TICKS = 4;
/** How far past either end the view may be pushed, as a fraction of the window. */
const OVERSCROLL = 0.5;

export class TimelineView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;

  frames: { palette: Entry[]; hold: number }[] = [];
  fmt: ColorFormat | null = null;
  current = 0;
  loopStart: number | null = null;
  playheadTick: number | null = null;
  selection: [number, number] | null = null;

  viewStartTick = 0;
  viewEndTick = 1;

  /** Wired by the app. The view never mutates the animation itself. */
  onScrub: ((tick: number) => void) | null = null;
  onSelectFrame: ((index: number) => void) | null = null;
  onSelectSpan: ((span: [number, number] | null) => void) | null = null;
  onSetLoop: ((index: number) => void) | null = null;
  onView: (() => void) | null = null;

  /** Exposed for the end-to-end test, the way loopy exposes `_drag`. */
  _drag: TimelineDrag | null = null;
  private _raf: number | null = null;
  private _layout: TimelineLayout = timelineLayout([], 1);
  private _offsetX = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this._bind();
  }

  get cssWidth(): number {
    return this.canvas.clientWidth || 1;
  }
  get windowTicks(): number {
    return Math.max(MIN_WINDOW_TICKS, this.viewEndTick - this.viewStartTick);
  }
  get totalTicks(): number {
    return this.frames.reduce((n, f) => n + Math.max(1, f.hold), 0);
  }

  /**
   * True once the user has zoomed or panned. Until then the view keeps
   * refitting as frames are added, because a window sized to a one-frame
   * animation and never grown shows four ticks of a nine-frame cycle and looks
   * like a broken widget.
   */
  private _userMovedView = false;

  setContent(content: TimelineContent): void {
    this.frames = content.frames;
    this.fmt = content.fmt;
    if (!this._userMovedView || this.viewEndTick <= this.viewStartTick) this.fit();
    else this.setView(this.viewStartTick, this.viewEndTick);
    this.requestDraw();
  }

  fit(): void {
    this._userMovedView = false;
    this.viewStartTick = 0;
    this.viewEndTick = Math.max(MIN_WINDOW_TICKS, this.totalTicks);
    this.onView?.();
    this.requestDraw();
  }

  /**
   * Window bounds come from the px-per-tick limits rather than from the
   * content, and the start may run half a window past either end.
   *
   * Both on spicyjpeg's ask: without overscroll the first and last frames sit
   * under the widget's edges at high zoom and cannot be brought inboard, which
   * is the same complaint he had about the image viewport.
   */
  setView(start: number, end: number): void {
    const total = Math.max(MIN_WINDOW_TICKS, this.totalTicks);
    const w = Math.max(1, this.cssWidth);
    const minLen = w / MAX_PX_PER_TICK;
    const maxLen = Math.max(minLen, Math.min(total, w / MIN_PX_PER_TICK));
    const len = Math.max(minLen, Math.min(maxLen, end - start));
    const slack = len * OVERSCROLL;
    this.viewStartTick = Math.max(-slack, Math.min(total - len + slack, start));
    this.viewEndTick = this.viewStartTick + len;
    this.onView?.();
    this.requestDraw();
  }

  /** Zoom keeping `tick` pinned under the same x. */
  zoomAt(tick: number, factor: number): void {
    this._userMovedView = true;
    const len = this.windowTicks;
    const frac = len > 0 ? (tick - this.viewStartTick) / len : 0.5;
    const next = len * factor;
    this.setView(tick - frac * next, tick - frac * next + next);
  }

  /* ---- coordinates ----------------------------------------------------- */

  private _rebuildLayout(): void {
    const pad = 0;
    const pxPerTick = (this.cssWidth - pad * 2) / this.windowTicks;
    this._layout = timelineLayout(this.frames, pxPerTick, { pad, minSpanW: 0 });
    this._offsetX = xForTick(this._layout, this.viewStartTick);
  }

  /** Canvas-local x -> content x. */
  private _contentX(x: number): number {
    return x + this._offsetX;
  }

  tickAt(x: number): number {
    return tickAtX(this._layout, this._contentX(x));
  }

  frameAt(x: number): number | null {
    return frameAtX(this._layout, this._contentX(x));
  }

  band(y: number): TimelineBand {
    if (y < this._layout.laneY) return 'ruler';
    if (y < this._layout.laneY + this._layout.laneH) return 'lane';
    return 'labels';
  }

  /* ---- drawing --------------------------------------------------------- */

  requestDraw(): void {
    if (this._raf !== null) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.draw();
    });
  }

  draw(): void {
    if (!this.fmt) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.cssWidth;
    this._rebuildLayout();
    const cssH = this._layout.height;

    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, cssW, cssH);

    this.ctx.save();
    this.ctx.translate(-this._offsetX, 0);
    drawTimeline(this.ctx, {
      frames: this.frames,
      fmt: this.fmt,
      layout: this._layout,
      current: this.current,
      playheadTick: this.playheadTick,
      selection: this.selection,
      loopStart: this.loopStart,
    });
    this.ctx.restore();
  }

  /* ---- interaction ----------------------------------------------------- */

  private _localX(ev: PointerEvent | WheelEvent): number {
    return ev.clientX - this.canvas.getBoundingClientRect().left;
  }
  private _localY(ev: PointerEvent | WheelEvent): number {
    return ev.clientY - this.canvas.getBoundingClientRect().top;
  }

  /** Canvas-local x of the loop marker, or null when there is no loop. */
  loopHandleX(): number | null {
    if (this.loopStart === null) return null;
    const span = this._layout.spans[this.loopStart];
    if (!span) return null;
    return span.x - this._offsetX;
  }

  private _nearLoopHandle(x: number): boolean {
    const lx = this.loopHandleX();
    return lx !== null && Math.abs(x - lx) <= LOOP_HANDLE_PX;
  }

  /**
   * Gestures, as spicyjpeg specified them:
   *
   *   drag                 scrub, anywhere on the widget
   *   shift + drag         move the loop point, if the cursor started near it
   *   shift + drag         otherwise, make or move a span selection
   *   middle drag          pan
   *   wheel                zoom about the cursor
   *
   * Scrubbing is the unmodified gesture because it is the one you do
   * constantly; the two editing gestures are behind shift so a stray drag
   * cannot silently move the loop point.
   */
  private _bind(): void {
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (!this.frames.length) return;
      const x = this._localX(ev);
      this.canvas.setPointerCapture(ev.pointerId);

      if (ev.button === 1) {
        this._drag = { kind: 'pan', x, startTick: this.viewStartTick };
        return;
      }
      if (ev.shiftKey) {
        if (this._nearLoopHandle(x)) {
          this._drag = { kind: 'loop' };
          return;
        }
        const i = this.frameAt(x);
        if (i === null) return;
        this._drag = { kind: 'select', anchor: i, moved: false };
        return;
      }
      this._drag = { kind: 'scrub' };
      this.onScrub?.(this.tickAt(x));
    });

    this.canvas.addEventListener('pointermove', (ev) => {
      const x = this._localX(ev);
      const d = this._drag;
      if (!d) {
        // Advertise the loop handle before it is grabbed, or nobody finds it.
        this.canvas.style.cursor = ev.shiftKey && this._nearLoopHandle(x) ? 'ew-resize' : '';
        return;
      }
      if (d.kind === 'pan') {
        this._userMovedView = true;
        const perPx = this.windowTicks / Math.max(1, this.cssWidth);
        const start = d.startTick - (x - d.x) * perPx;
        this.setView(start, start + this.windowTicks);
        return;
      }
      if (d.kind === 'scrub') {
        this.onScrub?.(this.tickAt(x));
        return;
      }
      if (d.kind === 'loop') {
        const i = this.frameAt(x);
        if (i !== null && i !== this.loopStart) this.onSetLoop?.(i);
        return;
      }
      const i = this.frameAt(x);
      if (i === null) return;
      // Only becomes a span once the drag has crossed into another frame.
      // Otherwise a shift-click would emit a one-frame span as well as a
      // selection, and the app would have to guess which was meant.
      if (i !== d.anchor) d.moved = true;
      if (d.moved) {
        this.selection = [Math.min(d.anchor, i), Math.max(d.anchor, i)];
        this.onSelectSpan?.(this.selection);
        this.requestDraw();
      }
    });

    const end = (ev: PointerEvent): void => {
      const d = this._drag;
      this._drag = null;
      if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
      if (d && d.kind === 'select' && !d.moved) {
        this.selection = null;
        this.onSelectSpan?.(null);
        this.onSelectFrame?.(d.anchor);
      }
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        if (!this.frames.length) return;
        ev.preventDefault();
        // A horizontal wheel (or a trackpad's horizontal axis) pans; the
        // vertical one zooms. Checked first, because a horizontal gesture on a
        // trackpad also carries a little deltaY and would otherwise zoom.
        if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
          this._userMovedView = true;
          const perPx = this.windowTicks / Math.max(1, this.cssWidth);
          const start = this.viewStartTick + ev.deltaX * perPx;
          this.setView(start, start + this.windowTicks);
          return;
        }
        const tick = this.tickAt(this._localX(ev));
        this.zoomAt(tick, ev.deltaY > 0 ? 1.25 : 0.8);
      },
      { passive: false },
    );
  }
}
