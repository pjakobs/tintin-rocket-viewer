// Pre-bakes the LDraw model (public/model/tintin-rocket.ldr + ldraw-min/) into a
// single public/model/tintin-rocket.glb, so the browser never has to parse raw
// LDraw text or recompute smoothed vertex normals at runtime — both of which are
// cheap on a desktop but can take 30-40+ seconds of main-thread CPU time on a
// mid/low-end phone. Loading the baked glTF instead is close to instant: it's
// just binary buffers to deserialize, no per-part parsing or geometry math.
//
// Runs the *same* LDrawLoader pipeline main.js used to run in the browser, but
// here in plain Node — LDrawLoader only builds THREE.BufferGeometry/Mesh
// objects (plain math), it never touches the DOM or a WebGL context, so no
// headless-browser dependency is needed. The one thing it does need is
// `fetch()` for its internal parts-library requests; a scheme-based shim below
// redirects those onto ldraw-min/ on disk instead of a real network call.
//
//   node scripts/bake-model.mjs
//
// Re-run this whenever public/model/tintin-rocket.ldr or ldraw-min/ changes.

import * as THREE from 'three';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/examples/jsm/materials/LDrawConditionalLineMaterial.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = path.join(root, 'ldraw-min');
const MODEL_LDR = path.join(root, 'public/model/tintin-rocket.ldr');
const OUT_GLB = path.join(root, 'public/model/tintin-rocket.glb');
const OUT_DESC = path.join(root, 'public/model/part-descriptions.json');

// three's FileLoader streams the response body to report progress, which needs
// the browser-only ProgressEvent constructor. Node doesn't have one; a minimal
// stand-in is enough since nothing here reads progress events.
if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.lengthComputable = !!init.lengthComputable;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  };
}

// GLTFExporter's binary path reads the assembled Blob via the browser-only
// FileReader API. Node's Blob already exposes arrayBuffer() directly, so this
// stand-in only needs to support the one call GLTFExporter makes.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
  };
}

// LDrawLoader has no "read from disk" mode, only fetch() — so give it a fake
// scheme that resolves against ldraw-min/ on disk instead of the network.
const SCHEME = 'ldraw-min://';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith(SCHEME)) return realFetch(input);
  const rel = decodeURIComponent(url.slice(SCHEME.length));
  try {
    const text = fs.readFileSync(path.join(LIB_DIR, rel), 'utf8');
    return new Response(text, { status: 200 });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};

const loader = new LDrawLoader();
loader.smoothNormals = true;
loader.setPartsLibraryPath(SCHEME);
loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);

await loader.preloadMaterials(`${SCHEME}LDConfig.ldr`);

const modelText = fs.readFileSync(MODEL_LDR, 'utf8');
const group = await new Promise((resolve, reject) => {
  loader.parse(modelText, resolve, reject);
});

let meshCount = 0;
group.traverse((o) => { if (o.isMesh) meshCount++; });
console.log(`Parsed ${meshCount} meshes.`);

// Same fixup main.js used to apply at runtime: this three.js build leaves
// non-conditional edge LineSegments with a null material, which crashes the
// renderer when it reads material.visible.
const EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.35 });
group.traverse((child) => {
  if ((child.isLine || child.isLineSegments) && child.material == null) {
    child.material = EDGE_MATERIAL;
  }
});

// GLTFExporter can't serialize ShaderMaterial (GLTFExporter: "THREE.ShaderMaterial
// not supported") and LDrawConditionalLineMaterial is one, so conditional lines
// (the view-dependent silhouette curves on rounded parts) would otherwise export
// with a meaningless fallback material. Strip them rather than ship broken/noisy
// geometry — the model's regular hard-edge lines (LineBasicMaterial, exports fine)
// still define every part's boundaries.
let strippedConditional = 0;
group.traverse((child) => {
  if (child.isConditionalLine) {
    child.parent.remove(child);
    strippedConditional++;
  }
});
console.log(`Stripped ${strippedConditional} conditional-line segments (not exportable to glTF).`);

// Per-part description strings, extracted once here instead of hotspots.js
// fetching each clicked part's raw .dat file at runtime from a library that
// (after this change) is no longer even shipped to the browser.
const descriptions = {};
function descriptionOf(fileName) {
  try {
    const text = fs.readFileSync(path.join(LIB_DIR, 'parts', fileName), 'utf8');
    const line = text.split(/\r?\n/).find((l) =>
      /^0 /.test(l) && !/^0 (Name:|Author:|!|BFC|\/\/|FILE)/i.test(l.trim()));
    return line ? line.replace(/^0 ~?/, '').trim() : '';
  } catch {
    return '';
  }
}
group.traverse((o) => {
  const fileName = o.userData?.fileName;
  if (!fileName || !/\.dat$/i.test(fileName)) return;
  const key = fileName.toLowerCase();
  if (!(key in descriptions)) descriptions[key] = descriptionOf(fileName);
});
fs.writeFileSync(OUT_DESC, JSON.stringify(descriptions));
console.log(`Wrote ${OUT_DESC} (${Object.keys(descriptions).length} parts).`);

const exporter = new GLTFExporter();
const glb = await exporter.parseAsync(group, { binary: true });
fs.writeFileSync(OUT_GLB, Buffer.from(glb));
console.log(`Wrote ${OUT_GLB} (${(fs.statSync(OUT_GLB).size / 1e6).toFixed(2)} MB).`);
