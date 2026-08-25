// SPDX-License-Identifier: Apache-2.0
/** Coverage must not count unexported fork-only process entries as in-process source. */

import { describe, expect, it } from "vitest";
import rootVitestConfig from "../../vitest.config.js";
import { TERMINAL_PROCESS_ENTRIES } from "../../packages/skills/src/tools/builtin/terminal-driver/terminal-process-entry-registry.js";

interface RootVitestConfig {
  readonly test?: { readonly coverage?: { readonly exclude?: readonly string[] } };
}

describe("fork-only process entry coverage", () => {
  it("excludes every unexported terminal process entry from in-process coverage", () => {
    const exclusions = (rootVitestConfig as RootVitestConfig).test?.coverage?.exclude ?? [];
    const violations = Object.values(TERMINAL_PROCESS_ENTRIES)
      .map((entry) => entry.sourcePath)
      .filter((path) => !exclusions.includes(path));

    expect(
      violations,
      "Extract importable behavior for unit coverage, or exclude the exact fork-only process entry and exercise its process lifecycle on Linux.",
    ).toEqual([]);
  });
});
