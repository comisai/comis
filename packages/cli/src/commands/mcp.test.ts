// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the `comis mcp` CLI command surface.
 *
 * Covers the token-resolution helper `ensureGatewayToken`:
 *   - missing token (no env, no ~/.comis/.env) surfaces an explicit error
 *     naming COMIS_GATEWAY_TOKEN (NOT a generic 401),
 *   - the --token flag overrides the env var,
 *   - a preset env var passes through without throwing,
 *   - the thrown error never interpolates a token value.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGatewayToken } from "./mcp.js";

describe("ensureGatewayToken", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    // Point HOME at a fresh tmp dir with NO .comis/.env so loadEnvFile's
    // homedir()-derived path resolves to a missing file (load returns -1,
    // no env var injected). os.homedir() honors $HOME on POSIX.
    savedHome = process.env["HOME"];
    savedToken = process.env["COMIS_GATEWAY_TOKEN"];
    tmpHome = mkdtempSync(join(tmpdir(), "comis-mcp-test-"));
    process.env["HOME"] = tmpHome;
    delete process.env["COMIS_GATEWAY_TOKEN"];
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedToken === undefined) delete process.env["COMIS_GATEWAY_TOKEN"];
    else process.env["COMIS_GATEWAY_TOKEN"] = savedToken;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("Test 1: throws naming COMIS_GATEWAY_TOKEN when unset and no ~/.comis/.env", () => {
    expect(() => ensureGatewayToken(undefined)).toThrow(/Missing COMIS_GATEWAY_TOKEN/);
  });

  it("Test 2: --token flag sets process.env.COMIS_GATEWAY_TOKEN and does not throw", () => {
    expect(() => ensureGatewayToken("flag-tok")).not.toThrow();
    expect(process.env["COMIS_GATEWAY_TOKEN"]).toBe("flag-tok");
  });

  it("Test 3: preset COMIS_GATEWAY_TOKEN env passes through without throwing", () => {
    process.env["COMIS_GATEWAY_TOKEN"] = "x";
    expect(() => ensureGatewayToken(undefined)).not.toThrow();
  });

  it("Test 4: thrown error names only the env var, never a token value", () => {
    // A sentinel token value is present in the flag path test; ensure the
    // miss-path error never leaks any token string. The message must name
    // the env var but contain no secret material.
    let message = "";
    try {
      ensureGatewayToken(undefined);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("COMIS_GATEWAY_TOKEN");
    expect(message).not.toContain("flag-tok");
    expect(message).not.toMatch(/token=\S/i);
  });
});

describe("registerMcpCommand — subcommand registration", () => {
  it("registers the list/status/test subcommands under `mcp`", async () => {
    const { Command } = await import("commander");
    const { registerMcpCommand } = await import("./mcp.js");
    const program = new Command();
    registerMcpCommand(program);

    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    expect(mcpCmd).toBeDefined();
    expect(mcpCmd!.description()).toBe("MCP server management");

    const subcommandNames = mcpCmd!.commands.map((c) => c.name());
    for (const name of ["list", "status", "connect", "disconnect", "reconnect", "test"]) {
      expect(subcommandNames).toContain(name);
    }
  });

  it("connect requires --transport and exposes the four transport flags", async () => {
    const { Command } = await import("commander");
    const { registerMcpCommand } = await import("./mcp.js");
    const program = new Command();
    registerMcpCommand(program);

    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    const connectCmd = mcpCmd!.commands.find((c) => c.name() === "connect");
    expect(connectCmd).toBeDefined();
    const optionNames = connectCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--transport");
    expect(optionNames).toContain("--command");
    expect(optionNames).toContain("--args");
    expect(optionNames).toContain("--url");
    expect(optionNames).toContain("--token");
    // connect must NOT carry the YAML-only filtering/idle flags.
    expect(optionNames).not.toContain("--allowlist");
    expect(optionNames).not.toContain("--blocklist");
    expect(optionNames).not.toContain("--idle-ttl");
  });
});
