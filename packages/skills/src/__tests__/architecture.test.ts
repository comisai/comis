// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/skills (Plan 17-04, TOOLING-CFG-19).
 *
 * Source-grep boundary tests enforce that:
 *   - Production source MUST NOT import the test-only stub factory
 *     `createCapabilityPortStub`.
 *   - Test source files MUST NOT import the production no-op
 *     `createNoOpCapabilityPort` (tests should use the stub instead).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/skills -- architecture invariants (TOOLING-CFG-19, MCPNAME-03, INSTALL-DTR-25)", () => {
  it("production source does NOT import createCapabilityPortStub (Pitfall 13)", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createCapabilityPortStub",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "__test-helpers"],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/skills production source must not import the test stub",
    ).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });

  it("test source does NOT import createNoOpCapabilityPort", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/skills tests must use createCapabilityPortStub from @comis/core's __test-helpers",
    ).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });

  it("MCPNAME-03: mcp-tool-bridge.ts has no inline mcp__...--... parser (delegates to @comis/shared)", () => {
    // §10.6 inverted-cycle proof: this test was proven failing on a real
    // violation BEFORE merge. Steps captured in 18-03-SUMMARY.md — a scratch
    // _scratchExtract body was added to mcp-tool-bridge.ts; the test fired
    // with the offending file path; the scratch was reverted byte-perfectly;
    // the test went green again. The committed state is green.
    //
    // The forbidden shape: a function body that strips the `mcp__` prefix
    // (`.slice(5)` or `.slice("mcp__".length)`) and locates the `--`
    // separator (`.indexOf("--")`) within ~200 chars of each other. The
    // [\s\S]{0,200} cross-line allowance accommodates inline parsers that
    // span ~3 lines between the two stems. Post-migration the only place
    // this shape exists is `packages/shared/src/mcp-tool-name.ts`.
    const result = findInSourceFiles({
      rootDir: resolve(SRC_ROOT, "bridge"),
      needle: /\.slice\(5\)[\s\S]{0,200}\.indexOf\(["']--["']\)/,
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "mcp-tool-bridge.ts must import extractMcpServerName from @comis/shared, " +
        "not inline-parse; expected matches to be empty",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one file in bridge/").toBeGreaterThan(0);
  });

  it("INSTALL-DTR-25 / Pitfall 11: tool:install_detour_detected event payload contains no forbidden keys", () => {
    // §10.6 inverted-cycle proof was REQUIRED before this test was trusted (Pitfall 13).
    // Captured in 22-03-SUMMARY.md:
    //   1. Plant `command: command,` line inside one of the
    //      `eventBus?.emit("tool:install_detour_detected", { ... })` blocks
    //      in `exec-tool.ts` (the foreground emission site).
    //   2. Run this test — it FAILED with the offending file path included
    //      in the offenders list.
    //   3. Revert the planted line byte-perfectly.
    //   4. Re-ran — green. The committed state is green.
    //
    // Forbidden shape: any of {command, rawCommand, stdout, stderr, rawArgs, fullCommand}
    // appearing as a property KEY inside an `eventBus.emit("tool:install_detour_detected", {...})`
    // block. The TS event type at packages/core/src/event-bus/events-agent.ts:120-159 rejects
    // extra keys at compile time, but this grep is the runtime safety net for forbidden-key
    // prevention (Pitfall 11; design §8.2 telemetry privacy invariants).
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: /eventBus\??\.emit\(\s*['"]tool:install_detour_detected['"][\s\S]{0,4000}?\);/g,
      excludeFileSuffixes: [".test.ts"],
    });
    const forbiddenKeys = ["command:", "rawCommand:", "stdout:", "stderr:", "rawArgs:", "fullCommand:"];
    const offenders: Array<{ file: string; key: string }> = [];
    for (const filePath of result.matches) {
      const content = readFileSync(filePath, "utf-8");
      const blocks = [
        ...content.matchAll(
          /eventBus\??\.emit\(\s*['"]tool:install_detour_detected['"][\s\S]{0,4000}?\);/g,
        ),
      ];
      for (const block of blocks) {
        for (const key of forbiddenKeys) {
          // Anchor on whitespace, comma, or `{` BEFORE the forbidden key.
          // This guards against `commandDigest:` matching `command:` (the
          // `command:` substring is preceded by alphanumeric `mandD`, not by
          // whitespace / comma / brace).
          const re = new RegExp(`(?:[\\s,{])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
          if (re.test(block[0])) offenders.push({ file: filePath, key });
        }
      }
    }
    expect(
      offenders,
      "Event payload must not include raw command text or output (Pitfall 11). " +
        "Closed shape lives at packages/core/src/event-bus/events-agent.ts:120-159. " +
        "If this test fails, remove the offending key from the emit call site — " +
        "or, if you truly need command-derived metadata, use the existing `commandDigest` field.",
    ).toEqual([]);
  });
});
