// SPDX-License-Identifier: Apache-2.0
/**
 * Coverage tests for CLI_SUBCOMMAND_MAP (CLI-01 / v8 §7 — the `comis-agent`
 * subcommand→{tool|method} source-of-truth).
 *
 * Asserts the table is the tight 1:1 mapping of the FINAL subcommand set
 * (`skill` EXCLUDED — the denylisted orch:skill closed door; admin verbs
 * absent — CLI-03), that every target resolves to a real cap-map key (orch:*
 * or a self-scoped read, never admin/deny-by-origin), and that `list`/`status`
 * are BOTH flat enumerable entries (the same-gate predicate in Plan 05 iterates
 * the flat values, so a target must never hide inside a nested value shape).
 *
 * The companion arch-test (Plan 05) consumes the SAME table to prove no
 * subcommand reaches a weaker path AND that no target is denylisted at the cap
 * socket — so the CLI surface and the auditable cap-maps cannot drift.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  CLI_SUBCOMMAND_MAP,
  type CliCallTarget,
  type CliSubcommand,
} from "./cli-subcommand-map.js";
import { TOOL_CAPABILITY_MAP } from "./tool-capability-map.js";
import {
  HANDLER_CAPABILITY_MAP,
  SELF_SCOPED_AGENT_READS,
} from "./handler-capability-map.js";

const SELF_SCOPED_SET = new Set<string>(SELF_SCOPED_AGENT_READS);

describe("CLI_SUBCOMMAND_MAP", () => {
  it("contains EXACTLY the final subcommand set (skill excluded; list its own key)", () => {
    const keys = Object.keys(CLI_SUBCOMMAND_MAP).sort();
    expect(keys).toEqual(
      [
        "fetch",
        "find",
        "grep",
        "list",
        "ls",
        "read",
        "schedule",
        "search",
        "send",
        "spawn",
        "status",
        "whoami",
      ].sort(),
    );
  });

  it("maps each subcommand to its v8 §7 call target (1:1, cap never restated)", () => {
    expect(CLI_SUBCOMMAND_MAP.spawn).toEqual({ kind: "method", method: "session.spawn" });
    expect(CLI_SUBCOMMAND_MAP.run).toEqual({ kind: "method", method: "graph.execute" });
    expect(CLI_SUBCOMMAND_MAP.schedule).toEqual({ kind: "method", method: "cron.add" });
    expect(CLI_SUBCOMMAND_MAP.send).toEqual({ kind: "method", method: "message.send" });
    expect(CLI_SUBCOMMAND_MAP.search).toEqual({ kind: "tool", tool: "web_search" });
    expect(CLI_SUBCOMMAND_MAP.fetch).toEqual({ kind: "tool", tool: "web_fetch" });
    expect(CLI_SUBCOMMAND_MAP.read).toEqual({ kind: "tool", tool: "read" });
    expect(CLI_SUBCOMMAND_MAP.grep).toEqual({ kind: "tool", tool: "grep" });
    expect(CLI_SUBCOMMAND_MAP.find).toEqual({ kind: "tool", tool: "find" });
    expect(CLI_SUBCOMMAND_MAP.ls).toEqual({ kind: "tool", tool: "ls" });
    expect(CLI_SUBCOMMAND_MAP.whoami).toEqual({ kind: "method", method: "capabilities.introspect" });
    expect(CLI_SUBCOMMAND_MAP.status).toEqual({ kind: "method", method: "session.status" });
    expect(CLI_SUBCOMMAND_MAP.list).toEqual({ kind: "method", method: "session.list" });
  });

  it("has NO `skill` key (the denylisted orch:skill closed door — excluded by design)", () => {
    expect("skill" in CLI_SUBCOMMAND_MAP).toBe(false);
    expect((CLI_SUBCOMMAND_MAP as Record<string, unknown>).skill).toBeUndefined();
  });

  it("has NO admin/control-plane subcommand (CLI-03)", () => {
    for (const adminVerb of [
      "secrets",
      "config",
      "tokens",
      "gateway",
      "agents",
      "providers",
      "models",
      "channels",
      "env",
    ]) {
      expect(adminVerb in CLI_SUBCOMMAND_MAP).toBe(false);
    }
  });

  it("routes every {kind:'tool'} entry to a real TOOL_CAPABILITY_MAP key (CLI-01)", () => {
    for (const [sub, target] of Object.entries(CLI_SUBCOMMAND_MAP) as [string, CliCallTarget][]) {
      if (target.kind !== "tool") continue;
      expect(target.tool in TOOL_CAPABILITY_MAP, `${sub} → tool ${target.tool}`).toBe(true);
    }
  });

  it("routes every {kind:'method'} entry to a real HANDLER_CAPABILITY_MAP key (CLI-01)", () => {
    for (const [sub, target] of Object.entries(CLI_SUBCOMMAND_MAP) as [string, CliCallTarget][]) {
      if (target.kind !== "method") continue;
      expect(target.method in HANDLER_CAPABILITY_MAP, `${sub} → method ${target.method}`).toBe(true);
    }
  });

  it("targets only orch:* or self-scoped-read methods — never admin/deny-by-origin", () => {
    for (const [sub, target] of Object.entries(CLI_SUBCOMMAND_MAP) as [string, CliCallTarget][]) {
      if (target.kind !== "method") continue;
      const classification = HANDLER_CAPABILITY_MAP[target.method];
      const isOrchCap = typeof classification === "string" && classification.startsWith("orch:");
      const isSelfScoped = SELF_SCOPED_SET.has(target.method);
      expect(
        isOrchCap || isSelfScoped,
        `${sub} → ${target.method} is ${classification} (must be orch:* or self-scoped read)`,
      ).toBe(true);
      expect(classification, `${sub} → ${target.method} must not be deny-by-origin`).not.toBe(
        "deny-by-origin",
      );
    }
  });

  it("includes NO orch:skill method (the skills.* family is excluded from the table)", () => {
    for (const target of Object.values(CLI_SUBCOMMAND_MAP) as CliCallTarget[]) {
      if (target.kind !== "method") continue;
      expect(HANDLER_CAPABILITY_MAP[target.method]).not.toBe("orch:skill");
    }
  });

  it("exposes BOTH `list` and `status` as flat enumerable entries (no nested target)", () => {
    expect(CLI_SUBCOMMAND_MAP.list).toEqual({ kind: "method", method: "session.list" });
    expect(CLI_SUBCOMMAND_MAP.status).toEqual({ kind: "method", method: "session.status" });
    // Every value is a flat CliCallTarget (kind tool|method) — never a nested
    // {default, subVerbs} shape that would hide a target from the flat scan.
    for (const target of Object.values(CLI_SUBCOMMAND_MAP) as CliCallTarget[]) {
      expect(target.kind === "tool" || target.kind === "method").toBe(true);
    }
  });

  it("types CliSubcommand as the table's keys", () => {
    const sub: CliSubcommand = "whoami";
    expect(sub in CLI_SUBCOMMAND_MAP).toBe(true);
  });
});
