// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/channels.
 *
 * Forbidden-import rules:
 *   - Production source MUST NOT import @comis/agent. The shared/ pipeline
 *     carriers that previously imported @comis/agent moved to
 *     @comis/orchestrator; channels now depends only on
 *     @comis/{shared, core}.
 *   - Production source MUST NOT import @comis/orchestrator. The target
 *     graph has orchestrator → channels (one-way), NEVER the reverse. A
 *     back-edge would create a cycle.
 *   - Production source MUST NOT import @comis/scheduler, @comis/memory,
 *     @comis/gateway, @comis/cli, @comis/daemon, @comis/infra.
 *
 * Each it() destructures `{ violations, checkedFiles }` from
 * `findForbiddenImports` and adds a walked-at-least-one-file sanity check on
 * `checkedFiles` so a misconfigured rootDir cannot silently report zero
 * violations against zero files.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const PKG_ROOT = resolve(SRC_ROOT, "..");

// Hard-forbidden: never permitted, no allowlist. Includes the back-edge
// prohibition for @comis/orchestrator (target dependency direction is
// orchestrator → channels, one-way; a back-edge would create a cycle).
// @comis/infra is forbidden — logger contract types canonically live in
// @comis/core; the Pino runtime factory stays in @comis/daemon's wiring.
// @comis/agent is forbidden — every channels/src/shared/ pipeline carrier
// that imported @comis/agent (inbound-gate, channel-manager,
// inbound-pipeline, inbound-route, inbound-resolve, execution-execute,
// execution-pipeline, execution-filter) moved to @comis/orchestrator.
const HARD_FORBIDDEN_PACKAGES = [
  "@comis/agent",
  "@comis/orchestrator",
  "@comis/scheduler",
  "@comis/memory",
  "@comis/gateway",
  "@comis/cli",
  "@comis/daemon",
  "@comis/infra",
] as const;

describe("@comis/channels -- architecture invariants", () => {
  for (const forbidden of HARD_FORBIDDEN_PACKAGES) {
    it(`production source does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/channels production source must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            forbidden === "@comis/agent"
              ? "The channels/src/shared/ pipeline carriers that previously imported @comis/agent moved to @comis/orchestrator. channels depends only on @comis/{shared, core}; if a type is needed, move it to @comis/core/ports."
              : forbidden === "@comis/orchestrator"
                ? "The dependency direction is orchestrator → channels (one-way). A back-edge would create a cycle. Use the channels public surface from orchestrator instead."
                : forbidden === "@comis/infra"
                  ? "Replace `import type { ComisLogger | LogFields | ErrorKind } from \"@comis/infra\"` with `... from \"@comis/core\"`. The Pino-free structural ComisLogger contract canonically lives in @comis/core."
                  : "channels depends only on @comis/{shared, core}. If a type is needed, move it to @comis/core/ports.",
          designRef:
            forbidden === "@comis/agent"
              ? "channels → agent edge is cut; carriers live in @comis/orchestrator"
              : forbidden === "@comis/orchestrator"
                ? "one-way orchestrator → channels"
                : forbidden === "@comis/infra"
                  ? "ComisLogger contract lives in @comis/core"
                  : "target package graph",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one channels/src file",
      ).toBeGreaterThan(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Binding-named test for the logger-contract retarget. The
  // HARD_FORBIDDEN_PACKAGES loop above already guards the source-grep
  // boundary; this rule pairs it with a tsconfig.json + package.json
  // absence assertion for the dropped @comis/infra dep.
  // ---------------------------------------------------------------------------

  it("imports logger contract types from @comis/core, not @comis/infra", () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: SRC_ROOT,
      forbiddenPackage: "@comis/infra",
    });
    expect(
      violations,
      formatViolations({
        description:
          "@comis/channels production source must import logger contract types (ComisLogger, LogFields, ErrorKind) from @comis/core, not @comis/infra.",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Replace `import type { ComisLogger | LogFields | ErrorKind } from \"@comis/infra\"` with `... from \"@comis/core\"`. The Pino-free structural ComisLogger contract canonically lives in @comis/core.",
        designRef:
          "ComisLogger contract lives in @comis/core",
      }),
    ).toEqual([]);
    expect(
      checkedFiles,
      "sanity: findForbiddenImports walked at least one channels/src file",
    ).toBeGreaterThan(0);
  });

  it("channels/tsconfig.json and channels/package.json do not reference @comis/infra", () => {
    const tsconfigPath = resolve(PKG_ROOT, "tsconfig.json");
    const packageJsonPath = resolve(PKG_ROOT, "package.json");
    const tsconfigContent = readFileSync(tsconfigPath, "utf8");
    const packageJsonContent = readFileSync(packageJsonPath, "utf8");
    expect(
      tsconfigContent.includes("@comis/infra") ||
        tsconfigContent.includes('"path": "../infra"'),
      "channels/tsconfig.json must not reference @comis/infra. " +
        "If a logger contract type is needed, import it from @comis/core; the Pino runtime factory " +
        "stays in @comis/daemon's wiring.",
    ).toBe(false);
    expect(
      packageJsonContent.includes("@comis/infra"),
      "channels/package.json must not depend on @comis/infra. " +
        "channels's logger contract usage is type-only and resolves through @comis/core.",
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Zero `as any` in the Discord adapter pair: scope covers BOTH
  // discord-actions.ts (18 sites) AND discord-adapter.ts (the 5 adjacent
  // `const textChannel = channel as any` sites, all collapsing to the same
  // asTextLike narrowing). Narrowing helpers live in
  // ./discord/discord-adapter-types.ts: asTextLike() for text-like channels,
  // asThreadInfo() for the threadList iteration sites.
  // ---------------------------------------------------------------------------

  it("discord adapter files contain zero `as any` casts", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: /\bas\s+any\b/,
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "fixtures"],
      excludeFileSuffixes: [".test.ts"],
    });
    const offenders = result.matches.filter(
      (m) =>
        m.endsWith("discord/discord-actions.ts") ||
        m.endsWith("discord/discord-adapter.ts"),
    );
    expect(
      offenders,
      formatViolations({
        description:
          "discord-actions.ts and discord-adapter.ts must contain zero `as any` casts; use asTextLike() or asThreadInfo() from ./discord-adapter-types.js to narrow Discord channels.",
        violations: offenders.map((file) => ({ file, line: 0 })),
        suggestedFix:
          "Replace `(channel as any).method()` with `const tc = asTextLike(channel); if (!tc) return err(...); tc.method()`. For thread iteration, use asThreadInfo(thread).",
        designRef: "Discord channels must be narrowed via asTextLike/asThreadInfo helpers",
      }),
    ).toEqual([]);
    expect(
      result.checkedFiles,
      "sanity: findInSourceFiles walked at least one channels/src file",
    ).toBeGreaterThan(0);
  });
});
