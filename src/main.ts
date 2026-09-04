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
  countStalledFrames,
  truncateChannel,
  type ColorFormat,
  type Entry,
  type FormatId,
} from './shared/color.js';
import { decodePng, type IndexedImage, type TruecolorImage } from './shared/png.js';
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
import { hsvRamp, interpolateTo, cycleRange, type CycleDirection } from './core/generators.js';
import { paletteLut, composeInto, createImageBuffer } from './core/compose.js';

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

const gCycleLo = $<HTMLInputElement>('g-cycle-lo');
const gCycleHi = $<HTMLInputElement>('g-cycle-hi');
const gCycleDir = $<HTMLSelectElement>('g-cycle-dir');
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

const statusFrames = $('s-frames');
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
}

const state: AppState = {
  formatId: 'rgba8888',
  animation: null,
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
};

// Live references into the palette grid and frame strip, so playback can
// repaint them without rebuilding. See updatePaletteColors().
const paletteFills: HTMLElement[] = [];
const frameCells: HTMLElement[] = [];
let currentCell: HTMLElement | null = null;

let dragging: { x: number; y: number } | null = null;
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

  if (decoded.kind === 'truecolor') {
    importTruecolor(decoded, file.name);
    return;
  }

  loadIndexedImage(decoded);
  setStatus(`Loaded ${file.name}: ${decoded.width}x${decoded.height}, ${decoded.palette.length} colours.`);
}

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
  state.animation = createAnimation(state.formatId, palette, state.animation?.fps ?? 60);
  state.currentFrame = 0;
  state.selected = new Set();
  state.editingIndex = null;

  const rect = canvasWrap.getBoundingClientRect();
  state.view = fitView(state.view, img.width, img.height, rect.width, rect.height);

  fpsInput.value = String(state.animation.fps);
  gCycleLo.max = String(palette.length - 1);
  gCycleHi.max = String(palette.length - 1);
  gCycleHi.value = String(palette.length - 1);

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

formatSelect.addEventListener('change', () => {
  const newId = formatSelect.value as FormatId;
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
  state.animation = { ...state.animation, formatId: newId };
  formatChangeNote.textContent =
    changed > 0
      ? `${changed} of ${frame.palette.length} entries change appearance in this format`
      : 'no visible change in this format';

  refreshAll();
});

// ---------------------------------------------------------------------------
// Palette grid + entry editor
// ---------------------------------------------------------------------------

let lastClickedIndex: number | null = null;
let cycleHighlight: [number, number] | null = null;

function renderPaletteGrid(): void {
  paletteGrid.innerHTML = '';
  paletteEmpty.classList.toggle('hidden', !!state.animation);
  if (!state.animation) return;

  const fmt = formatById(state.animation.formatId);
  const frame = state.animation.frames[state.currentFrame];

  frame.palette.forEach((e, i) => {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    if (state.selected.has(i)) sw.classList.add('selected');
    if (cycleHighlight && i >= cycleHighlight[0] && i <= cycleHighlight[1]) sw.classList.add('in-range');

    const fill = document.createElement('div');
    fill.className = 'fill';
    const d = fmt.display(e);
    fill.style.background = `rgba(${d.r},${d.g},${d.b},${d.a / 255})`;
    sw.appendChild(fill);

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i);
    sw.appendChild(idx);

    sw.title = `#${i}  ${packedHex(fmt, e)}`;
    sw.addEventListener('click', (ev) => onSwatchClick(i, ev));
    paletteGrid.appendChild(sw);
    paletteFills[i] = fill;
  });
  paletteFills.length = frame.palette.length;
}

/**
 * Repaint the existing swatches without rebuilding them.
 *
 * Playback used to call renderPaletteGrid() and renderFrameStrip() on every
 * frame change, which tore down and rebuilt every swatch and every frame-strip
 * cell - 544 elements per frame on a 17-frame, 32-colour animation. Measured
 * at 5.4 fps on a 320x240 image, with the profile dominated by createElement,
 * appendChild and the style/layout/paint that follows them; the actual pixel
 * work (composeInto) was 0.2%. Mutating a style on an existing node does not
 * invalidate layout the way inserting one does.
 */
function updatePaletteColors(): void {
  if (!state.animation) return;
  const fmt = formatById(state.animation.formatId);
  const frame = state.animation.frames[state.currentFrame];
  for (let i = 0; i < frame.palette.length; i++) {
    const fill = paletteFills[i];
    if (!fill) continue;
    const d = fmt.display(frame.palette[i]);
    fill.style.background = `rgba(${d.r},${d.g},${d.b},${d.a / 255})`;
  }
}

/** Move the `current` marker in the frame strip. No rebuild. */
function updateFrameStripSelection(): void {
  if (currentCell) currentCell.classList.remove('current');
  const cell = frameCells[state.currentFrame];
  if (cell) {
    cell.classList.add('current');
    currentCell = cell;
  }
}

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

function configureChannelSteps(fmt: ColorFormat): void {
  const stepFor = (bits: number): number => (bits <= 0 || bits >= 8 ? 1 : Math.max(1, Math.round(255 / ((1 << bits) - 1))));
  $<HTMLInputElement>('e-r-range').step = String(stepFor(fmt.channelBits.r));
  $<HTMLInputElement>('e-g-range').step = String(stepFor(fmt.channelBits.g));
  $<HTMLInputElement>('e-b-range').step = String(stepFor(fmt.channelBits.b));
  $<HTMLInputElement>('e-a-range').step = String(stepFor(fmt.channelBits.a));
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
  configureChannelSteps(fmt);

  setChannelUi('e-r', 'e-r-range', entry.r);
  setChannelUi('e-g', 'e-g-range', entry.g);
  setChannelUi('e-b', 'e-b-range', entry.b);

  eARow.classList.toggle('hidden', !fmt.hasAlpha);
  if (fmt.hasAlpha) setChannelUi('e-a', 'e-a-range', entry.a);

  eStpRow.classList.toggle('hidden', !fmt.hasStp);
  if (fmt.hasStp) eStp.checked = !!entry.stp;

  eHex.value = packedHex(fmt, entry);

  const warn = fmt.diagnose(entry);
  eDiagnose.textContent = warn ?? '';
  eDiagnose.classList.toggle('hidden', !warn);
}

function applyChannelEdit(channel: 'r' | 'g' | 'b' | 'a', raw: number): void {
  if (!state.animation || state.editingIndex === null) return;
  const fmt = formatById(state.animation.formatId);
  const bits = fmt.channelBits[channel];
  const snapped = truncateChannel(raw, bits >= 8 ? 8 : bits);
  const frame = state.animation.frames[state.currentFrame];
  const entry = { ...frame.palette[state.editingIndex], [channel]: snapped };
  state.animation = setEntry(state.animation, state.currentFrame, state.editingIndex, entry);
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
  if (!state.animation || state.editingIndex === null) return;
  const frame = state.animation.frames[state.currentFrame];
  const entry = { ...frame.palette[state.editingIndex], stp: eStp.checked };
  state.animation = setEntry(state.animation, state.currentFrame, state.editingIndex, entry);
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
  frameStrip.innerHTML = '';
  frameCells.length = 0;
  currentCell = null;
  if (!state.animation) {
    statusFrames.textContent = '0 frames';
    statusLoop.textContent = 'no loop';
    return;
  }

  statusFrames.textContent = `${state.animation.frames.length} frame${state.animation.frames.length === 1 ? '' : 's'}`;
  statusLoop.textContent = state.animation.loopStart !== null ? `loops at ${state.animation.loopStart}` : 'no loop';

  const fmt = formatById(state.animation.formatId);

  state.animation.frames.forEach((f, i) => {
    const cell = document.createElement('div');
    cell.className = 'frame-cell';
    if (i === state.currentFrame) cell.classList.add('current');
    if (state.animation!.loopStart !== null && i < state.animation!.loopStart) cell.classList.add('before-loop');
    cell.title = `frame ${i}, hold ${f.hold}`;

    for (const e of f.palette) {
      const d = fmt.display(e);
      const swatch = document.createElement('i');
      swatch.style.background = `rgba(${d.r},${d.g},${d.b},${d.a / 255})`;
      cell.appendChild(swatch);
    }

    if (state.animation!.loopStart === i) {
      const flag = document.createElement('div');
      flag.className = 'loop-flag';
      cell.appendChild(flag);
    }

    const num = document.createElement('span');
    num.className = 'frame-num';
    num.textContent = String(i);
    cell.appendChild(num);

    cell.addEventListener('click', () => selectFrame(i));
    frameStrip.appendChild(cell);
    frameCells[i] = cell;
    if (i === state.currentFrame) currentCell = cell;
  });
  frameCells.length = state.animation.frames.length;
}

function selectFrame(i: number): void {
  if (!state.animation) return;
  if (i < 0 || i >= state.animation.frames.length) return;
  state.currentFrame = i;
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
  state.animation = deleteFrame(state.animation, state.currentFrame);
  state.currentFrame = Math.min(state.currentFrame, state.animation.frames.length - 1);
  refreshAll();
});

fDuplicate.addEventListener('click', () => {
  if (!state.animation) return;
  state.animation = duplicateFrame(state.animation, state.currentFrame);
  state.currentFrame = state.currentFrame + 1;
  refreshAll();
});

fMoveLeft.addEventListener('click', () => {
  if (!state.animation) return;
  const to = state.currentFrame - 1;
  if (to < 0) return;
  state.animation = moveFrame(state.animation, state.currentFrame, to);
  state.currentFrame = to;
  refreshAll();
});

fMoveRight.addEventListener('click', () => {
  if (!state.animation) return;
  const to = state.currentFrame + 1;
  if (to >= state.animation.frames.length) return;
  state.animation = moveFrame(state.animation, state.currentFrame, to);
  state.currentFrame = to;
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

function insertGenerated(generated: Entry[][], kind: string, params: Record<string, unknown>): void {
  if (!state.animation) return;
  const frames: Frame[] = generated.map((palette, k) => ({
    palette,
    hold: 1,
    from: { kind, params, step: k },
  }));
  state.animation = insertFrames(state.animation, state.currentFrame + 1, frames);
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
  const lo = clampToPalette(Number(gCycleLo.value), base.length);
  const hi = clampToPalette(Number(gCycleHi.value), base.length);
  const direction = gCycleDir.value as CycleDirection;
  const steps = Math.max(1, Math.round(Number(gCycleSteps.value)));
  const params = { lo: Math.min(lo, hi), hi: Math.max(lo, hi), direction, steps };
  return { params, frames: cycleRange({ base, ...params }) };
}

function buildHsbRun(base: Entry[]) {
  const indices = selectedOrAll(base);
  const hueFrom = Number(gHsbHueFrom.value);
  const hueTo = Number(gHsbHueTo.value);
  const sat = Number(gHsbSat.value);
  const val = Number(gHsbVal.value);
  const steps = Math.max(1, Math.round(Number(gHsbSteps.value)));
  const closed = gHsbClosed.checked;
  const params = { indices, hueFrom, hueTo, sat, val, steps, closed };
  return {
    params,
    frames: hsvRamp({
      base,
      indices,
      from: { hue: hueFrom, sat, val },
      to: { hue: hueTo, sat, val },
      steps,
      closed,
    }),
  };
}

function buildFadeRun(base: Entry[]) {
  const indices = selectedOrAll(base);
  const to = fadeTargetEntry();
  const steps = Math.max(1, Math.round(Number(gFadeSteps.value)));
  const closed = gFadeClosed.checked;
  const params = { indices, to, steps, closed };
  return { params, frames: interpolateTo({ base, indices, to, steps, closed }) };
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

  const cycle = buildCycleRun(base);
  const loop = cycle.params.hi - cycle.params.lo + 1;
  gCycleDistinct.textContent = runNote(
    fmt,
    cycle.frames,
    `one full loop of entries ${cycle.params.lo}-${cycle.params.hi} is ${loop} step${loop === 1 ? '' : 's'}`,
  );
  cycleHighlight = [cycle.params.lo, cycle.params.hi];

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

[gCycleLo, gCycleHi, gHsbHueFrom, gHsbHueTo, gHsbSat, gHsbVal, gFadeColor, gFadeAlpha].forEach((el) => {
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
  state.currentFrame += 1;
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
  state.currentFrame += 1;
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
  state.currentFrame += 1;
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
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (dragging && state.animation) {
    const dx = e.clientX - dragging.x;
    const dy = e.clientY - dragging.y;
    dragging = { x: e.clientX, y: e.clientY };
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
    updateFrameStripSelection();
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
  const file = e.dataTransfer?.files?.[0];
  if (file) void importFile(file);
});
