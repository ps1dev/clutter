// The tour shot by shoot.mjs. Each shot() call writes public/manual/<name>.png.

async function closeDialog(page) {
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
}

export async function run({ page, shot, swatch, clickSwatch, sample }) {
  // ---- 1. import ------------------------------------------------------------------
  await page.setInputFiles('#file-png', sample);
  await page.waitForSelector('#dlg-format[open]');
  await page.selectOption('#format-select', 'rgb5551');
  await shot('01-import', [
    { sel: '#btn-import', text: 'Open a PNG or a saved .clutter.json\n(or drop either on the canvas)', at: [260, 170] },
    { sel: '#format-select', text: 'The colour format the palettes are stored in', at: [700, 250] },
    { sel: '#format-dialog-note', text: 'An indexed PNG keeps its palette; a truecolour\none is quantized to the number of colours you ask', at: [700, 640] },
    { sel: '#format-apply', text: 'Import', at: [330, 600] },
  ]);
  await page.click('#format-apply');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));

  // ---- 2. overview ----------------------------------------------------------------
  await shot('02-overview', [
    { sel: '#canvas-wrap', text: 'The image, drawn with the current frame\'s palette', at: [560, 470], pad: -3 },
    { sel: '#palette-canvas', text: 'The current frame\'s palette', at: [900, 120], pad: 3 },
    { rect: [1128, 664, 305, 98], text: 'Generators and cross-frame edits', at: [900, 560] },
    { sel: '#strip-canvas', text: 'Frames: one complete palette each', at: [560, 690], pad: 1 },
    { sel: '#frame-strip-controls', text: 'Frame editing and looping', at: [960, 690], pad: -1 },
    { rect: [366, 5, 145, 28], text: 'Playback', at: [440, 110] },
    { rect: [584, 5, 154, 28], text: 'Zoom', at: [700, 110] },
    { rect: [0, 878, 250, 21], text: 'Frame count, current frame, loop', at: [470, 888] },
    { sel: '#btn-manual', text: 'This manual', at: [1080, 19], pad: 3 },
  ]);

  // ---- 3. the palette and one entry ---------------------------------------------------
  await clickSwatch(17);
  const s17 = await swatch(17);
  await shot('03-entry', [
    { rect: [s17.x - 17, s17.y - 17, 34, 34], text: 'Click an entry to edit it. Shift+click selects\na range, Ctrl/Cmd+click adds or removes one.', at: [820, 140] },
    { rect: [1128, 632, 305, 84], text: 'Its channels, in the format\'s own units:\n0-31 for RGB5551', at: [850, 640] },
    { sel: '#e-stp', text: 'The PlayStation semi-transparency bit', at: [850, 715], pad: 3 },
    { sel: '#e-hex', text: 'The value exactly as it is stored; type to set it', at: [800, 770], pad: 2 },
    { sel: '#run-setall', text: 'Set for all: write the selected entries\ninto every selected frame', at: [850, 560], pad: 2 },
    { sel: '#open-copyfrom', text: 'Copy from: give the selection another\nentry\'s colour, frame by frame', at: [880, 470], pad: 2 },
  ]);

  // ---- 4. colour cycle ---------------------------------------------------------------
  await clickSwatch(1);
  await clickSwatch(16, ['Shift']);
  await page.click('#open-cycle');
  await page.waitForSelector('#dlg-cycle[open]');
  await shot('04-cycle', [
    { sel: '#palette-canvas', text: 'Entries 1-16 selected: the waterfall', at: [1250, 300], pad: 3 },
    { sel: '#g-cycle-inc', text: 'Places to rotate per frame. 0.5 is one place\nevery two frames; negative runs backwards.', at: [200, 200] },
    { sel: '#g-cycle-wrap', text: 'Wrap: what falls off one end comes back\nat the other', at: [170, 300], pad: 3 },
    { sel: '#g-cycle-steps', text: 'How many new frames to generate', at: [200, 610] },
    { sel: '#g-cycle-distinct', text: 'How many of them the format can\nactually tell apart', at: [760, 640], pad: 2 },
    { sel: '#g-cycle-run', text: 'Generate', at: [560, 700], pad: 2 },
  ]);
  await page.click('#g-cycle-run');
  await page.waitForFunction(() => /16 frames/.test(document.getElementById('s-frames').textContent));
  if (await page.$('dialog[open]')) await closeDialog(page);

  // ---- 5. frames and playback -----------------------------------------------------------
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await shot('05-frames', [
    { rect: [0, 778, 1440, 58], text: 'Drag to scrub. Shift+drag selects a span of frames\nor moves the loop point. Wheel zooms, middle-drag pans.', at: [1110, 806] },
    { rect: [6, 840, 364, 32], text: 'Insert, delete, duplicate and reorder frames', at: [190, 735] },
    { sel: '#f-hold', text: 'Hold: ticks this frame stays on screen', at: [470, 670], pad: 2 },
    { sel: '#f-loop-mode', text: 'Loop mode', at: [760, 610], pad: 2 },
    { sel: '#f-loop-set', text: 'Loop back to this frame', at: [980, 550], pad: 2 },
    { rect: [366, 5, 145, 28], text: 'Play (or Space) at this many ticks per second.\nLeft/Right arrows step a frame.', at: [460, 130] },
    { rect: [0, 878, 360, 21], text: 'Frame count, current frame, loop', at: [560, 888] },
  ]);

  // ---- 6. HSB ramp ---------------------------------------------------------------------
  await page.keyboard.press('Home');
  // The cycle left its frames selected as a span; clear it so HSB generates
  // new frames rather than ramping across the span.
  await page.keyboard.press('Escape');
  await clickSwatch(17);
  await clickSwatch(24, ['Shift']);
  await page.click('#open-hsb');
  await page.waitForSelector('#dlg-hsb[open]');
  await shot('06-hsb', [
    { rect: await union(page, '#g-hsb-hue-from', '#g-hsb-hue-to'), text: 'Hue offset, from - to, in degrees', at: [180, 150] },
    { rect: await union(page, '#g-hsb-sat', '#g-hsb-sat-to'), text: 'Saturation multiplier, from - to', at: [180, 260] },
    { rect: await union(page, '#g-hsb-val', '#g-hsb-val-to'), text: 'Brightness multiplier, from - to', at: [180, 370] },
    { sel: '#g-hsb-easing', text: 'Easing curve', at: [180, 480], pad: 2 },
    { sel: '#g-hsb-steps', text: 'Frames to generate', at: [180, 590], pad: 2 },
    { sel: '#g-hsb-closed', text: 'Closed: the last step lands back\non the start, for a seamless loop', at: [1250, 420], pad: 3 },
    { sel: '#g-hsb-black', text: 'Used where a result lands on 0x0000,\nwhich RGB5551 draws as transparent', at: [1250, 560], pad: 2 },
    { sel: '#g-hsb-distinct', text: 'Distinct frames the format can show', at: [900, 720], pad: 2 },
  ]);
  await closeDialog(page);

  // ---- 7. interpolate ------------------------------------------------------------------
  await page.click('#open-interp');
  await page.waitForSelector('#dlg-interp[open]');
  await shot('07-interpolate', [
    { sel: '#g-interp-target', text: 'What will be interpolated', at: [720, 250], pad: 2 },
    { sel: '#g-interp-count', text: 'New frames between each pair of frames', at: [200, 330], pad: 2 },
    { sel: '#g-interp-easing', text: 'Easing curve', at: [180, 430], pad: 2 },
    { sel: '#g-interp-black', text: 'Replacement for a result of 0x0000', at: [200, 530], pad: 2 },
    { sel: '#g-interp-distinct', text: 'Distinct frames the format can show', at: [900, 700], pad: 2 },
  ]);
  await closeDialog(page);

  // ---- 8. phase shift --------------------------------------------------------------------
  await page.click('#open-phase');
  await page.waitForSelector('#dlg-phase[open]');
  await shot('08-phase', [
    { sel: '#ph-shift', text: 'Frames to delay the first selected entry by', at: [200, 200], pad: 2 },
    { sel: '#ph-inc', text: 'Extra delay added per selected entry,\nso a row of lights can chase', at: [1250, 220], pad: 2 },
    { sel: '#ph-wrap', text: 'Wrap shifted colours round the end', at: [200, 640], pad: 3 },
    { sel: '#ph-note', text: 'What will happen', at: [900, 700], pad: 2 },
  ]);
  await closeDialog(page);

  // ---- 9. format -------------------------------------------------------------------------
  await page.click('#open-format');
  await page.waitForSelector('#dlg-format[open]');
  await shot('09-format', [
    { sel: '#format-select', text: 'RGBA8888, RGB565 or RGB5551. Colours are kept at\n8 bits, so switching formats loses nothing.', at: [700, 230] },
    { sel: '#format-dialog-note', text: 'What the change will do', at: [700, 650], pad: 2 },
  ]);
  await closeDialog(page);

  // ---- 10. export --------------------------------------------------------------------------
  await page.click('#btn-export');
  await page.waitForSelector('#dlg-export[open]');
  await page.selectOption('#ex-what', 'tim');
  await shot('10-export', [
    { sel: '#ex-what', text: 'Raw image data, the palette sequence,\na multi-palette .tim, palettes only as .clt,\nor a text template', at: [200, 180], pad: 2 },
    { sel: '#ex-per-row', text: 'CLUT layout: palettes side by side\nbefore starting the next row', at: [1250, 260], pad: 2 },
    { sel: '#ex-note', text: 'Exactly what will be written', at: [900, 700], pad: 2 },
    { sel: '#ex-run', text: 'Export', at: [300, 680], pad: 2 },
  ]);
  await page.selectOption('#ex-what', 'text');
  await shot('11-export-template', [
    { sel: '#ex-template', text: 'The template, rendered once per export', at: [180, 160], pad: 2 },
    { sel: '#ex-note', text: 'An unknown placeholder is left as written,\nso a typo shows in the output', at: [900, 740], pad: 2 },
  ]);
  await closeDialog(page);
}

// The box around two elements, for annotating a from/to pair.
async function union(page, a, b) {
  const ra = await page.locator(a).boundingBox();
  const rb = await page.locator(b).boundingBox();
  const x = Math.min(ra.x, rb.x) - 3, y = Math.min(ra.y, rb.y) - 3;
  const x2 = Math.max(ra.x + ra.width, rb.x + rb.width) + 3, y2 = Math.max(ra.y + ra.height, rb.y + rb.height) + 3;
  return [x, y, x2 - x, y2 - y];
}
