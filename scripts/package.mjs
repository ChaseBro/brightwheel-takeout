// Produce a Chrome-Web-Store-ready zip of the built extension.
//
// Reads the version from package.json, zips extension/dist/ into
// extension/releases/brightwheel-takeout-v<version>.zip, and prints a summary.
//
// Node-native (no external deps): uses the standard-library `zlib` deflate
// primitives wrapped in a minimal ZIP writer. This keeps the packaging path
// portable — nothing to `npm install` beyond what the extension itself needs,
// and no shelling out to a system `zip` binary.

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const deflateRawAsync = promisify(deflateRaw);

const HERE = new URL('.', import.meta.url).pathname;
const EXT_ROOT = resolve(HERE, '..');
const DIST_DIR = join(EXT_ROOT, 'dist');
const RELEASES_DIR = join(EXT_ROOT, 'releases');

const pkg = JSON.parse(await fs.readFile(join(EXT_ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// CRC-32 (IEEE 802.3) — required by the ZIP spec for every entry.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ZIP DOS date/time (2-second resolution, 1980 epoch).
function dosDateTime(date) {
  const t =
    ((date.getSeconds() / 2) | 0) |
    (date.getMinutes() << 5) |
    (date.getHours() << 11);
  const d =
    date.getDate() |
    ((date.getMonth() + 1) << 5) |
    ((date.getFullYear() - 1980) << 9);
  return { time: t & 0xffff, date: d & 0xffff };
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

async function buildZip(files, outPath) {
  const now = new Date();
  const { time, date } = dosDateTime(now);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { archivePath, data } of files) {
    const nameBuf = Buffer.from(archivePath, 'utf8');
    const crc = crc32(data);
    const compressed = await deflateRawAsync(data, { level: 9 });
    // Fall back to STORE if deflate happens to inflate (tiny files); harmless.
    const useDeflate = compressed.length < data.length;
    const method = useDeflate ? 8 : 0;
    const stored = useDeflate ? compressed : data;

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0),  // flags — UTF-8 not set; ASCII paths only in our build
      u16(method),
      u16(time),
      u16(date),
      u32(crc),
      u32(stored.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),  // extra length
    ]);
    localParts.push(localHeader, nameBuf, stored);
    const localSize = localHeader.length + nameBuf.length + stored.length;

    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed
        u16(0),  // flags
        u16(method),
        u16(time),
        u16(date),
        u32(crc),
        u32(stored.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),  // extra
        u16(0),  // comment
        u16(0),  // disk number
        u16(0),  // internal attrs
        u32(0),  // external attrs
        u32(offset),
        nameBuf,
      ])
    );

    offset += localSize;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);

  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(centralOffset),
    u16(0), // comment length
  ]);

  await fs.mkdir(RELEASES_DIR, { recursive: true });
  const out = createWriteStream(outPath);
  for (const part of localParts) out.write(part);
  out.write(central);
  out.write(eocd);
  await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
}

// Main
try {
  await fs.access(DIST_DIR);
} catch {
  console.error(`error: ${DIST_DIR} does not exist. Run \`npm run build\` first.`);
  process.exit(1);
}

const paths = (await walk(DIST_DIR)).sort();
const files = await Promise.all(
  paths.map(async (p) => {
    const rel = relative(DIST_DIR, p).split(sep).join('/');
    const data = await fs.readFile(p);
    return { archivePath: rel, data };
  })
);

const outPath = join(RELEASES_DIR, `brightwheel-takeout-v${version}.zip`);
await buildZip(files, outPath);

const stat = await fs.stat(outPath);
const bytes = stat.size;
const kb = (bytes / 1024).toFixed(1);
const sha256 = createHash('sha256');
await pipeline(createReadStream(outPath), sha256);
const digest = sha256.digest('hex');

console.log('');
console.log(`  packaged: ${relative(EXT_ROOT, outPath)}`);
console.log(`  files:    ${files.length}`);
console.log(`  size:     ${kb} KiB (${bytes} bytes)`);
console.log(`  sha256:   ${digest}`);
console.log('');
