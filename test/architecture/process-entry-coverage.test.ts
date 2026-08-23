// SPDX-License-Identifier: Apache-2.0
/** Coverage must not count unexported fork-only process entries as in-process source. */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const terminalDriverDir = resolve(
  repoRoot,
  "packages/skills/src/tools/builtin/terminal-driver",
);
const coverageConfig = readFileSync(resolve(repoRoot, "vitest.config.ts"), "utf8");

describe("fork-only process entry coverage", () => {
  it("excludes every unexported terminal process entry from in-process coverage", () => {
    const violations = readdirSync(terminalDriverDir)
      .filter((name) => name.endsWith("-main.ts"))
      .filter((name) => {
        const source = readFileSync(resolve(terminalDriverDir, name), "utf8");
        return source.includes("function isEntryScript()") && !/^export\s/m.test(source);
      })
      .map((name) => `packages/skills/src/tools/builtin/terminal-driver/${name}`)
      .filter((path) => !coverageConfig.includes(`"${path}"`));

    expect(
      violations,
      "Extract importable behavior for unit coverage, or exclude the exact fork-only process entry and exercise its process lifecycle on Linux.",
    ).toEqual([]);
  });
});
