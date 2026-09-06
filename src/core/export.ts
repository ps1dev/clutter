/**
 * Exporting a pre-baked colour-cycle animation to formats a PS1 program (or a
 * host-side viewer) can actually load.
 *
 * The shapes here follow timweb's sibling exporters (`src/core/raw.ts`,
 * `src/core/template.ts`) straight down to the option names and placeholder
 * syntax, per spicyjpeg's request - two tools that both feed PS1 art
 * pipelines should not invent two vocabularies for the same idea. Where this
 * module diverges from timweb it says so inline, because a silent divergence
 * is the kind of thing that costs someone an afternoon later.
 *
 * `clutter` has no dependency on `timweb` (separate repo, separate package),
 * so nothing here is imported from it. The TIM layout constants in section 3
 * are copied by hand from timweb's `src/core/tim.ts`, with a comment marking
 * exactly what was copied and why.
 *
 * Four exports, in the order a user would reach for them:
 *
 *   exportRawImage        the index image, headerless
 *   exportPaletteSequence every frame's palette, concatenated
 *   exportMultiClutTim    a single TIM whose CLUT holds every frame's palette
 *   renderTemplate        placement/metadata as user-authored text
 *
 * The animation model (`src/core/animation.ts`) is one fixed index image with
 * a palette per frame - "pre-baked palettes", not per-frame pixel data - so
 * `ExportSource.indices` is a single array shared across every frame. Only
 * `exportMultiClutTim`'s pixel section and `exportRawImage` touch it; the
 * other two exports never look at pixels at all.
 */

import type { ColorFormat, Entry } from '../shared/color.js';

export interface ExportSource {
  fmt: ColorFormat;
  width: number;
  height: number;
  indices: Uint8Array; // one byte per pixel
  frames: { palette: Entry[]; hold: number }[];
  /** null when playback does not loop. */
  loopStart: number | null;
  /** 'none' | 'forward' | 'backward' | 'pingpong', for a template to emit. */
  loopMode?: string;
  fps: number;
  name: string; // project name, no extension
}

/** Thrown with a message naming the field or constraint that failed. */
export class ExportError extends Error {}

function fail(what: string): never {
  throw new ExportError(what);
}

// ---------------------------------------------------------------------------
// Shared validation and index packing
// ---------------------------------------------------------------------------

/**
 * Confirm the source is internally consistent - every frame's palette the
 * same length, and the index image the size `width`x`height` claims - and
 * return that shared palette size. Every export below starts here, the same
 * "validate before trusting a field" discipline `project.ts` uses on load.
 */
function validateSource(src: ExportSource): number {
  if (src.frames.length === 0) fail('frames is empty');
  const size = src.frames[0].palette.length;
  if (size === 0) fail('frame 0 has an empty palette');
  for (let i = 1; i < src.frames.length; i++) {
    if (src.frames[i].palette.length !== size) {
      fail(`frame ${i} has ${src.frames[i].palette.length} palette entries but frame 0 has ${size}`);
    }
  }
  const expected = src.width * src.height;
  if (src.indices.length !== expected) {
    fail(`indices holds ${src.indices.length} bytes, but ${src.width}x${src.height} needs ${expected}`);
  }
  return size;
}

/**
 * A palette of `size` entries needs 4bpp indices up to 16 entries, 8bpp
 * beyond that - the same rule timweb's `timFromIndexed` applies via its
 * `clutWidth` check, just read the other direction (size -> depth instead of
 * depth -> max size).
 */
function bppForPaletteSize(size: number): 4 | 8 {
  if (size <= 16) return 4;
  if (size <= 256) return 8;
  fail(`palette has ${size} entries; indexed export supports at most 256`);
}

/**
 * Pack one row-major index image into TIM-halfword layout.
 *
 * Packing mirrors timweb's `tim.ts` `getTexel`/`setTexel` exactly (not
 * imported - copied by hand): at 8bpp the low byte of a halfword is the left
 * texel, at 4bpp the low nibble of the low byte is the leftmost texel.
 * timweb's own comment on `getTexel` records why: decoding real img2tim
 * output high-nibble-first scored 995/8192 wrong, low-nibble-first scored 0.
 *
 * `width` must be a multiple of the depth's texels-per-halfword (4 at 4bpp, 2
 * at 8bpp) for the same reason timweb's `timFromIndexed` requires it: a TIM
 * pixel section's width is counted in whole halfwords, so a narrower image
 * has no legal representation.
 */
function packIndices(
  indices: Uint8Array,
  width: number,
  height: number,
  bpp: 4 | 8,
): { w: number; data: Uint16Array } {
  const texelsPerHalfword = bpp === 4 ? 4 : 2;
  if (width % texelsPerHalfword !== 0) {
    fail(
      `width ${width} must be a multiple of ${texelsPerHalfword} at ${bpp}bpp ` +
        `(a TIM pixel section's width is counted in whole halfwords)`,
    );
  }
  const w = width / texelsPerHalfword;
  const data = new Uint16Array(w * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = indices[y * width + x];
      const hw = y * w + Math.floor(x / texelsPerHalfword);
      const shift = (x % texelsPerHalfword) * bpp;
      data[hw] |= (idx & ((1 << bpp) - 1)) << shift;
    }
  }
  return { w, data };
}

/** Little-endian byte view of a halfword array. Mirrors timweb raw.ts's `sectionBytes`. */
function halfwordsToLEBytes(data: Uint16Array): Uint8Array {
  const out = new Uint8Array(data.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < data.length; i++) view.setUint16(i * 2, data[i], true);
  return out;
}

// ---------------------------------------------------------------------------
// 1. Raw index image
// ---------------------------------------------------------------------------

export interface RawImageOptions {
  /**
   * Pack two 4bpp indices per byte (low nibble first), the way a TIM's own
   * pixel section is packed. Defaults to true.
   *
   * timweb's raw.ts has no such option because it never has unpacked data to
   * choose from - it slices `sectionBytes` straight out of an already-built
   * TIM, so what it emits at 4bpp IS the packed form, unconditionally. We
   * start from unpacked indices instead (`ExportSource.indices` is one byte
   * per pixel), so somewhere has to decide whether to pack, and an explicit
   * option beats a silent implicit choice. The default (true) reproduces
   * timweb's behaviour; `packed: false` is an addition timweb has no
   * equivalent of, for callers that want one byte per index regardless of
   * depth.
   */
  packed?: boolean;
}

/** The index image as raw bytes: headerless, nothing to parse. */
export function exportRawImage(src: ExportSource, options: RawImageOptions = {}): Uint8Array {
  const { packed = true } = options;
  const paletteSize = validateSource(src);
  const bpp = bppForPaletteSize(paletteSize);
  if (bpp === 8 || !packed) {
    // 8bpp is already one index per byte; nothing to pack either way.
    return Uint8Array.from(src.indices);
  }
  const { data } = packIndices(src.indices, src.width, src.height, bpp);
  return halfwordsToLEBytes(data);
}

// ---------------------------------------------------------------------------
// 2. Palette sequence
// ---------------------------------------------------------------------------

/**
 * Byte size of one packed palette in `fmt`. The documented constant the
 * caller uses to find frame N's palette inside `exportPaletteSequence`'s
 * output: `frame N starts at N * paletteStride(fmt, paletteSize)`.
 */
export function paletteStride(fmt: ColorFormat, paletteSize: number): number {
  return paletteSize * (fmt.entryBits / 8);
}

/**
 * Every frame's palette, packed in `src.fmt` and concatenated frame after
 * frame. 16-bit formats are written little-endian explicitly (PS1 is little-
 * endian and so is every host this runs in, but a value like 0x1F must still
 * come out as bytes `1f 00`, not whatever the host happens to do) - never via
 * a typed-array's native byte order. RGBA8888 is written as four separate
 * bytes, R, G, B, A, in that order; it is not a wire format with an
 * endianness of its own.
 */
export function exportPaletteSequence(src: ExportSource): Uint8Array {
  const paletteSize = validateSource(src);
  const stride = paletteStride(src.fmt, paletteSize);
  const out = new Uint8Array(stride * src.frames.length);
  const view = new DataView(out.buffer);

  for (let f = 0; f < src.frames.length; f++) {
    const base = f * stride;
    const palette = src.frames[f].palette;
    for (let i = 0; i < paletteSize; i++) {
      const e = palette[i];
      if (src.fmt.entryBits === 32) {
        const c = src.fmt.snap(e);
        const o = base + i * 4;
        out[o] = c.r;
        out[o + 1] = c.g;
        out[o + 2] = c.b;
        out[o + 3] = c.a;
      } else {
        view.setUint16(base + i * 2, src.fmt.pack(e), true);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Multi-CLUT TIM
// ---------------------------------------------------------------------------

/*
 * The constants and layout below are copied by hand from timweb's
 * `src/core/tim.ts` (not imported - clutter has no dependency on timweb).
 * That file's own header comment cites the source: psx-spx's "TIM
 * (Playstation Texture Image)" page, cdromfileformats.md. Only what a WRITER
 * needs is copied; none of timweb's tolerant-parsing machinery (junk flag
 * bits, mismatched length fields) applies to a file we are producing rather
 * than reading.
 *
 *   File header, 8 bytes, little endian:
 *     000h  1  ID       = 10h
 *     001h  1  Version  = 00h
 *     002h  2  Reserved = 0000h
 *     004h  4  Flags    bit0-2 = Type, bit3 = HasCLUT
 *     008h  .. CLUT section
 *     ...   .. Pixel section
 *
 *   Section, 12-byte preamble then payload:
 *     000h  4  Size in bytes, INCLUDING these 12
 *     004h  4  (Y << 16) | X    VRAM destination; X counted in HALFWORDS
 *     008h  4  (H << 16) | W    dimensions;       W counted in HALFWORDS
 *     00Ch  .. W * 2 * H bytes
 */
const TIM_ID = 0x10;
const TIM_VERSION = 0x00;
const FILE_HEADER_SIZE = 8;
const SECTION_HEADER_SIZE = 12;
const FLAG_HAS_CLUT = 1 << 3;
/** psx-spx, via timweb: shipped games use 11h for CLT despite Sony's spec. */
const CLT_ID = 0x11;
/** "The .CLT Type should be always 2 (meant to indicate 16bit CLUT entries)." */
const CLT_TYPE = 2;
const TIM_TYPE_BPP4 = 0;
const TIM_TYPE_BPP8 = 1;

interface TimSectionOut {
  x: number;
  y: number;
  w: number; // halfwords
  h: number;
  data: Uint16Array;
}

/** Write one 12-byte-preambled section at `cursor`; returns the next cursor. */
function writeTimSection(view: DataView, cursor: number, section: TimSectionOut): number {
  const payloadBytes = section.data.length * 2;
  view.setUint32(cursor, SECTION_HEADER_SIZE + payloadBytes, true);
  view.setUint32(cursor + 4, (((section.y & 0xffff) << 16) | (section.x & 0xffff)) >>> 0, true);
  view.setUint32(cursor + 8, (((section.h & 0xffff) << 16) | (section.w & 0xffff)) >>> 0, true);
  let p = cursor + SECTION_HEADER_SIZE;
  for (let i = 0; i < section.data.length; i++) {
    view.setUint16(p, section.data[i], true);
    p += 2;
  }
  return p;
}

export interface MultiClutTimOptions {
  /** Palettes placed side by side before wrapping to the next row. Default 1. */
  palettesPerRow?: number;
}

/**
 * Build a single TIM whose CLUT section holds every frame's palette.
 *
 * The CLUT is a 2D VRAM region and the palettes stack VERTICALLY - width is
 * the palette size (16 entries for 4bpp, 256 for 8bpp; short palettes are
 * padded with 0x0000, same as timweb's `timFromIndexed`), height is the
 * frame count. Row N is frame N's palette. That is spicyjpeg's own framing
 * and it is the entire point of this export: a program can page through the
 * animation by walking CLUT rows without re-uploading pixel data.
 *
 * RGB5551 only - the CLUT entries are packed 16-bit PlayStation colour
 * words, and packing an RGBA8888 or RGB565 palette into that would silently
 * throw away or misplace bits, so this refuses instead.
 */
/**
 * Lay every frame's palette out as one CLUT block.
 *
 * `palettesPerRow` palettes sit side by side before wrapping to the row below,
 * so the block is `perRow * slots` wide and `ceil(frames / perRow)` tall. One
 * per row - the default - stacks them vertically, which is the shape you would
 * DMA a row at a time.
 *
 * ⚠ **X and Y are always zero.** Placement in VRAM is timweb's job; writing a
 * coordinate here would claim a location this tool knows nothing about
 * (spicyjpeg, 2026-09-05).
 *
 * The row width is the DEPTH's slot count, 16 or 256, not however many colours
 * a frame happens to use. A 4-entry palette still occupies a 16-slot row with
 * the rest zero, because that is what the depth's CLUT lookup indexes into.
 */
export function clutLayout(
  paletteSize: number,
  frameCount: number,
  palettesPerRow: number,
): { slots: number; perRow: number; width: number; height: number } {
  const slots = bppForPaletteSize(paletteSize) === 4 ? 16 : 256;
  const perRow = Math.max(1, Math.min(frameCount, Math.floor(palettesPerRow) || 1));
  return { slots, perRow, width: slots * perRow, height: Math.ceil(frameCount / perRow) };
}

export function exportMultiClutTim(src: ExportSource, options: MultiClutTimOptions = {}): Uint8Array {
  if (src.fmt.id !== 'rgb5551') {
    fail(`exportMultiClutTim only supports rgb5551 palettes, got ${src.fmt.id}`);
  }
  const paletteSize = validateSource(src);
  const bpp = bppForPaletteSize(paletteSize);
  const clut = clutLayout(paletteSize, src.frames.length, options.palettesPerRow ?? 1);
  const clutData = buildClutBlock(src, paletteSize, clut);

  const { w: pixelW, data: pixelData } = packIndices(src.indices, src.width, src.height, bpp);

  const clutSection: TimSectionOut = { x: 0, y: 0, w: clut.width, h: clut.height, data: clutData };
  const pixelSection: TimSectionOut = { x: 0, y: 0, w: pixelW, h: src.height, data: pixelData };

  const total =
    FILE_HEADER_SIZE +
    SECTION_HEADER_SIZE +
    clutData.length * 2 +
    SECTION_HEADER_SIZE +
    pixelData.length * 2;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out[0] = TIM_ID;
  out[1] = TIM_VERSION;
  view.setUint16(2, 0, true);
  const flags = (bpp === 4 ? TIM_TYPE_BPP4 : TIM_TYPE_BPP8) | FLAG_HAS_CLUT;
  view.setUint32(4, flags, true);

  let cursor = FILE_HEADER_SIZE;
  cursor = writeTimSection(view, cursor, clutSection);
  writeTimSection(view, cursor, pixelSection);

  return out;
}

function buildClutBlock(
  src: ExportSource,
  paletteSize: number,
  clut: { slots: number; perRow: number; width: number; height: number },
): Uint16Array {
  const data = new Uint16Array(clut.width * clut.height);
  for (let f = 0; f < src.frames.length; f++) {
    const col = f % clut.perRow;
    const row = Math.floor(f / clut.perRow);
    const base = row * clut.width + col * clut.slots;
    const palette = src.frames[f].palette;
    for (let i = 0; i < paletteSize; i++) data[base + i] = src.fmt.pack(palette[i]);
  }
  return data;
}

/**
 * A .CLT: the same CLUT block on its own, with no pixel section.
 *
 * For palette animation this is often the artifact you actually want - the
 * image ships once and the animation IS the CLUT block. timweb's own notes
 * record that Sony's spec says 11h=PXL and 12h=CLT while shipped games use
 * them swapped; this follows the games, as timweb does.
 */
export function exportClt(src: ExportSource, options: MultiClutTimOptions = {}): Uint8Array {
  if (src.fmt.id !== 'rgb5551') {
    fail(`exportClt only supports rgb5551 palettes, got ${src.fmt.id}`);
  }
  const paletteSize = validateSource(src);
  const clut = clutLayout(paletteSize, src.frames.length, options.palettesPerRow ?? 1);
  const data = buildClutBlock(src, paletteSize, clut);

  const out = new Uint8Array(FILE_HEADER_SIZE + SECTION_HEADER_SIZE + data.length * 2);
  const view = new DataView(out.buffer);
  out[0] = CLT_ID;
  out[1] = TIM_VERSION;
  view.setUint16(2, 0, true);
  view.setUint32(4, CLT_TYPE, true);
  writeTimSection(view, FILE_HEADER_SIZE, { x: 0, y: 0, w: clut.width, h: clut.height, data });
  return out;
}

// ---------------------------------------------------------------------------
// 4. Template rendering
// ---------------------------------------------------------------------------

/*
 * Same tiny placeholder syntax as timweb's `src/core/template.ts` (copied by
 * hand below - `TOKEN`, `findBlock`, `substitute` - since clutter cannot
 * import timweb). Syntax:
 *
 *   {{name}}                    substitute a value
 *   {{x:hex}}                   ... as 0x1f
 *   {{x:hex4}}                  ... as 0x001f, zero-padded to 4 digits
 *   {{#frames}}...{{/frames}}   repeat once per frame
 *   {{#loop}}...{{/loop}}       only when the animation loops
 *   {{^loop}}...{{/loop}}       only when it does not
 *
 * timweb's repeating constructs are `{{#assets}}` and `{{#keepouts}}`, over
 * lists that don't exist in this data model; it has no per-frame repeat, so
 * `{{#frames}}` is new here - built the same way, as the task asked, since
 * timweb had nothing to reuse for it.
 *
 * An unknown placeholder is left alone rather than emptied - matches
 * timweb exactly, same reasoning: a typo shows up in the output instead of
 * quietly producing a blank field.
 */

export type Scalar = string | number | boolean;
export type Scope = Record<string, Scalar>;

function formatValue(value: Scalar, spec?: string): string {
  if (!spec) return String(value);
  const m = /^hex(\d*)$/i.exec(spec);
  if (m && typeof value === 'number') {
    const digits = m[1] ? Number(m[1]) : 0;
    const body = Math.abs(value).toString(16).padStart(digits, '0');
    const cased = spec.startsWith('HEX') ? body.toUpperCase() : body;
    return `${value < 0 ? '-' : ''}0x${cased}`;
  }
  return String(value);
}

const TOKEN = /\{\{\s*([#^/]?)([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z0-9]+))?\s*\}\}/g;

function substitute(text: string, scope: Scope): string {
  return text.replace(TOKEN, (whole, sigil: string, key: string, spec?: string) => {
    if (sigil) return whole;
    return key in scope ? formatValue(scope[key], spec) : whole;
  });
}

function findBlock(
  text: string,
  name: string,
  from = 0,
): { start: number; end: number; body: string; inverted: boolean } | undefined {
  const open = new RegExp(`\\{\\{\\s*([#^])\\s*${name}\\s*\\}\\}`, 'g');
  open.lastIndex = from;
  const m = open.exec(text);
  if (!m) return undefined;
  const closeTag = new RegExp(`\\{\\{\\s*/\\s*${name}\\s*\\}\\}`, 'g');
  closeTag.lastIndex = open.lastIndex;
  const c = closeTag.exec(text);
  if (!c) return undefined;
  return {
    start: m.index,
    end: c.index + c[0].length,
    body: text.slice(open.lastIndex, c.index),
    inverted: m[1] === '^',
  };
}

function topScope(src: ExportSource, paletteSize: number): Scope {
  const totalTicks = src.frames.reduce((n, f) => n + Math.max(1, f.hold), 0);
  return {
    name: src.name,
    nameId: cIdentifier(src.name),
    nameUpper: cIdentifier(src.name).toUpperCase(),
    width: src.width,
    height: src.height,
    pixelCount: src.width * src.height,
    paletteSize,
    frameCount: src.frames.length,
    totalTicks,
    fps: src.fps,
    hasLoop: src.loopStart !== null,
    // -1 when not looping: Scalar has no null, and this is the number a
    // template author would otherwise have to invent themselves.
    loopStart: src.loopStart ?? -1,
    loopMode: src.loopMode ?? (src.loopStart === null ? 'none' : 'forward'),
    colorFormat: src.fmt.label,
    colorFormatId: src.fmt.id,
  };
}

function frameScope(src: ExportSource, index: number, offset: number): Scope {
  return {
    index,
    hold: src.frames[index].hold,
    offset,
    isLoopStart: src.loopStart === index,
  };
}

/**
 * Render a template against one export source. Throws only on a malformed
 * `ExportSource` (via `validateSource`); a malformed block in the template
 * itself is left un-expanded rather than thrown on, matching timweb.
 */
/**
 * A project name is a filename and a C identifier is not.
 *
 * `indexed8-trns` produced `#define INDEXED8-TRNS_WIDTH 32`, which no compiler
 * accepts - caught by the end-to-end assertion that the default template's
 * output looks like C rather than merely being a non-empty string. Anything
 * outside [A-Za-z0-9_] becomes an underscore, and a leading digit gets one in
 * front, since an identifier cannot start with one.
 */
export function cIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || 'clutter';
}

export function renderTemplate(template: string, src: ExportSource): string {
  const paletteSize = validateSource(src);
  const top = topScope(src, paletteSize);
  let out = template;

  // {{#frames}} ... {{/frames}}
  for (;;) {
    const block = findBlock(out, 'frames');
    if (!block) break;
    let offset = 0;
    const rendered = src.frames
      .map((f, i) => {
        const scope = { ...top, ...frameScope(src, i, offset) };
        offset += Math.max(1, f.hold);
        return substitute(block.body, scope);
      })
      .join('');
    out = out.slice(0, block.start) + rendered + out.slice(block.end);
  }

  // {{#loop}} / {{^loop}}
  for (;;) {
    const block = findBlock(out, 'loop');
    if (!block) break;
    const keep = block.inverted ? !top.hasLoop : !!top.hasLoop;
    out = out.slice(0, block.start) + (keep ? substitute(block.body, top) : '') + out.slice(block.end);
  }

  return substitute(out, top);
}

/**
 * A starting template producing a usable C header: dimensions and frame
 * count as `#define`s, and a hold-time array so a program can drive its own
 * frame timer without re-deriving it.
 */
export const DEFAULT_TEMPLATE = `#define {{nameUpper}}_WIDTH {{width}}
#define {{nameUpper}}_HEIGHT {{height}}
#define {{nameUpper}}_FRAME_COUNT {{frameCount}}

static const unsigned char {{nameId}}_holds[] = {
{{#frames}}    {{hold}},
{{/frames}}};
`;
