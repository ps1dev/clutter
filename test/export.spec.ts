import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE,
  ExportError,
  cIdentifier,
  exportClt,
  exportMultiClutTim,
  exportPaletteSequence,
  exportRawImage,
  paletteStride,
  renderTemplate,
  type ExportSource,
} from '../src/core/export.js';
import { formatById, type Entry } from '../src/shared/color.js';

const e = (r: number, g: number, b: number, stp = false): Entry => ({ r, g, b, a: 255, stp });

/**
 * A 4x2 index image, three frames, a 4-entry (so 4bpp) rgb5551 palette per
 * frame. Small enough to hand-check every byte, big enough to exercise a
 * real multi-row CLUT and a multi-halfword pixel section.
 */
function sample(): ExportSource {
  return {
    fmt: formatById('rgb5551'),
    width: 4,
    height: 2,
    // one byte per pixel, values 0..3
    indices: Uint8Array.from([0, 1, 2, 3, 3, 2, 1, 0]),
    frames: [
      { hold: 1, palette: [e(255, 0, 0), e(0, 255, 0), e(0, 0, 255), e(255, 255, 0)] },
      { hold: 2, palette: [e(0, 0, 255), e(255, 0, 0), e(0, 255, 0), e(0, 255, 255)] },
      { hold: 3, palette: [e(0, 255, 0), e(0, 0, 255), e(255, 0, 0, true), e(255, 0, 255)] },
    ],
    loopStart: 1,
    fps: 30,
    name: 'demo',
  };
}

// ---------------------------------------------------------------------------
// Minimal TIM parser, written here rather than imported from timweb - it
// only needs to read back what exportMultiClutTim wrote, and asserting
// against a parser under someone else's ownership would beg the question.
// ---------------------------------------------------------------------------

interface ParsedSection {
  x: number;
  y: number;
  w: number; // halfwords
  h: number;
  data: Uint16Array;
}

interface ParsedTim {
  bpp: 4 | 8;
  clut: ParsedSection;
  pixels: ParsedSection;
}

function parseTim(bytes: Uint8Array): ParsedTim {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x10) throw new Error(`bad TIM id ${bytes[0]}`);
  if (bytes[1] !== 0x00) throw new Error(`bad TIM version ${bytes[1]}`);
  const flags = view.getUint32(4, true);
  const type = flags & 7;
  const hasClut = (flags & (1 << 3)) !== 0;
  if (!hasClut) throw new Error('expected HasCLUT set');
  const bpp: 4 | 8 = type === 0 ? 4 : type === 1 ? 8 : (() => {
    throw new Error(`unexpected TIM type ${type}`);
  })();

  function readSection(cursor: number): { section: ParsedSection; next: number } {
    const byteLen = view.getUint32(cursor, true);
    const xy = view.getUint32(cursor + 4, true);
    const wh = view.getUint32(cursor + 8, true);
    const x = xy & 0xffff;
    const y = (xy >>> 16) & 0xffff;
    const w = wh & 0xffff;
    const h = (wh >>> 16) & 0xffff;
    const data = new Uint16Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = view.getUint16(cursor + 12 + i * 2, true);
    return { section: { x, y, w, h, data }, next: cursor + byteLen };
  }

  const { section: clut, next } = readSection(8);
  const { section: pixels } = readSection(next);
  return { bpp, clut, pixels };
}

/** Unpack one texel from a parsed pixel section, mirroring the writer's own bit layout. */
function texelAt(tim: ParsedTim, x: number, y: number): number {
  const texelsPerHalfword = tim.bpp === 4 ? 4 : 2;
  const hw = tim.pixels.data[y * tim.pixels.w + Math.floor(x / texelsPerHalfword)];
  const shift = (x % texelsPerHalfword) * tim.bpp;
  return (hw >> shift) & ((1 << tim.bpp) - 1);
}

// ---------------------------------------------------------------------------
// exportMultiClutTim
// ---------------------------------------------------------------------------

/** Five distinguishable frames, for the block-layout assertions. */
function fiveFrames(): { palette: Entry[]; hold: number }[] {
  return Array.from({ length: 5 }, (_, f) => ({
    hold: 1,
    palette: Array.from({ length: 4 }, (_, i) => ({ r: (f * 8 + i * 2) % 32, g: 0, b: 0, a: 255 })),
  }));
}

describe('exportMultiClutTim', () => {
  it('stacks every frame\'s palette as a CLUT row and preserves the pixel data', () => {
    const src = sample();
    const tim = parseTim(exportMultiClutTim(src));
    const fmt = src.fmt;

    expect(tim.bpp).toBe(4);
    // Width is the DEPTH's max palette size (16 at 4bpp), not the 4 entries
    // this fixture actually uses - the padding is the point, it is what lets
    // a program index the CLUT by a fixed stride regardless of how many
    // colours a given frame happens to need.
    expect(tim.clut.w).toBe(16);
    expect(tim.clut.h).toBe(src.frames.length);

    for (let f = 0; f < src.frames.length; f++) {
      const row = tim.clut.data.subarray(f * tim.clut.w, f * tim.clut.w + tim.clut.w);
      for (let i = 0; i < src.frames[f].palette.length; i++) {
        expect(row[i]).toBe(fmt.pack(src.frames[f].palette[i]));
      }
      // Padding past the real palette entries is zero, not garbage.
      for (let i = src.frames[f].palette.length; i < tim.clut.w; i++) {
        expect(row[i]).toBe(0);
      }
    }

    // Pixel section: width in halfwords is width/4 at 4bpp, height unchanged.
    expect(tim.pixels.w).toBe(src.width / 4);
    expect(tim.pixels.h).toBe(src.height);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        expect(texelAt(tim, x, y)).toBe(src.indices[y * src.width + x]);
      }
    }
  });

  it('always writes 0,0 for both sections, with no way to ask otherwise', () => {
    // spicyjpeg, 2026-09-05: placement is timweb's job. Writing a coordinate
    // here would claim a VRAM location this tool knows nothing about. Asserted
    // rather than deleted, because "the option was removed" and "the option is
    // ignored" look identical from outside.
    const tim = parseTim(exportMultiClutTim(sample()));
    expect([tim.pixels.x, tim.pixels.y, tim.clut.x, tim.clut.y]).toEqual([0, 0, 0, 0]);
  });

  it('wraps palettes across the block at the requested width', () => {
    // Five frames, three per row: a 3x16 wide block two rows tall, with the
    // last row half empty. The discriminator against a purely vertical stack
    // is the WIDTH - a stacker would report 16 here whatever was asked for.
    const src = { ...sample(), frames: fiveFrames() };
    const tim = parseTim(exportMultiClutTim(src, { palettesPerRow: 3 }));
    expect(tim.clut.w).toBe(48);
    expect(tim.clut.h).toBe(2);
    // Frame 3 starts the second row, at x = 0.
    expect(tim.clut.data[1 * 48 + 0]).toBe(src.fmt.pack(src.frames[3].palette[0]));
    // Frame 2 sits third along the first row.
    expect(tim.clut.data[2 * 16]).toBe(src.fmt.pack(src.frames[2].palette[0]));
    // The unused tail of the last row is zero.
    expect(tim.clut.data[1 * 48 + 2 * 16]).toBe(0);
  });

  it('stacks vertically by default, which is one palette per row', () => {
    const src = { ...sample(), frames: fiveFrames() };
    const tim = parseTim(exportMultiClutTim(src));
    expect(tim.clut.w).toBe(16);
    expect(tim.clut.h).toBe(5);
  });

  it('never asks for more columns than there are frames', () => {
    const src = { ...sample(), frames: fiveFrames() };
    const tim = parseTim(exportMultiClutTim(src, { palettesPerRow: 99 }));
    expect(tim.clut.w).toBe(5 * 16);
    expect(tim.clut.h).toBe(1);
  });

  it('writes a .clt: the same block, no pixel section', () => {
    const src = { ...sample(), frames: fiveFrames() };
    const clt = exportClt(src, { palettesPerRow: 2 });
    const tim = exportMultiClutTim(src, { palettesPerRow: 2 });
    const view = new DataView(clt.buffer);
    expect(clt[0]).toBe(0x11);
    expect(view.getUint32(4, true)).toBe(2);
    // Same CLUT payload, and smaller than the TIM by exactly the pixel section.
    const clutBytes = 32 * 3 * 2;
    expect(clt.length).toBe(8 + 12 + clutBytes);
    expect(clt.length).toBeLessThan(tim.length);
    expect(Array.from(clt.subarray(20))).toEqual(Array.from(tim.subarray(20, 20 + clutBytes)));
  });

  it('refuses a .clt in a non-PlayStation format', () => {
    expect(() => exportClt({ ...sample(), fmt: formatById('rgb565') })).toThrow(/rgb565/);
  });

  it('rejects anything other than rgb5551, naming the format in the message', () => {
    const src = sample();
    src.fmt = formatById('rgba8888');
    expect(() => exportMultiClutTim(src)).toThrow(ExportError);
    expect(() => exportMultiClutTim(src)).toThrow(/rgba8888/);
  });

  it('packs 4bpp indices low-nibble-first (the classic packing-order bug)', () => {
    // A hand-picked case where high-nibble-first and low-nibble-first
    // disagree on every byte, so a swapped implementation cannot pass this
    // by accident. Indices [1, 2, 3, 0] need a palette of at least 4 entries
    // for index 3 to be valid.
    const src: ExportSource = {
      fmt: formatById('rgb5551'),
      width: 4,
      height: 1,
      indices: Uint8Array.from([1, 2, 3, 0]),
      frames: [{ hold: 1, palette: [e(0, 0, 0), e(1, 0, 0), e(2, 0, 0), e(3, 0, 0)] }],
      loopStart: null,
      fps: 60,
      name: 'nibbles',
    };
    const tim = parseTim(exportMultiClutTim(src));
    // byte0 low nibble = index[0]=1, high nibble = index[1]=2 -> 0x21
    // byte1 low nibble = index[2]=3, high nibble = index[3]=0 -> 0x03
    expect(tim.pixels.data[0]).toBe(0x0321);
  });
});

// ---------------------------------------------------------------------------
// exportRawImage
// ---------------------------------------------------------------------------

describe('exportRawImage', () => {
  it('packs two 4bpp indices per byte, low nibble first, by default', () => {
    const src: ExportSource = {
      fmt: formatById('rgb5551'),
      width: 4,
      height: 1,
      indices: Uint8Array.from([1, 2, 3, 0]),
      frames: [{ hold: 1, palette: [e(0, 0, 0), e(1, 0, 0), e(2, 0, 0), e(3, 0, 0)] }],
      loopStart: null,
      fps: 60,
      name: 'nibbles',
    };
    const bytes = exportRawImage(src);
    expect(Array.from(bytes)).toEqual([0x21, 0x03]);
  });

  it('emits one byte per index when packed is false', () => {
    const src: ExportSource = {
      fmt: formatById('rgb5551'),
      width: 4,
      height: 1,
      indices: Uint8Array.from([1, 2, 3, 0]),
      frames: [{ hold: 1, palette: [e(0, 0, 0), e(1, 0, 0), e(2, 0, 0), e(3, 0, 0)] }],
      loopStart: null,
      fps: 60,
      name: 'nibbles',
    };
    expect(Array.from(exportRawImage(src, { packed: false }))).toEqual([1, 2, 3, 0]);
  });

  it('leaves 8bpp images alone (already one index per byte)', () => {
    const palette = Array.from({ length: 20 }, (_, i) => e(i, i, i));
    const src: ExportSource = {
      fmt: formatById('rgb5551'),
      width: 2,
      height: 1,
      indices: Uint8Array.from([5, 19]),
      frames: [{ hold: 1, palette }],
      loopStart: null,
      fps: 60,
      name: 'wide',
    };
    expect(Array.from(exportRawImage(src))).toEqual([5, 19]);
  });

  it('rejects a width that is not a multiple of the depth\'s texel count', () => {
    const src: ExportSource = {
      fmt: formatById('rgb5551'),
      width: 3,
      height: 1,
      indices: Uint8Array.from([1, 2, 3]),
      frames: [{ hold: 1, palette: [e(0, 0, 0), e(1, 0, 0), e(2, 0, 0), e(3, 0, 0)] }],
      loopStart: null,
      fps: 60,
      name: 'odd',
    };
    expect(() => exportRawImage(src)).toThrow(ExportError);
    expect(() => exportRawImage(src)).toThrow(/multiple of 4/);
  });
});

// ---------------------------------------------------------------------------
// exportPaletteSequence
// ---------------------------------------------------------------------------

describe('exportPaletteSequence', () => {
  it('writes rgb5551 entries little-endian, explicitly', () => {
    const src: ExportSource = {
      fmt: formatById('rgb5551'),
      width: 2,
      height: 1,
      indices: Uint8Array.from([0, 0]),
      frames: [{ hold: 1, palette: [e(255, 0, 0)] }], // packs to 0x001f
      loopStart: null,
      fps: 60,
      name: 'led',
    };
    const bytes = exportPaletteSequence(src);
    expect(Array.from(bytes)).toEqual([0x1f, 0x00]);
  });

  it('places frame 1\'s palette at exactly paletteStride bytes in', () => {
    const src = sample();
    const stride = paletteStride(src.fmt, src.frames[0].palette.length);
    const bytes = exportPaletteSequence(src);
    const fmt = src.fmt;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < src.frames[1].palette.length; i++) {
      expect(view.getUint16(stride + i * 2, true)).toBe(fmt.pack(src.frames[1].palette[i]));
    }
    // and stride itself is exactly entries * 2 bytes for a 16-bit format
    expect(stride).toBe(src.frames[0].palette.length * 2);
  });

  it('writes rgba8888 entries as four bytes R,G,B,A, not as a packed word', () => {
    const src: ExportSource = {
      fmt: formatById('rgba8888'),
      width: 2,
      height: 1,
      indices: Uint8Array.from([0, 0]),
      frames: [{ hold: 1, palette: [{ r: 10, g: 20, b: 30, a: 40 }] }],
      loopStart: null,
      fps: 60,
      name: 'rgba',
    };
    expect(Array.from(exportPaletteSequence(src))).toEqual([10, 20, 30, 40]);
    expect(paletteStride(src.fmt, 1)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------

describe('renderTemplate', () => {
  it('substitutes every known placeholder', () => {
    const src = sample();
    const out = renderTemplate(
      '{{name}} {{width}}x{{height}} px={{pixelCount}} pal={{paletteSize}} ' +
        'frames={{frameCount}} ticks={{totalTicks}} fps={{fps}} loop={{loopStart}} fmt={{colorFormat}}',
      src,
    );
    expect(out).toBe(
      'demo 4x2 px=8 pal=4 frames=3 ticks=6 fps=30 loop=1 fmt=RGB5551 (PlayStation)',
    );
  });

  it('leaves an unknown placeholder untouched, matching timweb', () => {
    const out = renderTemplate('before {{notAField}} after', sample());
    expect(out).toBe('before {{notAField}} after');
  });

  it('formats a numeric field as zero-padded hex on request', () => {
    const out = renderTemplate('{{width:hex4}}', sample());
    expect(out).toBe('0x0004');
  });

  it('repeats a {{#frames}} block once per frame with per-frame fields', () => {
    const out = renderTemplate('{{#frames}}{{index}}:{{hold}} {{/frames}}', sample());
    expect(out).toBe('0:1 1:2 2:3 ');
  });

  it('renders {{#loop}} / {{^loop}} based on whether the animation loops', () => {
    const looping = sample();
    const notLooping = { ...sample(), loopStart: null };
    const tpl = '{{#loop}}loops at {{loopStart}}{{/loop}}{{^loop}}plays once{{/loop}}';
    expect(renderTemplate(tpl, looping)).toBe('loops at 1');
    expect(renderTemplate(tpl, notLooping)).toBe('plays once');
  });

  it('DEFAULT_TEMPLATE produces a parseable C header with a correctly-sized holds array', () => {
    const src = sample();
    const out = renderTemplate(DEFAULT_TEMPLATE, src);

    expect(out).toContain('#define DEMO_WIDTH 4');
    expect(out).toContain('#define DEMO_HEIGHT 2');
    expect(out).toContain('#define DEMO_FRAME_COUNT 3');

    const arrayMatch = /demo_holds\[\]\s*=\s*\{([\s\S]*?)\};/.exec(out);
    expect(arrayMatch).not.toBeNull();
    const values = arrayMatch![1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number);
    expect(values).toEqual(src.frames.map((f) => f.hold));
  });
});

describe('the default template emits usable C', () => {
  it('turns a filename into a legal identifier', () => {
    // A project called indexed8-trns produced INDEXED8-TRNS_WIDTH, which no
    // compiler accepts. Names come from filenames; identifiers do not.
    expect(cIdentifier('indexed8-trns')).toBe('indexed8_trns');
    expect(cIdentifier('3frames')).toBe('_3frames');
    expect(cIdentifier('my project (2)')).toBe('my_project__2_');
    expect(cIdentifier('')).toBe('clutter');
  });

  it('produces defines and an array a compiler would accept', () => {
    const out = renderTemplate(DEFAULT_TEMPLATE, { ...sample(), name: 'indexed8-trns' });
    expect(out).not.toMatch(/\{\{/);
    // Every identifier the template emits - the defines AND the array name -
    // has to be legal C. The array was the one I missed: sanitising only the
    // uppercase form left `indexed8-trns_holds[]` behind.
    const identifiers = [
      ...(out.match(/#define\s+(\S+)/g) ?? []).map((m) => m.split(/\s+/)[1]),
      ...(out.match(/unsigned char\s+(\S+?)\[/g) ?? []).map((m) => m.split(/\s+/)[2].replace('[', '')),
    ];
    expect(identifiers.length).toBeGreaterThanOrEqual(4);
    for (const id of identifiers) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(out).toMatch(/_WIDTH \d+/);
    expect(out).toMatch(/_FRAME_COUNT \d+/);
  });
});
