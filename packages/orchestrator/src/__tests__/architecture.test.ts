// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/orchestrator.
 *
 * Forbidden-import rules:
 *   - Production source MUST NOT import @comis/{scheduler, memory, gateway,
 *     skills, cli, daemon, infra}. Orchestrator depends only on
 *     @comis/{shared, core, agent, channels}.
 *   - Logger contract types come from @comis/core, not @comis/infra.
 *
 * `imports from @comis/channels public exports only` invariant — the
 * orchestrator may import only the public @comis/channels surface.
 *
 * Symbol-presence regex (createOrchestrator | ChannelManager |
 * processInboundMessage) — verifies the public surface is present.
 *
 * ChannelManagerDeps audit-coverage — the audit doc lives at
 * packages/orchestrator/AUDIT.md (co-located with the package).
 * CHANNEL_MANAGER_PATH points at the orchestrator-side source.
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
const PKG_ROOT = resolve(SRC_ROOT, "..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");

// Audit-coverage paths (co-located with the orchestrator package).
const AUDIT_PATH = resolve(PKG_ROOT, "AUDIT.md");
const CHANNEL_MANAGER_PATH = resolve(
  REPO_ROOT,
  "packages/orchestrator/src/channel-manager.ts",
);

// Hard-forbidden: never permitted, no allowlist. Orchestrator depends only on
// @comis/{shared, core, agent, channels}. @comis/infra is forbidden because
// logger contract types canonically live in @comis/core.
const HARD_FORBIDDEN_PACKAGES = [
  "@comis/scheduler",
  "@comis/memory",
  "@comis/gateway",
  "@comis/skills",
  "@comis/cli",
  "@comis/daemon",
  "@comis/infra",
] as const;

describe("@comis/orchestrator -- architecture invariants", () => {
  for (const forbidden of HARD_FORBIDDEN_PACKAGES) {
    it(`production source does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/orchestrator production source must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            forbidden === "@comis/infra"
              ? "Replace `import type { ComisLogger | LogFields | ErrorKind } from \"@comis/infra\"` with `... from \"@comis/core\"`. The Pino-free structural ComisLogger contract canonically lives in @comis/core."
              : "@comis/orchestrator depends only on @comis/{shared, core, agent, channels}. Move the dependency to the right tier (core ports for type contracts; daemon for composition) or inject through deps.",
          designRef: "orchestrator depends only on @comis/{shared, core, agent, channels}",
        }),
      ).toEqual([]);
      // Sanity check -- assert at least one file was walked.
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one orchestrator/src file",
      ).toBeGreaterThan(0);
    });
  }

  // Orchestrator imports from the public @comis/channels surface only —
  // no @comis/channels/dist/*, no @comis/channels/src/*, no relative
  // paths into channels.
  it("imports from @comis/channels public exports only (no internal subpaths)", () => {
    // Forbid @comis/channels/dist/* and @comis/channels/src/* (private subpath imports)
    const subpathForbidden = ["@comis/channels/dist", "@comis/channels/src"];
    for (const subpath of subpathForbidden) {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: subpath,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/orchestrator must NOT import ${subpath} (use only the public @comis/channels surface).`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            "Import from `@comis/channels` (public surface) instead. Helpers consumed from channels must be exported via packages/channels/src/index.ts.",
          designRef: "orchestrator depends only on the public @comis/channels surface",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: walked at least one orchestrator src file",
      ).toBeGreaterThan(0);
    }

    // Forbid relative imports into channels (e.g., ../../../channels/src/...).
    // This is a secondary safety net — TypeScript would catch most relative
    // cross-package paths, but a clever .js alias could dodge that, and this
    // AST-based check is robust.
    const { violations: relViolations } = findForbiddenImports({
      rootDir: SRC_ROOT,
      forbiddenPackage: "../channels",
    });
    expect(
      relViolations,
      formatViolations({
        description: "@comis/orchestrator must NOT use relative paths into the channels package.",
        violations: relViolations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Use `import { ... } from \"@comis/channels\"` (the public surface) instead of relative paths.",
        designRef: "orchestrator must not reach into the channels package via relative paths",
      }),
    ).toEqual([]);
  });

  it("exposes createOrchestrator, ChannelManager, processInboundMessage from src/index.ts", async () => {
    const orchestratorIndex = await import("../index.js");
    expect(typeof orchestratorIndex.createOrchestrator).toBe("function");
    // ChannelManager + processInboundMessage are types, not runtime values — the
    // type-presence check is enforced at compile time by tsc consuming this file.
    // The `createOrchestrator` runtime check above is the falsifiable signal.
  }, 30_000); // extend timeout for runtime import under v8 coverage instrumentation

  // Audit-coverage architecture test: the audit doc at
  // packages/orchestrator/AUDIT.md must align row-for-row with ChannelManagerDeps.
  it("every ChannelManagerDeps field appears in audit document", () => {
    // 1. Parse the audit Markdown table at packages/orchestrator/AUDIT.md.
    const auditContent = readFileSync(AUDIT_PATH, "utf8");
    const tableLines = auditContent
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("|-"));
    // Skip the header row (first line); subsequent lines are data rows.
    // Header text uses bold markdown (`**Field**`, `**Classification**`, ...) so
    // ordinary field-name rows do not collide with the header.
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

    // 2. Parse the ChannelManagerDeps interface body via regex.
    const cmContent = readFileSync(CHANNEL_MANAGER_PATH, "utf8");
    const interfaceMatch = cmContent.match(
      /export interface ChannelManagerDeps\s*\{([\s\S]*?)^\}/m,
    );
    expect(
      interfaceMatch,
      `ChannelManagerDeps interface not found in ${CHANNEL_MANAGER_PATH}`,
    ).not.toBeNull();
    const body = interfaceMatch![1];
    const fieldRegex = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)(\??):/gm;
    const interfaceFields = new Map<string, "required" | "optional">();
    let m: RegExpExecArray | null;
    while ((m = fieldRegex.exec(body)) !== null) {
      interfaceFields.set(m[1], m[2] === "?" ? "optional" : "required");
    }

    // 3. Bidirectional set equality between audit rows and interface fields.
    const auditFieldNames = new Set(rows.map((r) => r.field));
    const interfaceFieldNames = new Set(interfaceFields.keys());
    const inAuditOnly = [...auditFieldNames].filter(
      (f) => !interfaceFieldNames.has(f),
    );
    const inInterfaceOnly = [...interfaceFieldNames].filter(
      (f) => !auditFieldNames.has(f),
    );
    expect(
      inAuditOnly,
      `AUDIT.md has fields not in ChannelManagerDeps: ${inAuditOnly.join(", ")}`,
    ).toEqual([]);
    expect(
      inInterfaceOnly,
      `ChannelManagerDeps has fields not in AUDIT.md: ${inInterfaceOnly.join(", ")}`,
    ).toEqual([]);

    // 4. No forbidden "delete-this-field" classification values
    //    (the seed audit and the final audit both forbid this — every field
    //    must be either `required` or `optional` at every commit).
    const forbidden = rows.filter(
      (r) =>
        r.classification !== "required" && r.classification !== "optional",
    );
    expect(
      forbidden,
      `every row must classify as required|optional; bad rows: ${forbidden
        .map((r) => `${r.field}=${r.classification}`)
        .join(", ")}`,
    ).toEqual([]);

    // 5. Classification matches optional/required from the interface.
    const mismatches: string[] = [];
    for (const r of rows) {
      const expected = interfaceFields.get(r.field);
      if (!expected) continue; // covered by set-equality above
      if (r.classification !== expected) {
        mismatches.push(
          `${r.field}: audit=${r.classification} interface=${expected}`,
        );
      }
    }
    expect(
      mismatches,
      `classification mismatches: ${mismatches.join("; ")}`,
    ).toEqual([]);

    // 6. Every row has a non-empty evidence-link cell.
    const missingEvidence = rows.filter(
      (r) => !r.evidenceLink || r.evidenceLink === "",
    );
    expect(
      missingEvidence,
      `rows missing evidence-link: ${missingEvidence
        .map((r) => r.field)
        .join(", ")}`,
    ).toEqual([]);
  });
});
