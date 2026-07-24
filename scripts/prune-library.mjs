// Shrink public/ldraw from the full ~820 MB library to only the parts this model
// actually references (plus their recursive sub-parts and primitives).
//
//   node scripts/prune-library.mjs           # dry run: report what would be kept
//   node scripts/prune-library.mjs --apply   # copy the needed subset to public/ldraw-min
//
// After --apply, point the viewer at the slim library by changing LIBRARY_PATH
// in src/main.js to '/ldraw-min/' (and move/rename as you like).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(root, 'public/ldraw');
const OUT = path.join(root, 'public/ldraw-min');
const MODEL = path.join(root, 'public/model/tintin-rocket.ldr');
const apply = process.argv.includes('--apply');

// Resolve a referenced filename to its on-disk location, mirroring LDrawLoader's
// search order: parts/ -> p/ -> models/ -> as-is.
const SUBDIRS = ['parts', 'p', 'models', 'parts/s', 'p/48', 'p/8', ''];
function resolve(name) {
  const n = name.replace(/\\/g, '/').toLowerCase();
  for (const sub of SUBDIRS) {
    const rel = path.join(sub, n);
    if (fs.existsSync(path.join(LIB, rel))) return rel;
  }
  return null;
}

// Parse a .dat/.ldr file body for its type-1 sub-references.
function refsOf(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('1 ')) out.push(line.split(/\s+/).slice(14).join(' '));
  }
  return out;
}

const keep = new Set();
const seen = new Set();
function walk(name) {
  const rel = resolve(name);
  if (!rel) return; // missing (e.g. a submodel defined inline, or a real gap)
  if (seen.has(rel)) return;
  seen.add(rel);
  keep.add(rel);
  for (const r of refsOf(path.join(LIB, rel))) walk(r);
}

// Seed from the model's top-level part references. Submodels are inline in the
// MPD, so start from every type-1 reference in the model file.
for (const r of refsOf(MODEL)) walk(r);
// Always keep the colour config.
if (fs.existsSync(path.join(LIB, 'LDConfig.ldr'))) keep.add('LDConfig.ldr');

console.log(`Model needs ${keep.size} library files (of ~46k total).`);
if (!apply) {
  console.log('Dry run. Re-run with --apply to write public/ldraw-min/.');
  process.exit(0);
}

let bytes = 0;
for (const rel of keep) {
  const src = path.join(LIB, rel);
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  bytes += fs.statSync(src).size;
}
console.log(`Wrote ${keep.size} files (${(bytes / 1e6).toFixed(1)} MB) to public/ldraw-min/`);
console.log("Now set LIBRARY_PATH = '/ldraw-min/' in src/main.js.");
