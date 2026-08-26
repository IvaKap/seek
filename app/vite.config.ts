/* SPDX-License-Identifier: GPL-3.0-or-later */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Default import, not a named one: esbuild transpiles this config file and
// only exposes the default export of a JSON module. `tsc` accepts either,
// so the named form typechecked cleanly and then failed the build.
import pkg from './package.json' with { type: 'json' };

/* The About screen used to carry its own hand-written copy of the version,
   which is a string that is only ever read when someone is trying to work out
   which build they have — exactly when being stale does the most damage.
   package.json is the source; the bundle and the Rust crate are kept in step
   by `release.sh`, which refuses to build if they drift. */

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    // The fixture lives outside app/, in the repo root, and is imported with
    // `?raw`. Vite must be allowed to read it.
    fs: { allow: ['..', '../..'] },
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'safari15', sourcemap: false },
});
