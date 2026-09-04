/**
 * Applying a palette to an indexed image, fast enough to do it every frame.
 *
 * The whole tool is "same indices, different palette, sixty times a second",
 * so this is the hot path and nothing else is close. Per frame we build a
 * 256-entry lookup of packed RGBA words and then run one tight loop over a
 * Uint32Array view of the ImageData. That is one multiply-free pass per pixel
 * with no per-pixel object allocation and no per-pixel format dispatch.
 *
 * ENDIANNESS: a Uint32Array view over an RGBA byte buffer packs in the host's
 * byte order, which is little-endian on everything this will realistically run
 * on and big-endian on things that still exist. Detected once at module load
 * rather than assumed, because getting it wrong swaps red and blue and looks
 * exactly like a palette bug.
 */

import type { ColorFormat, Entry } from '../shared/color.js';

const LITTLE_ENDIAN = (() => {
  const probe = new ArrayBuffer(4);
  new Uint32Array(probe)[0] = 0x11223344;
  return new Uint8Array(probe)[0] === 0x44;
})();

/** True on little-endian hosts. Exported so tests can assert the byte order that is actually in play. */
export const HOST_LITTLE_ENDIAN = LITTLE_ENDIAN;

export function packWord(r: number, g: number, b: number, a: number): number {
  return LITTLE_ENDIAN
    ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/** Build the per-frame lookup: palette index -> packed RGBA word. */
export function paletteLut(fmt: ColorFormat, palette: Entry[], size = 256): Uint32Array {
  const lut = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    const e = palette[i];
    if (!e) {
      lut[i] = 0; // out of palette: fully transparent, and visibly so
      continue;
    }
    const d = fmt.display(e);
    lut[i] = packWord(d.r, d.g, d.b, d.a);
  }
  return lut;
}

/**
 * Paint `indices` through `lut` into `target`, which must already be the right
 * size. Reuse the same ImageData across frames; allocating one per frame is
 * what turns a smooth preview into a garbage-collection stutter.
 */
export function composeInto(
  // Structurally typed rather than `ImageData` so this is testable without a
  // DOM. It only ever touches `.data`, and an untestable hot path is how a
  // red/blue swap ships.
  target: { data: Uint8ClampedArray },
  indices: Uint8Array,
  lut: Uint32Array,
): void {
  const words = new Uint32Array(target.data.buffer, target.data.byteOffset, target.data.length / 4);
  const n = Math.min(words.length, indices.length);
  for (let i = 0; i < n; i++) {
    words[i] = lut[indices[i]];
  }
}

/** Allocate a reusable ImageData without needing a canvas element. */
export function createImageBuffer(width: number, height: number): ImageData {
  return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
}
