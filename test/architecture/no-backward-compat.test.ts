// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide no-backward-compat invariant (Phase 38 — BC-REM-02, 03,
 * 04, 05, 06, 07, 21, 23).
 *
 * Scope (intentional, by design): production source under `packages/*\/src/`
 * only. This matches the npm-tarball scope — files included in the
 * published `@comis/*` tarballs by `prepack.js` (the umbrella `comisai`
 * package bundles each `packages/*\/dist/` built from `packages/*\/src/`).
 * Non-shipped paths (`test/support/`, root config files, `scripts/`,
 * `tools/`, `website/`, `packages/comis/` umbrella) are out of scope
 * because they do not reach end-users and therefore cannot regress the
 * shipped contract.
 *
 * If you need to add a BC-text exemption for a file outside
 * `packages/*\/src/`, that file is outside the ratchet's scope by
 * definition — no allowlist entry is needed. The rule's failure mode
 * (per-line citation with absolute path) makes the in-scope/out-of-scope
 * distinction visible at review time.
 *
 * Enforces the v2.1 "no backward-compat" policy (see CLAUDE.md user
 * memory `feedback_no_backward_compat`) by gating production source at
 * `packages/*\/src/` against:
 *
 *  - BC-REM-02 — text /backward.?compat|backcompat|legacy.?(alias|mode|fallback)/i
 *    outside `noBackwardCompatAllowlist` (line-pinned) and outside the
 *    in-file `BC_REM_02_PATH_TAIL_ALLOWLIST` (pre-existing-benign
 *    sub-allowlist; see comment block on the constant).
 *  - BC-REM-03 — `@deprecated` JSDoc annotations (zero permitted; the
 *    v2.1 policy is no-deprecation-period: delete, don't deprecate).
 *  - BC-REM-04 — `agent/src/index.ts` contains no `export { X as Y } from "..."`
 *    alias re-exports (Phase 29 PUB-EXPORTS-03 closure).
 *  - BC-REM-05 — `skills/src/index.ts` + `skills/src/skills/index.ts` do
 *    not re-export names from `@comis/shared` (Phase 33 SKILLS-SPLIT closure).
 *  - BC-REM-06 — `agent/src/index.ts` does not export `createCommandHandler`
 *    or `CommandHandlerDeps` (moved to `@comis/orchestrator` in Phase 32).
 *  - BC-REM-07 — `cli/src/index.ts` public value exports are exactly
 *    `{ withClient, credentialsStep }` (Phase 29 PUB-EXPORTS-02 closure).
 *  - BC-REM-21 — `getGlobalHookRunner` / `hook-runner-global` symbols
 *    return zero hits (Phase 30 closure preserved; defense-in-depth).
 *  - BC-REM-23 — no `eslint-disable` comment cites "legacy" or
 *    "backward compat" as justification (pragma-drift threat T-38-06-01).
 *
 * Two-tier allowlist model (matches existing architecture-test idiom,
 * see source-rules.test.ts L23_ALLOWLIST):
 *
 *   1. `noBackwardCompatAllowlist` (test/support/architecture-allowlist.ts)
 *      — line-pinned permanent-historical-reference entries. Currently 1
 *      entry: `core/src/config/migrate.ts:1` (the kept Wave 5b config
 *      migration carrying `@migration-since: 2026-04-22; remove-after:
 *      v2.2`). Max 3 entries per BC-REM-22.
 *
 *   2. `BC_REM_02_PATH_TAIL_ALLOWLIST` (this file, below) — pre-existing
 *      benign-text path-tails captured at Phase 38 baseline (Wave-5b
 *      close). Each file in this list contains text that matches the
 *      BC-REM-02 regex but is NOT a live BC shim (documentation about
 *      absence/defaults/policy, OR pre-existing BC code paths that fall
 *      outside Phase 38's deletion scope — e.g. web/router aliases,
 *      skills/exec-tool deps-shape doc strings, env-handlers .env-fallback
 *      branch). The architecture rule's purpose is to ratchet against
 *      *new* BC code; pre-existing benign text in this list does not
 *      regress the no-backward-compat ratchet. A future wave that
 *      deletes any of these BC code paths SHRINKS this list (a positive
 *      shrink-only signal); reintroducing a removed entry would require
 *      an explicit `noBackwardCompatAllowlist` entry.
 *
 * Pragma-drift guard: this rule does NOT honor any `// eslint-disable`
 * or `// @no-backward-compat: allow` pragma. BC-REM-23 explicitly forbids
 * justifying a violation via `eslint-disable -- legacy ...`. The only
 * exemption path is the two allowlists above, both of which are visible
 * in test/support and reviewable in PR diffs.
 *
 * Pattern analog: `raw-throw.test.ts` (per-line scan with file-path +
 * line-number violation citations) + `source-rules.test.ts` (in-file
 * path-tail allowlist for pre-existing benign sites).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";
import type { ViolationCitation } from "../support/architecture-helpers.js";
import { noBackwardCompatAllowlist } from "../support/architecture-allowlist.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

/**
 * Path-tails (suffix match against repo-relative paths) of files that
 * contain text matching the BC-REM-02 regex at Phase 38 baseline but
 * whose text is NOT a live BC shim under Phase 38's deletion scope.
 *
 * Each entry must remain documented (one reason per file). When a future
 * wave deletes the BC code path or rewrites the documentation, the entry
 * should be REMOVED from this list (positive ratchet) — never relaxed.
 *
 * This list MUST shrink-only. Adding entries requires explicit
 * justification at PR review (the rule's failure mode catches additions
 * by surfacing the offending file path).
 */
const BC_REM_02_PATH_TAIL_ALLOWLIST: readonly string[] = [
  // ---------- Documentation / defaults / policy text (no live BC shim) ----------
  "packages/agent/src/bootstrap/workspace-loader.ts", // doc-string: "preserves backward-compatible behavior" describing opt-in flag semantics
  "packages/agent/src/bootstrap/system-prompt-assembler.ts", // doc-strings on "additional sections" field (RAG-memory etc.)
  "packages/agent/src/bootstrap/sections/skills-memory-sections.ts", // doc-comment about absent-subsection case
  "packages/agent/src/model/model-allowlist.ts", // doc-string: empty array = "allow all models (backward compatible)" — default rationale
  "packages/agent/src/model/compaction-model-resolver.ts", // doc-string: "No backward-compat shim per feedback_no_backward_compat.md" — POLICY citation, not BC code
  "packages/agent/src/model/model-registry-adapter.ts", // doc-string mentioning "legacy aliases that ..." — describes local inference catalog
  "packages/agent/src/executor/cache-break-detection.ts", // doc-comment on optional field default-0 rationale
  "packages/agent/src/executor/cache-break-diff-writer.ts", // doc-comment on `?? false` default rationale for newer fields
  "packages/agent/src/spawn/sub-agent-runner.ts", // legacy-fallback branch — out of Phase 38 scope (spawn pipeline rewrites tracked separately)
  "packages/agent/src/session/comis-session-manager.ts", // doc-string about session-mapping carry-over (pre-v2.1 paths still resolvable)
  "packages/agent/src/context-engine/types-core.ts", // doc-string on optional-field default-0 rationale
  "packages/core/src/config/schema-secrets.ts", // doc-strings on default-false / empty-array rationale (zod schema defaults)
  "packages/core/src/config/schema-channel.ts", // doc-string on default-true rationale (per-channel toggles)
  "packages/core/src/security/injection-patterns.ts", // barrel re-export module-doc — describes barrel purpose
  "packages/core/src/security/secret-manager.ts", // doc-string: "Empty array = unrestricted (backward compat)" — default rationale
  "packages/core/src/security/secret-access.ts", // doc-strings on empty-allow-list = unrestricted rationale (same as secret-manager)
  "packages/core/src/runtime/file-lock.ts", // module-doc: "per the no-backward-compat convention" — POLICY citation
  "packages/core/src/runtime/is-remote-env.ts", // module-doc: "per the no-backward-compat convention" — POLICY citation
  "packages/core/src/event-bus/events-infra.ts", // doc-string on canonical/coexisting-form pair (events-infra event-payload schema)
  "packages/daemon/src/api/types.ts", // doc-comment on optional-field message-id rationale
  "packages/daemon/src/api/env-handlers.ts", // "legacy fallback" / "Legacy mode" .env-file branch — out of Phase 38 scope (env-handlers refactor tracked separately)
  "packages/daemon/src/api/session-handlers.ts", // doc-comment about synchronous "backward compatible" inline-result path
  "packages/memory/src/schema.ts", // module-level flag set "for backward compatibility" — schema-init carry-over
  "packages/memory/src/setup-secrets.ts", // explicit two-mode "legacy mode" branch (no MEMORY_DB_KEY env) — out of Phase 38 scope (secrets-store optionality)
  "packages/skills/src/tools/builtin/exec-tool.ts", // doc-string: "Backward compatibility is NOT preserved (see feedback_no_backward_compat)" — POLICY citation
  "packages/skills/src/tools/builtin/process-tool.ts", // doc-string: "Backward compatibility is NOT preserved" + "backward compat with the prior positional ..." — POLICY citations
  "packages/skills/src/platform-tools/tools/browser-tool.ts", // RpcCall-or-deps-object signature; doc-comment describing the two-shape acceptance — out of Phase 38 scope
  "packages/skills/src/platform-tools/tools/agents-manage-tool.ts", // doc-string: "default-logger compat shim (per feedback_no_backward_compat.md)" — POLICY citation
  "packages/web/src/router.ts", // route-aliases-for-backward-compatibility — out of Phase 38 scope (web router consolidation tracked separately)
  "packages/web/src/utils/health-status.ts", // LEGACY_ALIASES channel-health map — out of Phase 38 scope (channel-status canonicalization tracked separately)
  "packages/web/src/components/nav-bar.ts", // file-level comment "retained for backward compatibility with existing tests"
  "packages/web/src/views/config-editor.ts", // re-export shim doc-comment "for backward compatibility" — module barrel reorganization
] as const;

/**
 * Walks every production .ts file under `packages/*\/src/`. Mirrors the
 * raw-throw.test.ts walker; rejects `.test.ts`, `.spec.ts`, `.d.ts`,
 * `.generated.ts`, and `__tests__` / `__snapshots__` / `dist` /
 * `node_modules` / `__test-helpers` / `fixtures` directories.
 */
function walkProductionFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (
        [
          "__tests__",
          "__snapshots__",
          "dist",
          "node_modules",
          "__test-helpers",
          "fixtures",
        ].includes(entry.name)
      ) {
        continue;
      }
      walkProductionFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function listAllProductionFiles(): string[] {
  const out: string[] = [];
  let packageDirs;
  try {
    packageDirs = readdirSync(PACKAGES_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pkg of packageDirs) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
    walkProductionFiles(resolve(PACKAGES_ROOT, pkg.name, "src"), out);
  }
  return out;
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

/**
 * Per-line scan of `absPath` for any line matching `pattern`. Returns
 * one citation per matching line. Skips lines where the match is inside
 * an unbalanced string literal (best-effort — same quote-count guard as
 * raw-throw.test.ts).
 */
function findLineHits(
  absPath: string,
  pattern: RegExp,
): readonly ViolationCitation[] {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split(/\r?\n/);
  const hits: ViolationCitation[] = [];
  const rel = repoRelative(absPath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Clone the regex per line (defensive against `/g` / `/y` state
    // bleed-over even though our patterns have no such flags).
    const re = new RegExp(pattern.source, pattern.flags);
    if (!re.test(line)) continue;
    hits.push({
      file: rel,
      line: i + 1,
      snippet: line.trim().slice(0, 160),
    });
  }
  return hits;
}

describe("no-backward-compat — Phase 38 (BC-REM-02/03/04/05/06/07/21/23)", () => {
  it("production source contains no /backward.?compat|backcompat|legacy.?(alias|mode|fallback)/i text outside noBackwardCompatAllowlist + path-tail benign-allowlist (BC-REM-02)", () => {
    const pattern = /backward.?compat|backcompat|legacy.?(alias|mode|fallback)/i;
    const allFiles = listAllProductionFiles();

    // Line-pinned allowlist set keyed on "<repo-relative-file>:<line>"
    // for fast lookup against per-line hits.
    const linePinned = new Set(
      noBackwardCompatAllowlist.map(
        (e) => `${e.file}:${e.line}`,
      ),
    );

    const violations: ViolationCitation[] = [];
    for (const file of allFiles) {
      const rel = repoRelative(file);
      // Path-tail benign allowlist — entire file is exempted (pre-existing).
      if (BC_REM_02_PATH_TAIL_ALLOWLIST.some((tail) => rel.endsWith(tail))) {
        continue;
      }
      const hits = findLineHits(file, pattern);
      for (const h of hits) {
        if (linePinned.has(`${h.file}:${h.line}`)) continue;
        violations.push(h);
      }
    }

    expect(
      violations,
      formatViolations({
        description:
          "Production source under packages/*/src/ must not contain backward-compat / legacy-alias / legacy-mode / legacy-fallback text outside the noBackwardCompatAllowlist (line-pinned permanent historical references, max 3 entries per BC-REM-22) and outside the BC_REM_02_PATH_TAIL_ALLOWLIST (pre-existing benign-text files captured at Phase 38 baseline). Scope is intentionally limited to npm-tarball-bundled source (the published @comis/* tarballs from packages/*/src/) — non-shipped paths (test/support/, root configs, scripts/, tools/, website/, packages/comis/ umbrella) are out of scope by design because they do not reach end-users.",
        violations,
        suggestedFix:
          "Delete the legacy code path and its compatibility comment (preferred). Alternatively, if the code is a permanent-historical-reference migration that must remain pending v2.2 cleanup, add a {file, line, reason} entry to noBackwardCompatAllowlist in test/support/architecture-allowlist.ts (max 3 entries per BC-REM-22) and annotate the file with `@migration-since: <YYYY-MM-DD>; @remove-after: <milestone>`. Adding a new file to BC_REM_02_PATH_TAIL_ALLOWLIST is reserved for documented pre-existing benign text — not new BC code. If the offending text is outside packages/*/src/ it is outside this ratchet's scope by design — no allowlist entry needed.",
        designRef:
          "code-quality-plan-2026-05-10.md §11.3 (BC-REM-02), §11.5 / Phase 38 wave-close",
        allowlistRef:
          "noBackwardCompatAllowlist (line-pinned) + BC_REM_02_PATH_TAIL_ALLOWLIST (in-file, this test). Scope: packages/*/src/ only (npm-tarball-bundled source).",
      }),
    ).toEqual([]);

    // Sanity: walker actually scanned production source.
    expect(
      allFiles.length,
      "sanity: listAllProductionFiles enumerated at least one production .ts file",
    ).toBeGreaterThan(0);
  });

  it("production source contains zero @deprecated JSDoc annotations (BC-REM-03)", () => {
    const pattern = /@deprecated\b/;
    const allFiles = listAllProductionFiles();
    const violations: ViolationCitation[] = [];
    for (const file of allFiles) {
      violations.push(...findLineHits(file, pattern));
    }
    expect(
      violations,
      formatViolations({
        description:
          "Production source must contain zero @deprecated JSDoc annotations. The v2.1 policy is no-deprecation-period (feedback_no_backward_compat): delete the deprecated code and retarget consumers atomically.",
        violations,
        suggestedFix:
          "Delete the @deprecated annotation AND the code it annotates; retarget all consumers in the same commit. If retargeting is non-trivial, split into a follow-up wave but do not ship @deprecated.",
        designRef:
          "code-quality-plan-2026-05-10.md §11.2.8 / §11.3 (BC-REM-03)",
      }),
    ).toEqual([]);
  });

  it("agent/src/index.ts contains no `export { X as Y } from \"...\"` alias re-exports (BC-REM-04)", () => {
    const indexAbs = resolve(PACKAGES_ROOT, "agent/src/index.ts");
    const text = readFileSync(indexAbs, "utf8");
    const lines = text.split(/\r?\n/);
    // Match an export statement that contains `as` between the braces
    // AND has a `from "..."` re-export source. The brace-set is single-line
    // in this file (current shape); a future multi-line export would
    // require widening, but the rule fires per-line, so a multi-line
    // export with `as` would still be caught on the line containing `as`
    // (the violation would name the offending alias even if `from` lands
    // on a later line). For robustness we require both `as` AND `from` on
    // the same line — matching agent/src/index.ts's current convention.
    const aliasReexportPattern =
      /\bexport\s*\{[^}]*\bas\b[^}]*\}\s*from\s*["']/;
    const violations: ViolationCitation[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (aliasReexportPattern.test(line)) {
        violations.push({
          file: "packages/agent/src/index.ts",
          line: i + 1,
          snippet: line.trim().slice(0, 160),
        });
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "agent/src/index.ts must not contain `export { X as Y } from \"...\"` alias re-exports. Phase 29 PUB-EXPORTS-03 removed every such alias from the agent barrel; this rule pins the closure.",
        violations,
        suggestedFix:
          "Delete the alias re-export. Consumers should import from the canonical module (the `from \"...\"` source), not via an alias on the agent index. If the alias is genuinely needed for ergonomics, declare a local binding inside the consumer rather than aliasing on the barrel.",
        designRef:
          "code-quality-plan-2026-05-10.md §11.2.1 / §11.3 (BC-REM-04)",
      }),
    ).toEqual([]);
  });

  it("skills/src/index.ts and skills/src/skills/index.ts do not re-export names from @comis/shared (BC-REM-05)", () => {
    const filesToCheck = [
      "packages/skills/src/index.ts",
      "packages/skills/src/skills/index.ts",
    ];
    const sharedReexportPattern =
      /\bexport\s*(\*|\{[^}]+\})\s*from\s*["']@comis\/shared["']/;
    const violations: ViolationCitation[] = [];
    for (const relFile of filesToCheck) {
      const text = readFileSync(resolve(REPO_ROOT, relFile), "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (sharedReexportPattern.test(line)) {
          violations.push({
            file: relFile,
            line: i + 1,
            snippet: line.trim().slice(0, 160),
          });
        }
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "skills/src/index.ts and skills/src/skills/index.ts must not re-export names from @comis/shared. Consumers of shared types/values should import directly from @comis/shared (Phase 33 SKILLS-SPLIT-* closure).",
        violations,
        suggestedFix:
          "Delete the `export { ... } from \"@comis/shared\"` (or `export *`) line. Update any consumer importing the affected name through @comis/skills to import it from @comis/shared directly.",
        designRef:
          "code-quality-plan-2026-05-10.md §11.2.1 / §11.3 (BC-REM-05)",
      }),
    ).toEqual([]);
  });

  it("agent/src/index.ts does not export createCommandHandler or CommandHandlerDeps (BC-REM-06)", () => {
    const indexAbs = resolve(PACKAGES_ROOT, "agent/src/index.ts");
    const text = readFileSync(indexAbs, "utf8");
    const lines = text.split(/\r?\n/);
    const violations: ViolationCitation[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Match only lines that look like an `export ...` statement
      // mentioning the symbols — pure documentation comments (e.g. the
      // file-header migration note that says createCommandHandler "moved
      // to @comis/orchestrator") should NOT match. We require the line
      // to start with `export` (after optional whitespace).
      if (!/^\s*export\b/.test(line)) continue;
      if (
        /\bcreateCommandHandler\b/.test(line) ||
        /\bCommandHandlerDeps\b/.test(line)
      ) {
        violations.push({
          file: "packages/agent/src/index.ts",
          line: i + 1,
          snippet: line.trim().slice(0, 160),
        });
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "agent/src/index.ts must not export createCommandHandler or CommandHandlerDeps. Both symbols live in @comis/orchestrator after Phase 32 (ORCH-EXT-08); consumers must import from @comis/orchestrator.",
        violations,
        suggestedFix:
          "Delete the export line. Update any consumer that imports createCommandHandler or CommandHandlerDeps from @comis/agent to import from @comis/orchestrator instead.",
        designRef:
          "code-quality-plan-2026-05-10.md §11.2.2 / §11.3 (BC-REM-06)",
      }),
    ).toEqual([]);
  });

  it("cli/src/index.ts public value exports are exactly { withClient, credentialsStep } (BC-REM-07)", () => {
    const cliIndexAbs = resolve(PACKAGES_ROOT, "cli/src/index.ts");
    const text = readFileSync(cliIndexAbs, "utf8");
    const lines = text.split(/\r?\n/);
    const allowedValueExports = new Set(["withClient", "credentialsStep"]);
    const violations: ViolationCitation[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Skip type-only re-exports — `export type { ... }` is allowed for
      // any signature-required type.
      if (/^\s*export\s+type\b/.test(line)) continue;
      // Match `export { ... }` (value-export) with an optional `from "..."`.
      const match = line.match(/^\s*export\s*\{([^}]+)\}/);
      if (!match) continue;
      const names = match[1]
        .split(",")
        .map((s) => s.trim())
        .map((s) => {
          // Handle `X as Y` → use Y; otherwise bare name.
          const asMatch = s.match(/^\s*\S+\s+as\s+(\S+)\s*$/);
          return (asMatch ? asMatch[1] : s).trim();
        })
        .filter(Boolean);
      for (const name of names) {
        if (!allowedValueExports.has(name)) {
          violations.push({
            file: "packages/cli/src/index.ts",
            line: i + 1,
            snippet: `unexpected value export: ${name}`,
          });
        }
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "cli/src/index.ts public value exports must be exactly { withClient, credentialsStep } (plus any number of signature-required type re-exports). Phase 29 PUB-EXPORTS-02 narrowed this surface deliberately.",
        violations,
        suggestedFix:
          "Remove the unexpected export. If the symbol is needed by the CLI bin entry point (cli.ts), import it directly from ./commands/X.js or ./output/X.js — those modules remain importable, but are NOT part of the documented @comis/cli external API.",
        designRef:
          "code-quality-plan-2026-05-10.md §11.2.2 / §11.3 (BC-REM-07) / Phase 29 PUB-EXPORTS-02",
      }),
    ).toEqual([]);
  });

  it("no eslint-disable comment cites 'legacy' or 'backward compat' as justification (BC-REM-23)", () => {
    // Capture `eslint-disable` (line or block, with-rule or without) where
    // a justification trailing `--` cites "legacy" or "backward compat".
    // The ESLint convention is `eslint-disable-... -- <reason>` (the `--`
    // separator introduces the justification per @eslint-community/eslint-comments).
    const pattern =
      /eslint-disable[\w-]*[^\n]*--[^\n]*\b(legacy|backward[- ]?compat)\b/i;
    const allFiles = listAllProductionFiles();
    const violations: ViolationCitation[] = [];
    for (const file of allFiles) {
      violations.push(...findLineHits(file, pattern));
    }
    expect(
      violations,
      formatViolations({
        description:
          "No eslint-disable comment in production source may cite 'legacy' or 'backward compat' as justification. The pragma-drift threat (T-38-06-01) requires that any BC carve-out flow through the noBackwardCompatAllowlist (line-pinned, review-visible) rather than through per-file pragmas (invisible in PR diffs).",
        violations,
        suggestedFix:
          "Remove the eslint-disable comment. If the underlying lint violation is real, fix the code; if the rule is wrong, fix the rule. If the code path is a permanent-historical-reference BC site, add it to noBackwardCompatAllowlist with a `@migration-since` annotation instead.",
        designRef:
          "code-quality-plan-2026-05-10.md §11.3 (BC-REM-23) / Phase 38 threat T-38-06-01",
      }),
    ).toEqual([]);
  });

  // Defense-in-depth (BC-REM-21): Phase 30 closure deleted every
  // `getGlobalHookRunner` / `hook-runner-global` symbol. This block
  // asserts the zero-hits invariant in production source — catches any
  // accidental reintroduction.
  it("production source contains no getGlobalHookRunner / hook-runner-global references (BC-REM-21 defense-in-depth)", () => {
    const pattern = /\bgetGlobalHookRunner\b|hook-runner-global/;
    const allFiles = listAllProductionFiles();
    const violations: ViolationCitation[] = [];
    for (const file of allFiles) {
      violations.push(...findLineHits(file, pattern));
    }
    expect(
      violations,
      formatViolations({
        description:
          "Production source must contain zero getGlobalHookRunner / hook-runner-global references. Phase 30 deleted both symbols; there is no replacement. Reintroducing either would re-create the global-singleton anti-pattern the closure resolved.",
        violations,
        suggestedFix:
          "Remove the reference. The hook-runner is now constructed at the composition root and passed via deps; there is no module-level accessor and no global registry.",
        designRef:
          "code-quality-plan-2026-05-10.md §11.2.10 / §11.3 (BC-REM-21) / Phase 30 hook-runner-global deletion",
      }),
    ).toEqual([]);
  });
});
