import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TranscriptionPort, TranscriptionConfig, SecretManager } from "@comis/core";
import type { Result } from "@comis/shared";
import type { TranscriptionResult } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createSTTProvider, createFallbackTranscription, type SttFallbackLogger } from "./stt-factory.js";

// ---------------------------------------------------------------------------
// Mock adapter constructors
// ---------------------------------------------------------------------------

vi.mock("./openai-stt-adapter.js", () => ({
  createOpenAISttAdapter: vi.fn().mockReturnValue({
    transcribe: vi.fn().mockResolvedValue({ ok: true, value: { text: "openai-mock" } }),
  }),
}));

vi.mock("./groq-stt-adapter.js", () => ({
  createGroqSttAdapter: vi.fn().mockReturnValue({
    transcribe: vi.fn().mockResolvedValue({ ok: true, value: { text: "groq-mock" } }),
  }),
}));

vi.mock("./deepgram-stt-adapter.js", () => ({
  createDeepgramSttAdapter: vi.fn().mockReturnValue({
    transcribe: vi.fn().mockResolvedValue({ ok: true, value: { text: "deepgram-mock" } }),
  }),
}));

import { createOpenAISttAdapter } from "./openai-stt-adapter.js";
import { createGroqSttAdapter } from "./groq-stt-adapter.js";
import { createDeepgramSttAdapter } from "./deepgram-stt-adapter.js";
import { createMockLogger as _createMockLogger } from "../../../../test/support/mock-logger.js";

const createMockLogger = (): SttFallbackLogger => _createMockLogger() as unknown as SttFallbackLogger;


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSecretManager(secrets: Record<string, string> = {}): SecretManager {
  return {
    get: vi.fn((key: string) => secrets[key] ?? undefined),
  } as unknown as SecretManager;
}

function createBaseConfig(provider: string): TranscriptionConfig {
  return {
    provider: provider as TranscriptionConfig["provider"],
    model: "custom-model",
    maxFileSizeMb: 50,
    timeoutMs: 30_000,
    autoTranscribe: true,
    preflight: true,
    fallbackProviders: [],
  };
}

function createMockProvider(
  result: Result<TranscriptionResult, Error>,
): TranscriptionPort {
  return {
    transcribe: vi.fn().mockResolvedValue(result),
  };
}

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("createSTTProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates OpenAI adapter for 'openai' provider", () => {
    const secrets = { OPENAI_API_KEY: "sk-openai-123" };
    const sm = createMockSecretManager(secrets);
    const config = createBaseConfig("openai");

    const result = createSTTProvider(config, sm);

    expect(result.ok).toBe(true);
    expect(createOpenAISttAdapter).toHaveBeenCalledTimes(1);
    expect(createOpenAISttAdapter).toHaveBeenCalledWith({
      apiKey: "sk-openai-123",
      model: "custom-model",
      timeoutMs: 30_000,
      maxFileSizeMb: 50,
    });
  });

  it("creates Groq adapter for 'groq' provider", () => {
    const secrets = { GROQ_API_KEY: "gsk-groq-456" };
    const sm = createMockSecretManager(secrets);
    const config = createBaseConfig("groq");

    const result = createSTTProvider(config, sm);

    expect(result.ok).toBe(true);
    expect(createGroqSttAdapter).toHaveBeenCalledTimes(1);
    expect(createGroqSttAdapter).toHaveBeenCalledWith({
      apiKey: "gsk-groq-456",
      model: "custom-model",
      timeoutMs: 30_000,
      maxFileSizeMb: 50,
    });
  });

  it("creates Deepgram adapter for 'deepgram' provider", () => {
    const secrets = { DEEPGRAM_API_KEY: "dg-789" };
    const sm = createMockSecretManager(secrets);
    const config = createBaseConfig("deepgram");

    const result = createSTTProvider(config, sm);

    expect(result.ok).toBe(true);
    expect(createDeepgramSttAdapter).toHaveBeenCalledTimes(1);
    expect(createDeepgramSttAdapter).toHaveBeenCalledWith({
      apiKey: "dg-789",
      model: "custom-model",
      timeoutMs: 30_000,
      maxFileSizeMb: 50,
    });
  });

  it("returns err for unknown provider", () => {
    const sm = createMockSecretManager();
    const config = createBaseConfig("unsupported-provider");

    const result = createSTTProvider(config, sm);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unknown STT provider");
      expect(result.error.message).toContain("unsupported-provider");
    }
  });

  it("calls SecretManager.get() with correct key names", () => {
    const sm = createMockSecretManager();

    createSTTProvider(createBaseConfig("openai"), sm);
    expect(sm.get).toHaveBeenCalledWith("OPENAI_API_KEY");

    vi.clearAllMocks();
    createSTTProvider(createBaseConfig("groq"), sm);
    expect(sm.get).toHaveBeenCalledWith("GROQ_API_KEY");

    vi.clearAllMocks();
    createSTTProvider(createBaseConfig("deepgram"), sm);
    expect(sm.get).toHaveBeenCalledWith("DEEPGRAM_API_KEY");
  });

  it("passes config.model, config.timeoutMs, config.maxFileSizeMb to adapter", () => {
    const sm = createMockSecretManager({ OPENAI_API_KEY: "key" });
    const config: TranscriptionConfig = {
      provider: "openai",
      model: "whisper-1",
      maxFileSizeMb: 100,
      timeoutMs: 120_000,
      autoTranscribe: false,
      preflight: false,
      fallbackProviders: [],
    };

    createSTTProvider(config, sm);

    expect(createOpenAISttAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "whisper-1",
        timeoutMs: 120_000,
        maxFileSizeMb: 100,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Fallback chain tests
// ---------------------------------------------------------------------------

describe("createFallbackTranscription", () => {
  const audio = Buffer.from("test-audio");
  const options = { mimeType: "audio/ogg" };

  it("returns immediately on single provider success", async () => {
    const successResult = ok({ text: "hello world", language: "en", durationMs: 5000 });
    const provider = createMockProvider(successResult);
    const fallback = createFallbackTranscription([provider]);

    const result = await fallback.transcribe(audio, options);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("hello world");
    }
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
  });

  it("falls back to second provider when first fails", async () => {
    const failResult = err(new Error("Provider 1 timeout"));
    const successResult = ok({ text: "from provider 2" });
    const provider1 = createMockProvider(failResult);
    const provider2 = createMockProvider(successResult);
    const fallback = createFallbackTranscription([provider1, provider2]);

    const result = await fallback.transcribe(audio, options);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("from provider 2");
    }
    expect(provider1.transcribe).toHaveBeenCalledTimes(1);
    expect(provider2.transcribe).toHaveBeenCalledTimes(1);
  });

  it("returns last error when all providers fail", async () => {
    const fail1 = err(new Error("Provider 1 failed"));
    const fail2 = err(new Error("Provider 2 failed"));
    const fail3 = err(new Error("Provider 3 failed"));
    const fallback = createFallbackTranscription([
      createMockProvider(fail1),
      createMockProvider(fail2),
      createMockProvider(fail3),
    ]);

    const result = await fallback.transcribe(audio, options);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Provider 3 failed");
    }
  });

  it("does NOT fallback on empty text (empty text is valid)", async () => {
    const emptyTextResult = ok({ text: "" });
    const provider1 = createMockProvider(emptyTextResult);
    const provider2 = createMockProvider(ok({ text: "should not reach" }));
    const fallback = createFallbackTranscription([provider1, provider2]);

    const result = await fallback.transcribe(audio, options);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("");
    }
    expect(provider1.transcribe).toHaveBeenCalledTimes(1);
    expect(provider2.transcribe).not.toHaveBeenCalled();
  });

  it("returns err for empty providers array", async () => {
    const fallback = createFallbackTranscription([]);

    const result = await fallback.transcribe(audio, options);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("No STT providers configured");
    }
  });

  it("logs WARN with errorKind 'dependency' on each failure", async () => {
    const logger = createMockLogger();
    const fail1 = err(new Error("timeout"));
    const fail2 = err(new Error("rate limit"));
    const fallback = createFallbackTranscription(
      [createMockProvider(fail1), createMockProvider(fail2)],
      logger,
    );

    await fallback.transcribe(audio, options);

    expect(logger.warn).toHaveBeenCalledTimes(2);

    // First failure: hint about falling back
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerIndex: 0,
        err: "timeout",
        hint: "Falling back to next STT provider",
        errorKind: "dependency",
      }),
      expect.any(String),
    );

    // Last failure: hint about all failed
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerIndex: 1,
        err: "rate limit",
        hint: "All STT providers failed",
        errorKind: "dependency",
      }),
      expect.any(String),
    );
  });

  it("logs DEBUG before each provider attempt", async () => {
    const logger = createMockLogger();
    const success = ok({ text: "hello" });
    const fallback = createFallbackTranscription(
      [createMockProvider(err(new Error("fail"))), createMockProvider(success)],
      logger,
    );

    await fallback.transcribe(audio, options);

    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith(
      { providerIndex: 0, totalProviders: 2 },
      "Attempting STT provider",
    );
    expect(logger.debug).toHaveBeenCalledWith(
      { providerIndex: 1, totalProviders: 2 },
      "Attempting STT provider",
    );
  });
});
