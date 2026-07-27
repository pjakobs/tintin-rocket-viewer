// Single keydown listener for every keyboard shortcut in the app. Each module
// registers its bindings with bindKey() instead of adding its own
// 'keydown' listener — one guard (don't steal slider keys), one registry
// (loud on a combo collision), and one place the UI hint text is sourced from.

const bindings = new Map();

// combo is 'x' for a bare key, or 'mod+x' for Cmd (Mac) / Ctrl (Windows/Linux) + x.
// label is the fragment shown in the on-screen hint text; omit it for a combo
// that shares another binding's hint (e.g. mod+z alongside 'u').
export function bindKey(combo, fn, { label, preventDefault = false } = {}) {
  if (bindings.has(combo)) throw new Error(`key "${combo}" already bound`);
  bindings.set(combo, { fn, label, preventDefault });
}

// { combo: label } for every binding that has one, in registration order —
// callers pick the combos they care about (see main.js's hint-text wiring).
export function keyHints() {
  const out = {};
  for (const [combo, b] of bindings) if (b.label) out[combo] = b.label;
  return out;
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return; // don't steal slider keys
  const mod = e.metaKey || e.ctrlKey;
  if (!mod && e.altKey) return; // no bare-key binding is ever allowed under Alt
  const combo = (mod ? 'mod+' : '') + e.key.toLowerCase();
  const b = bindings.get(combo);
  if (!b) return;
  if (b.preventDefault) e.preventDefault();
  b.fn();
});
