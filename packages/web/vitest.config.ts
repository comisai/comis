// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
    // Neutralizes happy-dom's crash-prone navigation on <a download> clicks.
    // See vitest-setup.ts for the full rationale.
    setupFiles: ["./vitest-setup.ts"],
  },
});
