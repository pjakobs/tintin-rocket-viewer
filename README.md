# Tintin Moon Rocket — 3D Digital Twin

A Three.js web viewer for the LEGO **21367 Tintin Moon Rocket** (1,255 bricks),
rendered directly from an LDraw model exported by BrickLink Studio. Orbit / zoom /
pan controls, built to be extended with clickable part hotspots and a build-progress
animation.

![viewer](docs/screenshot.png)

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173  (or the port Vite prints)
```

The repo ships with a **slim LDraw parts library** (`public/ldraw-min/`, ~2.7 MB)
containing only the ~535 parts and primitives this model actually uses, so it
works out of the box. See [Parts library](#parts-library) to regenerate or use
the full library.

## What's here

```
public/
  model/
    tintin-rocket.ldr          # the model (copied from references/, MPD w/ 37 submodels)
    rebrickable_parts.csv      # manual-derived parts list, for the sanity check
  ldraw-min/                   # slim LDraw library (parts/, p/, LDConfig.ldr)
src/
  main.js                      # scene, loader, controls, framing, HUD
  crosscheck.js                # LDR↔CSV part-count reconciliation
scripts/
  prune-library.mjs            # build the slim library from the full one
references/                    # original source files (untouched)
```

## The investigation: LDrawLoader vs. a Blender pipeline

The task was to first find out whether Three.js's built-in **`LDrawLoader`** can
load this `.ldr` directly and render it well, and only fall back to a
Blender → glTF conversion if it hit real limitations.

**Verdict: `LDrawLoader` handles it cleanly. No Blender needed.** It's also the
*better* choice for this project, not just the simpler one — see below.

### Coverage (the main risk)

`LDrawLoader` doesn't ship the LEGO parts library; you supply it. Studio models
can also reference parts that aren't in the official library. I expanded the MPD
(37 submodels, resolved recursively) to **133 unique parts** and checked each
against the downloaded library:

| Source | Result |
| --- | --- |
| Official LDraw library | 129 / 133 parts |
| + LDraw *unofficial* library (adds `7547`, `7217`) | 131 / 133 |
| BrickLink Studio custom parts | `bl_8097` (×2, nose cone), `bl_98138pb459` (×1, printed tile) |

The 2 `bl_*` parts are Studio-proprietary and aren't in any LDraw library.
Studio embeds their real geometry in the `.io` export (`model2.ldr`), so
`scripts/extract-custom-parts.mjs` pulls it out into
`public/ldraw*/parts/bl_*.dat`. Net result: **0 missing parts.**

> ⚠️ **BrickLink numbers collide with LDraw numbers.** Don't alias `bl_8097` to
> LDraw's `8097.dat`: LDraw `8097` is a "Panel Cone 4×8×8", but BrickLink 8097 is
> a different shape ("Cone Half 4×8×8") with a different local origin. Aliasing to
> the LDraw part renders the two nose cones **splayed outward like ears**. The
> extract script uses Studio's own geometry, which the model's transforms place
> correctly.

### Performance

~1,255 bricks → 1,319 meshes, ~703k triangles, ~3,900 draw calls. Renders at
60 fps as separate per-part meshes on a normal desktop GPU. No merging needed
(and merging would be counterproductive here — see next section).

### Why this beats a Blender bake for *this* project

A Blender LDraw-import → glTF export would bake everything into a handful of
material-batched meshes. That throws away exactly what the planned features need:

- **Per-part identity** — every brick stays its own `Object3D` with its LDraw
  part number in `userData.fileName`, so hotspots are just a raycast away.
- **Build steps** — the loader parses the `0 STEP` metas: `root.userData.numBuildingSteps`
  is **360**, and each part group carries `userData.buildingStep` /
  `startingBuildingStep`. That's a ready-made timeline for a build animation.

A Blender bake would be the right call if the model were dominated by
Studio-custom parts (it isn't) or if you wanted photoreal baked AO/materials and
didn't care about part identity. For an interactive, part-addressable twin,
`LDrawLoader` wins.

### Gotchas found while wiring it up (three r0.171)

Four non-obvious issues, all fixed in `src/main.js` — worth knowing if you bump
the Three.js version:

1. **Conditional lines need an explicit material.** `loader.setConditionalLineMaterial(LDrawConditionalLineMaterial)`
   is mandatory now, or parsing throws.
2. **`load()` wipes preloaded colours.** `preloadMaterials()` + `load()` renders
   everything **magenta**, because `load()` calls `setMaterials([])` internally.
   Fix: `preloadMaterials()`, then `fetch()` the model text and call
   **`loader.parse()`** (which keeps the colours).
3. **Edge lines come back with a null material** and crash the renderer at
   `material.visible`. Fix: assign a shared `LineBasicMaterial` to any
   material-less line after load.
4. **Serve missing parts as real 404s.** Vite's SPA fallback returns `index.html`
   for a missing `.dat`, which the loader tries to parse (`Unknown line type
   <!doctype>`). Fix: `appType: 'mpa'` in `vite.config.js`.

## Sanity check: model vs. CSV

On load the viewer reconciles the rendered model against the manual-derived CSV
(`src/crosscheck.js`, also logged to the console). Result:

- **LDR model: 1,255 bricks** (matches the file's own `NumOfBricks 1255`), 133 unique parts
- **CSV: 1,283 non-spare bricks**, 148 unique parts
- **120 part numbers match exactly**, with identical quantities

The **+28** difference is not an error — it's cataloguing differences:

- **ID scheme:** LDraw vs. BrickLink/Rebrickable numbers for the same part —
  e.g. `3023b`↔`3023` (×105, plate 1×2), `2780`↔`61332` (×17, pin),
  `32064c`↔`32064a` (×12), `48729b`↔`3484` (×6). Same part, same count.
- **Minifig sub-parts & prints:** the manual lists minifigure torsos/legs/heads
  and printed decorations as separate line items (`970c34pr0007`,
  `973c34h34pr0002`, the `28621pr00xx` head prints, …) that the LDraw model
  represents differently or as assemblies. This accounts for the bulk of the gap.

## Parts library

`public/ldraw-min/` is generated, not authored. To rebuild or use the full library:

```bash
# 1. Download the official (and optionally unofficial) LDraw library:
#    https://library.ldraw.org/library/updates/complete.zip      (~142 MB)
#    https://library.ldraw.org/library/unofficial/ldrawunf.zip    (~90 MB, adds 7547/7217)
#    Extract/merge so you have public/ldraw/{parts,p,LDConfig.ldr,...}

# 2. Add the Studio custom parts (bl_8097 nose cone, bl_98138pb459 tile):
node scripts/extract-custom-parts.mjs     # pulls geometry from the .io export

# 3. Slim it to just this model's parts (~535 files, ~2.7 MB):
node scripts/prune-library.mjs --apply    # writes public/ldraw-min/
```

To render against the full library instead, set `LIBRARY_PATH = '/ldraw/'` in
`src/main.js`.

> Note: `npm run build` copies everything in `public/` into `dist/`. With the slim
> library that's fine; with the full ~820 MB library, prune first or serve the
> library separately.

## Interactive features (`src/features.js`)

The bottom control bar drives two features off the per-part LDraw metadata:

- **Exploded view** — the *Explode* slider slides every brick radially away from
  the rocket's axis (0–100%). Each of the 1,255 brick groups gets a pre-computed
  local displacement vector, so the update is one `copy + addScaledVector` per
  brick.
- **Build scrubber + Play** — the *Build step* slider reveals bricks up to a given
  LDraw build step (there are **360**, in `userData.buildingStep`); *Play build*
  animates it 0 → end. Mid-build you can see the internal bracing, just like the
  instruction manual.

Both work on **brick groups** — the outermost `Object3D` whose
`userData.fileName` is a `.dat` part (nested sub-parts move/hide with their
brick). `initFeatures()` collects exactly 1,255 of them and stores
`model.bricks = [{ group, step, home, dir }]`, plus `model.setExplode(0..1)` and
`model.setStep(n)` for the console.

- **Click-to-inspect hotspots** (`src/hotspots.js`) — click any brick to select it.
  A raycast against the brick meshes resolves the hit back to its brick group; the
  part glows (cloned emissive material) inside a highlight box, and a panel shows
  the part number, human-readable description (lazy-fetched from the `.dat`), colour
  swatch + name, build step, and how many of that part the build uses. Respects the
  scrubber (step-hidden bricks aren't pickable) and works in the exploded state.
  Pointer-drag is distinguished from a click so orbiting never selects. `Esc` /
  click-empty deselects.

## Extending it further

`window.viewer` exposes `{ THREE, scene, camera, renderer, controls, model }`, and
`model` now also carries `selectBrick(brick)` / `deselect()`.

- **Isolate / colour-by:** `model.bricks` groups every brick with its step —
  tint by `step` for a build-order heatmap, or filter by `group.userData.fileName`
  / `colorCode` to isolate a part type or colour.
- **Inventory linking:** join the selected part number to `src/crosscheck.js`'s CSV
  data to show set-level quantities / spares alongside the in-build count.
