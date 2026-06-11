// SPDX-License-Identifier: Apache-2.0
/**
 * Channel status command behavior tests.
 *
 * Tests channel status: displays all configured
 * channels with name/type/status/details, outputs valid JSON with --format
 * json, handles all status variants (connected/disconnected/error/disabled),
 * handles daemon offline with exit code 1 and descriptive error, and shows
 * no-channels message for empty config. Uses mocked RPC layer.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockRpcClient } from "../mock-rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock withClient from rpc-client at module level for ESM hoisting.
// importOriginal-based mock so callTyped resolves to the real wrapper
// while withClient is mocked.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

// Mock withSpinner to pass-through (no actual ora spinner in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Dynamic imports after mocks
const { registerChannelCommand } = await import("./channel.js");
const { withClient } = await import("../client/rpc-client.js");

/**
 * Sample channel CONFIG section: what is configured/enabled. Live state
 * comes from channels.health, never from config (the old config-only read
 * reported a healthy live adapter as "disconnected" — 2026-06-12 C5 live
 * finding).
 */
const CHANNELS_DATA = {
  telegram: { enabled: true, botUsername: "mybot" },
  discord: { enabled: true, applicationId: "app-123" },
  slack: { enabled: true, teamId: "team-456" },
};

/**
 * Extended channel data that includes a disabled channel.
 */
const CHANNELS_DATA_WITH_DISABLED = {
  ...CHANNELS_DATA,
  whatsapp: { enabled: false },
};

/**
 * Live health entries: telegram healthy (running), slack errored,
 * discord ABSENT (enabled in config but adapter not running).
 */
function healthEntry(channelType: string, state: string, connectionMode: string) {
  return {
    channelType,
    state,
    connectionMode,
    lastCheckedAt: 1781220286856,
    lastMessageAt: null,
    error: null,
    stateChangedAt: 1781220166855,
    consecutiveFailures: 0,
    activeRuns: 0,
    restartAttempts: 0,
    uptimeMs: 264123,
  };
}

const HEALTH_DATA = {
  channels: [
    healthEntry("telegram", "healthy", "polling"),
    healthEntry("slack", "errored", "socket"),
  ],
  timestamp: 1781220310975,
  enabled: true,
};

// -- channel status displays all configured channels -----------------

describe("channel status displays all configured channels", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.read", CHANNELS_DATA)
        .onCall("channels.health", HEALTH_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays channel names, types, statuses, and details in table format", async () => {
    const program = createTestProgram();
    registerChannelCommand(program);

    await program.parseAsync(["node", "test", "channel", "status"]);

    const output = getSpyOutput(consoleSpy.log);

    // Capitalized channel names
    expect(output).toContain("Telegram");
    expect(output).toContain("Discord");
    expect(output).toContain("Slack");

    // Type column values
    expect(output).toContain("telegram");
    expect(output).toContain("discord");
    expect(output).toContain("slack");

    // Channel details
    expect(output).toContain("@mybot");
    expect(output).toContain("App: app-123");
    expect(output).toContain("Team: team-456");

    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- channel status --format json outputs valid JSON -----------------

describe("channel status --format json outputs valid JSON", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.read", CHANNELS_DATA)
        .onCall("channels.health", HEALTH_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON array of channel status objects", async () => {
    const program = createTestProgram();
    registerChannelCommand(program);

    await program.parseAsync(["node", "test", "channel", "status", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{
      name: string;
      type: string;
      status: string;
      details?: string;
    }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);

    // Each item has required properties
    for (const item of parsed) {
      expect(item).toHaveProperty("name");
      expect(item).toHaveProperty("type");
      expect(item).toHaveProperty("status");
    }

    // Verify specific channel data: status comes from the LIVE health
    // lens, never from config.
    const telegram = parsed.find((ch) => ch.type === "telegram");
    expect(telegram).toBeDefined();
    expect(telegram!.name).toBe("Telegram");
    expect(telegram!.status).toBe("healthy");
    expect(telegram!.details).toBe("@mybot, mode: polling");

    const discord = parsed.find((ch) => ch.type === "discord");
    expect(discord).toBeDefined();
    expect(discord!.status).toBe("not running");
    expect(discord!.details).toBe("App: app-123");

    const slack = parsed.find((ch) => ch.type === "slack");
    expect(slack).toBeDefined();
    expect(slack!.status).toBe("errored");
    expect(slack!.details).toBe("Team: team-456, mode: socket");

    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- channel status handles all status variants ----------------------

describe("channel status color-codes status", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.read", CHANNELS_DATA_WITH_DISABLED)
        .onCall("channels.health", HEALTH_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays all status variants: healthy, not running, errored, disabled", async () => {
    const program = createTestProgram();
    registerChannelCommand(program);

    await program.parseAsync(["node", "test", "channel", "status"]);

    const output = getSpyOutput(consoleSpy.log);

    // All four status strings should appear (chalk may or may not add ANSI codes)
    expect(output).toContain("healthy");
    expect(output).toContain("not running");
    expect(output).toContain("errored");
    expect(output).toContain("disabled");

    // Whatsapp should be present as a disabled channel
    expect(output).toContain("Whatsapp");

    expect(exitSpy.spy).not.toHaveBeenCalled();
  });

  it("outputs all four status variants in JSON format", async () => {
    const program = createTestProgram();
    registerChannelCommand(program);

    await program.parseAsync(["node", "test", "channel", "status", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{ name: string; status: string }>;

    expect(parsed).toHaveLength(4);

    const statuses = parsed.map((ch) => ch.status);
    expect(statuses).toContain("healthy");
    expect(statuses).toContain("not running");
    expect(statuses).toContain("errored");
    expect(statuses).toContain("disabled");
  });
});

// -- channel status handles daemon offline gracefully ----------------

describe("channel status handles daemon offline gracefully", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockRejectedValue(new Error("Daemon not running"));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerChannelCommand(program);

    try {
      await program.parseAsync(["node", "test", "channel", "status"]);
      expect.unreachable("Should have called process.exit");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to get channel status");
  });
});

// -- channel status shows no channels message -----------------------

describe("channel status shows no channels message", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.read", {})
        .onCall("channels.health", { channels: [], timestamp: 0, enabled: false })
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows no channels configured message for empty config", async () => {
    const program = createTestProgram();
    registerChannelCommand(program);

    await program.parseAsync(["node", "test", "channel", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No channels configured");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});
