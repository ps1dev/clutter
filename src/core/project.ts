/**
 * Project files: plain JSON, the way timweb does it.
 *
 * What goes in, and why it is more than timweb keeps: the quantized indices,
 * because re-quantizing on load would give a different palette from the one
 * saved beside it; every frame's palette AND hold; and the metadata that makes
 * the animation mean anything - loop point, tick rate, colour format.
 *
 * PALETTES ARE STORED AS TUPLES IN THE FORMAT'S OWN UNITS, one per entry:
 *
 *     rgba8888   [r, g, b, a]      each 0-255
 *     rgb565     [r, g, b]         r and b 0-31, g 0-63
 *     rgb5551    [r, g, b, stp]    each 0-31, stp a boolean
 *
 * Same units the sliders show, which is the point: a hand-edited file and the
 * entry editor talk about a colour the same way, and every value round-trips
 * exactly because it is already quantized. Storing 0-255 instead would read
 * more familiarly and would re-quantize on load, which is the thing this
 * format exists to avoid.

 *
 * ⚠ A PROJECT FILE IS DATA FROM DISK AND IS VALIDATED AS SUCH. Nothing in here
 * trusts a field: lengths are cross-checked against each other, indices against
 * the palette size, the loop point against the frame count. A malformed file
 * gets a diagnostic naming the field, not a half-loaded editor.
 */

import {
  formatById,
  FORMATS,
  fromLevel,
  levelOf,
  type ColorFormat,
  type Entry,
  type FormatId,
} from '../shared/color.js';

/** Thrown with a message naming the field that failed. */
export class ProjectError extends Error {}

function fail(what: string): never {
  throw new ProjectError(what);
}

export const PROJECT_KIND = 'clutter-project';
export const PROJECT_VERSION = 1;

/** `[r, g, b]`, `[r, g, b, a]` or `[r, g, b, stp]`, in the format's own units. */
export type ProjectEntry = (number | boolean)[];

export interface ProjectFrame {
  /** Ticks this frame stays up. */
  hold: number;
  /** One tuple per entry. */
  palette: ProjectEntry[];
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

/** An entry as levels in the format's own units, plus alpha or the STP flag. */
export function entryToTuple(fmt: ColorFormat, e: Entry): ProjectEntry {
  const t: ProjectEntry = [
    levelOf(e.r, fmt.channelBits.r),
    levelOf(e.g, fmt.channelBits.g),
    levelOf(e.b, fmt.channelBits.b),
  ];
  if (fmt.hasAlpha) t.push(levelOf(e.a, fmt.channelBits.a));
  else if (fmt.hasStp) t.push(!!e.stp);
  return t;
}

/**
 * The inverse. Missing trailing members take their defaults, so `[31, 0, 0]`
 * is a legal opaque red in every format and a hand-written file does not have
 * to know which one it is in.
 */
export function tupleToEntry(fmt: ColorFormat, t: ProjectEntry, where: string): Entry {
  const num = (i: number, bits: number, fallback: number): number => {
    const v = t[i];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}: component ${i} is not a number`);
    const max = bits >= 8 ? 255 : (1 << bits) - 1;
    if (v < 0 || v > max) fail(`${where}: component ${i} is ${v}, outside 0..${max}`);
    return fromLevel(v, bits);
  };
  const e: Entry = {
    r: num(0, fmt.channelBits.r, 0),
    g: num(1, fmt.channelBits.g, 0),
    b: num(2, fmt.channelBits.b, 0),
    a: 255,
  };
  if (fmt.hasAlpha) e.a = num(3, fmt.channelBits.a, 255);
  if (fmt.hasStp) {
    const flag = t[3];
    if (flag !== undefined && typeof flag !== 'boolean') fail(`${where}: stp must be true or false`);
    e.stp = flag === true;
    if (fmt.pack(e) === 0) e.a = 0;
  }
  return e;
}

/**
 * Pretty-print a project with each palette tuple on ONE line.
 *
 * `JSON.stringify(doc, null, 1)` puts every component of every tuple on its own
 * line, so a 256-colour frame becomes a thousand lines and the readability this
 * format exists for is gone. Tuples are stashed behind a marker, the document
 * is indented normally, and the markers are substituted back.
 *
 * The marker is safe by inspection rather than by hope: the only strings in a
 * project are `kind`, `colorFormat` and the base64 `indices`, and `@` is not in
 * the base64 alphabet.
 */
export function formatProjectJson(doc: ProjectFile): string {
  const inline: string[] = [];
  const text = JSON.stringify(
    doc,
    (_k, v: unknown) => {
      if (Array.isArray(v) && v.every((x) => typeof x === 'number' || typeof x === 'boolean')) {
        inline.push(JSON.stringify(v));
        return `@@${inline.length - 1}@@`;
      }
      return v;
    },
    1,
  );
  return text.replace(/"@@(\d+)@@"/g, (_m, i: string) => inline[Number(i)]);
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
      palette: f.palette.map((e) => entryToTuple(fmt, e)),
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
      if (!Array.isArray(v)) fail(`frame ${i} entry ${k} is not a [r, g, b] tuple`);
      return tupleToEntry(fmt, v as ProjectEntry, `frame ${i} entry ${k}`);
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
