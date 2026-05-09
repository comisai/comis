// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/daemon.
 *
 * Source-grep boundary tests enforce that:
 *   - Production source MUST NOT import the test-only stub factory
 *     `createCapabilityPortStub` (it would leak the stub into the
 *     published comisai tarball via bundledDependencies).
 *   - Test source files MUST NOT import the production no-op factory
 *     (use `createCapabilityPortStub` from `__test-helpers/` instead). The
 *     orchestration smoke test (`orchestration-order.test.ts`) is allowlisted
 *     because it imports the no-op as a reference-equality sentinel proving
 *     the live adapter is NOT the no-op fallback.
 *   - Production source under `packages/daemon/src/` MUST NOT reference
 *     the production no-op factory. The no-op factory itself
 *     (`packages/core/src/ports/no-op-tool-capability.ts`) is intentionally
 *     retained for hypothetical future early-startup wiring; it MUST NOT be
 *     CALLED from daemon production source.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/daemon -- architecture invariants", () => {
  it("production source does NOT import createCapabilityPortStub (test/prod boundary)", () => {
    // Rationale: if the daemon adapter file imports the stub, it ships in
    // the published comisai tarball via bundledDependencies and returns
    // getInstallDetourMode: () => "advise" unconditionally — silent, fixed,
    // wrong. The architecture-grep is the SOLE boundary preventing this
    // regression class.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createCapabilityPortStub",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "__test-helpers"],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/daemon production source must not import createCapabilityPortStub — " +
        "the test stub leaks into the published comisai tarball if smuggled into " +
        "dist/ via __test-helpers/ which is NOT tsconfig-excluded.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file in @comis/daemon").toBeGreaterThan(0);
  });

  it("test source files do NOT import createNoOpCapabilityPort (use createCapabilityPortStub from __test-helpers/ instead)", () => {
    // Note: orchestration-order.test.ts intentionally imports
    // createNoOpCapabilityPort as a reference-equality sentinel proving the
    // per-agent ToolCapabilityPort emerging from real setupMcp + the live
    // adapter factory is NOT the no-op fallback. Allowlisted intentionally —
    // see ALLOWLIST below.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    // Allowlist:
    //   1. architecture.test.ts itself references the literal in its
    //      explanatory comment block.
    //   2. orchestration-order.test.ts imports the no-op factory purely as
    //      a reference-equality sentinel for proving the live adapter is
    //      not the no-op fallback. Allowlisted intentionally as an explicit
    //      forbidden-patterns carve-out.
    const ALLOWLIST = ["architecture.test.ts", "orchestration-order.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "@comis/daemon test files must use createCapabilityPortStub from @comis/core's " +
        "__test-helpers/ instead of createNoOpCapabilityPort — production no-op factory " +
        "is for early-startup fallback only.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one test file in @comis/daemon").toBeGreaterThan(0);
  });

  it("production source in @comis/daemon does NOT reference createNoOpCapabilityPort (regression check)", () => {
    // Rationale: all production createNoOpCapabilityPort() call sites in
    // @comis/daemon were replaced with the live ToolCapabilityPort adapter
    // from createToolCapabilityAdapter. A reference here means a regression —
    // someone added a new exec/process factory site or rolled back the
    // wiring. The grep catches it pre-merge.
    //
    // Note: the no-op factory itself
    // (packages/core/src/ports/no-op-tool-capability.ts) is intentionally
    // retained as a legitimate factory for hypothetical future early-startup
    // wiring. It MUST NOT be called from daemon production source.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      excludeFileSuffixes: [".test.ts"],
    });
    // Allowlist: architecture.test.ts itself contains the literal in its
    // explanatory comments. It is already excluded by BOTH the default
    // `__tests__/` directory exclusion (source-grep.ts:55-60) AND the
    // `excludeFileSuffixes: [".test.ts"]` filter above (source-grep.ts:103)
    // -- so the allowlist is defense-in-depth against a future filename
    // refactor that drops the `.test.ts` suffix or moves the test out of
    // `__tests__/`.
    const ALLOWLIST = ["architecture.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "All production createNoOpCapabilityPort() call sites in @comis/daemon " +
        "should use the live ToolCapabilityPort adapter. A reference here is a " +
        "regression — most likely a new exec/process tool factory site or a " +
        "partial revert of the wiring. Add the agent's per-agent adapter via " +
        "deps.getCapabilityPortForAgent(agentId) in setup-tools.ts.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file in @comis/daemon").toBeGreaterThan(0);
  });
});
