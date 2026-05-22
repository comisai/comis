// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// All `@comis/core` imports from web are system-time helpers (verified by grep).
// Aliasing to the runtime/system-time module avoids pulling in the rest of
// @comis/core, which transitively imports node:crypto via security/oauth/etc.
// and breaks Vite's browser-external shim at module-load time.
const coreSystemTime = fileURLToPath(
  new URL("../core/dist/runtime/system-time.js", import.meta.url),
);

export default defineConfig({
  root: "src",
  base: "/app/",
  resolve: {
    alias: {
      "@comis/core": coreSystemTime,
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:4766",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:4766",
        ws: true,
      },
    },
  },
});
