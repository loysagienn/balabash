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
//   icon-32.png, icon-192.png, icon-512.png   purpose "any": the transparent icon as is
//                                             (tab, launcher, Chrome's install dialog
//                                             and splash over background_color)
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

const ICONS = [
  { name: 'icon-32.png', size: 32, source: 'transparent', scale: 1, background: 'transparent' },
  { name: 'icon-192.png', size: 192, source: 'transparent', scale: 1, background: 'transparent' },
  { name: 'icon-512.png', size: 512, source: 'transparent', scale: 1, background: 'transparent' },
  { name: 'icon-maskable-192.png', size: 192, source: 'transparent', scale: MASKABLE_SCALE, background: BG },
  { name: 'icon-maskable-512.png', size: 512, source: 'transparent', scale: MASKABLE_SCALE, background: BG },
  { name: 'apple-touch-icon.png', size: 180, source: 'dark', scale: 1, background: BG },
];

/**
 * @param {{ size: number, scale: number, background: string }} icon
 * @param {string} imageDataUrl
 */
function markup({ size, scale, background }, imageDataUrl) {
  const side = size * scale;
  const offset = (size - side) / 2;

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;width:${size}px;height:${size}px;background:${background};overflow:hidden}
  img{position:absolute;left:${offset}px;top:${offset}px;width:${side}px;height:${side}px;display:block}
</style></head>
<body><img src="${imageDataUrl}" alt=""></body></html>`;
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

      await page.setContent(markup(icon, sources[icon.source]));
      await page.evaluate(() => Promise.all([...document.images].map(img => img.decode())));

      const png = await page.screenshot({ omitBackground: icon.background === 'transparent', type: 'png' });

      await fs.writeFile(path.join(OUT_DIR, icon.name), png);
      await page.close();
      console.log(`[console-icons] ${icon.name} (${icon.size} px, ${png.length} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

await main();
