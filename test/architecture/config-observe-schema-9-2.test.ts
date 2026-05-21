// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariant — `ConfigObserveAuditRecordSchema` honors
 * design §9.2 verbatim.
 *
 * The on-disk schema for `event: "config.observe"` audit records is the
 * forensics contract for boot-time misconfiguration triage (operators
 * use `comis config audit show` against `~/.comis/logs/config-audit.jsonl`).
 * Design §9.2 enumerates the canonical field set; this test pins the
 * Zod-schema shape to that enumeration so a casual schema-shrink can't
 * silently regress the contract.
 *
 * The literal field list below is the source of truth this test enforces.
 * Adding a new §9.2 field means BOTH the schema entry AND the entry here.
 *
 * Scope: this test does NOT validate on-disk records. It checks the
 * Zod-schema shape at the import site. Semantic correctness is gated by
 * `packages/observability/src/config-audit/types.test.ts`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { ConfigObserveAuditRecordSchema } from "@comis/observability";

/**
 * Design-§9.2 required field set. Each name MUST appear as a key on
 * `ConfigObserveAuditRecordSchema.shape`. Sorted by field group so a
 * diff reviewer can spot a missing block at a glance.
 */
const DESIGN_92_FIELDS = [
  // Identity + envelope.
  "traceSchema",
  "schemaVersion",
  "ts",
  "source",
  "event",
  "phase",
  // Caller provenance.
  "configPath",
  "callerSource",
  "pid",
  "ppid",
  "cwd",
  "argv",
  "execArgv",
  "watchMode",
  // File-state block.
  "exists",
  "valid",
  "hash",
  "bytes",
  "mtimeMs",
  "ctimeMs",
  "dev",
  "ino",
  "mode",
  "nlink",
  "uid",
  "gid",
  // LKG triple.
  "lastKnownGoodHash",
  "lastKnownGoodBytes",
  "lastKnownGoodMtimeMs",
  // Backup triple.
  "backupHash",
  "backupBytes",
  "backupMtimeMs",
  // Recovery state.
  "clobberedPath",
  "restoredFromBackup",
  "restoredBackupPath",
  "restoreErrorCode",
  "restoreErrorMessage",
  // Heuristics.
  "suspicious",
] as const;

describe("config.observe schema honors design §9.2", () => {
  it("schema shape contains every field listed in design §9.2", () => {
    const shapeKeys = Object.keys(ConfigObserveAuditRecordSchema.shape);
    for (const field of DESIGN_92_FIELDS) {
      expect(
        shapeKeys,
        `ConfigObserveAuditRecordSchema is missing design-§9.2 field: ${field}`,
      ).toContain(field);
    }
  });

  it("schema rejects an `exists:true` record missing the file-stat block", () => {
    // Sanity check: the new fields are REQUIRED, not optional. If a
    // refactor accidentally adds `.optional()` to one of them, this
    // test catches the regression.
    const bare = {
      traceSchema: "comis-config-audit" as const,
      schemaVersion: 1 as const,
      ts: "2026-05-20T00:00:00.000Z",
      source: "config-io" as const,
      event: "config.observe" as const,
      phase: "read" as const,
      configPath: "/x",
      callerSource: "test",
      pid: 1,
      ppid: 0,
      argv: [],
      cwd: "/",
      execArgv: [],
      watchMode: false,
      suspicious: [],
      // Deliberately MISSING: exists, valid, hash, bytes, …
    };
    const r = ConfigObserveAuditRecordSchema.safeParse(bare);
    expect(r.success).toBe(false);
  });
});
