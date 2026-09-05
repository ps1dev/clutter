import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  formatProjectJson,
  parseProject,
  ProjectError,
  serializeProject,
  type SerializeInput,
} from '../src/core/project.js';
import { formatById, type Entry } from '../src/shared/color.js';

const e = (r: number, g: number, b: number, stp = false): Entry => ({ r, g, b, a: 255, stp });

function sample(): SerializeInput {
  return {
    colorFormat: 'rgb5551',
    fps: 30,
    loopStart: 1,
    width: 4,
    height: 2,
    indices: Uint8Array.from([0, 1, 2, 0, 1, 2, 0, 1]),
    frames: [
      { hold: 1, palette: [e(255, 0, 0), e(0, 255, 0), e(0, 0, 255)] },
      { hold: 6, palette: [e(0, 0, 255), e(255, 0, 0), e(0, 255, 0, true)] },
    ],
  };
}

const round = (i: SerializeInput) => parseProject(JSON.stringify(serializeProject(i)));

describe('base64', () => {
  it('round-trips, including bytes past the chunk boundary', () => {
    const big = new Uint8Array(0x8000 * 2 + 123);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    // The chunking exists because a 76,800-argument spread blows the stack;
    // a fixture smaller than one chunk would never exercise it.
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
});

describe('round trip', () => {
  it('preserves everything the editor needs', () => {
    const out = round(sample());
    expect(out.colorFormat).toBe('rgb5551');
    expect(out.fps).toBe(30);
    expect(out.loopStart).toBe(1);
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
    expect(Array.from(out.indices)).toEqual([0, 1, 2, 0, 1, 2, 0, 1]);
    expect(out.frames.map((f) => f.hold)).toEqual([1, 6]);
  });

  it('preserves the colours as the FORMAT sees them, not as authored', () => {
    // Comparing the packed words is the honest assertion; comparing 8-bit
    // channels would pass on a lossy round-trip through a wider intermediate.
    const fmt = formatById('rgb5551');
    const src = sample();
    const out = round(src);
    for (let f = 0; f < src.frames.length; f++) {
      expect(out.frames[f].palette.map((x) => fmt.pack(x))).toEqual(
        src.frames[f].palette.map((x) => fmt.pack(x)),
      );
    }
  });

  it('writes tuples in the format\'s own units, shaped by the format', () => {
    // rgb5551: five bits a channel plus the STP boolean.
    const ps1 = serializeProject(sample());
    expect(ps1.frames[0].palette[0]).toEqual([31, 0, 0, false]);
    expect(ps1.frames[1].palette[2]).toEqual([0, 31, 0, true]);

    // rgb565: green gets six bits, and there is no fourth member at all.
    const p565 = serializeProject({ ...sample(), colorFormat: 'rgb565' });
    expect(p565.frames[0].palette[1]).toEqual([0, 63, 0]);

    // rgba8888: full bytes, and alpha rather than a flag.
    const p888 = serializeProject({ ...sample(), colorFormat: 'rgba8888' });
    expect(p888.frames[0].palette[0]).toEqual([255, 0, 0, 255]);
  });

  it('still reads a version 1 file, which stored packed integers', () => {
    const doc = serializeProject(sample()) as unknown as Record<string, unknown>;
    const fmt = formatById('rgb5551');
    doc.version = 1;
    doc.frames = sample().frames.map((f) => ({
      hold: f.hold,
      palette: f.palette.map((e) => fmt.pack(e)),
    }));
    const out = parseProject(JSON.stringify(doc));
    expect(out.frames[0].palette.map((x) => fmt.pack(x))).toEqual(
      sample().frames[0].palette.map((x) => fmt.pack(x)),
    );
  });

  it('lets a hand-written tuple leave off the trailing member', () => {
    const doc = serializeProject(sample()) as unknown as Record<string, unknown>;
    (doc.frames as { palette: unknown[] }[])[0].palette = [[31, 0, 0], [0, 31, 0], [0, 0, 31]];
    const out = parseProject(JSON.stringify(doc));
    expect(out.frames[0].palette[0].stp).toBe(false);
    expect(formatById('rgb5551').pack(out.frames[0].palette[0])).toBe(0x001f);
  });

  it('rejects a component outside the format\'s range, naming the bound', () => {
    const doc = serializeProject(sample()) as unknown as Record<string, unknown>;
    (doc.frames as { palette: unknown[] }[])[0].palette = [[32, 0, 0, false], [0, 0, 0, false], [0, 0, 0, false]];
    // 32 is a legal byte and an illegal 5-bit level; catching it is the whole
    // reason the units are the format's own rather than 0-255.
    expect(() => parseProject(JSON.stringify(doc))).toThrow(/component 0 is 32, outside 0\.\.31/);
  });

  it('rejects a non-boolean where the STP flag belongs', () => {
    const doc = serializeProject(sample()) as unknown as Record<string, unknown>;
    (doc.frames as { palette: unknown[] }[])[0].palette = [[0, 0, 0, 1], [0, 0, 0, false], [0, 0, 0, false]];
    expect(() => parseProject(JSON.stringify(doc))).toThrow(/stp must be true or false/);
  });

  it('preserves the STP flag, which is not a colour channel', () => {
    const out = round(sample());
    expect(out.frames[1].palette[2].stp).toBe(true);
    expect(out.frames[1].palette[0].stp).toBe(false);
  });

  it('accepts a null loop point', () => {
    expect(round({ ...sample(), loopStart: null }).loopStart).toBeNull();
  });
});

describe('a project file is data from disk and is validated as such', () => {
  const mangle = (fn: (o: Record<string, unknown>) => void): string => {
    const o = serializeProject(sample()) as unknown as Record<string, unknown>;
    fn(o);
    return JSON.stringify(o);
  };
  const why = (json: string): string => {
    try {
      parseProject(json);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected parseProject to reject this');
  };

  it('rejects a file that is not a project at all', () => {
    expect(why('{"hello":1}')).toMatch(/not a clutter project/);
    expect(why('nonsense')).toMatch(/not valid JSON/);
    expect(() => parseProject('[]')).toThrow(ProjectError);
  });

  it('rejects a version it cannot read, naming both numbers', () => {
    expect(why(mangle((o) => (o.version = 99)))).toMatch(/unsupported version 99.*up to 2/);
  });

  it('rejects an unknown colour format', () => {
    expect(why(mangle((o) => (o.colorFormat = 'rgb888')))).toMatch(/unknown colorFormat/);
  });

  it('catches indices that do not match the dimensions', () => {
    // The failure this prevents: a silently truncated image, which renders as
    // a plausible picture with the bottom missing.
    expect(why(mangle((o) => (o.width = 5)))).toMatch(/needs 10/);
  });

  it('catches an index past the end of the palette', () => {
    expect(why(mangle((o) => (o.indices = bytesToBase64(Uint8Array.from([0, 1, 9, 0, 1, 2, 0, 1])))))).toMatch(
      /palette index 9/,
    );
  });

  it('catches frames whose palettes disagree in length', () => {
    expect(
      why(
        mangle((o) => {
          (o.frames as { palette: unknown[] }[])[1].palette = [[0, 0, 0, false], [1, 1, 1, false]];
        }),
      ),
    ).toMatch(/frame 1 has 2 entries but frame 0 has 3/);
  });

  it('catches a loop point outside the animation', () => {
    expect(why(mangle((o) => (o.loopStart = 7)))).toMatch(/outside 0\.\.1/);
  });

  it('falls back rather than failing on a merely odd fps or hold', () => {
    // These cannot corrupt anything, so a bad value is clamped instead of
    // refusing to open a file somebody may have hand-edited.
    expect(parseProject(mangle((o) => (o.fps = -3))).fps).toBe(60);
    expect(
      parseProject(
        mangle((o) => {
          (o.frames as { hold: number }[])[0].hold = 0;
        }),
      ).frames[0].hold,
    ).toBe(1);
  });
});

describe('formatProjectJson', () => {
  it('keeps each palette tuple on one line', () => {
    const text = formatProjectJson(serializeProject(sample()));
    expect(text).toContain('[31,0,0,false]');
    expect(text).toContain('[0,31,0,true]');
    // Readability is the whole reason for the tuple format, and the default
    // indenter puts every component on its own line - four lines per colour,
    // a thousand for a 256-entry frame. Measure that directly: one line per
    // colour, and no line holding a lone component.
    const lines = text.split('\n');
    const tupleLines = lines.filter((l) => /^\s*\[.*\],?$/.test(l));
    expect(tupleLines).toHaveLength(6);
    expect(lines.filter((l) => /^\s*(\d+|true|false),?$/.test(l))).toHaveLength(0);
  });

  it('still parses as the same document', () => {
    const doc = serializeProject(sample());
    expect(JSON.parse(formatProjectJson(doc))).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('leaves the base64 indices intact', () => {
    const doc = serializeProject(sample());
    expect(JSON.parse(formatProjectJson(doc)).indices).toBe(doc.indices);
  });
});
