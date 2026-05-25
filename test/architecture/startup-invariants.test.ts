// SPDX-License-Identifier: Apache-2.0
/**
 * Startup invariants architecture test.
 *
 * Asserts that packages/daemon/src/daemon.ts:
 *   1. Imports `emitStartupInvariants` from "./wiring/setup-startup-invariants.js"
 *   2. Calls `emitStartupInvariants(` AFTER `emitStartupBanner(` and BEFORE
 *      `saveLastKnownGood` in the bootShutdown function body.
 *
 * Shrink-only: no allowlist. The only way to comply is to add the call in daemon.ts.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const DAEMON_TS = resolve(REPO_ROOT, "packages/daemon/src/daemon.ts");

describe("startup invariants architecture", () => {
  it("daemon.ts imports emitStartupInvariants from wiring/setup-startup-invariants.js", () => {
    const content = readFileSync(DAEMON_TS, "utf8");

    expect(content).toMatch(
      /import\s*\{[^}]*emitStartupInvariants[^}]*\}\s*from\s*["']\.\/wiring\/setup-startup-invariants\.js["']/,
    );
  });

  it("daemon.ts calls emitStartupInvariants after emitStartupBanner and before saveLastKnownGood", () => {
    const content = readFileSync(DAEMON_TS, "utf8");
    const lines = content.split(/\r?\n/);

    // Find line numbers (1-indexed) for all three tokens
    let bannerLine = -1;
    let invariantsLine = -1;
    let lkgLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Skip comment lines
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

      if (bannerLine === -1 && /emitStartupBanner\s*\(/.test(line)) {
        bannerLine = i + 1;
      }
      if (invariantsLine === -1 && /emitStartupInvariants\s*\(/.test(line)) {
        invariantsLine = i + 1;
      }
      if (lkgLine === -1 && /saveLastKnownGood\s*\(/.test(line)) {
        lkgLine = i + 1;
      }
    }

    expect(
      bannerLine,
      "emitStartupBanner( not found in daemon.ts",
    ).toBeGreaterThan(0);

    expect(
      invariantsLine,
      "emitStartupInvariants( not found in daemon.ts — add the call after emitStartupBanner",
    ).toBeGreaterThan(0);

    expect(
      lkgLine,
      "saveLastKnownGood( not found in daemon.ts",
    ).toBeGreaterThan(0);

    expect(
      invariantsLine,
      `emitStartupInvariants (line ${invariantsLine}) must appear AFTER emitStartupBanner (line ${bannerLine})`,
    ).toBeGreaterThan(bannerLine);

    expect(
      invariantsLine,
      `emitStartupInvariants (line ${invariantsLine}) must appear BEFORE saveLastKnownGood (line ${lkgLine})`,
    ).toBeLessThan(lkgLine);
  });
});
