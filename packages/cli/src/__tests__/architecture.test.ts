// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/cli.
 *
 * Forbidden-import rules:
 *   - L17: CLOSED in Phase 35 Plan 35-04 (WEB-CONTRACTS-02). All previously
 *     allowlisted cli → @comis/agent sites have been retargeted to
 *     @comis/core; `@comis/agent` is now in HARD_FORBIDDEN_PACKAGES.
 *   - L12: CLOSED in Phase 35 Plan 35-05 (WEB-CONTRACTS-03). All previously
 *     allowlisted cli → @comis/infra sites have been retargeted to
 *     @comis/core (createConsoleLogger replaces createLogger; isDocker
 *     relocated in Plan 35-02). `@comis/infra` is now in HARD_FORBIDDEN_PACKAGES.
 *   - L11: cli → memory imports allowlisted at existing site(s);
 *     cli → memory closes in Phase 31 (MEM-CTX-PORTS-02).
 *   - Production source MUST NOT import @comis/{agent, infra, channels, skills,
 *     scheduler, gateway, daemon, orchestrator}.
 *
 * Each it() destructures `{ violations, checkedFiles }` from
 * `findForbiddenImports` (Plan 01 result-shape change) and adds a
 * Pattern E sanity check on `checkedFiles`.
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

// L17: CLOSED in Phase 35 Plan 35-04 (WEB-CONTRACTS-02). The 9-site allowlist
// is empty — all cli → @comis/agent imports have been retargeted to
// @comis/core. @comis/agent is now in HARD_FORBIDDEN_PACKAGES (see below).

// L11: closed in Phase 31 commit 12 (MEM-CTX-PORTS-02 / MEM-CTX-PORTS-09) —
// secrets RPC migration eliminated the last cli → memory value-import.
const L11_ALLOWLIST: readonly string[] = [];

// L12: CLOSED in Phase 35 Plan 35-05 (WEB-CONTRACTS-03). The 3-site allowlist
// is empty — all cli → @comis/infra imports have been retargeted to
// @comis/core (createConsoleLogger replaces createLogger; isDocker relocated
// in Plan 35-02). @comis/infra is now in HARD_FORBIDDEN_PACKAGES.
const L12_INFRA_ALLOWLIST = [] as const;

const HARD_FORBIDDEN_PACKAGES = [
  // Phase 35 Plan 35-04 (WEB-CONTRACTS-02 / L17 closure): @comis/agent
  // promoted to HARD_FORBIDDEN after every CLI agent-import site retargeted
  // to @comis/core (D-01 #1/#2/#3/#4/#5).
  "@comis/agent",
  // Phase 35 Plan 35-05 (WEB-CONTRACTS-03 / L12 closure): @comis/infra
  // promoted to HARD_FORBIDDEN after every CLI infra-import site retargeted
  // to @comis/core (createConsoleLogger + isDocker).
  "@comis/infra",
  "@comis/channels",
  "@comis/skills",
  "@comis/scheduler",
  "@comis/gateway",
  "@comis/daemon",
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
          "CLI commands that need memory-store data move to daemon-backed RPC in Phase 31 (MEM-CTX-PORTS-09). The cli → memory edge dies entirely in Phase 31 (MEM-CTX-PORTS-02).",
        designRef: "design §1.3 L11 / §8.2.7 (Phase 31)",
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
          "L12 is CLOSED in Phase 35 Plan 35-05 (WEB-CONTRACTS-03). Retarget the import to @comis/core: { createConsoleLogger } replaces { createLogger } (Plan 35-02 shipped the Pino-free logger); { isDocker } moved to @comis/core in Plan 35-02 (WEB-CONTRACTS-05).",
        designRef: "design §1.3 L12 / §11 (Phase 35 console-logger + is-docker) / Phase 35 Plan 35-05",
        allowlistRef: "L12 (CLOSED)",
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
          suggestedFix: `cli depends per §2.2 on {@comis/shared, @comis/core, @comis/memory (until L11 closes)}. L12 (infra) CLOSED in Phase 35 Plan 35-05; L17 (agent) CLOSED in Phase 35 Plan 35-04. ${forbidden} is NEVER permitted.`,
          designRef: "design §2.2 (target package graph)",
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
// Phase 31 commit 10 (MEM-CTX-PORTS-10) -- daemon-required help-text patterns.
//
// Every store-backed secrets subcommand must document the daemon precondition
// in its Commander .description() string. Source-grep approach (simpler than
// rendering Commander help).
//
// Store-backed (REQUIRE suffix): set, get, list, delete, import.
// Daemon-free  (FORBID suffix):  init, audit.
// ---------------------------------------------------------------------------

describe("Phase 31 -- daemon-required help-text patterns (MEM-CTX-PORTS-10)", () => {
  const SECRETS_FILE = resolve(SRC_ROOT, "commands/secrets.ts");
  const SECRETS_REQUIRED_PATTERN = /Requires the comis daemon to be running\./;

  it("secrets set description contains the daemon-required precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "set <name>");
    expect(
      sec,
      "secrets set description must declare daemon precondition (MEM-CTX-PORTS-10)",
    ).toMatch(SECRETS_REQUIRED_PATTERN);
  });

  it("secrets get description contains the daemon-required precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "get <name>");
    expect(sec).toMatch(SECRETS_REQUIRED_PATTERN);
  });

  it("secrets list description contains the daemon-required precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "list");
    expect(sec).toMatch(SECRETS_REQUIRED_PATTERN);
  });

  it("secrets delete description contains the daemon-required precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "delete <name>");
    expect(sec).toMatch(SECRETS_REQUIRED_PATTERN);
  });

  it("secrets import description contains the daemon-required precondition string", () => {
    const contents = readFileSync(SECRETS_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "import");
    expect(sec).toMatch(SECRETS_REQUIRED_PATTERN);
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
// Phase 31 commit 11 (MEM-CTX-PORTS-10) -- auth subcommand help-text patterns.
// Reuses `extractSubcommandDescription` declared at MODULE SCOPE below (see
// plan 31-10 commit 10; I-05 fix in 31-11 revision iter 2 hoisted it if it
// was declared inside the secrets describe).
//
// `auth login` description must declare file-backed-local + encrypted-not-
// supported. `auth list/logout/status` descriptions must declare the
// conditional daemon-required precondition.
// ---------------------------------------------------------------------------

describe("Phase 31 -- auth help-text patterns (MEM-CTX-PORTS-10)", () => {
  const AUTH_FILE = resolve(SRC_ROOT, "commands/auth.ts");
  const AUTH_ENCRYPTED_PATTERN = /Requires the comis daemon to be running when oauth\.storage is 'encrypted'\./;
  const AUTH_LOGIN_PATTERN = /Runs locally for file-backed storage\. Daemon-assisted login for encrypted storage is not yet supported\./;

  it("auth list description contains the conditional daemon-required precondition string", () => {
    const contents = readFileSync(AUTH_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "list");
    expect(
      sec,
      "auth list description must declare daemon-required-when-encrypted precondition (MEM-CTX-PORTS-10)",
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

  it("auth login description names the file-backed local + encrypted-not-supported contract", () => {
    const contents = readFileSync(AUTH_FILE, "utf8");
    const sec = extractSubcommandDescription(contents, "login");
    expect(
      sec,
      "auth login must declare file-backed-local + encrypted-not-supported per MEM-CTX-PORTS-10",
    ).toMatch(AUTH_LOGIN_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL -- module-scope placement (per Phase 31 revision iter 2 / I-05 fix):
// `extractSubcommandDescription` MUST be declared at MODULE SCOPE in this file
// (outside the describe block above). Plan 31-11 task 3 reuses it for the auth
// help-text invariants. If it is accidentally placed INSIDE the describe
// block, plan 31-11's tests cannot see the helper and TypeScript fails at
// compile time.
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
 * (e.g. `oauth.storage is 'encrypted'`) are NOT treated as the closing
 * quote (Rule 3 fix in plan 31-11 task 3).
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
