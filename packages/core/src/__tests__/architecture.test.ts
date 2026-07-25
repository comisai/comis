// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/core.
 *
 * Source-grep boundary tests enforce that:
 *   - Production source MUST NOT import the test-only stub factory
 *     `createCapabilityPortStub` (lives in `__test-helpers/`).
 *   - Test source files MUST NOT import the production no-op
 *     `createNoOpCapabilityPort` (tests should use the stub instead),
 *     except for the no-op's own test file which legitimately
 *     references its own export.
 *   - core/bootstrap.ts MUST NOT import skills internals (McpClientManager,
 *     SkillRegistry, @comis/skills) — the live ToolCapabilityPort adapter
 *     is constructed in daemon-side wiring, not in core bootstrap.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import * as ts from "typescript";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const BOOTSTRAP_PATH_FRAGMENT = "bootstrap.ts";
const CATALOG_DIR = resolve(SRC_ROOT, "security/provider-catalog");

describe("@comis/core -- architecture invariants", () => {
  it("production source does NOT import createCapabilityPortStub", () => {
    // Default excludeDirs already drops __tests__ + __snapshots__ + dist + node_modules.
    // Add __test-helpers (where the stub legitimately lives) so the boundary
    // means "production OUTSIDE __test-helpers must not import the stub".
    // excludeFileSuffixes drops *.test.ts so test files (which legitimately
    // reference the literal in negative-export assertions) do not poison
    // the grep.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createCapabilityPortStub",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "__test-helpers"],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "production source must not import createCapabilityPortStub (use createNoOpCapabilityPort instead)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper actually walked files").toBeGreaterThan(0);
  });

  it("test source files do NOT import createNoOpCapabilityPort (except no-op's own test + port public-surface test)", () => {
    // Tests should use createCapabilityPortStub (in __test-helpers/) for
    // fixture overrides. Two legitimate exceptions exist within @comis/core:
    //   - no-op-tool-capability.test.ts  -- tests the no-op itself.
    //   - tool-capability.test.ts        -- verifies the port public surface
    //                                       (createNoOpCapabilityPort is
    //                                       re-exported from @comis/core;
    //                                       createCapabilityPortStub is NOT).
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    const ALLOWLIST = ["no-op-tool-capability.test.ts", "tool-capability.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "test files (outside the port public-surface test allowlist) must use createCapabilityPortStub instead of createNoOpCapabilityPort",
    ).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });

  it("exports FileLockPort interface from core/src/ports/file-lock.ts", () => {
    // Asserts the type-only port file exists and exports the expected
    // names (FileLockPort + LockOptions + LockError). The "ports/*.ts is
    // type-only" rule below gates that the file is type-only; this test
    // asserts the export shape.
    const portFile = resolve(SRC_ROOT, "ports/file-lock.ts");
    const source = readFileSync(portFile, "utf8");
    const missing: string[] = [];
    if (!/export\s+interface\s+FileLockPort\b/.test(source)) missing.push("FileLockPort");
    if (!/export\s+interface\s+LockOptions\b/.test(source)) missing.push("LockOptions");
    if (!/export\s+type\s+LockError\b/.test(source)) missing.push("LockError");
    if (!/cleanupStaleLocks\s*\(/.test(source)) missing.push("cleanupStaleLocks");
    expect(
      missing,
      "core/src/ports/file-lock.ts must export FileLockPort + LockOptions + LockError and the FileLockPort surface must include cleanupStaleLocks.",
    ).toEqual([]);
  });

  it("OAuth rewritten errors expose code (OAuthErrorCode) and logErrorKind (closed Pino ErrorKind), with no string-typed errorKind field", () => {
    // The RewrittenOAuthError interface in core/src/security/oauth-helpers.ts
    // must expose:
    //   - `code: OAuthErrorCode` (domain discriminator)
    //   - `logErrorKind: ErrorKind` (closed-Pino-union mirror)
    // and MUST NOT declare an `errorKind:` field (a string-typed mirror
    // would bypass the closed union; the closed-union field is named
    // logErrorKind). The architecture rule structurally gates regressions —
    // any introduction of an `errorKind` field on this interface fails the
    // build.
    const oauthFile = resolve(SRC_ROOT, "security/oauth-helpers.ts");
    const source = readFileSync(oauthFile, "utf8");
    const ifaceMatch = /export\s+interface\s+RewrittenOAuthError\b[\s\S]*?\n\}/.exec(source);
    const missing: string[] = [];
    if (!ifaceMatch) {
      missing.push("RewrittenOAuthError interface declaration (not found)");
    } else {
      const ifaceBody = ifaceMatch[0];
      if (!/\bcode\s*:\s*OAuthErrorCode\b/.test(ifaceBody)) {
        missing.push("`code: OAuthErrorCode` (domain discriminator)");
      }
      if (!/\blogErrorKind\s*:\s*ErrorKind\b/.test(ifaceBody)) {
        missing.push("`logErrorKind: ErrorKind` (closed-union Pino mirror)");
      }
      if (/^[ \t]*errorKind\s*:/m.test(ifaceBody)) {
        missing.push(
          "STRING-TYPED `errorKind` FIELD STILL PRESENT (must be removed — rename to logErrorKind)",
        );
      }
    }
    // ErrorKind must be imported from core/logging/log-fields.js so the
    // closed-union type is bound to the canonical ErrorKind union.
    if (!/import\s+type\s+\{\s*ErrorKind\s*\}\s+from\s+"\.\.\/logging\/log-fields\.js"/.test(source)) {
      missing.push("`import type { ErrorKind } from \"../logging/log-fields.js\"`");
    }
    expect(
      missing,
      "core/src/security/oauth-helpers.ts must declare RewrittenOAuthError with `code: OAuthErrorCode` + `logErrorKind: ErrorKind`, with no string-typed `errorKind` field.",
    ).toEqual([]);
  });

  it("core/bootstrap.ts does NOT import McpClientManager, SkillRegistry, or @comis/skills", () => {
    // The live ToolCapabilityPort adapter is constructed in daemon-side
    // wiring, NOT in core bootstrap. Core bootstrap must not import
    // McpClientManager or SkillRegistry — those are daemon/skills
    // internals.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: /McpClientManager|SkillRegistry|@comis\/skills/,
      excludeFileSuffixes: [".test.ts"],
    });
    const offenders = result.matches.filter((m) => m.endsWith(BOOTSTRAP_PATH_FRAGMENT));
    expect(
      offenders,
      "core/bootstrap.ts must NOT import skills internals — the live adapter must not be constructed in core bootstrap (no McpClientManager, no SkillRegistry, no @comis/skills imports there).",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one file in @comis/core src tree").toBeGreaterThan(0);
  });

  for (const forbidden of ["@comis/skills", "@comis/infra"] as const) {
    it(`provider-catalog tree does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: CATALOG_DIR,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `packages/core/src/security/provider-catalog must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix: `Remove the ${forbidden} import. The provider-catalog is pure-logic; it must not depend on infra or skills.`,
          designRef: "catalog purity requirement",
        }),
      ).toEqual([]);
      expect(checkedFiles, "sanity: walked provider-catalog files").toBeGreaterThan(0);
    });
  }

  it("provider-catalog tree does NOT call console.* or Date.now() in production source", () => {
    // provider-catalog is a pure deterministic module — no logging, no timestamps.
    // Guard against future changes that accidentally introduce console calls or Date.now().
    for (const needle of [/console\./, /Date\.now\b/] as const) {
      const result = findInSourceFiles({
        rootDir: CATALOG_DIR,
        needle,
        excludeFileSuffixes: [".test.ts"],
      });
      expect(
        result.matches,
        `provider-catalog production source must not contain '${needle.source}' (pure-logic requirement)`,
      ).toEqual([]);
    }
  });
});

/* ---------------------------------------------------------------------- */
/*  core/src/ports/*.ts port-shape (type-only) enforcement                */
/* ---------------------------------------------------------------------- */

/**
 * Sub-allowlist — files in packages/core/src/ports/ that legitimately
 * contain runtime imports / value declarations.
 *
 * Runtime helpers (ChannelCapabilitySchema, createNoOpDeliveryQueue,
 * createNoOpDeliveryMirror, createNoOpCapabilityPort, validateProfileId,
 * PROFILE_ID_RE) live in non-ports/ home modules
 * (../domain/channel-capability.ts,
 * ../delivery/no-op-delivery-{queue,mirror}.ts,
 * ../tool-capability/no-op-tool-capability.ts, ../security/profile-id.ts);
 * the curated re-exports at ../exports/ports.ts expose them on the
 * @comis/core public surface.
 *
 * Every file under core/src/ports/*.ts is type-only:
 *   - all imports are `import type`
 *   - no top-level runtime value declarations (no `export const/let/var`,
 *     no `export function`, no `export class`)
 *   - re-exports (`export type { ... } from "..."`) are allowed; the AST
 *     walker only flags ImportDeclarations and locally-declared exports.
 *
 * The allowlist is therefore empty. Re-extending it is a regression.
 */
const L15_PORT_SHAPE_ALLOWLIST: ReadonlySet<string> = new Set<string>();

const PORTS_DIR = resolve(SRC_ROOT, "ports");

/**
 * Enumerate top-level .ts files in core/src/ports/ (no subdir descent, no
 * .test.ts).
 */
function listPortFiles(): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(PORTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    out.push(resolve(PORTS_DIR, entry.name));
  }
  return out;
}

/**
 * For a port file, return the array of port-shape violations:
 *   - Any non-type-only ImportDeclaration (including side-effect imports).
 *   - Any top-level runtime value declaration (function / class / const /
 *     let / var) with an `export` modifier.
 *
 * If both are empty, the file is type-only and conforms to the port-shape
 * rule.
 */
function findRuntimeShapeViolations(
  filePath: string,
): Array<{ line: number; column: number; snippet: string }> {
  const source = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2023, true);
  const violations: Array<{ line: number; column: number; snippet: string }> = [];
  ts.forEachChild(sf, (node) => {
    // Non-type-only ImportDeclaration => runtime import. An import with NO
    // importClause (`import "side-effect";`) is also a runtime import.
    if (ts.isImportDeclaration(node)) {
      const isTypeOnly = node.importClause?.isTypeOnly ?? false;
      const isSideEffect = !node.importClause;
      if (!isTypeOnly || isSideEffect) {
        const { line, character } = sf.getLineAndCharacterOfPosition(
          node.getStart(sf),
        );
        violations.push({
          line: line + 1,
          column: character + 1,
          snippet: source.split("\n")[line] ?? "",
        });
      }
    }
    // Top-level runtime value declarations with `export` modifier:
    //   export function ..., export class ..., export const/let/var ...
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isVariableStatement(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const { line, character } = sf.getLineAndCharacterOfPosition(
        node.getStart(sf),
      );
      violations.push({
        line: line + 1,
        column: character + 1,
        snippet: source.split("\n")[line] ?? "",
      });
    }
  });
  return violations;
}

describe("@comis/core -- port-shape", () => {
  it("packages/core/src/ports/*.ts files are type-only (import type ... only; no runtime values)", () => {
    const portFiles = listPortFiles();
    const offenders: Array<{
      file: string;
      line: number;
      column: number;
      snippet: string;
    }> = [];
    let checkedFiles = 0;
    for (const filePath of portFiles) {
      checkedFiles++;
      const baseName = filePath.split("/").pop() ?? "";
      if (L15_PORT_SHAPE_ALLOWLIST.has(baseName)) continue;
      const fileViolations = findRuntimeShapeViolations(filePath);
      for (const v of fileViolations) {
        offenders.push({ file: filePath, ...v });
      }
    }
    expect(
      offenders,
      formatViolations({
        description:
          "Files in packages/core/src/ports/*.ts must be TYPE-ONLY (every import is `import type {...}` and there are no top-level runtime value declarations). " +
          "If a runtime helper genuinely needs to live in ports/ temporarily, add its basename VERBATIM to L15_PORT_SHAPE_ALLOWLIST in this file with a rationale comment.",
        violations: offenders.map((o) => ({
          file: o.file,
          line: o.line,
          column: o.column,
          snippet: o.snippet,
        })),
        suggestedFix:
          "Move the runtime helper out of core/src/ports/ to a non-port core module (e.g., core/src/security/, core/src/delivery/, core/src/no-op/). " +
          "Update curated re-exports at core/src/exports/ports.ts so the public surface of @comis/core stays byte-identical. " +
          "If the move is deferred, add the file's basename to L15_PORT_SHAPE_ALLOWLIST with a rationale comment.",
        designRef: 'core/src/ports/*.ts must be type-only before new ports are added',
        allowlistRef: "L15_PORT_SHAPE_ALLOWLIST (in-file sub-allowlist)",
      }),
    ).toEqual([]);
    expect(
      checkedFiles,
      "sanity: at least one port file scanned (core/src/ports/ should not be empty)",
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Port-DTO residency invariants (text-level / regex — complementary to the
// TS-compiler-API walker in test/architecture/source-rules.test.ts).
// Row DTOs live in core/src/ports/{context-store,session-store}-types.ts
// (NOT inline in port files, NOT in core/src/domain/).
// ---------------------------------------------------------------------------

describe("port-DTO residency text-level checks", () => {
  const PORTS_DIR_P31 = resolve(SRC_ROOT, "ports");
  const DOMAIN_DIR_P31 = resolve(SRC_ROOT, "domain");

  it("session-store.ts declares the eight explicit-authority methods", () => {
    const portFile = readFileSync(resolve(PORTS_DIR_P31, "session-store.ts"), "utf8");
    expect(portFile).toMatch(/export\s+interface\s+SessionStorePort\b/);
    const expectedMethods = [
      "save",
      "load",
      "loadByRef",
      "list",
      "delete",
      "deleteByRef",
      "deleteStale",
      "listDetailed",
    ];
    for (const m of expectedMethods) {
      expect(
        portFile,
        `SessionStorePort must declare method ${m}()`,
      ).toMatch(new RegExp(`\\b${m}\\s*\\(`));
    }
  });

  it("no Ctx*Row or Session{Data,ListEntry,DetailedEntry} types live in core/src/domain/ (preserves domain/persistence boundary)", () => {
    if (!existsSync(DOMAIN_DIR_P31)) return; // domain dir is optional
    const domainFiles = readdirSync(DOMAIN_DIR_P31).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    const offenders: string[] = [];
    for (const f of domainFiles) {
      const content = readFileSync(resolve(DOMAIN_DIR_P31, f), "utf8");
      if (
        /\bexport\s+(interface|type)\s+(Ctx[A-Z][A-Za-z]+Row|SessionData|SessionListEntry|SessionDetailedEntry)\b/.test(
          content,
        )
      ) {
        offenders.push(f);
      }
    }
    expect(
      offenders,
      "Row DTOs must live in core/src/ports/, NOT core/src/domain/. Move declarations to context-store-types.ts or session-store-types.ts.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// secrets-handlers integrity invariants.
// ---------------------------------------------------------------------------

describe("secrets-handlers integrity", () => {
  const HANDLERS_FILE = resolve(
    SRC_ROOT,
    "..",
    "..",
    "daemon",
    "src",
    "api",
    "secrets-handlers.ts",
  );
  const SETUP_GATEWAY_RPC_FILE = resolve(
    SRC_ROOT,
    "..",
    "..",
    "daemon",
    "src",
    "wiring",
    "setup-gateway-api.ts",
  );
  const CHECKLIST_FILE = resolve(
    SRC_ROOT,
    "security",
    "SECRET-RPC-CHECKLIST.md",
  );

  it("secrets-handlers.ts leading comment references core/src/security/SECRET-RPC-CHECKLIST.md", () => {
    const contents = readFileSync(HANDLERS_FILE, "utf8");
    // Grab the leading JSDoc block (everything before the first `*/` line).
    const leadingCommentEnd = contents.indexOf("\n */");
    expect(
      leadingCommentEnd,
      "secrets-handlers.ts must open with a JSDoc block (`/** ... */`).",
    ).toBeGreaterThan(0);
    const leadingComment = contents.slice(0, leadingCommentEnd + 4);
    expect(
      leadingComment,
      "secrets-handlers.ts leading comment must reference core/src/security/SECRET-RPC-CHECKLIST.md.",
    ).toMatch(/core\/src\/security\/SECRET-RPC-CHECKLIST\.md/);

    // Verify the referenced file ACTUALLY EXISTS at the cited path. Without
    // this assertion, a future rename of core/src/security/ silently breaks
    // the reference -- the leading-comment grep would still match but
    // point at a dead path.
    expect(
      existsSync(CHECKLIST_FILE),
      `core/src/security/SECRET-RPC-CHECKLIST.md must exist at the path referenced from secrets-handlers.ts leading comment. Resolved path: ${CHECKLIST_FILE}. If core/src/security/ was renamed, update both the file location AND the leading-comment reference in secrets-handlers.ts.`,
    ).toBe(true);
  });

  it("every secrets.* contract is admin-scoped", async () => {
    // setup-gateway-api.ts iterates API_CONTRACTS_ORDERED in a single
    // for-loop over the contract registry — there are no method-name
    // literals in the dispatcher source.
    //
    // The architectural invariant (every secrets.* method registered at
    // admin scope on the dynamic router) is preserved by verifying it
    // through the contract registry, which is the SINGLE SOURCE OF
    // TRUTH. The collapse loop in setup-gateway-api.ts iterates this
    // registry — so if every contract declares scope "admin", every
    // method registers at admin scope on the router.
    const core = await import("../index.js");
    const { API_CONTRACTS_ORDERED } = core as unknown as {
      API_CONTRACTS_ORDERED: ReadonlyArray<{
        readonly method: string;
        readonly scopes: readonly string[];
      }>;
    };
    const secretContracts = API_CONTRACTS_ORDERED.filter((c) =>
      c.method.startsWith("secrets."),
    );
    expect(
      secretContracts.length,
      "Expected at least one secrets.* contract in API_CONTRACTS_ORDERED.",
    ).toBeGreaterThan(0);

    // Verify the contract registry → setup-gateway-api.ts collapse loop
    // is the only path that registers RPC methods on the dynamic router
    // (no out-of-band registration with a different scope).
    const setupContents = readFileSync(SETUP_GATEWAY_RPC_FILE, "utf8");
    expect(
      setupContents,
      "setup-gateway-api.ts must register methods through the API_CONTRACTS_ORDERED collapse loop.",
    ).toMatch(/for\s*\(\s*const\s+c\s+of\s+API_CONTRACTS_ORDERED\s*\)/);

    // The load-bearing security invariant: every secrets.* contract MUST
    // declare scope "admin". The collapse loop passes c.scopes straight
    // through to registerMethod, so admin-only at the contract layer is
    // admin-only at the router layer.
    for (const c of secretContracts) {
      expect(
        c.scopes,
        `Contract ${c.method} must declare scopes: ["admin"]. Actual scopes: ${JSON.stringify(c.scopes)}.`,
      ).toEqual(["admin"]);
    }
  });
});

// ---------------------------------------------------------------------------
// ClockPort / EnvPort / TimerPort exports and YAGNI guard (TimerHandle has
// NO ref() method).
//
// Test strategy mirrors the file-lock / context-store checks above: a
// `readFileSync` + regex grep against the on-disk source is the
// load-bearing assertion. Vitest's esbuild transformer erases
// `type _t = import("../ports/index.js").ClockPort` to `any`, so a pure
// type-only assertion would silently pass even when the port file is
// missing. The grep assertions are the binding signal.
// ---------------------------------------------------------------------------

describe("clock / env / timer ports", () => {
  const PORTS_DIR_P39 = resolve(SRC_ROOT, "ports");
  const INDEX_PATH_P39 = resolve(PORTS_DIR_P39, "index.ts");

  it("ClockPort interface lives in core/src/ports/clock.ts and is re-exported from index.ts", () => {
    const portFile = resolve(PORTS_DIR_P39, "clock.ts");
    expect(
      existsSync(portFile),
      "packages/core/src/ports/clock.ts must exist",
    ).toBe(true);
    const source = readFileSync(portFile, "utf8");
    expect(
      source,
      "clock.ts must declare `export interface ClockPort` with now() and nowDate()",
    ).toMatch(/export\s+interface\s+ClockPort\b/);
    expect(source, "ClockPort must declare now()").toMatch(/\bnow\s*\(\s*\)\s*:/);
    expect(source, "ClockPort must declare nowDate()").toMatch(/\bnowDate\s*\(\s*\)\s*:/);

    const indexSource = readFileSync(INDEX_PATH_P39, "utf8");
    expect(
      indexSource,
      "core/src/ports/index.ts must re-export ClockPort from ./clock.js",
    ).toMatch(/export\s+type\s+\{\s*ClockPort\s*\}\s+from\s+"\.\/clock\.js"/);
  });

  it("EnvPort interface lives in core/src/ports/env.ts with get() and is re-exported from index.ts", () => {
    const portFile = resolve(PORTS_DIR_P39, "env.ts");
    expect(
      existsSync(portFile),
      "packages/core/src/ports/env.ts must exist",
    ).toBe(true);
    const source = readFileSync(portFile, "utf8");
    expect(
      source,
      "env.ts must declare `export interface EnvPort`",
    ).toMatch(/export\s+interface\s+EnvPort\b/);
    expect(source, "EnvPort must declare get(key: string)").toMatch(
      /\bget\s*\(\s*key\s*:\s*string\s*\)/,
    );
    // NOTE: EnvPort deliberately declares only get() — a snapshot() member
    // has zero production callers and is excluded per YAGNI.
    expect(source, "EnvPort.snapshot must NOT appear in env.ts").not.toMatch(
      /\bsnapshot\s*\(/,
    );

    const indexSource = readFileSync(INDEX_PATH_P39, "utf8");
    expect(
      indexSource,
      "core/src/ports/index.ts must re-export EnvPort from ./env.js",
    ).toMatch(/export\s+type\s+\{\s*EnvPort\s*\}\s+from\s+"\.\/env\.js"/);
  });

  it("TimerHandle and TimerPort live in core/src/ports/timer.ts and are re-exported from index.ts", () => {
    const portFile = resolve(PORTS_DIR_P39, "timer.ts");
    expect(
      existsSync(portFile),
      "packages/core/src/ports/timer.ts must exist",
    ).toBe(true);
    const source = readFileSync(portFile, "utf8");
    expect(source, "timer.ts must declare `export interface TimerHandle`").toMatch(
      /export\s+interface\s+TimerHandle\b/,
    );
    expect(source, "timer.ts must declare `export interface TimerPort`").toMatch(
      /export\s+interface\s+TimerPort\b/,
    );
    // TimerHandle.cancelled is readonly boolean; cancel() + unref() exist.
    expect(
      source,
      "TimerHandle must declare readonly cancelled: boolean",
    ).toMatch(/\breadonly\s+cancelled\s*:\s*boolean\b/);
    expect(source, "TimerHandle must declare cancel(): void").toMatch(
      /\bcancel\s*\(\s*\)\s*:\s*void\b/,
    );
    expect(source, "TimerHandle must declare unref(): void").toMatch(
      /\bunref\s*\(\s*\)\s*:\s*void\b/,
    );
    // TimerPort surface — parameter list contains `(callback: () => void,
    // delayMs: number)` with nested parens, so a flat `[^)]*` regex fails.
    // Use a balanced-paren match (callback list + trailing whitespace) before
    // the return-type colon and TimerHandle.
    expect(
      source,
      "TimerPort must declare setTimeout(callback, delayMs): TimerHandle",
    ).toMatch(/\bsetTimeout\s*\([^()]*\([^)]*\)[^()]*\)\s*:\s*TimerHandle\b/);
    expect(
      source,
      "TimerPort must declare setInterval(callback, intervalMs): TimerHandle",
    ).toMatch(/\bsetInterval\s*\([^()]*\([^)]*\)[^()]*\)\s*:\s*TimerHandle\b/);

    const indexSource = readFileSync(INDEX_PATH_P39, "utf8");
    expect(
      indexSource,
      "core/src/ports/index.ts must re-export TimerPort + TimerHandle from ./timer.js",
    ).toMatch(/export\s+type\s+\{\s*TimerPort\s*,\s*TimerHandle\s*\}\s+from\s+"\.\/timer\.js"/);
  });

  it("TimerHandle deliberately omits ref() per YAGNI", () => {
    const portFile = resolve(PORTS_DIR_P39, "timer.ts");
    expect(
      existsSync(portFile),
      "packages/core/src/ports/timer.ts must exist for the YAGNI guard to bind",
    ).toBe(true);
    const source = readFileSync(portFile, "utf8");

    // Extract the TimerHandle interface body and assert NO bare ref() member.
    // `unref()` legitimately exists; we filter that out by anchoring on a
    // member that is NOT preceded by `un` / any identifier character.
    const handleBlock = /export\s+interface\s+TimerHandle\b[\s\S]*?\n\}/.exec(source);
    expect(
      handleBlock,
      "TimerHandle interface block must be locatable in timer.ts",
    ).not.toBeNull();
    const body = handleBlock![0];
    // Strip comments before scanning — the body legitimately contains the
    // string "ref()" inside documentation about the absence of the member.
    // We only care about actual TypeScript member declarations.
    const bodyNoComments = body
      // strip /* ... */ block comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // strip // line comments (to end of line)
      .replace(/\/\/[^\n]*/g, "");
    // Match a method member literally named `ref` (boundary-anchored), not
    // `unref`. Production callers re-refing a timer is a YAGNI surface
    // frozen out by the port shape.
    const refMember = /(?<![A-Za-z0-9_])ref\s*\(\s*\)/.exec(bodyNoComments);
    expect(
      refMember,
      "TimerHandle MUST NOT declare a ref() method (YAGNI). Found a ref()-shaped member in the interface body.",
    ).toBeNull();
  });

  it("type-only structural assertions for ClockPort/EnvPort/TimerPort/TimerHandle (contract documentation)", () => {
    // These remain as living contract documentation; vitest's esbuild
    // transformer erases the type queries, so the *binding* signal is
    // the grep-based assertions above. These compile when running
    // `tsc --noEmit` on the test file standalone (the package
    // tsconfig excludes __tests__, so the type system check is advisory).
    type _Clock = import("../ports/index.js").ClockPort;
    type _Env = import("../ports/index.js").EnvPort;
    type _Handle = import("../ports/index.js").TimerHandle;
    type _Port = import("../ports/index.js").TimerPort;
    const _clock: _Clock = {
      now: () => 0,
      nowDate: () => new Date(0),
    };
    const _env: _Env = {
      get: () => undefined,
    };
    const _h: _Handle = {
      get cancelled() {
        return false;
      },
      cancel: () => {},
      unref: () => {},
    };
    const _p: _Port = {
      setTimeout: (_cb, _ms) => _h,
      setInterval: (_cb, _ms) => _h,
    };
    expect(_clock.now()).toBe(0);
    expect(_env.get("X")).toBeUndefined();
    expect(_h.cancelled).toBe(false);
    expect(_p).toBeDefined();
    // Compile-time YAGNI guard: TimerHandle MUST NOT have ref().
    type _HasRef = _Handle extends { ref(): unknown } ? true : false;
    const _noRef: _HasRef = false;
    expect(_noRef).toBe(false);
  });
});
