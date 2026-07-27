// Sanity check: expand the raw LDraw model to a per-part count and reconcile it
// against the manual-derived parts CSV. Runs in the browser off the same model
// text the viewer loads, so what you see rendered is what gets counted.

const CSV_URL = '/model/rebrickable_parts.csv';

// Expand an LDraw MPD (multiple "0 FILE" submodels) to leaf part counts.
// Submodel names can contain spaces, so the filename in a type-1 line is
// everything after the 13 numeric parameters, not just the last token.
export function expandLdr(text) {
  const files = {};
  const order = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('0 FILE ')) {
      current = line.slice(7).trim().toLowerCase();
      files[current] = [];
      order.push(current);
      continue;
    }
    if (current == null) { current = '__root__'; files[current] = []; order.push(current); }
    if (line.startsWith('1 ')) {
      const p = line.split(/\s+/);
      files[current].push(p.slice(14).join(' ').toLowerCase());
    }
  }
  const counts = {};
  (function expand(name, mult) {
    const refs = files[name];
    if (!refs) { counts[name] = (counts[name] || 0) + mult; return; }
    for (const ref of refs) {
      if (files[ref]) expand(ref, mult);
      else counts[ref] = (counts[ref] || 0) + mult;
    }
  })(order[0], 1);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total, unique: Object.keys(counts).length };
}

function baseId(id) { return id.replace(/\.dat$/, '').toLowerCase(); }

// Parse rebrickable CSV: Part,Color,Quantity,Is Spare
export function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter(Boolean);
  rows.shift(); // header
  const counts = {};
  let total = 0, spares = 0;
  for (const row of rows) {
    const [part, , qty, isSpare] = row.split(',');
    const q = parseInt(qty, 10) || 0;
    if ((isSpare || '').trim().toLowerCase() === 'true') { spares += q; continue; }
    counts[part.toLowerCase()] = (counts[part.toLowerCase()] || 0) + q;
    total += q;
  }
  return { counts, total, spares, unique: Object.keys(counts).length };
}

export async function crossCheck(modelText) {
  const ldr = expandLdr(modelText);
  const ldrBase = {};
  for (const [k, v] of Object.entries(ldr.counts)) ldrBase[baseId(k)] = (ldrBase[baseId(k)] || 0) + v;

  let csv = null;
  try {
    const csvText = await fetch(CSV_URL).then((r) => (r.ok ? r.text() : null));
    if (csvText) csv = parseCsv(csvText);
  } catch { /* CSV optional */ }

  const result = { ldrBricks: ldr.total, ldrUnique: ldr.unique };
  if (csv) {
    const ids = new Set([...Object.keys(ldrBase), ...Object.keys(csv.counts)]);
    let both = 0;
    const ldrOnly = [], csvOnly = [];
    for (const id of ids) {
      const a = ldrBase[id] || 0, b = csv.counts[id] || 0;
      if (a > 0 && b > 0) both++;
      else if (a > 0) ldrOnly.push([id, a]);
      else csvOnly.push([id, b]);
    }
    Object.assign(result, {
      csvBricks: csv.total, csvSpares: csv.spares, csvUnique: csv.unique,
      matchedParts: both, ldrOnly, csvOnly,
    });
  }

  // Log a readable summary for the console.
  console.groupCollapsed(
    `%c[cross-check] LDR ${result.ldrBricks} bricks` +
    (csv ? ` vs CSV ${result.csvBricks} (non-spare)` : ''),
    'color:#7dd3fc'
  );
  console.log('LDraw model:', result.ldrBricks, 'bricks,', result.ldrUnique, 'unique parts');
  if (csv) {
    console.log('CSV:', result.csvBricks, 'non-spare bricks,', result.csvUnique, 'unique parts');
    console.log('Matched part numbers:', result.matchedParts);
    console.log('Δ bricks (CSV − LDR):', result.csvBricks - result.ldrBricks,
      '— mostly minifig sub-parts & printed-variant IDs the manual lists separately');
    console.log('IDs only in CSV:', result.csvOnly.map(([i, n]) => `${i}×${n}`).join(', '));
    console.log('IDs only in LDR:', result.ldrOnly.map(([i, n]) => `${i}×${n}`).join(', '));
  }
  console.groupEnd();

  return result;
}
