/**
 * Generic 2D image viewport: pan, zoom, fit-to-window, screen<->image
 * coordinate transforms, hit-testing, and an optional pixel grid.
 *
 * This is domain-free by construction - it knows nothing about indexed
 * images, palettes, or any of this editor's own concepts. It is extracted
 * from timweb's VRAM canvas (`timweb/src/ui/canvas.ts`), which is the same
 * pan/zoom/hit-test machinery welded to PlayStation VRAM semantics (halfword
 * coordinates, texture pages, CLUT alignment). Everything VRAM-specific was
 * left behind; what's here is the reusable half.
 *
 * COORDINATE SPACES, and why device-pixel-ratio never appears below:
 *
 *   IMAGE space   - pixels of the source image/bitmap, origin top-left.
 *   SCREEN space  - CSS pixels of the canvas element, origin top-left. This
 *                   is the space mouse events already arrive in
 *                   (`clientX - canvas.getBoundingClientRect().left`), and
 *                   it is the space every pure function in this file works
 *                   in: `ViewState.scale` is screen-CSS-px per image-px.
 *
 * Device pixels (`canvas.width`, which is CSS width * devicePixelRatio) are
 * a THIRD space that this module deliberately never touches. A real caller
 * sizes the canvas backing store in device pixels and then does exactly one
 * thing to reconcile it with everything else:
 *
 *   ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // once, before render()
 *
 * After that, every canvas drawing command - and every argument this
 * module's `render()` passes to `ctx` - is expressed in CSS pixels, which is
 * exactly the space `toScreen`/`toImage`/`hitTest` already use, so nothing
 * here needs to know dpr exists. The bug this design exists to prevent (and
 * which timweb actually shipped, fixed 2026-09-02) was `render()` calling
 * `ctx.setTransform(1, 0, 0, 1, 0, 0)` internally to reset its own state -
 * which silently discards the caller's dpr scale, so drawing happens in
 * device pixels while hit-testing stays in CSS pixels. The two disagree by
 * exactly a factor of `dpr`, invisible at dpr=1, and read as an
 * incomprehensible cursor drift that grows with zoom and pan at dpr!=1.
 *
 *   render() below NEVER calls ctx.setTransform or ctx.resetTransform. It
 *   only uses ctx.save/ctx.restore/ctx.translate/ctx.scale, which COMPOSE
 *   onto whatever base transform the caller already set. That is the whole
 *   contract: set the dpr transform once, outside this module, and never
 *   let anything downstream reset it.
 */

import { resolveMagnitude } from './zoom.js';

export interface ViewState {
  /** Image-space X of the image pixel drawn at screen X=0. */
  originX: number;
  /** Image-space Y of the image pixel drawn at screen Y=0. */
  originY: number;
  /** Screen (CSS) pixels per image pixel. */
  scale: number;
}

export interface ViewportOptions {
  minScale?: number;
  maxScale?: number;
  /** Integer-snap the scale at or above 1x so pixels stay crisp. Default true. */
  snapIntegerZoom?: boolean;
}

export const DEFAULT_MIN_SCALE = 0.1;
export const DEFAULT_MAX_SCALE = 64;

function resolveScale(scale: number, opts?: ViewportOptions): number {
  const minScale = opts?.minScale ?? DEFAULT_MIN_SCALE;
  const maxScale = opts?.maxScale ?? DEFAULT_MAX_SCALE;
  const snap = opts?.snapIntegerZoom ?? true;

  let s = Math.max(minScale, Math.min(maxScale, scale));
  if (snap && s >= 1) {
    s = Math.round(s);
    // Rounding can only move s towards 1 from above minScale or push it past
    // maxScale by less than one unit; reclamp rather than special-case it.
    s = Math.max(minScale, Math.min(maxScale, s));
  }
  return s;
}

/** A fresh view: image pixel (0,0) at screen (0,0), scale 1x (subject to opts). */
export function createView(imageW: number, imageH: number, opts?: ViewportOptions): ViewState {
  void imageW;
  void imageH;
  return { originX: 0, originY: 0, scale: resolveScale(1, opts) };
}

/**
 * Fit the whole image into a `cssW` x `cssH` viewport, centred, at the
 * largest scale that shows all of it. Deliberately ignores `opts`/scale
 * snapping - "fit" is a request for a specific scale, and snapping it would
 * either crop the image or leave it not actually fitted.
 *
 * The incoming `view` is not read; the signature accepts it so callers can
 * pipe their current `ViewState` through fit/zoom/pan uniformly.
 */
export function fitView(
  view: ViewState,
  imageW: number,
  imageH: number,
  cssW: number,
  cssH: number,
): ViewState {
  void view;
  const scale = imageW > 0 && imageH > 0 ? Math.min(cssW / imageW, cssH / imageH) : 1;
  return {
    scale,
    originX: imageW / 2 - cssW / (2 * scale),
    originY: imageH / 2 - cssH / (2 * scale),
  };
}

/** Image coordinate -> screen (CSS-pixel) coordinate. */
export function toScreen(view: ViewState, ix: number, iy: number): { x: number; y: number } {
  return {
    x: (ix - view.originX) * view.scale,
    y: (iy - view.originY) * view.scale,
  };
}

/** Screen (CSS-pixel) coordinate -> image coordinate. Fractional; floor to use as a pixel index. */
export function toImage(view: ViewState, sx: number, sy: number): { x: number; y: number } {
  return {
    x: sx / view.scale + view.originX,
    y: sy / view.scale + view.originY,
  };
}

/** Which image pixel is under this CSS-pixel point, or null if outside the image bounds. */
export function hitTest(
  view: ViewState,
  imageW: number,
  imageH: number,
  sx: number,
  sy: number,
): { x: number; y: number } | null {
  const p = toImage(view, sx, sy);
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= imageW || y >= imageH) return null;
  return { x, y };
}

/**
 * Zoom about a fixed screen point (the cursor): the image point currently
 * under (sx, sy) stays under (sx, sy) after the zoom. `factor` multiplies
 * the current scale (e.g. 1.2 to zoom in, 1/1.2 to zoom out).
 */
/**
 * The magnitude policy lives in shared/zoom.ts, because the timeline needs the
 * same rule and writing it twice has produced two separate bugs. See that
 * file's header for both.
 */
function stepScale(from: number, factor: number, opts?: ViewportOptions): number {
  return resolveMagnitude(from, factor, {
    min: opts?.minScale ?? DEFAULT_MIN_SCALE,
    max: opts?.maxScale ?? DEFAULT_MAX_SCALE,
    snapIntegersAboveOne: opts?.snapIntegerZoom ?? true,
  });
}

export function zoomAt(
  view: ViewState,
  sx: number,
  sy: number,
  factor: number,
  opts?: ViewportOptions,
): ViewState {
  const scale = stepScale(view.scale, factor, opts);
  // A zoom that cannot change the scale must not move the view either. The
  // timeline had the same bug the other way round: at its limit it kept
  // recentring on the cursor, so a dead wheel event silently panned.
  if (scale === view.scale) return view;
  const before = toImage(view, sx, sy);
  return {
    scale,
    originX: before.x - sx / scale,
    originY: before.y - sy / scale,
  };
}

/**
 * Pan by a screen-space delta. Positive (dxScreen, dyScreen) is the
 * direction the CONTENT moves on screen (i.e. a mouse-drag delta: dragging
 * right moves the image right, matching drag-to-pan in every image editor).
 */
export function panBy(view: ViewState, dxScreen: number, dyScreen: number): ViewState {
  return {
    ...view,
    originX: view.originX - dxScreen / view.scale,
    originY: view.originY - dyScreen / view.scale,
  };
}

/**
 * Keep the viewport sane relative to the image: when the image is smaller
 * than the viewport in a dimension, centre it; otherwise keep the viewport
 * fully inside the image so you can't pan the image entirely off-screen.
 */
/**
 * Keep the image reachable without pinning it to the viewport edges.
 *
 * Hard-clamping the viewport inside the image makes a corner pixel impossible
 * to inspect: at high zoom the thing you want sits under the window edge and
 * there is nowhere to push it. So overscroll is allowed up to
 * `OVERSCROLL_FRACTION` of the viewport in each direction, which is enough to
 * bring any corner to the middle of the screen, and the image can still never
 * be pushed entirely out of sight.
 */
export const OVERSCROLL_FRACTION = 0.5;

export function clampView(
  view: ViewState,
  imageW: number,
  imageH: number,
  cssW: number,
  cssH: number,
): ViewState {
  const viewW = cssW / view.scale;
  const viewH = cssH / view.scale;
  const slackX = viewW * OVERSCROLL_FRACTION;
  const slackY = viewH * OVERSCROLL_FRACTION;

  const originX = Math.max(-slackX, Math.min(imageW - viewW + slackX, view.originX));
  const originY = Math.max(-slackY, Math.min(imageH - viewH + slackY, view.originY));

  return { ...view, originX, originY };
}

export interface RenderInput {
  source: CanvasImageSource | ImageData;
  imageW: number;
  imageH: number;
  view: ViewState;
  /** Viewport size in CSS pixels (NOT canvas.width/height, which are device pixels). */
  cssW: number;
  cssH: number;
  showGrid?: boolean;
  /** Scale (screen px per image px) at or above which the pixel grid is drawn. Default 8. */
  gridMinScale?: number;
  checkerboard?: boolean;
}

const GRID_MIN_SCALE_DEFAULT = 8;
const CHECKER_SIZE = 8;
const CHECKER_LIGHT = '#ffffff';
const CHECKER_DARK = '#cccccc';
const GRID_STROKE = 'rgba(128, 128, 128, 0.5)';

function isImageData(source: CanvasImageSource | ImageData): source is ImageData {
  return typeof ImageData !== 'undefined' && source instanceof ImageData;
}

let checkerTile: HTMLCanvasElement | null = null;
let checkerPattern: CanvasPattern | null = null;

/**
 * Transparency checker, tiled in SCREEN space (does not zoom with the image).
 *
 * Drawn as ONE fillRect through a cached repeating pattern. The obvious
 * two-nested-loops version costs a fillStyle assignment and a fillRect per
 * 8x8 cell, which on a 1400x900 viewport is ~19,600 of each PER FRAME - it
 * was measured as the second largest cost in playback and it scales with the
 * window rather than with the image.
 */
function drawCheckerboard(ctx: CanvasRenderingContext2D, cssW: number, cssH: number): void {
  if (typeof ctx.createPattern !== 'function' || typeof document === 'undefined') {
    // Non-DOM harness: fall back to the direct version so tests still run.
    ctx.save();
    for (let y = 0; y < cssH; y += CHECKER_SIZE) {
      for (let x = 0; x < cssW; x += CHECKER_SIZE) {
        const parity = (Math.round(x / CHECKER_SIZE) + Math.round(y / CHECKER_SIZE)) % 2;
        ctx.fillStyle = parity === 0 ? CHECKER_LIGHT : CHECKER_DARK;
        ctx.fillRect(x, y, CHECKER_SIZE, CHECKER_SIZE);
      }
    }
    ctx.restore();
    return;
  }

  if (!checkerTile) {
    checkerTile = document.createElement('canvas');
    checkerTile.width = CHECKER_SIZE * 2;
    checkerTile.height = CHECKER_SIZE * 2;
    const t = checkerTile.getContext('2d')!;
    t.fillStyle = CHECKER_LIGHT;
    t.fillRect(0, 0, CHECKER_SIZE * 2, CHECKER_SIZE * 2);
    t.fillStyle = CHECKER_DARK;
    t.fillRect(CHECKER_SIZE, 0, CHECKER_SIZE, CHECKER_SIZE);
    t.fillRect(0, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
    checkerPattern = null;
  }
  if (!checkerPattern) checkerPattern = ctx.createPattern(checkerTile, 'repeat');
  if (!checkerPattern) return;

  ctx.save();
  ctx.fillStyle = checkerPattern;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.restore();
}

/**
 * One line per image-pixel boundary, clipped to the visible region. Runs
 * inside the caller's image-space transform (translate+scale already
 * applied), so it zooms with the image - that's what makes it a pixel grid
 * rather than a screen-space overlay like the checkerboard.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  view: ViewState,
  imageW: number,
  imageH: number,
  cssW: number,
  cssH: number,
): void {
  const topLeft = toImage(view, 0, 0);
  const bottomRight = toImage(view, cssW, cssH);
  const minX = Math.max(0, Math.floor(topLeft.x));
  const maxX = Math.min(imageW, Math.ceil(bottomRight.x));
  const minY = Math.max(0, Math.floor(topLeft.y));
  const maxY = Math.min(imageH, Math.ceil(bottomRight.y));
  if (minX >= maxX || minY >= maxY) return;

  ctx.save();
  ctx.lineWidth = 1 / view.scale;
  ctx.strokeStyle = GRID_STROKE;
  ctx.beginPath();
  for (let x = minX; x <= maxX; x++) {
    ctx.moveTo(x, minY);
    ctx.lineTo(x, maxY);
  }
  for (let y = minY; y <= maxY; y++) {
    ctx.moveTo(minX, y);
    ctx.lineTo(maxX, y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * `ImageData` ignores the canvas transform (`putImageData` always writes in
 * device pixels at a fixed offset), so it has to be staged through an
 * offscreen canvas to draw scaled and panned like everything else. Browser
 * only: if `document` is unavailable (e.g. a non-DOM unit test), passing
 * `ImageData` as the source will throw. Pass a `CanvasImageSource` (an
 * `HTMLCanvasElement`, `ImageBitmap`, etc.) instead in that case.
 */
let stagingCanvas: HTMLCanvasElement | null = null;
let stagingCtx: CanvasRenderingContext2D | null = null;

function drawImageDataSource(
  ctx: CanvasRenderingContext2D,
  data: ImageData,
  imageW: number,
  imageH: number,
): void {
  // Cached across calls. Allocating a canvas per frame was costing a full
  // allocation plus a GC cycle at animation rate; the staging canvas only ever
  // needs to change when the image dimensions do.
  if (!stagingCanvas) stagingCanvas = document.createElement('canvas');
  if (stagingCanvas.width !== data.width || stagingCanvas.height !== data.height) {
    stagingCanvas.width = data.width;
    stagingCanvas.height = data.height;
    stagingCtx = null;
  }
  if (!stagingCtx) stagingCtx = stagingCanvas.getContext('2d');
  if (!stagingCtx) throw new Error('viewport: could not get 2D context for offscreen canvas');
  stagingCtx.putImageData(data, 0, 0);
  ctx.drawImage(stagingCanvas, 0, 0, imageW, imageH);
}

/**
 * Draw the image (plus optional checkerboard/grid) into `ctx`.
 *
 * CONTRACT: this function does not set, and never resets, the base canvas
 * transform. If the caller has applied a device-pixel-ratio transform
 * (`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`), it stays in effect throughout
 * and everything drawn here composes onto it correctly. `render()` only
 * calls `ctx.save()`/`ctx.translate()`/`ctx.scale()`/`ctx.restore()` -
 * never `ctx.setTransform()` or `ctx.resetTransform()`. Clearing the canvas
 * is the caller's job, for the same reason it's the caller's job in
 * timweb's `draw()`: it's the one step that wants device pixels.
 */
export function render(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const {
    source,
    imageW,
    imageH,
    view,
    cssW,
    cssH,
    showGrid = false,
    gridMinScale = GRID_MIN_SCALE_DEFAULT,
    checkerboard = false,
  } = input;

  if (checkerboard) drawCheckerboard(ctx, cssW, cssH);

  ctx.save();
  ctx.translate(-view.originX * view.scale, -view.originY * view.scale);
  ctx.scale(view.scale, view.scale);
  ctx.imageSmoothingEnabled = view.scale < 1;

  if (isImageData(source)) {
    drawImageDataSource(ctx, source, imageW, imageH);
  } else {
    ctx.drawImage(source, 0, 0, imageW, imageH);
  }

  if (showGrid && view.scale >= gridMinScale) {
    drawGrid(ctx, view, imageW, imageH, cssW, cssH);
  }

  ctx.restore();
}
