// SPDX-License-Identifier: Apache-2.0
/**
 * Dual-graph alignment test.
 *
 * Asserts three invariants:
 *   1. Every packages/*\/tsconfig.json `references` block aligns with the
 *      target package graph (closed set; no allowlist).
 *   2. Every packages/*\/package.json `dependencies` (filtered to @comis/*)
 *      aligns with the target graph (closed set; no allowlist).
 *   3. The two graphs (#1 + #2) match each other — drift between
 *      tsconfig refs and package.json deps is a covert source of cycles
 *      and stale-build risk. Filtered through DRIFT_ALLOWLIST for
 *      INTENTIONAL divergences (currently empty — see DRIFT_ALLOWLIST
 *      inline comment).
 *
 * Also asserts:
 *   - test/architecture/tsconfig.madge.json `paths` block has exactly
 *     14 entries (12 workspace packages + 2 skills subpaths; `web` and
 *     `comis` umbrella excluded). Regression coverage; the count grew
 *     from 12 to 14 with the skills package split.
 *
 * NOTE: the dist-mode madge gate AND `tsc -b --dry` gate live in
 * .github/workflows/ci.yml — NOT here. This file's scope is
 * "tsconfig + package.json static-graph alignment", which is a different
 * concern from runtime cycle detection.
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
 * field and the issue prose in the snippet block.
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
 * Target package graph.
 *
 * Each value is the set of @comis/* packages that the key package SHOULD
 * reference in BOTH tsconfig.json `references` and package.json `dependencies`.
 *
 * NOTE on cli: TARGET_GRAPH.cli does NOT include "agent" because cli's
 * tsconfig.json does not reference ../agent. cli/package.json no longer
 * depends on @comis/agent either; the previous runtime substring imports
 * were retargeted to @comis/core. The @comis/memory edge was temporarily
 * closed after secrets + auth moved to daemon RPC, and is re-opened for
 * the offline secrets bootstrap path (L11 re-open, one bounded adapter site:
 * `util/offline-secrets-store.ts`).
 *
 * NOTE on agent vs skills: packages/agent does NOT import @comis/skills
 * (only structural-typing comments reference it). agent's TARGET_GRAPH is
 * [shared, core, scheduler] — no skills edge, no infra edge, no memory edge.
 * Agent's type-only imports for ContextStorePort + SessionStorePort + row
 * DTOs resolve through @comis/core, and the lone OAuth-store value-import
 * lives in daemon's setup-agents.ts.
 */
const TARGET_GRAPH: Record<WorkspacePackage, ReadonlySet<string>> = {
  shared: new Set(),
  core: new Set(["shared"]),
  // infra → observability is a static first-class arrow.
  // `packages/infra/src/logging/redact-transport.ts` is a static re-export
  // of `@comis/observability/dist/redact/pino-redact-transport.js`
  // (previously a `createRequire(import.meta.url)` runtime shim that hid
  // the dep from `tsc`). The fs-safe primitives that anchored the
  // bidirectional cycle moved from @comis/infra to @comis/observability,
  // so the graph is now one-arrow:
  //   @comis/core ← @comis/observability ← @comis/infra
  infra: new Set(["shared", "core", "observability"]),
  memory: new Set(["shared", "core"]),
  scheduler: new Set(["shared", "core"]),
  // skills: no infra edge. Logger type imports from @comis/core; isDocker
  // lives at packages/core/src/runtime/is-docker.ts.
  //
  // @comis/observability edge — `writeRegularFile` / `ensureContainedDir` from
  // packages/observability/src/shared/fs-safe.ts back the 3-file OAuth token
  // store (`<server>.json` / `<server>.client.json` / `<server>.meta.json` at
  // 0o600 in 0o700 dir under ~/.comis/mcp-tokens/). Observability depends only
  // on @comis/core + @comis/shared (both already skills deps) so the edge is acyclic.
  //
  // @comis/agent edge (AUTHOR-02 / Phase 174-04): pipeline-tool.ts's from_intent
  // action imports `synthesizeFromIntent` to deterministically expand a one-line
  // intent into a validated ExecutionGraph (then dispatches it via graph.execute
  // so governance applies). The edge is FORWARD + acyclic: agent depends only on
  // shared/core/observability/scheduler (none of which reach skills — see the
  // agent entry's "no skills entry here" note), so skills → agent introduces no
  // cycle (verified via cycles + cycles:refs).
  skills: new Set(["shared", "core", "observability", "agent"]),
  // agent: structurally references skills' types only (comments) — no actual
  // import edge, so no skills entry here. No @comis/infra edge: logger
  // contract types canonically live in @comis/core. No @comis/memory edge:
  // agent's type-only imports resolve through @comis/core; the OAuth-store
  // value-import lives in daemon.
  //
  // @comis/observability runtime edge: pi-executor.ts imports
  // `createTrajectoryRecorder` and `attachTrajectoryToEventBus` for the
  // per-session trajectory writer. Direction is forward
  // (agent → observability → infra/core/shared); no cycle.
  agent: new Set(["shared", "core", "observability", "scheduler"]),
  // channels: no agent dep — the shared/ pipeline carriers (inbound +
  // execution) moved to @comis/orchestrator. No @comis/infra edge either.
  channels: new Set(["shared", "core"]),
  // orchestrator: depends on shared, core, agent, channels.
  orchestrator: new Set(["shared", "core", "agent", "channels"]),
  // gateway: no agent OAuth-helpers back-edge — OAuth helpers live in
  // @comis/core.
  gateway: new Set(["shared", "core"]),
  // cli: depends on shared, core, observability, memory, and daemon.
  // config-write hook in sync-tooling needs the config-audit JSONL append
  // helpers (observability). The @comis/memory edge is re-opened for the
  // offline secrets bootstrap path (daemon-free first-time setup, L11 re-open):
  // `util/offline-secrets-store.ts` is the single allowed import site; all
  // other CLI memory access still routes through daemon RPC.
  //
  // @comis/daemon edge (W14 obs-llm-troubleshooting): the OFFLINE obs fallback.
  // `comis explain`/`comis fleet` reuse the daemon's exported pure assemblers
  // (assembleIncidentReportFromSources / makeRealReader /
  // assembleFleetHealthReport) to build the post-mortem directly from the
  // local ~/.comis files when the gateway is unreachable — the session data
  // is on local disk and must not require a live daemon to read. Single
  // bounded import site: `util/offline-obs.ts`. Acyclic (daemon has no cli
  // edge); live-daemon access still routes through RPC.
  cli: new Set(["shared", "core", "observability", "memory", "daemon"]),
  daemon: new Set([
    "shared",
    "core",
    "infra",
    "memory",
    "observability",
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
 * Currently empty: the last divergence (`infra:observability`) was closed by:
 *   1. Moving fs-safe.ts from @comis/infra to @comis/observability, which
 *      removed the `observability → infra` arrow that made the static
 *      back-edge cyclic.
 *   2. Rewriting `packages/infra/src/logging/redact-transport.ts` from a
 *      `createRequire(import.meta.url)` runtime shim to a static re-export,
 *      making `infra → observability` a first-class TypeScript type-graph
 *      arrow visible to both `tsc --build` and `madge`.
 *   3. Adding `{ "path": "../observability" }` to
 *      `packages/infra/tsconfig.json` references, so the tsconfig and
 *      package.json now agree (no drift).
 *
 * The allowlist mechanism mirrors test/support/architecture-allowlist.ts
 * shrink-only semantics: entries can be REMOVED but should NOT be ADDED
 * without a refactor PR + design-doc citation. PR review catches additions.
 */
const DRIFT_ALLOWLIST: ReadonlySet<string> = new Set([]);

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

describe("architecture-graph -- dual-graph alignment", () => {
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
      "tsconfig.madge.json must have exactly 14 paths entries (12 workspace packages + 2 skills subpaths)",
    ).toBe(14);
    for (const k of keys) {
      expect(
        k.startsWith("@comis/"),
        `path key ${k} must start with @comis/`,
      ).toBe(true);
      const target = paths[k]?.[0] ?? "";
      // path target must point at a SOURCE file under packages/*/src/ —
      // never under dist/. The skills subpath entries point at
      // packages/skills/src/{skills,tools,platform-tools}/index.ts, so the
      // check is "contains /src/ AND ends with /index.ts AND does not
      // contain /dist/".
      expect(
        target.includes("/src/") && target.endsWith("/index.ts") && !target.includes("/dist/"),
        `path target ${target} must point at a /src/.../index.ts file (NOT dist)`,
      ).toBe(true);
    }
  });

  it("every packages/*/tsconfig.json `references` matches the target graph", () => {
    const violations: string[] = [];
    for (const pkg of WORKSPACE_PACKAGES) {
      const actual = readTsconfigRefs(pkg);
      const expected = TARGET_GRAPH[pkg];
      // Baseline is exact-match per package: TARGET_GRAPH is the source of
      // truth for the allowed graph; the test stays exact.
      for (const requiredDep of expected) {
        if (!actual.has(requiredDep)) {
          violations.push(
            `packages/${pkg}/tsconfig.json missing reference to ../${requiredDep} (per target graph)`,
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
              `packages/${pkg}/tsconfig.json has unexpected reference to ../${extraDep} (not in target graph)`,
            );
          }
        }
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "tsconfig.json `references` blocks must align with the target package graph (CLOSED SET — no allowlist).",
        violations: violations.map(structureViolation),
        suggestedFix:
          'Add the missing `{ "path": "../<dep>" }` reference, OR remove the unknown reference. If the divergence is intentional, update TARGET_GRAPH in this file with an inline rationale.',
        designRef:
          "target package graph — closed set, no allowlist",
        allowlistRef: "(none — closed set)",
      }),
    ).toEqual([]);
  });

  it("every packages/*/package.json @comis/* `dependencies` matches the target graph", () => {
    const violations: string[] = [];
    for (const pkg of WORKSPACE_PACKAGES) {
      const actual = readPackageJsonDeps(pkg);
      const expected = TARGET_GRAPH[pkg];
      for (const requiredDep of expected) {
        if (!actual.has(requiredDep)) {
          violations.push(
            `packages/${pkg}/package.json missing @comis/${requiredDep} in dependencies (per target graph)`,
          );
        }
      }
      for (const extraDep of actual) {
        // DRIFT_ALLOWLIST tracks intentional pkg-json/tsconfig divergences
        // (e.g., a runtime dep without a tsconfig ref). DRIFT_ALLOWLIST is
        // currently empty; any future divergence requires a PR.
        const driftKey = `${pkg}:${extraDep}`;
        if (DRIFT_ALLOWLIST.has(driftKey)) continue;
        if (!expected.has(extraDep)) {
          if (!(WORKSPACE_PACKAGES as readonly string[]).includes(extraDep)) {
            violations.push(
              `packages/${pkg}/package.json has unknown @comis/${extraDep} dep`,
            );
          } else {
            violations.push(
              `packages/${pkg}/package.json has unexpected @comis/${extraDep} dep (not in target graph and not in DRIFT_ALLOWLIST)`,
            );
          }
        }
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "package.json @comis/* `dependencies` must align with the target package graph (CLOSED SET — no allowlist).",
        violations: violations.map(structureViolation),
        suggestedFix:
          'Add the missing `"@comis/<dep>": "workspace:*"` to dependencies, OR remove the unknown dep. If the divergence is intentional, update TARGET_GRAPH or DRIFT_ALLOWLIST in this file with an inline rationale.',
        designRef: "target package graph (closed set)",
        allowlistRef: "(none — closed set; DRIFT_ALLOWLIST is empty)",
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
          "Intentional divergences are recorded in the DRIFT_ALLOWLIST constant at the top of this test file (currently empty). " +
          "If a new divergence is intentional, add it to DRIFT_ALLOWLIST in this file with an inline rationale; the allowlist follows shrink-only semantics by convention.",
        violations: violations.map(structureViolation),
        suggestedFix:
          "Both files must list the same set of @comis/* deps. If a package needs a type-only reference (no runtime), keep it in tsconfig refs AND package.json devDependencies (or use workspace:* in dependencies for runtime). " +
          "For intentional divergence, see DRIFT_ALLOWLIST in this file — adding entries requires a PR review + design-doc citation.",
        designRef: "target package graph (closed set)",
        allowlistRef: "(none — closed set; DRIFT_ALLOWLIST is empty)",
      }),
    ).toEqual([]);
  });

  it("every DRIFT_ALLOWLIST entry corresponds to a live divergence (catch stale exemptions)", () => {
    // Without this gate, closing a divergence without pruning the matching
    // DRIFT_ALLOWLIST entry leaves a stale exemption that silently blesses
    // any future regression on the same edge.
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
        designRef: "target package graph",
        allowlistRef: "DRIFT_ALLOWLIST (shrink-only by convention)",
      }),
    ).toEqual([]);
  });
});
