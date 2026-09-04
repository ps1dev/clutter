/**
 * Playback benchmark. NOT part of `npm test` - run it by hand:
 *
 *   node test/bench.mjs                 # chromium
 *   node test/bench.mjs firefox         # firefox (needs `npx playwright install firefox`)
 *
 * It exists because "it feels slow" and "it is slow" are different claims, and
 * because the two engines disagree by a factor of three on this workload. The
 * numbers in the commit log were produced by this file; re-run it rather than
 * trusting them.
 *
 * Reports playback fps and the live DOM element count, which turned out to be
 * the thing Firefox is actually sensitive to.
 */
import { chromium, firefox } from 'playwright-core';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist/index.html');
const engine = process.argv[2] === 'firefox' ? 'firefox' : 'chromium';
const launch =
  engine === 'firefox'
    ? () => firefox.launch({})
    : () => chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

async function run(fixture, hi) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
  await page.goto(`file://${DIST}`);
  await page.waitForSelector('#canvas');
  await page.setInputFiles('#file-png', resolve(ROOT, 'test/fixtures', fixture));
  await page.waitForFunction(() => (document.querySelector('#s-msg')?.textContent ?? '').length > 0);
  await page.click('#btn-fit');
  await page.fill('#g-cycle-lo', '0');
  await page.fill('#g-cycle-hi', hi);
  await page.fill('#g-cycle-steps', '16');
  await page.click('#g-cycle-run');

  const elements = await page.evaluate(() => document.getElementsByTagName('*').length);
  const fps = await page.evaluate(async () => {
    document.getElementById('btn-play').click();
    let n = 0;
    const t0 = performance.now();
    await new Promise((r) => {
      const step = () => {
        n++;
        if (performance.now() - t0 > 2500) return r();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const dt = performance.now() - t0;
    document.getElementById('btn-play').click();
    return +((n / dt) * 1000).toFixed(1);
  });
  await browser.close();
  return { fixture, elements, fps };
}

console.log(`engine: ${engine}`);
for (const [f, hi] of [
  ['anim320.png', '31'],
  ['anim320-256.png', '255'],
]) {
  const r = await run(f, hi);
  console.log(`  ${r.fixture.padEnd(20)} ${String(r.elements).padStart(6)} elements   ${r.fps} fps`);
}
