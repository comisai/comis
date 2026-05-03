// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for agent management commands.
 *
 * Verifies command registration, subcommand structure, options,
 * and error handling for the agent command group.
 */

import { Command } from "commander";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAgentCommand } from "./agent.js";

// Mock the RPC client so the Phase 9 R7 tests can drive `agents.update`
// without spinning a daemon. Default returns success for set-oauth-profile;
// individual tests override per-call to assert error propagation.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(async (fn: (client: { call: (m: string, p: unknown) => Promise<unknown> }) => Promise<unknown>) => {
      // Default mock client: succeeds with a stub success payload.
      return fn({ call: async () => ({ updated: true }) });
    }),
  };
});

import { withClient } from "../client/rpc-client.js";
const mockWithClient = vi.mocked(withClient);

describe("registerAgentCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerAgentCommand(program);
  });

  it("registers the agent command group", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    expect(agentCmd).toBeDefined();
    expect(agentCmd!.description()).toBe("Agent management");
  });

  it("registers list subcommand with --format option", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const listCmd = agentCmd!.commands.find((c) => c.name() === "list");
    expect(listCmd).toBeDefined();
    expect(listCmd!.description()).toBe("List all configured agents");

    const formatOpt = listCmd!.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });

  it("registers create subcommand with name argument and options", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const createCmd = agentCmd!.commands.find((c) => c.name() === "create");
    expect(createCmd).toBeDefined();
    expect(createCmd!.description()).toBe("Create a new agent configuration");

    const providerOpt = createCmd!.options.find((o) => o.long === "--provider");
    expect(providerOpt).toBeDefined();
    const modelOpt = createCmd!.options.find((o) => o.long === "--model");
    expect(modelOpt).toBeDefined();
  });

  it("registers configure subcommand with name argument", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const configureCmd = agentCmd!.commands.find((c) => c.name() === "configure");
    expect(configureCmd).toBeDefined();
    expect(configureCmd!.description()).toBe("Update an existing agent's settings");
  });

  it("registers delete subcommand with --yes option", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const deleteCmd = agentCmd!.commands.find((c) => c.name() === "delete");
    expect(deleteCmd).toBeDefined();
    expect(deleteCmd!.description()).toBe("Delete an agent configuration");

    const yesOpt = deleteCmd!.options.find((o) => o.long === "--yes");
    expect(yesOpt).toBeDefined();
  });

  it("has all six subcommands under agent", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const subcommands = agentCmd!.commands.map((c) => c.name()).sort();
    expect(subcommands).toEqual([
      "configure",
      "create",
      "delete",
      "list",
      "models",
      "set-oauth-profile",
    ]);
  });

  it("shows help text for agent command", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const helpText = agentCmd!.helpInformation();
    expect(helpText).toContain("agent");
    expect(helpText).toContain("list");
    expect(helpText).toContain("create");
    expect(helpText).toContain("configure");
    expect(helpText).toContain("delete");
  });
});

describe("agent list error handling", () => {
  it("handles daemon not running gracefully", async () => {
    const program = new Command();
    program.exitOverride();
    registerAgentCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "agent", "list"]);
    } catch (e) {
      // Expected: daemon not running causes process.exit
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Failed to list agents");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("agent configure validation", () => {
  it("warns when no options are specified", async () => {
    const program = new Command();
    program.exitOverride();
    registerAgentCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "agent", "configure", "my-agent"]);
      // Should reach here without process.exit (it's just a warning)
      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toContain("No settings specified");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("agent delete confirmation", () => {
  it("requires --yes flag in non-TTY mode", async () => {
    const program = new Command();
    program.exitOverride();
    registerAgentCommand(program);

    // Simulate non-TTY (stdin.isTTY is undefined in test environment)
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "agent", "delete", "test-agent"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Confirmation required");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 9 R7: agent set-oauth-profile <agentId> <profileId>
//
// Six tests covering: subcommand existence + description, malformed-profile
// rejection (exit 2), valid-input RPC call shape, "not found" daemon error
// (exit 1), generic daemon error (exit 1), and the updated subcommands
// roster (covered above in the registerAgentCommand block).
// ---------------------------------------------------------------------------

describe("agent set-oauth-profile (Phase 9 R7)", () => {
  let program: Command;

  beforeEach(() => {
    mockWithClient.mockReset();
    // Default mock: success path. Per-test overrides for error scenarios.
    mockWithClient.mockImplementation(async (fn) =>
      fn({ call: async () => ({ updated: true }) } as never),
    );
    program = new Command();
    program.exitOverride();
    registerAgentCommand(program);
  });

  it("registers the set-oauth-profile subcommand with the documented description", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const sub = agentCmd!.commands.find((c) => c.name() === "set-oauth-profile");
    expect(sub).toBeDefined();
    expect(sub!.description()).toContain("OAuth profile preference");
    expect(sub!.description()).toContain("provider derived from profile-id");
  });

  it("rejects malformed profile-id (no colon) with exit 2 and an explanatory stderr", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      await program.parseAsync([
        "node",
        "test",
        "agent",
        "set-oauth-profile",
        "my-agent",
        "no-colon",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("exit:2");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toMatch(/Invalid profile ID/i);
      expect(errOutput).toMatch(/<provider>:<identity>/);
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
    // RPC must NOT have been called for malformed input.
    expect(mockWithClient).not.toHaveBeenCalled();
  });

  it("sends agents.update RPC with the oauthProfiles patch on valid input", async () => {
    const callSpy = vi.fn(async () => ({ updated: true }));
    mockWithClient.mockImplementationOnce(async (fn) =>
      fn({ call: callSpy } as never),
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync([
        "node",
        "test",
        "agent",
        "set-oauth-profile",
        "my-agent",
        "openai-codex:work@example.com",
      ]);
    } finally {
      consoleSpy.mockRestore();
    }

    expect(callSpy).toHaveBeenCalledWith("agents.update", {
      agentId: "my-agent",
      config: {
        oauthProfiles: { "openai-codex": "openai-codex:work@example.com" },
      },
    });
  });

  it("exits 1 with the daemon error message when profile not found", async () => {
    mockWithClient.mockImplementationOnce(async () => {
      throw new Error(
        'profile openai-codex:nope@example.com not found in store. Run "comis auth list" to see available profiles.',
      );
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      await program.parseAsync([
        "node",
        "test",
        "agent",
        "set-oauth-profile",
        "my-agent",
        "openai-codex:nope@example.com",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("exit:1");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("not found in store");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("exits 1 with 'Failed to set oauth profile:' prefix on a generic daemon error", async () => {
    mockWithClient.mockImplementationOnce(async () => {
      throw new Error("Internal server error");
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      await program.parseAsync([
        "node",
        "test",
        "agent",
        "set-oauth-profile",
        "my-agent",
        "openai-codex:work@example.com",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("exit:1");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Failed to set oauth profile");
      expect(errOutput).toContain("Internal server error");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
