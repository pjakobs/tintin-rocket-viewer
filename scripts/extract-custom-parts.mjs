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
const LIBS = [path.join(root, 'ldraw-library/parts'), path.join(root, 'public/ldraw-min/parts')];

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

// Studio writes geometry (type 2/3/4/5) with colour code -1 meaning "inherit the
// part's colour". LDraw/three's LDrawLoader use 16 for that; it can't resolve a
// material for -1 and silently drops those faces (the cones render as nothing).
// Rewrite the colour token to 16 on geometry lines only (not on 0-meta lines,
// where -1 is a real value e.g. FlexibleBrickControlPointUnitLength -1).
function normalizeColours(text) {
  // Studio uses negative colour codes on geometry to mean "inherit": -1 on faces,
  // -2 on edges. LDraw can't resolve those (faces silently dropped, edges render
  // as magenta "missing" specks). Remap: faces (3/4) -> 16, edges (2/5) -> 24.
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^([2345])\s+(-\d+)\s+(.*)$/);
    if (!m) return line;
    const code = (m[1] === '2' || m[1] === '5') ? '24' : '16';
    return `${m[1]} ${code} ${m[3]}`;
  }).join('\n');
}

// Keep only real geometry lines (edges/tris/quads/conditional). Studio wraps the
// geometry in non-standard meta (0 FILE, 0 CustomBrick, 0 IsSubModel,
// 0 FlexibleBrick...) that makes LDrawLoader misclassify the file as a submodel
// and emit no geometry. We drop all of that and wrap the geometry in a clean,
// minimal LDraw part header instead.
function geometryOnly(text) {
  return text.split(/\r?\n/).filter((l) => /^[2345]\s/.test(l.trim())).join('\n');
}

for (const [src, dst] of Object.entries(MAP)) {
  const body = sections[src];
  if (!body) { console.error('No embedded section for', src, '— skipping'); continue; }
  // These sections are self-contained geometry (verified: no type-1 sub-refs).
  const geom = normalizeColours(geometryOnly(body));
  // Human-readable description: first 0-comment that isn't a known directive.
  const descLine = body.split(/\r?\n/).find((l) =>
    /^0 /.test(l) &&
    !/^0 (FILE|Name:|Author:|!|BFC|IsSubModel|CustomBrick|Flexible|BL_|RenderAngle|~Moved)/i.test(l.trim()));
  const desc = (descLine ? descLine.replace(/^0 ~?/, '') : dst).replace(/\s+/g, ' ').trim();
  const header =
    `0 ${desc}\n` +
    `0 Name: ${dst}\n` +
    `0 !LDRAW_ORG Unofficial_Part\n` +
    `0 BFC CERTIFY CCW\n` +
    `0 // Geometry extracted from BrickLink Studio .io (model2.ldr) — the correct\n` +
    `0 // BrickLink part geometry, NOT LDraw's same-numbered part. Colour -1 -> 16.\n`;
  for (const dir of LIBS) {
    if (!fs.existsSync(dir)) continue;
    fs.writeFileSync(path.join(dir, dst), header + geom + '\n');
    console.log('wrote', path.relative(root, path.join(dir, dst)));
  }
}
