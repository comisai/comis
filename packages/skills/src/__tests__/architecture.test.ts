// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/skills.
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

describe("@comis/skills -- architecture invariants", () => {
  it("production source does NOT import createCapabilityPortStub", () => {
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

  it("mcp-tool-bridge.ts has no inline mcp__...--... parser (delegates to @comis/shared)", () => {
    // The forbidden shape: a function body that strips the `mcp__` prefix
    // (`.slice(5)` or `.slice("mcp__".length)`) and locates the `--`
    // separator (`.indexOf("--")`) within ~200 chars of each other. The
    // [\s\S]{0,200} cross-line allowance accommodates inline parsers that
    // span ~3 lines between the two stems. Post-migration the only place
    // this shape exists is `packages/shared/src/mcp-tool-name.ts`.
    const result = findInSourceFiles({
      // bridge/ lives at src/skills/bridge/ (skills source restructure).
      rootDir: resolve(SRC_ROOT, "skills/bridge"),
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

  it("tool:install_detour_detected event payload contains no forbidden keys", () => {
    // Forbidden shape: any of {command, rawCommand, stdout, stderr, rawArgs, fullCommand}
    // appearing as a property KEY inside an `eventBus.emit("tool:install_detour_detected", {...})`
    // block. The TS event type at packages/core/src/event-bus/events-agent.ts:120-159 rejects
    // extra keys at compile time, but this grep is the runtime safety net for
    // forbidden-key prevention (telemetry privacy invariant).
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
      "Event payload must not include raw command text or output. " +
        "Closed shape lives at packages/core/src/event-bus/events-agent.ts:120-159. " +
        "If this test fails, remove the offending key from the emit call site — " +
        "or, if you truly need command-derived metadata, use the existing `commandDigest` field.",
    ).toEqual([]);
  });

  it("skills/src/skills/* never imports from tools/ or platform-tools/", () => {
    // One-way invariant: the `.` subpath (skill registry, manifest, prompt,
    // policy, bridge) must not depend on the tool layer at the per-file
    // PEER-LEVEL. The invariant is ONE-WAY only — `tools/` and
    // `platform-tools/` may depend on each other (e.g., shared
    // tool-helpers.ts).
    //
    // The regex matches `from "../tools/..."` or `from "../platform-tools/..."`
    // (single `../`). For files at depth 1 inside skills/ (e.g.
    // skills/X.ts where X is a peer of tools/), `../tools/` is the
    // canonical peer-subpath crossing. The regex deliberately does NOT
    // match `../../tools/...` (depth-2 relative reach across subpaths) —
    // that level of cross-subpath dependency is tolerated transitionally.
    //
    // The skills/src/skills/index.ts barrel is excluded from the walk
    // (it intentionally re-exports from `../tools/index.js` and
    // `../platform-tools/index.js` to keep consumer imports of
    // `@comis/skills` resolving). The walk targets the SUBDIRECTORIES
    // (registry, manifest, prompt, audit, policy, bridge, integrations)
    // where the actual skill-concern logic lives — those files SHOULD
    // never reach across subpaths at peer level. Bare-package imports
    // (`from "@comis/skills/tools"`) are intentionally out of scope
    // (self-imports through node_modules are a different anti-pattern,
    // not the architectural boundary this test locks).
    const SKILLS_SUBDIRS = ["registry", "manifest", "prompt", "audit", "policy", "bridge", "integrations"] as const;
    const allMatches: string[] = [];
    let totalChecked = 0;
    for (const sub of SKILLS_SUBDIRS) {
      const result = findInSourceFiles({
        rootDir: resolve(SRC_ROOT, "skills", sub),
        needle: /from\s+["']\.\.\/(?:tools|platform-tools)\//,
        excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules"],
        excludeFileSuffixes: [".test.ts"],
      });
      allMatches.push(...result.matches);
      totalChecked += result.checkedFiles;
    }
    expect(
      allMatches,
      "skills/src/skills/* must not depend on tools/ or platform-tools/",
    ).toEqual([]);
    expect(totalChecked).toBeGreaterThan(0);
  });
});
