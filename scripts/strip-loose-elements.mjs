// Split the master Studio export into (a) the rocket the viewer renders and
// (b) the loose minifig gear, kept aside for later use.
//
//   node scripts/strip-loose-elements.mjs
//
// The set 21367 inventory includes five astronaut backpacks, their air tanks, a
// couple of small props and a 380x20 LDU tile strip the minifigs stand on. In
// the export these sit on the base plane but ~500 LDU off to the side, well
// clear of the rocket's own footprint. Rendered without the actual minifigs
// they read as debris, and being far off-axis they inflate the model bounds
// (pulling the auto-framed camera back) and skew the explode centroid.
//
// Everything with z < CUTOFF is moved out. Submodels left unreferenced by the
// rocket are dropped from it and carried over to the gear file instead.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'references', 'Lego Tintin-Full inventory.ldr');
const OUT_MODEL = path.join(ROOT, 'public', 'model', 'tintin-rocket.ldr');
const OUT_GEAR = path.join(ROOT, 'references', 'minifig-gear.ldr');

// The rocket's rearmost brick sits at z = -146; the gear cluster starts at -440.
const CUTOFF = -350;

const text = fs.readFileSync(SRC, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);

// --- parse the MPD into ordered blocks -------------------------------------

const blocks = [];
let cur = null;
for (const raw of lines) {
  const line = raw.trim();
  if (/^0 FILE /i.test(line)) {
    cur = { name: line.slice(7).trim(), header: [raw], body: [] };
    blocks.push(cur);
    continue;
  }
  if (/^0 NOFILE/i.test(line)) { cur = null; continue; }
  if (cur) cur.body.push(raw);
}
if (!blocks.length) throw new Error(`no "0 FILE" blocks in ${SRC}`);

const byName = new Map(blocks.map((b) => [b.name.toLowerCase(), b]));

// A type-1 line is: 1 <colour> <x y z> <9 matrix values> <filename>.
// Submodel names can contain spaces, so the filename is everything after the
// first 14 tokens, not just the last one.
const refOf = (raw) => raw.trim().split(/\s+/).slice(14).join(' ');
const isRef = (raw) => raw.trim().startsWith('1 ');

// --- split the root block ---------------------------------------------------

const root = blocks[0];
const keep = [];
const moved = [];
for (const raw of root.body) {
  if (isRef(raw) && Number(raw.trim().split(/\s+/)[4]) < CUTOFF) moved.push(raw);
  else keep.push(raw);
}
if (!moved.length) throw new Error(`nothing found beyond z < ${CUTOFF} — has the export changed?`);
root.body = keep;

// --- work out which submodels each side still needs -------------------------

function reachable(bodies) {
  const seen = new Set();
  const walk = (body) => {
    for (const raw of body) {
      if (!isRef(raw)) continue;
      const sub = byName.get(refOf(raw).toLowerCase());
      if (!sub || seen.has(sub.name)) continue;
      seen.add(sub.name);
      walk(sub.body);
    }
  };
  walk(bodies);
  return seen;
}

const usedByRocket = reachable(root.body);
const usedByGear = reachable(moved);

// --- emit -------------------------------------------------------------------

const brickCount = (body) =>
  body.filter(isRef).reduce((n, raw) => {
    const sub = byName.get(refOf(raw).toLowerCase());
    return n + (sub ? brickCount(sub.body) : 1);
  }, 0);

// Studio records a per-block brick total; keep it honest after the split.
const retotal = (block) =>
  block.header.concat(block.body).map((raw) =>
    /^\s*0 NumOfBricks /i.test(raw) ? `0 NumOfBricks ${brickCount(block.body)}` : raw
  );

const render = (list) =>
  list.flatMap((b) => [...retotal(b), '0 NOFILE']).join(eol) + eol;

const rocketBlocks = [root, ...blocks.slice(1).filter((b) => usedByRocket.has(b.name))];
const gearRoot = {
  name: 'minifig gear',
  header: [
    '0 FILE minifig gear',
    '0 Loose minifig gear from set 21367, split out of the rocket model',
    '0 Name: minifig gear',
    '0 Author: ',
    '0 CustomBrick',
    '0 NumOfBricks 0',
  ],
  body: moved,
};
const gearBlocks = [gearRoot, ...blocks.slice(1).filter((b) => usedByGear.has(b.name))];

fs.writeFileSync(OUT_MODEL, render(rocketBlocks));
fs.writeFileSync(OUT_GEAR, render(gearBlocks));

const rel = (p) => path.relative(ROOT, p);
console.log(`${rel(SRC)}: ${brickCount(root.body) + brickCount(moved)} bricks, ${blocks.length} blocks`);
console.log(`  -> ${rel(OUT_MODEL)}: ${brickCount(root.body)} bricks, ${rocketBlocks.length} blocks`);
console.log(`  -> ${rel(OUT_GEAR)}: ${brickCount(moved)} bricks, ${gearBlocks.length} blocks` +
  ` (${moved.length} placements: ${[...new Set(moved.map(refOf))].join(', ')})`);
