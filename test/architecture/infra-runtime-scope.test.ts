// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/infra runtime-scope invariant.
 *
 * No implementation package other than `@comis/daemon` may value-import
 * `@comis/infra` at runtime. The umbrella `@comis/comis` package may keep
 * its facade re-export (`import * as infra from "@comis/infra"` in
 * `packages/comis/src/index.ts` + the mirror file `packages/comis/src/infra.ts`).
 * `@comis/infra` itself self-imports during build — also allowed.
 *
 * Type-only imports of `@comis/infra` types (notably `ComisLogger` consumed
 * by 30+ daemon-internal files at HEAD) are allowed ANYWHERE — they
 * disappear at compile time. The `valueImportsOnly: true` flag implements
 * this distinction.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenImports } from "../support/import-checker.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

// Directories where value-imports of @comis/infra are allowed at runtime.
//
// `packages/observability/src/` is intentionally absent: the fs-safe primitives
// (appendRegularFile / writeRegularFile / SymlinkParentRejected /
// FileSizeLimitExceeded / PathEscapesConfinementError) live inside
// @comis/observability itself, so no source file under
// packages/observability/src/ value-imports @comis/infra. The dep arrow
// points the OTHER way (infra → observability via the static re-export in
// logging/redact-transport.ts).
const ALLOWED_INFRA_RUNTIME_DIRS: readonly string[] = [
  "packages/daemon/src/",         // composition root (runtime wiring)
  "packages/infra/src/",          // self-imports during build
] as const;

// Umbrella facade allowed value-imports.
const FACADE_REEXPORT_ALLOWLIST: readonly string[] = [
  "packages/comis/src/index.ts",  // `import * as infra from "@comis/infra"` namespace re-export
  "packages/comis/src/infra.ts",  // `export * from "@comis/infra"` mirror file
] as const;

describe("infra-runtime-scope — only daemon/infra/umbrella value-import @comis/infra", () => {
  it("packages/*/src value-imports of @comis/infra are restricted to daemon + infra + umbrella facade", () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: PACKAGES_ROOT,
      forbiddenPackage: "@comis/infra",
      excludeFileSuffixes: [".test.ts"],
      valueImportsOnly: true,
    });

    const offenders = violations.filter((v) => {
      // Convert absolute file path to relative-from-repo-root for matching.
      const relativeFromRepo = v.file.startsWith(REPO_ROOT)
        ? v.file.slice(REPO_ROOT.length + 1)
        : v.file;
      if (ALLOWED_INFRA_RUNTIME_DIRS.some((d) => relativeFromRepo.startsWith(d))) {
        return false;
      }
      if (FACADE_REEXPORT_ALLOWLIST.some((p) => relativeFromRepo === p)) {
        return false;
      }
      return true;
    });

    expect(
      offenders,
      formatViolations({
        description:
          "Only daemon and infra packages may value-import @comis/infra at runtime (umbrella facade allowed). Type-only imports of @comis/infra types are allowed anywhere.",
        violations: offenders.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          'Use `import type { ComisLogger } from "@comis/core"` for type-only consumers; inject the runtime logger via the `Deps` interface. The Pino-backed runtime implementation lives in @comis/infra and is wired only at the composition root (daemon).',
        designRef: "Logger injection via Deps interface",
        allowlistRef: "ALLOWED_INFRA_RUNTIME_DIRS + FACADE_REEXPORT_ALLOWLIST (in-file)",
      }),
    ).toEqual([]);

    // Coverage floor: assert findForbiddenImports descended into the whole
    // packages/*/src tree rather than bailing after one package. With the
    // L-allowlist closed to zero, there is no "must find violations"
    // backstop to catch a walker regression that silently visits only a
    // single directory. Empirical baseline at HEAD is ~1,290 .ts source
    // files across all packages; the largest single package is ~225 files,
    // so a floor of 500 catches "walker stuck in one package" while
    // leaving generous headroom for normal refactors.
    expect(
      checkedFiles,
      `sanity: findForbiddenImports must walk every packages/*/src tree; got ${checkedFiles} (expected >= 500 — current HEAD has ~1,290 source .ts files; largest single package is ~225)`,
    ).toBeGreaterThanOrEqual(500);
  });

  // ---------------------------------------------------------------------------
  // Phase 122 P3 (SEC-07): a NAMED, focused regression guard for the three
  // terminal scope/egress files. The global rule above already covers them (they
  // live under packages/skills/src/), but the EgressControlPort design has a
  // BINDING constraint — the worker-side egress code depends on the PORT TYPE in
  // @comis/core and NEVER value-imports @comis/infra. Naming the files makes that
  // constraint self-documenting and turns a future infra-import regression into a
  // targeted, legible failure (not a needle in the 1,290-file global haystack).
  // ---------------------------------------------------------------------------
  it("terminal scope/egress + caps + reaper files (scope-args, env-scrub, egress-relay, spawn-plan, terminal-caps, terminal-reaper) value-import zero @comis/infra (SEC-07 boundary)", () => {
    const TERMINAL_EGRESS_DIR = resolve(
      PACKAGES_ROOT,
      "skills/src/tools/builtin/terminal-driver",
    );
    const NAMED_FILES = [
      "terminal-scope-args.ts",
      "terminal-env-scrub.ts",
      "terminal-egress-relay.ts",
      // 122-06: the worker-side scope-jail composition seam. Imports only the
      // EgressControlPort/EgressMaterialization TYPES from @comis/core + the sibling
      // skills composers + node builtins — never @comis/infra (worker ↛ infra).
      "terminal-spawn-plan.ts",
      // 122-fix: the in-jail relay-as-init runtime (SEC-07). Spawned as a subprocess
      // inside the bwrap jail; imports ONLY node builtins (net / child_process) —
      // carries no secret, injects nothing, never @comis/infra.
      "egress-relay-init.ts",
      // P4 OPS-03/06: per-session caps — closure-local counters + injected clock; node + @comis/core types only, never @comis/infra.
      "terminal-caps.ts",
      // P4 TR-06/OPS-06: the reaper — injected-timer sweep (idle + wall-clock) + overflow;
      // TYPE-ONLY TimerPort/TimerHandle from @comis/core + injected nowMs, never @comis/infra.
      "terminal-reaper.ts",
    ] as const;

    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: TERMINAL_EGRESS_DIR,
      forbiddenPackage: "@comis/infra",
      excludeFileSuffixes: [".test.ts"],
      valueImportsOnly: true,
    });

    // Scope the assertion to exactly the named files (the directory holds ~20
    // terminal-driver modules; this guard is about the scope/egress boundary).
    const namedViolations = violations.filter((v) =>
      NAMED_FILES.some((f) => v.file.endsWith(`/${f}`)),
    );

    expect(
      namedViolations,
      formatViolations({
        description:
          "The terminal scope/egress + caps + reaper files (terminal-scope-args.ts, terminal-env-scrub.ts, terminal-egress-relay.ts, terminal-spawn-plan.ts, egress-relay-init.ts, terminal-caps.ts, terminal-reaper.ts) MUST NOT value-import @comis/infra — they depend only on @comis/core types (the EgressControlPort; the structural limits shape + injected nowMs for terminal-caps; the TimerPort/TimerHandle + injected nowMs for terminal-reaper) + node builtins (SEC-07 trust boundary; worker ↛ infra).",
        violations: namedViolations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          'Import the EgressControlPort as a TYPE from "@comis/core" and use node `net`/`fs` builtins; the concrete proxy impl is wired by the daemon (composition root) and injected via the port. Never value-import @comis/infra from a worker-side file.',
        designRef: "SEC-07 / 122-RESEARCH EgressControlPort placement decision",
      }),
    ).toEqual([]);

    // Sanity: the walker actually descended into the terminal-driver dir (catch a
    // path typo that would silently pass with zero files checked).
    expect(
      checkedFiles,
      `sanity: the terminal-driver directory must contain source files; got ${checkedFiles}`,
    ).toBeGreaterThan(0);
  });
});
