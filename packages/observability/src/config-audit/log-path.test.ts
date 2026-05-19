// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import * as path from "node:path";

import { resolveConfigAuditLogPath } from "./log-path.js";

describe("config-audit/log-path", () => {
  it("defaults to $HOME/.comis/logs/config-audit.jsonl when no env override is set", () => {
    const homedir = "/home/test";
    const result = resolveConfigAuditLogPath({
      homedir: () => homedir,
      getEnv: () => undefined,
    });
    expect(result).toBe(path.join(homedir, ".comis", "logs", "config-audit.jsonl"));
  });

  it("honors COMIS_CONFIG_AUDIT_LOG env override when set", () => {
    const result = resolveConfigAuditLogPath({
      homedir: () => "/home/test",
      getEnv: (key: string) =>
        key === "COMIS_CONFIG_AUDIT_LOG" ? "/var/log/comis-audit.jsonl" : undefined,
    });
    expect(result).toBe("/var/log/comis-audit.jsonl");
  });

  it("falls back to the default when the env value is an empty string", () => {
    // Empty-string treated as "not set" so a typo'd `export
    // COMIS_CONFIG_AUDIT_LOG=` does not redirect the log to ''.
    const homedir = "/home/test";
    const result = resolveConfigAuditLogPath({
      homedir: () => homedir,
      getEnv: (key: string) => (key === "COMIS_CONFIG_AUDIT_LOG" ? "" : undefined),
    });
    expect(result).toBe(path.join(homedir, ".comis", "logs", "config-audit.jsonl"));
  });
});
