// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for write-config step (step 10).
 *
 * Verifies atomic config.yaml write (temp + rename), .env file generation,
 * data directory creation, secrets store integration, YAML validation,
 * and error handling. All external modules are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:os", () => {
  const homedir = vi.fn(() => "/home/test");
  return {
    homedir,
    default: { homedir },
  };
});

vi.mock("yaml", () => ({
  stringify: vi.fn((obj: unknown) => JSON.stringify(obj)),
  parse: vi.fn((s: string) => JSON.parse(s)),
}));

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: vi.fn((...parts: string[]) => parts.join("/")),
  };
});

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { writeConfigStep } from "./10-write-config.js";

// ---------- Mock Prompter Helper ----------

function createMockPrompter(
  responses: {
    select?: string[];
    confirm?: boolean[];
  } = {},
): WizardPrompter {
  const selectQueue = [...(responses.select ?? [])];
  const confirmQueue = [...(responses.confirm ?? [])];

  const mockSpinner: Spinner = {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async (opts) => opts.defaultValue ?? ""),
    select: vi.fn(async () => selectQueue.shift() ?? ""),
    multiselect: vi.fn(async () => []),
    password: vi.fn(async () => ""),
    confirm: vi.fn(async () => confirmQueue.shift() ?? false),
    spinner: vi.fn(() => mockSpinner),
    group: vi.fn(async (steps) => {
      const result: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(steps)) {
        result[key] = await (fn as () => Promise<unknown>)();
      }
      return result;
    }) as WizardPrompter["group"],
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
}

function populatedState(): WizardState {
  return {
    completedSteps: [],
    provider: { id: "anthropic", apiKey: "sk-test-key-123" },
    agentName: "test-agent",
    model: "claude-sonnet-4-5-20250929",
    channels: [{ type: "telegram", botToken: "123:ABC", validated: true }],
    gateway: {
      port: 4766,
      bindMode: "loopback",
      authMethod: "token",
      token: "test-token-value",
    },
    dataDir: "/home/test/.comis/data",
  };
}

// ---------- Tests ----------

describe("writeConfigStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("has correct step id and label", () => {
    expect(writeConfigStep.id).toBe("write-config");
    expect(writeConfigStep.label).toBe("Write Configuration");
  });

  it("atomic config write sequence: writeFileSync to temp, renameSync to final", async () => {
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    // writeFileSync should be called with temp path first
    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const tempWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(tempWriteCall).toBeDefined();

    // renameSync should be called to atomically move temp to final
    expect(renameSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.stringContaining("config.yaml"),
    );
  });

  it(".env file written with API key env var", async () => {
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    expect(envWriteCall).toBeDefined();

    // Content should contain ANTHROPIC_API_KEY
    const envContent = envWriteCall![1] as string;
    expect(envContent).toContain("ANTHROPIC_API_KEY=sk-test-key-123");
  });

  it("data directory created when it does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    // mkdirSync should be called for the data directory
    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("data"),
      expect.objectContaining({ recursive: true }),
    );
  });

  it("channel env vars written to .env for configured channels", async () => {
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    expect(envWriteCall).toBeDefined();

    const envContent = envWriteCall![1] as string;
    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=123:ABC");
  });

  it("gateway token written to .env when token auth", async () => {
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    expect(envWriteCall).toBeDefined();

    const envContent = envWriteCall![1] as string;
    expect(envContent).toContain("COMIS_GATEWAY_TOKEN=test-token-value");
  });

  it("secrets store offer shown when secrets.db exists", async () => {
    // First call (secrets.db check) returns true, second call (dataDir check) returns false
    vi.mocked(existsSync)
      .mockReturnValueOnce(true)  // secrets.db exists
      .mockReturnValue(false);    // dataDir doesn't exist

    const prompter = createMockPrompter({
      select: ["env"],  // user declines secrets store
    });

    await writeConfigStep.execute(populatedState(), prompter);

    // select should have been called for secrets store choice
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("secrets store"),
      }),
    );
  });

  it("no secrets store prompt when secrets.db does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    // select should NOT have been called (no secrets store prompt)
    expect(prompter.select).not.toHaveBeenCalled();
  });

  it("step returns state unchanged", async () => {
    const state = populatedState();
    const prompter = createMockPrompter();

    const result = await writeConfigStep.execute(state, prompter);

    expect(result.agentName).toBe("test-agent");
    expect(result.provider?.id).toBe("anthropic");
    expect(result.gateway).toBeDefined();
  });

  it("config directory created with restricted permissions", async () => {
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    // mkdirSync should be called for config directory with mode 0o700
    expect(mkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recursive: true, mode: 0o700 }),
    );
  });

  it("spinner lifecycle: start -> update -> stop", async () => {
    const prompter = createMockPrompter();
    const spinner = prompter.spinner();

    await writeConfigStep.execute(populatedState(), prompter);

    expect(spinner.start).toHaveBeenCalled();
    expect(spinner.stop).toHaveBeenCalledWith(
      expect.stringContaining("success"),
    );
  });

  it(".env file written with 0o600 permissions", async () => {
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    expect(envWriteCall).toBeDefined();

    // Should have mode: 0o600 in options
    const opts = envWriteCall![2] as { mode: number };
    expect(opts.mode).toBe(0o600);
  });

  it("secrets store mode writes placeholder .env", async () => {
    vi.mocked(existsSync)
      .mockReturnValueOnce(true)  // secrets.db exists
      .mockReturnValue(false);

    const prompter = createMockPrompter({
      select: ["secrets"],  // user accepts secrets store
    });

    await writeConfigStep.execute(populatedState(), prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    expect(envWriteCall).toBeDefined();

    const envContent = envWriteCall![1] as string;
    expect(envContent).toContain("secrets store");
    // Should NOT contain actual API key
    expect(envContent).not.toContain("sk-test-key-123");
  });

  it("includes elevatedReply in config when senderTrustEntries present", async () => {
    const state: WizardState = {
      ...populatedState(),
      senderTrustEntries: [{ senderId: "12345", level: "admin" }],
    };
    const prompter = createMockPrompter();

    await writeConfigStep.execute(state, prompter);

    // Find the config.yaml temp write
    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();

    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.agents.default.elevatedReply).toEqual({
      enabled: true,
      senderTrustMap: { "12345": "admin" },
    });
  });

  it("omits elevatedReply when no senderTrustEntries", async () => {
    const state = populatedState(); // no senderTrustEntries
    const prompter = createMockPrompter();

    await writeConfigStep.execute(state, prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();

    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.agents.default.elevatedReply).toBeUndefined();
  });

  it("gateway password auth writes password env var", async () => {
    const state: WizardState = {
      ...populatedState(),
      gateway: {
        port: 4766,
        bindMode: "loopback",
        authMethod: "password",
        password: "my-secret-password",
      },
    };
    const prompter = createMockPrompter();

    await writeConfigStep.execute(state, prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    expect(envWriteCall).toBeDefined();

    const envContent = envWriteCall![1] as string;
    expect(envContent).toContain("COMIS_GATEWAY_PASSWORD=my-secret-password");
  });
});
