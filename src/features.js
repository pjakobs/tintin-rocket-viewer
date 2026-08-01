import * as THREE from 'three';
import { axisOfSymmetry } from './geometry.js';
import { bindKey } from './keymap.js';

// Interactive features driven off the per-part LDraw metadata:
//  - Exploded view   : each brick slides radially away from the rocket's axis.
//  - Build scrubber  : reveal bricks up to a given LDraw build step (0..maxStep).
//
// Both operate on the ~1,255 "brick groups" — the outermost Object3D whose
// userData.fileName is a .dat part (nested sub-parts move/hide with their brick).

const EXPLODE_SCALE = 1.5;   // at 100%, a brick moves ~1.5× its distance-from-centre
const EXPLODE_BASE = 45;     // + a constant push (LDU) so axis-hugging bricks also separate
const VERTICAL_BIAS = 0.4;   // how much bricks also fan out along the rocket axis
const PLAY_SECONDS = 22;     // duration of the "Play build" animation

// Order-sensitive fingerprint over the brick list (FNV-1a with a separator
// byte, so a reorder, insert or delete changes it). Used to detect share
// links made against a different build of the model — see state.js.
function fingerprintOf(entries) {
  let h = 0x811c9dc5;
  const mix = (c) => { h ^= c; h = Math.imul(h, 0x01000193); };
  for (const e of entries) {
    const s = e.group.userData.fileName || '';
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
    mix(0x2c);   // separator: ["ab","c"] must not hash like ["a","bc"]
  }
  return (h >>> 0).toString(36);
}

function collectBricks(root) {
  const isDat = (o) => o.isGroup && /\.dat$/i.test(o.userData?.fileName || '');
  const bricks = [];
  root.traverse((o) => {
    if (!isDat(o)) return;
    for (let p = o.parent; p; p = p.parent) if (isDat(p)) return; // skip nested sub-parts
    bricks.push(o);
  });
  return bricks;
}

// Returns an API object ({ view, bricks, maxStep, fingerprint, setView, setHidden,
// unhideLast, showAllHidden, hiddenIndices, onChange, dispose }) and, as a side
// effect, stamps model.bricks / model.maxStep / model.fingerprint with the same
// data — model stays the plain data bag; this is the behaviour that operates on it.
export function initFeatures(model) {
  const root = model.root;
  const bricks = collectBricks(root);

  root.updateMatrixWorld(true); // ensure world matrices are current for bbox maths

  // Explode radially from the rocket's AXIS, not the bbox centre — the splayed
  // landing legs pull the latter ~53 LDU sideways (see axisOfSymmetry in
  // main.js), which would fan one side of every ring further than the other.
  // Vertical fanning still uses the bbox mid-height, which is what "middle of
  // the model, top to bottom" should mean.
  const center = axisOfSymmetry(root);
  center.y = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3()).y;
  const wp = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const bbox = new THREE.Box3();

  let maxStep = 0;
  const entries = bricks.map((group, index) => {
    // Use the brick's geometric centre (world bbox centre), not its group origin.
    // Big parts like the nose cones have their LDraw origin offset from where the
    // geometry actually sits, which would skew the radial explode direction.
    bbox.setFromObject(group).getCenter(wp);
    const step = group.userData.buildingStep | 0;
    maxStep = Math.max(maxStep, step);

    // Explosion direction in world space: radial from the vertical axis, plus a
    // damped vertical component so stacked layers separate too.
    const worldDir = new THREE.Vector3(
      wp.x - center.x,
      (wp.y - center.y) * VERTICAL_BIAS,
      wp.z - center.z
    );
    // Bake into the brick's parent-local frame (parent world-rotation is constant),
    // so the per-frame update is a single copy + addScaledVector.
    group.parent.getWorldQuaternion(q).invert();
    const localDir = worldDir.applyQuaternion(q);

    // Full displacement at 100% = proportional part + a constant push along the
    // same direction (so bricks near the axis, whose localDir is tiny, still move).
    const len = localDir.length();
    if (len > 1e-4) {
      const unit = localDir.clone().divideScalar(len);
      localDir.multiplyScalar(EXPLODE_SCALE).addScaledVector(unit, EXPLODE_BASE);
    }

    // Own index, so hiddenIndices doesn't need an indexOf scan over ~1,181 entries
    // per hidden brick.
    return { group, step, home: group.position.clone(), dir: localDir, hidden: false, index };
  });

  model.bricks = entries;
  model.maxStep = maxStep;
  model.fingerprint = fingerprintOf(entries);

  // ---- view state ------------------------------------------------------------
  // The single source of truth for explode/step. Sliders render from it and
  // write to it via setView() — one notification path, instead of the slider
  // 'input' event and Play-build's programmatic .value set needing separate
  // handling.
  const api = { view: { explode: 0, step: maxStep } };
  const view = api.view;

  function applyExplode(amount) {
    // dir already encodes the displacement at 100%; just scale by the slider.
    // The slider runs to 300%, so `amount` is 0..3 — nothing here caps it, and
    // the console can push it further still.
    for (const e of entries) e.group.position.copy(e.home).addScaledVector(e.dir, amount);
  }
  // ---- visibility ------------------------------------------------------------
  // Two independent things suppress a brick: the build-step scrubber and the
  // per-brick hide. They must not fight, so this is the ONLY writer of
  // group.visible — anything that changes either input goes through render().
  function applyVisibility() {
    for (const e of entries) e.group.visible = e.step <= view.step && !e.hidden;
  }

  // Hidden bricks, most-recent-last, so `U` can walk back out of a peel.
  const hiddenStack = [];

  // ---- UI wiring -----------------------------------------------------------
  const panel = document.getElementById('controls');
  const explodeEl = document.getElementById('explode');
  const explodeVal = document.getElementById('explode-val');
  const stepEl = document.getElementById('step');
  const stepVal = document.getElementById('step-val');
  const playBtn = document.getElementById('play');
  const playIcon = playBtn.querySelector('.btn-icon');
  const playLabel = playBtn.querySelector('.btn-label');
  const showAllBtn = document.getElementById('show-all');
  const showAllLabel = showAllBtn.querySelector('.btn-label');

  stepEl.max = String(maxStep);

  function updateStepLabel(step) {
    // Count what's actually on screen, so hidden bricks don't inflate the total.
    const visible = entries.reduce((n, e) => n + (e.step <= step && !e.hidden ? 1 : 0), 0);
    const suffix = hiddenStack.length ? ` · ${hiddenStack.length} hidden` : '';
    stepVal.textContent = step >= maxStep
      ? `all · ${maxStep}${suffix}`
      : `${step} / ${maxStep} · ${visible} bricks${suffix}`;
  }
  function updateShowAllBtn() {
    const n = hiddenStack.length;
    showAllLabel.textContent = `Show all (${n})`;
    showAllBtn.classList.toggle('gone', n === 0);
  }

  // Reflect `view` (and the hidden set) onto the 3D scene and the DOM. The one
  // place that runs after every change, whatever triggered it.
  function render() {
    applyExplode(view.explode);
    applyVisibility();
    explodeEl.value = String(Math.round(view.explode * 100));
    explodeVal.textContent = `${explodeEl.value}%`;
    stepEl.value = String(view.step);
    updateStepLabel(view.step);
    updateShowAllBtn();
  }

  function setView(patch) {
    Object.assign(view, patch);
    render();
    api.onChange?.();
  }

  function setHidden(brick, flag) {
    if (!brick || !!brick.hidden === !!flag) return;
    brick.hidden = !!flag;
    if (flag) hiddenStack.push(brick);
    else hiddenStack.splice(hiddenStack.indexOf(brick), 1);
    render();
    api.onChange?.();
  }
  function unhideLast() {
    const brick = hiddenStack.pop();
    if (!brick) return;
    brick.hidden = false;
    render();
    api.onChange?.();
  }
  function showAllHidden() {
    if (!hiddenStack.length) return;
    for (const e of hiddenStack) e.hidden = false;
    hiddenStack.length = 0;
    render();
    api.onChange?.();
  }

  render(); // sync sliders/labels to the initial view before anything can change it

  const onExplodeInput = () => setView({ explode: explodeEl.valueAsNumber / 100 });
  const onStepInput = () => { stopPlay(); setView({ step: stepEl.valueAsNumber }); };
  explodeEl.addEventListener('input', onExplodeInput);
  stepEl.addEventListener('input', onStepInput);

  // ---- Play build animation ------------------------------------------------
  let playRAF = null;
  function stopPlay() {
    if (playRAF != null) {
      cancelAnimationFrame(playRAF); playRAF = null;
      playIcon.textContent = '▶'; playLabel.textContent = 'Play build';
    }
  }
  function startPlay() {
    const startStep = view.step >= maxStep ? 0 : view.step;
    const t0 = performance.now();
    playIcon.textContent = '⏸'; playLabel.textContent = 'Pause';
    const tick = (now) => {
      const frac = startStep / maxStep + (now - t0) / (PLAY_SECONDS * 1000);
      const s = Math.min(maxStep, Math.round(frac * maxStep));
      setView({ step: s });
      if (s >= maxStep) { stopPlay(); return; }
      playRAF = requestAnimationFrame(tick);
    };
    playRAF = requestAnimationFrame(tick);
  }
  const onPlayClick = () => (playRAF == null ? startPlay() : stopPlay());
  playBtn.addEventListener('click', onPlayClick);

  // ---- hide / restore ------------------------------------------------------
  showAllBtn.addEventListener('click', showAllHidden);

  // A hidden brick can't be clicked (hotspots.js skips invisible bricks), so
  // un-hiding has to come from here: `U`, or Cmd/Ctrl+Z for the usual reflex.
  bindKey('u', unhideLast, { label: 'U un-hides the last' });
  bindKey('mod+z', unhideLast, { preventDefault: true }); // don't fall through to browser undo

  panel.classList.add('ready');

  api.bricks = entries;
  api.maxStep = maxStep;
  api.fingerprint = model.fingerprint;
  api.setView = setView;
  api.setHidden = setHidden;
  api.unhideLast = unhideLast;
  api.showAllHidden = showAllHidden;
  api.onChange = null; // assigned by main.js
  Object.defineProperty(api, 'hiddenIndices', {
    get: () => hiddenStack.map((b) => b.index),
  });
  api.dispose = () => {
    stopPlay();
    explodeEl.removeEventListener('input', onExplodeInput);
    stepEl.removeEventListener('input', onStepInput);
    playBtn.removeEventListener('click', onPlayClick);
    showAllBtn.removeEventListener('click', showAllHidden);
    // Keymap bindings aren't unregistered — keymap.js has no unbind, and
    // dispose() isn't wired to anything yet (see the composition refactor).
  };

  return api;
}
