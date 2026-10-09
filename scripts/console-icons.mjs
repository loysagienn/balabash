// Renders the console's app icons into src/console/public from the approved
// service icon — the pair of PNGs in the project library (balabash/design/
// balabash-icon-transparent.png and balabash-icon-dark.png, 1254 × 1254, the
// "b" ribbon with a speech-bubble tail; design/README.md there names them).
// The PNGs here are committed: this script runs when the icon changes, not at
// build time. Headless Chromium (playwright, a devDependency) scales and
// composes them — the only raster tool on the host.
//
//   node scripts/console-icons.mjs <balabash-icon-transparent.png> <balabash-icon-dark.png>
//
// What it writes (sizes per the install requirements of Chrome and Safari):
//   favicon-32.png, favicon-192.png           the browser tab's <link rel="icon">: the
//                                             transparent icon with its own margins
//                                             cropped away and the mark fitted into the
//                                             square by its longer side (Vladimir's
//                                             29000): the "b" is 771 × 975, so it runs
//                                             from the top edge to the bottom one and is
//                                             centered across, with (1 − 771/975) / 2 ≈
//                                             10.5 % of the width clear at each side —
//                                             the square canvas, not the source's
//                                             padding. The canvas stays square on
//                                             purpose: Chromium resizes a favicon to
//                                             desired × desired pixels without keeping
//                                             its aspect (favicon_base/
//                                             select_favicon_frames.cc), so a 771 × 975
//                                             file would be stretched in the tab, and
//                                             stretching or cutting the approved mark
//                                             ourselves is out.
//   icon-192.png, icon-512.png                purpose "any": the transparent icon as is
//                                             (launcher, Chrome's install dialog and
//                                             splash over background_color)
//   icon-maskable-192.png, icon-maskable-512.png   purpose "maskable": the transparent icon
//                                             at 86 % over --bg — the mark reaches 0.895
//                                             of the canvas radius and the launcher's mask
//                                             keeps only the inner 80 % circle for sure
//   apple-touch-icon.png                      180 px, the dark icon as is — opaque, iOS
//                                             rounds the corners itself and ignores
//                                             transparency

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'console', 'public');

// tokens.css --bg: the surface under the maskable icon (the dark PNG's own
// graphite is the same color).
const BG = '#0c0d0f';
// The safe zone of a maskable icon is a circle of 80 % of the canvas; the
// approved mark reaches 0.895 of the radius, so it is scaled to 0.86 (0.77 of
// the safe zone) with a margin for the rounded corners of the stem.
const MASKABLE_SCALE = 0.86;
// The favicon's crop keeps every pixel with at least this alpha (of 255). The
// approved PNG carries stray pixels of alpha 1 along its bottom row and left
// column — export noise, invisible — which would otherwise hold the margins.
const CROP_ALPHA = 2;

const ICONS = [
  { name: 'favicon-32.png', size: 32, source: 'transparent', scale: 1, background: 'transparent', crop: true },
  { name: 'favicon-192.png', size: 192, source: 'transparent', scale: 1, background: 'transparent', crop: true },
  { name: 'icon-192.png', size: 192, source: 'transparent', scale: 1, background: 'transparent', crop: false },
  { name: 'icon-512.png', size: 512, source: 'transparent', scale: 1, background: 'transparent', crop: false },
  { name: 'icon-maskable-192.png', size: 192, source: 'transparent', scale: MASKABLE_SCALE, background: BG, crop: false },
  { name: 'icon-maskable-512.png', size: 512, source: 'transparent', scale: MASKABLE_SCALE, background: BG, crop: false },
  { name: 'apple-touch-icon.png', size: 180, source: 'dark', scale: 1, background: BG, crop: false },
];

/**
 * @param {{ size: number, background: string }} icon
 */
function markup({ size, background }) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;width:${size}px;height:${size}px;background:${background};overflow:hidden}
  img{position:absolute;display:block}
</style></head>
<body><img alt=""></body></html>`;
}

// Runs in the page: loads a PNG (a data URL) into a canvas and returns the box
// of its pixels with at least `alpha` — the source's mark when cropping, the
// rendered icon when checking the result.
/**
 * @param {{ src: string, alpha: number }} input
 * @returns {Promise<{ x: number, y: number, w: number, h: number, width: number, height: number }>}
 */
async function visibleBox({ src, alpha }) {
  const image = new Image();

  image.src = src;
  await image.decode();

  const canvas = document.createElement('canvas');

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext('2d');

  if (!context) throw new Error('no 2d context');

  context.drawImage(image, 0, 0);

  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] >= alpha) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }

  if (right < 0) throw new Error('the image has no visible pixels');

  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1, width, height };
}

// Runs in the page: loads the source into the <img> and lays it out so that
// `box` (a part of it, in source pixels; the whole image when null) is scaled
// to `size × scale` by its longer side and centered on the canvas — the
// browser's image scaling does the resampling.
/**
 * @param {{ src: string, size: number, scale: number, box: { x: number, y: number, w: number, h: number } | null }} input
 */
async function layOut({ src, size, scale, box: part }) {
  const img = document.querySelector('img');

  if (!(img instanceof HTMLImageElement)) throw new Error('no <img>');

  img.src = src;
  await img.decode();

  const box = part ?? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  const k = (size * scale) / Math.max(box.w, box.h);

  img.style.width = `${img.naturalWidth * k}px`;
  img.style.height = `${img.naturalHeight * k}px`;
  img.style.left = `${(size - box.w * k) / 2 - box.x * k}px`;
  img.style.top = `${(size - box.h * k) / 2 - box.y * k}px`;
}

// The cropped icon as rendered: the mark's longer side runs from edge to edge
// (no margin at either end), the shorter one is centered (the two margins
// differ by a pixel at most) and no wider than the proportions allow. Catches
// a crop that slipped (a changed source, a threshold that let noise hold a
// margin, a layout error) at the only time the PNGs are made.
/**
 * @param {{ x: number, y: number, w: number, h: number }} source
 * @param {{ x: number, y: number, w: number, h: number, width: number, height: number }} out
 * @returns {string} the margins, for the log
 */
function checkCrop(source, out) {
  const size = out.width;
  const tall = source.h >= source.w;
  const [longStart, longLength] = tall ? [out.y, out.h] : [out.x, out.w];
  const [shortStart, shortLength] = tall ? [out.x, out.w] : [out.y, out.h];
  const near = size - shortStart - shortLength;
  const allowed = Math.ceil((size * (1 - Math.min(source.w, source.h) / Math.max(source.w, source.h))) / 2);
  const where = `${out.w}×${out.h} at ${out.x},${out.y} in ${size}`;

  if (longStart !== 0 || longLength !== size) throw new Error(`the mark does not reach both edges along its longer side: ${where}`);
  if (Math.abs(shortStart - near) > 1) throw new Error(`the mark is off center across: ${where}`);
  if (shortStart > allowed) throw new Error(`the margins across (${shortStart} px) exceed the proportions' ${allowed} px: ${where}`);

  return tall ? `${out.y}/${near}/${size - out.y - out.h}/${shortStart} px top/right/bottom/left` : `${shortStart}/${size - out.x - out.w}/${near}/${out.x} px top/right/bottom/left`;
}

async function main() {
  const [transparentPath, darkPath] = process.argv.slice(2);

  if (!transparentPath || !darkPath) {
    console.error('usage: node scripts/console-icons.mjs <balabash-icon-transparent.png> <balabash-icon-dark.png>');
    process.exit(1);
  }

  const toDataUrl = async file => `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`;
  const sources = { transparent: await toDataUrl(transparentPath), dark: await toDataUrl(darkPath) };

  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();

  try {
    for (const icon of ICONS) {
      const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });

      await page.setContent(markup(icon));

      const src = sources[icon.source];
      const box = icon.crop ? await page.evaluate(visibleBox, { src, alpha: CROP_ALPHA }) : null;

      await page.evaluate(layOut, { src, size: icon.size, scale: icon.scale, box });

      const png = await page.screenshot({ omitBackground: icon.background === 'transparent', type: 'png' });
      let cropNote = '';

      if (box) {
        const out = await page.evaluate(visibleBox, { src: `data:image/png;base64,${png.toString('base64')}`, alpha: CROP_ALPHA });

        cropNote = `, cropped to ${box.w}×${box.h} at ${box.x},${box.y}; ${checkCrop(box, out)}`;
      }

      await fs.writeFile(path.join(OUT_DIR, icon.name), png);
      await page.close();

      console.log(`[console-icons] ${icon.name} (${icon.size} px, ${png.length} bytes${cropNote})`);
    }
  } finally {
    await browser.close();
  }
}

await main();
