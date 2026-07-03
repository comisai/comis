// SPDX-License-Identifier: Apache-2.0
/**
 * Status command behavior tests.
 *
 * Tests status displays daemon/gateway/channels/agents
 * overview in table format, outputs valid JSON, handles daemon offline, empty
 * config, uptime formatting edge cases, and individual RPC failures.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock withClient from rpc-client at module level for ESM hoisting.
// Use vi.importActual to keep `callTyped` WIRED — status.ts's
// `gateway.status` call goes through callTyped, so the wrapper needs to
// pass through to the mocked `client.call`. Pattern mirrors
// `config-behavior.test.ts` (vi.importActual hybrid mock).
vi.mock("../client/rpc-client.js", async () => {
  const actual = await vi.importActual<typeof import("../client/rpc-client.js")>(
    "../client/rpc-client.js",
  );
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

// Dynamic imports after mocks
const { registerStatusCommand } = await import("./status.js");
const { withClient } = await import("../client/rpc-client.js");

// ── Test data ────────────────────────────────────────────────────────────

// GatewayStatusContract.response = { pid, uptime, memoryUsage, nodeVersion,
// configPaths, sections, secretsStoreAvailable }. The status CLI displays
// uptime/pid/nodeVersion; the rest are not displayed but are required by
// the contract so the always-on response.parse passes through.
const PROCESS_DATA = {
  pid: 12345,
  uptime: 3661,
  memoryUsage: 0,
  nodeVersion: "6.0.0",
  configPaths: [],
  sections: [],
  secretsStoreAvailable: true,
};
const GATEWAY_CONFIG = { host: "localhost", port: 3100, connections: 5 };
const CHANNELS_DATA = { telegram: { enabled: true }, discord: { enabled: false } };
const AGENTS_DATA = {
  agents: {
    assistant: {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      bindings: ["channel:discord-main"],
    },
    moderator: {
      provider: "openai",
      model: "gpt-4o",
    },
  },
};

/**
 * Helper to set up the spy client with configurable per-method responses.
 *
 * Partial `"gateway.status"` overrides are merged into the full PROCESS_DATA
 * defaults so always-on response.parse (GatewayStatusContract) sees a
 * contract-complete shape — callers only need to specify the fields the
 * specific test cares about (uptime/pid/nodeVersion).
 */
function setupSpyClient(overrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const gatewayStatusOverride = overrides["gateway.status"] as Record<string, unknown> | undefined;
  const mergedGatewayStatus = gatewayStatusOverride
    ? { ...PROCESS_DATA, ...gatewayStatusOverride }
    : PROCESS_DATA;

  const responses: Record<string, unknown> = {
    "gateway-config": GATEWAY_CONFIG,
    "channels": CHANNELS_DATA,
    "agents": AGENTS_DATA,
    ...overrides,
    "gateway.status": mergedGatewayStatus,
  };

  const callSpy = vi.fn();
  callSpy.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "gateway.status") return responses["gateway.status"];
    // status.ts calls the daemon's `config.read` method.
    if (method === "config.read") {
      const p = params as { section: string } | undefined;
      if (p?.section === "gateway") return responses["gateway-config"];
      if (p?.section === "channels") return responses["channels"];
      if (p?.section === "agents") return responses["agents"];
    }
    throw new Error(`Unexpected RPC call: ${method}`);
  });

  vi.mocked(withClient).mockImplementation(async (fn) => {
    return fn({ call: callSpy, close: vi.fn() });
  });

  return callSpy;
}

// ── status displays overview in table format ────────────────────

describe("status displays overview in table format", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    setupSpyClient();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays daemon section with status, uptime, and PID", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);

    // Daemon section header
    expect(output).toContain("Daemon");
    // Daemon status
    expect(output).toContain("online");
    // Formatted uptime from 3661 seconds = 1h 1m
    expect(output).toContain("1h 1m");
    // PID
    expect(output).toContain("12345");
    // NOTE: the daemon's version is exposed via `nodeVersion` in
    // GatewayStatusContract, but status.ts checks `details["version"]` —
    // a known mismatch. The CLI does not
    // display the daemon version today, so no assertion is made.
  });

  it("displays gateway section with status, address, and connections", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);

    // Gateway section header
    expect(output).toContain("Gateway");
    // Address
    expect(output).toContain("localhost:3100");
    // Connections
    expect(output).toContain("5");
  });

  it("displays channels table with telegram and discord", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);

    // Channels section header
    expect(output).toContain("Channels");
    // Channel types
    expect(output).toContain("telegram");
    expect(output).toContain("discord");
  });

  it("displays agents table with names, providers, and models", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);

    // Agents section header
    expect(output).toContain("Agents");
    // Agent names
    expect(output).toContain("assistant");
    expect(output).toContain("moderator");
    // Providers
    expect(output).toContain("anthropic");
    // Models
    expect(output).toContain("claude-sonnet-4-5-20250929");
  });
});

// ── status --format json outputs valid JSON ─────────────────────

describe("status --format json outputs valid JSON", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    setupSpyClient();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON with daemon, gateway, channels, and agents sections", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const result = JSON.parse(output) as Record<string, unknown>;

    // Top-level sections exist
    expect(result).toHaveProperty("daemon");
    expect(result).toHaveProperty("gateway");
    expect(result).toHaveProperty("channels");
    expect(result).toHaveProperty("agents");
  });

  it("includes correct daemon status and details in JSON", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const result = JSON.parse(output) as {
      daemon: { status: string; details: Record<string, unknown> };
    };

    expect(result.daemon.status).toBe("online");
    expect(result.daemon.details.uptime).toBe(3661);
  });

  it("includes correct gateway status in JSON", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const result = JSON.parse(output) as {
      gateway: { status: string };
    };

    expect(result.gateway.status).toBe("online");
  });

  it("includes channels and agents arrays in JSON", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const result = JSON.parse(output) as {
      channels: Array<{ type: string }>;
      agents: Array<{ name: string; provider: string }>;
    };

    expect(result.channels).toHaveLength(2);
    expect(result.agents).toHaveLength(2);
    expect(result.agents.find((a) => a.name === "assistant")?.provider).toBe("anthropic");
  });
});

// ── status handles daemon offline ───────────────────────────────

describe("status handles daemon offline", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Simulate daemon not running -- withClient itself rejects
    vi.mocked(withClient).mockRejectedValue(new Error("Daemon not running"));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows daemon offline and gateway unknown when daemon is unreachable", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("offline");
    expect(output).toContain("unknown");
  });

  it("does NOT call process.exit on offline -- graceful degradation", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// ── status handles empty channels and agents ───────────────────

describe("status handles empty channels and agents", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    setupSpyClient({
      "gateway.status": { uptime: 60, pid: 111 },
      "gateway-config": { enabled: false },
      "channels": {},
      "agents": { agents: {} },
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows empty state messages for channels and agents", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No channels configured");
    expect(output).toContain("No agents configured");
  });
});

// ── status formatUptime edge cases ─────────────────────────────

describe("status formatUptime edge cases", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("formats uptime < 60 seconds as Ns", async () => {
    setupSpyClient({
      "gateway.status": { uptime: 45, pid: 100 },
      "gateway-config": { enabled: false },
      "channels": {},
      "agents": { agents: {} },
    });

    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("45s");
  });

  it("formats uptime 120-3599 seconds as Nm Ns", async () => {
    setupSpyClient({
      "gateway.status": { uptime: 125, pid: 100 },
      "gateway-config": { enabled: false },
      "channels": {},
      "agents": { agents: {} },
    });

    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("2m 5s");
  });
});

// ── status handles individual RPC failures gracefully ──────────

describe("status handles individual RPC failures gracefully", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // gateway.status succeeds but config.get calls throw.
    // gateway.status response must satisfy GatewayStatusContract (always-on
    // parse) — provide all required fields, not just the partial subset.
    const callSpy = vi.fn();
    callSpy.mockImplementation(async (method: string) => {
      if (method === "gateway.status") {
        return {
          pid: 123,
          uptime: 100,
          memoryUsage: 0,
          nodeVersion: "test",
          configPaths: [],
          sections: [],
          secretsStoreAvailable: true,
        };
      }
      throw new Error("Method not found");
    });
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("still shows daemon online when other RPCs fail", async () => {
    const program = createTestProgram();
    registerStatusCommand(program);

    await program.parseAsync(["node", "test", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    // Daemon should still show as online
    expect(output).toContain("online");
    // Gateway falls back to unknown
    expect(output).toContain("unknown");
  });
});
