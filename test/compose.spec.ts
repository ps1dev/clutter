import { describe, expect, it } from 'vitest';
import { composeInto, HOST_LITTLE_ENDIAN, packWord, paletteLut } from '../src/core/compose.js';
import { formatById, type Entry } from '../src/shared/color.js';

const e = (r: number, g: number, b: number, a = 255, stp = false): Entry => ({ r, g, b, a, stp });

/** A stand-in for ImageData; composeInto only ever touches `.data`. */
const buffer = (pixels: number) => ({ data: new Uint8ClampedArray(pixels * 4) });

describe('packWord', () => {
  it('lays bytes out as R,G,B,A in memory whatever the host order', () => {
    // The claim that matters is not "the word equals 0x...", it is "the BYTES
    // land in RGBA order", because that is what the canvas reads. Assert the
    // bytes, so the test is not just a restatement of the packing expression.
    const buf = buffer(1);
    const words = new Uint32Array(buf.data.buffer);
    words[0] = packWord(1, 2, 3, 4);
    expect([buf.data[0], buf.data[1], buf.data[2], buf.data[3]]).toEqual([1, 2, 3, 4]);
  });

  it('agrees with the host order it detected', () => {
    const probe = new ArrayBuffer(4);
    new Uint32Array(probe)[0] = 0x11223344;
    expect(new Uint8Array(probe)[0] === 0x44).toBe(HOST_LITTLE_ENDIAN);
  });
});

describe('paletteLut', () => {
  it('runs entries through the format, not through the raw values', () => {
    const fmt = formatById('rgb5551');
    // 255,8,0: red survives, green truncates to level 1 which widens to 8.
    const lut = paletteLut(fmt, [e(255, 8, 0)], 1);
    const buf = buffer(1);
    new Uint32Array(buf.data.buffer)[0] = lut[0];
    expect(buf.data[0]).toBe(255);
    expect(buf.data[1]).toBe(8);
    expect(buf.data[2]).toBe(0);
    expect(buf.data[3]).toBe(255);
  });

  it('reports PS1 opaque black as transparent, matching the GPU', () => {
    const fmt = formatById('rgb5551');
    const lut = paletteLut(fmt, [e(0, 0, 0)], 1);
    const buf = buffer(1);
    new Uint32Array(buf.data.buffer)[0] = lut[0];
    expect(buf.data[3]).toBe(0);
  });

  it('renders an STP entry at half alpha, distinct from both opaque and transparent', () => {
    // Changed 2026-09-05 on spicyjpeg's ask: a flagged entry drawn identically
    // to an unflagged one gives no way to see which is which. Half alpha is a
    // convention - the flag only blends when the primitive enables it - so the
    // assertion that matters is that all THREE states are distinguishable.
    const fmt = formatById('rgb5551');
    const alphaOf = (entry: Entry): number => {
      const buf = buffer(1);
      new Uint32Array(buf.data.buffer)[0] = paletteLut(fmt, [entry], 1)[0];
      return buf.data[3];
    };
    const stp = alphaOf(e(0, 0, 0, 255, true));
    const opaque = alphaOf(e(255, 255, 255, 255));
    const transparent = alphaOf(e(0, 0, 0, 255));
    expect(stp).toBe(128);
    expect(opaque).toBe(255);
    expect(transparent).toBe(0);
    expect(new Set([stp, opaque, transparent]).size).toBe(3);
  });

  it('paints indices past the end of the palette as transparent', () => {
    const fmt = formatById('rgba8888');
    const lut = paletteLut(fmt, [e(1, 2, 3)], 4);
    expect(lut[0]).not.toBe(0);
    expect(lut[1]).toBe(0);
    expect(lut[3]).toBe(0);
  });
});

describe('composeInto', () => {
  it('writes one palette colour per index', () => {
    const fmt = formatById('rgba8888');
    const lut = paletteLut(fmt, [e(10, 20, 30), e(40, 50, 60)], 2);
    const buf = buffer(4);
    composeInto(buf, Uint8Array.from([0, 1, 1, 0]), lut);
    expect(Array.from(buf.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
    expect(Array.from(buf.data.slice(4, 8))).toEqual([40, 50, 60, 255]);
    expect(Array.from(buf.data.slice(12, 16))).toEqual([10, 20, 30, 255]);
  });

  it('changes every pixel when only the palette changes', () => {
    // The central claim of the whole tool: same indices, different palette.
    const fmt = formatById('rgba8888');
    const indices = Uint8Array.from([0, 1, 0, 1]);
    const buf = buffer(4);
    composeInto(buf, indices, paletteLut(fmt, [e(1, 1, 1), e(2, 2, 2)], 2));
    const before = Array.from(buf.data);
    composeInto(buf, indices, paletteLut(fmt, [e(9, 9, 9), e(8, 8, 8)], 2));
    expect(Array.from(buf.data)).not.toEqual(before);
    expect(buf.data[0]).toBe(9);
    expect(buf.data[4]).toBe(8);
  });

  it('stops at the shorter of the two lengths rather than running off the end', () => {
    const fmt = formatById('rgba8888');
    const lut = paletteLut(fmt, [e(7, 7, 7)], 1);
    const buf = buffer(2);
    composeInto(buf, Uint8Array.from([0, 0, 0, 0, 0]), lut);
    expect(buf.data).toHaveLength(8);
    expect(buf.data[4]).toBe(7);
  });
});
