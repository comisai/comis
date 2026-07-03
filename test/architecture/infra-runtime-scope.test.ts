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
  // A NAMED, focused regression guard for the three terminal scope/egress
  // files. The global rule above already covers them (they
  // live under packages/skills/src/), but the EgressControlPort design has a
  // BINDING constraint — the worker-side egress code depends on the PORT TYPE in
  // @comis/core and NEVER value-imports @comis/infra. Naming the files makes that
  // constraint self-documenting and turns a future infra-import regression into a
  // targeted, legible failure (not a needle in the 1,290-file global haystack).
  // ---------------------------------------------------------------------------
  it("terminal scope/egress + caps + reaper + send-guard + attention files (scope-args, env-scrub, egress-relay, spawn-plan, terminal-caps, terminal-reaper, terminal-send-guards, terminal-classifier, terminal-auto-answer, terminal-loop-guard, terminal-attention-emitter, terminal-tmux-backend) value-import zero @comis/infra (worker ↛ infra boundary)", () => {
    const TERMINAL_EGRESS_DIR = resolve(
      PACKAGES_ROOT,
      "skills/src/tools/builtin/terminal-driver",
    );
    const NAMED_FILES = [
      "terminal-scope-args.ts",
      "terminal-env-scrub.ts",
      "terminal-egress-relay.ts",
      // the worker-side scope-jail composition seam. Imports only the
      // EgressControlPort/EgressMaterialization TYPES from @comis/core + the sibling
      // skills composers + node builtins — never @comis/infra (worker ↛ infra).
      "terminal-spawn-plan.ts",
      // the in-jail relay-as-init runtime. Spawned as a subprocess
      // inside the bwrap jail; imports ONLY node builtins (net / child_process) —
      // carries no secret, injects nothing, never @comis/infra.
      "egress-relay-init.ts",
      // per-session caps — closure-local counters + injected clock; node + @comis/core types only, never @comis/infra.
      "terminal-caps.ts",
      // the reaper — injected-timer sweep (idle + wall-clock) + overflow;
      // TYPE-ONLY TimerPort/TimerHandle from @comis/core + injected nowMs, never @comis/infra.
      "terminal-reaper.ts",
      // the send-path guards (keystroke audit + cap enforcement) —
      // value-import only @comis/core's scrubSecretsFromText + the local tool-helpers
      // (throwToolError) + TYPE-ONLY the tool/registry shapes, never @comis/infra/observability.
      "terminal-send-guards.ts",
      // ---------------------------------------------------------------------
      // Pre-register ALL the skills-side worker files in ONE place. The test
      // FILTERS real import-scan violations by this named list, so a name for a
      // not-yet-created file is INERT (contributes zero violations) until that
      // file exists; naming them here makes a future infra-import regression in
      // any of them a legible, targeted failure (the house convention). The
      // global rule already forbids the infra import in all of them.
      // ---------------------------------------------------------------------
      // The pure state classifier (cursor-parked gate) — node builtins +
      // the TYPE-ONLY EmulatorSnapshot from terminal-render, never @comis/infra.
      "terminal-classifier.ts",
      // The safe-only auto-answer policy — a pure decision over
      // operator inputs + the screen; value-imports only node builtins, never
      // @comis/infra (any audited-value redaction happens in the woken turn).
      "terminal-auto-answer.ts",
      // The normalized region-scoped loop guard — node:crypto +
      // an injected clock + a closure-local ring, never @comis/infra.
      "terminal-loop-guard.ts",
      // The in-worker fd3 attention-event emitter — node
      // builtins + the local terminal-ipc framer, never @comis/infra (NOT YET
      // CREATED — inert until it is added).
      "terminal-attention-emitter.ts",
      // The tmux worker backend (named-session re-attach) — node
      // builtins behind the same loadBackend seam, never @comis/infra (NOT YET
      // CREATED — inert until it is added).
      "terminal-tmux-backend.ts",
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
          "The terminal scope/egress + caps + reaper + send-guard + P5 attention files (terminal-scope-args.ts, terminal-env-scrub.ts, terminal-egress-relay.ts, terminal-spawn-plan.ts, egress-relay-init.ts, terminal-caps.ts, terminal-reaper.ts, terminal-send-guards.ts, terminal-classifier.ts, terminal-auto-answer.ts, terminal-loop-guard.ts, terminal-attention-emitter.ts, terminal-tmux-backend.ts) MUST NOT value-import @comis/infra — they depend only on @comis/core (types + scrubSecretsFromText) + the local tool-helpers + node builtins (SEC-07 trust boundary; worker ↛ infra/observability).",
        violations: namedViolations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          'Import the EgressControlPort as a TYPE from "@comis/core" and use node `net`/`fs` builtins; the concrete proxy impl is wired by the daemon (composition root) and injected via the port. Never value-import @comis/infra from a worker-side file.',
        designRef: "EgressControlPort placement decision",
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
