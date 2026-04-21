// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://comis.ai",

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [sitemap()],
});