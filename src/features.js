import * as THREE from 'three';

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

export function initFeatures(model) {
  const root = model.root;
  const bricks = collectBricks(root);

  root.updateMatrixWorld(true); // ensure world matrices are current for bbox maths
  const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  const wp = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const bbox = new THREE.Box3();

  let maxStep = 0;
  const entries = bricks.map((group) => {
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

    return { group, step, home: group.position.clone(), dir: localDir, hidden: false };
  });

  model.bricks = entries;
  model.maxStep = maxStep;

  function setExplode(amount) {
    // e.dir already encodes the displacement at 100%; just scale by the slider.
    // The slider runs to 300%, so `amount` is 0..3 — nothing here caps it, and
    // the console can push it further still.
    for (const e of entries) e.group.position.copy(e.home).addScaledVector(e.dir, amount);
  }
  // ---- visibility ----------------------------------------------------------
  // Two independent things suppress a brick: the build-step scrubber and the
  // per-brick hide. They must not fight, so this is the ONLY writer of
  // group.visible — anything that changes either input calls it.
  let currentStep = maxStep;
  function applyVisibility() {
    for (const e of entries) e.group.visible = e.step <= currentStep && !e.hidden;
  }
  function setStep(step) {
    currentStep = step;
    applyVisibility();
  }

  // Hidden bricks, most-recent-last, so `U` can walk back out of a peel.
  const hiddenStack = [];

  function setHidden(brick, flag) {
    if (!brick || !!brick.hidden === !!flag) return;
    brick.hidden = !!flag;
    if (flag) hiddenStack.push(brick);
    else hiddenStack.splice(hiddenStack.indexOf(brick), 1);
    afterHiddenChange();
  }
  function unhideLast() {
    const brick = hiddenStack.pop();
    if (!brick) return;
    brick.hidden = false;
    afterHiddenChange();
  }
  function showAllHidden() {
    if (!hiddenStack.length) return;
    for (const e of hiddenStack) e.hidden = false;
    hiddenStack.length = 0;
    afterHiddenChange();
  }
  function afterHiddenChange() {
    applyVisibility();
    updateStepLabel(currentStep);
    updateShowAllBtn();
    model.onFeatureChange?.(); // persist to the URL hash
  }

  // ---- UI wiring -----------------------------------------------------------
  const panel = document.getElementById('controls');
  const explodeEl = document.getElementById('explode');
  const explodeVal = document.getElementById('explode-val');
  const stepEl = document.getElementById('step');
  const stepVal = document.getElementById('step-val');
  const playBtn = document.getElementById('play');
  const showAllBtn = document.getElementById('show-all');

  stepEl.max = String(maxStep);
  stepEl.value = String(maxStep);

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
    showAllBtn.textContent = `↺ Show all (${n})`;
    showAllBtn.classList.toggle('gone', n === 0);
  }
  updateStepLabel(maxStep);
  updateShowAllBtn();

  explodeEl.addEventListener('input', () => {
    const a = explodeEl.valueAsNumber / 100;
    explodeVal.textContent = `${explodeEl.valueAsNumber}%`;
    setExplode(a);
  });

  stepEl.addEventListener('input', () => {
    stopPlay();
    const s = stepEl.valueAsNumber;
    setStep(s);
    updateStepLabel(s);
  });

  // ---- Play build animation ------------------------------------------------
  let playRAF = null;
  function stopPlay() {
    if (playRAF != null) { cancelAnimationFrame(playRAF); playRAF = null; playBtn.textContent = '▶ Play build'; }
  }
  function startPlay() {
    const startStep = stepEl.valueAsNumber >= maxStep ? 0 : stepEl.valueAsNumber;
    const t0 = performance.now();
    playBtn.textContent = '⏸ Pause';
    const tick = (now) => {
      const frac = startStep / maxStep + (now - t0) / (PLAY_SECONDS * 1000);
      const s = Math.min(maxStep, Math.round(frac * maxStep));
      stepEl.value = String(s);
      setStep(s);
      updateStepLabel(s);
      model.onFeatureChange?.(); // let state.js debounce-persist the step as it plays
      if (s >= maxStep) { stopPlay(); return; }
      playRAF = requestAnimationFrame(tick);
    };
    playRAF = requestAnimationFrame(tick);
  }
  playBtn.addEventListener('click', () => (playRAF == null ? startPlay() : stopPlay()));

  // ---- hide / restore ------------------------------------------------------
  showAllBtn.addEventListener('click', showAllHidden);

  // A hidden brick can't be clicked (hotspots.js skips invisible bricks), so
  // un-hiding has to come from here: `U`, or Cmd/Ctrl+Z for the usual reflex.
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return; // don't steal slider keys
    const undoChord = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z';
    if (!undoChord && (e.key.toLowerCase() !== 'u' || e.metaKey || e.ctrlKey || e.altKey)) return;
    if (undoChord) e.preventDefault(); // don't fall through to browser undo
    unhideLast();
  });

  panel.classList.add('ready');

  // Expose for the console / other modules (hotspots.js hides the selected
  // brick; state.js serialises the hidden set into the URL).
  model.setExplode = setExplode;
  model.setStep = setStep;
  model.setHidden = setHidden;
  model.unhideLast = unhideLast;
  model.showAllHidden = showAllHidden;
  Object.defineProperty(model, 'hiddenIndices', {
    get: () => hiddenStack.map((b) => entries.indexOf(b)),
  });
}
