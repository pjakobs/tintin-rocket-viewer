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
export function debounceWithMaxWait(fn, wait, maxWait) {
  let timer = null;
  let maxTimer = null;
  return () => {
    const flush = () => { clearTimeout(timer); clearTimeout(maxTimer); timer = maxTimer = null; fn(); };
    clearTimeout(timer);
    timer = setTimeout(flush, wait);
    if (!maxTimer) maxTimer = setTimeout(flush, maxWait);
  };
}

export function parseHash() {
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

const NOTICE_MS = 8000;   // how long the dismissible notice stays up

function notice(msg) {
  const el = document.getElementById('notice');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => el.classList.add('hidden'), NOTICE_MS);
}

// Wires camera + features + hotspots into the URL hash. Construction only sets
// up writers; call the returned restore() afterwards, once features.onChange /
// hotspots.onChange are wired to scheduleWrite, so a restored selection or
// hidden brick is suppressed by `restoring` rather than silently written back.
export function initStateSync({ camera, controls, features, hotspots }) {
  const shareBtn = document.getElementById('share');

  let restoring = true;   // suppresses writes while we apply the initial URL state
  let cameraTouched = false;

  function currentState() {
    const s = {};
    if (features.view.explode > 0) s.e = Math.round(features.view.explode * 100);
    if (features.view.step < features.maxStep) s.s = features.view.step;
    if (hotspots.selectedIndex != null) s.p = hotspots.selectedIndex;
    if (features.hiddenIndices.length) s.h = features.hiddenIndices.join(',');
    if (s.p != null || s.h != null) s.v = features.fingerprint;
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

  // ---- restore from URL (once) -----------------------------------------------
  function restore() {
    const initial = parseHash();
    if (initial.e != null) features.setView({ explode: (+initial.e) / 100 });
    if (initial.s != null) features.setView({ step: +initial.s });
    if (initial.cx != null) {
      camera.position.set(+initial.cx, +initial.cy, +initial.cz);
      controls.target.set(+initial.tx, +initial.ty, +initial.tz);
      controls.update();
      cameraTouched = true;
    }
    // p=/h= are positional indices into features.bricks — meaningless if the brick
    // list has changed shape since the link was made (reorder/insert/delete), and
    // silently resolving to the wrong brick is worse than not resolving at all.
    // A missing v counts as a mismatch (old links predate the fingerprint).
    const brickRefs = initial.p != null || initial.h != null;
    if (brickRefs && initial.v !== features.fingerprint) {
      delete initial.p; delete initial.h;
      notice('This link was made from a different version of the model — the highlighted and hidden bricks could not be restored.');
    }
    // Hidden bricks before the selection: a brick that's both hidden and selected is
    // contradictory (you'd get an info panel for something invisible), so hidden wins.
    if (initial.h != null) {
      for (const i of initial.h.split(',')) {
        const brick = features.bricks[+i];
        if (brick) features.setHidden(brick, true);
      }
    }
    if (initial.p != null) {
      const brick = features.bricks[+initial.p];
      if (brick && !brick.hidden) hotspots.selectBrick(brick);
    }
    restoring = false;
  }

  // ---- wire up writers ---------------------------------------------------------
  // features.onChange / hotspots.onChange are wired by main.js to scheduleWrite —
  // that's the single notification path for explode/step/selection/hidden changes.
  // Camera is the one input this module still listens for directly.
  const onControlsChange = () => { cameraTouched = true; scheduleWrite(); };
  controls.addEventListener('change', onControlsChange);

  // ---- share button ------------------------------------------------------------
  let onShareClick;
  if (shareBtn) {
    onShareClick = async () => {
      writeHash(); // flush immediately so the copied link reflects the current view
      try {
        await navigator.clipboard.writeText(location.href);
        const prev = shareBtn.textContent;
        shareBtn.textContent = '✓ Copied';
        setTimeout(() => { shareBtn.textContent = prev; }, 1400);
      } catch {
        prompt('Copy this link:', location.href); // clipboard API unavailable (e.g. http, permissions)
      }
    };
    shareBtn.addEventListener('click', onShareClick);
  }

  return {
    scheduleWrite,
    restore,
    dispose() {
      controls.removeEventListener('change', onControlsChange);
      if (shareBtn && onShareClick) shareBtn.removeEventListener('click', onShareClick);
    },
  };
}
