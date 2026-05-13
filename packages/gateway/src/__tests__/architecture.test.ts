// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/gateway.
 *
 * Forbidden-import rules:
 *   - Production source MUST NOT import @comis/agent. Phase 28 commit 5
 *     (CORE-PORTS-14 / L4 closure) moved the OAuth helpers
 *     (resolveCodexAuthIdentity, rewriteOAuthError, redactEmailForLog) to
 *     @comis/core/security; gateway now imports them from @comis/core.
 *     The L4 allowlist is closed (unconditional rule).
 *   - Production source MUST NOT import @comis/cli, @comis/skills,
 *     @comis/scheduler, @comis/memory, @comis/channels, @comis/daemon,
 *     @comis/orchestrator. gateway is a transport-only layer; the §2.2
 *     target package graph allows only @comis/{shared, core}.
 *
 * Binding rule (design §5.3):
 *   - oauth-callback-route.ts imports the OAuth helpers from @comis/core
 *     (not @comis/agent).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

const HARD_FORBIDDEN_PACKAGES = [
  "@comis/agent",
  "@comis/cli",
  "@comis/skills",
  "@comis/scheduler",
  "@comis/memory",
  "@comis/channels",
  "@comis/daemon",
  "@comis/orchestrator",
] as const;

describe("@comis/gateway -- architecture invariants", () => {
  for (const forbidden of HARD_FORBIDDEN_PACKAGES) {
    it(`production source does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/gateway production source must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            forbidden === "@comis/agent"
              ? "Phase 28 commit 5 / L4 closure: OAuth helpers (resolveCodexAuthIdentity, rewriteOAuthError, redactEmailForLog) live in @comis/core/security. Replace `from \"@comis/agent\"` with `from \"@comis/core\"`."
              : "gateway is a transport-only layer; allowed deps per §2.2 are only @comis/{shared, core}.",
          designRef:
            forbidden === "@comis/agent"
              ? "design §5.2 + §1.3 L4 (closed in Phase 28 commit 5 / CORE-PORTS-14)"
              : "design §2.2 (target package graph)",
        }),
      ).toEqual([]);
      expect(checkedFiles, "sanity: findForbiddenImports walked at least one gateway/src file").toBeGreaterThan(0);
    });
  }

  // -------------------------------------------------------------------------
  // Phase 28 commit 5 (CORE-PORTS-14 / L4 closure) — binding rule from design
  // §5.3. Asserts the gateway's OAuth callback route imports the helpers from
  // @comis/core (the single source of truth post-consolidation), not from a
  // back-edge into @comis/agent (deleted in the same commit).
  // -------------------------------------------------------------------------

  it("imports oauth helpers from @comis/core", () => {
    const routePath = resolve(SRC_ROOT, "oauth", "oauth-callback-route.ts");
    const source = readFileSync(routePath, "utf8");
    const missing: string[] = [];
    if (!/resolveCodexAuthIdentity/.test(source)) missing.push("resolveCodexAuthIdentity (symbol absent)");
    if (!/rewriteOAuthError/.test(source)) missing.push("rewriteOAuthError (symbol absent)");
    if (!/redactEmailForLog/.test(source)) missing.push("redactEmailForLog (symbol absent)");
    if (!/from\s+"@comis\/core"/.test(source)) missing.push('import from "@comis/core" (path)');
    expect(
      missing,
      "gateway/src/oauth/oauth-callback-route.ts must import resolveCodexAuthIdentity + rewriteOAuthError + redactEmailForLog from @comis/core (post-L4-closure single source).",
    ).toEqual([]);
  });
});
