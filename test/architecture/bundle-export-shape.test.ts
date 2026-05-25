// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture test — bundle export shape invariants.
 *
 * Pins, by AST/text inspection of the production source:
 *   1. The 4 hard-limit constants with exact values.
 *   2. The TrajectoryBundleWarning.code closed union — exactly the 6
 *      values, no more, no less.
 *   3. The FILE_PLAN array in bundle-exporter.ts enumerates exactly the 7
 *      non-manifest files (manifest.json is written separately) with exact
 *      mediaTypes, and "manifest.json" appears ≥2 times in the file.
 *   4. TrajectoryBundleManifest has the expected readonly field set.
 *   5. The privacy-warning docstring is present in
 *      bundle-exporter.ts (the module that owns the exporter pipeline).
 *
 * Shrink-only: no allowlist entries. Constants and union values are pinned
 * numerically and lexically — any drift is a contract violation.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const EXPORT_TS_PATH = resolve(REPO_ROOT, "packages/observability/src/trajectory/export.ts");
const BUNDLE_EXPORTER_TS_PATH = resolve(REPO_ROOT, "packages/observability/src/trajectory/bundle-exporter.ts");

const exportContent = readFileSync(EXPORT_TS_PATH, "utf8");
const bundleExporterContent = readFileSync(BUNDLE_EXPORTER_TS_PATH, "utf8");

/**
 * Strip JS/TS comments (single-line + multi-line) so grep gates
 * don't self-invalidate on prose in docstrings.
 *
 * Block comments stripped first (non-greedy), then single-line comments.
 */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const exportCode = stripComments(exportContent);
const bundleExporterCode = stripComments(bundleExporterContent);

// ---------------------------------------------------------------------------
// Case 1: Hard-limit constants exist in export.ts with exact values
// ---------------------------------------------------------------------------

describe("bundle-export-shape: hard-limit constants (export.ts)", () => {
  it("MAX_TRAJECTORY_RUNTIME_EVENTS is declared as 200_000 in export.ts", () => {
    // Use global flag so .match() returns all occurrences (array length == occurrence count).
    const matches = exportCode.match(
      /^export const MAX_TRAJECTORY_RUNTIME_EVENTS\s*=\s*200_000(?:\s+as const)?;?/gm,
    );
    expect(matches, "MAX_TRAJECTORY_RUNTIME_EVENTS not declared as 200_000").not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("MAX_TRAJECTORY_TOTAL_EVENTS is declared as 250_000 in export.ts", () => {
    const matches = exportCode.match(
      /^export const MAX_TRAJECTORY_TOTAL_EVENTS\s*=\s*250_000(?:\s+as const)?;?/gm,
    );
    expect(matches, "MAX_TRAJECTORY_TOTAL_EVENTS not declared as 250_000").not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("MAX_TRAJECTORY_SESSION_FILE_BYTES is declared as 52_428_800 in export.ts", () => {
    // The design spec says 50 * 1024 * 1024 = 52_428_800. The source uses
    // either the expression form or the evaluated numeric literal.
    const matchesLiteral = exportCode.match(
      /^export const MAX_TRAJECTORY_SESSION_FILE_BYTES\s*=\s*52_428_800(?:\s+as const)?;?/gm,
    );
    const matchesExpr = exportCode.match(
      /^export const MAX_TRAJECTORY_SESSION_FILE_BYTES\s*=\s*50\s*\*\s*1024\s*\*\s*1024(?:\s+as const)?;?/gm,
    );
    expect(
      matchesLiteral !== null || matchesExpr !== null,
      "MAX_TRAJECTORY_SESSION_FILE_BYTES not declared as 52_428_800 or 50*1024*1024",
    ).toBe(true);
  });

  it("MAX_TRAJECTORY_WARNING_ROWS is declared as 20 in export.ts", () => {
    const matches = exportCode.match(
      /^export const MAX_TRAJECTORY_WARNING_ROWS\s*=\s*20(?:\s+as const)?;?/gm,
    );
    expect(matches, "MAX_TRAJECTORY_WARNING_ROWS not declared as 20").not.toBeNull();
    expect(matches!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 2: TrajectoryBundleWarning.code is the closed §6.2 6-value union
// ---------------------------------------------------------------------------

describe("bundle-export-shape: TrajectoryBundleWarning.code closed union (export.ts)", () => {
  it("TrajectoryBundleWarning.code has exactly the 6 values", () => {
    // Locate the TrajectoryBundleWarning interface block.
    const interfaceBlockMatch = exportContent.match(
      /export interface TrajectoryBundleWarning\s*\{([\s\S]*?)^}/m,
    );
    expect(
      interfaceBlockMatch,
      "Could not locate export interface TrajectoryBundleWarning block",
    ).not.toBeNull();

    const block = interfaceBlockMatch![1]!;

    // Find the "readonly code:" union (spans from "readonly code:" to the
    // next ";"). The block is inside the interface, so we can search for it.
    const codeLineMatch = block.match(/readonly code:\s*([\s\S]*?);/);
    expect(
      codeLineMatch,
      "Could not locate readonly code: union inside TrajectoryBundleWarning",
    ).not.toBeNull();

    const unionStr = codeLineMatch![1]!;
    // Split on "|", strip quotes and whitespace.
    const codes = unionStr
      .split("|")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);

    const expectedCodes = [
      "cyclic-session-branch",
      "incomplete-session-branch",
      "invalid-runtime-event",
      "invalid-runtime-json",
      "invalid-session-json",
      "invalid-session-row",
    ];

    expect(
      codes.sort(),
      `TrajectoryBundleWarning.code union must have exactly 6 values: ${expectedCodes.join(", ")}`,
    ).toEqual(expectedCodes);
  });
});

// ---------------------------------------------------------------------------
// Case 3: FILE_PLAN in bundle-exporter.ts has exactly 7 non-manifest entries
//          with correct mediaTypes, and "manifest.json" appears ≥2 times
// ---------------------------------------------------------------------------

describe("bundle-export-shape: FILE_PLAN 7-file + manifest shape (bundle-exporter.ts)", () => {
  it("FILE_PLAN in bundle-exporter.ts has exactly 7 non-manifest entries", () => {
    // Locate the FILE_PLAN const block — from "const FILE_PLAN" through the
    // matching "];". We extract the names from within it.
    const filePlanMatch = bundleExporterCode.match(
      /const FILE_PLAN[\s\S]*?= \[([\s\S]*?)\];/,
    );
    expect(filePlanMatch, "Could not locate const FILE_PLAN in bundle-exporter.ts").not.toBeNull();

    const filePlanBlock = filePlanMatch![1]!;

    const nameMatches = [...filePlanBlock.matchAll(/name:\s*"([^"]+)"/g)];
    const names = nameMatches.map((m) => m[1]!).sort();

    const expectedNames = [
      "artifacts.json",
      "events.jsonl",
      "metadata.json",
      "prompts.json",
      "session-branch.json",
      "system-prompt.txt",
      "tools.json",
    ];

    expect(names.length).toBe(7);
    expect(names).toEqual(expectedNames);
  });

  it("FILE_PLAN entries have correct mediaTypes", () => {
    const filePlanMatch = bundleExporterCode.match(
      /const FILE_PLAN[\s\S]*?= \[([\s\S]*?)\];/,
    );
    expect(filePlanMatch, "Could not locate const FILE_PLAN in bundle-exporter.ts").not.toBeNull();

    const filePlanBlock = filePlanMatch![1]!;

    // Extract paired name+mediaType by splitting on entry boundaries.
    // Each entry looks like: { name: "...", mediaType: "...", body: ... }
    const nameMatches = [...filePlanBlock.matchAll(/name:\s*"([^"]+)"/g)];
    const mediaTypeMatches = [...filePlanBlock.matchAll(/mediaType:\s*"([^"]+)"/g)];
    expect(nameMatches.length).toBe(mediaTypeMatches.length);

    const nameToMediaType: Record<string, string> = {};
    for (let i = 0; i < nameMatches.length; i++) {
      nameToMediaType[nameMatches[i]![1]!] = mediaTypeMatches[i]![1]!;
    }

    // Locked table.
    const expectedMediaTypes: Record<string, string> = {
      "events.jsonl": "application/x-ndjson",
      "session-branch.json": "application/json",
      "metadata.json": "application/json",
      "artifacts.json": "application/json",
      "prompts.json": "application/json",
      "system-prompt.txt": "text/plain",
      "tools.json": "application/json",
    };

    for (const [name, expectedMediaType] of Object.entries(expectedMediaTypes)) {
      expect(
        nameToMediaType[name],
        `${name} should have mediaType "${expectedMediaType}"`,
      ).toBe(expectedMediaType);
    }
  });

  it("manifest.json string literal appears ≥2 times in bundle-exporter.ts (separate from FILE_PLAN)", () => {
    // One occurrence in the manifest self-write path, plus one in
    // the manifestContents array that populates the contents list.
    const manifestMatches = bundleExporterContent.match(/["']manifest\.json["']/g);
    expect(
      manifestMatches,
      "manifest.json must appear ≥2 times in bundle-exporter.ts",
    ).not.toBeNull();
    expect(manifestMatches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Case 4: TrajectoryBundleManifest has the expected readonly field set (§6.2)
// ---------------------------------------------------------------------------

describe("bundle-export-shape: TrajectoryBundleManifest field set (export.ts)", () => {
  it("TrajectoryBundleManifest has all required fields", () => {
    const manifestBlockMatch = exportContent.match(
      /export interface TrajectoryBundleManifest\s*\{([\s\S]*?)^}/m,
    );
    expect(
      manifestBlockMatch,
      "Could not locate export interface TrajectoryBundleManifest block",
    ).not.toBeNull();

    const block = manifestBlockMatch![1]!;

    // Extract all "readonly fieldName" lines (including optional with "?:").
    const fieldMatches = [...block.matchAll(/readonly (\w+)\??:/g)];
    const fields = fieldMatches.map((m) => m[1]!);

    // Required fields (11 required).
    const requiredFields = [
      "traceSchema",
      "schemaVersion",
      "generatedAt",
      "traceId",
      "sessionId",
      "workspaceDir",
      "leafId",
      "eventCount",
      "runtimeEventCount",
      "transcriptEventCount",
      "sourceFiles",
    ];

    for (const field of requiredFields) {
      expect(fields, `TrajectoryBundleManifest must have required field: ${field}`).toContain(
        field,
      );
    }

    // Optional fields.
    const optionalFields = ["sessionKey", "contents", "supplementalFiles", "warnings"];
    for (const field of optionalFields) {
      expect(fields, `TrajectoryBundleManifest must have optional field: ${field}`).toContain(
        field,
      );
    }

    // At least 15 distinct field names total (11 required + 4 optional).
    expect(new Set(fields).size).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// Case 5: Privacy warning docstring present in bundle-exporter.ts
// ---------------------------------------------------------------------------

describe("bundle-export-shape: privacy warning docstring (bundle-exporter.ts)", () => {
  it("bundle-exporter.ts module docstring references privacy warning", () => {
    // The privacy note must appear in the module's docstring.
    // The redaction implementer will see this as the contract being upgraded.
    const hasPrivacyRef = /§8\.?5|Privacy Warning|session.?branch\.json.*PII|raw.?content|redact/i.test(
      bundleExporterContent,
    );
    expect(
      hasPrivacyRef,
      "bundle-exporter.ts must contain a privacy/PII reference in its module docstring",
    ).toBe(true);
  });
});
