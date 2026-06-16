// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "@comis/shared";
import {
  executeVoiceResponse,
  type VoiceResponsePipelineDeps,
  type VoiceResponseContext,
} from "./voice-response-pipeline.js";

// ---------------------------------------------------------------------------
// Mock @comis/core safePath
// ---------------------------------------------------------------------------
vi.mock("@comis/core", () => ({
  safePath: vi.fn((...segments: string[]) => segments.join("/")),
  systemNowMs: () => Date.now(),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises writeFile
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock prepareVoicePayload from voice-sender
// ---------------------------------------------------------------------------
vi.mock("./voice-sender.js", () => ({
  prepareVoicePayload: vi.fn(),
}));

import { prepareVoicePayload } from "./voice-sender.js";
const mockPrepareVoicePayload = vi.mocked(prepareVoicePayload);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(
  overrides?: Partial<VoiceResponsePipelineDeps>,
): VoiceResponsePipelineDeps {
  return {
    ttsAdapter: {
      synthesize: vi.fn().mockResolvedValue(
        ok({ audio: Buffer.from("audio-data"), mimeType: "audio/opus" }),
      ),
    },
    audioConverter: {
      toOggOpus: vi.fn(),
      verifyOpusCodec: vi.fn(),
      extractWaveform: vi.fn(),
    },
    mediaTempManager: {
      getManagedDir: vi.fn().mockReturnValue("/tmp/comis-media"),
    },
    mediaSemaphore: {
      run: vi.fn().mockImplementation(async (fn) => fn()),
    },
    shouldAutoTts: vi.fn().mockReturnValue({ shouldSynthesize: true }),
    resolveOutputFormat: vi.fn().mockReturnValue({
      openai: "opus",
      elevenlabs: "opus_48000_64",
      edge: "audio-24khz-48kbitrate-mono-mp3",
      extension: ".opus",
    }),
    ttsConfig: {
      autoMode: "inbound",
      tagPattern: "\\[\\[tts(?::.*?)?\\]\\]",
      voice: "alloy",
      maxTextLength: 4096,
      outputFormats: undefined,
      providerFormatKey: "openai",
      // OBS-01 voice-identity fields (Phase 196) — the resolved STT/TTS provider
      // identity the wiring point threads into the pipeline for the §2.7 INFO line.
      provider: "edge",
      keyless: true,
      model: "edge-tts",
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function createMockCtx(
  overrides?: Partial<VoiceResponseContext>,
): VoiceResponseContext {
  return {
    responseText: "Hello, this is a voice response test.",
    originalMessage: {
      attachments: [{ type: "audio", isVoiceNote: true }],
    },
    adapter: {
      sendAttachment: vi.fn().mockResolvedValue(ok({})),
    },
    channelType: "telegram",
    channelId: "chat-123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeVoiceResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareVoicePayload.mockResolvedValue(
      ok({
        oggPath: "/tmp/comis-media/voice-abc.ogg",
        durationSecs: 5,
        waveformBase64: "AQID",
        codecVerified: true,
      }),
    );
  });

  // Returns voiceSent:false when autoMode logic says no
  it("should return voiceSent:false when shouldAutoTts says no", async () => {
    const deps = createMockDeps({
      shouldAutoTts: vi.fn().mockReturnValue({ shouldSynthesize: false }),
    });
    const ctx = createMockCtx({
      originalMessage: { attachments: [] },
    });

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(false);
    // TTS adapter should NOT be called
    expect(deps.ttsAdapter.synthesize).not.toHaveBeenCalled();
  });

  // Returns voiceSent:true when autoMode is "inbound" and original message has voice
  it("should return voiceSent:true with voice attachment on happy path", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx();

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(true);

    // Verify sendAttachment called with isVoiceNote:true
    expect(ctx.adapter.sendAttachment).toHaveBeenCalledWith(
      "chat-123",
      expect.objectContaining({
        type: "audio",
        mimeType: "audio/ogg; codecs=opus",
        isVoiceNote: true,
        durationSecs: 5,
        waveform: "AQID",
      }),
      undefined, // sendOptions (no thread context in default mock)
    );
  });

  // Handles TTS synthesis failure gracefully
  it("should return voiceSent:false on TTS synthesis failure (not error)", async () => {
    const deps = createMockDeps({
      ttsAdapter: {
        synthesize: vi.fn().mockResolvedValue(
          err(new Error("API rate limit exceeded")),
        ),
      },
    });
    const ctx = createMockCtx();

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "TTS synthesis failed; falling back to text-only response",
        errorKind: "dependency",
      }),
      "TTS synthesis failed",
    );
  });

  // Handles conversion failure gracefully
  it("should return voiceSent:false on prepareVoicePayload failure", async () => {
    mockPrepareVoicePayload.mockResolvedValue(
      err(new Error("ffmpeg conversion failed")),
    );
    const deps = createMockDeps();
    const ctx = createMockCtx();

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Voice payload preparation failed; falling back to text-only response",
      }),
      "Voice payload preparation failed",
    );
  });

  // Truncates text exceeding maxTextLength before synthesis
  it("should truncate text exceeding maxTextLength", async () => {
    const longText = "A".repeat(5000);
    const deps = createMockDeps({
      ttsConfig: {
        autoMode: "inbound",
        tagPattern: "\\[\\[tts(?::.*?)?\\]\\]",
        voice: "alloy",
        maxTextLength: 100,
        providerFormatKey: "openai",
      },
    });
    const ctx = createMockCtx({ responseText: longText });

    await executeVoiceResponse(deps, ctx);

    // Verify synthesize was called with truncated text
    expect(deps.ttsAdapter.synthesize).toHaveBeenCalledWith(
      "A".repeat(100),
      expect.any(Object),
    );
    // Verify WARN log about truncation
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        originalLength: 5000,
        maxTextLength: 100,
        hint: "Text truncated before TTS synthesis",
      }),
      "TTS text truncated",
    );
  });

  // Skips voice when audioConverter is undefined and TTS outputs MP3
  it("should skip voice when audioConverter is undefined and TTS outputs MP3", async () => {
    const deps = createMockDeps({
      ttsAdapter: {
        synthesize: vi.fn().mockResolvedValue(
          ok({ audio: Buffer.from("mp3-data"), mimeType: "audio/mpeg" }),
        ),
      },
      audioConverter: undefined,
    });
    const ctx = createMockCtx();

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Install ffmpeg for voice response support with Edge TTS/ElevenLabs providers",
        errorKind: "dependency",
      }),
      "Audio converter unavailable for non-Opus TTS output",
    );
  });

  // Sends voice attachment with correct OGG/Opus MIME type and metadata
  it("should send voice attachment with correct MIME type and metadata", async () => {
    mockPrepareVoicePayload.mockResolvedValue(
      ok({
        oggPath: "/tmp/comis-media/voice-xyz.ogg",
        durationSecs: 12,
        waveformBase64: "BQUH",
        codecVerified: true,
      }),
    );
    const deps = createMockDeps();
    const ctx = createMockCtx();

    await executeVoiceResponse(deps, ctx);

    expect(ctx.adapter.sendAttachment).toHaveBeenCalledWith("chat-123", {
      type: "audio",
      url: "/tmp/comis-media/voice-xyz.ogg",
      mimeType: "audio/ogg; codecs=opus",
      isVoiceNote: true,
      durationSecs: 12,
      waveform: "BQUH",
    }, undefined);
  });

  // Semaphore.run is called
  it("should invoke mediaSemaphore.run for concurrency control", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx();

    await executeVoiceResponse(deps, ctx);

    expect(deps.mediaSemaphore.run).toHaveBeenCalledTimes(1);
    expect(deps.mediaSemaphore.run).toHaveBeenCalledWith(expect.any(Function));
  });

  // Handles sendAttachment failure gracefully
  it("should return voiceSent:false on sendAttachment failure", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx({
      adapter: {
        sendAttachment: vi.fn().mockResolvedValue(
          err(new Error("Telegram API error")),
        ),
      },
    });

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Voice attachment send failed; falling back to text-only response",
        errorKind: "network",
      }),
      "Voice attachment send failed",
    );
  });

  // Tagged mode returns strippedText in result
  it("should return strippedText in tagged mode", async () => {
    const deps = createMockDeps({
      shouldAutoTts: vi.fn().mockReturnValue({
        shouldSynthesize: true,
        strippedText: "Hello world",
      }),
    });
    const ctx = createMockCtx({
      responseText: "[[tts]] Hello world",
    });

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(true);
    expect(result.value.cleanedText).toBe("Hello world");

    // Verify synthesize was called with stripped text
    expect(deps.ttsAdapter.synthesize).toHaveBeenCalledWith(
      "Hello world",
      expect.any(Object),
    );
  });

  // Selects correct provider format via providerFormatKey
  it("should select ElevenLabs format when providerFormatKey is 'elevenlabs'", async () => {
    const deps = createMockDeps({
      ttsConfig: {
        autoMode: "inbound",
        tagPattern: "\\[\\[tts(?::.*?)?\\]\\]",
        voice: "rachel",
        maxTextLength: 4096,
        providerFormatKey: "elevenlabs",
      },
    });
    const ctx = createMockCtx();

    await executeVoiceResponse(deps, ctx);

    // resolveOutputFormat returns elevenlabs: "opus_48000_64"
    expect(deps.ttsAdapter.synthesize).toHaveBeenCalledWith(
      ctx.responseText,
      { voice: "rachel", format: "opus_48000_64" },
    );
  });

  it("should select OpenAI format when providerFormatKey is 'openai'", async () => {
    const deps = createMockDeps({
      ttsConfig: {
        autoMode: "inbound",
        tagPattern: "\\[\\[tts(?::.*?)?\\]\\]",
        voice: "alloy",
        maxTextLength: 4096,
        providerFormatKey: "openai",
      },
    });
    const ctx = createMockCtx();

    await executeVoiceResponse(deps, ctx);

    // resolveOutputFormat returns openai: "opus"
    expect(deps.ttsAdapter.synthesize).toHaveBeenCalledWith(
      ctx.responseText,
      { voice: "alloy", format: "opus" },
    );
  });

  // Returns voiceSent:false when mediaTempManager.getManagedDir() returns undefined
  it("should return voiceSent:false when getManagedDir returns undefined", async () => {
    const deps = createMockDeps({
      mediaTempManager: {
        getManagedDir: vi.fn().mockReturnValue(undefined),
      },
    });
    const ctx = createMockCtx();

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Media temp manager not initialized",
        errorKind: "resource",
      }),
      "Media temp manager not initialized",
    );
  });

  // -------------------------------------------------------------------
  // Thread propagation (sendOptions passthrough)
  // -------------------------------------------------------------------
  it("passes sendOptions to sendAttachment", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx({
      sendOptions: { threadId: "42" },
    });

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(true);

    expect(ctx.adapter.sendAttachment).toHaveBeenCalledWith(
      "chat-123",
      expect.objectContaining({
        type: "audio",
        mimeType: "audio/ogg; codecs=opus",
        isVoiceNote: true,
      }),
      { threadId: "42" },
    );
  });

  it("works without sendOptions", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx(); // no sendOptions

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(true);

    expect(ctx.adapter.sendAttachment).toHaveBeenCalledWith(
      "chat-123",
      expect.objectContaining({
        type: "audio",
        mimeType: "audio/ogg; codecs=opus",
        isVoiceNote: true,
      }),
      undefined,
    );
  });

  // -------------------------------------------------------------------
  // OBS-01 §2.7 — extended voice-out completion INFO (Phase 196)
  // -------------------------------------------------------------------
  it("logs the §17 voice fields (provider/keyless/model/costUsd) on the 'Voice response sent' INFO", async () => {
    const deps = createMockDeps(); // ttsConfig: provider:edge, keyless:true, model:edge-tts
    const ctx = createMockCtx();

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voiceSent).toBe(true);

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        // existing fields preserved
        channelType: "telegram",
        durationMs: expect.any(Number),
        durationSecs: 5,
        // OBS-01 extension
        provider: "edge",
        keyless: true,
        model: "edge-tts",
        costUsd: 0, // keyless records 0 EXPLICITLY (FLAG 4 — "free" is visible, not absent)
      }),
      "Voice response sent",
    );
  });

  it("omits costUsd on a keyed provider (no per-call cost source; FLAG 4)", async () => {
    const deps = createMockDeps({
      ttsConfig: {
        autoMode: "inbound",
        tagPattern: "\\[\\[tts(?::.*?)?\\]\\]",
        voice: "alloy",
        maxTextLength: 4096,
        providerFormatKey: "openai",
        provider: "openai",
        keyless: false,
        model: "gpt-4o-mini-tts",
      },
    });
    const ctx = createMockCtx();

    const result = await executeVoiceResponse(deps, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const infoCall = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === "Voice response sent",
    );
    expect(infoCall).toBeDefined();
    const infoObj = infoCall![0] as Record<string, unknown>;
    expect(infoObj.provider).toBe("openai");
    expect(infoObj.keyless).toBe(false);
    expect(infoObj.model).toBe("gpt-4o-mini-tts");
    // keyed path carries no per-call cost source today — omit, don't log undefined.
    expect("costUsd" in infoObj).toBe(false);
  });
});
