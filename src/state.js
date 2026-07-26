// Deep-links the viewer's interactive state (explode amount, build step, camera,
// selected brick) into the URL hash, so any view is a shareable / bookmarkable /
// refresh-safe link. Format is a short "&"-joined key=value string, e.g.
//   #e=40&s=180&p=612&h=41,88&cx=120&cy=340&cz=560&tx=0&ty=80&tz=0
// Only keys that differ from the default view are written, so a plain visit
// keeps a clean URL.

const WRITE_DEBOUNCE_MS = 350;   // write this long after the last change
const WRITE_MAX_WAIT_MS = 600;   // ...but never wait longer than this since the first one

// Debounce with a max-wait: OrbitControls damping can keep firing 'change' events
// for a long time after a drag (inertia decaying toward a tiny epsilon), which
// would otherwise keep resetting a plain debounce and delay the URL update far
// longer than feels responsive.
function debounceWithMaxWait(fn, wait, maxWait) {
  let timer = null;
  let maxTimer = null;
  return () => {
    const flush = () => { clearTimeout(timer); clearTimeout(maxTimer); timer = maxTimer = null; fn(); };
    clearTimeout(timer);
    timer = setTimeout(flush, wait);
    if (!maxTimer) maxTimer = setTimeout(flush, maxWait);
  };
}

function parseHash() {
  const h = location.hash.replace(/^#/, '');
  const out = {};
  if (!h) return out;
  for (const kv of h.split('&')) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) out[k] = v;
  }
  return out;
}

function round(n) { return Math.round(n * 10) / 10; }

export function initStateSync({ model, camera, controls }) {
  const explodeEl = document.getElementById('explode');
  const stepEl = document.getElementById('step');
  const shareBtn = document.getElementById('share');

  let restoring = true;   // suppresses writes while we apply the initial URL state
  let cameraTouched = false;

  function currentState() {
    const s = {};
    if (explodeEl.valueAsNumber > 0) s.e = explodeEl.valueAsNumber;
    if (stepEl.valueAsNumber < model.maxStep) s.s = stepEl.valueAsNumber;
    if (model.selectedIndex != null) s.p = model.selectedIndex;
    if (model.hiddenIndices.length) s.h = model.hiddenIndices.join(',');
    if (cameraTouched) {
      s.cx = round(camera.position.x); s.cy = round(camera.position.y); s.cz = round(camera.position.z);
      s.tx = round(controls.target.x); s.ty = round(controls.target.y); s.tz = round(controls.target.z);
    }
    return s;
  }

  function writeHash() {
    const s = currentState();
    const hash = Object.entries(s).map(([k, v]) => `${k}=${v}`).join('&');
    const url = hash ? `#${hash}` : location.pathname + location.search;
    history.replaceState(null, '', url);
  }

  const debouncedWrite = debounceWithMaxWait(writeHash, WRITE_DEBOUNCE_MS, WRITE_MAX_WAIT_MS);
  function scheduleWrite() {
    if (restoring) return;
    debouncedWrite();
  }

  // ---- restore from URL (once) ---------------------------------------------
  const initial = parseHash();
  if (initial.e != null) { explodeEl.value = initial.e; explodeEl.dispatchEvent(new Event('input')); }
  if (initial.s != null) { stepEl.value = initial.s; stepEl.dispatchEvent(new Event('input')); }
  if (initial.cx != null) {
    camera.position.set(+initial.cx, +initial.cy, +initial.cz);
    controls.target.set(+initial.tx, +initial.ty, +initial.tz);
    controls.update();
    cameraTouched = true;
  }
  // Hidden bricks before the selection: a brick that's both hidden and selected is
  // contradictory (you'd get an info panel for something invisible), so hidden wins.
  if (initial.h != null) {
    for (const i of initial.h.split(',')) {
      const brick = model.bricks[+i];
      if (brick) model.setHidden(brick, true);
    }
  }
  if (initial.p != null) {
    const brick = model.bricks[+initial.p];
    if (brick && !brick.hidden) model.selectBrick(brick);
  }
  restoring = false;

  // ---- wire up writers -------------------------------------------------------
  explodeEl.addEventListener('input', scheduleWrite);
  stepEl.addEventListener('input', scheduleWrite);
  controls.addEventListener('change', () => { cameraTouched = true; scheduleWrite(); });
  model.onFeatureChange = scheduleWrite;   // called by features.js during Play
  model.onSelectionChange = scheduleWrite; // called by hotspots.js on select/deselect

  // ---- share button ----------------------------------------------------------
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      writeHash(); // flush immediately so the copied link reflects the current view
      try {
        await navigator.clipboard.writeText(location.href);
        const prev = shareBtn.textContent;
        shareBtn.textContent = '✓ Copied';
        setTimeout(() => { shareBtn.textContent = prev; }, 1400);
      } catch {
        prompt('Copy this link:', location.href); // clipboard API unavailable (e.g. http, permissions)
      }
    });
  }
}
