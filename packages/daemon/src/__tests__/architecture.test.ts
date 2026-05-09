// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/daemon (Plan 17-04 scaffolding;
 * Plan 23-03 lands the real WIRING-10/-11 invariants).
 *
 * Source-grep boundary tests enforce that:
 *   - Production source MUST NOT import the test-only stub factory
 *     `createCapabilityPortStub` (Pitfall 13 — leaks the stub into the
 *     published comisai tarball via bundledDependencies).
 *   - Test source files MUST NOT import the production no-op factory
 *     (use `createCapabilityPortStub` from `__test-helpers/` instead). The
 *     orchestration smoke test (`orchestration-order.test.ts`, Plan 23-02
 *     Task 3c) is allowlisted because it imports the no-op as a reference-
 *     equality sentinel proving the live adapter is NOT the no-op fallback.
 *   - Production source under `packages/daemon/src/` MUST NOT reference
 *     the production no-op factory (Plan 23-02 swap landed; WIRING-11
 *     regression check). The no-op factory itself
 *     (`packages/core/src/ports/no-op-tool-capability.ts`) is intentionally
 *     retained for hypothetical future early-startup wiring (Pitfall 13);
 *     it MUST NOT be CALLED from daemon production source after Phase 23.
 *
 * Each invariant was PROVEN failing on a real violation per design v1.1
 * §10.6 inverted TDD cycle BEFORE merge -- see SUMMARY.md for the file:line
 * snapshots that fired the failure path. The proof-of-failure dance happens
 * in the working tree only; only the green test state is committed.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/daemon -- architecture invariants (WIRING-10, WIRING-11)", () => {
  it("WIRING-10a: production source does NOT import createCapabilityPortStub (Pitfall 13 — test/prod boundary)", () => {
    // §10.6 INVERTED-CYCLE PROOF (Phase 23 Plan 23-03): planted violation:
    //   1. cp packages/daemon/src/wiring/tool-capability-adapter.ts /tmp/p23-adapter-backup.ts
    //   2. Append: import { createCapabilityPortStub } from "../../../core/src/ports/__test-helpers/tool-capability-stub.js";
    //   3. Run: pnpm --filter @comis/daemon exec vitest run src/__tests__/architecture.test.ts
    //      Expected: WIRING-10a fails with tool-capability-adapter.ts in offenders.
    //   4. cp /tmp/p23-adapter-backup.ts packages/daemon/src/wiring/tool-capability-adapter.ts
    //   5. Run again: GREEN
    //   6. Document in 23-03-SUMMARY.md.
    //
    // Rationale (Pitfall 13): if the daemon adapter file imports the stub,
    // it ships in the published comisai tarball via bundledDependencies and
    // returns getInstallDetourMode: () => "advise" unconditionally — silent,
    // fixed, wrong. The architecture-grep is the SOLE boundary preventing
    // this regression class.
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
        "dist/ via __test-helpers/ which is NOT tsconfig-excluded (Pitfall 13).",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file in @comis/daemon").toBeGreaterThan(0);
  });

  it("WIRING-10b: test source files do NOT import createNoOpCapabilityPort (use createCapabilityPortStub from __test-helpers/ instead)", () => {
    // §10.6 INVERTED-CYCLE PROOF (Phase 23 Plan 23-03): planted violation:
    //   1. Pick any daemon test file that does NOT currently import the
    //      no-op factory (e.g., setup-tools.test.ts after Plan 23-02 mock
    //      migration). Back up: cp <target> /tmp/p23-test-backup.ts
    //   2. Insert near the top:
    //        import { createNoOpCapabilityPort } from "@comis/core";
    //   3. Run: pnpm --filter @comis/daemon exec vitest run src/__tests__/architecture.test.ts
    //      Expected: WIRING-10b fails with the planted file in offenders
    //               (after the allowlist filter).
    //   4. cp /tmp/p23-test-backup.ts <target>
    //   5. Run again: GREEN
    //   6. Document in 23-03-SUMMARY.md.
    //
    // Note: orchestration-order.test.ts (Plan 23-02 Task 3c) intentionally
    // imports createNoOpCapabilityPort as a reference-equality sentinel
    // proving the per-agent ToolCapabilityPort emerging from real setupMcp
    // + the live adapter factory is NOT the no-op fallback. Allowlisted
    // intentionally — see ALLOWLIST below.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    // Allowlist:
    //   1. architecture.test.ts itself references the literal in its proof-
    //      of-failure comment block (even in green state).
    //   2. orchestration-order.test.ts (Plan 23-02 Task 3c) imports the
    //      no-op factory purely as a reference-equality sentinel for proving
    //      the live adapter is not the no-op fallback. Allowlisted
    //      intentionally per Plan 23-03 forbidden-patterns explicit carve-
    //      out.
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

  it("WIRING-11: production source in @comis/daemon does NOT reference createNoOpCapabilityPort (Phase 23 swap landed; regression check)", () => {
    // §10.6 INVERTED-CYCLE PROOF (Phase 23 Plan 23-03): planted violation:
    //   1. cp packages/daemon/src/wiring/setup-tools.ts /tmp/p23-tools-backup.ts
    //   2. Add: const _scratch = createNoOpCapabilityPort();
    //      (Note: must also temporarily re-add the import to compile;
    //       per @comis/core re-export it would be:
    //       import { createNoOpCapabilityPort } from "@comis/core";)
    //   3. Run: pnpm --filter @comis/daemon exec vitest run src/__tests__/architecture.test.ts
    //      Expected: WIRING-11 fails with setup-tools.ts in offenders.
    //   4. cp /tmp/p23-tools-backup.ts packages/daemon/src/wiring/setup-tools.ts
    //   5. Run again: GREEN
    //   6. Document in 23-03-SUMMARY.md.
    //
    // Rationale (Plan 23-02 + WIRING-11): Phase 23 replaced all production
    // createNoOpCapabilityPort() call sites in @comis/daemon with the live
    // ToolCapabilityPort adapter from createToolCapabilityAdapter. A
    // reference here means a regression — someone added a new exec/process
    // factory site or rolled back the wiring. The grep catches it pre-merge.
    //
    // Note: the no-op factory itself
    // (packages/core/src/ports/no-op-tool-capability.ts) is intentionally
    // retained as a legitimate factory for hypothetical future early-startup
    // wiring (Pitfall 13). It MUST NOT be called from daemon production
    // source after Phase 23.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      excludeFileSuffixes: [".test.ts"],
    });
    // Allowlist: architecture.test.ts itself contains the literal in
    // proof-of-failure comments. It is already excluded by BOTH the
    // default `__tests__/` directory exclusion (source-grep.ts:55-60)
    // AND the `excludeFileSuffixes: [".test.ts"]` filter above
    // (source-grep.ts:103) -- so the allowlist is defense-in-depth
    // against a future filename refactor that drops the `.test.ts`
    // suffix or moves the test out of `__tests__/`.
    const ALLOWLIST = ["architecture.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "Phase 23 (WIRING-01..11) replaced all production createNoOpCapabilityPort() " +
        "call sites in @comis/daemon with the live ToolCapabilityPort adapter " +
        "(Plan 23-02). A reference here is a regression — most likely a new " +
        "exec/process tool factory site or a partial revert of the wiring. Add " +
        "the agent's per-agent adapter via deps.getCapabilityPortForAgent(agentId) " +
        "in setup-tools.ts.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file in @comis/daemon").toBeGreaterThan(0);
  });
});
