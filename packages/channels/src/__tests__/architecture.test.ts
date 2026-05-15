// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/channels.
 *
 * Forbidden-import rules:
 *   - Production source MUST NOT import @comis/agent. The 8 shared/
 *     pipeline carriers that previously imported @comis/agent moved to
 *     @comis/orchestrator in Phase 32 commits 3-4; the channels→agent
 *     package-graph edge was cut in Phase 32 commit 5 (ORCH-EXT-12,
 *     L1 closed). channels now depends only on @comis/{shared, core}.
 *   - Production source MUST NOT import @comis/orchestrator. The §2.2
 *     target graph has orchestrator → channels (one-way), NEVER the
 *     reverse. A back-edge would create a cycle.
 *   - Production source MUST NOT import @comis/scheduler, @comis/memory,
 *     @comis/gateway, @comis/cli, @comis/daemon, @comis/infra.
 *
 * Each it() destructures `{ violations, checkedFiles }` from
 * `findForbiddenImports` (Plan 01 result-shape change) and adds a
 * Pattern E sanity check on `checkedFiles` so a misconfigured rootDir
 * cannot silently report zero violations against zero files.
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
// prohibition for @comis/orchestrator (§2.2 dependency direction is
// orchestrator → channels, one-way; a back-edge would create a cycle).
// Phase 28 commit 2 (CORE-PORTS-05) added @comis/infra to the list — logger
// contract types canonically live in @comis/core; the Pino runtime factory
// stays in @comis/daemon's wiring.
// Phase 32 commit 5 (ORCH-EXT-12 / L1 closed) added @comis/agent to the list:
// every channels/src/shared/ pipeline carrier that imported @comis/agent
// (inbound-gate, channel-manager, inbound-pipeline, inbound-route,
// inbound-resolve, execution-execute, execution-pipeline, execution-filter)
// moved to @comis/orchestrator in commits 3-4; the package-graph edge was
// cut at commit 5.
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
              ? "The 8 channels/src/shared/ pipeline carriers that previously imported @comis/agent moved to @comis/orchestrator in Phase 32 commits 3-4. The channels → agent package-graph edge was cut at Phase 32 commit 5 (ORCH-EXT-12 / L1 closed); channels now depends only on @comis/{shared, core}. If a type is needed, move it to @comis/core/ports."
              : forbidden === "@comis/orchestrator"
                ? "The §2.2 dependency direction is orchestrator → channels (one-way). A back-edge would create a cycle. Use the channels public surface from orchestrator instead."
                : forbidden === "@comis/infra"
                  ? "Replace `import type { ComisLogger | LogFields | ErrorKind } from \"@comis/infra\"` with `... from \"@comis/core\"`. The Pino-free structural ComisLogger contract canonically lives in @comis/core after Phase 28 commit 2 (CORE-PORTS-05)."
                  : "channels depends only on @comis/{shared, core}. If a type is needed, move it to @comis/core/ports.",
          designRef:
            forbidden === "@comis/agent"
              ? "design §1.3 L1 (closed Phase 32 commit 5) / §9.4 commit 5 (channels → agent edge cut) / ORCH-EXT-12"
              : forbidden === "@comis/orchestrator"
                ? "design §2.2 (one-way orchestrator → channels)"
                : forbidden === "@comis/infra"
                  ? "design §5.2 step 2 / §5.4 step 2 (CORE-PORTS-05 / L12 closure)"
                  : "design §2.2 (target package graph)",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one channels/src file",
      ).toBeGreaterThan(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 28 commit 2 (CORE-PORTS-05) binding-named test: explicit rule for
  // logger-contract retarget. The HARD_FORBIDDEN_PACKAGES loop above already
  // guards the source-grep boundary; this rule is the binding-named contract
  // from design §5.3 plus a tsconfig.json + package.json absence assertion
  // for the dropped @comis/infra dep.
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
          "Replace `import type { ComisLogger | LogFields | ErrorKind } from \"@comis/infra\"` with `... from \"@comis/core\"`. The Pino-free structural ComisLogger contract canonically lives in @comis/core after Phase 28 commit 2.",
        designRef:
          "design §5.2 step 2 / §5.4 step 2 (CORE-PORTS-05 / L12 closure)",
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
      "channels/tsconfig.json must not reference @comis/infra (Phase 28 commit 2 / CORE-PORTS-05). " +
        "If a logger contract type is needed, import it from @comis/core; the Pino runtime factory " +
        "stays in @comis/daemon's wiring.",
    ).toBe(false);
    expect(
      packageJsonContent.includes("@comis/infra"),
      "channels/package.json must not depend on @comis/infra (Phase 28 commit 2 / CORE-PORTS-05). " +
        "channels's logger contract usage is type-only and resolves through @comis/core.",
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Phase 41 plan 05 (TS-HYG-06): zero `as any` in the Discord adapter pair.
  // Per 41-03-SUMMARY.md Decision 3, scope covers BOTH discord-actions.ts
  // (the original TS-HYG-06 target, 18 sites) AND discord-adapter.ts (the
  // 5 adjacent `const textChannel = channel as any` sites at lines
  // 426/453/475/500/521, all collapsing to the same asTextLike narrowing).
  // Narrowing helpers live in ./discord/discord-adapter-types.ts (Plan 41-02
  // foundation): asTextLike() for text-like channels, asThreadInfo() for the
  // threadList iteration sites.
  // ---------------------------------------------------------------------------

  it("discord adapter files contain zero `as any` casts (TS-HYG-06)", () => {
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
          "discord-actions.ts and discord-adapter.ts must contain zero `as any` casts after Phase 41 TS-HYG-06; use asTextLike() or asThreadInfo() from ./discord-adapter-types.js to narrow Discord channels.",
        violations: offenders.map((file) => ({ file, line: 0 })),
        suggestedFix:
          "Replace `(channel as any).method()` with `const tc = asTextLike(channel); if (!tc) return err(...); tc.method()`. For thread iteration, use asThreadInfo(thread).",
        designRef: "code-quality-plan §7.2.2 (TS-HYG-06) / 41-03-SUMMARY.md Decision 3 (adjacent-adapter scope expansion)",
      }),
    ).toEqual([]);
    expect(
      result.checkedFiles,
      "sanity: findInSourceFiles walked at least one channels/src file",
    ).toBeGreaterThan(0);
  });
});
