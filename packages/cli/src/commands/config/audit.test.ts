// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `comis config audit show|scrub` subcommands (Plan 45-05
 * task 12). Mirror sessions report show|list test patterns.
 */
import { Command } from "commander";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../client/rpc-client.js", () => {
  return {
    callTyped: vi.fn(),
    withClient: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn({})),
  };
});

import { callTyped } from "../../client/rpc-client.js";
import { registerConfigAuditCommand } from "./audit.js";

describe("registerConfigAuditCommand", () => {
  let program: Command;
  let configCmd: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    configCmd = program.command("config").description("Configuration management");
    registerConfigAuditCommand(configCmd);
  });

  it("registers the audit subcommand group on the config parent", () => {
    const auditCmd = configCmd.commands.find((c) => c.name() === "audit");
    expect(auditCmd).toBeDefined();
  });

  it("registers show subcommand under audit", () => {
    const auditCmd = configCmd.commands.find((c) => c.name() === "audit")!;
    const showCmd = auditCmd.commands.find((c) => c.name() === "show");
    expect(showCmd).toBeDefined();
    expect(showCmd!.options.some((o) => o.long === "--since")).toBe(true);
    expect(showCmd!.options.some((o) => o.long === "--suspicious-only")).toBe(true);
    expect(showCmd!.options.some((o) => o.long === "--pid")).toBe(true);
    expect(showCmd!.options.some((o) => o.long === "--tail")).toBe(true);
    expect(showCmd!.options.some((o) => o.long === "--format")).toBe(true);
  });

  it("registers scrub subcommand under audit", () => {
    const auditCmd = configCmd.commands.find((c) => c.name() === "audit")!;
    const scrubCmd = auditCmd.commands.find((c) => c.name() === "scrub");
    expect(scrubCmd).toBeDefined();
    expect(scrubCmd!.options.some((o) => o.long === "--dry-run")).toBe(true);
  });

  it("show --since 1h forwards the filter to the RPC", async () => {
    const mock = vi.mocked(callTyped);
    mock.mockResolvedValueOnce({ records: [] });

    await program.parseAsync(["node", "test", "config", "audit", "show", "--since", "1h"]);

    expect(mock).toHaveBeenCalledTimes(1);
    const [, , params] = mock.mock.calls[0]!;
    expect(params).toMatchObject({ since: "1h" });
  });

  it("show --suspicious-only=true forwards the boolean filter", async () => {
    const mock = vi.mocked(callTyped);
    mock.mockResolvedValueOnce({ records: [] });

    await program.parseAsync([
      "node",
      "test",
      "config",
      "audit",
      "show",
      "--suspicious-only",
    ]);

    expect(mock).toHaveBeenCalledTimes(1);
    const [, , params] = mock.mock.calls[0]!;
    expect(params).toMatchObject({ suspiciousOnly: true });
  });

  it("show --pid forwards the numeric filter", async () => {
    const mock = vi.mocked(callTyped);
    mock.mockResolvedValueOnce({ records: [] });

    await program.parseAsync([
      "node",
      "test",
      "config",
      "audit",
      "show",
      "--pid",
      "13927",
    ]);

    expect(mock).toHaveBeenCalledTimes(1);
    const [, , params] = mock.mock.calls[0]!;
    expect(params).toMatchObject({ pid: 13927 });
  });

  it("show --tail forwards the tail cap", async () => {
    const mock = vi.mocked(callTyped);
    mock.mockResolvedValueOnce({ records: [] });

    await program.parseAsync([
      "node",
      "test",
      "config",
      "audit",
      "show",
      "--tail",
      "50",
    ]);

    const [, , params] = mock.mock.calls[0]!;
    expect(params).toMatchObject({ tail: 50 });
  });

  it("show --format=json prints raw JSON.stringify of records", async () => {
    const mock = vi.mocked(callTyped);
    const recs = [
      { pid: 1, source: "config-patch-rpc" },
      { pid: 2, source: "cli-sync-tooling" },
    ];
    mock.mockResolvedValueOnce({ records: recs });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "audit",
        "show",
        "--format=json",
      ]);
      const printed = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toContain("config-patch-rpc");
      expect(printed).toContain("cli-sync-tooling");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("scrub --dry-run calls config.audit.scrub with dryRun=true and reports would-rewrite count", async () => {
    const mock = vi.mocked(callTyped);
    mock.mockResolvedValueOnce({ rewrittenRecords: 5, skippedMalformed: 0, aborted: false });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "test", "config", "audit", "scrub", "--dry-run"]);
      const [, , params] = mock.mock.calls[0]!;
      expect(params).toMatchObject({ dryRun: true });
      const printed = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toMatch(/would rewrite 5/i);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("scrub (no flags) calls config.audit.scrub without dryRun and reports rewrote count", async () => {
    const mock = vi.mocked(callTyped);
    mock.mockResolvedValueOnce({ rewrittenRecords: 7, skippedMalformed: 1, aborted: false });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "test", "config", "audit", "scrub"]);
      const printed = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toMatch(/rewrote 7/i);
      expect(printed).toMatch(/1.*malformed/i);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
