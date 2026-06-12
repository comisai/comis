// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/daemon.
 *
 * Source-grep boundary tests enforce that:
 *   - Production source MUST NOT import the test-only stub factory
 *     `createCapabilityPortStub` (it would leak the stub into the
 *     published comisai tarball via bundledDependencies).
 *   - Test source files MUST NOT import the production no-op factory
 *     (use `createCapabilityPortStub` from `__test-helpers/` instead). The
 *     orchestration smoke test (`orchestration-order.test.ts`) is allowlisted
 *     because it imports the no-op as a reference-equality sentinel proving
 *     the live adapter is NOT the no-op fallback.
 *   - Production source under `packages/daemon/src/` MUST NOT reference
 *     the production no-op factory. The no-op factory itself
 *     (`packages/core/src/ports/no-op-tool-capability.ts`) is intentionally
 *     retained for hypothetical future early-startup wiring; it MUST NOT be
 *     CALLED from daemon production source.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import * as ts from "typescript";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const DAEMON_TS_PATH = resolve(SRC_ROOT, "daemon.ts");

// Per-domain audit docs at packages/daemon/AUDIT-<domain>.md, one per
// cluster slice in api/types.ts. The for-loop below generates 11 it()
// blocks (one per domain) that each parse the audit Markdown table and
// assert bidirectional set equality against the corresponding *ApiDeps
// interface.
const AUDIT_DOMAINS = [
  "sessions",
  "memory",
  "channels",
  "agents",
  "orchestrator",
  "workspace",
  "config",
  "auth",
  "media",
  "observability",
  "daemon",
] as const;
const API_TYPES_PATH = resolve(SRC_ROOT, "api", "types.ts");
const PKG_ROOT = resolve(SRC_ROOT, ".."); // packages/daemon/

describe("@comis/daemon -- architecture invariants", () => {
  it("production source does NOT import createCapabilityPortStub (test/prod boundary)", () => {
    // Rationale: if the daemon adapter file imports the stub, it ships in
    // the published comisai tarball via bundledDependencies and returns
    // getInstallDetourMode: () => "advise" unconditionally — silent, fixed,
    // wrong. The architecture-grep is the SOLE boundary preventing this
    // regression class.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createCapabilityPortStub",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "__test-helpers"],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/daemon production source must not import createCapabilityPortStub — " +
        "the test stub leaks into the published comisai tarball if smuggled into " +
        "dist/ via __test-helpers/ which is NOT tsconfig-excluded.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file in @comis/daemon").toBeGreaterThan(0);
  });

  it("test source files do NOT import createNoOpCapabilityPort (use createCapabilityPortStub from __test-helpers/ instead)", () => {
    // Note: orchestration-order.test.ts intentionally imports
    // createNoOpCapabilityPort as a reference-equality sentinel proving the
    // per-agent ToolCapabilityPort emerging from real setupMcp + the live
    // adapter factory is NOT the no-op fallback. Allowlisted intentionally —
    // see ALLOWLIST below.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    // Allowlist:
    //   1. architecture.test.ts itself references the literal in its
    //      explanatory comment block.
    //   2. orchestration-order.test.ts imports the no-op factory purely as
    //      a reference-equality sentinel for proving the live adapter is
    //      not the no-op fallback. Allowlisted intentionally as an explicit
    //      forbidden-patterns carve-out.
    const ALLOWLIST = ["architecture.test.ts", "orchestration-order.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "@comis/daemon test files must use createCapabilityPortStub from @comis/core's " +
        "__test-helpers/ instead of createNoOpCapabilityPort — production no-op factory " +
        "is for early-startup fallback only.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one test file in @comis/daemon").toBeGreaterThan(0);
  });

  it("production source in @comis/daemon does NOT reference createNoOpCapabilityPort (regression check)", () => {
    // Rationale: all production createNoOpCapabilityPort() call sites in
    // @comis/daemon were replaced with the live ToolCapabilityPort adapter
    // from createToolCapabilityAdapter. A reference here means a regression —
    // someone added a new exec/process factory site or rolled back the
    // wiring. The grep catches it pre-merge.
    //
    // Note: the no-op factory itself
    // (packages/core/src/ports/no-op-tool-capability.ts) is intentionally
    // retained as a legitimate factory for hypothetical future early-startup
    // wiring. It MUST NOT be called from daemon production source.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      excludeFileSuffixes: [".test.ts"],
    });
    // Allowlist: architecture.test.ts itself contains the literal in its
    // explanatory comments. It is already excluded by BOTH the default
    // `__tests__/` directory exclusion (source-grep.ts:55-60) AND the
    // `excludeFileSuffixes: [".test.ts"]` filter above (source-grep.ts:103)
    // -- so the allowlist is defense-in-depth against a future filename
    // refactor that drops the `.test.ts` suffix or moves the test out of
    // `__tests__/`.
    const ALLOWLIST = ["architecture.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "All production createNoOpCapabilityPort() call sites in @comis/daemon " +
        "should use the live ToolCapabilityPort adapter. A reference here is a " +
        "regression — most likely a new exec/process tool factory site or a " +
        "partial revert of the wiring. Add the agent's per-agent adapter via " +
        "deps.getCapabilityPortForAgent(agentId) in setup-tools.ts.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file in @comis/daemon").toBeGreaterThan(0);
  });

  it("rpc/ directory does not exist; api/ is canonical", () => {
    // Daemon API handlers live under api/, not rpc/. The rename surfaces
    // the conceptual shift -- internal API seam, not transport-bound. The
    // api/ location aligns with core/src/api-contracts/<domain>.ts.
    //
    // Failure-message phrasing note: the recovery hints below MUST NOT
    // contain the pre-rename literal directory-path bytes -- if they did,
    // the workspace-wide residual grep (run as part of the rename
    // validation) would match this very file. Use the `<daemon-src>/rpc`
    // placeholder instead.
    const rpcPath = resolve(SRC_ROOT, "rpc");
    const apiPath = resolve(SRC_ROOT, "api");
    expect(
      existsSync(rpcPath),
      `<daemon-src>/rpc must not exist. ` +
        `Found at ${rpcPath}. Run \`git mv <daemon-src>/rpc <daemon-src>/api\` ` +
        `and retarget every internal import.`,
    ).toBe(false);
    expect(
      existsSync(apiPath),
      `<daemon-src>/api must exist as the canonical handler directory. ` +
        `Expected at ${apiPath}.`,
    ).toBe(true);
  });

  it("daemon.ts total line count enforced (hard cap ≤ 3000)", () => {
    // Post-collapse daemon.ts is a single composition root containing main()
    // + 4 small helpers + inlined foundation/agents/channels/gateway/shutdown
    // bodies + 30 ex-stage-helper functions. The pre-collapse per-stage 200L
    // caps were removed when the 4-handle chain collapsed to BootContext.
    // This single hard-cap is the architectural budget — if daemon.ts grows
    // past 3000L, refactor a helper into wiring/main-helpers.ts.
    const sourceText = readFileSync(DAEMON_TS_PATH, "utf8");
    const lineCount = sourceText.split("\n").length;
    expect(
      lineCount,
      `daemon.ts is ${lineCount} lines (cap 3000). ` +
        `Split a helper into wiring/main-helpers.ts to fit.`,
    ).toBeLessThanOrEqual(3000);
  });

  // 90s timeout (default 5s) — under v8 coverage instrumentation the
  // 27-handler AST walk slows enough to exceed the default budget, and on a
  // loaded CI runner (full-workspace coverage, 2026-06-12 run 27408093972)
  // it blew through the earlier 30s bump too. Without coverage the test
  // runs in ~1.5s; the generous ceiling only delays a REAL hang's report.
  it(
    "api/*-handlers.ts never imports another api/*-handlers.ts file",
    () => {
    // Handler files are siblings -- they MUST NOT import each other. Any
    // cross-handler shared logic lives in api/shared/ (4 helpers:
    // persist-to-config, credential-resolver, probe-provider-auth,
    // builtin-provider-guard).
    //
    // This invariant is mechanically enforceable: every *-handlers.ts file
    // imports either from external packages, from ./types.js, or from
    // ./shared/*.js -- never from a sibling handler.
    //
    // Implementation: enumerate every *-handlers.ts file under api/, then
    // for each (handler, otherHandler) pair, run findForbiddenImports
    // looking for `./${otherHandler}.js`. To keep the run within vitest's
    // default 5s per-test budget on a 27-handler workspace we do a SINGLE
    // walk per other-handler (27 walks total) and post-filter the
    // violations by importing-file basename in memory -- a strict
    // optimization of the documented N × (N-1) walk shape. The AST-based
    // scanner from test/support/import-checker.ts (not regex) produces
    // verbose failure messages via formatViolations.
    const apiDir = resolve(SRC_ROOT, "api");
    const handlerFiles = readdirSync(apiDir)
      .filter((f) => f.endsWith("-handlers.ts") && !f.endsWith(".test.ts"))
      .map((f) => f.replace(/\.ts$/, ""));

    expect(
      handlerFiles.length,
      "sanity: api/ should contain at least 20 *-handlers.ts files",
    ).toBeGreaterThan(20);

    const handlerSet = new Set(handlerFiles);
    for (const other of handlerFiles) {
      const { violations } = findForbiddenImports({
        rootDir: apiDir,
        forbiddenPackage: `./${other}.js`,
      });
      // Cross-handler edges only: keep offenders whose importing file is
      // ALSO a *-handlers.ts sibling (not the helper itself, not a test,
      // not api/shared/*).
      const crossHandlerOffenders = violations.filter((v) => {
        const m = /\/([^/]+)\.ts$/.exec(v.file);
        if (!m) return false;
        const importer = m[1];
        return handlerSet.has(importer) && importer !== other;
      });
      expect(
        crossHandlerOffenders,
        formatViolations({
          description: `No api/*-handlers.ts file may import api/${other}.js — handlers are siblings; shared logic goes to api/shared/.`,
          violations: crossHandlerOffenders.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix: `Move the shared symbol from ${other}.ts to packages/daemon/src/api/shared/ and import it from there. See packages/daemon/src/api/shared/ for the established pattern (4 cross-handler helpers).`,
          designRef: "packages/daemon/src/api/shared/",
        }),
      ).toEqual([]);
    }
    },
    90_000,
  );

  // Per-domain audit-coverage invariants. For each cluster slice in
  // api/types.ts the matching AUDIT-<domain>.md doc at
  // packages/daemon/AUDIT-<domain>.md must:
  //   1. List every interface field as a row (set equality, both directions)
  //   2. Classify each row as "required" or "optional" -- never the third
  //      "stale-fallback" value (architecture-test invariant)
  //   3. Match the interface's optional/required marker (`?:` vs `:`)
  //   4. Provide a non-empty evidence-link cell on every row
  //
  // Pattern lifted from packages/orchestrator/src/__tests__/architecture.test.ts;
  // generalized via the AUDIT_DOMAINS loop to produce 11 it() blocks at
  // module load time.
  for (const domain of AUDIT_DOMAINS) {
    const interfaceName = `${domain.charAt(0).toUpperCase()}${domain.slice(1)}ApiDeps`;
    const auditPath = resolve(PKG_ROOT, `AUDIT-${domain}.md`);

    it(`every ${interfaceName} field appears in audit document at AUDIT-${domain}.md`, () => {
      // 1. Parse the audit Markdown table.
      const auditContent = readFileSync(auditPath, "utf8");
      const tableLines = auditContent
        .split("\n")
        .filter((l) => l.startsWith("| ") && !l.startsWith("|-"));
      // Skip the header row (first); subsequent lines are data rows.
      // The header text uses bold markdown (`**Field**`, ...) so the
      // `r.field.startsWith("**")` filter keeps ordinary identifiers from
      // colliding with the header.
      const rows = tableLines
        .slice(1)
        .map((l) => {
          const cells = l.split("|").map((s) => s.trim());
          return {
            field: cells[1] ?? "",
            classification: cells[2] ?? "",
            whenAbsent: cells[3] ?? "",
            evidenceLink: cells[4] ?? "",
          };
        })
        .filter((r) => r.field.length > 0 && !r.field.startsWith("**"));

      // 2. Parse the interface body via the TypeScript Compiler API.
      //    Replaces the previous regex-based extractor, which was fragile
      //    against indentation changes, inline object-literal types, and
      //    continuation-line field declarations. The AST walker is robust
      //    against all three. Note: heritage clauses (`extends X`) are
      //    intentionally NOT followed -- AUDIT_DOMAINS slices MUST not
      //    extend each other (see the guard test below).
      const apiTypesContent = readFileSync(API_TYPES_PATH, "utf8");
      const sf = ts.createSourceFile(
        "types.ts",
        apiTypesContent,
        ts.ScriptTarget.ES2023,
        /* setParentNodes */ true,
      );
      const interfaceFields = new Map<string, "required" | "optional">();
      let interfaceFound = false;
      let extendsAnotherInterface = false;
      ts.forEachChild(sf, (node) => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
          interfaceFound = true;
          if (node.heritageClauses && node.heritageClauses.length > 0) {
            extendsAnotherInterface = true;
          }
          for (const member of node.members) {
            if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
              interfaceFields.set(
                member.name.text,
                member.questionToken ? "optional" : "required",
              );
            }
          }
        }
      });
      expect(
        interfaceFound,
        `${interfaceName} interface not found in ${API_TYPES_PATH}`,
      ).toBe(true);
      // Guard: leaf *ApiDeps slices in AUDIT_DOMAINS MUST NOT extend other
      // interfaces. The audit-coverage check does not walk heritage clauses,
      // so an inherited member set would silently miss fields. The
      // aggregator `ApiDispatchDeps extends ...` is not in AUDIT_DOMAINS and
      // is intentionally excluded.
      expect(
        extendsAnotherInterface,
        `${interfaceName} extends another interface. AUDIT_DOMAINS slices ` +
          `MUST be flat (no \`extends\` clause); the audit-coverage check ` +
          `does not inherit fields. Either flatten the interface or remove ` +
          `it from AUDIT_DOMAINS.`,
      ).toBe(false);

      const auditFieldNames = new Set(rows.map((r) => r.field));
      const interfaceFieldNames = new Set(interfaceFields.keys());

      // 3a. Every interface field appears in the audit
      const inInterfaceOnly = [...interfaceFieldNames].filter(
        (f) => !auditFieldNames.has(f),
      );
      expect(
        inInterfaceOnly,
        `Fields in ${interfaceName} but NOT in AUDIT-${domain}.md: ${inInterfaceOnly.join(", ")}. ` +
          `Add a row to the audit table or remove the field from the interface.`,
      ).toEqual([]);

      // 3b. Every audit row matches an interface field
      const inAuditOnly = [...auditFieldNames].filter(
        (f) => !interfaceFieldNames.has(f),
      );
      expect(
        inAuditOnly,
        `Fields in AUDIT-${domain}.md but NOT in ${interfaceName}: ${inAuditOnly.join(", ")}. ` +
          `Remove the stale audit row or add the field to the interface.`,
      ).toEqual([]);

      // 4. No stale-fallback classifications (terminal value forbidden;
      //    every field must be required or optional).
      const staleFallbackRows = rows.filter(
        (r) => r.classification === "stale-fallback",
      );
      expect(
        staleFallbackRows.map((r) => r.field),
        `Stale-fallback classification rows in AUDIT-${domain}.md: ${staleFallbackRows
          .map((r) => r.field)
          .join(", ")}. ` +
          `Delete the field from the interface and remove the row from the audit.`,
      ).toEqual([]);

      // 5. Classification matches interface optional marker
      const classificationMismatches: string[] = [];
      for (const row of rows) {
        const interfaceClass = interfaceFields.get(row.field);
        if (interfaceClass && row.classification !== interfaceClass) {
          classificationMismatches.push(
            `${row.field}: audit=${row.classification}, interface=${interfaceClass}`,
          );
        }
      }
      expect(
        classificationMismatches,
        `Classification mismatches (audit vs interface optional marker) in AUDIT-${domain}.md:\n  ${classificationMismatches.join("\n  ")}`,
      ).toEqual([]);

      // 6. Every row has non-empty evidence-link
      const missingEvidence = rows.filter((r) => r.evidenceLink.length === 0);
      expect(
        missingEvidence.map((r) => r.field),
        `Audit rows missing evidence-link in AUDIT-${domain}.md: ${missingEvidence
          .map((r) => r.field)
          .join(", ")}`,
      ).toEqual([]);
    });
  }
});
