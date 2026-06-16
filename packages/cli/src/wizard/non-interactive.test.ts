// SPDX-License-Identifier: Apache-2.0
/**
 * Comprehensive tests for non-interactive mode.
 *
 * Covers:
 * - validateNonInteractiveOptions: all error conditions, field names, and valid paths
 * - buildNonInteractiveState: all defaults, overrides, flag combinations
 * - NonInteractivePrompter: all methods, quiet/non-quiet modes
 * - NonInteractiveError: class properties
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Stub the two @comis/core entry points the wizard's non-interactive path
// touches: safePath (filesystem composition) + createModelCatalog (model
// validation). Tests that need a specific catalog response override this
// mock per-test via
// `vi.mocked(createModelCatalog).mockReturnValueOnce(...)`. We do NOT call
// `importOriginal()` because @comis/core's real barrel transitively imports
// node:os/node:fs/promises — the node:os mock below stubs only `homedir`
// (and pulling the full module would break unrelated workspace helpers).
vi.mock("@comis/core", () => ({
  safePath: vi.fn((...parts: string[]) => parts.join("/")),
  writeMasterKeyIfAbsent: vi.fn(() => ({
    written: true,
    path: "/home/test/.comis/.env",
    keyHex: "f".repeat(64),
  })),
  createModelCatalog: vi.fn(() => ({
    loadStatic: vi.fn(),
    getAll: vi.fn(() => [
      { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "google", modelId: "gemini-2.0-flash" },
      { provider: "groq", modelId: "llama-3.3-70b-versatile" },
    ]),
    get: vi.fn(),
    getByProvider: vi.fn(),
    mergeScanned: vi.fn(),
    getProviders: vi.fn(),
  })),
}));
vi.mock("node:os", () => ({ homedir: vi.fn(() => "/home/test") }));
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "ab".repeat(24) })),
}));

import { writeMasterKeyIfAbsent } from "@comis/core";
import {
  validateNonInteractiveOptions,
  buildNonInteractiveState,
  NonInteractivePrompter,
  NonInteractiveError,
} from "./non-interactive.js";
import type { NonInteractiveOptions } from "./non-interactive.js";

// ---------- Helpers ----------

/** Build a minimal valid options set that passes validation. */
function validOpts(overrides?: Partial<NonInteractiveOptions>): NonInteractiveOptions {
  return {
    nonInteractive: true,
    acceptRisk: true,
    provider: "anthropic",
    apiKey: "sk-ant-test-key",
    ...overrides,
  };
}

// ==========================================================================
// validateNonInteractiveOptions
// ==========================================================================

describe("validateNonInteractiveOptions", () => {
  it("throws NonInteractiveError with field 'acceptRisk' when acceptRisk=false", () => {
    const opts = validOpts({ acceptRisk: false });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("acceptRisk");
    }
  });

  it("throws NonInteractiveError with field 'provider' when provider is missing", () => {
    const opts = validOpts({ provider: undefined });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("provider");
    }
  });

  it("throws NonInteractiveError with field 'provider' when provider is empty string", () => {
    const opts = validOpts({ provider: "" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("provider");
    }
  });

  it("throws NonInteractiveError with field 'gatewayPort' when port is invalid", () => {
    const opts = validOpts({ gatewayPort: 80 });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("gatewayPort");
    }
  });

  it("throws NonInteractiveError with field 'agentName' when agent name is invalid", () => {
    const opts = validOpts({ agentName: "-bad" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("agentName");
    }
  });

  it("throws NonInteractiveError with field 'resetScope' when resetScope set without reset=true", () => {
    const opts = validOpts({ resetScope: "full" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("resetScope");
    }
  });

  it("throws NonInteractiveError for missing telegram token", () => {
    const opts = validOpts({ channels: ["telegram"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("telegramToken");
    }
  });

  it("throws NonInteractiveError for missing discord token", () => {
    const opts = validOpts({ channels: ["discord"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("discordToken");
    }
  });

  it("throws NonInteractiveError for missing slack bot token", () => {
    const opts = validOpts({ channels: ["slack"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("slackBotToken");
    }
  });

  it("throws NonInteractiveError for missing slack app token when bot token present", () => {
    const opts = validOpts({ channels: ["slack"], slackBotToken: "xoxb-test" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("slackAppToken");
    }
  });

  it("throws NonInteractiveError for missing line token", () => {
    const opts = validOpts({ channels: ["line"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("lineToken");
    }
  });

  it("throws NonInteractiveError for missing line secret when token present", () => {
    const opts = validOpts({ channels: ["line"], lineToken: "line-tok" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("lineSecret");
    }
  });

  it("does NOT throw for whatsapp, signal, or irc channels (no tokens needed)", () => {
    const opts = validOpts({ channels: ["whatsapp", "signal", "irc"] });
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
  });

  it("does NOT throw when all required flags are valid", () => {
    const opts = validOpts({
      gatewayPort: 9443,
      agentName: "my-agent",
      channels: ["telegram"],
      telegramToken: "123:ABC",
    });
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
  });

  it("does NOT throw for unknown provider (forward compatibility)", () => {
    const opts = validOpts({ provider: "future-provider-xyz" });
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
  });

  // ---------- C2-C4: soft-warn validation regression tests ----------

  it("C2: emits a console.warn for unknown providers (no throw)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const opts = validOpts({ provider: "fake-provider-xyz" });
      expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledOnce();
      const warnMsg = warnSpy.mock.calls[0][0] as string;
      expect(warnMsg).toContain("fake-provider-xyz");
      expect(warnMsg).toContain("not in the pi-ai catalog");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("C3: validation passes silently for catalog providers (no warn)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const opts = validOpts({ provider: "anthropic" });
      expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("C3b: 'custom' provider passes silently (synthetic, never warns)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const opts = validOpts({ provider: "custom" });
      expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("C4: RECOMMENDED_MODELS does not appear in non-interactive.ts source", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "non-interactive.ts"), "utf-8");
    expect(src).not.toMatch(/RECOMMENDED_MODELS/);
  });

  // ---------- openai-codex non-interactive rejection ----------

  it("rejects --provider openai-codex with the literal interactive-login hint", () => {
    const opts: NonInteractiveOptions = {
      nonInteractive: true,
      acceptRisk: true,
      provider: "openai-codex",
    };
    expect(() => validateNonInteractiveOptions(opts)).toThrow(
      NonInteractiveError,
    );
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect(e).toBeInstanceOf(NonInteractiveError);
      const err = e as NonInteractiveError;
      expect(err.field).toBe("provider");
      expect(err.message).toBe(
        "openai-codex requires interactive login; run `comis init` interactively or run `comis auth login --provider openai-codex --method device-code` separately.",
      );
    }
  });

  it("accepts other providers (smoke check the gate is not too broad)", () => {
    const opts: NonInteractiveOptions = {
      nonInteractive: true,
      acceptRisk: true,
      provider: "anthropic",
      apiKey: "sk-ant-api03-test-key-1234567890",
    };
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
  });

  it("rejects an unknown --video-provider (closed config vocabulary)", () => {
    const opts = validOpts({ videoProvider: "runway" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("videoProvider");
    }
  });

  it("accepts each valid --video-provider value", () => {
    for (const id of ["auto", "fal", "google", "xai"]) {
      expect(() =>
        validateNonInteractiveOptions(validOpts({ videoProvider: id })),
      ).not.toThrow();
    }
  });

  it("rejects an unknown --image-provider (closed config vocabulary)", () => {
    const opts = validOpts({ imageProvider: "midjourney" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("imageProvider");
    }
  });

  it("accepts each valid --image-provider value", () => {
    for (const id of ["auto", "fal", "openai", "openai-codex", "google", "openrouter"]) {
      expect(() =>
        validateNonInteractiveOptions(validOpts({ imageProvider: id })),
      ).not.toThrow();
    }
  });
});

// ==========================================================================
// buildNonInteractiveState
// ==========================================================================

describe("buildNonInteractiveState", () => {
  it("returns state with flow='advanced' by default", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.flow).toBe("advanced");
  });

  it("returns state with flow='quickstart' when quick=true", () => {
    const state = buildNonInteractiveState(validOpts({ quick: true }));
    expect(state.flow).toBe("quickstart");
  });

  it("builds provider config with id and apiKey", () => {
    const state = buildNonInteractiveState(validOpts({ provider: "openai", apiKey: "sk-test" }));
    expect(state.provider).toBeDefined();
    expect(state.provider!.id).toBe("openai");
    expect(state.provider!.apiKey).toBe("sk-test");
  });

  it("uses default agent name 'comis-agent' when not specified", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.agentName).toBe("comis-agent");
  });

  it("uses custom agent name when provided", () => {
    const state = buildNonInteractiveState(validOpts({ agentName: "my-bot" }));
    expect(state.agentName).toBe("my-bot");
  });

  it("delegates --model resolution to daemon when not specified", () => {
    // --model defaults to literal "default" (daemon-side resolution per
    // builtin-provider-guard.ts:45 catalog readback). The hardcoded
    // RECOMMENDED_MODELS provider->model lookup was removed; daemon
    // decides at runtime. Verify both providers behave the same.
    const stateA = buildNonInteractiveState(validOpts({ provider: "anthropic" }));
    expect(stateA.model).toBe("default");
    const stateB = buildNonInteractiveState(validOpts({ provider: "openai" }));
    expect(stateB.model).toBe("default");
  });

  it("uses custom model when opts.model is provided", () => {
    const state = buildNonInteractiveState(validOpts({ model: "custom-model-v2" }));
    expect(state.model).toBe("custom-model-v2");
  });

  it("defaults model to 'default' for unknown provider without model flag", () => {
    const state = buildNonInteractiveState(validOpts({ provider: "unknown-provider" }));
    expect(state.model).toBe("default");
  });

  it("uses gateway defaults: port=4766, bindMode='loopback' (token-only)", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.gateway).toBeDefined();
    expect(state.gateway!.port).toBe(4766);
    expect(state.gateway!.bindMode).toBe("loopback");
  });

  it("auto-generates token (48 hex chars) when no gatewayToken provided", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.gateway!.token).toBe("ab".repeat(24));
  });

  it("uses explicit gatewayToken when provided", () => {
    const state = buildNonInteractiveState(validOpts({ gatewayToken: "my-explicit-token" }));
    expect(state.gateway!.token).toBe("my-explicit-token");
  });

  it("buildNonInteractiveState never emits gateway.password even if gatewayPassword leaks in", () => {
    // Gateway password auth is removed entirely: the daemon's GatewayConfigSchema
    // is a z.strictObject with no `password` key, so emitting one FATAL-crash-loops
    // the daemon at boot. The wizard must be structurally incapable of emitting it,
    // even when stray gatewayAuth/gatewayPassword values are forced in (these fields
    // no longer exist on the type, hence the `as never` cast — this pins RUNTIME
    // behavior, not the type).
    const state = buildNonInteractiveState(
      validOpts({ gatewayPassword: "x", gatewayAuth: "password" } as never),
    );
    const gw = state.gateway as Record<string, unknown>;
    expect(gw.password).toBeUndefined();
    expect(gw.authMethod).toBeUndefined();
    // Token path stays fully intact.
    expect(gw.token).toBe("ab".repeat(24));
  });

  it("builds channels from opts.channels with correct types and tokens", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["telegram", "discord"],
        telegramToken: "tg-tok",
        discordToken: "dc-tok",
      }),
    );
    expect(state.channels).toHaveLength(2);
    expect(state.channels![0]).toEqual({
      type: "telegram",
      botToken: "tg-tok",
      validated: false,
    });
    expect(state.channels![1]).toEqual({
      type: "discord",
      botToken: "dc-tok",
      validated: false,
    });
  });

  it("builds slack channel with both bot and app tokens", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["slack"],
        slackBotToken: "xoxb-tok",
        slackAppToken: "xapp-tok",
      }),
    );
    expect(state.channels![0]).toEqual({
      type: "slack",
      botToken: "xoxb-tok",
      appToken: "xapp-tok",
      validated: false,
    });
  });

  it("builds line channel with token and secret", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["line"],
        lineToken: "line-tok",
        lineSecret: "line-sec",
      }),
    );
    expect(state.channels![0]).toEqual({
      type: "line",
      botToken: "line-tok",
      channelSecret: "line-sec",
      validated: false,
    });
  });

  it("builds tokenless channels (whatsapp, signal, irc) correctly", () => {
    const state = buildNonInteractiveState(
      validOpts({ channels: ["whatsapp", "signal", "irc"] }),
    );
    expect(state.channels).toHaveLength(3);
    expect(state.channels![0]).toEqual({ type: "whatsapp", validated: false });
    expect(state.channels![1]).toEqual({ type: "signal", validated: false });
    expect(state.channels![2]).toEqual({ type: "irc", validated: false });
  });

  it("omits image/video provider when the flags are not set", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.imageProvider).toBeUndefined();
    expect(state.videoProvider).toBeUndefined();
  });

  it("records auto image provider without a credential", () => {
    const state = buildNonInteractiveState(validOpts({ imageProvider: "auto" }));
    expect(state.imageProvider).toEqual({ provider: "auto" });
  });

  it("records openai-codex image provider without a credential (OAuth)", () => {
    const state = buildNonInteractiveState(validOpts({ imageProvider: "openai-codex" }));
    expect(state.imageProvider).toEqual({ provider: "openai-codex" });
  });

  it("reuses the main provider key for a matching openai image provider", () => {
    const state = buildNonInteractiveState(
      validOpts({ provider: "openai", apiKey: "sk-openai-main-123456", imageProvider: "openai" }),
    );
    expect(state.imageProvider).toEqual({ provider: "openai" });
  });

  it("uses --image-api-key for fal image generation", () => {
    const state = buildNonInteractiveState(
      validOpts({ imageProvider: "fal", imageApiKey: "fal-img-key-1234567890" }),
    );
    expect(state.imageProvider).toEqual({
      provider: "fal",
      apiKey: "fal-img-key-1234567890",
    });
  });

  it("records auto video provider without a credential", () => {
    const state = buildNonInteractiveState(validOpts({ videoProvider: "auto" }));
    expect(state.videoProvider).toEqual({ provider: "auto" });
  });

  it("reuses the main provider key for a matching google video provider", () => {
    const state = buildNonInteractiveState(
      validOpts({ provider: "google", apiKey: "AIza-main-1234567890", videoProvider: "google" }),
    );
    // CRED-01: no extra key — GOOGLE_API_KEY already covered by the main provider.
    expect(state.videoProvider).toEqual({ provider: "google" });
  });

  it("uses --video-api-key for fal", () => {
    const state = buildNonInteractiveState(
      validOpts({ videoProvider: "fal", videoApiKey: "fal-secret-key-1234567890" }),
    );
    expect(state.videoProvider).toEqual({
      provider: "fal",
      apiKey: "fal-secret-key-1234567890",
    });
  });

  it("defaults dataDir to homedir/.comis/data", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.dataDir).toBe("/home/test/.comis/data");
  });

  it("uses custom dataDir when provided", () => {
    const state = buildNonInteractiveState(validOpts({ dataDir: "/custom/data" }));
    expect(state.dataDir).toBe("/custom/data");
  });

  it("includes all interactive steps (incl. storage + tool/image/video-providers) in completedSteps", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.completedSteps).toEqual([
      "welcome",
      "detect-existing",
      "flow-select",
      "storage",
      "provider",
      "credentials",
      "agent",
      "channels",
      "gateway",
      "workspace",
      "tool-providers",
      "image-providers",
      "video-providers",
      "review",
    ]);
  });

  it("sets skipHealth from opts", () => {
    const stateWithSkip = buildNonInteractiveState(validOpts({ skipHealth: true }));
    expect(stateWithSkip.skipHealth).toBe(true);

    const stateWithoutSkip = buildNonInteractiveState(validOpts({ skipHealth: false }));
    expect(stateWithoutSkip.skipHealth).toBe(false);
  });

  it("sets existingConfigAction='fresh' and resetScope when reset=true", () => {
    const state = buildNonInteractiveState(
      validOpts({ reset: true, resetScope: "full" }),
    );
    expect(state.existingConfigAction).toBe("fresh");
    expect(state.resetScope).toBe("full");
  });

  it("defaults resetScope to 'config' when reset=true without explicit scope", () => {
    const state = buildNonInteractiveState(validOpts({ reset: true }));
    expect(state.resetScope).toBe("config");
  });

  it("sets existingConfigAction=undefined when reset is false", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.existingConfigAction).toBeUndefined();
    expect(state.resetScope).toBeUndefined();
  });

  it("sets riskAccepted=true", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.riskAccepted).toBe(true);
  });

  it("sets provider validated based on skipValidation", () => {
    const stateSkipped = buildNonInteractiveState(validOpts({ skipValidation: true }));
    expect(stateSkipped.provider!.validated).toBe(true);

    const stateNotSkipped = buildNonInteractiveState(validOpts({ skipValidation: false }));
    expect(stateNotSkipped.provider!.validated).toBe(false);
  });

  // ---------- storage mode default + headless master-key bootstrap ----------

  describe("storage mode", () => {
    beforeEach(() => {
      vi.mocked(writeMasterKeyIfAbsent).mockClear();
    });

    it("defaults storageMode to 'encrypted' and provisions the master key headless", () => {
      const state = buildNonInteractiveState(validOpts());
      expect(state.storageMode).toBe("encrypted");
      // The master key is provisioned at the CONFIG dir (~/.comis), NOT the
      // /data subdir.
      expect(writeMasterKeyIfAbsent).toHaveBeenCalledTimes(1);
      const dir = vi.mocked(writeMasterKeyIfAbsent).mock.calls[0][0];
      expect(dir).toBe("/home/test/.comis");
      expect(dir).not.toContain("/data");
    });

    it("--storage file opts out: storageMode 'file' and NO master-key write", () => {
      const state = buildNonInteractiveState(validOpts({ storage: "file" }));
      expect(state.storageMode).toBe("file");
      expect(writeMasterKeyIfAbsent).not.toHaveBeenCalled();
    });

    it("explicit --storage encrypted provisions the key", () => {
      const state = buildNonInteractiveState(validOpts({ storage: "encrypted" }));
      expect(state.storageMode).toBe("encrypted");
      expect(writeMasterKeyIfAbsent).toHaveBeenCalledTimes(1);
    });

    it("provisions the key at opts.configDir when set (still not /data)", () => {
      buildNonInteractiveState(validOpts({ configDir: "/custom/config" }));
      expect(writeMasterKeyIfAbsent).toHaveBeenCalledWith("/custom/config");
    });

    it("includes 'storage' in completedSteps so the runner skips the interactive step", () => {
      const state = buildNonInteractiveState(validOpts());
      expect(state.completedSteps).toContain("storage");
    });
  });
});

// ==========================================================================
// NonInteractivePrompter
// ==========================================================================

describe("NonInteractivePrompter", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("intro(), outro(), note() are no-ops (do not throw)", () => {
    const p = new NonInteractivePrompter(validOpts());
    expect(() => p.intro("test")).not.toThrow();
    expect(() => p.outro("test")).not.toThrow();
    expect(() => p.note("test", "title")).not.toThrow();
  });

  describe("select()", () => {
    it("returns 'yes' option when startDaemon=true for daemon start message", async () => {
      const p = new NonInteractivePrompter(validOpts({ startDaemon: true }));
      const result = await p.select({
        message: "Start the Comis daemon now?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      });
      expect(result).toBe("yes");
    });

    it("returns 'no' option when startDaemon=false for daemon start message", async () => {
      const p = new NonInteractivePrompter(validOpts({ startDaemon: false }));
      const result = await p.select({
        message: "Start the Comis daemon now?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      });
      expect(result).toBe("no");
    });

    // Regression: the "Daemon is already running…" restart prompt fell through
    // to the generic first-option fallback (= "restart"), so a plain
    // `comis init --non-interactive` (startDaemon defaults false) silently
    // stopped + respawned whatever daemon held the gateway port.
    it("returns 'no' for the restart prompt when startDaemon=false (does NOT restart)", async () => {
      const p = new NonInteractivePrompter(validOpts({ startDaemon: false }));
      const result = await p.select({
        message: "Daemon is already running. What would you like to do?",
        options: [
          { value: "restart", label: "Restart" },
          { value: "no", label: "Leave running" },
        ],
      });
      expect(result).toBe("no");
    });

    it("returns 'restart' for the restart prompt when startDaemon=true", async () => {
      const p = new NonInteractivePrompter(validOpts({ startDaemon: true }));
      const result = await p.select({
        message: "Daemon is already running. What would you like to do?",
        options: [
          { value: "restart", label: "Restart" },
          { value: "no", label: "Leave running" },
        ],
      });
      expect(result).toBe("restart");
    });

    it("returns initialValue if set for other prompts", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.select({
        message: "Choose something",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        initialValue: "b",
      });
      expect(result).toBe("b");
    });

    it("returns first option when no initialValue for other prompts", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.select({
        message: "Choose something",
        options: [
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ],
      });
      expect(result).toBe("first");
    });
  });

  describe("multiselect()", () => {
    it("returns initialValues if set", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.multiselect({
        message: "Select items",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
        ],
        initialValues: ["a", "c"],
      });
      expect(result).toEqual(["a", "c"]);
    });

    it("returns all options when no initialValues", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.multiselect({
        message: "Select items",
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      });
      expect(result).toEqual(["x", "y"]);
    });
  });

  describe("text()", () => {
    it("returns defaultValue when available", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.text({
        message: "Enter something",
        defaultValue: "my-default",
      });
      expect(result).toBe("my-default");
    });

    it("throws NonInteractiveError when no default", async () => {
      const p = new NonInteractivePrompter(validOpts());
      await expect(p.text({ message: "Enter something" })).rejects.toThrow(
        NonInteractiveError,
      );
    });
  });

  describe("password()", () => {
    it("always throws NonInteractiveError", async () => {
      const p = new NonInteractivePrompter(validOpts());
      await expect(p.password({ message: "Enter password" })).rejects.toThrow(
        NonInteractiveError,
      );
    });
  });

  describe("confirm()", () => {
    it("returns true for risk-related messages", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.confirm({ message: "Do you acknowledge the risk?" });
      expect(result).toBe(true);
    });

    it("returns false for shell completion messages", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.confirm({ message: "Enable shell completion?" });
      expect(result).toBe(false);
    });

    it("returns initialValue for other prompts when set", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.confirm({ message: "Some question?", initialValue: true });
      expect(result).toBe(true);
    });

    it("returns false for other prompts when no initialValue", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.confirm({ message: "Some question?" });
      expect(result).toBe(false);
    });
  });

  describe("spinner()", () => {
    it("returns no-op spinner in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      const s = p.spinner();
      expect(() => s.start("test")).not.toThrow();
      expect(() => s.update("test")).not.toThrow();
      expect(() => s.stop("test")).not.toThrow();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("writes to stderr in non-quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), false);
      const s = p.spinner();
      s.start("starting...");
      expect(stderrSpy).toHaveBeenCalledWith("  starting...\n");
      s.update("updating...");
      expect(stderrSpy).toHaveBeenCalledWith("  updating...\n");
      s.stop("done");
      expect(stderrSpy).toHaveBeenCalledWith("  done\n");
    });
  });

  describe("group()", () => {
    it("executes thunks sequentially and returns results", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.group({
        name: async () => "Alice",
        age: async () => 30,
      });
      expect(result).toEqual({ name: "Alice", age: 30 });
    });
  });

  describe("log", () => {
    it("error always writes to stderr even in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      p.log.error("something broke");
      expect(stderrSpy).toHaveBeenCalledWith("  ERROR: something broke\n");
    });

    it("info is a no-op in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      p.log.info("info message");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("warn is a no-op in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      p.log.warn("warning");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("success is a no-op in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      p.log.success("done");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("info writes to stderr in non-quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), false);
      p.log.info("some info");
      expect(stderrSpy).toHaveBeenCalledWith("  some info\n");
    });

    it("warn writes to stderr in non-quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), false);
      p.log.warn("a warning");
      expect(stderrSpy).toHaveBeenCalledWith("  WARN: a warning\n");
    });

    it("success writes to stderr in non-quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), false);
      p.log.success("yay");
      expect(stderrSpy).toHaveBeenCalledWith("  yay\n");
    });
  });
});

// ==========================================================================
// NonInteractiveError
// ==========================================================================

describe("NonInteractiveError", () => {
  it("has correct name 'NonInteractiveError'", () => {
    const err = new NonInteractiveError("test message", "testField");
    expect(err.name).toBe("NonInteractiveError");
  });

  it("has field property set", () => {
    const err = new NonInteractiveError("test", "myField");
    expect(err.field).toBe("myField");
  });

  it("preserves the provided message argument on the NonInteractiveError instance", () => {
    const err = new NonInteractiveError("something went wrong", "x");
    expect(err.message).toBe("something went wrong");
  });

  it("is an instance of Error", () => {
    const err = new NonInteractiveError("test", "field");
    expect(err).toBeInstanceOf(Error);
  });
});
