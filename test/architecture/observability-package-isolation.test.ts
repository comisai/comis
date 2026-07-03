// SPDX-License-Identifier: Apache-2.0
/**
 * Lock-in: @comis/observability imports neither @comis/agent nor
 * @comis/daemon nor @comis/cli nor @comis/orchestrator. Top-level
 * defense-in-depth boundary at the architecture-allowlist level.
 *
 * Mirrors `cli-no-agent-no-infra.test.ts`: source-level AST walker via
 * `findForbiddenImports` PLUS grep-assertions on `package.json` and
 * `tsconfig.json` — so a future PR that re-adds a workspace dep or
 * tsconfig reference is caught by the architecture suite before any
 * source-level import regression.
 *
 * The four forbidden packages are the consumer-tier siblings of
 * observability: agent runs LLM execution flow, daemon hosts the
 * composition root, cli is the operator entrypoint, orchestrator owns
 * inbound pipeline + execution coordination. None of them should be
 * pulled into the observability substrate — substrate is a leaf
 * dependency of agent / daemon / orchestrator, not the other way around.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenImports } from "../support/import-checker.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const OBSERVABILITY_SRC = resolve(REPO_ROOT, "packages/observability/src");
const CORE_SRC = resolve(REPO_ROOT, "packages/core/src");

describe("@comis/observability isolation — no @comis/agent + @comis/daemon + @comis/cli + @comis/orchestrator", () => {
  for (const forbidden of [
    "@comis/agent",
    "@comis/daemon",
    "@comis/cli",
    "@comis/orchestrator",
  ] as const) {
    it(`observability/src imports do NOT include ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: OBSERVABILITY_SRC,
        forbiddenPackage: forbidden,
        excludeFileSuffixes: [".test.ts"],
      });
      expect(
        violations,
        formatViolations({
          description: `observability/src imports must not include ${forbidden}`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            "Substrate is a leaf dep of agent/daemon/cli/orchestrator. Retarget the import to @comis/core / @comis/infra / @comis/shared (the substrate's only three allowed peer packages).",
          designRef:
            "@comis/observability must remain a leaf in the dep graph",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one observability/src file",
      ).toBeGreaterThan(0);
    });
  }

  it("packages/observability/package.json declares no agent / daemon / cli / orchestrator dependency", () => {
    const pkg = readFileSync(
      resolve(REPO_ROOT, "packages/observability/package.json"),
      "utf8",
    );
    for (const forbidden of [
      "@comis/agent",
      "@comis/daemon",
      "@comis/cli",
      "@comis/orchestrator",
    ]) {
      expect(
        pkg,
        `package.json must not list ${forbidden}`,
      ).not.toMatch(new RegExp(`"${forbidden.replace("/", "\\/")}"`));
    }
  });

  it("packages/observability/tsconfig.json declares no reference to ../agent / ../daemon / ../cli / ../orchestrator", () => {
    const ts = readFileSync(
      resolve(REPO_ROOT, "packages/observability/tsconfig.json"),
      "utf8",
    );
    for (const forbiddenRef of [
      "../agent",
      "../daemon",
      "../cli",
      "../orchestrator",
    ]) {
      expect(
        ts,
        `tsconfig.json must not reference ${forbiddenRef}`,
      ).not.toMatch(
        new RegExp(`"path":\\s*"${forbiddenRef.replace("/", "\\/")}"`),
      );
    }
  });

  // The bidirectional package-deps cycle between @comis/infra and
  // @comis/observability was closed:
  //   - fs-safe.ts moved from @comis/infra to @comis/observability.
  //   - @comis/infra dep was dropped from @comis/observability/package.json
  //     and the corresponding tsconfig project reference.
  //   - redact-transport.ts was rewritten as a static re-export of
  //     @comis/observability/dist/redact/pino-redact-transport.js,
  //     and packages/infra/tsconfig.json gained `{ "path": "../observability" }`.
  // The resulting graph is one-direction: @comis/infra → @comis/observability.
  // This assertion locks the architectural invariant at the package-deps
  // layer. The companion forward-direction check
  // (`@comis/infra DOES depend on @comis/observability`) is the other
  // active case in this describe block.
  it("@comis/observability does NOT depend on @comis/infra", () => {
    const pkg = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, "packages/observability/package.json"),
        "utf8",
      ),
    );
    const deps = pkg.dependencies ?? {};
    expect(deps["@comis/infra"]).toBeUndefined();
  });

  it("@comis/infra DOES depend on @comis/observability (one-arrow preserved)", () => {
    const pkg = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, "packages/infra/package.json"),
        "utf8",
      ),
    );
    const deps = pkg.dependencies ?? {};
    expect(deps["@comis/observability"]).toBe("workspace:*");
  });
});

/**
 * Hexagonal renderer-port boundary lock (the Agent Transparency ship gate).
 * The activity rendering port
 * (`core/activity/channel-activity-renderer.ts`) and the strategy selector
 * (`core/activity/activity-strategy.ts`) live in `@comis/core`, NOT in
 * `@comis/channels` — that placement is a hard architectural constraint. The
 * channel strategy BODIES depend on
 * core (`channels → core` is allowed), never the reverse.
 *
 * This guard makes the placement permanent: any future file in `packages/core/`
 * OR `packages/observability/` that imports `@comis/channels` fails CI. The
 * global ship-gate rule reads literally "No file in `packages/core/` or
 * `packages/observability/` imports from `packages/channels/`." — this is the
 * mechanical enforcement of that rule.
 *
 * Mirrors the OBSERVABILITY_SRC pattern above: a source-level AST walk via
 * `findForbiddenImports` PLUS package.json + tsconfig grep assertions, so a
 * future PR that re-adds a workspace dep or a tsconfig project reference is
 * caught by the architecture suite before any source-level import regression.
 */
describe("core + observability isolation — neither imports @comis/channels (renderer-port-in-core lock)", () => {
  for (const [label, rootDir] of [
    ["core", CORE_SRC],
    ["observability", OBSERVABILITY_SRC],
  ] as const) {
    it(`${label}/src source imports do NOT include @comis/channels`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir,
        forbiddenPackage: "@comis/channels",
        excludeFileSuffixes: [".test.ts"],
      });
      expect(
        violations,
        formatViolations({
          description: `${label}/src must not import @comis/channels — the activity renderer port (ChannelActivityRenderer) + selectStrategy live in @comis/core; channels depend on core, never the reverse.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            "Move the port/type into core/activity (it already lives there) and import it from @comis/core. A channel-side renderer/strategy duplicate collapses the hexagonal boundary this project preserves — strike it.",
          designRef:
            "ship gate: no file in core/ or observability/ imports from channels/",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        `sanity: findForbiddenImports walked at least one ${label}/src file`,
      ).toBeGreaterThan(0);
    });
  }

  it("packages/core/package.json and packages/observability/package.json declare no @comis/channels dependency", () => {
    for (const pkgRel of [
      "packages/core/package.json",
      "packages/observability/package.json",
    ]) {
      const pkg = readFileSync(resolve(REPO_ROOT, pkgRel), "utf8");
      expect(
        pkg,
        `${pkgRel} must not list @comis/channels as a dependency`,
      ).not.toMatch(/"@comis\/channels"/);
    }
  });

  it("packages/core/tsconfig.json and packages/observability/tsconfig.json declare no reference to ../channels", () => {
    for (const tsRel of [
      "packages/core/tsconfig.json",
      "packages/observability/tsconfig.json",
    ]) {
      const ts = readFileSync(resolve(REPO_ROOT, tsRel), "utf8");
      expect(
        ts,
        `${tsRel} must not reference ../channels`,
      ).not.toMatch(/"path":\s*"\.\.\/channels"/);
    }
  });
});
