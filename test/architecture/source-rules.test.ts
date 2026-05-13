// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide source-rules invariants.
 *
 * Rules enforced here:
 *   - L23 (ARCH-BASE-06 partial): production source under packages/*\/src/**
 *     MUST NOT call raw path.join / nodePath.join / `join as pathJoin`
 *     aliases. Use safePath(base, ...segments) from @comis/core/security
 *     instead. Closed in Phase 28 commit 6A (CORE-PORTS-06).
 *   - CONFIG-DELIV-08a (no-free-deliverToChannel): production source under
 *     packages/*\/src/** MUST NOT contain a free-standing `deliverToChannel(...)`
 *     call. Consume the method via `deps.deliveryService.deliverToChannel(...)`
 *     instead. Path-tail allowlist exempts the impl declaration site and the
 *     test factory.
 *   - CONFIG-DELIV-08b (no-deps-optional-in-delivery): files under
 *     packages/core/src/delivery/ MUST NOT use a `deps?:` optional-deps
 *     signature. The required-deps DeliveryService factory is the only
 *     legitimate shape (L26 closure).
 *
 * The closed-`errorKind` literal rule (L16, the third component of
 * ARCH-BASE-06) lives in Plan 07's AST walker, not here — that rule
 * needs the TS TypeChecker to resolve Object.assign / spread / member-access
 * expressions, which source-grep cannot do (RES-PIT-9). Plan 07 also
 * claims ARCH-BASE-06 for that closed-errorKind component.
 *
 * Sub-allowlist semantics:
 *   - L23_ALLOWLIST: each entry is a path-tail (substring match against the
 *     absolute path) that the source-grep helper found at Phase 27 baseline.
 *     The canonical safe-path implementation file is included; all other
 *     entries are pre-Phase-28 baseline violations of L23. Phase 28 commit
 *     6A (CORE-PORTS-06) shrunk this list to one entry (the safe-path impl
 *     itself), plus a D-14 carve-out for the symlink-aware skill discovery.
 *   - NO_FREE_DELIVER_ALLOWLIST: exactly two path-tails — the
 *     `DeliveryService.deliverToChannel(...)` method declaration in
 *     `core/src/delivery/delivery-service.ts` (the symbol's only legitimate
 *     bare-token site, since the regex catches the method-declaration
 *     syntax) and the `makeDeliveryService` test factory in
 *     `test/support/factories.ts` (defensive — the file no longer matches
 *     the regex, but is retained per CONFIG-DELIV-08 design spec).
 *
 * NOTE: The L14 rule (`no-getGlobalHookRunner`) was REMOVED in Phase 30
 * plan 07 because the symbol it forbade no longer exists in any package —
 * `hook-runner-global.ts` was deleted in Phase 30 plan 06. Recreating the
 * symbol would require a new module that fails type-check (no import to
 * resolve), so the source-grep rule no longer serves a CI purpose.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findInSourceFiles } from "../support/source-grep.js";
import { formatViolations } from "../support/architecture-helpers.js";
import { checkContextStoreRowResidency } from "../support/ports-dto-residency-checker.js";
import { checkSecretResidency } from "../support/secret-residency-checker.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

const WORKSPACE_PACKAGES = [
  "shared",
  "core",
  "infra",
  "memory",
  "scheduler",
  "skills",
  "agent",
  "channels",
  "gateway",
  "cli",
  "daemon",
] as const;

/**
 * L23 sub-allowlist (Phase 28 commit 6A — shrunk to 1 entry).
 *
 * The sole entry (`core/src/security/safe-path.ts`) is the canonical
 * implementation of `safePath` itself — by definition it must call
 * `path.join` internally. Every other baseline entry was migrated to
 * `safePath(base, ...segments)` in Phase 28 commit 6A (CORE-PORTS-06)
 * per design §5.4 step 6A and D-12..D-15.
 *
 * D-13 carve-outs (Zod issue-path joins like `i.path.join(".")` and
 * `result.error.issues.map((i) => i.path.join("."))`) are filtered by
 * the regex below — they are NOT file-path constructions and remain
 * legitimate. The regex uses a negative lookbehind `(?<!\.)` to
 * distinguish raw `path.join(...)` from member access on objects whose
 * `path` property carries a Zod issue path array (e.g., `i.path` /
 * `issue.path` / `result.error.issues[*].path`).
 *
 * Format: each entry is a path-tail. The check uses `m.endsWith(allowed)`
 * so the entry is matched as a suffix of the absolute file path.
 */
const L23_ALLOWLIST: readonly string[] = [
  // canonical safePath implementation (path.join is the safe wrapper's body)
  "core/src/security/safe-path.ts",
  // D-14 carve-out: skill discovery legitimately follows symlinks (dedup via
  // realpath); the readdir-walker uses path.join because entry.name comes
  // from fs.readdirSync (kernel-validated basename — cannot contain a path
  // separator) AND safePath's symlink-escape check would reject the
  // intentional symlink-to-sibling pattern used for skill-dir aliasing
  // (verified by the "symlink deduplication" tests in discovery.test.ts and
  // skill-registry.test.ts). All other call sites in this file use safePath.
  // Phase 33: file path retargeted from `skills/src/registry/discovery.ts`
  // to `skills/src/skills/registry/discovery.ts` per SKILLS-SPLIT-02.
  "skills/src/skills/registry/discovery.ts",
] as const;

/**
 * NO_FREE_DELIVER_ALLOWLIST (CONFIG-DELIV-08a, Phase 30 plan 07 — 2 entries).
 *
 * The first entry is the `DeliveryService.deliverToChannel(...)` method
 * declaration in `core/src/delivery/delivery-service.ts` — the file
 * literally contains `deliverToChannel(adapter, channelId, text, options)`
 * as a method signature/body, which the regex matches at the bare-token
 * position (no preceding `.`). Exempted to prevent the rule from failing
 * on its own implementation.
 *
 * The second entry is the test factory at `test/support/factories.ts`.
 * Test files are already excluded via `excludeFileSuffixes: [".test.ts"]`,
 * but `factories.ts` is NOT a `.test.ts` file. The factory's
 * `makeDeliveryService(...)` body is currently a method-form call
 * (`createDeliveryService({...})`) and does NOT contain a bare
 * `deliverToChannel(` token today, but the entry is retained per the
 * CONFIG-DELIV-08 design spec: if the factory evolves to expose a
 * method-declaration form, it must remain the only second site.
 *
 * Path-tail match (`m.endsWith(allowed)`) so any future move of these
 * files within the same suffix continues to apply.
 */
const NO_FREE_DELIVER_ALLOWLIST: readonly string[] = [
  "core/src/delivery/delivery-service.ts",
  "test/support/factories.ts",
] as const;

describe("source-rules -- L23 safePath (ARCH-BASE-06 partial)", () => {
  for (const pkg of WORKSPACE_PACKAGES) {
    it(`packages/${pkg}/src does NOT call raw path.join (use safePath instead)`, () => {
      const result = findInSourceFiles({
        rootDir: resolve(PACKAGES_ROOT, pkg, "src"),
        // Match `path.join(`, `nodePath.join(`, or `join as pathJoin` aliases.
        // The negative lookbehind `(?<!\.)` is the D-13 carve-out — it
        // skips member access like `i.path.join(".")` /
        // `issue.path.join(".")` / `result.error.issues[*].path.join(".")`,
        // which are STRING JOINS over Zod's issue path arrays (not file
        // paths). It also avoids false-positives on tokens like
        // `something.path.join` carrying a Zod-shaped `path` property.
        needle: /(?<!\.)\bpath\.join\s*\(|(?<!\.)\bnodePath\.join\s*\(|\bjoin\s+as\s+pathJoin\b/,
        excludeFileSuffixes: [".test.ts"],
      });
      const offenders = result.matches.filter(
        (m) => !L23_ALLOWLIST.some((allowed) => m.endsWith(allowed)),
      );
      expect(
        offenders,
        formatViolations({
          description: `packages/${pkg}/src must use safePath(base, ...segments) instead of raw path.join.`,
          violations: offenders.map((file) => ({ file, line: 0 })),
          suggestedFix:
            "Replace `path.join(base, segment, ...)` with `safePath(base, segment, ...)` from @comis/core. safePath enforces no path traversal beyond `base` (per OWASP V12).",
          designRef: "design §1.3 L23 / Phase 28 commit 6A (CORE-PORTS-06)",
          allowlistRef: "L23 + L23_ALLOWLIST (in-file sub-allowlist)",
        }),
      ).toEqual([]);
      expect(
        result.checkedFiles,
        "sanity: helper walked at least one production source file",
      ).toBeGreaterThan(0);
    });
  }
});

describe("source-rules -- no-free-deliverToChannel (CONFIG-DELIV-08)", () => {
  for (const pkg of WORKSPACE_PACKAGES) {
    it(`packages/${pkg}/src does NOT contain a free-standing deliverToChannel(...) call`, () => {
      const result = findInSourceFiles({
        rootDir: resolve(PACKAGES_ROOT, pkg, "src"),
        // Match `deliverToChannel(` only when NOT preceded by `.` — the
        // negative lookbehind `(?<!\.)` excludes method-form calls like
        // `deps.deliveryService.deliverToChannel(...)` (the CORRECT pattern)
        // and only flags bare-token sites: the method-declaration syntax in
        // `delivery-service.ts` (allowlisted) and any future free-standing
        // function or top-level call that would re-introduce the L26 shape.
        // Mirrors the L23 (?<!\.)\bpath\.join pattern verbatim.
        needle: /(?<!\.)\bdeliverToChannel\s*\(/,
        excludeFileSuffixes: [".test.ts"],
      });
      const offenders = result.matches.filter(
        (m) => !NO_FREE_DELIVER_ALLOWLIST.some((allowed) => m.endsWith(allowed)),
      );
      expect(
        offenders,
        formatViolations({
          description: `packages/${pkg}/src must consume DeliveryService.deliverToChannel via the service interface; no free-standing call.`,
          violations: offenders.map((file) => ({ file, line: 0 })),
          suggestedFix:
            "Inject DeliveryService via deps and call deliveryService.deliverToChannel(adapter, channelId, text, options). See Phase 30 (CONFIG-DELIV-04, -05).",
          designRef: "design §1.3 L26 / Phase 30 (CONFIG-DELIV-04, -08)",
          allowlistRef: "NO_FREE_DELIVER_ALLOWLIST (in-file sub-allowlist)",
        }),
      ).toEqual([]);
      expect(
        result.checkedFiles,
        "sanity: helper walked at least one production source file",
      ).toBeGreaterThan(0);
    });
  }
});

describe("source-rules -- no-deps-optional-in-delivery (CONFIG-DELIV-08)", () => {
  it("core/src/delivery does NOT use `deps?:` optional-deps signature", () => {
    const result = findInSourceFiles({
      rootDir: resolve(PACKAGES_ROOT, "core", "src", "delivery"),
      // Match `deps?:` in function parameter lists. The space-allowing form
      // captures `deps?: T`, `deps ?: T`, and similar.
      needle: /\bdeps\s*\?\s*:/,
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      formatViolations({
        description:
          "Delivery code must require deps; optional deps (deps?: ...) is forbidden by L26 closure.",
        violations: result.matches.map((file) => ({ file, line: 0 })),
        suggestedFix:
          "Change `deps?: DeliveryServiceDeps` to `deps: DeliveryServiceDeps`. Construct the service at composition root and inject the resolved DeliveryService into call sites; do not push optional deps through the call chain.",
        designRef: "design §1.3 L26 / Phase 30 (CONFIG-DELIV-04, -08)",
        allowlistRef: "(no allowlist — delivery code must not use deps?:)",
      }),
    ).toEqual([]);
    expect(
      result.checkedFiles,
      "sanity: helper walked at least one production source file",
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 31 commit 6 (MEM-CTX-PORTS-14 / RES-PIT-31-4) — disableRedaction
// production-source forbidden invariant.
//
// The `LoggerOptions.disableRedaction` option (added in plan 31-06) is for
// the residency integration test (plan 31-13) ONLY. If any production code
// sets it to `true`, plaintext secrets could surface in production logs.
//
// The needle `/disableRedaction\s*:\s*true/` matches the literal assignment
// form (object-literal or named-object spread). It does NOT match the
// optional-field declaration `disableRedaction?: boolean;` in
// `packages/infra/src/logging/logger.ts` (the `?` after the field name and
// `boolean` value do not match the literal `true`).
//
// The residency test (`test/integration/secret-rpc-residency.test.ts`,
// plan 31-13) lives OUTSIDE `packages/*\/src/` and is therefore not scanned
// by this rule — that file is allowed to set `disableRedaction: true`.
// ---------------------------------------------------------------------------

describe("source-rules -- disableRedaction forbidden in production source (MEM-CTX-PORTS-14 / RES-PIT-31-4)", () => {
  for (const pkg of WORKSPACE_PACKAGES) {
    it(`packages/${pkg}/src does NOT set disableRedaction: true (residency-test fixture only)`, () => {
      const pkgSrcDir = resolve(PACKAGES_ROOT, pkg, "src");
      if (!existsSync(pkgSrcDir)) {
        // Package has no src/ — skip (e.g., comis umbrella package).
        return;
      }
      const result = findInSourceFiles({
        rootDir: pkgSrcDir,
        needle: /disableRedaction\s*:\s*true/,
        excludeFileSuffixes: [".test.ts"],
      });
      expect(
        result.matches,
        formatViolations({
          description:
            `packages/${pkg}/src must not set disableRedaction: true. ` +
            `This option is for the residency test (test/integration/secret-rpc-residency.test.ts) only. ` +
            `Production code that disables redaction can leak plaintext secrets to logs.`,
          violations: result.matches.map((m) => ({
            file: m,
            line: 0,
            snippet: "disableRedaction: true",
          })),
          suggestedFix:
            "Remove the `disableRedaction: true` assignment. If you genuinely need to observe raw payloads for a test, place that test under test/integration/ and use the residency-test harness pattern.",
          designRef: "design §8.2.7 / MEM-CTX-PORTS-14 part 2 / RES-PIT-31-4",
        }),
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 31 commit 8 (MEM-CTX-PORTS-14 part 1 / RES-PIT-31-1) — secret-residency
// AST walker invariant on secret-RPC handler files.
//
// The walker (`test/support/secret-residency-checker.ts`) enforces two
// rules via TypeScript Compiler API + TypeChecker resolution:
//
//   Rule 1: NO module-level / class-level let/const binding whose name
//   matches /secret|decrypted|plaintext/i AND whose initializer is a
//   CallExpression on a known secret-source method name
//   ({get, getDecrypted, resolve, decrypt, decryptAll}).
//
//   Rule 2: NO closure inside Promise.all([...]) captures an outer-scope
//   binding whose resolved Symbol's name matches the regex above AND whose
//   declaration's initializer matches the secret-source pattern.
//
// Per I-03 fix in Phase 31 revision iter 2, the walker scope extends to
// `auth-handlers.ts` (created in plan 31-11). Until plan 31-11 lands, the
// `auth-handlers.ts` block is skipped via `it.skipIf(!existsSync(...))`.
// ---------------------------------------------------------------------------

describe("source-rules -- secret-residency (MEM-CTX-PORTS-14 part 1)", () => {
  it("packages/daemon/src/api/secrets-handlers.ts does NOT leak plaintext via residency violations", () => {
    const target = resolve(
      PACKAGES_ROOT,
      "daemon/src/api/secrets-handlers.ts",
    );
    const violations = checkSecretResidency([target]);
    expect(
      violations,
      formatViolations({
        description:
          "packages/daemon/src/api/secrets-handlers.ts must not retain plaintext across handler invocations. Two rules: (1) no module-level/class-level let/const binding named /secret|decrypted|plaintext/i with secret-source initializer; (2) no Promise.all closure capturing such a binding from outer scope (RES-PIT-31-1).",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.character,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Remove any module-level / class-level binding named /secret|decrypted|plaintext/i whose initializer comes from SecretStorePort / SecretManager / SecretsCrypto. Remove any Promise.all closure that captures such a binding from outer scope. See core/src/security/SECRET-RPC-CHECKLIST.md sections B (Plaintext residency) and D (Architecture-test alignment).",
        designRef: "design §8.2.7 / MEM-CTX-PORTS-14 part 1",
      }),
    ).toEqual([]);
  });

  // Plan 31-11 creates packages/daemon/src/api/auth-handlers.ts (renamed from
  // rpc/ to api/ in Phase 34 / DAEMON-API-02). The walker
  // scope extends to it per Phase 31 revision iter 2 / I-03 fix: auth.list
  // returns OAuth-token-bearing data structurally (un-projected
  // OAuthProfile[] lives in handler closure between port.list() and
  // redactProfileForRpc). The same residency discipline applies. Until plan
  // 31-11 lands, the file does not yet exist; skipIf prevents the
  // assertion from running early.
  const AUTH_HANDLERS_PATH = resolve(
    PACKAGES_ROOT,
    "daemon/src/api/auth-handlers.ts",
  );
  const authHandlersExists = existsSync(AUTH_HANDLERS_PATH);
  it.skipIf(!authHandlersExists)(
    "packages/daemon/src/api/auth-handlers.ts does NOT leak OAuth tokens via residency violations (scope-extended per I-03 fix)",
    () => {
      const violations = checkSecretResidency([AUTH_HANDLERS_PATH]);
      expect(
        violations,
        formatViolations({
          description:
            "packages/daemon/src/api/auth-handlers.ts must not retain OAuth-token-bearing OAuthProfile values across handler invocations. Two rules: (1) no module-level/class-level let/const binding named /secret|decrypted|plaintext/i whose initializer comes from a port get/list/getDecrypted call; (2) no Promise.all closure capturing such a binding from outer scope. OAuthProfile contains `access`, `refresh`, `accountId` — equivalent to plaintext secrets.",
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.character,
            snippet: v.snippet,
          })),
          suggestedFix:
            "Remove any module-level / class-level binding holding the un-projected OAuthProfile[]. Apply the redactProfileForRpc projection IMMEDIATELY at the handler-return boundary, never storing the un-projected array in a closure-captured variable. See core/src/security/SECRET-RPC-CHECKLIST.md sections B (Plaintext residency) and D (Architecture-test alignment).",
          designRef:
            "design §8.2.7 / MEM-CTX-PORTS-14 part 1 / Phase 31 revision iter 2 I-03",
        }),
      ).toEqual([]);
    },
  );
});

describe("source-rules -- ContextStorePort row-DTO residency (MEM-CTX-PORTS-04 primary)", () => {
  it("every Ctx*Row referenced from ContextStorePort method signatures is exported from context-store-types.ts (TS-compiler-API walker)", () => {
    const contextStorePath = resolve(
      PACKAGES_ROOT,
      "core/src/ports/context-store.ts",
    );
    const typesPath = resolve(
      PACKAGES_ROOT,
      "core/src/ports/context-store-types.ts",
    );
    const violations = checkContextStoreRowResidency(
      contextStorePath,
      typesPath,
    );
    expect(
      violations,
      formatViolations({
        description:
          "Every Ctx*Row referenced transitively from ContextStorePort method signatures (parameters and return types) MUST be exported as an interface from context-store-types.ts. Walks the AST via TypeChecker — this is the PRIMARY check for MEM-CTX-PORTS-04. A complementary text-level regex check lives in packages/core/src/__tests__/architecture.test.ts.",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.character,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Add the missing `export interface <Name> { ... }` to packages/core/src/ports/context-store-types.ts. If the type genuinely should not be a public row-DTO (e.g., it's a helper type), rename it so it does NOT match /^Ctx[A-Z][A-Za-z]+Row$/.",
        designRef: "design §8.2.1 / MEM-CTX-PORTS-04",
      }),
    ).toEqual([]);
  });
});
