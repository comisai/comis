// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  ConfigWriteAuditRecordSchema,
  ConfigObserveAuditRecordSchema,
  type ConfigWriteAuditRecord,
  type ConfigObserveAuditRecord,
} from "./types.js";

describe("config-audit/types", () => {
  it("rejects empty object on both write and read schemas", () => {
    const writeResult = ConfigWriteAuditRecordSchema.safeParse({});
    expect(writeResult.success).toBe(false);

    const readResult = ConfigObserveAuditRecordSchema.safeParse({});
    expect(readResult.success).toBe(false);
  });

  it("accepts a fully-populated write record with gatewayMode fields omitted", () => {
    const valid: ConfigWriteAuditRecord = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      phase: "write",
      source: "config-patch-rpc",
      configPath: "/home/test/.comis/config.yaml",

      pid: 12345,
      ppid: 1,
      argv: ["node", "daemon.js", "--config", "config.yaml"],
      cwd: "/home/test",
      execArgv: [],
      watchMode: false,

      existsBefore: true,
      previousHash:
        "0000000000000000000000000000000000000000000000000000000000000000",
      previousBytes: 128,
      previousStat: {
        dev: 64768,
        ino: 999_999,
        mode: 0o600,
        nlink: 1,
        uid: 1000,
        gid: 1000,
      },
      hasMetaBefore: true,

      nextHash:
        "1111111111111111111111111111111111111111111111111111111111111111",
      nextBytes: 196,
      nextStat: {
        dev: 64768,
        ino: 999_999,
        mode: 0o600,
        nlink: 1,
        uid: 1000,
        gid: 1000,
      },
      hasMetaAfter: true,
      changedPathCount: 1,

      result: "rename",
      suspicious: [],

      ts: "2026-05-19T03:00:00.000Z",
      tsMs: 1_779_148_800_000,
    };

    const parsed = ConfigWriteAuditRecordSchema.parse(valid);
    // Verify the gatewayMode fields are NOT carried into the parsed
    // shape — z.object() is non-strict so they would silently pass
    // through if present in input, but we never emit them.
    expect("gatewayModeBefore" in parsed).toBe(false);
    expect("gatewayModeAfter" in parsed).toBe(false);
    expect(parsed.phase).toBe("write");
    expect(parsed.source).toBe("config-patch-rpc");
    expect(parsed.result).toBe("rename");
  });

  it("accepts a fully-populated read record", () => {
    const valid: ConfigObserveAuditRecord = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      phase: "read",
      source: "config-load",
      configPath: "/home/test/.comis/config.yaml",

      pid: 12345,
      ppid: 1,
      argv: ["node", "daemon.js"],
      cwd: "/home/test",
      execArgv: [],
      watchMode: true,

      suspicious: ["unknown-binary"],

      ts: "2026-05-19T03:00:00.000Z",
      tsMs: 1_779_148_800_000,
    };

    const parsed = ConfigObserveAuditRecordSchema.parse(valid);
    expect(parsed.phase).toBe("read");
    expect(parsed.suspicious).toEqual(["unknown-binary"]);
  });
});
