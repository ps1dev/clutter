/**
 * Dependency-free PNG codec: decode indexed and truecolour PNGs (keeping
 * palette INDICES intact), encode indexed PNGs back out.
 *
 * Why this exists at all: the browser's own path -
 * `createImageBitmap` -> draw to canvas -> `getImageData` - throws away the
 * palette and hands back straight RGBA. That is fine for a viewer, but this
 * is a palette-animation editor: the whole trick is swapping the palette
 * under FIXED indices, so the indices are the one thing that must survive
 * the round trip. Hence: parse the file ourselves.
 *
 * Scope, deliberately narrow:
 *   - Adam7 interlacing is DETECTED and REJECTED, never silently
 *     mis-decoded. Producing garbage from an interlaced source is the
 *     failure mode that actually matters for an editor.
 *   - The encoder only ever writes colour type 3 (indexed). This tool never
 *     needs to author truecolour PNGs.
 *   - Filtering on encode is always type 0 (None). Simplicity over file
 *     size; nothing here is bandwidth-sensitive.
 *
 * Chunk inflate/deflate goes through `DecompressionStream`/`CompressionStream`
 * with the `'deflate'` format, which is zlib-wrapped (2-byte header + Adler32
 * trailer) - exactly what PNG's IDAT payload is. `'deflate-raw'` would be
 * wrong here; that's headerless deflate, used by zip entries, not PNG.
 */

import type { Rgba } from './color.js';

export interface IndexedImage {
  kind: 'indexed';
  width: number;
  height: number;
  /** One byte per pixel, row-major, value < palette.length. */
  indices: Uint8Array;
  /** tRNS folded in: entries with no explicit alpha decode to 255. */
  palette: Rgba[];
  /** Bit depth the source file actually used (1, 2, 4, or 8). */
  sourceBitDepth: 1 | 2 | 4 | 8;
}

export interface TruecolorImage {
  kind: 'truecolor';
  width: number;
  height: number;
  /** 4 bytes per pixel, row-major, straight alpha. */
  rgba: Uint8ClampedArray;
}

export type DecodedPng = IndexedImage | TruecolorImage;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const enum ColorType {
  Grayscale = 0,
  Truecolor = 2,
  Indexed = 3,
  GrayscaleAlpha = 4,
  TruecolorAlpha = 6,
}

/** Channels per pixel for each colour type, before any bit-depth packing. */
const CHANNELS_PER_COLOR_TYPE: Record<number, number> = {
  [ColorType.Grayscale]: 1,
  [ColorType.Truecolor]: 3,
  [ColorType.Indexed]: 1,
  [ColorType.GrayscaleAlpha]: 2,
  [ColorType.TruecolorAlpha]: 4,
};

interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: ColorType;
  interlace: number;
}

interface RawChunk {
  type: string;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// CRC32 - table-driven, matches zlib's polynomial (0xEDB88320, reflected).
// ---------------------------------------------------------------------------

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Chunk walking
// ---------------------------------------------------------------------------

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function writeUint32BE(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function parseChunks(bytes: Uint8Array): RawChunk[] {
  const chunks: RawChunk[] = [];
  let pos = PNG_SIGNATURE.length;
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) {
      throw new Error('PNG truncated: incomplete chunk header');
    }
    const length = readUint32BE(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`PNG truncated: ${type} chunk data runs past end of file`);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    const storedCrc = readUint32BE(bytes, dataEnd);

    // CRC covers the chunk type bytes plus the chunk data, per spec.
    const isCritical = type[0] === type[0].toUpperCase();
    if (isCritical) {
      const typeAndData = bytes.subarray(pos + 4, dataEnd);
      const computedCrc = crc32(typeAndData);
      if (computedCrc !== storedCrc) {
        throw new Error(`PNG CRC mismatch in ${type} chunk`);
      }
    }

    chunks.push({ type, data });
    pos = dataEnd + 4;
    if (type === 'IEND') {
      break;
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// IHDR
// ---------------------------------------------------------------------------

function parseIhdr(data: Uint8Array): Ihdr {
  if (data.length < 13) {
    throw new Error('PNG IHDR chunk is too short');
  }
  const width = readUint32BE(data, 0);
  const height = readUint32BE(data, 4);
  const bitDepth = data[8];
  const colorType = data[9] as ColorType;
  const compressionMethod = data[10];
  const filterMethod = data[11];
  const interlace = data[12];

  if (width === 0 || height === 0) {
    throw new Error('PNG has zero width or height');
  }
  if (compressionMethod !== 0) {
    throw new Error(`unsupported PNG compression method ${compressionMethod}`);
  }
  if (filterMethod !== 0) {
    throw new Error(`unsupported PNG filter method ${filterMethod}`);
  }
  if (!(colorType in CHANNELS_PER_COLOR_TYPE)) {
    throw new Error(`unsupported PNG colour type ${colorType}`);
  }
  if (interlace !== 0 && interlace !== 1) {
    throw new Error(`unsupported PNG interlace method ${interlace}`);
  }
  if (interlace === 1) {
    throw new Error('interlaced PNG is not supported');
  }

  const validBitDepths: Record<number, number[]> = {
    [ColorType.Grayscale]: [1, 2, 4, 8, 16],
    [ColorType.Truecolor]: [8, 16],
    [ColorType.Indexed]: [1, 2, 4, 8],
    [ColorType.GrayscaleAlpha]: [8, 16],
    [ColorType.TruecolorAlpha]: [8, 16],
  };
  if (!validBitDepths[colorType].includes(bitDepth)) {
    throw new Error(`bit depth ${bitDepth} is not valid for PNG colour type ${colorType}`);
  }
  if (bitDepth < 8 && colorType !== ColorType.Indexed) {
    throw new Error(
      `grayscale PNGs with bit depth ${bitDepth} are not supported (only 8 and 16 bit grayscale, and any depth of indexed, are supported)`,
    );
  }

  return { width, height, bitDepth, colorType, interlace };
}

// ---------------------------------------------------------------------------
// Inflate (zlib-wrapped, via DecompressionStream)
// ---------------------------------------------------------------------------

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not available in this environment');
  }
  // Copy into a fresh ArrayBuffer-backed view: `data` may be a subarray view
  // over a larger buffer, and Blob/Response want their own bytes.
  const owned = new Uint8Array(data);
  const stream = new Blob([owned]).stream().pipeThrough(new DecompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not available in this environment');
  }
  const owned = new Uint8Array(data);
  const stream = new Blob([owned]).stream().pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// Scanline un-filtering
// ---------------------------------------------------------------------------

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Un-filters raw inflated scanline data in place and returns the packed
 * pixel bytes (filter bytes stripped). `bpp` is bytes-per-pixel rounded UP
 * (minimum 1) - PNG defines the filter's "previous pixel" reference in
 * whole bytes even for sub-byte bit depths, where bpp is 1 and the filter
 * effectively looks at the previous BYTE, not the previous pixel.
 */
function unfilterScanlines(raw: Uint8Array, width: number, height: number, bpp: number, rowBytes: number): Uint8Array {
  const stride = rowBytes + 1; // +1 for the filter type byte
  const expected = stride * height;
  if (raw.length < expected) {
    throw new Error(
      `PNG pixel data is shorter than expected: got ${raw.length} bytes, need ${expected}`,
    );
  }

  const out = new Uint8Array(rowBytes * height);
  let prevRowStart = -1; // -1 = no previous row (treat as all zeros)

  for (let y = 0; y < height; y++) {
    const srcRowStart = y * stride;
    const filterType = raw[srcRowStart];
    const srcPixels = srcRowStart + 1;
    const dstRowStart = y * rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[srcPixels + x];
      const a = x >= bpp ? out[dstRowStart + x - bpp] : 0; // left
      const b = prevRowStart >= 0 ? out[prevRowStart + x] : 0; // up
      const c = x >= bpp && prevRowStart >= 0 ? out[prevRowStart + x - bpp] : 0; // upper-left

      let value: number;
      switch (filterType) {
        case 0: // None
          value = rawByte;
          break;
        case 1: // Sub
          value = rawByte + a;
          break;
        case 2: // Up
          value = rawByte + b;
          break;
        case 3: // Average
          value = rawByte + Math.floor((a + b) / 2);
          break;
        case 4: // Paeth
          value = rawByte + paethPredictor(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG scanline filter type ${filterType}`);
      }
      out[dstRowStart + x] = value & 0xff;
    }

    prevRowStart = dstRowStart;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Sub-byte / multi-byte sample unpacking
// ---------------------------------------------------------------------------

/**
 * Unpacks one sample (channel value) per pixel from packed scanline bytes.
 * Sub-byte depths are MSB-first within each byte and each row starts on a
 * byte boundary (padding bits at the end of a row are ignored). Returns
 * values still in their native bit-depth range (e.g. 0-15 for depth 4).
 */
function unpackSamples(
  pixelBytes: Uint8Array,
  width: number,
  height: number,
  channels: number,
  bitDepth: number,
  rowBytes: number,
): Uint16Array {
  const samplesPerRow = width * channels;
  const out = new Uint16Array(samplesPerRow * height);

  if (bitDepth === 8) {
    for (let y = 0; y < height; y++) {
      const srcOff = y * rowBytes;
      const dstOff = y * samplesPerRow;
      for (let i = 0; i < samplesPerRow; i++) {
        out[dstOff + i] = pixelBytes[srcOff + i];
      }
    }
    return out;
  }

  if (bitDepth === 16) {
    for (let y = 0; y < height; y++) {
      const srcOff = y * rowBytes;
      const dstOff = y * samplesPerRow;
      for (let i = 0; i < samplesPerRow; i++) {
        // Take the high byte only - callers that want 16-bit-accurate data
        // would need a different return type; this codec downshifts to 8.
        out[dstOff + i] = pixelBytes[srcOff + i * 2];
      }
    }
    return out;
  }

  // bitDepth is 1, 2, or 4: MSB-first packing, row-aligned to a byte.
  for (let y = 0; y < height; y++) {
    const srcOff = y * rowBytes;
    const dstOff = y * samplesPerRow;
    let bitPos = 0;
    for (let i = 0; i < samplesPerRow; i++) {
      const byteIndex = srcOff + (bitPos >> 3);
      const bitOffsetInByte = bitPos & 7;
      const shift = 8 - bitDepth - bitOffsetInByte;
      const mask = (1 << bitDepth) - 1;
      out[dstOff + i] = (pixelBytes[byteIndex] >> shift) & mask;
      bitPos += bitDepth;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PLTE / tRNS
// ---------------------------------------------------------------------------

function parsePlte(data: Uint8Array): Array<[number, number, number]> {
  if (data.length % 3 !== 0) {
    throw new Error('PNG PLTE chunk length is not a multiple of 3');
  }
  const entries: Array<[number, number, number]> = [];
  for (let i = 0; i < data.length; i += 3) {
    entries.push([data[i], data[i + 1], data[i + 2]]);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error('not a PNG file: bad signature');
    }
  }

  const chunks = parseChunks(bytes);
  if (chunks.length === 0 || chunks[0].type !== 'IHDR') {
    throw new Error('PNG must start with an IHDR chunk');
  }
  const ihdr = parseIhdr(chunks[0].data);

  let plte: Array<[number, number, number]> | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let sawIend = false;

  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'IHDR':
        break;
      case 'PLTE':
        plte = parsePlte(chunk.data);
        break;
      case 'tRNS':
        trns = chunk.data;
        break;
      case 'IDAT':
        idatParts.push(chunk.data);
        break;
      case 'IEND':
        sawIend = true;
        break;
      default:
        // Unknown/ancillary chunk: ignored, per spec.
        break;
    }
  }

  if (!sawIend) {
    throw new Error('PNG is missing its IEND chunk');
  }
  if (idatParts.length === 0) {
    throw new Error('PNG has no IDAT data');
  }
  if (ihdr.colorType === ColorType.Indexed && !plte) {
    throw new Error('indexed PNG has no PLTE chunk');
  }

  let totalIdatLength = 0;
  for (const part of idatParts) totalIdatLength += part.length;
  const combinedIdat = new Uint8Array(totalIdatLength);
  let offset = 0;
  for (const part of idatParts) {
    combinedIdat.set(part, offset);
    offset += part.length;
  }

  const inflated = await inflateZlib(combinedIdat);

  const channels = CHANNELS_PER_COLOR_TYPE[ihdr.colorType];
  const bitsPerPixel = channels * ihdr.bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const rowBytes = Math.ceil((ihdr.width * bitsPerPixel) / 8);

  const pixelBytes = unfilterScanlines(inflated, ihdr.width, ihdr.height, bpp, rowBytes);
  const samples = unpackSamples(pixelBytes, ihdr.width, ihdr.height, channels, ihdr.bitDepth, rowBytes);

  if (ihdr.colorType === ColorType.Indexed) {
    // plte is guaranteed non-null above.
    const paletteEntries = plte as Array<[number, number, number]>;
    const maxIndex = paletteEntries.length - 1;
    const palette: Rgba[] = paletteEntries.map(([r, g, b], i) => ({
      r,
      g,
      b,
      a: trns && i < trns.length ? trns[i] : 255,
    }));

    const indices = new Uint8Array(ihdr.width * ihdr.height);
    for (let i = 0; i < indices.length; i++) {
      const value = samples[i];
      if (value > maxIndex) {
        throw new Error(
          `PNG pixel index ${value} is out of range for a ${paletteEntries.length}-entry palette`,
        );
      }
      indices[i] = value;
    }

    if (!(ihdr.bitDepth === 1 || ihdr.bitDepth === 2 || ihdr.bitDepth === 4 || ihdr.bitDepth === 8)) {
      // Unreachable given parseIhdr's validation, but keeps the type narrow.
      throw new Error(`unexpected indexed PNG bit depth ${ihdr.bitDepth}`);
    }

    return {
      kind: 'indexed',
      width: ihdr.width,
      height: ihdr.height,
      indices,
      palette,
      sourceBitDepth: ihdr.bitDepth as 1 | 2 | 4 | 8,
    };
  }

  // Truecolor family: grayscale, RGB, gray+alpha, RGBA. All become RGBA8.
  const rgba = new Uint8ClampedArray(ihdr.width * ihdr.height * 4);
  const pixelCount = ihdr.width * ihdr.height;

  // Colour-key transparency (tRNS on colour types 0/2): a single exact
  // sample tuple that should decode to alpha 0.
  let colorKey: number[] | null = null;
  if (trns) {
    if (ihdr.colorType === ColorType.Grayscale) {
      if (trns.length < 2) {
        throw new Error('PNG grayscale tRNS chunk is too short');
      }
      // tRNS for grayscale is always a 2-byte big-endian sample value, even
      // at sub-16 bit depths (where it fits in the low byte, trns[1]). Our
      // unpacked samples are downshifted to the high byte only when the
      // source is 16-bit, and are native range otherwise - key on the same
      // byte we used to build the sample.
      colorKey = [ihdr.bitDepth === 16 ? trns[0] : trns[1]];
    } else if (ihdr.colorType === ColorType.Truecolor) {
      if (trns.length < 6) {
        throw new Error('PNG truecolor tRNS chunk is too short');
      }
      colorKey = [
        ihdr.bitDepth === 16 ? trns[0] : trns[1],
        ihdr.bitDepth === 16 ? trns[2] : trns[3],
        ihdr.bitDepth === 16 ? trns[4] : trns[5],
      ];
    }
    // tRNS is invalid (and ignored by parseIhdr's chunk pass-through) for
    // colour types 4/6, which already carry a real alpha channel.
  }

  for (let p = 0; p < pixelCount; p++) {
    const srcOff = p * channels;
    let r: number, g: number, b: number, a: number;
    switch (ihdr.colorType) {
      case ColorType.Grayscale: {
        const v = samples[srcOff];
        r = g = b = v;
        a = colorKey && colorKey[0] === v ? 0 : 255;
        break;
      }
      case ColorType.Truecolor: {
        r = samples[srcOff];
        g = samples[srcOff + 1];
        b = samples[srcOff + 2];
        a = colorKey && colorKey[0] === r && colorKey[1] === g && colorKey[2] === b ? 0 : 255;
        break;
      }
      case ColorType.GrayscaleAlpha: {
        const v = samples[srcOff];
        r = g = b = v;
        a = samples[srcOff + 1];
        break;
      }
      case ColorType.TruecolorAlpha: {
        r = samples[srcOff];
        g = samples[srcOff + 1];
        b = samples[srcOff + 2];
        a = samples[srcOff + 3];
        break;
      }
      default:
        throw new Error(`unexpected truecolor-family colour type ${ihdr.colorType}`);
    }
    const dstOff = p * 4;
    rgba[dstOff] = r;
    rgba[dstOff + 1] = g;
    rgba[dstOff + 2] = b;
    rgba[dstOff + 3] = a;
  }

  return {
    kind: 'truecolor',
    width: ihdr.width,
    height: ihdr.height,
    rgba,
  };
}

// ---------------------------------------------------------------------------
// Encode (indexed only)
// ---------------------------------------------------------------------------

function bitDepthForPaletteSize(paletteLength: number): 1 | 2 | 4 | 8 {
  if (paletteLength <= 2) return 1;
  if (paletteLength <= 4) return 2;
  if (paletteLength <= 16) return 4;
  if (paletteLength <= 256) return 8;
  throw new Error(`palette has ${paletteLength} entries; PNG indexed colour supports at most 256`);
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);

  const lengthBytes: number[] = [];
  writeUint32BE(lengthBytes, data.length);

  const typeAndData = new Uint8Array(typeBytes.length + data.length);
  typeAndData.set(typeBytes, 0);
  typeAndData.set(data, typeBytes.length);
  const crc = crc32(typeAndData);
  const crcBytes: number[] = [];
  writeUint32BE(crcBytes, crc);

  const chunk = new Uint8Array(4 + typeAndData.length + 4);
  chunk.set(lengthBytes, 0);
  chunk.set(typeAndData, 4);
  chunk.set(crcBytes, 4 + typeAndData.length);
  return chunk;
}

/**
 * Packs one index per pixel into PNG's row-aligned, MSB-first sub-byte
 * layout (or a plain byte-per-pixel copy at depth 8).
 */
function packIndexedScanlines(
  indices: Uint8Array,
  width: number,
  height: number,
  bitDepth: 1 | 2 | 4 | 8,
): Uint8Array {
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const stride = rowBytes + 1; // +1 for the filter type byte, always 0 (None)
  const out = new Uint8Array(stride * height);

  if (bitDepth === 8) {
    for (let y = 0; y < height; y++) {
      out[y * stride] = 0; // filter: None
      out.set(indices.subarray(y * width, (y + 1) * width), y * stride + 1);
    }
    return out;
  }

  for (let y = 0; y < height; y++) {
    const dstRowStart = y * stride;
    out[dstRowStart] = 0; // filter: None
    let bitPos = 0;
    for (let x = 0; x < width; x++) {
      const value = indices[y * width + x];
      const byteIndex = dstRowStart + 1 + (bitPos >> 3);
      const bitOffsetInByte = bitPos & 7;
      const shift = 8 - bitDepth - bitOffsetInByte;
      out[byteIndex] |= (value << shift) & 0xff;
      bitPos += bitDepth;
    }
  }
  return out;
}

export async function encodeIndexedPng(img: {
  width: number;
  height: number;
  indices: Uint8Array;
  palette: Rgba[];
}): Promise<Uint8Array> {
  const { width, height, indices, palette } = img;

  if (width <= 0 || height <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`invalid image dimensions ${width}x${height}`);
  }
  if (indices.length !== width * height) {
    throw new Error(
      `indices length ${indices.length} does not match ${width}x${height} = ${width * height}`,
    );
  }
  if (palette.length === 0) {
    throw new Error('palette must have at least one entry');
  }
  if (palette.length > 256) {
    throw new Error(`palette has ${palette.length} entries; PNG indexed colour supports at most 256`);
  }
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= palette.length) {
      throw new Error(
        `index ${indices[i]} at pixel ${i} is out of range for a ${palette.length}-entry palette`,
      );
    }
  }

  const bitDepth = bitDepthForPaletteSize(palette.length);

  const ihdrData = new Uint8Array(13);
  const ihdrFields: number[] = [];
  writeUint32BE(ihdrFields, width);
  writeUint32BE(ihdrFields, height);
  ihdrData.set(ihdrFields, 0);
  ihdrData[8] = bitDepth;
  ihdrData[9] = ColorType.Indexed;
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace: none

  const plteData = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    plteData[i * 3] = palette[i].r;
    plteData[i * 3 + 1] = palette[i].g;
    plteData[i * 3 + 2] = palette[i].b;
  }

  // tRNS is emitted only if some entry is not fully opaque, and truncated
  // right after the last non-255 entry - both per spec and matching what
  // other encoders (including Pillow, our own test oracle) produce.
  let lastNonOpaque = -1;
  for (let i = 0; i < palette.length; i++) {
    if (palette[i].a !== 255) lastNonOpaque = i;
  }
  let trnsChunk: Uint8Array | null = null;
  if (lastNonOpaque >= 0) {
    const trnsData = new Uint8Array(lastNonOpaque + 1);
    for (let i = 0; i <= lastNonOpaque; i++) {
      trnsData[i] = palette[i].a;
    }
    trnsChunk = buildChunk('tRNS', trnsData);
  }

  const scanlines = packIndexedScanlines(indices, width, height, bitDepth);
  const compressed = await deflateZlib(scanlines);

  const chunks: Uint8Array[] = [
    buildChunk('IHDR', ihdrData),
    buildChunk('PLTE', plteData),
  ];
  if (trnsChunk) chunks.push(trnsChunk);
  chunks.push(buildChunk('IDAT', compressed));
  chunks.push(buildChunk('IEND', new Uint8Array(0)));

  let totalLength = PNG_SIGNATURE.length;
  for (const chunk of chunks) totalLength += chunk.length;

  const out = new Uint8Array(totalLength);
  out.set(PNG_SIGNATURE, 0);
  let pos = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
