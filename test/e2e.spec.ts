/**
 * End-to-end test against the BUILT single-file artifact.
 *
 * A green `vite build` is a claim about the pipeline with no power over whether
 * the page runs: exit 0, one file on disk and a plausible byte count are all
 * satisfied by a page that throws on load. So launch a real browser, open
 * dist/index.html off the filesystem the way a user will (`file://`, no server,
 * no network), drive it, and read values back out of the DOM.
 *
 * Excluded from CI by `test:unit`, because the runners have no chromium at a
 * fixed path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist/index.html');
const CHROME = '/usr/bin/chromium';
const SHOTS = process.env.CLUTTER_SHOTS ?? '';

let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function walkMtimes(dir: string): number[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = resolve(dir, e.name);
      return e.isDirectory() ? walkMtimes(full) : [statSync(full).mtimeMs];
    });
  } catch {
    return [];
  }
}

beforeAll(async () => {
  // Build if missing or stale. A test that silently grades a previous build is
  // measuring the wrong binary.
  const newest = Math.max(
    ...['src', 'index.html', 'vite.config.ts'].flatMap((p) => {
      const full = resolve(ROOT, p);
      return existsSync(full) ? [statSync(full).mtimeMs, ...walkMtimes(full)] : [0];
    }),
  );
  if (!existsSync(DIST) || statSync(DIST).mtimeMs < newest) {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
  }

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`file://${DIST}`);
  await page.waitForSelector('#canvas');
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

async function importFixture(name: string, fmt?: string): Promise<void> {
  await page.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures', name));
  // Importing over unsaved work asks first.
  if (await page.locator('#dlg-discard[open]').count()) await page.click('#discard-yes');
  // Import asks for the format first now.
  await page.waitForSelector('#dlg-format[open]', { timeout: 20_000 });
  if (fmt) await page.selectOption('#format-select', fmt);
  await page.click('#format-apply');
  await page.waitForFunction(
    () => (document.querySelector('#s-msg')?.textContent ?? '').length > 0,
    undefined,
    { timeout: 20_000 },
  );
}


/** Click palette swatch `i`, computing its position the way the grid lays it out. */
async function clickSwatch(i: number, shift = false): Promise<void> {
  const pos = await page.evaluate((n) => {
    const c = document.getElementById('palette-canvas') as HTMLCanvasElement;
    const step = 34; // cell 32 + gap 2, from paletteLayout's defaults
    const cols = Math.max(1, Math.floor((c.clientWidth + 2) / step));
    return { x: (n % cols) * step + 16, y: Math.floor(n / cols) * step + 16 };
  }, i);
  await page.locator('#palette-canvas').click({
    position: pos,
    modifiers: shift ? ['Shift'] : [],
  });
}

const status = () => page.textContent('#s-msg');
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

describe('the built artifact', () => {
  it('is one self-contained file with no external references', () => {
    const html = readFileSync(DIST, 'utf8');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
    expect(html).not.toMatch(/src="\.\//);
  });

  it('loads without console or page errors', () => {
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

describe('indexed import', () => {
  it('keeps the source palette and paints real pixels', async () => {
    await importFixture('indexed8-trns.png');
    expect(await status()).toMatch(/32x24, 20 colours/);
    // The palette grid is a canvas now, so count its painted swatches rather
    // than DOM nodes: sample the centre of each cell and require 20 of them to
    // be non-empty. A blank canvas and a canvas with one swatch both fail.
    const painted = await page.evaluate(() => {
      const c = document.getElementById('palette-canvas') as HTMLCanvasElement;
      const g = c.getContext('2d')!;
      const dpr = window.devicePixelRatio || 1;
      const step = 34;
      const cols = Math.max(1, Math.floor((c.clientWidth + 2) / step));
      let n = 0;
      for (let i = 0; i < 64; i++) {
        const x = ((i % cols) * step + 16) * dpr;
        const y = (Math.floor(i / cols) * step + 16) * dpr;
        if (x >= c.width || y >= c.height) continue;
        const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        if (d[3] !== 0) n++;
      }
      return n;
    });
    expect(painted).toBe(20);
    await shot('01-indexed');

    // The canvas must actually have colour on it. A blank render is the exact
    // failure a build-exit-code cannot see.
    const distinct = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement;
      const g = c.getContext('2d')!;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4) {
        seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
      return seen.size;
    });
    expect(distinct).toBeGreaterThan(4);
  });
});

describe('truecolour import goes through the quantizer', () => {
  it('reports what the quantizer actually did', async () => {
    await page.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures/truecolor-rgba.png'));
    await page.waitForSelector('#dlg-format[open]');
    // The palette-size control is offered at import, and only for truecolour.
    expect(await page.locator('#colors-input').isVisible()).toBe(true);
    await page.fill('#colors-input', '8');
    await page.click('#format-apply');
    await page.waitForFunction(
      () => (document.querySelector('#s-msg')?.textContent ?? '').startsWith('Quantized'),
    );
    const msg = (await status()) ?? '';
    expect(msg).toMatch(/^Quantized truecolor-rgba\.png/);
    expect(msg).toMatch(/48x40/);
    // The discriminator against "it silently loaded something": the message
    // must carry the palette size the quantizer settled on, and it must be
    // within the budget that was asked for.
    const m = msg.match(/(\d+) of 8 colours/) ?? msg.match(/(\d+) colours, no quantizing/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(8);
    await shot('02-quantized');
  });

  it('quantizes into the PlayStation format when that is selected', async () => {
    await importFixture('truecolor-rgba.png', 'rgb5551');
    expect(await status()).toMatch(/^Quantized/);
    // rgb5551 has no alpha row and does have an STP row. This is the
    // discriminator that the format actually reached the editor, not just the
    // select element.
    // Click the first swatch: cell 0 sits at (16,16) in CSS pixels whatever
    // the column count works out to.
    await page.locator('#palette-canvas').click({ position: { x: 16, y: 16 } });
    expect(await page.locator('#e-a-row').isVisible()).toBe(false);
    expect(await page.locator('#e-stp-row').isVisible()).toBe(true);

    // The sliders speak the format's own levels, so a 5-bit channel has 32
    // positions and not 256. Checked per format rather than once, because the
    // interesting case is that they CHANGE.
    const maxes = () =>
      page.evaluate(() =>
        ['e-r-range', 'e-g-range', 'e-b-range'].map(
          (id) => (document.getElementById(id) as HTMLInputElement).max,
        ),
      );
    expect(await maxes()).toEqual(['31', '31', '31']);

    const switchTo = async (id: string): Promise<void> => {
      await page.click('#open-format');
      // Never offered again after import.
      expect(await page.locator('#colors-input').isVisible()).toBe(false);
      await page.selectOption('#format-select', id);
      await page.click('#format-apply');
      await page.locator('#palette-canvas').click({ position: { x: 16, y: 16 } });
    };
    await switchTo('rgb565');
    expect(await maxes()).toEqual(['31', '63', '31']);

    await switchTo('rgba8888');
    expect(await maxes()).toEqual(['255', '255', '255']);
    expect(await page.locator('#e-a-row').isVisible()).toBe(true);
    await switchTo('rgb5551');
    await shot('03-quantized-5551');
  });
});

describe('generating and playing', () => {
  it('stamps a colour cycle and advances frames', async () => {
    await importFixture('indexed8-trns.png');
    const before = (await status.call(null)) ?? '';
    expect(await page.textContent('#s-frames')).toBe('1 frame');
    // The cycle now takes its range from the PALETTE selection, and is
    // disabled without one. Assert the disabled state first: it is the new
    // rule, and a test that only exercises the happy path cannot tell a
    // working gate from an absent one.
    // The button that OPENS the tool is the one that goes dead, with the
    // reason on it - not a live button leading to a dead one inside.
    expect(await page.locator('#open-cycle').isDisabled()).toBe(true);
    expect(await page.locator('#open-cycle').getAttribute('title')).toMatch(/select two or more/i);

    await clickSwatch(0);
    await clickSwatch(7, true);
    expect(await page.locator('#open-cycle').isDisabled()).toBe(false);
    await page.click('#open-cycle');
    expect(await page.locator('#g-cycle-run').isDisabled()).toBe(false);
    await page.fill('#g-cycle-steps', '8');
    await page.click('#g-cycle-run');
    await page.evaluate(() => (document.getElementById('dlg-cycle') as HTMLDialogElement).close());
    expect(await page.textContent('#s-frames')).toBe('9 frames');
    await shot('04-cycled');

    // The timeline fits the whole animation across its width, so sampling a
    // column at nine evenly spaced x positions crosses nine different frames.
    // Eight copies of the base palette would satisfy the frame count above and
    // fail this.
    const signatures = await page.evaluate(() => {
      const c = document.getElementById('strip-canvas') as HTMLCanvasElement;
      const g = c.getContext('2d')!;
      const dpr = window.devicePixelRatio || 1;
      const out: string[] = [];
      for (let i = 0; i < 9; i++) {
        const x = Math.round(((i + 0.5) / 9) * c.clientWidth * dpr);
        if (x >= c.width) break;
        const col = g.getImageData(Math.min(x, c.width - 1), Math.round(20 * dpr), 1, Math.round(24 * dpr)).data;
        out.push(Array.from(col).join(','));
      }
      return out;
    });
    expect(signatures.length).toBeGreaterThan(1);
    expect(new Set(signatures).size).toBeGreaterThan(1);
  });
});

describe('project save and load', () => {
  it('round-trips an edited animation through a file on disk', async () => {
    const p5 = await browser.newPage({
      viewport: { width: 1400, height: 900 },
      acceptDownloads: true,
    });
    await p5.goto(`file://${DIST}`);
    await p5.waitForSelector('#canvas');
    await p5.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures/indexed8-trns.png'));
    await p5.waitForSelector('#dlg-format[open]');
    await p5.selectOption('#format-select', 'rgb5551');
    await p5.click('#format-apply');
    await p5.waitForFunction(() => (document.querySelector('#s-msg')?.textContent ?? '').length > 0);

    // Give it something worth preserving: extra frames, a hold, a loop point.
    for (let i = 0; i < 2; i++) await p5.click('#f-duplicate');
    await p5.fill('#f-hold', '7');
    await p5.click('#f-loop-set');
    await p5.fill('#fps-input', '24');
    await p5.click('#s-frames');
    expect(await p5.textContent('#s-frame')).toMatch(/\*/);

    const download = await Promise.all([p5.waitForEvent('download'), p5.click('#btn-save')]);
    const file = join(tmpdir(), `clutter-e2e-${Date.now()}.clutter.json`);
    await download[0].saveAs(file);

    // Saving is what clears the dirty flag; it was armed with nothing to
    // disarm it until now.
    expect(await p5.textContent('#s-frame')).not.toMatch(/\*/);

    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.kind).toBe('clutter-project');
    expect(doc.colorFormat).toBe('rgb5551');
    expect(doc.fps).toBe(24);
    expect(doc.frames).toHaveLength(3);
    expect(doc.width * doc.height).toBe(32 * 24);
    // Palettes are stored as packed words, so every entry is a 16-bit integer.
    for (const v of doc.frames[0].palette) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeLessThanOrEqual(0xffff);
    }

    // Open it back in a clean page and compare what the UI reports.
    const p6 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await p6.goto(`file://${DIST}`);
    await p6.waitForSelector('#canvas');
    await p6.setInputFiles('#file-png', file);
    await p6.waitForFunction(() => (document.querySelector('#s-msg')?.textContent ?? '').startsWith('Opened'));
    // No format dialog on the project path - the file already says.
    expect(await p6.locator('#dlg-format[open]').count()).toBe(0);
    expect(await p6.textContent('#s-frames')).toBe('3 frames');
    expect(await p6.textContent('#s-loop')).toMatch(/loops at/);
    expect(await p6.inputValue('#fps-input')).toBe('24');
    // A freshly opened project is not dirty.
    expect(await p6.textContent('#s-frame')).not.toMatch(/\*/);

    // And it refuses to silently eat a malformed file.
    const bad = join(tmpdir(), `clutter-bad-${Date.now()}.json`);
    writeFileSync(bad, JSON.stringify({ kind: 'clutter-project', version: 99 }));
    await p6.setInputFiles('#file-png', bad);
    await p6.waitForFunction(
      () => (document.querySelector('#s-msg')?.textContent ?? '').includes('Could not open'),
    );
    expect(await p6.textContent('#s-msg')).toMatch(/unsupported version 99/);
    expect(await p6.textContent('#s-frames')).toBe('3 frames');

    unlinkSync(file);
    unlinkSync(bad);
    await p5.close();
    await p6.close();
  }, 90_000);
});

describe('the frame transforms', () => {
  it('set-for-all writes one colour across every frame, and copy-from stays per frame', async () => {
    const p4 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await p4.goto(`file://${DIST}`);
    await p4.waitForSelector('#canvas');
    await p4.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures/indexed8-trns.png'));
    await p4.waitForSelector('#dlg-format[open]');
    await p4.click('#format-apply');
    await p4.waitForFunction(() => (document.querySelector('#s-msg')?.textContent ?? '').length > 0);

    // Build four frames that differ, by cycling.
    const swatch = (n: number) =>
      p4.evaluate((i) => {
        const c = document.getElementById('palette-canvas') as HTMLCanvasElement;
        const step = 34;
        const cols = Math.max(1, Math.floor((c.clientWidth + 2) / step));
        return { x: (i % cols) * step + 16, y: Math.floor(i / cols) * step + 16 };
      }, n);
    await p4.locator('#palette-canvas').click({ position: await swatch(0) });
    await p4.locator('#palette-canvas').click({ position: await swatch(5), modifiers: ['Shift'] });
    await p4.click('#open-cycle');
    await p4.fill('#g-cycle-steps', '3');
    await p4.click('#g-cycle-run');
    await p4.evaluate(() => (document.getElementById('dlg-cycle') as HTMLDialogElement).close());
    expect(await p4.textContent('#s-frames')).toBe('4 frames');

    // Sample entry 1 across all four frames from the PALETTE GRID, stepping
    // with the keyboard. The timeline thumbnail was the obvious source and is
    // a bad oracle: twenty entries in a 32px lane is a 1.6px band, so which
    // entry a sampled pixel lands on is a rounding accident.
    const sampleEntry1 = async (): Promise<string[]> => {
      // Click the status bar, NOT the viewport: clicking a pixel selects that
      // pixel's palette entry, so a sampler that focused the canvas was
      // destroying the selection it was about to measure the effect of.
      await p4.click('#s-frames');
      await p4.keyboard.press('Home');
      const out: string[] = [];
      for (let f = 0; f < 4; f++) {
        out.push(
          await p4.evaluate(() => {
            const c = document.getElementById('palette-canvas') as HTMLCanvasElement;
            const g = c.getContext('2d')!;
            const dpr = window.devicePixelRatio || 1;
            const step = 34;
            const cols = Math.max(1, Math.floor((c.clientWidth + 2) / step));
            const x = Math.round(((1 % cols) * step + 16) * dpr);
            const y = Math.round((Math.floor(1 / cols) * step + 16) * dpr);
            const d = g.getImageData(x, y, 1, 1).data;
            return `${d[0]},${d[1]},${d[2]},${d[3]}`;
          }),
        );
        if (f < 3) await p4.keyboard.press('ArrowRight');
      }
      return out;
    };

    const before = await sampleEntry1();
    expect(new Set(before).size).toBeGreaterThan(1);

    // The cycle auto-selects the frames it made, so the span is 1..3 here and
    // set-for-all must respect it: frame 0 keeps its own colours.
    expect(await p4.textContent('#s-loop')).toMatch(/3 selected/);
    await p4.click('#run-setall');
    expect(await p4.textContent('#s-msg')).toMatch(/Set for all frames: .*3 selected frames/);
    const spanned = await sampleEntry1();
    expect(new Set(spanned.slice(1)).size).toBe(1);
    expect(new Set(spanned).size).toBe(2);

    // Clear the span with Escape and repeat: now it covers everything. This is
    // the discriminator - a tool that ignored the span entirely would have
    // passed the first assertion by accident.
    await p4.click('#s-frames');
    await p4.keyboard.press('Escape');
    expect(await p4.textContent('#s-loop')).not.toMatch(/selected/);

    await p4.click('#run-setall');
    expect(await p4.textContent('#s-msg')).toMatch(/all 4 frames/);
    expect(new Set(await sampleEntry1()).size).toBe(1);
    await p4.close();
  }, 60_000);
});

describe('the dirty flag', () => {
  it('guards an import over unsaved work, and a fresh load is not dirty', async () => {
    const p3 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await p3.goto(`file://${DIST}`);
    await p3.waitForSelector('#canvas');
    const load = async (): Promise<void> => {
      await p3.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures/indexed8-trns.png'));
      await p3.waitForSelector('#dlg-format[open]');
      await p3.click('#format-apply');
      await p3.waitForFunction(() => (document.querySelector('#s-msg')?.textContent ?? '').length > 0);
    };
    await load();
    // A load is not an edit. The marker in the status bar is the observable.
    expect(await p3.textContent('#s-frame')).toBe('frame 0');

    await p3.click('#f-duplicate');
    expect(await p3.textContent('#s-frame')).toMatch(/\*/);

    // Importing now must ask, and cancelling must leave the animation alone.
    await p3.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures/indexed4.png'));
    await p3.waitForSelector('#dlg-discard[open]');
    await p3.click('#discard-no');
    expect(await p3.locator('#dlg-format[open]').count()).toBe(0);
    expect(await p3.textContent('#s-frames')).toBe('2 frames');

    // And confirming must go through and come back clean.
    await p3.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures/indexed4.png'));
    await p3.waitForSelector('#dlg-discard[open]');
    await p3.click('#discard-yes');
    await p3.waitForSelector('#dlg-format[open]');
    await p3.click('#format-apply');
    await p3.waitForFunction(() => (document.querySelector('#s-msg')?.textContent ?? '').length > 0);
    expect(await p3.textContent('#s-frames')).toBe('1 frame');
    expect(await p3.textContent('#s-frame')).toBe('frame 0');
    await p3.close();
  }, 60_000);
});

describe('looping playback', () => {
  it('keeps advancing past the first loop', async () => {
    // Reported 2026-09-05: the playhead stopped updating after one pass,
    // because the tick handed to the widget was the raw accumulating one and
    // walked off the end instead of the wrapped one.
    //
    // Own page on purpose. The shared one carries whatever the earlier tests
    // left behind - a frame count, a selection, an fps - and a timing test
    // reading a stale animation fails for reasons that have nothing to do with
    // the thing under test.
    const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await p2.goto(`file://${DIST}`);
    await p2.waitForSelector('#canvas');
    await p2.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures/indexed8-trns.png'));
    await p2.waitForSelector('#dlg-format[open]');
    await p2.click('#format-apply');
    await p2.waitForFunction(() => (document.querySelector('#s-msg')?.textContent ?? '').length > 0);
    for (let i = 0; i < 3; i++) await p2.click('#f-duplicate');
    await p2.fill('#fps-input', '20');
    await p2.click('#canvas');
    await p2.keyboard.press('Home');
    await p2.click('#f-loop-set');
    expect(await p2.textContent('#s-frames')).toBe('4 frames');
    expect(await p2.textContent('#s-loop')).toMatch(/loops at 0/);

    await p2.click('#btn-play');
    // 37ms against a 50ms frame period, deliberately not a near-multiple: at
    // 60ms the sampler aliased onto a rotating subset and missed a frame,
    // which failed the test for a property of the SAMPLER.
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      await p2.waitForTimeout(37);
      seen.push(((await p2.textContent('#s-frame')) ?? '').replace('frame ', ''));
    }
    await p2.click('#btn-play');
    await p2.close();

    // The property is "it survives looping", so count WRAPS. A playhead that
    // ran off the end after one pass gives at most one, and would still pass a
    // "did it move at all" check.
    let wraps = 0;
    for (let i = 1; i < seen.length; i++) if (seen[i - 1] === '3' && seen[i] === '0') wraps++;
    expect(new Set(seen).size).toBeGreaterThan(1);
    expect(wraps).toBeGreaterThan(1);
  }, 60_000);
});

describe('device pixel ratio', () => {
  it('reports the same pixel under the cursor at dpr 1 and dpr 2', async () => {
    const readAt = async (dpr: number): Promise<string> => {
      const ctxPage = await browser.newPage({
        viewport: { width: 1400, height: 900 },
        deviceScaleFactor: dpr,
      });
      await ctxPage.goto(`file://${DIST}`);
      await ctxPage.waitForSelector('#canvas');
      await ctxPage.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures/indexed8-trns.png'));
      await ctxPage.waitForSelector('#dlg-format[open]');
      await ctxPage.click('#format-apply');
      await ctxPage.waitForFunction(
        () => (document.querySelector('#s-msg')?.textContent ?? '').length > 0,
      );
      await ctxPage.click('#btn-fit');
      const box = (await ctxPage.locator('#canvas').boundingBox())!;
      await ctxPage.mouse.move(box.x + box.width * 0.41, box.y + box.height * 0.37);
      await ctxPage.waitForTimeout(120);
      const text = (await ctxPage.textContent('#readout')) ?? '';
      await ctxPage.close();
      return text;
    };
    const one = await readAt(1);
    const two = await readAt(2);
    expect(one).not.toBe('');
    // Pinning the harness at dpr 1 is exactly what hid this bug class the
    // first time, so both arms run and must agree.
    expect(two).toBe(one);
  }, 120_000);
});
