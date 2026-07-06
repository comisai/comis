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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

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
// Override only homedir; keep the real tmpdir so the SA-key-path test can write
// a temp key file (node:fs is unmocked here).
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => "/home/test") };
});
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

  it("throws NonInteractiveError for missing msteams app id", () => {
    const opts = validOpts({ channels: ["msteams"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("msteamsAppId");
    }
  });

  it("throws NonInteractiveError for missing msteams app password when app id present", () => {
    const opts = validOpts({
      channels: ["msteams"],
      msteamsAppId: "11111111-1111-1111-1111-111111111111",
    });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("msteamsAppPassword");
    }
  });

  it("throws NonInteractiveError for missing msteams tenant id when app id + password present", () => {
    const opts = validOpts({
      channels: ["msteams"],
      msteamsAppId: "11111111-1111-1111-1111-111111111111",
      msteamsAppPassword: "teams-client-secret-value-xyz",
    });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("msteamsTenantId");
    }
  });

  it("does NOT throw when all required msteams flags are present", () => {
    const opts = validOpts({
      channels: ["msteams"],
      msteamsAppId: "11111111-1111-1111-1111-111111111111",
      msteamsAppPassword: "teams-client-secret-value-xyz",
      msteamsTenantId: "22222222-2222-2222-2222-222222222222",
    });
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
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

  // ---------- Soft-warn validation regression tests ----------

  it("emits a console.warn for unknown providers (no throw)", () => {
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

  it("validation passes silently for catalog providers (no warn)", () => {
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

  it("RECOMMENDED_MODELS does not appear in non-interactive.ts source", () => {
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

  it("rejects an unknown --msteams-auth-mode (closed config vocabulary)", () => {
    // Commander hands this flag through as an arbitrary string; simulate a
    // typo the type system cannot catch at the boundary. Without wizard-time
    // validation it would be written to config.yaml and only rejected by the
    // daemon's Zod schema at boot (a FATAL, or a crash loop with --start-daemon).
    const opts = validOpts({
      msteamsAuthMode: "managed" as NonInteractiveOptions["msteamsAuthMode"],
    });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("msteamsAuthMode");
      expect((e as NonInteractiveError).message).toContain("secret");
      expect((e as NonInteractiveError).message).toContain("certificate");
      expect((e as NonInteractiveError).message).toContain("managedIdentity");
    }
  });

  it("accepts each valid --msteams-auth-mode value", () => {
    for (const mode of ["secret", "certificate", "managedIdentity"] as const) {
      expect(() =>
        validateNonInteractiveOptions(validOpts({ msteamsAuthMode: mode })),
      ).not.toThrow();
    }
  });

  it("rejects an unknown --googlechat-mode (closed transport vocabulary)", () => {
    const opts = validOpts({
      googlechatMode: "grpc" as NonInteractiveOptions["googlechatMode"],
    });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("googlechatMode");
      expect((e as NonInteractiveError).message).toContain("pubsub");
      expect((e as NonInteractiveError).message).toContain("webhook");
    }
  });

  it("accepts each valid --googlechat-mode value", () => {
    for (const mode of ["pubsub", "webhook"] as const) {
      expect(() =>
        validateNonInteractiveOptions(validOpts({ googlechatMode: mode })),
      ).not.toThrow();
    }
  });

  it("throws NonInteractiveError for missing googlechat sa key", () => {
    const opts = validOpts({ channels: ["googlechat"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("googlechatSaKey");
    }
  });

  it("throws NonInteractiveError for missing googlechat subscription in pubsub mode", () => {
    const opts = validOpts({
      channels: ["googlechat"],
      googlechatSaKey: "{}",
      googlechatMode: "pubsub",
    });
    try {
      validateNonInteractiveOptions(opts);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NonInteractiveError);
      expect((e as NonInteractiveError).field).toBe("googlechatSubscription");
    }
  });

  it("throws NonInteractiveError for missing googlechat audience in webhook mode", () => {
    const opts = validOpts({
      channels: ["googlechat"],
      googlechatSaKey: "{}",
      googlechatMode: "webhook",
    });
    try {
      validateNonInteractiveOptions(opts);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NonInteractiveError);
      expect((e as NonInteractiveError).field).toBe("googlechatAudience");
    }
  });

  it("does NOT throw when all required googlechat pubsub flags are present", () => {
    const opts = validOpts({
      channels: ["googlechat"],
      googlechatSaKey: "{}",
      googlechatSubscription: "projects/p/subscriptions/s",
      googlechatMode: "pubsub",
    });
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
  });

  it("rejects an unknown --stt-provider / --tts-provider", () => {
    expect(() =>
      validateNonInteractiveOptions(validOpts({ sttProvider: "assemblyai" })),
    ).toThrow(NonInteractiveError);
    expect(() =>
      validateNonInteractiveOptions(validOpts({ ttsProvider: "playht" })),
    ).toThrow(NonInteractiveError);
  });

  it("accepts each valid --stt-provider and --tts-provider value", () => {
    // The validator derives `known` from SUPPORTED_TRANSCRIPTION_PROVIDERS /
    // SUPPORTED_TTS_PROVIDERS rather than freezing its own list, so the keyless
    // providers (auto/local/edge) are accepted without a key flag.
    for (const id of ["auto", "local", "openai", "groq", "deepgram"]) {
      expect(() =>
        validateNonInteractiveOptions(validOpts({ sttProvider: id })),
      ).not.toThrow();
    }
    for (const id of ["edge", "openai", "elevenlabs", "local"]) {
      expect(() =>
        validateNonInteractiveOptions(validOpts({ ttsProvider: id })),
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
    // --model defaults to the literal "default", resolved daemon-side
    // (builtin-provider-guard.ts catalog readback). There is no CLI-side
    // provider->model lookup; the daemon decides at runtime. Verify both
    // providers behave the same.
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
    // Gateway auth is token-only: the daemon's GatewayConfigSchema
    // is a z.strictObject with no `password` key, so emitting one FATAL-crash-loops
    // the daemon at boot. The wizard must be structurally incapable of emitting it,
    // even when stray gatewayAuth/gatewayPassword values are forced in (these fields
    // do not exist on the type, hence the `as never` cast — this pins RUNTIME
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

  it("builds msteams channel from the --msteams-* opts", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["msteams"],
        msteamsAppId: "11111111-1111-1111-1111-111111111111",
        msteamsAppPassword: "teams-client-secret-value-xyz",
        msteamsTenantId: "22222222-2222-2222-2222-222222222222",
        msteamsAuthMode: "secret",
      }),
    );
    expect(state.channels).toHaveLength(1);
    expect(state.channels![0]).toEqual({
      type: "msteams",
      appId: "11111111-1111-1111-1111-111111111111",
      appPassword: "teams-client-secret-value-xyz",
      tenantId: "22222222-2222-2222-2222-222222222222",
      authMode: "secret",
      validated: false,
    });
  });

  it("builds a googlechat (pubsub) channel from the --googlechat-* opts", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["googlechat"],
        googlechatSaKey: '{"client_email":"bot@x.iam.gserviceaccount.com","private_key":"pk"}',
        googlechatSubscription: "projects/p/subscriptions/s",
        googlechatMode: "pubsub",
      }),
    );
    expect(state.channels).toHaveLength(1);
    const gc = state.channels![0];
    expect(gc.type).toBe("googlechat");
    expect(gc.serviceAccountKey).toBe(
      '{"client_email":"bot@x.iam.gserviceaccount.com","private_key":"pk"}',
    );
    expect(gc.subscriptionName).toBe("projects/p/subscriptions/s");
    expect(gc.mode).toBe("pubsub");
    expect(gc.validated).toBe(false);
  });

  it("builds a googlechat (webhook) channel carrying the audience", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["googlechat"],
        googlechatSaKey: '{"client_email":"bot@x.iam.gserviceaccount.com","private_key":"pk"}',
        googlechatAudience: "123456789012",
        googlechatMode: "webhook",
      }),
    );
    expect(state.channels).toHaveLength(1);
    const gc = state.channels![0];
    expect(gc.type).toBe("googlechat");
    expect(gc.mode).toBe("webhook");
    expect(gc.audience).toBe("123456789012");
    expect(gc.validated).toBe(false);
  });

  it("resolves a --googlechat-sa-key file PATH to the key contents, not the path string", () => {
    // The flag help advertises "or a path to the key file". A CI user who
    // follows it and passes a path must get the KEY read from that file
    // persisted -- not the literal path string, which would JSON.parse-fail at
    // daemon boot. This mirrors the interactive step's path resolution.
    const dir = mkdtempSync(join(tmpdir(), "gc-sakey-"));
    const keyPath = join(dir, "key.json");
    const keyObject = {
      type: "service_account",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIexample\n-----END PRIVATE KEY-----\n",
      client_email: "bot@example-project.iam.gserviceaccount.com",
    };
    // Pretty-printed, multi-line -- exactly a downloaded key file.
    writeFileSync(keyPath, JSON.stringify(keyObject, null, 2), "utf-8");
    try {
      const state = buildNonInteractiveState(
        validOpts({
          channels: ["googlechat"],
          googlechatSaKey: keyPath,
          googlechatSubscription: "projects/p/subscriptions/s",
          googlechatMode: "pubsub",
        }),
      );
      const gc = state.channels![0];
      expect(gc.serviceAccountKey).not.toBe(keyPath);
      const parsed = JSON.parse(gc.serviceAccountKey as string) as {
        client_email?: string;
        private_key?: string;
      };
      expect(parsed.client_email).toBe(keyObject.client_email);
      expect(parsed.private_key).toBe(keyObject.private_key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores an inline --googlechat-sa-key JSON blob verbatim (not treated as a path)", () => {
    // The counterpart to the path case: a value that is not an existing file is
    // the JSON content itself and must pass through untouched.
    const inline = '{"client_email":"bot@x.iam.gserviceaccount.com","private_key":"pk"}';
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["googlechat"],
        googlechatSaKey: inline,
        googlechatSubscription: "projects/p/subscriptions/s",
        googlechatMode: "pubsub",
      }),
    );
    expect(state.channels![0].serviceAccountKey).toBe(inline);
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

  it("records edge TTS with no credential and deepgram STT with --stt-api-key", () => {
    const state = buildNonInteractiveState(
      validOpts({
        sttProvider: "deepgram",
        sttApiKey: "dg-key-1234567890",
        ttsProvider: "edge",
      }),
    );
    expect(state.transcriptionProvider).toEqual({
      provider: "deepgram",
      apiKey: "dg-key-1234567890",
    });
    expect(state.ttsProvider).toEqual({ provider: "edge" });
  });

  it("reuses the main openai key for openai STT/TTS (no extra credential)", () => {
    const state = buildNonInteractiveState(
      validOpts({
        provider: "openai",
        apiKey: "sk-openai-main-123456",
        sttProvider: "openai",
        ttsProvider: "openai",
      }),
    );
    expect(state.transcriptionProvider).toEqual({ provider: "openai" });
    expect(state.ttsProvider).toEqual({ provider: "openai" });
  });

  it("records a keyless STT provider for --stt-provider auto with an ollama main and no key", () => {
    // The STT branch must take the explicit `!requiredEnvKey`
    // keyless short-circuit (mirroring TTS/image), NOT the fragile reuse-main
    // fall-through that happens to work only because ollama also has no env key.
    const state = buildNonInteractiveState(
      validOpts({ provider: "ollama", apiKey: undefined, sttProvider: "auto" }),
    );
    expect(state.transcriptionProvider).toEqual({ provider: "auto" });
    expect(state.transcriptionProvider).not.toHaveProperty("apiKey");
  });

  it("records a keyless STT provider for --stt-provider local with no key", () => {
    const state = buildNonInteractiveState(
      validOpts({ provider: "ollama", apiKey: undefined, sttProvider: "local" }),
    );
    expect(state.transcriptionProvider).toEqual({ provider: "local" });
    expect(state.transcriptionProvider).not.toHaveProperty("apiKey");
  });

  it("leaves STT and TTS unset when the audio flags are omitted so the daemon applies keyless defaults", () => {
    // The codex-safe mechanism: with NO --stt-provider/--tts-provider, the state
    // omits both sections, so 10-write-config writes nothing and the daemon's
    // schema default (auto/edge) applies — never a stranded openai.
    // A keyless ollama main stands in for the OAuth-only case (openai-codex
    // itself still hard-throws; the keyless-default path is
    // what protects an OAuth-only user from a phantom OPENAI_API_KEY).
    const state = buildNonInteractiveState(
      validOpts({ provider: "ollama", apiKey: undefined }),
    );
    expect(state.transcriptionProvider).toBeUndefined();
    expect(state.ttsProvider).toBeUndefined();
  });

  it("records auto video provider without a credential", () => {
    const state = buildNonInteractiveState(validOpts({ videoProvider: "auto" }));
    expect(state.videoProvider).toEqual({ provider: "auto" });
  });

  it("reuses the main provider key for a matching google video provider", () => {
    const state = buildNonInteractiveState(
      validOpts({ provider: "google", apiKey: "AIza-main-1234567890", videoProvider: "google" }),
    );
    // No extra key — GOOGLE_API_KEY is already covered by the main provider.
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
      "transcription",
      "tts",
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
