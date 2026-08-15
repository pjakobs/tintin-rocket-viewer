import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { inject } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { crossCheck } from './crosscheck.js';
import { initFeatures } from './features.js';
import { initHotspots } from './hotspots.js';
import { initStateSync } from './state.js';
import { axisOfSymmetry } from './geometry.js';
import { bindKey, keyHints } from './keymap.js';
import { initPanels } from './panels.js';

// Initialize Vercel Web Analytics
inject();

// Initialize Vercel Speed Insights
injectSpeedInsights();

initPanels();

// Pre-baked by scripts/bake-model.mjs from public/model/tintin-rocket.ldr +
// ldraw-min/ — parsing raw LDraw and recomputing smoothed vertex normals in the
// browser is cheap on desktop but can take 30-40+ seconds of CPU on a phone, so
// that work happens once at build time instead. Re-run the bake script after
// editing the source .ldr model.
const MODEL_URL = '/model/tintin-rocket.glb';
// Kept only for the cross-check sanity panel below, which wants the raw LDraw
// text to reconcile against the manual's parts CSV — unrelated to rendering.
const MODEL_LDR_URL = '/model/tintin-rocket.ldr';
// Per-part description strings for the click-to-inspect panel (hotspots.js),
// extracted from the LDraw library at bake time so the browser never needs the
// library itself — see scripts/bake-model.mjs.
const DESCRIPTIONS_URL = '/model/part-descriptions.json';

// ---------------------------------------------------------------------------
// Scene / renderer
// ---------------------------------------------------------------------------
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 100000);
camera.position.set(400, 320, 520);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 40;
controls.maxDistance = 4000;   // provisional; frameModel() refits it to the model

// The pivot frameModel() parks the model on: the rocket's axis at its mid-height.
// frameModel() moves the model onto this point, so it is simply the origin.
// Declared here rather than beside frameModel() so it is initialised before the
// top-level loader.parse() below, which can call frameModel() via its callback.
const HOME_TARGET = new THREE.Vector3(0, 0, 0);

// Lighting — a soft studio setup so bricks read clearly from any angle.
scene.add(new THREE.HemisphereLight(0xffffff, 0x333844, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(1, 1.4, 0.8);
scene.add(key);
const fill = new THREE.DirectionalLight(0xbcd4ff, 0.8);
fill.position.set(-1, 0.3, -0.7);
scene.add(fill);

// ---------------------------------------------------------------------------
// Model state — plain data, populated here and by initFeatures(). Behaviour
// (explode/step/selection/hide) lives on the objects features.js and
// hotspots.js return, not on this object.
// ---------------------------------------------------------------------------
export const model = {
  root: null,        // THREE.Group of the whole build
  bricks: null,      // set by initFeatures(): [{ group, step, home, dir, hidden, index }]
  maxStep: 0,        // set by initFeatures(): highest LDraw build step
  fingerprint: null, // set by initFeatures(): order-sensitive hash of the brick list
};

let meshCount = 0; // placed meshes, for the HUD's "Meshes drawn" row

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const loadingEl = document.getElementById('loading');

function failLoad(err, msg) {
  console.error(err);
  loadingEl.classList.add('error');
  document.getElementById('load-msg').textContent = msg;
  document.getElementById('load-detail').textContent = String(err?.message ?? err);
  statusEl.textContent = 'Load failed';
}

const gltfLoader = new GLTFLoader();

statusEl.textContent = 'Loading model…';
progressEl.style.width = '30%';

// Deliberately not awaited: the rest of this module (recentre/bindKey('r', ...),
// the render loop, the resize listener) is declared further down the file and
// needs to run before onModelLoaded() does, since onModelLoaded() reads those
// bindings back out via keyHints(). A top-level await here would stall the
// whole module until the model loads, running onModelLoaded() — and that
// keyHints() call — before any of that later code ever registers.
Promise.all([
  gltfLoader.loadAsync(MODEL_URL, (evt) => {
    if (evt.lengthComputable) progressEl.style.width = `${30 + (evt.loaded / evt.total) * 60}%`;
  }),
  fetch(DESCRIPTIONS_URL).then((r) => (r.ok ? r.json() : {})),
]).then(
  ([gltf, descriptions]) => onModelLoaded(gltf.scene, descriptions),
  (err) => failLoad(err, `Couldn't load the model from ${MODEL_URL}.`)
);

function onModelLoaded(group, descriptions) {
  // LDraw is -Y up; rotate 180° about X so the rocket stands upright.
  group.rotation.x = Math.PI;

  // NB: the bake script (scripts/bake-model.mjs) deliberately does NOT call
  // LDrawUtils.mergeObject() before exporting. Merging would collapse all
  // bricks into a few material-batched buffers, destroying the per-part
  // hierarchy the clickable hotspots and build-progress animation depend on.
  // ~1,250 separate meshes render comfortably at 60fps.

  group.traverse((child) => { if (child.isMesh) meshCount++; });

  model.root = group;
  scene.add(group);

  frameModel(group);
  updateHUD();
  const features = initFeatures(model);
  const hotspots = initHotspots({ camera, renderer, features, descriptions });
  const state = initStateSync({ camera, controls, features, hotspots });
  features.onChange = state.scheduleWrite;
  hotspots.onChange = state.scheduleWrite;
  state.restore();

  // Reset also clears the current selection, so the inspect panel doesn't linger
  // pointed at a brick that's no longer part of an intentional view.
  document.getElementById('reset-view').addEventListener('click', () => hotspots.deselect());

  // Refresh the two hint strings from the keymap now that features.js and
  // hotspots.js have registered their bindings, so the shortcuts shown can't
  // drift from what's actually bound.
  const hints = keyHints();
  document.getElementById('hud-hint').textContent =
    `Drag to orbit · scroll to zoom · right-drag to pan · ${hints.r}`;
  document.getElementById('ins-hint').textContent =
    `Click a brick to inspect · ${hints.escape} · ${hints.u}`;

  statusEl.textContent = 'Ready';
  loadingEl.classList.add('hidden');

  // Sanity check: reconcile the baked model's brick count with the manual CSV.
  // Fetched separately (and only) here — this is the one place that still
  // wants the raw LDraw text, not the baked glTF.
  fetch(MODEL_LDR_URL).then((r) => r.text()).then((modelText) => crossCheck(modelText)).then((r) => {
    model.crossCheck = r;
    document.getElementById('stat-bricks').textContent = r.ldrBricks.toLocaleString();
    if (r.csvBricks != null) {
      document.getElementById('stat-csv').textContent = r.csvBricks.toLocaleString();
      const delta = r.csvBricks - r.ldrBricks;
      document.getElementById('stat-note').textContent =
        `${r.matchedParts} part IDs matched · Δ${delta > 0 ? '+' : ''}${delta} (minifig sub-parts & print variants the manual lists separately)`;
    } else {
      document.getElementById('stat-csv').textContent = 'n/a';
    }
  });
}

// Center the model at the origin and fit the camera to its bounding sphere.
function frameModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const axis = axisOfSymmetry(object);

  // Sit the model's axis on the world Y axis, and its mid-height at y=0, so the
  // orbit target below is a pivot that runs straight up through the rocket.
  object.position.sub(new THREE.Vector3(axis.x, center.y, axis.z));

  // Enclosing radius about the new origin. Measured from the re-centred box
  // rather than from size.length()/2, because shifting to the axis (not the bbox
  // centre) leaves the box slightly lopsided — the legs now reach further on one
  // side, and framing has to cover that longer reach.
  object.updateMatrixWorld(true);
  const shifted = new THREE.Box3().setFromObject(object);
  const radius = Math.max(shifted.max.length(), shifted.min.length());

  const dist = radius / Math.sin((camera.fov * Math.PI) / 180 / 2);
  camera.position.set(dist * 0.6, dist * 0.45, dist * 0.75);
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();

  // Leave room to pull back far enough to frame the *exploded* model, not just the
  // assembled one — at the Explode slider's 300% each brick travels several times
  // its distance from the centre, so the assembled fit distance is nowhere near enough.
  controls.maxDistance = dist * 6;
  controls.target.copy(HOME_TARGET);
  controls.update();
}

// Undo panning.
//
// Right-drag pan slides the camera and the orbit target together, so afterwards
// OrbitControls pivots about wherever the target landed — off the rocket's axis
// by however far you panned, which reads as the model swinging around a point
// outside itself. state.js persists the target in the URL hash, so a stray pan
// also survives a reload and looks permanent.
//
// Moving both back by the same delta exactly reverses that: the rocket returns
// to the centre of the view and the pivot returns to its axis, while the current
// zoom and orbit angle are left untouched.
function recentre() {
  const delta = controls.target.clone().sub(HOME_TARGET);
  if (delta.lengthSq() === 0) return;
  camera.position.sub(delta);
  controls.target.copy(HOME_TARGET);
  controls.update(); // fires 'change', so state.js persists the corrected target
}

document.getElementById('recentre').addEventListener('click', recentre);
bindKey('r', recentre, { label: 'R to recentre' });

function updateHUD() {
  document.getElementById('stat-parts').textContent = meshCount.toLocaleString();
  // A successfully-loaded baked model (see scripts/bake-model.mjs) is
  // self-contained — there's no per-part fetch left at runtime that could fail.
  document.getElementById('stat-missing').textContent = '0';
}

// Expose viewer internals for the browser console and future feature scripts.
window.viewer = { THREE, scene, camera, renderer, controls, model };

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
