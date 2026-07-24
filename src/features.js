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

    return { group, step, home: group.position.clone(), dir: localDir };
  });

  model.bricks = entries;
  model.maxStep = maxStep;

  function setExplode(amount) {
    // e.dir already encodes the full 100% displacement; just scale by the slider.
    for (const e of entries) e.group.position.copy(e.home).addScaledVector(e.dir, amount);
  }
  function setStep(step) {
    for (const e of entries) e.group.visible = e.step <= step;
  }

  // ---- UI wiring -----------------------------------------------------------
  const panel = document.getElementById('controls');
  const explodeEl = document.getElementById('explode');
  const explodeVal = document.getElementById('explode-val');
  const stepEl = document.getElementById('step');
  const stepVal = document.getElementById('step-val');
  const playBtn = document.getElementById('play');

  stepEl.max = String(maxStep);
  stepEl.value = String(maxStep);

  function updateStepLabel(step) {
    const visible = entries.reduce((n, e) => n + (e.step <= step ? 1 : 0), 0);
    stepVal.textContent = step >= maxStep ? `all · ${maxStep}` : `${step} / ${maxStep} · ${visible} bricks`;
  }
  updateStepLabel(maxStep);

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

  panel.classList.add('ready');

  // Expose for the console / future features.
  model.setExplode = setExplode;
  model.setStep = setStep;
}
