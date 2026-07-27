import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import { axisOfSymmetry } from './geometry.js';

// A minimal stand-in for an LDraw brick group: a single mesh with a box
// geometry, positioned so axisOfSymmetry can find its world-space centre.
function meshAt(x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.position.set(x, y, z);
  return mesh;
}

describe('axisOfSymmetry', () => {
  it('stays near a symmetric cluster even with one far outlier, unlike the bbox centre', () => {
    const root = new THREE.Group();
    // A ring of meshes symmetric about the origin (mirrors the rocket body).
    for (const [x, z] of [[10, 0], [-10, 0], [0, 10], [0, -10]]) {
      root.add(meshAt(x, 0, z));
    }
    // One outlier far to one side (mirrors a splayed landing leg).
    root.add(meshAt(200, 0, 0));
    root.updateMatrixWorld(true);

    const axis = axisOfSymmetry(root);

    const bbox = new THREE.Box3().setFromObject(root);
    const bboxCenter = bbox.getCenter(new THREE.Vector3());

    // The bbox centre is dragged well off-origin by the outlier...
    expect(bboxCenter.x).toBeGreaterThan(50);
    // ...but the mean-of-centres axis stays close to the symmetric cluster.
    expect(Math.abs(axis.x)).toBeLessThan(50);
  });

  it('returns the origin for an object with no meshes', () => {
    const root = new THREE.Group();
    root.updateMatrixWorld(true);
    const axis = axisOfSymmetry(root);
    expect(axis.x).toBe(0);
    expect(axis.y).toBe(0);
    expect(axis.z).toBe(0);
  });
});
