// SPDX-License-Identifier: Apache-2.0
/**
 * Dual-graph alignment test (ARCH-BASE-02).
 *
 * Asserts three invariants:
 *   1. Every packages/*\/tsconfig.json `references` block aligns with the
 *      §2.2 target package graph (closed set — GUARDRAILS-02; no allowlist).
 *   2. Every packages/*\/package.json `dependencies` (filtered to @comis/*)
 *      aligns with the §2.2 target graph (closed Phase 36 GUARDRAILS-02 — no allowlist).
 *   3. The two graphs (#1 + #2) match each other — drift between
 *      tsconfig refs and package.json deps is a covert source of cycles
 *      and stale-build risk. Filtered through DRIFT_ALLOWLIST for
 *      INTENTIONAL divergences (empty as of Phase 35 Plan 35-05 — see
 *      DRIFT_ALLOWLIST inline comment).
 *
 * Also asserts:
 *   - test/architecture/tsconfig.madge.json `paths` block has exactly
 *     14 entries (12 workspace packages + 2 skills subpaths per
 *     SKILLS-SPLIT-04; `web` and `comis` umbrella excluded). Pitfall 5
 *     (RES-PIT-5) regression coverage; Phase 33 expanded from 12 → 14.
 *
 * NOTE: ARCH-BASE-14's dist-mode madge gate AND `tsc -b --dry` gate live
 * in .github/workflows/ci.yml (Plan 02 Task 3) — NOT here. This file's
 * scope is "tsconfig + package.json static-graph alignment", which is a
 * different concern from runtime cycle detection.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatViolations,
  type ViolationCitation,
} from "../support/architecture-helpers.js";

/**
 * Parse a legacy "<path><sep><message>" violation string into a structured
 * ViolationCitation so `formatViolations()` renders the path in the file
 * field and the issue prose in the snippet block (CR-WR-01).
 *
 * Accepts both `packages/X/file.json <message>` and `packages/X: <message>`
 * shapes; falls back to the whole string as `file` when no separator
 * matches.
 */
function structureViolation(raw: string): ViolationCitation {
  const colonMatch = raw.match(/^(packages\/[^\s:]+):\s+(.+)$/s);
  if (colonMatch) {
    return { file: colonMatch[1], line: 0, snippet: colonMatch[2] };
  }
  const spaceMatch = raw.match(/^(packages\/\S+)\s+(.+)$/s);
  if (spaceMatch) {
    return { file: spaceMatch[1], line: 0, snippet: spaceMatch[2] };
  }
  return { file: raw, line: 0 };
}

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const TSCONFIG_MADGE_PATH = resolve(here, "tsconfig.madge.json");

const WORKSPACE_PACKAGES = [
  "shared",
  "core",
  "infra",
  "memory",
  "scheduler",
  "skills",
  "agent",
  "channels",
  "orchestrator",
  "gateway",
  "cli",
  "daemon",
] as const;

type WorkspacePackage = (typeof WORKSPACE_PACKAGES)[number];

/**
 * §2.2 target package graph (current state with L1-L26 allowlist still open).
 *
 * Each value is the set of @comis/* packages that the key package SHOULD
 * reference in BOTH tsconfig.json `references` and package.json `dependencies`.
 * Phase 27 records the current graph; Phase 28+ phases narrow it.
 *
 * NOTE on cli: TARGET_GRAPH.cli does NOT include "agent" because cli's
 * tsconfig.json does not reference ../agent (verified post-Phase-31 commit 12:
 * cli/tsconfig.json references = [shared, core, infra] — no ../agent and
 * no ../memory). cli/package.json DOES depend on @comis/agent for runtime
 * substring imports per L17. This intentional divergence is allowlisted via
 * DRIFT_ALLOWLIST below. The @comis/memory edge was closed in Phase 31
 * commit 12 (MEM-CTX-PORTS-02): both cli/package.json `dependencies` and
 * cli/tsconfig.json `references` dropped @comis/memory after the secrets +
 * auth subcommands migrated to daemon RPC (MEM-CTX-PORTS-09).
 *
 * NOTE on agent vs skills: at plan-authoring time, packages/agent does NOT
 * import @comis/skills (only structural-typing comments reference it). So
 * agent's TARGET_GRAPH after Phase 31 commit 4 is [shared, core, scheduler]
 * — no skills edge, and the memory edge was cut. Phase 28 commit 2
 * (CORE-PORTS-05 / L12) had already cut the @comis/infra edge; Phase 31
 * commit 4 (MEM-CTX-PORTS-01 + MEM-CTX-PORTS-07) closes the memory edge
 * by retargeting agent's type-only imports to @comis/core (ContextStorePort
 * + SessionStorePort + row DTOs) and moving the lone value-import
 * (createOAuthProfileStoreEncrypted) to daemon's setup-agents.ts.
 */
const TARGET_GRAPH: Record<WorkspacePackage, ReadonlySet<string>> = {
  shared: new Set(),
  core: new Set(["shared"]),
  infra: new Set(["shared", "core"]),
  memory: new Set(["shared", "core"]),
  scheduler: new Set(["shared", "core"]),
  // skills: Phase 33 cut the infra edge (SKILLS-SPLIT-09). Logger type imports from @comis/core;
  // isDocker moved to packages/core/src/runtime/is-docker.ts (RES-ARCH-2).
  skills: new Set(["shared", "core"]),
  // agent: structurally references skills' types only (comments) — no actual
  // import edge, so no skills entry here. Phase 28 commit 2 (CORE-PORTS-05 /
  // L12) cut the @comis/infra edge: logger contract types canonically live
  // in @comis/core after the move. Phase 31 commit 4 (MEM-CTX-PORTS-01 +
  // MEM-CTX-PORTS-07) cut the @comis/memory edge: agent's type-only imports
  // resolve through @comis/core; the OAuth-store value-import moved to daemon.
  agent: new Set(["shared", "core", "scheduler"]),
  // channels: L1 closed in Phase 32 commit 5 (ORCH-EXT-12). Agent dep dropped
  // from both package.json and tsconfig.json after the 8 shared/ pipeline
  // carriers (inbound + execution) moved to @comis/orchestrator in commits
  // 3-4. Phase 28 commit 2 (CORE-PORTS-05 / L12) cut the @comis/infra edge
  // earlier.
  channels: new Set(["shared", "core"]),
  // orchestrator: bootstrap commit only — empty src/, no actual import edges yet.
  // Phase 32 target graph: orchestrator depends on shared, core, agent, channels
  // per ORCH-EXT-01 (design §2.2 + §9.5 acceptance criteria).
  orchestrator: new Set(["shared", "core", "agent", "channels"]),
  // gateway: L4 closed in Phase 28 commit 5 (CORE-PORTS-14) — the agent
  // OAuth-helpers back-edge is cut; OAuth helpers now live in @comis/core.
  gateway: new Set(["shared", "core"]),
  // cli: L12 closed in Phase 35 Plan 35-05 (WEB-CONTRACTS-03) — cli no
  // longer depends on @comis/infra. L17 closed in Phase 35 Plan 35-04
  // (WEB-CONTRACTS-02) — cli no longer depends on @comis/agent. The
  // cli:agent entry in DRIFT_ALLOWLIST is removed alongside. Memory edge
  // closed in Phase 31 commit 12 (MEM-CTX-PORTS-02). Result: cli's
  // workspace dep graph collapses to {shared, core}.
  cli: new Set(["shared", "core"]),
  daemon: new Set([
    "shared",
    "core",
    "infra",
    "memory",
    "scheduler",
    "skills",
    "agent",
    "channels",
    "orchestrator",
    "gateway",
  ]),
};

/**
 * DRIFT_ALLOWLIST: intentional divergences between tsconfig.json `references`
 * and package.json `dependencies` (filtered to @comis/*).
 *
 * Format: `"${packageShortName}:${depShortName}"` — both strings have the
 * `@comis/` prefix STRIPPED.
 *
 * Phase 35 Plan 35-05 (WEB-CONTRACTS-03) — DRIFT_ALLOWLIST is now empty:
 *   cli:agent was removed when Phase 35 Plan 35-04 (WEB-CONTRACTS-02 / L17
 *   closure) retargeted every CLI @comis/agent import to @comis/core; the
 *   stale @comis/agent dep in cli/package.json was dropped in this plan
 *   alongside the @comis/infra closure.
 *
 * The allowlist mechanism mirrors test/support/architecture-allowlist.ts
 * shrink-only semantics: entries can be REMOVED (when the underlying L-ID
 * closes) but should NOT be ADDED without a refactor PR + L-ID assignment +
 * design-doc citation. PR review catches additions; future Phase 36 work may
 * extend Plan 06's allowlist-shrink test to also gate this set
 * programmatically.
 */
const DRIFT_ALLOWLIST: ReadonlySet<string> = new Set();

function readPackageJsonDeps(pkg: string): Set<string> {
  const path = resolve(REPO_ROOT, `packages/${pkg}/package.json`);
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = json.dependencies ?? {};
  return new Set(
    Object.keys(deps)
      .filter((k) => k.startsWith("@comis/"))
      .map((k) => k.slice("@comis/".length)),
  );
}

function readTsconfigRefs(pkg: string): Set<string> {
  const path = resolve(REPO_ROOT, `packages/${pkg}/tsconfig.json`);
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    references?: Array<{ path?: string }>;
  };
  const refs = json.references ?? [];
  return new Set(
    refs
      .map((r) => r.path ?? "")
      .filter((p) => p.startsWith("../"))
      .map((p) => p.slice("../".length)),
  );
}

describe("architecture-graph -- dual-graph alignment (ARCH-BASE-02)", () => {
  it("test/architecture/tsconfig.madge.json paths block has exactly 14 @comis/* entries", () => {
    const tsconfigMadge = JSON.parse(
      readFileSync(TSCONFIG_MADGE_PATH, "utf8"),
    ) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const paths = tsconfigMadge.compilerOptions.paths;
    const keys = Object.keys(paths);
    expect(
      keys.length,
      "tsconfig.madge.json must have exactly 14 paths entries (12 workspace packages + 2 new skills subpaths per SKILLS-SPLIT-04; Phase 33)",
    ).toBe(14);
    for (const k of keys) {
      expect(
        k.startsWith("@comis/"),
        `path key ${k} must start with @comis/`,
      ).toBe(true);
      const target = paths[k]?.[0] ?? "";
      // Pitfall 5 (RES-PIT-5): path target must point at a SOURCE file under
      // packages/*/src/ — never under dist/. Post-Phase-33 the skills subpath
      // entries point at packages/skills/src/{skills,tools,platform-tools}/index.ts
      // (per SKILLS-SPLIT-04), so the legacy "ends with /src/index.ts" check
      // is broadened to "contains /src/ AND ends with /index.ts AND does not
      // contain /dist/".
      expect(
        target.includes("/src/") && target.endsWith("/index.ts") && !target.includes("/dist/"),
        `path target ${target} must point at a /src/.../index.ts file (NOT dist — RES-PIT-5)`,
      ).toBe(true);
    }
  });

  it("every packages/*/tsconfig.json `references` matches §2.2 target graph", () => {
    const violations: string[] = [];
    for (const pkg of WORKSPACE_PACKAGES) {
      const actual = readTsconfigRefs(pkg);
      const expected = TARGET_GRAPH[pkg];
      // The Phase 27 baseline is exact-match per package: TARGET_GRAPH already
      // accounts for L1-L26 open edges. Future phases narrow TARGET_GRAPH as
      // L-IDs close; the test stays exact.
      for (const requiredDep of expected) {
        if (!actual.has(requiredDep)) {
          violations.push(
            `packages/${pkg}/tsconfig.json missing reference to ../${requiredDep} (per §2.2 target)`,
          );
        }
      }
      for (const extraDep of actual) {
        if (!expected.has(extraDep)) {
          if (!(WORKSPACE_PACKAGES as readonly string[]).includes(extraDep)) {
            violations.push(
              `packages/${pkg}/tsconfig.json has reference to unknown package ../${extraDep}`,
            );
          } else {
            violations.push(
              `packages/${pkg}/tsconfig.json has unexpected reference to ../${extraDep} (not in §2.2 target)`,
            );
          }
        }
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "tsconfig.json `references` blocks must align with the §2.2 target package graph (CLOSED SET per GUARDRAILS-02 — no allowlist).",
        violations: violations.map(structureViolation),
        suggestedFix:
          'Add the missing `{ "path": "../<dep>" }` reference, OR remove the unknown reference. If the divergence is intentional and tracked by an L-ID, update TARGET_GRAPH in this file and cite the L-ID with an inline comment.',
        designRef:
          "design §2.2 (target package graph) / GUARDRAILS-02 (closed set; no L-ID allowlist)",
        allowlistRef: "(none — closed set per GUARDRAILS-02)",
      }),
    ).toEqual([]);
  });

  it("every packages/*/package.json @comis/* `dependencies` matches §2.2 target graph", () => {
    const violations: string[] = [];
    for (const pkg of WORKSPACE_PACKAGES) {
      const actual = readPackageJsonDeps(pkg);
      const expected = TARGET_GRAPH[pkg];
      for (const requiredDep of expected) {
        if (!actual.has(requiredDep)) {
          violations.push(
            `packages/${pkg}/package.json missing @comis/${requiredDep} in dependencies (per §2.2 target)`,
          );
        }
      }
      for (const extraDep of actual) {
        // DRIFT_ALLOWLIST tracked intentional pkg-json/tsconfig divergences
        // (e.g., legacy cli:agent runtime dep without tsconfig ref). Phase 35
        // Plan 35-05 (WEB-CONTRACTS-03) emptied DRIFT_ALLOWLIST; any future
        // divergence requires a PR + L-ID assignment.
        const driftKey = `${pkg}:${extraDep}`;
        if (DRIFT_ALLOWLIST.has(driftKey)) continue;
        if (!expected.has(extraDep)) {
          if (!(WORKSPACE_PACKAGES as readonly string[]).includes(extraDep)) {
            violations.push(
              `packages/${pkg}/package.json has unknown @comis/${extraDep} dep`,
            );
          } else {
            violations.push(
              `packages/${pkg}/package.json has unexpected @comis/${extraDep} dep (not in §2.2 target and not in DRIFT_ALLOWLIST)`,
            );
          }
        }
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "package.json @comis/* `dependencies` must align with the §2.2 target package graph (CLOSED SET per GUARDRAILS-02 — no allowlist).",
        violations: violations.map(structureViolation),
        suggestedFix:
          'Add the missing `"@comis/<dep>": "workspace:*"` to dependencies, OR remove the unknown dep. If the divergence is intentional and tracked by an L-ID, update TARGET_GRAPH or DRIFT_ALLOWLIST in this file with an inline rationale.',
        designRef: "design §2.2 / GUARDRAILS-02 (closed set)",
        allowlistRef: "(none — closed set per GUARDRAILS-02; DRIFT_ALLOWLIST is empty post-Phase-35)",
      }),
    ).toEqual([]);
  });

  it("tsconfig refs and package.json deps match each other (no drift, except DRIFT_ALLOWLIST)", () => {
    const violations: string[] = [];
    for (const pkg of WORKSPACE_PACKAGES) {
      const tsRefs = readTsconfigRefs(pkg);
      const pkgDeps = readPackageJsonDeps(pkg);
      const onlyInTsconfig = [...tsRefs].filter((d) => !pkgDeps.has(d));
      const onlyInPkgJson = [...pkgDeps].filter((d) => !tsRefs.has(d));
      for (const d of onlyInTsconfig) {
        const driftKey = `${pkg}:${d}`;
        if (DRIFT_ALLOWLIST.has(driftKey)) continue;
        violations.push(
          `packages/${pkg}: tsconfig refs ${d} but package.json does not depend on @comis/${d}`,
        );
      }
      for (const d of onlyInPkgJson) {
        const driftKey = `${pkg}:${d}`;
        if (DRIFT_ALLOWLIST.has(driftKey)) continue;
        violations.push(
          `packages/${pkg}: package.json depends on @comis/${d} but tsconfig does not reference it`,
        );
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "tsconfig `references` and package.json `dependencies` (filtered to @comis/*) must match exactly — drift is a stale-build hazard. " +
          "Intentional divergences are recorded in the DRIFT_ALLOWLIST constant at the top of this test file (empty as of Phase 35 Plan 35-05 — WEB-CONTRACTS-03). " +
          "If a new divergence is intentional, add it to DRIFT_ALLOWLIST in this file with an inline rationale + L-ID; the allowlist follows shrink-only semantics by convention.",
        violations: violations.map(structureViolation),
        suggestedFix:
          "Both files must list the same set of @comis/* deps. If a package needs a type-only reference (no runtime), keep it in tsconfig refs AND package.json devDependencies (or use workspace:* in dependencies for runtime). " +
          "For intentional divergence, see DRIFT_ALLOWLIST in this file — adding entries requires a PR review + L-ID assignment + design-doc citation.",
        designRef: "design §2.2 / GUARDRAILS-02 (closed set)",
        allowlistRef: "(none — closed set per GUARDRAILS-02; DRIFT_ALLOWLIST is empty post-Phase-35)",
      }),
    ).toEqual([]);
  });

  it("every DRIFT_ALLOWLIST entry corresponds to a live divergence (catch stale exemptions)", () => {
    // Without this gate, closing a divergence in a later phase without
    // pruning the matching DRIFT_ALLOWLIST entry leaves a stale exemption
    // that silently blesses any future regression on the same edge (CR-WR-06).
    const stale: string[] = [];
    for (const entry of DRIFT_ALLOWLIST) {
      const [pkg, dep] = entry.split(":") as [WorkspacePackage, string];
      if (!(WORKSPACE_PACKAGES as readonly string[]).includes(pkg)) {
        stale.push(`${entry}: package '${pkg}' is not in WORKSPACE_PACKAGES`);
        continue;
      }
      const tsRefs = readTsconfigRefs(pkg);
      const pkgDeps = readPackageJsonDeps(pkg);
      const inTsconfig = tsRefs.has(dep);
      const inPkgJson = pkgDeps.has(dep);
      // A real divergence has the dep in exactly one of the two graphs.
      // If both are true OR both are false, the entry is no longer load-bearing.
      if (inTsconfig === inPkgJson) {
        stale.push(
          `${entry}: tsconfig=${inTsconfig}, package.json=${inPkgJson} — divergence resolved, prune this entry`,
        );
      }
    }
    expect(
      stale,
      formatViolations({
        description:
          "DRIFT_ALLOWLIST contains stale exemptions — the underlying divergence has been resolved, but the entry still grants a license to differ.",
        violations: stale.map(structureViolation),
        suggestedFix:
          "Remove the stale entry from DRIFT_ALLOWLIST. The allowlist follows shrink-only semantics by convention; an entry whose divergence is gone must be pruned in the same PR that closed the divergence.",
        designRef: "design §2.2 / §1.3 L17",
        allowlistRef: "DRIFT_ALLOWLIST (shrink-only by convention)",
      }),
    ).toEqual([]);
  });
});
