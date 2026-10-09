// Regenerates the screenshots in public/manual/.
//
//   node manual/shoot.mjs [url]
//
// url defaults to the local build (dist/index.html). Point it at
// https://tools.psx.dev/clutter/ to shoot the deployed site instead.
// The sample image is manual/sample.png, written by manual/make-sample.py.
// Arrows and labels are an SVG layer added on top of the live page just before
// each capture; the app underneath is untouched.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'public', 'manual');
const URL = process.argv[2] ?? pathToFileURL(resolve(here, '..', 'dist', 'index.html')).href;
const CHROME = process.env.CHROME ?? '/usr/bin/chromium';
const ONLY = process.env.ONLY;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL);
await page.waitForSelector('#canvas');

// notes: [{ sel, text, dx, dy, pad? }]. The label is placed at the target's
// centre plus (dx, dy); the arrow runs from the label to the target's edge.
async function annotate(notes) {
  await page.evaluate((ns) => {
    document.getElementById('__manual')?.remove();
    const svgNS = 'http://www.w3.org/2000/svg';
    // A modal <dialog> sits in the top layer, above any z-index. A popover
    // shown after it is stacked above it, so the arrows go in one.
    const host = document.createElement('div');
    host.id = '__manual';
    host.setAttribute('popover', 'manual');
    Object.assign(host.style, { position: 'fixed', inset: 0, width: '100vw', height: '100vh', margin: 0, padding: 0, border: 0, background: 'transparent', pointerEvents: 'none', overflow: 'visible' });
    const svg = document.createElementNS(svgNS, 'svg');
    Object.assign(svg.style, { position: 'absolute', left: 0, top: 0, width: '100vw', height: '100vh' });
    host.appendChild(svg);
    svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ffcc33"/></marker></defs>';
    document.body.appendChild(host);
    host.showPopover();
    const add = (tag, attrs) => {
      const e = document.createElementNS(svgNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.appendChild(e);
      return e;
    };
    const labels = [];
    ns.forEach((n, i) => {
      let r;
      if (n.rect) {
        r = { left: n.rect[0], top: n.rect[1], width: n.rect[2], height: n.rect[3] };
      } else {
        const el = document.querySelector(n.sel);
        if (!el) throw new Error('annotate: no element for ' + n.sel);
        r = el.getBoundingClientRect();
      }
      const pad = n.pad ?? 3;
      const box = { x: r.left - pad, y: r.top - pad, w: r.width + 2 * pad, h: r.height + 2 * pad };
      add('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 4, fill: 'none', stroke: '#ffcc33', 'stroke-width': 2.5 });
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const label = `${i + 1}. ${n.text}`;
      const lines = label.split('\n');
      const meas = document.createElement('canvas').getContext('2d');
      meas.font = '13px ui-monospace, monospace';
      const lw = Math.max(...lines.map((l) => meas.measureText(l).width)) + 18;
      const lh = lines.length * 17 + 10;
      // `drop: y` hangs the label below its target with its right edge just
      // past the target's centre and a vertical arrow, so a row of targets
      // dropped at increasing depth, left to right, never crosses arrows.
      let lx = n.drop !== undefined ? cx + 14 - lw / 2 : n.at ? n.at[0] : cx + n.dx;
      let ly = n.drop !== undefined ? n.drop : n.at ? n.at[1] : cy + n.dy;
      lx = Math.max(lw / 2 + 4, Math.min(innerWidth - lw / 2 - 4, lx));
      ly = Math.max(lh / 2 + 4, Math.min(innerHeight - lh / 2 - 4, ly));
      // Arrow end: where the segment label->centre crosses the box edge.
      const vx = cx - lx, vy = cy - ly;
      const tx = vx === 0 ? Infinity : Math.abs((box.w / 2) / vx);
      const ty = vy === 0 ? Infinity : Math.abs((box.h / 2) / vy);
      const t = Math.min(tx, ty);
      const ex = cx - vx * t, ey = cy - vy * t;
      const inside = lx > box.x && lx < box.x + box.w && ly > box.y && ly < box.y + box.h;
      if (n.drop !== undefined) add('line', { x1: cx, y1: ly - lh / 2, x2: cx, y2: box.y + box.h, stroke: '#ffcc33', 'stroke-width': 2.5, 'marker-end': 'url(#ah)' });
      else if (!inside) add('line', { x1: lx, y1: ly, x2: ex, y2: ey, stroke: '#ffcc33', 'stroke-width': 2.5, 'marker-end': 'url(#ah)' });
      labels.push(() => {
      add('rect', { x: lx - lw / 2, y: ly - lh / 2, width: lw, height: lh, rx: 5, fill: '#1b1b1f', stroke: '#ffcc33', 'stroke-width': 1.5 });
      lines.forEach((l, j) => {
        const tEl = add('text', { x: lx, y: ly - lh / 2 + 19 + j * 17, fill: '#ffe9a8', 'text-anchor': 'middle', 'font-family': 'ui-monospace, monospace', 'font-size': 13 });
        tEl.textContent = l;
      });
      });
    });
    labels.forEach((f) => f());
  }, notes);
}

async function shot(name, notes) {
  if (ONLY && ONLY !== name) return;
  await annotate(notes);
  await page.screenshot({ path: resolve(OUT, name + '.png') });
  await page.evaluate(() => document.getElementById('__manual')?.remove());
  console.log('wrote', name);
}

// Centre of palette swatch i in page coordinates (grid: 32px cells, 2px gap).
async function swatch(i) {
  const r = await page.locator('#palette-canvas').boundingBox();
  const cols = Math.max(1, Math.floor((r.width + 2) / 34));
  return { x: r.x + (i % cols) * 34 + 16, y: r.y + Math.floor(i / cols) * 34 + 16 };
}

async function clickSwatch(i, modifiers = []) {
  const p = await swatch(i);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

const scene = await import('./scenes.mjs');
await scene.run({ page, annotate, shot, swatch, clickSwatch, sample: resolve(here, 'sample.png') });

await browser.close();
if (errors.length) {
  console.error('page errors:\n' + errors.join('\n'));
  process.exit(1);
}
