// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the shared CLI version reader.
 *
 * Two behaviours are pinned: the reader resolves the real
 * `packages/cli/package.json` version (proving the relative specifier is
 * correct from the shared module's own location), and it degrades to
 * `undefined` — never throwing — when the package cannot be resolved.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

// Resolve the expected version independently of the module under test, using
// the SAME two-hop specifier from this test file's location (src/util/) that
// the reader uses from its own — so the assertion tracks the real release
// number and doubles as a check that the specifier depth is correct.
const expectedVersion = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

describe("readCliVersion", () => {
  afterEach(() => {
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("returns the CLI package.json version when the package resolves", async () => {
    const { readCliVersion } = await import("./cli-version.js");
    expect(readCliVersion()).toBe(expectedVersion);
    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns undefined without throwing when resolution fails", async () => {
    vi.resetModules();
    vi.doMock("node:module", () => ({
      createRequire: () => () => {
        throw new Error("cannot resolve package.json");
      },
    }));
    const { readCliVersion } = await import("./cli-version.js");
    expect(readCliVersion()).toBeUndefined();
  });
});
