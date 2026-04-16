import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  base: "/app/",
  plugins: [tailwindcss()],
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
