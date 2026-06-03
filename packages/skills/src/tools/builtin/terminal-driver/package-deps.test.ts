// SPDX-License-Identifier: Apache-2.0
/**
 * Supply-chain assertion for the terminal-driver native-dep install posture (TR-08).
 *
 * Reads `packages/skills/package.json` and asserts:
 *   - `node-pty` is an OPTIONAL dependency (so `npm install -g comisai` on a
 *     no-prebuild / no-toolchain host degrades to the pipe backend rather than
 *     FAILING the install — spec §2.2 / TR-08), exact-pinned `1.1.0`;
 *   - `@xterm/headless` + `@xterm/addon-serialize` are regular dependencies
 *     (the worker owns the emulator; P0 declares them so the dep graph is
 *     stable, even though rendering is P2/121), exact-pinned;
 *   - none of the three carries a caret/tilde (the supply-chain exact-pin
 *     invariant — CLAUDE.md §Releases).
 *
 * The BEHAVIOR this install posture enables (pipe fallback on a missing
 * node-pty) is proven by Task 1's injected-thrower RED test; this is the
 * config-shape assertion.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// terminal-driver → builtin → tools → src → packages/skills
const pkgPath = join(here, "..", "..", "..", "..", "package.json");

interface PkgJson {
  optionalDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPkg(): PkgJson {
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PkgJson;
}

describe("terminal-driver supply-chain (TR-08 install posture)", () => {
  it("declares node-pty 1.1.0 as an OPTIONAL dependency (not a hard dependency)", () => {
    const pkg = readPkg();
    expect(pkg.optionalDependencies?.["node-pty"]).toBe("1.1.0");
    // It must NOT be a hard dependency — that would fail install on a
    // no-prebuild host instead of degrading to the pipe backend.
    expect(pkg.dependencies?.["node-pty"]).toBeUndefined();
  });

  it("declares @xterm/headless 6.0.0 + @xterm/addon-serialize 0.14.0 as dependencies", () => {
    const pkg = readPkg();
    expect(pkg.dependencies?.["@xterm/headless"]).toBe("6.0.0");
    expect(pkg.dependencies?.["@xterm/addon-serialize"]).toBe("0.14.0");
  });

  it("exact-pins all three (no caret/tilde — supply-chain invariant)", () => {
    const pkg = readPkg();
    const pins = [
      pkg.optionalDependencies?.["node-pty"],
      pkg.dependencies?.["@xterm/headless"],
      pkg.dependencies?.["@xterm/addon-serialize"],
    ];
    for (const pin of pins) {
      expect(pin).toBeDefined();
      expect(pin).not.toMatch(/[\^~]/);
    }
  });
});
