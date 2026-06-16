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
    loadEnvFile: vi.fn(),
  };
});

vi.mock("../../util/offline-secrets-store.js", () => ({
  offlineSecretSet: vi.fn(() => ({ ok: true, value: undefined })),
}));

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { loadEnvFile } from "@comis/core";
import { offlineSecretSet } from "../../util/offline-secrets-store.js";
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

  it("never prompts for a storage choice (the storage prompt moved to step 02b)", async () => {
    // The secrets.db-gated "Your secrets store is active…" select was removed:
    // storage mode is now driven by state.storageMode (set by step 02b), so
    // step 10 never prompts — even when secrets.db exists on disk.
    vi.mocked(existsSync).mockReturnValue(true); // secrets.db + everything "exists"
    const prompter = createMockPrompter();

    await writeConfigStep.execute(
      { ...populatedState(), storageMode: "encrypted" },
      prompter,
    );

    expect(prompter.select).not.toHaveBeenCalled();
  });

  it("uses the encrypted secrets-store path regardless of whether secrets.db already exists", async () => {
    // storageMode="encrypted" drives the store path even when existsSync is
    // false for secrets.db (the old code gated this on the file existing).
    vi.mocked(existsSync).mockReturnValue(false);
    const prompter = createMockPrompter();

    await writeConfigStep.execute(
      { ...populatedState(), storageMode: "encrypted" },
      prompter,
    );

    expect(offlineSecretSet).toHaveBeenCalled();
    expect(prompter.select).not.toHaveBeenCalled();
  });

  it("writes logLevel: debug as the default into config.yaml", async () => {
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();

    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.logLevel).toBe("debug");
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

  it("secrets store mode (storageMode=encrypted) writes placeholder .env", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const prompter = createMockPrompter();

    await writeConfigStep.execute(
      { ...populatedState(), storageMode: "encrypted" },
      prompter,
    );

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

  // ---------- security.storage emission into config.yaml ----------

  it("emits security.storage=encrypted into config.yaml when storageMode is encrypted", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const prompter = createMockPrompter();

    await writeConfigStep.execute(
      { ...populatedState(), storageMode: "encrypted" },
      prompter,
    );

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.security).toEqual({ storage: "encrypted" });
  });

  it("emits security.storage=file into config.yaml when storageMode is file", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const prompter = createMockPrompter();

    await writeConfigStep.execute(
      { ...populatedState(), storageMode: "file" },
      prompter,
    );

    // Plaintext path: offlineSecretSet must NOT run, plaintext key in .env.
    expect(offlineSecretSet).not.toHaveBeenCalled();

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.security).toEqual({ storage: "file" });

    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    const envContent = envWriteCall![1] as string;
    expect(envContent).toContain("ANTHROPIC_API_KEY=sk-test-key-123");
  });

  it("omits security from config.yaml when storageMode is unset", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.security).toBeUndefined();
  });

  // ---------- video generation provider emission ----------

  it("emits integrations.media.videoGeneration.provider when videoProvider is set", async () => {
    const state: WizardState = {
      ...populatedState(),
      videoProvider: { provider: "google" },
    };
    const prompter = createMockPrompter();

    await writeConfigStep.execute(state, prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();

    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.integrations.media.videoGeneration.provider).toBe("google");
  });

  it("emits integrations.media.imageGeneration.provider when imageProvider is set", async () => {
    const state: WizardState = {
      ...populatedState(),
      imageProvider: { provider: "openrouter" },
    };
    const prompter = createMockPrompter();

    await writeConfigStep.execute(state, prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.integrations.media.imageGeneration.provider).toBe("openrouter");
  });

  it("emits BOTH image and video generation under integrations.media when both are set", async () => {
    const state: WizardState = {
      ...populatedState(),
      imageProvider: { provider: "fal", apiKey: "fal-img-key-123456" },
      videoProvider: { provider: "google" },
    };
    const prompter = createMockPrompter();

    await writeConfigStep.execute(state, prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.integrations.media.imageGeneration.provider).toBe("fal");
    expect(configContent.integrations.media.videoGeneration.provider).toBe("google");
  });

  it("writes the FAL_KEY image credential to .env when imageProvider is fal", async () => {
    const state: WizardState = {
      ...populatedState(),
      imageProvider: { provider: "fal", apiKey: "fal-img-secret-7890" },
    };
    const prompter = createMockPrompter();

    await writeConfigStep.execute(state, prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    const envContent = envWriteCall![1] as string;
    expect(envContent).toContain("FAL_KEY=fal-img-secret-7890");
  });

  it("omits integrations from config.yaml when no media provider is set", async () => {
    const prompter = createMockPrompter();

    await writeConfigStep.execute(populatedState(), prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.integrations).toBeUndefined();
  });

  it("writes the FAL_KEY video credential to .env when videoProvider is fal", async () => {
    const state: WizardState = {
      ...populatedState(),
      videoProvider: { provider: "fal", apiKey: "fal-secret-key-123456" },
    };
    const prompter = createMockPrompter();

    await writeConfigStep.execute(state, prompter);

    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const envWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    expect(envWriteCall).toBeDefined();
    const envContent = envWriteCall![1] as string;
    expect(envContent).toContain("FAL_KEY=fal-secret-key-123456");
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

  // ---------- oauthProfiles emission + openai-codex defaults ----------

  it("emits oauthProfiles on agent config when state.provider.oauthProfileId is set", async () => {
    const state: WizardState = {
      ...populatedState(),
      provider: {
        id: "openai-codex",
        authMethod: "oauth",
        apiKey: "test_access_token",
        oauthProfileId: "openai-codex:user_a@example.com",
        validated: true,
      },
    };
    const prompter = createMockPrompter();
    await writeConfigStep.execute(state, prompter);
    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.agents.default.oauthProfiles).toEqual({
      "openai-codex": "openai-codex:user_a@example.com",
    });
  });

  it("omits oauthProfiles when no oauthProfileId on state.provider", async () => {
    const prompter = createMockPrompter();
    await writeConfigStep.execute(populatedState(), prompter);
    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.agents.default.oauthProfiles).toBeUndefined();
  });

  it("openai-codex provider skips OPENAI_API_KEY env line (no PROVIDER_ENV_KEYS entry)", async () => {
    const state: WizardState = {
      ...populatedState(),
      provider: {
        id: "openai-codex",
        authMethod: "oauth",
        apiKey: "test_access_token",
        oauthProfileId: "openai-codex:user_a@example.com",
        validated: true,
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
    expect(envContent).not.toContain("OPENAI_API_KEY=");
    expect(envContent).not.toContain("test_access_token");
  });

  it("openai-codex default model is 'gpt-5.1' when state.model unset", async () => {
    const state: WizardState = {
      ...populatedState(),
      provider: {
        id: "openai-codex",
        authMethod: "oauth",
        apiKey: "test_access_token",
        oauthProfileId: "openai-codex:user_a@example.com",
        validated: true,
      },
      model: undefined,
    };
    const prompter = createMockPrompter();
    await writeConfigStep.execute(state, prompter);
    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const configWriteCall = writeCalls.find(
      ([path]) => typeof path === "string" && path.includes(".tmp"),
    );
    expect(configWriteCall).toBeDefined();
    const configContent = JSON.parse(configWriteCall![1] as string);
    expect(configContent.agents.default.model).toBe("gpt-5.1");
  });

  // ---------- Regression: secrets-store mode must not clobber the master key ----------

  it("secrets store mode PRESERVES an existing SECRETS_MASTER_KEY (no encrypted-store clobber)", async () => {
    // Regression: the secrets-store branch used to overwrite .env with a
    // comment-only placeholder, dropping the daemon-generated SECRETS_MASTER_KEY.
    // The next boot regenerated a new key that no longer matched the already-
    // sealed secrets.db -> DECRYPTION_FAILED, and every stored secret was lost.
    vi.mocked(existsSync)
      .mockReturnValueOnce(true) // .env exists -> load existing keys
      .mockReturnValue(false); // dataDir, etc.
    vi.mocked(loadEnvFile).mockImplementation(
      (_path: string, env: Record<string, string | undefined>) => {
        env.SECRETS_MASTER_KEY = "a".repeat(64);
      },
    );
    const prompter = createMockPrompter();

    await writeConfigStep.execute(
      { ...populatedState(), storageMode: "encrypted" },
      prompter,
    );

    const envWriteCall = vi.mocked(writeFileSync).mock.calls.find(
      ([path]) => typeof path === "string" && path.includes(".env"),
    );
    expect(envWriteCall).toBeDefined();
    const envContent = envWriteCall![1] as string;
    // The pre-existing master key must survive (else the encrypted store is orphaned).
    expect(envContent).toContain(`SECRETS_MASTER_KEY=${"a".repeat(64)}`);
    // Still secrets-store mode: no plaintext API key leaked into .env.
    expect(envContent).not.toContain("sk-test-key-123");
  });

  // ---------- Root-cause fix: secrets-store mode must PERSIST collected secrets ----------

  describe("secrets-store mode persists collected secrets", () => {
    // storageMode="encrypted" drives the store path; nothing exists on disk.
    function encryptedState(): WizardState {
      vi.mocked(existsSync).mockReturnValue(false);
      return { ...populatedState(), storageMode: "encrypted" };
    }

    it("writes the collected gateway + channel secrets into the encrypted store", async () => {
      // Regression: the wizard used to emit ${COMIS_GATEWAY_TOKEN}/${TELEGRAM_BOT_TOKEN}
      // references but DISCARD the values it already had, then merely print
      // `comis secrets set …`. If the user never ran those, the daemon boots
      // against unresolvable ${VAR}s and FATAL-crash-loops.
      const prompter = createMockPrompter();

      await writeConfigStep.execute(encryptedState(), prompter);

      const calls = vi.mocked(offlineSecretSet).mock.calls.map((c) => c[0]);
      const byName = new Map(calls.map((o) => [o.name, o.value]));
      expect(byName.get("COMIS_GATEWAY_TOKEN")).toBe("test-token-value");
      expect(byName.get("TELEGRAM_BOT_TOKEN")).toBe("123:ABC");
      // Every write targets the ~/.comis store and reads the master key from .env.
      for (const o of calls) {
        expect(o.dataDir).toContain(".comis");
        expect(o.envFilePath).toContain(".env");
      }
    });

    it("does NOT touch the encrypted store in plaintext .env mode (storageMode=file)", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const prompter = createMockPrompter();

      await writeConfigStep.execute(
        { ...populatedState(), storageMode: "file" },
        prompter,
      );

      expect(offlineSecretSet).not.toHaveBeenCalled();
    });

    it("flags unresolved secret refs (and logs an error) when a store write fails", async () => {
      // Gateway token fails to persist -> ${COMIS_GATEWAY_TOKEN} stays unresolvable.
      vi.mocked(offlineSecretSet).mockImplementation((opts: { name: string }) =>
        opts.name === "COMIS_GATEWAY_TOKEN"
          ? { ok: false, error: new Error("store write failed") }
          : { ok: true, value: undefined },
      );
      const prompter = createMockPrompter();

      const result = await writeConfigStep.execute(encryptedState(), prompter);

      expect(result.unresolvedSecretRefs).toContain("COMIS_GATEWAY_TOKEN");
      expect(prompter.log.error).toHaveBeenCalled();
    });

    it("reports no unresolved refs on the happy path (storageMode=file)", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const prompter = createMockPrompter(); // file mode, all secrets present
      const result = await writeConfigStep.execute(
        { ...populatedState(), storageMode: "file" },
        prompter,
      );
      expect(result.unresolvedSecretRefs ?? []).toHaveLength(0);
    });
  });
});
