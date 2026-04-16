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

// Mock withClient from rpc-client at module level for ESM hoisting
vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

// Dynamic imports after mocks
const { registerStatusCommand } = await import("./status.js");
const { withClient } = await import("../client/rpc-client.js");

// ── Test data ────────────────────────────────────────────────────────────

const PROCESS_DATA = { uptime: 3661, pid: 12345, version: "6.0.0" };
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
 */
function setupSpyClient(overrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const responses: Record<string, unknown> = {
    "gateway.status": PROCESS_DATA,
    "gateway-config": GATEWAY_CONFIG,
    "channels": CHANNELS_DATA,
    "agents": AGENTS_DATA,
    ...overrides,
  };

  const callSpy = vi.fn();
  callSpy.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "gateway.status") return responses["gateway.status"];
    if (method === "config.get") {
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

  it("displays daemon section with status, uptime, PID, and version", async () => {
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
    // Version
    expect(output).toContain("6.0.0");
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

    // gateway.status succeeds but config.get calls throw
    const callSpy = vi.fn();
    callSpy.mockImplementation(async (method: string) => {
      if (method === "gateway.status") return { uptime: 100, pid: 123 };
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
