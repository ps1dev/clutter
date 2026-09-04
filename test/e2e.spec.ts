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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

async function importFixture(name: string): Promise<void> {
  await page.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures', name));
  await page.waitForFunction(
    () => (document.querySelector('#s-msg')?.textContent ?? '').length > 0,
    undefined,
    { timeout: 20_000 },
  );
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
    await page.fill('#colors-input', '8');
    await importFixture('truecolor-rgba.png');
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
    await page.selectOption('#format-select', 'rgb5551');
    await page.fill('#colors-input', '16');
    await importFixture('truecolor-rgba.png');
    expect(await status()).toMatch(/^Quantized/);
    // rgb5551 has no alpha row and does have an STP row. This is the
    // discriminator that the format actually reached the editor, not just the
    // select element.
    // Click the first swatch: cell 0 sits at (16,16) in CSS pixels whatever
    // the column count works out to.
    await page.locator('#palette-canvas').click({ position: { x: 16, y: 16 } });
    expect(await page.locator('#e-a-row').isVisible()).toBe(false);
    expect(await page.locator('#e-stp-row').isVisible()).toBe(true);
    await shot('03-quantized-5551');
  });
});

describe('generating and playing', () => {
  it('stamps a colour cycle and advances frames', async () => {
    await importFixture('indexed8-trns.png');
    const before = (await status.call(null)) ?? '';
    expect(await page.textContent('#s-frames')).toBe('1 frame');
    await page.click('#open-cycle');
    expect(await page.locator('#dlg-cycle').isVisible()).toBe(true);
    await page.fill('#g-cycle-lo', '0');
    await page.fill('#g-cycle-hi', '7');
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
