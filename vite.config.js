import { defineConfig } from 'vite';

export default defineConfig({
  // Not a single-page app: disable Vite's index.html fallback so that a missing
  // public/model/*.glb (or any other static asset) returns a real 404 instead
  // of silently serving index.html in its place.
  appType: 'mpa',
  build: { chunkSizeWarningLimit: 2000 },
});
