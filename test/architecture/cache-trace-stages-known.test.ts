// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-HARD-11 — cache-trace stages closed-union enforcement.
 *
 * Mirrors `trajectory-event-types-known.test.ts`. Walks
 * `packages/observability/src/cache-trace/**\/*.ts` +
 * `packages/agent/src/**\/*.ts` for `recordStage(<literal>, …)` call
 * sites. Each first arg must be a string literal that is a member of
 * `CACHE_TRACE_STAGES`.
 *
 * Inverse-completeness check: every member of `CACHE_TRACE_STAGES`
 * (except sentinel-only stages and stages emitted via the terminal
 * `flushAndClose` path) has at least one producer. Producers are
 * counted from BOTH direct literal `recordStage("stage", …)` calls
 * AND the `CACHE_TRACE_BRIDGE_MAPPING` table values (the bridge
 * dispatches dynamically via `recordStage(stage, …)` where `stage`
 * is the table value, so the literal stage names don't show up at
 * the call site).
 *
 * @module
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  CACHE_TRACE_STAGES,
  CACHE_TRACE_BRIDGE_MAPPING,
} from "@comis/observability";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

/**
 * Production source roots scanned for `recordStage(<literal>, …)` calls.
 * Mirrors the closed-union enforcement pattern from
 * `trajectory-event-types-known.test.ts`. Cache-trace producers live
 * inside the observability cache-trace package itself (stream-fn-wrapper,
 * event-bus-bridge, runtime) and in agent-side executor wiring; no other
 * packages have producers today.
 */
const SCANNED_PACKAGE_DIRS: ReadonlyArray<string> = [
  resolve(PACKAGES_ROOT, "observability", "src", "cache-trace"),
  resolve(PACKAGES_ROOT, "agent", "src"),
] as const;

/**
 * Matches `recordStage("literal-stage-name", ...)` — captures the
 * literal stage name. Anchored on `recordStage(` to avoid false-positive
 * matches on unrelated identifiers. Picks up `trace.recordStage(...)`
 * (method-form) and a hypothetical bare `recordStage(...)` (import-form).
 */
const RECORD_STAGE_REGEX = /(?:\b|\.)recordStage\(\s*"([^"]+)"/g;

/**
 * Stages emitted via paths OTHER than a direct literal `recordStage(...)`
 * call.
 *
 * Listed here so the inverse-completeness check doesn't false-fail when
 * the literal stage name is absent from the AST.
 *
 * - `cache_trace.write_failures` — sentinel emitted by the runtime via
 *   `buildEvent({stage: "cache_trace.write_failures", …})` (inline path
 *   on writer rejection AND terminal-summary path in `flushAndClose`).
 *   No application-level producer; the runtime owns it.
 *
 * - `session:after` — terminal stage emitted unconditionally inside
 *   `flushAndClose` via `buildEvent({stage: "session:after", …})` +
 *   `writer.write(...)`. Bypasses the public `recordStage()` API so
 *   the regex can't capture it. Every session-close path produces
 *   exactly one `session:after` line on disk; no caller needs to emit
 *   it manually (see runtime.ts:380-389).
 */
const STAGES_WITHOUT_DIRECT_LITERAL_PRODUCER: ReadonlySet<string> = new Set<string>([
  "cache_trace.write_failures",
  "session:after",
]);

interface RecordStageSite {
  readonly file: string;
  readonly line: number;
  readonly stageName: string;
}

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
          "__test-helpers",
          "dist",
          "node_modules",
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
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function collectRecordStageSites(files: ReadonlyArray<string>): RecordStageSite[] {
  const sites: RecordStageSite[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      RECORD_STAGE_REGEX.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RECORD_STAGE_REGEX.exec(line)) !== null) {
        const stageName = m[1] ?? "";
        if (stageName.length > 0) {
          sites.push({ file, line: i + 1, stageName });
        }
      }
    }
  }
  return sites;
}

function collectAllSites(): RecordStageSite[] {
  const files: string[] = [];
  for (const dir of SCANNED_PACKAGE_DIRS) {
    walkProductionFiles(dir, files);
  }
  return collectRecordStageSites(files);
}

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replace(/\\/g, "/");
}

describe("cache-trace stages closed-union enforcement", () => {
  const known = new Set<string>(CACHE_TRACE_STAGES);

  it("every_recordStage_call_uses_a_CACHE_TRACE_STAGES_member", () => {
    const sites = collectAllSites();
    const violations = sites.filter((s) => !known.has(s.stageName));
    expect(
      violations,
      formatViolations({
        description:
          "Every recordStage(<literal>, ...) call site in " +
          "packages/observability/src/cache-trace + packages/agent/src " +
          "must use a stage from CACHE_TRACE_STAGES (closed union).",
        violations: violations.map((v) => ({
          file: `${repoRelative(v.file)}:${v.line}`,
          line: v.line,
          snippet: `recordStage("${v.stageName}", …) — not in CACHE_TRACE_STAGES`,
        })),
        suggestedFix:
          "Append the stage to CACHE_TRACE_STAGES in " +
          "packages/observability/src/cache-trace/types.ts (append-only " +
          "per SemVer rule from 2026-05-21 forward), OR use one of the " +
          "existing members.",
        designRef:
          "CACHE_TRACE_STAGES in packages/observability/src/cache-trace/types.ts",
      }),
    ).toEqual([]);

    // Sanity: walker actually found call sites.
    expect(
      sites.length,
      "sanity: scanner found at least one recordStage call site",
    ).toBeGreaterThan(0);
  });

  it("every_application_stage_in_CACHE_TRACE_STAGES_has_at_least_one_producer", () => {
    const sites = collectAllSites();
    const directProducers = new Set(sites.map((s) => s.stageName));
    const bridgeMappingProducers = new Set<string>(
      Object.values(CACHE_TRACE_BRIDGE_MAPPING),
    );

    const unwired = (CACHE_TRACE_STAGES as ReadonlyArray<string>).filter(
      (s) =>
        !STAGES_WITHOUT_DIRECT_LITERAL_PRODUCER.has(s) &&
        !directProducers.has(s) &&
        !bridgeMappingProducers.has(s),
    );

    expect(
      unwired,
      `These CACHE_TRACE_STAGES members have no producer ` +
        `(neither a direct recordStage(<literal>, ...) call nor a ` +
        `CACHE_TRACE_BRIDGE_MAPPING entry, and not in ` +
        `STAGES_WITHOUT_DIRECT_LITERAL_PRODUCER): ${unwired.join(", ")}. ` +
        `Either wire a producer in stream-fn-wrapper.ts / event-bus-bridge.ts ` +
        `/ pi-executor, OR add an entry to ` +
        `STAGES_WITHOUT_DIRECT_LITERAL_PRODUCER documenting the alternative ` +
        `emit path (e.g., via buildEvent in runtime.ts).`,
    ).toEqual([]);
  });
});
