/**
 * clutter application wiring.
 *
 * House style borrowed from timweb: one mutable state object, every mutation
 * ends in a re-render of the panels that depend on it, no framework, no
 * component tree. The canvas viewport follows timweb's own resizeCanvas/draw
 * split and the device-pixel-ratio contract documented in viewport.ts: this
 * file sets ctx.setTransform(dpr,...) once per resize/clear and viewport.ts's
 * render() never touches the transform again. Every coordinate this file
 * hands to hitTest/zoomAt/panBy is a CSS-pixel coordinate straight off
 * getBoundingClientRect() - never a canvas.width/height (device-pixel) one.
 */

import {
  FORMATS,
  formatById,
  PS1_NEAR_BLACK,
  countStalledFrames,
  fromLevel,
  levelOf,
  type ColorFormat,
  type Entry,
  type FormatId,
} from './shared/color.js';
import {
  decodePng,
  type DecodedPng,
  type IndexedImage,
  type TruecolorImage,
} from './shared/png.js';
import { quantize } from './shared/quantize.js';
import {
  fitView,
  hitTest,
  zoomAt,
  panBy,
  clampView,
  render,
  type ViewState,
} from './shared/viewport.js';
import {
  createAnimation,
  insertFrames,
  deleteFrame,
  duplicateFrame,
  moveFrame,
  setEntry,
  setHold,
  setLoopStart,
  type Animation,
  type Frame,
} from './core/animation.js';
import {
  cycleEntries,
  hsvRamp,
  hsvRampOver,
  interpolateOver,
  interpolateTo,
} from './core/generators.js';
import { paletteLut, composeInto, createImageBuffer } from './core/compose.js';
import {
  drawFrameStrip,
  drawPaletteGrid,
  frameHitTest,
  frameStripLayout,
  paletteHitTest,
  paletteLayout,
  type FrameStripLayout,
  type PaletteGridLayout,
} from './ui/grids.js';
import { TimelineView } from './ui/timeline.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const canvasWrap = $('canvas-wrap');
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const readoutEl = $('readout');
const importHint = $('import-hint');

const fileInput = $<HTMLInputElement>('file-png');
const btnImport = $<HTMLButtonElement>('btn-import');
const formatSelect = $<HTMLSelectElement>('format-select');
const formatChangeNote = $('format-change-note');
const btnPlay = $<HTMLButtonElement>('btn-play');
const fpsInput = $<HTMLInputElement>('fps-input');
const colorsInput = $<HTMLInputElement>('colors-input');
const zoomLabel = $('zoom-label');
const btnZoomIn = $<HTMLButtonElement>('btn-zoom-in');
const btnZoomOut = $<HTMLButtonElement>('btn-zoom-out');
const btnFit = $<HTMLButtonElement>('btn-fit');
const btn1to1 = $<HTMLButtonElement>('btn-1to1');

const paletteGrid = $('palette-grid');
const paletteEmpty = $('palette-empty');
const entryEditor = $('entry-editor');
const eARow = $('e-a-row');
const eStpRow = $('e-stp-row');
const eStp = $<HTMLInputElement>('e-stp');
const eHex = $<HTMLInputElement>('e-hex');
const eDiagnose = $('e-diagnose');

const frameStrip = $('frame-strip');
const fInsert = $<HTMLButtonElement>('f-insert');
const fDelete = $<HTMLButtonElement>('f-delete');
const fDuplicate = $<HTMLButtonElement>('f-duplicate');
const fMoveLeft = $<HTMLButtonElement>('f-move-left');
const fMoveRight = $<HTMLButtonElement>('f-move-right');
const fHold = $<HTMLInputElement>('f-hold');
const fLoopSet = $<HTMLButtonElement>('f-loop-set');
const fLoopClear = $<HTMLButtonElement>('f-loop-clear');

const gCycleTarget = $('g-cycle-target');
const gCycleInc = $<HTMLInputElement>('g-cycle-inc');
const gCycleSteps = $<HTMLInputElement>('g-cycle-steps');
const gCycleDistinct = $('g-cycle-distinct');
const gCycleRun = $<HTMLButtonElement>('g-cycle-run');
const gCycleStalled = $('g-cycle-stalled');

const gHsbHueFrom = $<HTMLInputElement>('g-hsb-hue-from');
const gHsbHueTo = $<HTMLInputElement>('g-hsb-hue-to');
const gHsbSat = $<HTMLInputElement>('g-hsb-sat');
const gHsbVal = $<HTMLInputElement>('g-hsb-val');
const gHsbSteps = $<HTMLInputElement>('g-hsb-steps');
const gHsbClosed = $<HTMLInputElement>('g-hsb-closed');
const gHsbDistinct = $('g-hsb-distinct');
const gHsbRun = $<HTMLButtonElement>('g-hsb-run');
const gHsbStalled = $('g-hsb-stalled');

const gFadeColor = $<HTMLInputElement>('g-fade-color');
const gFadeAlpha = $<HTMLInputElement>('g-fade-alpha');
const gFadeSteps = $<HTMLInputElement>('g-fade-steps');
const gFadeClosed = $<HTMLInputElement>('g-fade-closed');
const gFadeDistinct = $('g-fade-distinct');
const gFadeRun = $<HTMLButtonElement>('g-fade-run');
const gFadeStalled = $('g-fade-stalled');

const dlgDiscard = $<HTMLDialogElement>('dlg-discard');
const discardWhat = $('discard-what');
const discardYes = $<HTMLButtonElement>('discard-yes');
const discardNo = $<HTMLButtonElement>('discard-no');
const dlgFormat = $<HTMLDialogElement>('dlg-format');
const btnOpenFormat = $<HTMLButtonElement>('open-format');
const colorsRow = $('colors-row');
const formatApply = $<HTMLButtonElement>('format-apply');
const formatDialogNote = $('format-dialog-note');
const gHsbBlack = $<HTMLInputElement>('g-hsb-black');
const gFadeBlack = $<HTMLInputElement>('g-fade-black');
const dlgCycle = $<HTMLDialogElement>('dlg-cycle');
const dlgHsb = $<HTMLDialogElement>('dlg-hsb');
const dlgFade = $<HTMLDialogElement>('dlg-fade');

// The generators moved out of the sidebar into modals: with the palette grid,
// the buttons and the entry editor all in one scrolling column there were two
// nested scrollbars, and the entry editor - the thing you use most - was the
// one that scrolled off.
for (const [btn, dlg] of [
  ['open-cycle', dlgCycle],
  ['open-hsb', dlgHsb],
  ['open-fade', dlgFade],
] as const) {
  $<HTMLButtonElement>(btn).addEventListener('click', () => {
    updateGeneratorNotes();
    dlg.showModal();
  });
}

const statusFrames = $('s-frames');
const statusHoverFrame = $('s-frame');
const statusLoop = $('s-loop');
const statusHover = $('s-hover');
const statusMsg = $('s-msg');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface AppState {
  formatId: FormatId;
  animation: Animation | null;
  imageW: number;
  imageH: number;
  imageBuffer: ImageData | null;
  indices: Uint8Array | null;
  currentFrame: number;
  selected: Set<number>;
  editingIndex: number | null;
  view: ViewState;
  hover: { x: number; y: number } | null;
  playing: boolean;
  /** Where the playhead sits, in ticks. */
  playheadTick: number;
  /** Unsaved changes. Cleared on load; will be cleared on save once that exists. */
  dirty: boolean;
}

/**
 * `animation` is a property, not a field, so the dirty flag cannot be forgotten
 * at a mutation site. There are nineteen places that reassign it today and
 * there will be more; marking each one by hand is a rule that holds until
 * somebody adds the twentieth. Loading an image is the one assignment that
 * CLEARS it instead, and it says so explicitly via `asClean`.
 */
let animationRef: Animation | null = null;
let suppressDirty = false;

/** Run a mutation that should not set the dirty flag (loading, not editing). */
function asClean(fn: () => void): void {
  suppressDirty = true;
  try {
    fn();
  } finally {
    suppressDirty = false;
  }
}

const state: AppState = {
  formatId: 'rgba8888',
  get animation(): Animation | null {
    return animationRef;
  },
  set animation(v: Animation | null) {
    animationRef = v;
    if (!suppressDirty) state.dirty = true;
  },
  imageW: 0,
  imageH: 0,
  imageBuffer: null,
  indices: null,
  currentFrame: 0,
  selected: new Set(),
  editingIndex: null,
  view: { originX: 0, originY: 0, scale: 1 },
  hover: null,
  playing: false,
  playheadTick: 0,
  dirty: false,
};

const paletteCanvas = $<HTMLCanvasElement>('palette-canvas');
const paletteCanvasCtx = paletteCanvas.getContext('2d')!;
const stripCanvas = $<HTMLCanvasElement>('strip-canvas');
const timeline = new TimelineView(stripCanvas);
/** Frame span selected on the timeline, inclusive, or null. */
let frameSpan: [number, number] | null = null;
let paletteGridLayout: PaletteGridLayout = paletteLayout(0, 260);
let stripLayout: FrameStripLayout = frameStripLayout(0);

/**
 * Size a canvas's backing store in device pixels and its box in CSS pixels,
 * then set the transform once. Same contract as the viewport: everything
 * downstream draws and hit-tests in CSS pixels.
 */
function sizeCanvas(c: HTMLCanvasElement, cssW: number, cssH: number): void {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(cssW * dpr));
  c.height = Math.max(1, Math.round(cssH * dpr));
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  c.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
}

let dragging: { x: number; y: number } | null = null;
let dragMoved = false;
let rafId: number | null = null;
let playAnchorTime = 0;
let playAnchorTick = 0;

function setStatus(msg: string): void {
  statusMsg.textContent = msg;
}

// ---------------------------------------------------------------------------
// Canvas sizing / device-pixel-ratio contract
// ---------------------------------------------------------------------------

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvasWrap.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Redraw from the already-composited imageBuffer. Does not recomposite. */
function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvasWrap.getBoundingClientRect();

  // Clear in DEVICE pixels, then hand render() the CSS-pixel base transform.
  // This is the one place device pixels and CSS pixels meet; everything
  // downstream (drawing, hit-testing, panning, zooming) stays in CSS pixels.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#07090b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!state.animation || !state.imageBuffer) return;

  render(ctx, {
    source: state.imageBuffer,
    imageW: state.imageW,
    imageH: state.imageH,
    view: state.view,
    cssW: rect.width,
    cssH: rect.height,
    checkerboard: true,
    showGrid: true,
  });
}

/** Rebuild the current frame's palette LUT, recomposite, and redraw. */
function composeAndDraw(): void {
  if (!state.animation || !state.imageBuffer || !state.indices) {
    draw();
    return;
  }
  const fmt = formatById(state.animation.formatId);
  const frame = state.animation.frames[state.currentFrame];
  const lut = paletteLut(fmt, frame.palette, 256);
  composeInto(state.imageBuffer, state.indices, lut);
  draw();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

btnImport.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  void importFile(file);
});

async function importFile(file: File): Promise<void> {
  if (state.dirty && !(await confirmDiscard(file.name))) return;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    setStatus(`Could not read ${file.name}: ${(err as Error).message}`);
    return;
  }

  let decoded;
  try {
    decoded = await decodePng(bytes);
  } catch (err) {
    setStatus(`Import failed: ${(err as Error).message}`);
    return;
  }

  // Ask for the format BEFORE committing the palette. Changing format is a
  // re-quantization now, not a change of lens, so picking it after the fact
  // means quantizing twice and losing precision to the first pass for nothing.
  pending = { image: decoded, name: file.name };
  openFormatDialog(true);
}

/**
 * Ask before throwing away unsaved work. Resolves true to proceed.
 *
 * A <dialog> rather than window.confirm: confirm() is synchronous, blocks the
 * rAF loop, and cannot be driven by the end-to-end tests. `beforeunload` still
 * has to use the browser's own prompt, because a page cannot draw its own.
 */
function confirmDiscard(what: string): Promise<boolean> {
  discardWhat.textContent = what;
  return new Promise((resolveIt) => {
    const done = (ok: boolean) => () => {
      dlgDiscard.close();
      discardYes.removeEventListener('click', yes);
      discardNo.removeEventListener('click', no);
      resolveIt(ok);
    };
    const yes = done(true);
    const no = done(false);
    discardYes.addEventListener('click', yes);
    discardNo.addEventListener('click', no);
    dlgDiscard.showModal();
  });
}

// The browser will not show custom text here and has not for years; what it
// shows is its own wording. Setting returnValue is what arms it at all.
window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

interface PendingImport {
  image: DecodedPng;
  name: string;
}
let pending: PendingImport | null = null;

/**
 * `atImport` shows the palette-size control, which only ever applies to the
 * image being brought in. Afterwards the dialog is format-only: re-quantizing
 * an existing palette to a different size is a different operation and would
 * need a source image we no longer have.
 */
function openFormatDialog(atImport: boolean): void {
  const truecolour = atImport && pending?.image.kind === 'truecolor';
  colorsRow.classList.toggle('hidden', !truecolour);
  formatSelect.value = state.formatId;
  formatDialogNote.textContent = atImport
    ? truecolour
      ? 'Truecolour image: pick the target format and how many palette entries to quantize to.'
      : 'Indexed image: it brings its own palette, so only the format is up to you.'
    : 'Changing format re-quantizes every entry of every frame. Going to a narrower format and back does not round-trip.';
  formatApply.textContent = atImport ? 'Import' : 'Apply';
  dlgFormat.showModal();
}

btnOpenFormat.addEventListener('click', () => openFormatDialog(false));

formatApply.addEventListener('click', (ev) => {
  ev.preventDefault();
  const newId = formatSelect.value as FormatId;
  dlgFormat.close();
  if (pending) {
    const { image, name } = pending;
    pending = null;
    state.formatId = newId;
    if (image.kind === 'truecolor') {
      importTruecolor(image, name);
    } else {
      loadIndexedImage(image);
      setStatus(`Loaded ${name}: ${image.width}x${image.height}, ${image.palette.length} colours.`);
    }
    return;
  }
  applyFormatChange(newId);
});

/**
 * Quantize a truecolour import down to an indexed image.
 *
 * The status line reports what the quantizer actually did rather than just
 * that it succeeded: whether it took the lossless path, how much error is
 * left, and how many entries had to be nudged off 0x0000 on PlayStation. A
 * quantizer that silently returns fewer colours than you asked for is normal
 * here - two entries can collide once truncated - and you want to be told.
 */
function importTruecolor(img: TruecolorImage, name: string): void {
  const fmt = formatById(state.formatId);
  const maxColors = Math.min(256, Math.max(2, Math.round(Number(colorsInput.value) || 16)));
  colorsInput.value = String(maxColors);

  let result;
  try {
    result = quantize(img.rgba, img.width, img.height, { maxColors, format: fmt });
  } catch (err) {
    setStatus(`Quantizing failed: ${(err as Error).message}`);
    return;
  }

  loadIndexedImage({
    kind: 'indexed',
    width: img.width,
    height: img.height,
    indices: result.indices,
    palette: result.palette,
    sourceBitDepth: 8,
  });

  const bits: string[] = [
    `${img.width}x${img.height}`,
    result.lossless
      ? `${result.palette.length} colours, no quantizing needed`
      : `${result.palette.length} of ${maxColors} colours, mean error ${result.meanError.toFixed(1)}, max ${result.maxError.toFixed(1)}`,
  ];
  if (result.palette.length < maxColors && !result.lossless) {
    bits.push('some entries collided once truncated');
  }
  if (result.blackNudges > 0) {
    bits.push(`${result.blackNudges} nudged off 0x0000`);
  }
  setStatus(`Quantized ${name}: ${bits.join('. ')}.`);
}

function loadIndexedImage(img: IndexedImage): void {
  const fmt = formatById(state.formatId);
  const palette: Entry[] = img.palette.map((e) => fmt.snap({ ...e }));

  state.imageW = img.width;
  state.imageH = img.height;
  state.indices = img.indices;
  state.imageBuffer = createImageBuffer(img.width, img.height);
  const fresh = createAnimation(state.formatId, palette, state.animation?.fps ?? 60);
  asClean(() => {
    state.animation = fresh;
  });
  state.dirty = false;
  state.currentFrame = 0;
  state.selected = new Set();
  state.editingIndex = null;

  const rect = canvasWrap.getBoundingClientRect();
  state.view = fitView(state.view, img.width, img.height, rect.width, rect.height);

  fpsInput.value = String(fresh.fps);

  importHint.classList.add('hidden');
  formatChangeNote.textContent = '';

  refreshAll();
}

// ---------------------------------------------------------------------------
// Format switching
// ---------------------------------------------------------------------------

for (const id of Object.keys(FORMATS) as FormatId[]) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = FORMATS[id].label;
  formatSelect.appendChild(opt);
}
formatSelect.value = state.formatId;

function applyFormatChange(newId: FormatId): void {
  state.formatId = newId;
  if (!state.animation) return;

  const oldFmt = formatById(state.animation.formatId);
  const newFmt = formatById(newId);
  const frame = state.animation.frames[state.currentFrame];
  let changed = 0;
  for (const e of frame.palette) {
    const a = oldFmt.display(e);
    const b = newFmt.display(e);
    if (a.r !== b.r || a.g !== b.g || a.b !== b.b || a.a !== b.a) changed++;
  }
  // Re-quantize for real, rather than keeping 8-bit values and snapping only
  // for display. spicyjpeg's call: the sliders now speak the format's own
  // levels, so the stored value has to BE that level or the two disagree.
  // The trade, said out loud because it is a one-way door: switching to a
  // narrower format and back no longer round-trips.
  state.animation = {
    ...state.animation,
    formatId: newId,
    frames: state.animation.frames.map((f) => ({
      ...f,
      palette: f.palette.map((e) => newFmt.snap(e)),
    })),
  };
  formatChangeNote.textContent =
    changed > 0
      ? `${changed} of ${frame.palette.length} entries re-quantized for this format`
      : 'no visible change in this format';

  refreshAll();
}

// ---------------------------------------------------------------------------
// Palette grid + entry editor
// ---------------------------------------------------------------------------

let lastClickedIndex: number | null = null;
let cycleHighlight: [number, number] | null = null;

/**
 * Keyboard shortcuts.
 *
 * Gated on the event target: a number input in the generators is a text field
 * and left/right there mean cursor movement, not frame navigation. Checking the
 * target rather than a mode flag means there is no state to get out of sync.
 */
function typingInAField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if (typingInAField(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!state.animation) return;
  const last = state.animation.frames.length - 1;

  switch (e.key) {
    case ' ':
      if (state.playing) stopPlayback();
      else startPlayback();
      break;
    case 'ArrowLeft':
      stopPlayback();
      selectFrame(Math.max(0, state.currentFrame - 1));
      break;
    case 'ArrowRight':
      stopPlayback();
      selectFrame(Math.min(last, state.currentFrame + 1));
      break;
    case 'Home':
      stopPlayback();
      selectFrame(0);
      break;
    case 'End':
      stopPlayback();
      selectFrame(last);
      break;
    case 'Insert':
      stopPlayback();
      state.animation = duplicateFrame(state.animation, state.currentFrame);
      selectFrame(Math.min(state.animation.frames.length - 1, state.currentFrame + 1));
      break;
    case 'Delete':
      // Delete takes the selection when there is one; backspace is the
      // always-just-this-frame escape hatch.
      stopPlayback();
      fDelete.click();
      break;
    case 'Backspace': {
      stopPlayback();
      if (state.animation.frames.length <= 1) return;
      const at = state.currentFrame;
      state.animation = deleteFrame(state.animation, at);
      frameSpan = null;
      selectFrame(Math.min(state.animation.frames.length - 1, at));
      break;
    }
    default:
      return;
  }
  e.preventDefault();
});

function paletteContainerWidth(): number {
  const w = paletteGrid.clientWidth;
  return w > 0 ? w : 260;
}

function renderPaletteGrid(): void {
  paletteEmpty.classList.toggle('hidden', !!state.animation);
  paletteCanvas.classList.toggle('hidden', !state.animation);
  if (!state.animation) return;

  const fmt = formatById(state.animation.formatId);
  const palette = state.animation.frames[state.currentFrame].palette;
  paletteGridLayout = paletteLayout(palette.length, paletteContainerWidth());
  sizeCanvas(paletteCanvas, paletteGridLayout.width, paletteGridLayout.height);
  drawPaletteGrid(paletteCanvasCtx, {
    palette,
    fmt,
    selected: state.selected,
    range: cycleHighlight,
    layout: paletteGridLayout,
  });
}

/**
 * Both grids are a single canvas each, so "repaint" and "rebuild" are the same
 * call and there is no separate fast path to keep in sync with the slow one.
 * That is the second reason for the rewrite, after the measured one in
 * ui/grids.ts: the DOM version needed a mutate-in-place path beside the
 * build-from-scratch path, and two renderers for one thing drift.
 */
const updatePaletteColors = renderPaletteGrid;
const updateFrameStripSelection = (): void => renderFrameStrip();

paletteCanvas.addEventListener('click', (ev) => {
  if (!state.animation) return;
  const r = paletteCanvas.getBoundingClientRect();
  const count = state.animation.frames[state.currentFrame].palette.length;
  const i = paletteHitTest(paletteGridLayout, count, ev.clientX - r.left, ev.clientY - r.top);
  if (i !== null) onSwatchClick(i, ev);
});

stripCanvas.addEventListener('click', (ev) => {
  if (!state.animation) return;
  const r = stripCanvas.getBoundingClientRect();
  const i = frameHitTest(stripLayout, state.animation.frames.length, ev.clientX - r.left);
  if (i !== null) selectFrame(i);
});

/**
 * The panels resize each other: the timeline sets its own height after its
 * first draw, which changes the viewport's box. Watching the boxes rather than
 * only the window catches that, and catches the sidebar reflowing when the
 * palette wraps to a different column count.
 */
const ro = new ResizeObserver(() => {
  resizeCanvas();
  if (state.animation) {
    clampCurrentView();
    renderPaletteGrid();
    timeline.requestDraw();
  }
  draw();
});
ro.observe(canvasWrap);
ro.observe(paletteGrid);

window.addEventListener('resize', () => {
  if (state.animation) renderPaletteGrid();
});

function onSwatchClick(i: number, ev: MouseEvent): void {
  if (ev.shiftKey && lastClickedIndex !== null) {
    const lo = Math.min(lastClickedIndex, i);
    const hi = Math.max(lastClickedIndex, i);
    state.selected = new Set();
    for (let k = lo; k <= hi; k++) state.selected.add(k);
  } else if (ev.ctrlKey || ev.metaKey) {
    if (state.selected.has(i)) state.selected.delete(i);
    else state.selected.add(i);
    lastClickedIndex = i;
  } else {
    state.selected = new Set([i]);
    lastClickedIndex = i;
  }
  state.editingIndex = i;
  renderPaletteGrid();
  renderEntryEditor();
  updateGeneratorNotes();
}

function packedHex(fmt: ColorFormat, e: Entry): string {
  const v = fmt.pack(e);
  const digits = fmt.entryBits / 4;
  return `0x${v.toString(16).padStart(digits, '0')}`;
}

function configureChannelRanges(fmt: ColorFormat): void {
  const set = (numId: string, rangeId: string, bits: number): void => {
    const max = bits >= 8 ? 255 : (1 << bits) - 1;
    for (const id of [numId, rangeId]) {
      const el = $<HTMLInputElement>(id);
      el.min = '0';
      el.max = String(max);
      el.step = '1';
    }
  };
  set('e-r', 'e-r-range', fmt.channelBits.r);
  set('e-g', 'e-g-range', fmt.channelBits.g);
  set('e-b', 'e-b-range', fmt.channelBits.b);
  set('e-a', 'e-a-range', fmt.hasAlpha ? fmt.channelBits.a : 8);
}

function setChannelUi(numId: string, rangeId: string, v: number): void {
  $<HTMLInputElement>(numId).value = String(v);
  $<HTMLInputElement>(rangeId).value = String(v);
}

function renderEntryEditor(): void {
  if (!state.animation || state.editingIndex === null) {
    entryEditor.classList.add('hidden');
    return;
  }
  const fmt = formatById(state.animation.formatId);
  const entry = state.animation.frames[state.currentFrame].palette[state.editingIndex];
  if (!entry) {
    entryEditor.classList.add('hidden');
    return;
  }

  entryEditor.classList.remove('hidden');
  configureChannelRanges(fmt);

  setChannelUi('e-r', 'e-r-range', levelOf(entry.r, fmt.channelBits.r));
  setChannelUi('e-g', 'e-g-range', levelOf(entry.g, fmt.channelBits.g));
  setChannelUi('e-b', 'e-b-range', levelOf(entry.b, fmt.channelBits.b));

  eARow.classList.toggle('hidden', !fmt.hasAlpha);
  if (fmt.hasAlpha) setChannelUi('e-a', 'e-a-range', levelOf(entry.a, fmt.channelBits.a));

  eStpRow.classList.toggle('hidden', !fmt.hasStp);
  if (fmt.hasStp) eStp.checked = !!entry.stp;

  eHex.value = packedHex(fmt, entry);

  const warn = fmt.diagnose(entry);
  eDiagnose.textContent = warn ?? '';
  eDiagnose.classList.toggle('hidden', !warn);
}

/** Every entry an edit should touch: the whole selection, else the edited one. */
function editTargets(): number[] {
  if (state.selected.size > 1) return [...state.selected].sort((a, b) => a - b);
  return state.editingIndex === null ? [] : [state.editingIndex];
}

/**
 * `raw` is a LEVEL in the format's own units - 0-31 for a 5-bit channel, 0-63
 * for RGB565's green - not a 0-255 byte. Remapping every channel to 0-255 hid
 * the format from the one control where it matters most: a slider with 256
 * positions that can only produce 32 colours is lying about what you are
 * editing.
 */
function applyChannelEdit(channel: 'r' | 'g' | 'b' | 'a', raw: number): void {
  if (!state.animation) return;
  const fmt = formatById(state.animation.formatId);
  const bits = fmt.channelBits[channel];
  const value = fromLevel(raw, bits >= 8 ? 8 : bits);
  for (const i of editTargets()) {
    const frame = state.animation.frames[state.currentFrame];
    const cur = frame.palette[i];
    if (!cur) continue;
    state.animation = setEntry(state.animation, state.currentFrame, i, { ...cur, [channel]: value });
  }
  refreshAll();
}

function wireChannelInputs(numId: string, rangeId: string, channel: 'r' | 'g' | 'b' | 'a'): void {
  const numEl = $<HTMLInputElement>(numId);
  const rangeEl = $<HTMLInputElement>(rangeId);
  rangeEl.addEventListener('input', () => applyChannelEdit(channel, Number(rangeEl.value)));
  numEl.addEventListener('change', () => applyChannelEdit(channel, Number(numEl.value)));
}

wireChannelInputs('e-r', 'e-r-range', 'r');
wireChannelInputs('e-g', 'e-g-range', 'g');
wireChannelInputs('e-b', 'e-b-range', 'b');
wireChannelInputs('e-a', 'e-a-range', 'a');

eStp.addEventListener('change', () => {
  if (!state.animation) return;
  for (const i of editTargets()) {
    const cur = state.animation.frames[state.currentFrame].palette[i];
    if (!cur) continue;
    state.animation = setEntry(state.animation, state.currentFrame, i, { ...cur, stp: eStp.checked });
  }
  refreshAll();
});

eHex.addEventListener('change', () => {
  if (!state.animation || state.editingIndex === null) return;
  const fmt = formatById(state.animation.formatId);
  const raw = eHex.value.trim().replace(/^0x/i, '');
  const v = parseInt(raw, 16);
  if (!Number.isFinite(v)) return;
  const entry = fmt.unpack(v);
  state.animation = setEntry(state.animation, state.currentFrame, state.editingIndex, entry);
  refreshAll();
});

// ---------------------------------------------------------------------------
// Frame strip
// ---------------------------------------------------------------------------

function renderFrameStrip(): void {
  if (!state.animation) {
    statusFrames.textContent = '0 frames';
    statusLoop.textContent = 'no loop';
    return;
  }
  const anim = state.animation;
  statusFrames.textContent = `${anim.frames.length} frame${anim.frames.length === 1 ? '' : 's'}`;
  const spanNote = frameSpan ? `, ${frameSpan[1] - frameSpan[0] + 1} selected` : '';
  statusHoverFrame.textContent = `frame ${state.currentFrame}${state.dirty ? ' *' : ''}`;
  statusLoop.textContent =
    (anim.loopStart !== null ? `loops at ${anim.loopStart}` : 'no loop') + spanNote;

  timeline.current = state.currentFrame;
  timeline.loopStart = anim.loopStart;
  timeline.selection = frameSpan;
  // The playhead is the ONLY marker for where you are, now that the
  // current-frame border is gone, so it has to sit exactly where you put it.
  // Deriving it from the current frame snapped it back to that frame's left
  // edge, which reads as landing on the previous frame when you click near a
  // boundary - reported as "scrubbing is off by half a frame".
  timeline.playheadTick = state.playheadTick;
  timeline.setContent({ frames: anim.frames, fmt: formatById(anim.formatId) });
}

timeline.onScrub = (frame) => {
  if (!state.animation) return;
  stopPlayback();
  if (frame === state.currentFrame) return;
  state.playheadTick = tickForFrame(state.animation, frame);
  selectFrame(frame);
};
timeline.onSelectFrame = (i) => {
  stopPlayback();
  state.playheadTick = tickForFrame(state.animation!, i);
  selectFrame(i);
};
timeline.onSelectSpan = (span) => {
  frameSpan = span;
  renderFrameStrip();
};
timeline.onSetLoop = (i) => {
  if (!state.animation) return;
  state.animation = setLoopStart(state.animation, i);
  refreshAll();
};

/** The frames the edit buttons act on: the selected span, else the current frame. */
function targetSpan(): [number, number] {
  if (frameSpan) return frameSpan;
  return [state.currentFrame, state.currentFrame];
}

function selectFrame(i: number): void {
  if (!state.animation) return;
  if (i < 0 || i >= state.animation.frames.length) return;
  const wasFrame = frameAtPlayhead();
  state.currentFrame = i;
  // Only re-seat the playhead if it was not already inside this frame, so a
  // mid-frame scrub is not yanked to the frame's edge by its own selectFrame.
  if (wasFrame !== i) state.playheadTick = tickForFrame(state.animation, i);
  fHold.value = String(state.animation.frames[i].hold);
  refreshAll();
}

fInsert.addEventListener('click', () => {
  if (!state.animation) return;
  const cur = state.animation.frames[state.currentFrame];
  const copy: Frame = { palette: cur.palette.map((e) => ({ ...e })), hold: cur.hold };
  state.animation = insertFrames(state.animation, state.currentFrame, [copy]);
  refreshAll();
});

fDelete.addEventListener('click', () => {
  if (!state.animation) return;
  const [lo, hi] = targetSpan();
  for (let i = hi; i >= lo; i--) state.animation = deleteFrame(state.animation, i);
  state.currentFrame = Math.min(lo, state.animation.frames.length - 1);
  frameSpan = null;
  refreshAll();
});

fDuplicate.addEventListener('click', () => {
  if (!state.animation) return;
  const [lo, hi] = targetSpan();
  const copies: Frame[] = [];
  for (let i = lo; i <= hi; i++) {
    const f = state.animation.frames[i];
    copies.push({ palette: f.palette.map((e) => ({ ...e })), hold: f.hold });
  }
  state.animation = insertFrames(state.animation, hi + 1, copies);
  state.currentFrame = hi + 1;
  frameSpan = frameSpan ? [hi + 1, hi + copies.length] : null;
  refreshAll();
});

fMoveLeft.addEventListener('click', () => {
  if (!state.animation) return;
  const [lo, hi] = targetSpan();
  if (lo - 1 < 0) return;
  for (let i = lo; i <= hi; i++) state.animation = moveFrame(state.animation, i, i - 1);
  state.currentFrame = Math.max(0, state.currentFrame - 1);
  if (frameSpan) frameSpan = [lo - 1, hi - 1];
  refreshAll();
});

fMoveRight.addEventListener('click', () => {
  if (!state.animation) return;
  const [lo, hi] = targetSpan();
  if (hi + 1 >= state.animation.frames.length) return;
  for (let i = hi; i >= lo; i--) state.animation = moveFrame(state.animation, i, i + 1);
  state.currentFrame = Math.min(state.animation.frames.length - 1, state.currentFrame + 1);
  if (frameSpan) frameSpan = [lo + 1, hi + 1];
  refreshAll();
});

fHold.addEventListener('change', () => {
  if (!state.animation) return;
  state.animation = setHold(state.animation, state.currentFrame, Number(fHold.value));
  refreshAll();
});

fLoopSet.addEventListener('click', () => {
  if (!state.animation) return;
  state.animation = setLoopStart(state.animation, state.currentFrame);
  refreshAll();
});

fLoopClear.addEventListener('click', () => {
  if (!state.animation) return;
  state.animation = setLoopStart(state.animation, null);
  refreshAll();
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function selectedOrAll(base: Entry[]): number[] {
  return state.selected.size > 0 ? [...state.selected].sort((a, b) => a - b) : base.map((_, i) => i);
}

/**
 * Put a generator's output into the animation.
 *
 * Two modes, and which one applies is decided by whether a timeline span is
 * selected rather than by a control the user has to find:
 *
 *   span selected   REPLACE those frames, keeping each one's hold. The ramp
 *                   transformed frames that already exist, so inserting copies
 *                   beside them would be the wrong operation entirely.
 *   no span         INSERT after the current frame, and select what was just
 *                   made - you almost always want to act on it next.
 */
function insertGenerated(generated: Entry[][], kind: string, params: Record<string, unknown>): void {
  if (!state.animation) return;
  const span = frameSpan;
  if (span) {
    const frames = state.animation.frames.slice();
    for (let k = 0; k < generated.length && span[0] + k < frames.length; k++) {
      frames[span[0] + k] = {
        palette: generated[k],
        hold: frames[span[0] + k].hold,
        from: { kind, params, step: k },
      };
    }
    state.animation = { ...state.animation, frames };
    state.currentFrame = span[0];
    return;
  }
  const frames: Frame[] = generated.map((palette, k) => ({
    palette,
    hold: 1,
    from: { kind, params, step: k },
  }));
  const at = state.currentFrame + 1;
  state.animation = insertFrames(state.animation, at, frames);
  frameSpan = frames.length > 1 ? [at, at + frames.length - 1] : null;
  state.currentFrame = at;
}

// ---------------------------------------------------------------------------
// Generator dry runs
//
// Every note under a generator is computed by RUNNING that generator with the
// values currently in its inputs and counting what comes out, rather than by
// estimating from endpoints. Two reasons. It is exact, including for the cases
// an endpoint estimate cannot describe at all - a colour cycle interpolates
// nothing, so "distinct steps between entry 0 and 7" is a number about a ramp
// that does not exist. And it cannot drift from what Generate will actually
// do, because it is the same call with the same arguments.
// ---------------------------------------------------------------------------

function buildCycleRun(base: Entry[]) {
  const indices = [...state.selected].filter((i) => i >= 0 && i < base.length).sort((a, b) => a - b);
  const increment = Number(gCycleInc.value) || 0;
  const steps = Math.max(1, Math.round(Number(gCycleSteps.value)));
  const params = { indices, increment, steps, skipFirst: true };
  return { params, frames: cycleEntries({ base, indices, increment, steps, skipFirst: true }) };
}

/**
 * In RGB5551 a generated colour that lands on 0x0000 is read by the GPU as
 * fully transparent, so a fade to black silently punches holes in the image.
 * Every generator that INVENTS colours routes its output through here; the
 * substitute is the user's, defaulting to 0x0421 the way timweb does it.
 */
function replaceSolidBlack(fmt: ColorFormat, frames: Entry[][], picker: HTMLInputElement): Entry[][] {
  if (!fmt.hasStp) return frames;
  const sub = packedField(fmt, picker, PS1_NEAR_BLACK);
  return frames.map((pal) =>
    pal.map((e) => (e.a > 0 && fmt.pack(e) === 0 ? { ...e, r: sub.r, g: sub.g, b: sub.b } : e)),
  );
}

/**
 * Read a PACKED value out of a text field, in the format's own encoding.
 *
 * A colour picker was the wrong control here: the thing being chosen is a
 * specific 16-bit word you are avoiding 0x0000 with, and a picker rounds it
 * through 8-bit sRGB on the way in and out. The field is rewritten with the
 * canonical spelling so a typo does not silently become black.
 */
function packedField(fmt: ColorFormat, el: HTMLInputElement, fallback: number): Entry {
  const raw = el.value.trim().replace(/^0x/i, '').replace(/^#/, '');
  const parsed = /^[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : NaN;
  const packed = Number.isFinite(parsed) ? parsed & 0xffff : fallback;
  el.value = `0x${packed.toString(16).padStart(fmt.entryBits / 4, '0')}`;
  el.classList.toggle('warn-field', !Number.isFinite(parsed));
  return fmt.unpack(packed);
}

/** The frames a generator should transform, when a timeline span is selected. */
function spanFrames(): { palette: Entry[] }[] | null {
  if (!frameSpan || !state.animation) return null;
  return state.animation.frames.slice(frameSpan[0], frameSpan[1] + 1);
}

function buildHsbRun(base: Entry[]) {
  const indices = selectedOrAll(base);
  const hueFrom = Number(gHsbHueFrom.value);
  const hueTo = Number(gHsbHueTo.value);
  const sat = Number(gHsbSat.value);
  const val = Number(gHsbVal.value);
  const steps = Math.max(1, Math.round(Number(gHsbSteps.value)));
  const closed = gHsbClosed.checked;
  const over = spanFrames();
  const params = { indices, hueFrom, hueTo, sat, val, steps: over ? over.length : steps, closed };
  const from = { hue: hueFrom, sat, val };
  const to = { hue: hueTo, sat, val };
  const fmt = formatById(state.formatId);
  const frames = over
    ? hsvRampOver({ frames: over, indices, from, to, closed })
    : hsvRamp({ base, indices, from, to, steps, closed });
  return { params, frames: replaceSolidBlack(fmt, frames, gHsbBlack) };
}

function buildFadeRun(base: Entry[]) {
  const indices = selectedOrAll(base);
  const to = fadeTargetEntry();
  const steps = Math.max(1, Math.round(Number(gFadeSteps.value)));
  const closed = gFadeClosed.checked;
  const over = spanFrames();
  const params = { indices, to, steps: over ? over.length : steps, closed };
  const fmt = formatById(state.formatId);
  const frames = over
    ? interpolateOver({ frames: over, indices, to, closed })
    : interpolateTo({ base, indices, to, steps, closed });
  return { params, frames: replaceSolidBlack(fmt, frames, gFadeBlack) };
}

/** How many of these palettes are distinct once packed into the target format. */
function distinctPalettes(fmt: ColorFormat, frames: Entry[][]): number {
  const seen = new Set<string>();
  for (const pal of frames) seen.add(pal.map((e) => fmt.pack(e)).join(','));
  return seen.size;
}

function runNote(fmt: ColorFormat, frames: Entry[][], extra = ''): string {
  const distinct = distinctPalettes(fmt, frames);
  const head =
    distinct === frames.length
      ? `${frames.length} frames, all distinct in ${fmt.label}`
      : `${frames.length} frames, only ${distinct} distinct in ${fmt.label}`;
  return extra ? `${head}; ${extra}` : head;
}

function updateGeneratorNotes(): void {
  if (!state.animation) {
    gCycleDistinct.textContent = '';
    gHsbDistinct.textContent = '';
    gFadeDistinct.textContent = '';
    return;
  }
  const fmt = formatById(state.animation.formatId);
  const base = state.animation.frames[state.currentFrame].palette;

  // Availability, on spicyjpeg's rules: the cycle needs palette entries and
  // has nothing to say about a span of existing frames, while the two ramps
  // take their length FROM a span when one is selected, so their step count
  // stops being an input.
  const span = spanFrames();
  const cycle = buildCycleRun(base);
  const nSel = cycle.params.indices.length;
  const why =
    span !== null
      ? 'Not available while a timeline span is selected: cycling rewrites the palette, it does not transform existing frames.'
      : nSel < 2
        ? 'Select two or more palette entries to cycle. A non-contiguous selection is cycled as if it were contiguous.'
        : '';
  const cycleOff = why !== '';
  // The button that OPENS the modal is the one to grey out. Disabling only the
  // Generate button inside put the explanation one click away from the thing
  // it explains.
  $<HTMLButtonElement>('open-cycle').disabled = cycleOff;
  $<HTMLButtonElement>('open-cycle').title = why;
  gCycleRun.disabled = cycleOff;
  // The reason rides on the button as a tooltip as well as in the panel text:
  // a greyed control with the explanation somewhere else is a control you have
  // to go looking for an explanation for.
  gCycleRun.title = why;
  $<HTMLInputElement>('g-cycle-steps').disabled = cycleOff;
  gCycleTarget.textContent = why || `Cycles the ${nSel} selected entries, in index order.`;
  if (!cycleOff && document.activeElement !== gCycleSteps) {
    // A full loop of N entries is N-1 NEW frames: the one you started from is
    // already in the animation and re-emitting it inserts a duplicate.
    gCycleSteps.value = String(Math.max(1, nSel - 1));
  }

  for (const id of ['hsb', 'fade']) {
    $(`g-${id}-black-row`).classList.toggle('hidden', !fmt.hasStp);
  }
  for (const id of ['hsb', 'fade']) {
    $(`g-${id}-steps-row`).classList.toggle('disabled', span !== null);
    $<HTMLInputElement>(`g-${id}-steps`).disabled = span !== null;
  }

  if (cycleOff) {
    gCycleDistinct.textContent = '';
    cycleHighlight = null;
  } else {
    const loop = Math.max(1, nSel - 1);
    gCycleDistinct.textContent = runNote(
      fmt,
      cycle.frames,
      `a full loop of ${nSel} entries is ${loop} new frame${loop === 1 ? '' : 's'} on top of this one`,
    );
  }
  const ci = cycle.params.indices;
  cycleHighlight = ci.length ? [ci[0], ci[ci.length - 1]] : null;

  const indices = selectedOrAll(base);
  if (indices.length > 0) {
    gHsbDistinct.textContent = runNote(fmt, buildHsbRun(base).frames);
    gFadeDistinct.textContent = runNote(fmt, buildFadeRun(base).frames);
  } else {
    gHsbDistinct.textContent = '';
    gFadeDistinct.textContent = '';
  }

  renderPaletteGrid();
}

function clampToPalette(v: number, len: number): number {
  return Math.min(len - 1, Math.max(0, Math.round(v)));
}

function fadeTargetEntry(): Entry {
  const hex = gFadeColor.value;
  const v = parseInt(hex.slice(1), 16) || 0;
  return {
    r: (v >> 16) & 0xff,
    g: (v >> 8) & 0xff,
    b: v & 0xff,
    a: clampToPalette(Number(gFadeAlpha.value), 256),
  };
}

[gHsbHueFrom, gHsbHueTo, gHsbSat, gHsbVal, gFadeColor, gFadeAlpha].forEach((el) => {
  el.addEventListener('input', updateGeneratorNotes);
});

gCycleRun.addEventListener('click', () => {
  if (!state.animation) return;
  const base = state.animation.frames[state.currentFrame].palette;
  const { params, frames: generated } = buildCycleRun(base);
  insertGenerated(generated, 'cycle', params);
  const fmt = formatById(state.animation.formatId);
  const stalled = countStalledFrames(fmt, generated);
  gCycleStalled.textContent = `${stalled} stalled frame${stalled === 1 ? '' : 's'} in this run`;
  refreshAll();
});

gHsbRun.addEventListener('click', () => {
  if (!state.animation) return;
  const base = state.animation.frames[state.currentFrame].palette;
  const { params, frames: generated } = buildHsbRun(base);
  insertGenerated(generated, 'hsb-ramp', params);
  const fmt = formatById(state.animation.formatId);
  const stalled = countStalledFrames(fmt, generated);
  gHsbStalled.textContent = `${stalled} stalled frame${stalled === 1 ? '' : 's'} in this run`;
  refreshAll();
});

gFadeRun.addEventListener('click', () => {
  if (!state.animation) return;
  const base = state.animation.frames[state.currentFrame].palette;
  const { params, frames: generated } = buildFadeRun(base);
  insertGenerated(generated, 'fade', params);
  const fmt = formatById(state.animation.formatId);
  const stalled = countStalledFrames(fmt, generated);
  gFadeStalled.textContent = `${stalled} stalled frame${stalled === 1 ? '' : 's'} in this run`;
  refreshAll();
});

// ---------------------------------------------------------------------------
// Viewport: pan, zoom, hover readout
// ---------------------------------------------------------------------------

function syncZoomLabel(): void {
  zoomLabel.textContent = `${Math.round(state.view.scale * 100)}%`;
}

function clampCurrentView(): void {
  if (!state.animation) return;
  const rect = canvasWrap.getBoundingClientRect();
  state.view = clampView(state.view, state.imageW, state.imageH, rect.width, rect.height);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.animation) return;
  dragging = { x: e.clientX, y: e.clientY };
  dragMoved = false;
  canvas.setPointerCapture(e.pointerId);
});

/**
 * Clicking a pixel selects the palette entry that pixel uses. Suppressed after
 * a pan, or every drag would end by silently changing the selection.
 */
canvas.addEventListener('click', (e) => {
  if (dragMoved || !state.animation || !state.indices) return;
  const rect = canvas.getBoundingClientRect();
  const hit = hitTest(state.view, state.imageW, state.imageH, e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) return;
  const idx = state.indices[hit.y * state.imageW + hit.x];
  if (idx === undefined) return;
  onSwatchClick(idx, e);
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (dragging && state.animation) {
    const dx = e.clientX - dragging.x;
    const dy = e.clientY - dragging.y;
    dragging = { x: e.clientX, y: e.clientY };
    if (Math.abs(dx) > 0 || Math.abs(dy) > 0) dragMoved = true;
    state.view = panBy(state.view, dx, dy);
    clampCurrentView();
    draw();
  }

  updateHover(sx, sy);
});

window.addEventListener('pointerup', () => {
  dragging = null;
});

canvas.addEventListener('pointerleave', () => {
  if (dragging) return;
  state.hover = null;
  updateReadoutUi();
});

canvas.addEventListener(
  'wheel',
  (e) => {
    if (!state.animation) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    state.view = zoomAt(state.view, sx, sy, factor);
    clampCurrentView();
    syncZoomLabel();
    draw();
  },
  { passive: false },
);

function updateHover(sx: number, sy: number): void {
  if (!state.animation || !state.indices) {
    state.hover = null;
    updateReadoutUi();
    return;
  }
  state.hover = hitTest(state.view, state.imageW, state.imageH, sx, sy);
  updateReadoutUi();
}

function updateReadoutUi(): void {
  if (!state.hover || !state.animation || !state.indices) {
    readoutEl.style.display = 'none';
    statusHover.textContent = '';
    return;
  }
  const { x, y } = state.hover;
  const idx = state.indices[y * state.imageW + x];
  const fmt = formatById(state.animation.formatId);
  const entry = state.animation.frames[state.currentFrame].palette[idx];
  const hex = entry ? packedHex(fmt, entry) : '-';
  readoutEl.style.display = 'block';
  readoutEl.textContent = `${x}, ${y}\nindex ${idx}\n${hex}`;
  statusHover.textContent = `${x}, ${y}  idx ${idx}`;
}

btnZoomIn.addEventListener('click', () => {
  if (!state.animation) return;
  const rect = canvasWrap.getBoundingClientRect();
  state.view = zoomAt(state.view, rect.width / 2, rect.height / 2, 1.2);
  clampCurrentView();
  syncZoomLabel();
  draw();
});

btnZoomOut.addEventListener('click', () => {
  if (!state.animation) return;
  const rect = canvasWrap.getBoundingClientRect();
  state.view = zoomAt(state.view, rect.width / 2, rect.height / 2, 1 / 1.2);
  clampCurrentView();
  syncZoomLabel();
  draw();
});

btnFit.addEventListener('click', () => {
  if (!state.animation) return;
  const rect = canvasWrap.getBoundingClientRect();
  state.view = fitView(state.view, state.imageW, state.imageH, rect.width, rect.height);
  syncZoomLabel();
  draw();
});

btn1to1.addEventListener('click', () => {
  if (!state.animation) return;
  const rect = canvasWrap.getBoundingClientRect();
  state.view = {
    scale: 1,
    originX: state.imageW / 2 - rect.width / 2,
    originY: state.imageH / 2 - rect.height / 2,
  };
  clampCurrentView();
  syncZoomLabel();
  draw();
});

window.addEventListener('resize', () => {
  resizeCanvas();
  clampCurrentView();
  draw();
});

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/** Which frame the playhead is currently inside. */
function frameAtPlayhead(): number | null {
  if (!state.animation) return null;
  let acc = 0;
  for (let i = 0; i < state.animation.frames.length; i++) {
    acc += Math.max(1, state.animation.frames[i].hold);
    if (state.playheadTick < acc) return i;
  }
  return state.animation.frames.length - 1;
}

function tickForFrame(anim: Animation, frameIndex: number): number {
  let t = 0;
  for (let i = 0; i < frameIndex && i < anim.frames.length; i++) t += Math.max(1, anim.frames[i].hold);
  return t;
}

function stopPlayback(): void {
  state.playing = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  btnPlay.textContent = 'Play';
  btnPlay.classList.remove('on');
}

function startPlayback(): void {
  if (!state.animation) return;
  state.playing = true;
  btnPlay.textContent = 'Pause';
  btnPlay.classList.add('on');
  playAnchorTime = performance.now();
  playAnchorTick = tickForFrame(state.animation, state.currentFrame);
  rafId = requestAnimationFrame(tickLoop);
}

function tickLoop(now: number): void {
  if (!state.playing || !state.animation) return;
  const elapsedTicks = ((now - playAnchorTime) / 1000) * state.animation.fps;
  const t = playAnchorTick + elapsedTicks;

  let acc = 0;
  let frameIdx: number | null = null;
  const total = state.animation.frames.reduce((n, f) => n + Math.max(1, f.hold), 0);
  let tick = Math.max(0, Math.floor(t));
  if (tick >= total) {
    if (state.animation.loopStart === null) {
      stopPlayback();
      return;
    }
    const head = tickForFrame(state.animation, state.animation.loopStart);
    const loopLen = total - head;
    tick = loopLen <= 0 ? head : head + ((tick - head) % loopLen);
  }
  for (let i = 0; i < state.animation.frames.length; i++) {
    acc += Math.max(1, state.animation.frames[i].hold);
    if (tick < acc) {
      frameIdx = i;
      break;
    }
  }
  if (frameIdx === null) frameIdx = state.animation.frames.length - 1;

  if (frameIdx !== state.currentFrame) {
    state.currentFrame = frameIdx;
    composeAndDraw();
    timeline.current = state.currentFrame;
    // Wrapped, not raw: `t` keeps growing past the end of the animation, so
    // after the first loop the playhead walked off the right-hand side and
    // stopped appearing to move.
    state.playheadTick = tick;
    timeline.playheadTick = tick;
    statusHoverFrame.textContent = `frame ${state.currentFrame}`;
    timeline.requestDraw();
    updatePaletteColors();
    renderEntryEditor();
  }

  rafId = requestAnimationFrame(tickLoop);
}

btnPlay.addEventListener('click', () => {
  if (!state.animation) return;
  if (state.playing) stopPlayback();
  else startPlayback();
});

fpsInput.addEventListener('change', () => {
  if (!state.animation) return;
  const fps = Math.max(1, Math.round(Number(fpsInput.value)));
  state.animation = { ...state.animation, fps };
  fpsInput.value = String(fps);
  if (state.playing) {
    playAnchorTime = performance.now();
    playAnchorTick = tickForFrame(state.animation, state.currentFrame);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function refreshAll(): void {
  composeAndDraw();
  renderFrameStrip();
  renderPaletteGrid();
  renderEntryEditor();
  updateGeneratorNotes();
}

resizeCanvas();
syncZoomLabel();
draw();

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  canvasWrap.classList.remove('drop-target');
  const file = e.dataTransfer?.files?.[0];
  if (file) void importFile(file);
});

// The viewport is the drop target, and says so while you are over it. Dropping
// anywhere still works; this is about the affordance, since an empty dark
// rectangle does not look like somewhere you can drop a file.
canvasWrap.addEventListener('dragenter', (e) => {
  e.preventDefault();
  canvasWrap.classList.add('drop-target');
});
canvasWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
canvasWrap.addEventListener('dragleave', (e) => {
  if (e.relatedTarget && canvasWrap.contains(e.relatedTarget as Node)) return;
  canvasWrap.classList.remove('drop-target');
});
