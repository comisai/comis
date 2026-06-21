// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/cli.
 *
 * Forbidden-import rules:
 *   - L17 (CLOSED): all previously allowlisted cli → @comis/agent sites
 *     have been retargeted to @comis/core; `@comis/agent` is now in
 *     HARD_FORBIDDEN_PACKAGES.
 *   - L12 (CLOSED): all previously allowlisted cli → @comis/infra sites
 *     have been retargeted to @comis/core (createConsoleLogger replaces
 *     createLogger; isDocker relocated). `@comis/infra` is now in
 *     HARD_FORBIDDEN_PACKAGES.
 *   - L11: cli → memory imports allowlisted at existing site(s); the
 *     edge is scheduled to close once the secrets RPC migration lands.
 *   - Production source MUST NOT import @comis/{agent, infra, channels, skills,
 *     scheduler, gateway, daemon, orchestrator}.
 *
 * Each it() destructures `{ violations, checkedFiles }` from
 * `findForbiddenImports` and adds a sanity check on `checkedFiles`.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

// L17 (CLOSED): the previous 9-site allowlist is empty — all
// cli → @comis/agent imports have been retargeted to @comis/core.
// @comis/agent is now in HARD_FORBIDDEN_PACKAGES (see below).

// L11 re-opened for four sites:
//   1. util/offline-secrets-store.ts — the CLI's offline secrets adapter (daemon-free bootstrap)
//   2. doctor/repairs/repair-lcd.ts — the offline LCD repair path (DOC-03, Phase 171-04):
//      the contentless lcd_messages_fts cannot use the FTS5 'rebuild' idiom; the repair
//      re-derives FTS content via renderMessageFtsText (same render fn as the lcd-store adapter
//      populate path). This is the only @comis/memory import in the repair layer.
//   3. commands/cost-export.ts — the `comis cost export` CLI (179-03): imports the
//      ObservabilityStore cost-aggregate TYPES (QuarterHourBucket / CostBucketFilter) it
//      projects offline. Type-only; the data read routes through offline-obs's assemblers.
//   4. util/offline-obs.ts — the offline obs adapter (already the sole L18 @comis/daemon
//      site): the same cost-aggregate types ride its `comis cost export --offline` /
//      `comis fleet --offline` local-read path.
// All other CLI memory access routes through daemon RPC.
const L11_ALLOWLIST: readonly string[] = [
  "util/offline-secrets-store.ts",
  "doctor/repairs/repair-lcd.ts",
  "commands/cost-export.ts",
  "util/offline-obs.ts",
];

// L12 (CLOSED): the previous 3-site allowlist is empty — all
// cli → @comis/infra imports have been retargeted to @comis/core
// (createConsoleLogger replaces createLogger; isDocker relocated).
// @comis/infra is now in HARD_FORBIDDEN_PACKAGES.
const L12_INFRA_ALLOWLIST = [] as const;

// L18 (W14 obs-llm-troubleshooting): @comis/daemon re-opened for exactly one
// site — the CLI's OFFLINE obs adapter. `comis explain --offline` /
// `comis fleet --offline` (and the automatic unreachable-gateway fallback)
// reuse the daemon's exported PURE report assemblers over the local ~/.comis
// files; requiring a live daemon to read local telemetry defeated the
// post-mortem tool exactly when it was needed. A single bounded adapter file
// contains all @comis/daemon imports so a future closure is one deletion.
// Live-daemon access still routes through RPC.
const L18_DAEMON_ALLOWLIST: readonly string[] = [
  "util/offline-obs.ts",
];

const HARD_FORBIDDEN_PACKAGES = [
  // L17 closure: @comis/agent promoted to HARD_FORBIDDEN after every
  // CLI agent-import site retargeted to @comis/core.
  "@comis/agent",
  // L12 closure: @comis/infra promoted to HARD_FORBIDDEN after every
  // CLI infra-import site retargeted to @comis/core (createConsoleLogger + isDocker).
  "@comis/infra",
  "@comis/channels",
  "@comis/skills",
  "@comis/scheduler",
  "@comis/gateway",
  "@comis/orchestrator",
] as const;

describe("@comis/cli -- architecture invariants", () => {

  it("production source does NOT import @comis/memory (outside L11 allowlist)", () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: SRC_ROOT,
      forbiddenPackage: "@comis/memory",
      allowlistPaths: [...L11_ALLOWLIST],
    });
    expect(
      violations,
      formatViolations({
        description:
          "@comis/cli production source must not import @comis/memory (outside L11 allowlist).",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          "CLI commands that need memory-store data should move to daemon-backed RPC. The cli → memory edge is scheduled to die entirely.",
        allowlistRef: "L11",
      }),
    ).toEqual([]);
    expect(
      checkedFiles,
      "sanity: findForbiddenImports walked at least one cli/src file",
    ).toBeGreaterThan(0);
  });

  it("production source does NOT import @comis/infra (outside L12 allowlist)", () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: SRC_ROOT,
      forbiddenPackage: "@comis/infra",
      allowlistPaths: [...L12_INFRA_ALLOWLIST],
    });
    expect(
      violations,
      formatViolations({
        description:
          "@comis/cli production source must not import @comis/infra (outside L12 allowlist).",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          "L12 is CLOSED. Retarget the import to @comis/core: { createConsoleLogger } replaces { createLogger } (the Pino-free logger); { isDocker } also lives in @comis/core.",
        allowlistRef: "L12 (CLOSED)",
      }),
    ).toEqual([]);
    expect(
      checkedFiles,
      "sanity: findForbiddenImports walked at least one cli/src file",
    ).toBeGreaterThan(0);
  });

  it("production source does NOT import @comis/daemon (outside the L18 offline-obs allowlist)", () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: SRC_ROOT,
      forbiddenPackage: "@comis/daemon",
      allowlistPaths: [...L18_DAEMON_ALLOWLIST],
    });
    expect(
      violations,
      formatViolations({
        description:
          "@comis/cli production source must not import @comis/daemon (outside the L18 offline-obs allowlist).",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Live-daemon access routes through RPC (callTyped). Only the offline obs fallback (util/offline-obs.ts) may import the daemon's exported pure assemblers.",
        allowlistRef: "L18",
      }),
    ).toEqual([]);
    expect(
      checkedFiles,
      "sanity: findForbiddenImports walked at least one cli/src file",
    ).toBeGreaterThan(0);
  });

  for (const forbidden of HARD_FORBIDDEN_PACKAGES) {
    it(`production source does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/cli production source must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix: `cli depends only on {@comis/shared, @comis/core, @comis/memory (until L11 closes)}. L12 (infra) and L17 (agent) are CLOSED. ${forbidden} is NEVER permitted.`,
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one cli/src file",
      ).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Daemon-required help-text patterns.
//
// Store-backed secrets subcommands must document daemon precondition or
// fallback behavior in their Commander .description() string.
// Source-grep approach (simpler than rendering Commander help).
//
// Fallback-capable (set, list, import): daemon RPC when up; direct store when down.
// Daemon-default w/ explicit offline (get): daemon RPC by default (audit-logged);
//   `--offline` reads the local store directly (W15 — breaks the gateway-token
//   chicken-and-egg where fetching COMIS_GATEWAY_TOKEN required the token).
// Daemon-required  (delete):            always require daemon — no offline fallback.
// Daemon-free      (init, audit):       never mention daemon as required.
// ---------------------------------------------------------------------------

describe("daemon-required help-text patterns", () => {
  const SECRETS_FILE = resolve(SRC_ROOT, "commands/secrets.ts");
  // Pattern for subcommands that require the daemon with no fallback (get, delete).
  const SECRETS_REQUIRED_PATTERN = /Requires the comis daemon to be running\./;
  // Pattern for subcommands with an offline fallback (set, list, import).
  const SECRETS_FALLBACK_PATTERN =
    /Uses daemon RPC when running; falls back to direct store when daemon is offline\./;

  it("secrets set description contains the daemon-fallback precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "set <name>");
    expect(
      sec,
      "secrets set description must declare daemon-fallback precondition",
    ).toMatch(SECRETS_FALLBACK_PATTERN);
  });

  it("secrets get description documents the daemon default AND the explicit --offline escape (W15)", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "get <name>");
    expect(sec).toMatch(/Requires the comis daemon to be running/);
    expect(sec).toMatch(/--offline/);
    expect(sec).toMatch(/SECRETS_MASTER_KEY/);
  });

  it("secrets list description contains the daemon-fallback precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "list");
    expect(sec).toMatch(SECRETS_FALLBACK_PATTERN);
  });

  it("secrets delete description contains the daemon-required precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "delete <name>");
    expect(sec).toMatch(SECRETS_REQUIRED_PATTERN);
  });

  it("secrets import description contains the daemon-fallback precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "import");
    expect(sec).toMatch(SECRETS_FALLBACK_PATTERN);
  });

  it("secrets init description does NOT contain the daemon-required precondition (init is daemon-free)", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "init");
    expect(sec).not.toMatch(SECRETS_REQUIRED_PATTERN);
  });

  it("secrets audit description does NOT contain the daemon-required precondition (audit is daemon-free)", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "audit");
    expect(sec).not.toMatch(SECRETS_REQUIRED_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// auth subcommand help-text patterns. Reuses `extractSubcommandDescription`
// declared at MODULE SCOPE below.
//
// `auth login` description must declare file-backed-local + encrypted-not-
// supported. `auth list/logout/status` descriptions must declare the
// conditional daemon-required precondition.
// ---------------------------------------------------------------------------

describe("auth help-text patterns", () => {
  const AUTH_FILE = resolve(SRC_ROOT, "commands/auth.ts");
  const AUTH_ENCRYPTED_PATTERN = /Requires the comis daemon to be running when security\.storage is 'encrypted'\./;
  const AUTH_LOGIN_PATTERN = /File mode stores locally\. Encrypted mode routes through the daemon \(auth\.set RPC\)\./;

  it("auth list description contains the conditional daemon-required precondition string", () => {
    const contents = readFileSync(AUTH_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "list");
    expect(
      sec,
      "auth list description must declare daemon-required-when-encrypted precondition",
    ).toMatch(AUTH_ENCRYPTED_PATTERN);
  });

  it("auth logout description contains the conditional daemon-required precondition string", () => {
    const contents = readFileSync(AUTH_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "logout");
    expect(sec).toMatch(AUTH_ENCRYPTED_PATTERN);
  });

  it("auth status description contains the conditional daemon-required precondition string", () => {
    const contents = readFileSync(AUTH_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "status");
    expect(sec).toMatch(AUTH_ENCRYPTED_PATTERN);
  });

  it("auth login description names the file-backed local + encrypted-daemon-assisted contract", () => {
    const contents = readFileSync(AUTH_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "login");
    expect(
      sec,
      "auth login must declare file-backed-local + encrypted-daemon-assisted (auth.set RPC)",
    ).toMatch(AUTH_LOGIN_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL -- module-scope placement: `extractSubcommandDescription` MUST be
// declared at MODULE SCOPE in this file (outside the describe blocks above) so
// the auth-help-text describe block can see it. If it is accidentally placed
// INSIDE a describe block, the auth tests cannot see the helper and TypeScript
// fails at compile time.
// ---------------------------------------------------------------------------

/**
 * Extracts the .description() string that immediately follows a
 * .command("<subcommand>") call. Returns undefined if not found.
 *
 * Heuristic regex -- looks for `.command("<subcommand>")` followed by any
 * whitespace + `.description("<desc>")`. The description argument may span
 * multiple physical lines (Prettier wraps long strings) but is otherwise a
 * single double-quoted OR single-quoted JavaScript string literal at the
 * Commander API. The quote-type-aware variant matches the SAME quote that
 * opened the string, so apostrophes inside a double-quoted description
 * (e.g. `oauth.storage is 'encrypted'`) are NOT treated as the closing quote.
 */
function extractSubcommandDescription(
  source: string,
  subcommand: string,
): string | undefined {
  const escaped = subcommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Capture the opening quote in group 1 (`["']`) then back-reference it
  // for the closing quote. Description body (group 2) is any char that is
  // NOT the captured opening quote. `[\\s\\S]` is the multi-line-aware
  // "any char" equivalent of `.` without the `s` flag.
  const pattern = new RegExp(
    `\\.command\\(\\s*["']${escaped}["']\\s*\\)[\\s\\S]*?\\.description\\(\\s*(["'])((?:(?!\\1)[\\s\\S])*)\\1`,
  );
  const m = source.match(pattern);
  return m?.[2];
}
