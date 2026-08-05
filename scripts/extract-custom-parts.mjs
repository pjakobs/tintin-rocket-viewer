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
// *embeds* the correct geometry for every custom part as MPD sections.
//
// Two things about those sections vary by Studio version, so both are handled:
//   * the section NAME — 2.26.3 wrote `0 FILE 8097.dat`, 2.26.6 writes
//     `0 FILE rename_bl_8097.dat`. Lookup is by normalised name.
//   * whether the geometry is INLINE — 2.26.3 inlined every triangle, 2.26.6
//     moved `98138pb459`'s into `s/bl_98138pb459_0.dat` + `_1.dat` and left the
//     section holding only type-1 references. We flatten those refs.
// Missing either one fails silently-ish: you get a header-only .dat (an
// invisible part) or a skipped part, not a crash.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IO = path.join(root, 'references', 'Lego Tintin-Full inventory.io');
const LIBS = [path.join(root, 'ldraw-library/parts'), path.join(root, 'ldraw-min/parts')];

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

// Split the MPD into { normalisedFileName -> body }.
const sections = {};
let cur = null, buf = [];
for (const raw of model2.split(/\r?\n/)) {
  if (/^0 FILE /i.test(raw.trim())) {
    if (cur) sections[cur] = buf.join('\n');
    cur = normName(raw.trim().slice(7));
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

// Section lookup that tolerates Studio's naming churn: `8097.dat`,
// `bl_8097.dat` and `rename_bl_8097.dat` all normalise to the same key, as does
// a `s/`-prefixed subfile path.
function normName(name) {
  return name.trim().toLowerCase().replace(/^s\//, '').replace(/^(rename_)?(bl_)?/, '');
}

// ---- flattening ------------------------------------------------------------
// A type-1 line is: 1 <colour> x y z a b c d e f g h i <file>, i.e. a 3x3
// matrix plus a translation. Sub-references have to be inlined with that
// transform applied, because we emit a single flat .dat per part.
const IDENTITY = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function compose(a, b) {
  const A = a.m, B = b.m, m = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      m[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  const t = [0, 1, 2].map((r) =>
    A[r * 3] * b.t[0] + A[r * 3 + 1] * b.t[1] + A[r * 3 + 2] * b.t[2] + a.t[r]);
  return { m, t };
}
const isIdentity = (x) =>
  x.m.every((v, i) => Math.abs(v - IDENTITY.m[i]) < 1e-9) && x.t.every((v) => Math.abs(v) < 1e-9);
function apply({ m, t }, p) {
  return [0, 1, 2].map((r) => m[r * 3] * p[0] + m[r * 3 + 1] * p[1] + m[r * 3 + 2] * p[2] + t[r]);
}
// A mirroring transform flips face winding; BFC CERTIFY CCW output must undo it.
const det = ({ m }) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

const POINTS = { 2: 2, 3: 3, 4: 4, 5: 4 };   // vertices per geometry line type
const fmt = (n) => (Math.abs(n) < 1e-9 ? '0.000' : n.toFixed(3));

// Walk a section, emitting flat geometry lines. Studio wraps geometry in
// non-standard meta (0 FILE, 0 CustomBrick, 0 IsSubModel, 0 FlexibleBrick...)
// that makes LDrawLoader misclassify the file as a submodel and emit nothing —
// so only type 2-5 lines survive, wrapped later in a clean part header.
function flatten(sectionName, sections, xf = IDENTITY, seen = new Set()) {
  const key = normName(sectionName);
  const body = sections[key];
  if (body == null) return [];
  if (seen.has(key)) return [];        // cycles shouldn't happen, but don't hang on them
  const nested = new Set(seen).add(key);

  const out = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const type = line[0];

    if (type === '1') {
      const p = line.split(/\s+/);
      const [x, y, z] = p.slice(2, 5).map(Number);
      const m = p.slice(5, 14).map(Number);
      out.push(...flatten(p.slice(14).join(' '), sections, compose(xf, { m, t: [x, y, z] }), nested));
      continue;
    }
    if (!POINTS[type]) continue;

    // Identity is the common case; pass the coordinates through untouched so no
    // rounding creeps in and output stays stable across runs.
    if (isIdentity(xf)) { out.push(line); continue; }

    const p = line.split(/\s+/);
    const n = POINTS[type];
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(apply(xf, p.slice(2 + i * 3, 5 + i * 3).map(Number)));
    // Type 5's trailing pair are control points, not winding — leave their order.
    if ((type === '3' || type === '4') && det(xf) < 0) pts.reverse();
    // Preserve any trailing tokens (older Studio exports pad lines with extra zeros).
    const tail = p.slice(2 + n * 3);
    out.push([type, p[1], ...pts.flat().map(fmt), ...tail].join(' '));
  }
  return out;
}

let failed = false;
for (const [src, dst] of Object.entries(MAP)) {
  const body = sections[normName(src)];
  if (!body) { console.error('No embedded section for', src, '— skipping'); failed = true; continue; }
  const lines = flatten(src, sections);
  // A header-only .dat is an invisible part, which is easy to miss in the viewer.
  // Fail loudly instead — this is exactly how the Studio 2.26.6 format change bit.
  if (!lines.length) {
    console.error(`No geometry recovered for ${src} — refusing to write an empty ${dst}`);
    failed = true;
    continue;
  }
  const geom = normalizeColours(lines.join('\n'));
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
    console.log('wrote', path.relative(root, path.join(dir, dst)), `(${lines.length} geometry lines)`);
  }
}
if (failed) process.exit(1);
