// Render the Takeout for Brightwheel icon set from SVG.
//
// Design: rounded-square sage gradient (matches the takeout page's brand-mark)
// with a stylized "bw" wordmark in cream, plus a small folded-corner-page
// motif on the largest size to hint at "archive / takeout". Kept clean at
// 16px — the wordmark disappears below ~24px, replaced by just the mark.
//
// Runs at build time (or on demand):  node scripts/gen-icons.mjs
// Output: public/icons/icon-{16,32,48,128}.png

import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'public', 'icons');

// Sage-cream palette matches src/takeout-page/takeout.css.
const SAGE_LIGHT = '#C5D4BA';
const SAGE_DEEP = '#5F6E4F';
const CREAM = '#FAF8F4';

/**
 * Large-size SVG: gradient tile + wordmark "bw" + subtle folded-page corner.
 * The viewBox is 128x128; sharp resamples to each target size.
 */
function largeSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${SAGE_LIGHT}"/>
      <stop offset="1" stop-color="${SAGE_DEEP}"/>
    </linearGradient>
    <filter id="soft" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="0.4"/>
    </filter>
  </defs>
  <!-- Rounded-square tile. -->
  <rect x="4" y="4" width="120" height="120" rx="26" ry="26" fill="url(#bg)"/>
  <!-- Folded-page corner in the upper-right, hinting at "archive / takeout". -->
  <path d="M 96 12 L 116 12 L 116 32 Z" fill="${CREAM}" fill-opacity="0.28"/>
  <path d="M 96 12 L 116 32 L 96 32 Z" fill="${CREAM}" fill-opacity="0.14"/>
  <!-- "bw" wordmark, hand-tuned so it reads at 48px. -->
  <g fill="${CREAM}" filter="url(#soft)">
    <!-- b -->
    <path d="
      M 30 88
      L 30 40
      L 42 40
      L 42 60
      Q 52 54 60 60
      Q 68 66 68 76
      Q 68 86 60 92
      Q 52 98 42 92
      L 42 88
      Z
      M 42 76
      Q 42 84 50 84
      Q 58 84 58 76
      Q 58 68 50 68
      Q 42 68 42 76
      Z
      " />
    <!-- w -->
    <path d="
      M 72 60
      L 82 60
      L 86 82
      L 92 60
      L 100 60
      L 106 82
      L 110 60
      L 120 60
      L 112 94
      L 100 94
      L 96 74
      L 92 94
      L 80 94
      Z
    "/>
  </g>
</svg>`;
}

/**
 * Compact SVG for the 16px icon: same tile + gradient, but just a bold
 * lowercase "b" mark since the "bw" wordmark becomes illegible below ~24px.
 * Built as three simple non-overlapping shapes (stem + bowl outer + bowl
 * inner) so that a "fill-rule: evenodd" hole reliably renders — the earlier
 * combined path lost the counter at 16px.
 */
function smallSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="16" y2="16" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${SAGE_LIGHT}"/>
      <stop offset="1" stop-color="${SAGE_DEEP}"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="14" height="14" rx="3" ry="3" fill="url(#bg)"/>
  <!-- Vertical stem. -->
  <rect x="3.5" y="3" width="2" height="10" fill="${CREAM}"/>
  <!-- Bowl: filled circle then a smaller cream-hued inner circle to punch
       out the counter with a solid color match against the tile. Using two
       explicit shapes instead of an evenodd hole so 16px rendering can't
       lose the inner geometry. -->
  <circle cx="8.6" cy="9" r="3.4" fill="${CREAM}"/>
  <circle cx="8.6" cy="9" r="1.5" fill="${SAGE_DEEP}"/>
</svg>`;
}

async function render(size) {
  // 16px uses the deliberately-simple mark; larger sizes use the wordmark.
  const svg = size < 24 ? smallSvg() : largeSvg();
  const buf = await sharp(Buffer.from(svg))
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const path = resolve(OUT_DIR, `icon-${size}.png`);
  await writeFile(path, buf);
  console.log(`  wrote ${path} (${buf.byteLength}B)`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await render(size);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
