import * as THREE from 'three';

// Shared model-geometry maths. Lives in its own module so both main.js (camera
// framing) and features.js (explode directions) can use it without an import
// cycle — main.js already imports features.js.

// Horizontal position of the rocket's axis of symmetry, as the mean of the
// bricks' own centres.
//
// The bounding-box centre is NOT usable for this: the three landing legs splay
// out asymmetrically, and because a bbox is defined purely by its extremes, the
// two leg tips drag its horizontal centre ~53 LDU off the rocket's real axis —
// well over half the body radius (~88 LDU). Orbiting about that makes the rocket
// visibly swing around a pivot outside itself, and explodes fan one side of
// every ring further than the other. A mean over ~1,200 bricks is dominated by
// the symmetric body rather than the few outlying legs, and lands within
// ~1.3 LDU of the true axis.
export function axisOfSymmetry(object) {
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  const sum = new THREE.Vector3();
  let n = 0;
  object.traverse((o) => {
    if (!o.isMesh) return;
    box.setFromObject(o).getCenter(c);
    sum.add(c);
    n++;
  });
  return n ? sum.divideScalar(n) : new THREE.Vector3();
}
