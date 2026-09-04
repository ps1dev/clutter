/**
 * Colour formats.
 *
 * The editor authors at 8 bits per channel and SNAPS every entry through the
 * target format before anything is displayed. That is deliberate: interpolate a
 * hue ramp at 8 bits, pack it to 5, and consecutive frames land on the same
 * value, so the animation stalls on some steps and not others. You cannot see
 * that unless the preview shows the truncated colour, so the preview always
 * shows the truncated colour.
 *
 * Three formats, and only one of them is strange:
 *
 *   rgba8888  32-bit RGBA, straight alpha. Snap is the identity.
 *   rgb565    16-bit, 5-6-5, no alpha at all.
 *   rgb5551   16-bit, 5-5-5 plus the PlayStation STP bit in bit 15.
 *
 * THE PLAYSTATION RULES, because they are not what the name suggests:
 *   - Bit 15 is NOT alpha. It marks the pixel semi-transparent, and it only
 *     does anything while the primitive is drawn with semi-transparency
 *     enabled at the command level. With ABE off, an STP pixel draws solid.
 *   - The value 0x0000 is ALWAYS fully transparent. So opaque black is not
 *     representable: you either accept 0x8000 (STP black, solid only while ABE
 *     is off) or nudge to 0x0421, which is R=G=B=1 and reads as near-black.
 *   - Consequence for this tool: an entry the user authored as opaque black
 *     changes meaning when snapped. `diagnose()` surfaces that rather than
 *     letting it happen quietly.
 */

/** Authoring-precision colour. Channels 0-255. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A palette entry: a colour plus the format-specific flag bits. */
export interface Entry extends Rgba {
  /** PlayStation semi-transparency flag (bit 15). Meaningless in other formats. */
  stp?: boolean;
}

export type FormatId = 'rgba8888' | 'rgb565' | 'rgb5551';

export interface ChannelBits {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ColorFormat {
  id: FormatId;
  label: string;
  /** Width of one packed palette entry, in bits. */
  entryBits: 16 | 32;
  /** Does the format carry a real per-entry alpha channel? */
  hasAlpha: boolean;
  /** Does the format carry the PlayStation STP flag? */
  hasStp: boolean;
  channelBits: ChannelBits;
  /** Round an authoring entry to what this format can actually store. */
  snap(e: Entry): Entry;
  pack(e: Entry): number;
  unpack(v: number): Entry;
  /**
   * What to actually paint on screen for this entry, as straight RGBA.
   * For rgb5551 this reports STP entries as OPAQUE, because whether they blend
   * is a property of the draw command and not of the palette.
   */
  display(e: Entry): Rgba;
  /** A warning for the UI when snapping changed the entry's meaning, else null. */
  diagnose(e: Entry): string | null;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Truncate an 8-bit channel to `bits` and expand it back, the way hardware sees it. */
export function truncateChannel(v: number, bits: number): number {
  if (bits >= 8) return clamp255(v);
  const max = (1 << bits) - 1;
  const n = Math.min(max, Math.max(0, Math.round((clamp255(v) * max) / 255)));
  // Bit replication, which is what the hardware does when it widens the channel.
  return Math.round((n * 255) / max);
}

/** The quantized level (not the expanded byte) of an 8-bit channel at `bits`. */
export function levelOf(v: number, bits: number): number {
  if (bits >= 8) return clamp255(v);
  const max = (1 << bits) - 1;
  // Must be the exact inverse of the widening in unpack(), which is
  // round(level * 255 / max). Biasing this by +127 and THEN rounding double-
  // rounds and breaks pack(unpack(v)) === v for a third of all values.
  return Math.min(max, Math.max(0, Math.round((clamp255(v) * max) / 255)));
}

const RGBA8888: ColorFormat = {
  id: 'rgba8888',
  label: 'RGBA8888',
  entryBits: 32,
  hasAlpha: true,
  hasStp: false,
  channelBits: { r: 8, g: 8, b: 8, a: 8 },
  snap: (e) => ({ r: clamp255(e.r), g: clamp255(e.g), b: clamp255(e.b), a: clamp255(e.a) }),
  pack: (e) =>
    ((clamp255(e.r) << 24) | (clamp255(e.g) << 16) | (clamp255(e.b) << 8) | clamp255(e.a)) >>> 0,
  unpack: (v) => ({
    r: (v >>> 24) & 0xff,
    g: (v >>> 16) & 0xff,
    b: (v >>> 8) & 0xff,
    a: v & 0xff,
  }),
  display: (e) => ({ r: clamp255(e.r), g: clamp255(e.g), b: clamp255(e.b), a: clamp255(e.a) }),
  diagnose: () => null,
};

const RGB565: ColorFormat = {
  id: 'rgb565',
  label: 'RGB565',
  entryBits: 16,
  hasAlpha: false,
  hasStp: false,
  channelBits: { r: 5, g: 6, b: 5, a: 0 },
  snap: (e) => ({
    r: truncateChannel(e.r, 5),
    g: truncateChannel(e.g, 6),
    b: truncateChannel(e.b, 5),
    a: 255,
  }),
  pack: (e) => ((levelOf(e.r, 5) << 11) | (levelOf(e.g, 6) << 5) | levelOf(e.b, 5)) & 0xffff,
  unpack: (v) => ({
    r: Math.round((((v >>> 11) & 0x1f) * 255) / 31),
    g: Math.round((((v >>> 5) & 0x3f) * 255) / 63),
    b: Math.round(((v & 0x1f) * 255) / 31),
    a: 255,
  }),
  display(e) {
    const s = this.snap(e);
    return { r: s.r, g: s.g, b: s.b, a: 255 };
  },
  diagnose: (e) =>
    e.a < 255 ? 'RGB565 has no alpha channel; this entry will be stored fully opaque.' : null,
};

export const STP_BIT = 0x8000;
/** The value the GPU always reads as fully transparent. */
export const PS1_TRANSPARENT = 0x0000;
/** Semi-transparent black: solid black on screen while ABE is off. */
export const PS1_STP_BLACK = 0x8000;
/** R=G=B=1. The usual stand-in for opaque black. */
export const PS1_NEAR_BLACK = 0x0421;

const RGB5551: ColorFormat = {
  id: 'rgb5551',
  label: 'RGB5551 (PlayStation)',
  entryBits: 16,
  hasAlpha: false,
  hasStp: true,
  channelBits: { r: 5, g: 5, b: 5, a: 0 },
  snap(e) {
    const packed = this.pack(e);
    return {
      r: truncateChannel(e.r, 5),
      g: truncateChannel(e.g, 5),
      b: truncateChannel(e.b, 5),
      // The GPU's own rule, reported honestly: 0x0000 is transparent whatever
      // the author meant by it.
      a: packed === PS1_TRANSPARENT ? 0 : 255,
      stp: !!e.stp,
    };
  },
  pack: (e) =>
    (((e.stp ? 1 : 0) << 15) |
      (levelOf(e.b, 5) << 10) |
      (levelOf(e.g, 5) << 5) |
      levelOf(e.r, 5)) &
    0xffff,
  unpack: (v) => ({
    r: Math.round(((v & 0x1f) * 255) / 31),
    g: Math.round((((v >>> 5) & 0x1f) * 255) / 31),
    b: Math.round((((v >>> 10) & 0x1f) * 255) / 31),
    a: (v & 0xffff) === PS1_TRANSPARENT ? 0 : 255,
    stp: (v & STP_BIT) !== 0,
  }),
  display(e) {
    const s = this.snap(e);
    return { r: s.r, g: s.g, b: s.b, a: s.a };
  },
  diagnose(e) {
    if (this.pack(e) === PS1_TRANSPARENT) {
      return 'Opaque black packs to 0x0000, which the GPU always reads as fully transparent. Set STP for solid black (only while semi-transparency is off), or nudge to 0x0421.';
    }
    return null;
  },
};

export const FORMATS: Record<FormatId, ColorFormat> = {
  rgba8888: RGBA8888,
  rgb565: RGB565,
  rgb5551: RGB5551,
};

export function formatById(id: FormatId): ColorFormat {
  return FORMATS[id];
}

/** True when two entries are indistinguishable once stored in `fmt`. */
export function sameInFormat(fmt: ColorFormat, a: Entry, b: Entry): boolean {
  return fmt.pack(a) === fmt.pack(b);
}

/**
 * How many DISTINCT steps a straight ramp from `a` to `b` can actually produce
 * in this format. Asking for more frames than this buys duplicates, not
 * smoothness, which is the thing you cannot see at 8 bits per channel.
 */
export function distinctRampSteps(fmt: ColorFormat, a: Entry, b: Entry): number {
  const bits = fmt.channelBits;
  const spans = [
    Math.abs(levelOf(a.r, bits.r) - levelOf(b.r, bits.r)),
    Math.abs(levelOf(a.g, bits.g) - levelOf(b.g, bits.g)),
    Math.abs(levelOf(a.b, bits.b) - levelOf(b.b, bits.b)),
  ];
  if (fmt.hasAlpha) spans.push(Math.abs(levelOf(a.a, bits.a) - levelOf(b.a, bits.a)));
  return Math.max(...spans) + 1;
}

/** Count runs of consecutive palettes that are byte-identical once packed. */
export function countStalledFrames(fmt: ColorFormat, frames: Entry[][]): number {
  let stalled = 0;
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    if (prev.length !== cur.length) continue;
    let identical = true;
    for (let k = 0; k < cur.length; k++) {
      if (fmt.pack(prev[k]) !== fmt.pack(cur[k])) {
        identical = false;
        break;
      }
    }
    if (identical) stalled++;
  }
  return stalled;
}
