// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `comis skills import` CLI command.
 *
 * Covers the typed RPC round-trip (skills.import via callTyped over
 * SkillsImportContract), archive/source/scope/confirm option threading, the
 * resolvedAgentId + source reporting, --format json vs the default table
 * render, and the ensureGatewayToken pre-check running BEFORE the socket opens.
 *
 * Mirrors the fleet.test.ts seam: `withClient` is mocked via importOriginal so
 * the REAL `callTyped` runs (parsing request + response against the contract),
 * and `ensureGatewayToken` is a controllable spy.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillsImportContract } from "@comis/core";
import type { RpcClient } from "../client/rpc-client.js";
import { createTestProgram, createConsoleSpy, createProcessExitSpy, getSpyOutput } from "../test-helpers.js";

// Mock withClient (ESM hoist); importOriginal keeps the real callTyped so the
// request + response Zod validation actually runs end-to-end.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return { ...actual, withClient: vi.fn() };
});

// Mock the gateway-token pre-check so the ordering assertion is deterministic
// (no dependency on ~/.comis/.env or a process-level token).
vi.mock("./mcp-token.js", () => ({ ensureGatewayToken: vi.fn() }));

const { registerSkillsCommand } = await import("./skills.js");
const { withClient } = await import("../client/rpc-client.js");
const { ensureGatewayToken } = await import("./mcp-token.js");

/** A minimal-but-valid SkillsImportContract response (the real callTyped parses it). */
const FAKE_RESULT = {
  ok: true as const,
  path: "/data/skills/my-skill",
  name: "my-skill",
  fileCount: 2,
  source: "imported" as const,
  resolvedAgentId: "agent-a",
};

function captureClient(): { client: RpcClient; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: RpcClient = {
    call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params });
      return Promise.resolve(FAKE_RESULT);
    },
    close(): void {},
    onNotification(): void {},
  };
  return { client, calls };
}

describe("comis skills import", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(ensureGatewayToken).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("round-trips <ref> to skills.import via the typed contract and reports resolvedAgentId + source", async () => {
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerSkillsCommand(program);
    await program.parseAsync([
      "node", "test", "skills", "import",
      "https://example.com/skill.zip",
      "--source", "archive",
      "--scope", "shared",
      "--confirm",
      "--token", "test-token",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(SkillsImportContract.method);
    expect(calls[0]?.params).toMatchObject({
      url: "https://example.com/skill.zip",
      source: "archive",
      scope: "shared",
      confirm: true,
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("agent-a"); // resolvedAgentId reported
    expect(output).toContain("imported"); // source reported
    expect(output).toContain("my-skill");
  });

  it("emits the raw JSON result under --format json", async () => {
    const { client } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerSkillsCommand(program);
    await program.parseAsync([
      "node", "test", "skills", "import",
      "https://github.com/o/r/tree/main/skills/s",
      "--format", "json",
      "--token", "test-token",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as { resolvedAgentId?: string; source?: string };
    expect(parsed.resolvedAgentId).toBe("agent-a");
    expect(parsed.source).toBe("imported");
  });

  it("resolves the gateway token BEFORE opening the socket (a token error never reaches withClient)", async () => {
    vi.mocked(ensureGatewayToken).mockImplementation(() => {
      throw new Error("Missing COMIS_GATEWAY_TOKEN — set in ~/.comis/.env or pass --token <token>.");
    });

    const program = createTestProgram();
    registerSkillsCommand(program);
    await program.parseAsync(["node", "test", "skills", "import", "https://example.com/s.zip"]);

    // The token pre-check ran and failed; the socket was never opened.
    expect(ensureGatewayToken).toHaveBeenCalledTimes(1);
    expect(withClient).not.toHaveBeenCalled();
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});
