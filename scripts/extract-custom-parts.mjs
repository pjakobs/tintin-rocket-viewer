// Extract BrickLink Studio custom-part geometry (the `bl_*` parts) from the
// Studio .io export and write them into the LDraw library, so the model's own
// transforms place them correctly.
//
//   node scripts/extract-custom-parts.mjs
//
// Why this is needed: the model references two Studio-proprietary parts that
// aren't in the official LDraw library — `bl_8097` (the nose cone, ×2) and
// `bl_98138pb459` (a printed 1×1 round tile). They can't just be aliased to the
// same-numbered LDraw files, because **BrickLink part numbers collide with
// different LDraw part numbers**: LDraw `8097.dat` is a "Panel Cone 4×8×8", but
// BrickLink 8097 is a "Panel Cone 3×6×6" — a different shape with a different
// local origin. Aliasing to LDraw 8097 renders the nose cones splayed outward.
//
// Studio's `.io` is a zip; its `model2.ldr` is an LDraw-compatible export that
// *embeds* the correct geometry for every custom part as inline MPD sections.
// We pull those sections out verbatim.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IO = path.join(root, 'references', 'Lego Tintin-Full inventory.io');
const LIBS = [path.join(root, 'public/ldraw/parts'), path.join(root, 'public/ldraw-min/parts')];

// Embedded MPD section name in model2.ldr -> target bl_* filename we write.
const MAP = {
  '8097.dat': 'bl_8097.dat',
  '98138pb459.dat': 'bl_98138pb459.dat',
};

if (!fs.existsSync(IO)) {
  console.error('Cannot find the Studio .io export at', IO);
  process.exit(1);
}

// Read model2.ldr out of the .io zip (via `unzip -p`, available on macOS/Linux).
const model2 = execFileSync('unzip', ['-p', IO, 'model2.ldr'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');

// Split the MPD into { fileName -> body }.
const sections = {};
let cur = null, buf = [];
for (const raw of model2.split(/\r?\n/)) {
  if (/^0 FILE /i.test(raw.trim())) {
    if (cur) sections[cur] = buf.join('\n');
    cur = raw.trim().slice(7).trim().toLowerCase();
    buf = [raw];
  } else if (cur) buf.push(raw);
}
if (cur) sections[cur] = buf.join('\n');

for (const [src, dst] of Object.entries(MAP)) {
  const body = sections[src];
  if (!body) { console.error('No embedded section for', src, '— skipping'); continue; }
  // These sections are self-contained geometry (verified: no type-1 sub-refs).
  const named = body
    .replace(/^0 FILE .*/im, `0 FILE ${dst}`)
    .replace(/^0 Name:.*/im, `0 Name: ${dst}`);
  const header = `0 ${dst} — geometry extracted from BrickLink Studio .io (model2.ldr).\n` +
    `0 This is the correct BrickLink part geometry, NOT LDraw's same-numbered part.\n`;
  for (const dir of LIBS) {
    if (!fs.existsSync(dir)) continue;
    fs.writeFileSync(path.join(dir, dst), header + named + '\n');
    console.log('wrote', path.relative(root, path.join(dir, dst)));
  }
}
