/**
 * Project files: plain JSON, the way timweb does it.
 *
 * What goes in, and why it is more than timweb keeps: the quantized indices,
 * because re-quantizing on load would give a different palette from the one
 * saved beside it; every frame's palette AND hold; and the metadata that makes
 * the animation mean anything - loop point, tick rate, colour format.
 *
 * PALETTES ARE STORED PACKED, in the format that was active when you saved.
 * That is the value the hardware sees, so a project round-trips through the
 * format it was authored in rather than through an 8-bit intermediate that
 * would re-quantize on the way back. It also makes the file readable: a PS1
 * palette is a list of the 16-bit words you would DMA.
 *
 * ⚠ A PROJECT FILE IS DATA FROM DISK AND IS VALIDATED AS SUCH. Nothing in here
 * trusts a field: lengths are cross-checked against each other, indices against
 * the palette size, the loop point against the frame count. A malformed file
 * gets a diagnostic naming the field, not a half-loaded editor.
 */

import { formatById, FORMATS, type Entry, type FormatId } from '../shared/color.js';

export const PROJECT_KIND = 'clutter-project';
export const PROJECT_VERSION = 1;

export interface ProjectFrame {
  /** Ticks this frame stays up. */
  hold: number;
  /** Packed palette entries, in `colorFormat`. */
  palette: number[];
}

export interface ProjectFile {
  kind: typeof PROJECT_KIND;
  version: number;
  colorFormat: FormatId;
  fps: number;
  loopStart: number | null;
  width: number;
  height: number;
  /** base64 of one byte per pixel. */
  indices: string;
  frames: ProjectFrame[];
}

/* ---- base64, chunked ------------------------------------------------------
 * String.fromCharCode(...bytes) on a 320x240 image is a 76,800-argument spread
 * and blows the call stack. Chunked, which is the whole reason this is not one
 * line. */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface SerializeInput {
  colorFormat: FormatId;
  fps: number;
  loopStart: number | null;
  width: number;
  height: number;
  indices: Uint8Array;
  frames: { hold: number; palette: Entry[] }[];
}

export function serializeProject(input: SerializeInput): ProjectFile {
  const fmt = formatById(input.colorFormat);
  return {
    kind: PROJECT_KIND,
    version: PROJECT_VERSION,
    colorFormat: input.colorFormat,
    fps: input.fps,
    loopStart: input.loopStart,
    width: input.width,
    height: input.height,
    indices: bytesToBase64(input.indices),
    frames: input.frames.map((f) => ({
      hold: Math.max(1, Math.round(f.hold)),
      palette: f.palette.map((e) => fmt.pack(e)),
    })),
  };
}

export interface LoadedProject {
  colorFormat: FormatId;
  fps: number;
  loopStart: number | null;
  width: number;
  height: number;
  indices: Uint8Array;
  frames: { hold: number; palette: Entry[] }[];
}

/** Thrown with a message naming the field that failed. */
export class ProjectError extends Error {}

function fail(what: string): never {
  throw new ProjectError(what);
}

export function parseProject(text: string): LoadedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) fail('not an object');
  const o = raw as Record<string, unknown>;

  if (o.kind !== PROJECT_KIND) fail(`not a clutter project (kind is ${JSON.stringify(o.kind)})`);
  if (typeof o.version !== 'number' || o.version > PROJECT_VERSION) {
    fail(`unsupported version ${String(o.version)}; this build reads up to ${PROJECT_VERSION}`);
  }
  const colorFormat = o.colorFormat as FormatId;
  if (typeof colorFormat !== 'string' || !(colorFormat in FORMATS)) {
    fail(`unknown colorFormat ${JSON.stringify(o.colorFormat)}`);
  }
  const fmt = formatById(colorFormat);

  const width = o.width;
  const height = o.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) {
    fail('width and height must be positive integers');
  }
  if (typeof o.indices !== 'string') fail('indices must be a base64 string');

  let indices: Uint8Array;
  try {
    indices = base64ToBytes(o.indices);
  } catch (err) {
    fail(`indices is not valid base64: ${(err as Error).message}`);
  }
  const expected = (width as number) * (height as number);
  if (indices.length !== expected) {
    fail(`indices holds ${indices.length} bytes, but ${width}x${height} needs ${expected}`);
  }

  if (!Array.isArray(o.frames) || o.frames.length === 0) fail('frames must be a non-empty array');
  const frames = (o.frames as unknown[]).map((f, i) => {
    if (typeof f !== 'object' || f === null) fail(`frame ${i} is not an object`);
    const fr = f as Record<string, unknown>;
    if (!Array.isArray(fr.palette)) fail(`frame ${i} has no palette array`);
    const palette = (fr.palette as unknown[]).map((v, k) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`frame ${i} entry ${k} is not a number`);
      return fmt.unpack((v as number) & 0xffff_ffff);
    });
    const hold = typeof fr.hold === 'number' && fr.hold >= 1 ? Math.round(fr.hold) : 1;
    return { hold, palette };
  });

  const size = frames[0].palette.length;
  if (size === 0) fail('frame 0 has an empty palette');
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].palette.length !== size) {
      fail(`frame ${i} has ${frames[i].palette.length} entries but frame 0 has ${size}`);
    }
  }
  // An index past the end of the palette would render as a hole with no
  // explanation, so it is a load failure rather than something to paper over.
  for (let p = 0; p < indices.length; p++) {
    if (indices[p] >= size) {
      fail(`pixel ${p} uses palette index ${indices[p]}, but the palette has ${size} entries`);
    }
  }

  let loopStart: number | null = null;
  if (o.loopStart !== null && o.loopStart !== undefined) {
    if (!Number.isInteger(o.loopStart)) fail('loopStart must be an integer or null');
    const l = o.loopStart as number;
    if (l < 0 || l >= frames.length) fail(`loopStart ${l} is outside 0..${frames.length - 1}`);
    loopStart = l;
  }

  const fps = typeof o.fps === 'number' && o.fps > 0 && o.fps <= 1000 ? o.fps : 60;

  return { colorFormat, fps, loopStart, width: width as number, height: height as number, indices, frames };
}
