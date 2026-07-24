import * as THREE from 'three';

// Click-to-inspect hotspots. Raycasts against the brick meshes, resolves the hit
// back to its brick group (the tagged Object3D carrying the LDraw metadata),
// highlights it, and shows a details panel. Reuses model.bricks from features.js.

const HIGHLIGHT = 0x37c0ff;        // selection colour (emissive glow + box)
const DRAG_THRESHOLD = 5;          // px of pointer travel that counts as an orbit, not a click

export function initHotspots({ THREE: _THREE, scene, camera, renderer, model, libraryPath }) {
  const dom = renderer.domElement;

  // mesh -> brick entry, and a flat list of pickable meshes
  const meshToBrick = new Map();
  for (const b of model.bricks) b.group.traverse((o) => { if (o.isMesh) meshToBrick.set(o, b); });
  const targets = [...meshToBrick.keys()];

  // how many of each part number are in the build (for the "In this build" line)
  const countByPart = new Map();
  for (const b of model.bricks) {
    const k = (b.group.userData.fileName || '').toLowerCase();
    countByPart.set(k, (countByPart.get(k) || 0) + 1);
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // ---- selection + highlight ----------------------------------------------
  let selected = null;
  const savedMats = new Map(); // mesh -> original material (or array)

  // Highlight box, drawn in the brick's OWN local frame and parented to the brick,
  // so it hugs rotated parts and moves/rotates with them (explode, etc.). A plain
  // world-space AABB would jut out sideways for the many parts placed at an angle.
  const boxHelper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(HIGHLIGHT));
  boxHelper.material.depthTest = false;
  boxHelper.renderOrder = 999;

  const _inv = new THREE.Matrix4();
  const _m = new THREE.Matrix4();
  const _corner = new THREE.Vector3();
  // AABB of the brick's meshes expressed in the brick group's local coordinates.
  function computeLocalBox(group, out) {
    group.updateWorldMatrix(true, true);
    _inv.copy(group.matrixWorld).invert();
    out.makeEmpty();
    group.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      _m.multiplyMatrices(_inv, o.matrixWorld);
      const bb = geo.boundingBox;
      for (let i = 0; i < 8; i++) {
        _corner
          .set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
          .applyMatrix4(_m);
        out.expandByPoint(_corner);
      }
    });
    return out;
  }

  const emissiveClone = (m) => {
    const c = m.clone();
    if ('emissive' in c) { c.emissive = new THREE.Color(HIGHLIGHT); c.emissiveIntensity = 0.55; }
    return c;
  };

  function clearHighlight() {
    for (const [mesh, mat] of savedMats) {
      const cur = mesh.material;
      (Array.isArray(cur) ? cur : [cur]).forEach((m) => m.dispose());
      mesh.material = mat;
    }
    savedMats.clear();
    boxHelper.parent?.remove(boxHelper);
    selected = null;
  }

  function highlight(brick) {
    clearHighlight();
    selected = brick;
    brick.group.traverse((o) => {
      if (!o.isMesh) return;
      savedMats.set(o, o.material);
      o.material = Array.isArray(o.material) ? o.material.map(emissiveClone) : emissiveClone(o.material);
    });
    // Oriented highlight box: local-frame AABB parented to the brick.
    computeLocalBox(brick.group, boxHelper.box);
    brick.group.add(boxHelper);
  }

  // ---- info panel ----------------------------------------------------------
  const panel = document.getElementById('inspect');
  const el = (id) => document.getElementById(id);
  const descCache = new Map();

  async function fetchDesc(fileName) {
    if (descCache.has(fileName)) return descCache.get(fileName);
    let desc = '';
    try {
      const text = await fetch(`${libraryPath}parts/${fileName}`).then((r) => (r.ok ? r.text() : ''));
      const line = text.split(/\r?\n/).find((l) =>
        /^0 /.test(l) && !/^0 (Name:|Author:|!|BFC|\/\/|FILE)/i.test(l.trim()));
      desc = line ? line.replace(/^0 ~?/, '').trim() : '';
    } catch { /* description is optional */ }
    descCache.set(fileName, desc);
    return desc;
  }

  function showPanel(brick, hitMesh) {
    const ud = brick.group.userData;
    const fileName = ud.fileName || '';
    const partNo = fileName.replace(/\.dat$/i, '');

    // colour name + swatch from the hit mesh's material
    const mat = Array.isArray(hitMesh.material) ? hitMesh.material[0] : hitMesh.material;
    const colName = mat?.name && mat.name !== 'Material' ? mat.name : `code ${ud.colorCode}`;
    const hex = mat?.color ? `#${mat.color.getHexString()}` : '#888';

    el('ins-title').textContent = partNo;
    el('ins-num').textContent = partNo;
    el('ins-color').innerHTML = `<span class="swatch" style="background:${hex}"></span>${colName}`;
    el('ins-step').textContent = `${brick.step} / ${model.maxStep}`;
    el('ins-count').textContent = `${countByPart.get(fileName.toLowerCase()) || 1}×`;
    el('ins-desc').textContent = '…';
    panel.classList.remove('hidden');

    fetchDesc(fileName).then((d) => { if (selected === brick) el('ins-desc').textContent = d || '—'; });
  }

  function hidePanel() { panel.classList.add('hidden'); }

  function deselect() { clearHighlight(); hidePanel(); }

  // ---- picking -------------------------------------------------------------
  function pick(clientX, clientY) {
    const rect = dom.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      const brick = meshToBrick.get(hit.object);
      // ignore bricks hidden by the build-step scrubber
      if (brick && brick.group.visible) return { brick, mesh: hit.object };
    }
    return null;
  }

  // distinguish a click from an orbit-drag
  let down = null;
  dom.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  dom.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > DRAG_THRESHOLD) return;
    const res = pick(e.clientX, e.clientY);
    if (res) { highlight(res.brick); showPanel(res.brick, res.mesh); }
    else deselect();
  });

  // hover cursor feedback (throttled)
  let lastHover = 0;
  dom.addEventListener('pointermove', (e) => {
    if (down) return;
    const now = performance.now();
    if (now - lastHover < 60) return;
    lastHover = now;
    dom.style.cursor = pick(e.clientX, e.clientY) ? 'pointer' : '';
  });

  el('ins-close').addEventListener('click', deselect);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') deselect(); });

  // expose for console / other features
  model.selectBrick = highlight;
  model.deselect = deselect;
}
