import { defineConfig } from 'vite';

export default defineConfig({
  // Not a single-page app: disable Vite's index.html fallback so that a missing
  // LDraw part returns a real 404. Otherwise LDrawLoader receives index.html for
  // parts it can't find and chokes on "Unknown line type <!doctype>".
  appType: 'mpa',
  // The LDraw parts library lives in public/ldraw and is served as static assets.
  // It contains tens of thousands of small .dat files, so raise the warning limit
  // and don't try to bundle any of it.
  server: { fs: { strict: false } },
  // main.js uses top-level await (preloading LDraw colour config before parsing
  // the model); the default build target predates top-level-await support.
  // Every browser this app targets (WebGL2-capable) supports es2022.
  build: { chunkSizeWarningLimit: 2000, target: 'es2022' },
});
