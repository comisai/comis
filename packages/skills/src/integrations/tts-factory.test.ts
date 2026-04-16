import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTTSProvider } from "./tts-factory.js";
import type { TtsConfig, SecretManager } from "@comis/core";

// Mock all three adapters
vi.mock("./openai-tts-adapter.js", () => ({
  createOpenAITTSAdapter: vi.fn().mockReturnValue({ __type: "openai" }),
}));
vi.mock("./elevenlabs-tts-adapter.js", () => ({
  createElevenLabsTTSAdapter: vi.fn().mockReturnValue({ __type: "elevenlabs" }),
}));
vi.mock("./edge-tts-adapter.js", () => ({
  createEdgeTTSAdapter: vi.fn().mockReturnValue({ __type: "edge" }),
}));

function createMockSecretManager(secrets: Record<string, string | undefined>): SecretManager {
  return {
    get: (key: string) => secrets[key],
    has: (key: string) => secrets[key] !== undefined,
    require: (key: string) => {
      const value = secrets[key];
      if (value === undefined) throw new Error(`Required secret "${key}" is not set.`);
      return value;
    },
    keys: () => Object.keys(secrets).filter((k) => secrets[k] !== undefined),
  };
}

describe("createTTSProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create OpenAI adapter for 'openai' provider", async () => {
    const { createOpenAITTSAdapter } = await import("./openai-tts-adapter.js");
    const secretManager = createMockSecretManager({ OPENAI_API_KEY: "sk-test" });
    const config: TtsConfig = { provider: "openai", voice: "alloy", format: "opus" };

    const result = createTTSProvider(config, secretManager);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as unknown as { __type: string }).__type).toBe("openai");
    }
    expect(createOpenAITTSAdapter).toHaveBeenCalledWith({
      apiKey: "sk-test",
      model: undefined,
    });
  });

  it("should create ElevenLabs adapter for 'elevenlabs' provider", async () => {
    const { createElevenLabsTTSAdapter } = await import("./elevenlabs-tts-adapter.js");
    const secretManager = createMockSecretManager({ ELEVENLABS_API_KEY: "el-test" });
    const config: TtsConfig = {
      provider: "elevenlabs",
      voice: "custom-voice",
      format: "opus",
      model: "eleven_turbo_v2_5",
    };

    const result = createTTSProvider(config, secretManager);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as unknown as { __type: string }).__type).toBe("elevenlabs");
    }
    expect(createElevenLabsTTSAdapter).toHaveBeenCalledWith({
      apiKey: "el-test",
      modelId: "eleven_turbo_v2_5",
      defaultVoice: "custom-voice",
    });
  });

  it("should create Edge adapter for 'edge' provider", async () => {
    const { createEdgeTTSAdapter } = await import("./edge-tts-adapter.js");
    const secretManager = createMockSecretManager({});
    const config: TtsConfig = {
      provider: "edge",
      voice: "en-US-AvaMultilingualNeural",
      format: "opus",
    };

    const result = createTTSProvider(config, secretManager);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as unknown as { __type: string }).__type).toBe("edge");
    }
    expect(createEdgeTTSAdapter).toHaveBeenCalledWith({
      defaultVoice: "en-US-AvaMultilingualNeural",
    });
  });

  it("should return error for unknown provider", () => {
    const secretManager = createMockSecretManager({});
    // Force unknown provider via type assertion
    const config = { provider: "unknown", voice: "alloy", format: "opus" } as unknown as TtsConfig;

    const result = createTTSProvider(config, secretManager);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unknown TTS provider");
      expect(result.error.message).toContain("unknown");
    }
  });

  it("should work without API key for edge provider (free fallback)", () => {
    const secretManager = createMockSecretManager({});
    const config: TtsConfig = { provider: "edge", voice: "alloy", format: "opus" };

    const result = createTTSProvider(config, secretManager);

    expect(result.ok).toBe(true);
  });

  it("should pass empty string when API key is missing for openai", async () => {
    const { createOpenAITTSAdapter } = await import("./openai-tts-adapter.js");
    const secretManager = createMockSecretManager({});
    const config: TtsConfig = { provider: "openai", voice: "alloy", format: "opus" };

    createTTSProvider(config, secretManager);

    expect(createOpenAITTSAdapter).toHaveBeenCalledWith({
      apiKey: "",
      model: undefined,
    });
  });

  it("should pass empty string when API key is missing for elevenlabs", async () => {
    const { createElevenLabsTTSAdapter } = await import("./elevenlabs-tts-adapter.js");
    const secretManager = createMockSecretManager({});
    const config: TtsConfig = { provider: "elevenlabs", voice: "alloy", format: "opus" };

    createTTSProvider(config, secretManager);

    expect(createElevenLabsTTSAdapter).toHaveBeenCalledWith({
      apiKey: "",
      modelId: undefined,
      defaultVoice: "alloy",
    });
  });
});
