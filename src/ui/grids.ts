/**
 * The palette grid and the frame strip, drawn on canvas instead of built out
 * of DOM nodes.
 *
 * WHY, measured in Firefox on a 320x240 image with a 17-frame cycle and a
 * 256-colour palette. The DOM version put ~5,300 elements on the page:
 *
 *     as built              5294 elements    16.4 fps
 *     frame strip emptied    907 elements    28.2 fps
 *     both grids emptied     139 elements    60.2 fps
 *
 * and disabling the checkerboard and the image draw on top of that bought
 * nothing, so canvas work was never the ceiling - element count was. Chromium
 * absorbs it, Firefox does not, and an empty page does 60 fps rAF in both, so
 * it is not the harness either.
 *
 * SCROLLING IS THE BROWSER'S JOB. Each canvas is sized to its natural content
 * size and sits inside an ordinary overflow:auto container; nothing here reads
 * or writes scrollLeft/scrollTop, and hit-testing goes through
 * getBoundingClientRect(), which already accounts for scroll. Hand-rolled
 * scrolling is a large amount of work to get subtly wrong.
 */

import type { ColorFormat, Entry } from '../shared/color.js';

const CHECK = 4;

export interface PaletteGridLayout {
  cell: number;
  gap: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
}

export function paletteLayout(count: number, containerWidth: number, cell = 32, gap = 2): PaletteGridLayout {
  const cols = Math.max(1, Math.floor((containerWidth + gap) / (cell + gap)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return {
    cell,
    gap,
    cols,
    rows,
    width: cols * (cell + gap) - gap,
    height: rows * (cell + gap) - gap,
  };
}

/** Which palette index is at this CSS-pixel point, or null. */
export function paletteHitTest(layout: PaletteGridLayout, count: number, x: number, y: number): number | null {
  const step = layout.cell + layout.gap;
  const col = Math.floor(x / step);
  const row = Math.floor(y / step);
  if (col < 0 || col >= layout.cols || row < 0) return null;
  if (x - col * step > layout.cell || y - row * step > layout.cell) return null;
  const i = row * layout.cols + col;
  return i >= 0 && i < count ? i : null;
}

function checker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = '#222';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#444';
  for (let yy = 0; yy < h; yy += CHECK) {
    for (let xx = 0; xx < w; xx += CHECK) {
      if (((xx / CHECK) + (yy / CHECK)) % 2 === 0) continue;
      ctx.fillRect(x + xx, y + yy, Math.min(CHECK, w - xx), Math.min(CHECK, h - yy));
    }
  }
}

export interface PaletteGridInput {
  palette: Entry[];
  fmt: ColorFormat;
  selected: Set<number>;
  range: [number, number] | null;
  layout: PaletteGridLayout;
  /** Draw the index number on each swatch. Off below ~20px, where it is mush. */
  showIndices?: boolean;
}

export function drawPaletteGrid(ctx: CanvasRenderingContext2D, input: PaletteGridInput): void {
  const { palette, fmt, selected, range, layout } = input;
  const step = layout.cell + layout.gap;
  const labels = input.showIndices ?? layout.cell >= 20;

  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.font = '8px ui-monospace, monospace';
  ctx.textBaseline = 'bottom';

  for (let i = 0; i < palette.length; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const x = col * step;
    const y = row * step;
    const d = fmt.display(palette[i]);

    if (d.a < 255) checker(ctx, x, y, layout.cell, layout.cell);
    if (d.a > 0) {
      ctx.fillStyle = `rgba(${d.r},${d.g},${d.b},${d.a / 255})`;
      ctx.fillRect(x, y, layout.cell, layout.cell);
    }

    const inRange = range !== null && i >= range[0] && i <= range[1];
    const isSel = selected.has(i);
    ctx.lineWidth = 1;
    ctx.strokeStyle = isSel ? '#7ee787' : inRange ? '#e3b341' : '#30363d';
    ctx.strokeRect(x + 0.5, y + 0.5, layout.cell - 1, layout.cell - 1);
    if (isSel) {
      ctx.strokeStyle = '#7ee787';
      ctx.strokeRect(x + 1.5, y + 1.5, layout.cell - 3, layout.cell - 3);
    }

    if (labels) {
      const text = String(i);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillText(text, x + 3, y + layout.cell - 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 2, y + layout.cell - 2);
    }
  }
}

export interface FrameStripLayout {
  cell: number;
  gap: number;
  pad: number;
  height: number;
  width: number;
}

export function frameStripLayout(count: number, cell = 48, gap = 4, pad = 8): FrameStripLayout {
  return {
    cell,
    gap,
    pad,
    height: cell + pad * 2 + 10,
    width: pad * 2 + Math.max(0, count * (cell + gap) - gap),
  };
}

export function frameHitTest(layout: FrameStripLayout, count: number, x: number): number | null {
  const i = Math.floor((x - layout.pad) / (layout.cell + layout.gap));
  return i >= 0 && i < count ? i : null;
}

export interface FrameStripInput {
  frames: { palette: Entry[] }[];
  fmt: ColorFormat;
  current: number;
  loopStart: number | null;
  layout: FrameStripLayout;
}

/**
 * The thumbnails, cached. Drawing them costs one fillRect per palette entry per
 * frame - 4,352 of them on a 17-frame, 256-colour animation - and they only
 * change when the frames themselves do. Playback only moves a highlight, so it
 * blits this and strokes one rectangle.
 */
let thumbCache: HTMLCanvasElement | null = null;
let thumbKey = '';

function thumbnailKey(input: FrameStripInput): string {
  const { frames, fmt, layout } = input;
  let h = 0;
  for (const f of frames) {
    for (const e of f.palette) h = (Math.imul(h, 31) + fmt.pack(e)) | 0;
    h = (Math.imul(h, 31) + f.palette.length) | 0;
  }
  return `${frames.length}:${layout.cell}:${layout.width}:${fmt.id}:${h}`;
}

function ensureThumbnails(input: FrameStripInput): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const key = thumbnailKey(input);
  if (thumbCache && thumbKey === key) return thumbCache;

  const { frames, fmt, layout } = input;
  const { cell, gap, pad } = layout;
  if (!thumbCache) thumbCache = document.createElement('canvas');
  thumbCache.width = Math.max(1, layout.width);
  thumbCache.height = Math.max(1, layout.height);
  const c = thumbCache.getContext('2d');
  if (!c) return null;
  c.clearRect(0, 0, thumbCache.width, thumbCache.height);
  for (let i = 0; i < frames.length; i++) {
    const x = pad + i * (cell + gap);
    const palette = frames[i].palette;
    const n = Math.max(1, palette.length);
    const bandH = cell / n;
    for (let k = 0; k < n; k++) {
      const d = fmt.display(palette[k]);
      c.fillStyle = d.a === 0 ? '#1b1f24' : `rgb(${d.r},${d.g},${d.b})`;
      c.fillRect(x, pad + k * bandH, cell, Math.max(1, bandH));
    }
  }
  thumbKey = key;
  return thumbCache;
}

export function drawFrameStrip(ctx: CanvasRenderingContext2D, input: FrameStripInput): void {
  const { frames, fmt, current, loopStart, layout } = input;
  const { cell, gap, pad } = layout;

  ctx.clearRect(0, 0, layout.width, layout.height);
  const cached = ensureThumbnails(input);
  if (cached) ctx.drawImage(cached, 0, 0);
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'top';

  for (let i = 0; i < frames.length; i++) {
    const x = pad + i * (cell + gap);
    const y = pad;
    const palette = frames[i].palette;
    const n = Math.max(1, palette.length);

    // One band per entry. At 256 entries the bands are sub-pixel, which is
    // exactly right: the thumbnail reads as the palette's overall colour, and
    // 256 individually distinguishable swatches would be unreadable anyway.
    if (!cached) {
      const bandH = cell / n;
      for (let k = 0; k < n; k++) {
        const d = fmt.display(palette[k]);
        ctx.fillStyle = d.a === 0 ? '#1b1f24' : `rgb(${d.r},${d.g},${d.b})`;
        ctx.fillRect(x, y + k * bandH, cell, Math.max(1, bandH));
      }
    }

    const before = loopStart !== null && i < loopStart;
    if (before) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x, y, cell, cell);
    }

    ctx.lineWidth = i === current ? 2 : 1;
    ctx.strokeStyle = i === current ? '#7ee787' : '#30363d';
    ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);

    if (loopStart === i) {
      ctx.fillStyle = '#e3b341';
      ctx.beginPath();
      ctx.moveTo(x + cell - 12, y + 1);
      ctx.lineTo(x + cell - 1, y + 1);
      ctx.lineTo(x + cell - 1, y + 12);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = i === current ? '#7ee787' : '#8b949e';
    ctx.fillText(String(i), x + 1, y + cell + 1);
  }
}
