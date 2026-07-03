// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide source-rules invariants.
 *
 * Rules enforced here:
 *   - safePath: production source under packages/*\/src/** MUST NOT call
 *     raw path.join / nodePath.join / `join as pathJoin` aliases. Use
 *     safePath(base, ...segments) from @comis/core/security instead.
 *   - no-free-deliverToChannel: production source under packages/*\/src/**
 *     MUST NOT contain a free-standing `deliverToChannel(...)` call.
 *     Consume the method via `deps.deliveryService.deliverToChannel(...)`
 *     instead. Path-tail allowlist exempts the impl declaration site and
 *     the test factory.
 *   - no-deps-optional-in-delivery: files under packages/core/src/delivery/
 *     MUST NOT use a `deps?:` optional-deps signature. The required-deps
 *     DeliveryService factory is the only legitimate shape.
 *
 * The closed-`errorKind` literal rule lives in a separate AST walker, not
 * here — that rule needs the TS TypeChecker to resolve Object.assign /
 * spread / member-access expressions, which source-grep cannot do.
 *
 * Sub-allowlist semantics:
 *   - SAFE_PATH_ALLOWLIST: each entry is a path-tail (substring match
 *     against the absolute path). The canonical safe-path implementation
 *     file is the sole entry, plus a carve-out for the symlink-aware
 *     skill discovery.
 *   - NO_FREE_DELIVER_ALLOWLIST: exactly two path-tails — the
 *     `DeliveryService.deliverToChannel(...)` method declaration in
 *     `core/src/delivery/delivery-service.ts` (the symbol's only legitimate
 *     bare-token site, since the regex catches the method-declaration
 *     syntax) and the `makeDeliveryService` test factory in
 *     `test/support/factories.ts` (defensive — the file no longer matches
 *     the regex, but the allowlist entry is retained deliberately).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findInSourceFiles } from "../support/source-grep.js";
import { formatViolations } from "../support/architecture-helpers.js";
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
 * safePath sub-allowlist (1 entry).
 *
 * The sole entry (`core/src/security/safe-path.ts`) is the canonical
 * implementation of `safePath` itself — by definition it must call
 * `path.join` internally. Every other call site was migrated to
 * `safePath(base, ...segments)`.
 *
 * Zod issue-path joins like `i.path.join(".")` and
 * `result.error.issues.map((i) => i.path.join("."))` are filtered by
 * the regex below — they are NOT file-path constructions and remain
 * legitimate. The regex uses a negative lookbehind `(?<!\.)` to
 * distinguish raw `path.join(...)` from member access on objects whose
 * `path` property carries a Zod issue path array (e.g., `i.path` /
 * `issue.path` / `result.error.issues[*].path`).
 *
 * Format: each entry is a path-tail. The check uses `m.endsWith(allowed)`
 * so the entry is matched as a suffix of the absolute file path.
 */
const SAFE_PATH_ALLOWLIST: readonly string[] = [
  // canonical safePath implementation (path.join is the safe wrapper's body)
  "core/src/security/safe-path.ts",
  // Skill discovery legitimately follows symlinks (dedup via realpath); the
  // readdir-walker uses path.join because entry.name comes from
  // fs.readdirSync (kernel-validated basename — cannot contain a path
  // separator) AND safePath's symlink-escape check would reject the
  // intentional symlink-to-sibling pattern used for skill-dir aliasing
  // (verified by the "symlink deduplication" tests in discovery.test.ts and
  // skill-registry.test.ts). All other call sites in this file use safePath.
  "skills/src/skills/registry/discovery.ts",
  // The bind-mount validator: a path-VALIDATOR (the inverse of
  // safePath) that intentionally reasons over NON-base-confined absolute system
  // and credential paths (/etc, /proc, ~/.ssh, ...). safePath(base, ...) would
  // throw on any path outside `base`, which is exactly the set this validator
  // must inspect, and it resolves symlinks-through-ancestors via realpathSync to
  // reject escapes (safePath's confinement check would mis-handle the
  // intentional symlink-to-blocked-target cases the deny-branch tests assert).
  // Same justification class as safe-path.ts above. Covered by
  // bind-mount-validator.test.ts (all three deny branches + allow cases).
  "core/src/security/bind-mount-validator.ts",
] as const;

/**
 * NO_FREE_DELIVER_ALLOWLIST (2 entries).
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
 * `deliverToChannel(` token today, but the entry is retained as a
 * defensive guard: if the factory evolves to expose a method-declaration
 * form, it must remain the only second site.
 *
 * Path-tail match (`m.endsWith(allowed)`) so any future move of these
 * files within the same suffix continues to apply.
 */
const NO_FREE_DELIVER_ALLOWLIST: readonly string[] = [
  "core/src/delivery/delivery-service.ts",
  "test/support/factories.ts",
] as const;

describe("source-rules -- safePath", () => {
  for (const pkg of WORKSPACE_PACKAGES) {
    it(`packages/${pkg}/src does NOT call raw path.join (use safePath instead)`, () => {
      const result = findInSourceFiles({
        rootDir: resolve(PACKAGES_ROOT, pkg, "src"),
        // Match `path.join(`, `nodePath.join(`, or `join as pathJoin` aliases.
        // The negative lookbehind `(?<!\.)` carve-out skips member access
        // like `i.path.join(".")` /
        // `issue.path.join(".")` / `result.error.issues[*].path.join(".")`,
        // which are STRING JOINS over Zod's issue path arrays (not file
        // paths). It also avoids false-positives on tokens like
        // `something.path.join` carrying a Zod-shaped `path` property.
        needle: /(?<!\.)\bpath\.join\s*\(|(?<!\.)\bnodePath\.join\s*\(|\bjoin\s+as\s+pathJoin\b/,
        excludeFileSuffixes: [".test.ts"],
      });
      const offenders = result.matches.filter(
        (m) => !SAFE_PATH_ALLOWLIST.some((allowed) => m.endsWith(allowed)),
      );
      expect(
        offenders,
        formatViolations({
          description: `packages/${pkg}/src must use safePath(base, ...segments) instead of raw path.join.`,
          violations: offenders.map((file) => ({ file, line: 0 })),
          suggestedFix:
            "Replace `path.join(base, segment, ...)` with `safePath(base, segment, ...)` from @comis/core. safePath enforces no path traversal beyond `base` (per OWASP V12).",
          allowlistRef: "SAFE_PATH_ALLOWLIST (in-file sub-allowlist)",
        }),
      ).toEqual([]);
      expect(
        result.checkedFiles,
        "sanity: helper walked at least one production source file",
      ).toBeGreaterThan(0);
    });
  }
});

describe("source-rules -- no-free-deliverToChannel", () => {
  for (const pkg of WORKSPACE_PACKAGES) {
    it(`packages/${pkg}/src does NOT contain a free-standing deliverToChannel(...) call`, () => {
      const result = findInSourceFiles({
        rootDir: resolve(PACKAGES_ROOT, pkg, "src"),
        // Match `deliverToChannel(` only when NOT preceded by `.` — the
        // negative lookbehind `(?<!\.)` excludes method-form calls like
        // `deps.deliveryService.deliverToChannel(...)` (the CORRECT pattern)
        // and only flags bare-token sites: the method-declaration syntax in
        // `delivery-service.ts` (allowlisted) and any future free-standing
        // function or top-level call that would re-introduce the forbidden
        // shape. Mirrors the safePath `(?<!\.)\bpath\.join` pattern verbatim.
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
            "Inject DeliveryService via deps and call deliveryService.deliverToChannel(adapter, channelId, text, options).",
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

describe("source-rules -- no-deps-optional-in-delivery", () => {
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
          "Delivery code must require deps; optional deps (deps?: ...) is forbidden.",
        violations: result.matches.map((file) => ({ file, line: 0 })),
        suggestedFix:
          "Change `deps?: DeliveryServiceDeps` to `deps: DeliveryServiceDeps`. Construct the service at composition root and inject the resolved DeliveryService into call sites; do not push optional deps through the call chain.",
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
// disableRedaction production-source forbidden invariant.
//
// The `LoggerOptions.disableRedaction` option is for the residency
// integration test ONLY. If any production code sets it to `true`,
// plaintext secrets could surface in production logs.
//
// The needle `/disableRedaction\s*:\s*true/` matches the literal assignment
// form (object-literal or named-object spread). It does NOT match the
// optional-field declaration `disableRedaction?: boolean;` in
// `packages/infra/src/logging/logger.ts` (the `?` after the field name and
// `boolean` value do not match the literal `true`).
//
// The residency test (`test/integration/secret-rpc-residency.test.ts`)
// lives OUTSIDE `packages/*\/src/` and is therefore not scanned by this
// rule — that file is allowed to set `disableRedaction: true`.
// ---------------------------------------------------------------------------

describe("source-rules -- disableRedaction forbidden in production source", () => {
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
        }),
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Secret-residency AST walker invariant on secret-RPC handler files.
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
// The walker scope extends to `auth-handlers.ts`. When that file does not
// yet exist, the assertion is skipped via `it.skipIf(!existsSync(...))`.
// ---------------------------------------------------------------------------

describe("source-rules -- secret-residency", () => {
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
          "packages/daemon/src/api/secrets-handlers.ts must not retain plaintext across handler invocations. Two rules: (1) no module-level/class-level let/const binding named /secret|decrypted|plaintext/i with secret-source initializer; (2) no Promise.all closure capturing such a binding from outer scope.",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.character,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Remove any module-level / class-level binding named /secret|decrypted|plaintext/i whose initializer comes from SecretStorePort / SecretManager / SecretsCrypto. Remove any Promise.all closure that captures such a binding from outer scope. See core/src/security/SECRET-RPC-CHECKLIST.md sections B (Plaintext residency) and D (Architecture-test alignment).",
      }),
    ).toEqual([]);
  });

  // The walker scope extends to packages/daemon/src/api/auth-handlers.ts:
  // auth.list returns OAuth-token-bearing data structurally (un-projected
  // OAuthProfile[] lives in handler closure between port.list() and
  // redactProfileForRpc). The same residency discipline applies. When the
  // file does not yet exist, skipIf prevents the assertion from running.
  const AUTH_HANDLERS_PATH = resolve(
    PACKAGES_ROOT,
    "daemon/src/api/auth-handlers.ts",
  );
  const authHandlersExists = existsSync(AUTH_HANDLERS_PATH);
  it.skipIf(!authHandlersExists)(
    "packages/daemon/src/api/auth-handlers.ts does NOT leak OAuth tokens via residency violations",
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
        }),
      ).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Source-grep for the literal "[REDACTED]" string.
//
// The Pino redact censor uses the edge-keeping maskToken callback from
// @comis/observability/redact, not the literal sentinel. ESLint
// enforces this via a no-restricted-syntax selector in eslint.config.js;
// this source-grep is the defense-in-depth mirror — it catches the
// bytes even if the AST walker is bypassed.
//
// The grep walks every production packages/*/src/**/*.ts file
// (excluding .test.ts). Sites that legitimately need the literal
// (pre-existing non-Pino-censor sentinels, e.g. session-secret
// scrubbing, RPC placeholder-rejection guards, web-API error
// sanitization) carry an inline `// eslint-disable-next-line
// no-restricted-syntax` annotation citing them as pre-existing
// patterns. We grep for the literal AND filter out:
//   1) lines carrying the eslint-disable annotation;
//   2) the previous line carrying the eslint-disable-next-line annotation;
//   3) comment-only lines (the rule is about value positions, not docs);
//   4) regex character-class / pattern bodies referencing the literal
//      for REJECTION purposes (e.g., `/^\[REDACTED[^\]]*\]$/`).
// ---------------------------------------------------------------------------

const REDACTED_INLINE_DISABLE_RE = /eslint-disable[^\n]*no-restricted-syntax/;

// Matches a BARE `"[REDACTED]"` or `'[REDACTED]'` literal — exactly the
// AST shape `Literal[value='[REDACTED]']` that ESLint's no-restricted-
// syntax rule catches. We intentionally do NOT match templated literals
// like `"sk-ant-[REDACTED]"` (which combine provider context with a
// fixed mask suffix and are a legitimate sanitizer pattern — see
// `packages/core/src/security/log-sanitizer.ts`). Those are not the
// Pino censor literal and need no annotation.
const BARE_REDACTED_LITERAL_RE = /(?<!\\)(?:"\[REDACTED\]"|'\[REDACTED\]')/;

describe("source-rules -- [REDACTED] literal forbidden in production source", () => {
  for (const pkg of WORKSPACE_PACKAGES) {
    it(`packages/${pkg}/src does NOT contain a bare "[REDACTED]" literal (use maskToken instead)`, () => {
      const pkgSrcDir = resolve(PACKAGES_ROOT, pkg, "src");
      if (!existsSync(pkgSrcDir)) {
        // Package has no src/ (e.g., umbrella package).
        return;
      }
      const result = findInSourceFiles({
        rootDir: pkgSrcDir,
        needle: BARE_REDACTED_LITERAL_RE,
        excludeFileSuffixes: [".test.ts"],
      });
      const offenders: string[] = [];
      for (const file of result.matches) {
        const contents = readFileSync(file, "utf8");
        const lines = contents.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (!BARE_REDACTED_LITERAL_RE.test(line)) continue;
          // (1) Same-line eslint-disable carve-out.
          if (REDACTED_INLINE_DISABLE_RE.test(line)) continue;
          // (2) Previous-line eslint-disable-next-line carve-out.
          if (i > 0) {
            const prev = lines[i - 1]!;
            if (
              prev.includes("eslint-disable-next-line") &&
              REDACTED_INLINE_DISABLE_RE.test(prev)
            ) {
              continue;
            }
          }
          // (3) Comment-only line — rule is about value positions.
          const trimmed = line.trimStart();
          if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
          // (4) Regex character-class / pattern body (rejection guards).
          if (/\/\^?\\?\[REDACTED/.test(line) || /\\\[REDACTED/.test(line)) continue;
          offenders.push(`${file}:${i + 1}`);
        }
      }
      expect(
        offenders,
        formatViolations({
          description:
            `packages/${pkg}/src must not contain a bare "[REDACTED]" literal in production source. ` +
            `The Pino censor uses maskToken() (edge-keeping mask) from @comis/observability/redact. ` +
            `Pre-existing non-Pino-censor sentinels carry an inline eslint-disable-next-line annotation citing them as pre-existing patterns.`,
          violations: offenders.map((entry) => {
            const [file, line] = entry.split(":");
            return {
              file: file ?? entry,
              line: Number(line ?? 0),
              snippet: '"[REDACTED]"',
            };
          }),
          suggestedFix:
            "Use maskToken(value) from @comis/observability/redact (or import via @comis/observability barrel). " +
            "If this is a pre-existing non-Pino-censor sentinel, add an inline " +
            "`// eslint-disable-next-line no-restricted-syntax -- <reason>` annotation on the line above.",
        }),
      ).toEqual([]);
    });
  }
});
