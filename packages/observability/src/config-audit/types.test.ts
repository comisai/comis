// SPDX-License-Identifier: Apache-2.0
/**
 * Schema-shape tests for `ConfigWriteAuditRecordSchema` /
 * `ConfigObserveAuditRecordSchema` per design §9.2 (post-260519-rrm
 * deviation G fix).
 *
 * New schema invariants:
 *   - `event` discriminant ("config.write" | "config.observe"), NOT
 *     `phase`.
 *   - `source` is the literal `"config-io"`; caller provenance moves
 *     into `callerSource: string`.
 *   - Stat fields are FLAT (previousDev/Ino/Mode/Nlink/Uid/Gid plus
 *     next* mirrors); `dev` and `ino` are `string | null` for safe-int
 *     overflow protection.
 *   - `tsMs` is dropped; only `ts` (ISO string) remains.
 *
 * @module
 */
import { describe, it, expect } from "vitest";

import {
  ConfigWriteAuditRecordSchema,
  ConfigObserveAuditRecordSchema,
  type ConfigWriteAuditRecord,
  type ConfigObserveAuditRecord,
} from "./types.js";

describe("config-audit/types — design §9.2 shape", () => {
  it("rejects empty object on both write and read schemas", () => {
    const writeResult = ConfigWriteAuditRecordSchema.safeParse({});
    expect(writeResult.success).toBe(false);

    const readResult = ConfigObserveAuditRecordSchema.safeParse({});
    expect(readResult.success).toBe(false);
  });

  it("accepts a fully-populated write record with the new flat-stat shape", () => {
    const valid: ConfigWriteAuditRecord = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-19T03:00:00.000Z",
      source: "config-io",
      event: "config.write",
      result: "rename",

      configPath: "/home/test/.comis/config.yaml",
      callerSource: "config-patch-rpc",
      pid: 12345,
      ppid: 1,
      argv: ["node", "daemon.js", "--config", "config.yaml"],
      cwd: "/home/test",
      execArgv: [],
      watchMode: false,
      watchSession: null,
      watchCommand: null,

      existsBefore: true,
      previousHash:
        "0000000000000000000000000000000000000000000000000000000000000000",
      nextHash:
        "1111111111111111111111111111111111111111111111111111111111111111",
      previousBytes: 128,
      nextBytes: 196,

      previousDev: "64768",
      nextDev: "64768",
      previousIno: "999999",
      nextIno: "999999",
      previousMode: 0o600,
      nextMode: 0o600,
      previousNlink: 1,
      nextNlink: 1,
      previousUid: 1000,
      nextUid: 1000,
      previousGid: 1000,
      nextGid: 1000,

      changedPathCount: 1,
      hasMetaBefore: true,
      hasMetaAfter: true,

      suspicious: [],
    };

    const parsed = ConfigWriteAuditRecordSchema.parse(valid);
    expect(parsed.event).toBe("config.write");
    expect(parsed.source).toBe("config-io");
    expect(parsed.callerSource).toBe("config-patch-rpc");
    expect(parsed.result).toBe("rename");
    expect(parsed.previousDev).toBe("64768");
    expect(parsed.previousIno).toBe("999999");
  });

  it("rejects a record carrying the OLD `phase` discriminant", () => {
    const old = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      // OLD shape — must fail.
      phase: "write",
      source: "config-patch-rpc",
      configPath: "/x",
      pid: 1,
      ppid: 0,
      argv: [],
      cwd: "/",
      execArgv: [],
      watchMode: false,
      existsBefore: false,
      previousHash: null,
      previousBytes: null,
      previousStat: null,
      hasMetaBefore: false,
      nextHash: null,
      nextBytes: null,
      nextStat: null,
      hasMetaAfter: false,
      changedPathCount: null,
      result: "rename",
      suspicious: [],
      ts: "2026-05-19T03:00:00.000Z",
      tsMs: 1_779_148_800_000,
    };
    const r = ConfigWriteAuditRecordSchema.safeParse(old);
    expect(r.success).toBe(false);
  });

  it("rejects a record carrying nested `previousStat` (must be flat)", () => {
    const malformed = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-19T03:00:00.000Z",
      source: "config-io",
      event: "config.write",
      result: "rename",
      configPath: "/x",
      callerSource: "config-patch-rpc",
      pid: 1,
      ppid: 0,
      argv: [],
      cwd: "/",
      execArgv: [],
      watchMode: false,
      watchSession: null,
      watchCommand: null,
      existsBefore: true,
      previousHash: null,
      nextHash: null,
      previousBytes: null,
      nextBytes: null,
      // OLD nested-stat shape — should not parse (flat fields are required).
      previousStat: { dev: 1, ino: 1, mode: 0o600, nlink: 1, uid: 1, gid: 1 },
      nextStat: null,
      changedPathCount: null,
      hasMetaBefore: true,
      hasMetaAfter: false,
      suspicious: [],
    };
    const r = ConfigWriteAuditRecordSchema.safeParse(malformed);
    expect(r.success).toBe(false);
  });

  it("accepts result=`copy-fallback` (new design §9.2 value)", () => {
    const valid: ConfigWriteAuditRecord = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-19T03:00:00.000Z",
      source: "config-io",
      event: "config.write",
      result: "copy-fallback",
      configPath: "/x",
      callerSource: "last-known-good-save",
      pid: 1,
      ppid: 0,
      argv: [],
      cwd: "/",
      execArgv: [],
      watchMode: false,
      watchSession: null,
      watchCommand: null,
      existsBefore: false,
      previousHash: null,
      nextHash: null,
      previousBytes: null,
      nextBytes: null,
      previousDev: null,
      nextDev: null,
      previousIno: null,
      nextIno: null,
      previousMode: null,
      nextMode: null,
      previousNlink: null,
      nextNlink: null,
      previousUid: null,
      nextUid: null,
      previousGid: null,
      nextGid: null,
      changedPathCount: null,
      hasMetaBefore: false,
      hasMetaAfter: false,
      suspicious: [],
    };
    const parsed = ConfigWriteAuditRecordSchema.parse(valid);
    expect(parsed.result).toBe("copy-fallback");
  });

  it("accepts a fully-populated observe record with event=`config.observe` carrying the full §9.2 field set", () => {
    const valid: ConfigObserveAuditRecord = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-19T03:00:00.000Z",
      source: "config-io",
      event: "config.observe",
      phase: "read",
      configPath: "/home/test/.comis/config.yaml",
      callerSource: "config-load",
      pid: 12345,
      ppid: 1,
      argv: ["node", "daemon.js"],
      cwd: "/home/test",
      execArgv: [],
      watchMode: true,
      // §9.2 file-state.
      exists: true,
      valid: true,
      hash: "0".repeat(64),
      bytes: 128,
      mtimeMs: 1_779_148_800_000,
      ctimeMs: 1_779_148_800_000,
      dev: "64768",
      ino: "999999",
      mode: 0o600,
      nlink: 1,
      uid: 1000,
      gid: 1000,
      // §9.2 LKG triple.
      lastKnownGoodHash: "1".repeat(64),
      lastKnownGoodBytes: 100,
      lastKnownGoodMtimeMs: 1_779_148_000_000,
      // §9.2 backup triple.
      backupHash: null,
      backupBytes: null,
      backupMtimeMs: null,
      // §9.2 recovery state.
      clobberedPath: null,
      restoredFromBackup: false,
      restoredBackupPath: null,
      restoreErrorCode: null,
      restoreErrorMessage: null,
      suspicious: ["unknown-binary"],
    };

    const parsed = ConfigObserveAuditRecordSchema.parse(valid);
    expect(parsed.event).toBe("config.observe");
    expect(parsed.phase).toBe("read");
    expect(parsed.exists).toBe(true);
    expect(parsed.valid).toBe(true);
    expect(parsed.hash).toBe("0".repeat(64));
    expect(parsed.dev).toBe("64768");
    expect(parsed.lastKnownGoodHash).toBe("1".repeat(64));
    expect(parsed.suspicious).toEqual(["unknown-binary"]);
  });

  it("accepts an `exists:false` observe record with the full file-stat block nulled", () => {
    const missing: ConfigObserveAuditRecord = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-20T00:00:00.000Z",
      source: "config-io",
      event: "config.observe",
      phase: "read",
      configPath: "/tmp/missing.yaml",
      callerSource: "daemon-bootstrap",
      pid: 1,
      ppid: 0,
      argv: ["node", "daemon.js"],
      cwd: "/",
      execArgv: [],
      watchMode: false,
      exists: false,
      valid: false,
      hash: null,
      bytes: null,
      mtimeMs: null,
      ctimeMs: null,
      dev: null,
      ino: null,
      mode: null,
      nlink: null,
      uid: null,
      gid: null,
      lastKnownGoodHash: null,
      lastKnownGoodBytes: null,
      lastKnownGoodMtimeMs: null,
      backupHash: null,
      backupBytes: null,
      backupMtimeMs: null,
      clobberedPath: null,
      restoredFromBackup: false,
      restoredBackupPath: null,
      restoreErrorCode: null,
      restoreErrorMessage: null,
      suspicious: [],
    };
    const parsed = ConfigObserveAuditRecordSchema.parse(missing);
    expect(parsed.exists).toBe(false);
    expect(parsed.valid).toBe(false);
    expect(parsed.hash).toBeNull();
    expect(parsed.dev).toBeNull();
  });

  it("rejects observe record with `phase` other than `read`", () => {
    const bad = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-20T00:00:00.000Z",
      source: "config-io",
      event: "config.observe",
      phase: "write", // wrong literal
      configPath: "/x",
      callerSource: "x",
      pid: 1,
      ppid: 0,
      argv: [],
      cwd: "/",
      execArgv: [],
      watchMode: false,
      exists: false,
      valid: false,
      hash: null,
      bytes: null,
      mtimeMs: null,
      ctimeMs: null,
      dev: null,
      ino: null,
      mode: null,
      nlink: null,
      uid: null,
      gid: null,
      lastKnownGoodHash: null,
      lastKnownGoodBytes: null,
      lastKnownGoodMtimeMs: null,
      backupHash: null,
      backupBytes: null,
      backupMtimeMs: null,
      clobberedPath: null,
      restoredFromBackup: false,
      restoredBackupPath: null,
      restoreErrorCode: null,
      restoreErrorMessage: null,
      suspicious: [],
    };
    const r = ConfigObserveAuditRecordSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects observe record where `dev` is a number rather than a string", () => {
    const bad = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-20T00:00:00.000Z",
      source: "config-io",
      event: "config.observe",
      phase: "read",
      configPath: "/x",
      callerSource: "x",
      pid: 1,
      ppid: 0,
      argv: [],
      cwd: "/",
      execArgv: [],
      watchMode: false,
      exists: true,
      valid: true,
      hash: "0".repeat(64),
      bytes: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      dev: 17, // number — must be string|null per §9.2
      ino: "999",
      mode: 0o600,
      nlink: 1,
      uid: 0,
      gid: 0,
      lastKnownGoodHash: null,
      lastKnownGoodBytes: null,
      lastKnownGoodMtimeMs: null,
      backupHash: null,
      backupBytes: null,
      backupMtimeMs: null,
      clobberedPath: null,
      restoredFromBackup: false,
      restoredBackupPath: null,
      restoreErrorCode: null,
      restoreErrorMessage: null,
      suspicious: [],
    };
    const r = ConfigObserveAuditRecordSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});
