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

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const BOOTSTRAP_PATH_FRAGMENT = "bootstrap.ts";

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
    // Phase 28 commit 3 (CORE-PORTS-08) — binding rule from design §5.3.
    // Asserts the new type-only port file exists and exports the expected
    // names (FileLockPort + LockOptions + LockError). The "ports/*.ts is
    // type-only" rule below (ARCH-BASE-07 / L15) gates that the file is
    // type-only; this test asserts the export shape.
    const portFile = resolve(SRC_ROOT, "ports/file-lock.ts");
    const source = readFileSync(portFile, "utf8");
    const missing: string[] = [];
    if (!/export\s+interface\s+FileLockPort\b/.test(source)) missing.push("FileLockPort");
    if (!/export\s+interface\s+LockOptions\b/.test(source)) missing.push("LockOptions");
    if (!/export\s+type\s+LockError\b/.test(source)) missing.push("LockError");
    if (!/cleanupStaleLocks\s*\(/.test(source)) missing.push("cleanupStaleLocks (RES-ARCH-2)");
    expect(
      missing,
      "core/src/ports/file-lock.ts must export FileLockPort + LockOptions + LockError and the FileLockPort surface must include cleanupStaleLocks (RES-ARCH-2 closes the design §5.2 enumeration gap).",
    ).toEqual([]);
  });

  it("exports ContextStorePort interface from core/src/ports/context-store.ts", () => {
    // Phase 28 commit 4 (CORE-PORTS-13) — binding rule from design §5.3.
    // Asserts the new type-only port file exists and declares the
    // ContextStorePort interface (per Claude's Discretion in 28-CONTEXT.md).
    // The "ports/*.ts is type-only" rule below (ARCH-BASE-07 / L15) gates
    // that the file is type-only; this test asserts the export shape.
    //
    // Phase 31 commit 1 (RES-PIT-5) landed the row DTOs at
    // core/src/ports/context-store-types.ts.
    //
    // History of the memory-side declaration (kept for grep / git-blame context):
    //   • Phase 28 era — `export interface ContextStore { ... }` (full mirror;
    //     enforced via method-count parity).
    //   • Phase 31 commit 2 (MEM-CTX-PORTS-05) — `export type ContextStore =
    //     ContextStorePort` (alias is structurally faithful by definition).
    //   • Post-cleanup terminal state (this branch) — no `ContextStore`
    //     declaration in memory pkg; ContextStorePort from @comis/core is
    //     the single source of truth. All daemon + internal memory
    //     consumers import the Port from core directly.
    //
    // Accept any of the three states; flag drift only if the port is missing
    // OR an interface-form declaration drifts from method-count parity.
    const portFile = resolve(SRC_ROOT, "ports/context-store.ts");
    const source = readFileSync(portFile, "utf8");
    const missing: string[] = [];
    if (!/export\s+interface\s+ContextStorePort\b/.test(source)) {
      missing.push("ContextStorePort");
    }
    const memorySource = readFileSync(
      resolve(SRC_ROOT, "..", "..", "memory", "src", "context-store.ts"),
      "utf8",
    );
    const memAliasMatch = /export\s+type\s+ContextStore\s*=\s*ContextStorePort\b/.test(
      memorySource,
    );
    const memInterfaceMatch = /export\s+interface\s+ContextStore\b/.test(memorySource);
    if (!memAliasMatch && memInterfaceMatch) {
      // Phase 28-era path: interface form exists — gate method-count parity.
      const memBlock = /export\s+interface\s+ContextStore\b[\s\S]*?\n\}/.exec(
        memorySource,
      );
      const portBlock = /export\s+interface\s+ContextStorePort\b[\s\S]*?\n\}/.exec(source);
      const countMethods = (block: string | undefined): number =>
        block ? (block.match(/^ {2}[a-z][a-zA-Z]+\(/gm) ?? []).length : 0;
      const memMethodCount = countMethods(memBlock?.[0]);
      const portMethodCount = countMethods(portBlock?.[0]);
      if (portMethodCount < memMethodCount) {
        missing.push(
          `method-count parity (port has ${portMethodCount}, memory's ContextStore has ${memMethodCount} — full-mirror requires >=)`,
        );
      }
    }
    // If neither alias nor interface is present, the migration is complete
    // (Port is canonical) — no drift gate needed.
    expect(
      missing,
      "core/src/ports/context-store.ts must export the ContextStorePort interface (per Claude's Discretion in 28-CONTEXT.md, Pattern 5 in 28-PATTERNS.md). Post-cleanup terminal state: memory pkg no longer declares a `ContextStore` type — the Port from @comis/core is the single source of truth.",
    ).toEqual([]);
  });

  it("OAuth rewritten errors expose code (OAuthErrorCode) and logErrorKind (closed Pino ErrorKind), with no string-typed errorKind field", () => {
    // Phase 28 commit 6C (CORE-PORTS-15 + CORE-PORTS-16) — binding rule from
    // design §5.3. Closes L21. The RewrittenOAuthError interface in
    // core/src/security/oauth-helpers.ts must expose:
    //   - `code: OAuthErrorCode` (domain discriminator)
    //   - `logErrorKind: ErrorKind` (closed-Pino-union mirror)
    // and MUST NOT declare an `errorKind:` field (string-typed mirror was the
    // pre-6C shape; renamed to logErrorKind in 6C). The architecture rule
    // structurally gates future regressions — any reintroduction of an
    // `errorKind` field on this interface fails the build.
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
          "STRING-TYPED `errorKind` FIELD STILL PRESENT (must be removed per 6C — rename to logErrorKind)",
        );
      }
    }
    // ErrorKind must be imported from core/logging/log-fields.js so the
    // closed-union type is bound to the canonical 9-member ErrorKind.
    if (!/import\s+type\s+\{\s*ErrorKind\s*\}\s+from\s+"\.\.\/logging\/log-fields\.js"/.test(source)) {
      missing.push("`import type { ErrorKind } from \"../logging/log-fields.js\"`");
    }
    expect(
      missing,
      "core/src/security/oauth-helpers.ts must declare RewrittenOAuthError with `code: OAuthErrorCode` + `logErrorKind: ErrorKind`, with no string-typed `errorKind` field (Phase 28 commit 6C closure of L21; design §5.3).",
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
});

/* ---------------------------------------------------------------------- */
/*  ARCH-BASE-07: core/src/ports/*.ts port-shape (type-only) enforcement  */
/* ---------------------------------------------------------------------- */

/**
 * L15 sub-allowlist — files in packages/core/src/ports/ that legitimately
 * contain runtime imports / value declarations.
 *
 * Phase 28 commit 1 (CORE-PORTS-01) closed L15: the runtime helpers that
 * previously lived under core/src/ports/ (ChannelCapabilitySchema,
 * createNoOpDeliveryQueue, createNoOpDeliveryMirror, createNoOpCapabilityPort,
 * validateProfileId, PROFILE_ID_RE) moved to non-ports/ home modules
 * (../domain/channel-capability.ts, ../delivery/no-op-delivery-{queue,mirror}.ts,
 * ../tool-capability/no-op-tool-capability.ts, ../security/profile-id.ts), and
 * the curated re-exports at ../exports/ports.ts retarget consumers to those
 * new homes so the @comis/core public surface stayed byte-identical.
 *
 * After the move, every file under core/src/ports/*.ts is type-only:
 *   - all imports are `import type`
 *   - no top-level runtime value declarations (no `export const/let/var`,
 *     no `export function`, no `export class`)
 *   - re-exports (`export type { ... } from "..."`) are allowed; the AST
 *     walker only flags ImportDeclarations and locally-declared exports.
 *
 * The allowlist is therefore empty. Re-extending it would re-open L15 and
 * is a regression — the parent L15 entry has been removed from
 * test/support/architecture-allowlist.ts. The shrink-only test
 * (test/architecture/allowlist-shrink.test.ts) gates the parent entry.
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

describe("@comis/core -- port-shape (ARCH-BASE-07 / L15)", () => {
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
          "L15 closes in Phase 28 commit (CORE-PORTS-01) when current runtime helpers move out of core/src/ports/. " +
          "If a runtime helper genuinely needs to live in ports/ as a Phase 27 baseline state, add its basename VERBATIM to L15_PORT_SHAPE_ALLOWLIST in this file with a rationale comment + L-ID citation.",
        violations: offenders.map((o) => ({
          file: o.file,
          line: o.line,
          column: o.column,
          snippet: o.snippet,
        })),
        suggestedFix:
          "Move the runtime helper out of core/src/ports/ to a non-port core module (e.g., core/src/security/, core/src/delivery/, core/src/no-op/). " +
          "Update curated re-exports at core/src/exports/ports.ts so the public surface of @comis/core stays byte-identical (per design §5.2). " +
          "If the move is deferred to Phase 28, add the file's basename to L15_PORT_SHAPE_ALLOWLIST with a rationale comment.",
        designRef:
          'design §5.2 ("Move runtime values out of core/src/ports/...core/src/ports/*.ts becomes type-only before new ports are added") / §1.3 L15',
        allowlistRef: "L15 + L15_PORT_SHAPE_ALLOWLIST (in-file sub-allowlist)",
      }),
    ).toEqual([]);
    expect(
      checkedFiles,
      "sanity: at least one port file scanned (core/src/ports/ should not be empty)",
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 31 commit 1 (MEM-CTX-PORTS-03 + MEM-CTX-PORTS-04) — Port-DTO residency
// invariants (text-level / regex — complementary to the TS-compiler-API
// walker in test/architecture/source-rules.test.ts wired by Task 4).
// Row DTOs live in core/src/ports/{context-store,session-store}-types.ts
// (NOT inline in port files, NOT in core/src/domain/).
// ---------------------------------------------------------------------------

describe("Phase 31 — port-DTO residency text-level checks (MEM-CTX-PORTS-03 + MEM-CTX-PORTS-04 complementary)", () => {
  const PORTS_DIR_P31 = resolve(SRC_ROOT, "ports");
  const DOMAIN_DIR_P31 = resolve(SRC_ROOT, "domain");

  it("every Ctx*Row name appearing in context-store.ts source-text is exported from context-store-types.ts (MEM-CTX-PORTS-04 complementary)", () => {
    // COMPLEMENTARY check — the primary AST-level check is the TS-compiler-API
    // walker wired in test/architecture/source-rules.test.ts (Task 4). This
    // regex check additionally catches Ctx*Row names mentioned in comments
    // or non-method-signature positions in context-store.ts.
    const portFile = readFileSync(resolve(PORTS_DIR_P31, "context-store.ts"), "utf8");
    const typesFile = readFileSync(resolve(PORTS_DIR_P31, "context-store-types.ts"), "utf8");
    const ctxRowNames = new Set(
      [...portFile.matchAll(/\bCtx[A-Z][A-Za-z]+Row\b/g)].map((m) => m[0]),
    );
    expect(
      ctxRowNames.size,
      "context-store.ts must reference at least 1 Ctx*Row type",
    ).toBeGreaterThan(0);
    for (const name of ctxRowNames) {
      expect(
        typesFile,
        `${name} (used in context-store.ts) must be exported from context-store-types.ts (MEM-CTX-PORTS-04 complementary)`,
      ).toMatch(new RegExp(`export\\s+interface\\s+${name}\\b`));
    }
  });

  it("session-store.ts declares SessionStorePort with exactly 7 methods (MEM-CTX-PORTS-03)", () => {
    const portFile = readFileSync(resolve(PORTS_DIR_P31, "session-store.ts"), "utf8");
    expect(portFile).toMatch(/export\s+interface\s+SessionStorePort\b/);
    const expectedMethods = [
      "save",
      "load",
      "list",
      "delete",
      "deleteStale",
      "loadByFormattedKey",
      "listDetailed",
    ];
    for (const m of expectedMethods) {
      expect(
        portFile,
        `SessionStorePort must declare method ${m}() (MEM-CTX-PORTS-03)`,
      ).toMatch(new RegExp(`\\b${m}\\s*\\(`));
    }
  });

  it("no Ctx*Row or Session{Data,ListEntry,DetailedEntry} types live in core/src/domain/ (preserves domain/persistence boundary per design §8.2.1)", () => {
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
      "Row DTOs must live in core/src/ports/, NOT core/src/domain/. Move declarations to context-store-types.ts or session-store-types.ts (MEM-CTX-PORTS-03, design §8.2.1).",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 31 commit 7 (MEM-CTX-PORTS-13 / MEM-CTX-PORTS-14 part 3 /
// RES-PIT-31-3) -- secrets-handlers integrity invariants.
// ---------------------------------------------------------------------------

describe("Phase 31 -- secrets-handlers integrity (MEM-CTX-PORTS-13 + 14 part 3 / RES-PIT-31-3)", () => {
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

  it("secrets-handlers.ts leading comment references core/src/security/SECRET-RPC-CHECKLIST.md (MEM-CTX-PORTS-14 part 3)", () => {
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
      "secrets-handlers.ts leading comment must reference core/src/security/SECRET-RPC-CHECKLIST.md (MEM-CTX-PORTS-14 part 3).",
    ).toMatch(/core\/src\/security\/SECRET-RPC-CHECKLIST\.md/);

    // I-10 fix (Phase 31 revision iter 2): also verify the referenced file
    // ACTUALLY EXISTS at the cited path. Without this assertion, a future
    // rename of core/src/security/ (e.g., Phase 34) silently breaks the
    // reference -- the leading-comment grep would still match but point
    // at a dead path.
    expect(
      existsSync(CHECKLIST_FILE),
      `core/src/security/SECRET-RPC-CHECKLIST.md must exist at the path referenced from secrets-handlers.ts leading comment. Resolved path: ${CHECKLIST_FILE}. If core/src/security/ was renamed, update both the file location AND the leading-comment reference in secrets-handlers.ts.`,
    ).toBe(true);
  });

  it("every secrets.* contract is admin-scoped (RES-PIT-31-3 — post-Plan-35-20 collapse)", async () => {
    // Phase 35 Wave D Plan 35-20 BLOCKER 8 closure: setup-gateway-api.ts
    // collapsed from 14 string-array registerRpcPassthrough calls to a
    // single for-loop over API_CONTRACTS_ORDERED. The pre-Plan-35-20
    // version of this test grepped the dispatcher source for literal
    // "secrets.*" method names + their adjacent scope arg; the post-
    // collapse dispatcher contains no method literals.
    //
    // The architectural invariant (every secrets.* method registered at
    // admin scope on the dynamic router) is preserved by verifying it
    // through the contract registry, which is now the SINGLE SOURCE OF
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
      "setup-gateway-api.ts must register methods through the API_CONTRACTS_ORDERED collapse loop (Plan 35-20 BLOCKER 8 fix).",
    ).toMatch(/for\s*\(\s*const\s+c\s+of\s+API_CONTRACTS_ORDERED\s*\)/);

    // The load-bearing security invariant: every secrets.* contract MUST
    // declare scope "admin". The collapse loop passes c.scopes straight
    // through to registerMethod, so admin-only at the contract layer is
    // admin-only at the router layer.
    for (const c of secretContracts) {
      expect(
        c.scopes,
        `Contract ${c.method} must declare scopes: ["admin"] (RES-PIT-31-3 — Plan 35-20 collapse loop honors c.scopes directly). Actual scopes: ${JSON.stringify(c.scopes)}.`,
      ).toEqual(["admin"]);
    }
  });
});
