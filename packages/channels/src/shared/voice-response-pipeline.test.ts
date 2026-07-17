// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "@comis/shared";
import {
  executeVoiceResponse,
  type VoiceResponsePipelineDeps,
  type VoiceResponseContext,
} from "./voice-response-pipeline.js";

// ---------------------------------------------------------------------------
// Mock @comis/core safePath + the relocated redactErrorMessage.
//
// redactErrorMessage is mocked with the REAL relocated semantics (URL→[URL],
// Bearer/Authorization strip, 20+-char token→[REDACTED]) so the redaction
// asserts below exercise the actual scrubber the pipeline imports from
// @comis/core (NOT a pass-through stub) — the voice-out redaction floor.
// ---------------------------------------------------------------------------
vi.mock("@comis/core", () => ({
  safePath: vi.fn((...segments: string[]) => segments.join("/")),
  systemNowMs: () => Date.now(),
  redactErrorMessage: vi.fn((body: string): string =>
    body
      .replace(/https?:\/\/[^\s"')]+/g, "[URL]")
      .replace(/\bAuthorization:/gi, "")
      .replace(/\bBearer\b/gi, "")
      .replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]"),
  ),
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
import { writeFile } from "node:fs/promises";
const mockPrepareVoicePayload = vi.mocked(prepareVoicePayload);
const mockWriteFile = vi.mocked(writeFile);

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
      // Voice-identity fields — the resolved STT/TTS provider identity the
      // wiring point threads into the pipeline for the completion INFO line.
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
      sendAttachment: vi.fn().mockResolvedValue(ok({
        kind: "tracked",
        messageId: "voice-message-1",
      })),
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
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockPrepareVoicePayload.mockReset();
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

  it("stops before temp-file and attachment side effects when aborted during synthesis", async () => {
    const controller = new AbortController();
    const deps = createMockDeps({
      ttsAdapter: {
        synthesize: vi.fn(async () => {
          controller.abort("queue_aborted");
          return ok({ audio: Buffer.from("audio-data"), mimeType: "audio/opus" });
        }),
      },
    });
    const ctx = createMockCtx({ signal: controller.signal });

    const result = await executeVoiceResponse(deps, ctx);

    expect(result).toEqual(ok({ voiceSent: false }));
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockPrepareVoicePayload).not.toHaveBeenCalled();
    expect(ctx.adapter.sendAttachment).not.toHaveBeenCalled();
  });

  it("stops before conversion and attachment side effects when aborted during temp write", async () => {
    const controller = new AbortController();
    mockWriteFile.mockImplementationOnce(async () => {
      controller.abort("queue_aborted");
    });
    const ctx = createMockCtx({ signal: controller.signal });

    const result = await executeVoiceResponse(createMockDeps(), ctx);

    expect(result).toEqual(ok({ voiceSent: false }));
    expect(mockPrepareVoicePayload).not.toHaveBeenCalled();
    expect(ctx.adapter.sendAttachment).not.toHaveBeenCalled();
  });

  it("stops before attachment send when aborted during voice payload preparation", async () => {
    const controller = new AbortController();
    mockPrepareVoicePayload.mockImplementationOnce(async () => {
      controller.abort("queue_aborted");
      return ok({
        oggPath: "/tmp/comis-media/voice-abc.ogg",
        durationSecs: 5,
        waveformBase64: "AQID",
        codecVerified: true,
      });
    });
    const ctx = createMockCtx({ signal: controller.signal });

    const result = await executeVoiceResponse(createMockDeps(), ctx);

    expect(result).toEqual(ok({ voiceSent: false }));
    expect(ctx.adapter.sendAttachment).not.toHaveBeenCalled();
  });

  it("returns the real platform attachment message id with a successful voice send", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx({
      adapter: {
        sendAttachment: vi.fn().mockResolvedValue(ok({
          kind: "tracked",
          messageId: "voice-platform-123",
        })),
      },
    });

    const result = await executeVoiceResponse(deps, ctx);

    expect(result).toEqual(ok({
      voiceSent: true,
      receipt: { kind: "tracked", messageId: "voice-platform-123" },
      cleanedText: undefined,
    }));
  });

  it("does not fall back to duplicate text when voice was delivered without tracking", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx({
      adapter: {
        sendAttachment: vi.fn().mockResolvedValue(ok({
          kind: "delivered_untracked",
        })),
      },
    });

    const result = await executeVoiceResponse(deps, ctx);

    expect(result).toEqual(ok({
      voiceSent: true,
      receipt: { kind: "delivered_untracked" },
      cleanedText: undefined,
    }));
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("Do not retry"),
        errorKind: "platform",
      }),
      "Voice attachment delivered without platform tracking",
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

  it("falls back to text when TTS synthesis rejects", async () => {
    const deps = createMockDeps({
      ttsAdapter: {
        synthesize: vi.fn().mockRejectedValue(new Error("provider rejected")),
      },
    });

    const result = await executeVoiceResponse(deps, createMockCtx());

    expect(result).toEqual(ok({ voiceSent: false, cleanedText: undefined }));
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "dependency",
        hint: "TTS synthesis failed; falling back to text-only response",
      }),
      "TTS synthesis failed",
    );
  });

  it("falls back to text when writing synthesized audio rejects", async () => {
    mockWriteFile.mockRejectedValueOnce(new Error("temp storage rejected"));
    const deps = createMockDeps();

    const result = await executeVoiceResponse(deps, createMockCtx());

    expect(result).toEqual(ok({ voiceSent: false, cleanedText: undefined }));
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "resource",
        hint: "Writing synthesized audio failed; falling back to text-only response",
      }),
      "TTS temp file write failed",
    );
    expect(mockPrepareVoicePayload).not.toHaveBeenCalled();
  });

  it("falls back to text when voice payload preparation rejects", async () => {
    mockPrepareVoicePayload.mockRejectedValueOnce(new Error("converter rejected"));
    const deps = createMockDeps();

    const result = await executeVoiceResponse(deps, createMockCtx());

    expect(result).toEqual(ok({ voiceSent: false, cleanedText: undefined }));
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "dependency",
        hint: "Voice payload preparation failed; falling back to text-only response",
      }),
      "Voice payload preparation failed",
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
        errorKind: "platform",
      }),
      "Voice attachment send failed",
    );
  });

  it("falls back to text when voice attachment sending rejects", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx({
      adapter: {
        sendAttachment: vi.fn().mockRejectedValue(new Error("platform rejected")),
      },
    });

    const result = await executeVoiceResponse(deps, ctx);

    expect(result).toEqual(ok({ voiceSent: false, cleanedText: undefined }));
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "platform",
        hint: "Voice attachment send failed; falling back to text-only response",
      }),
      "Voice attachment send failed",
    );
  });

  it("falls back to text when the media semaphore rejects", async () => {
    const deps = createMockDeps({
      mediaSemaphore: {
        run: vi.fn().mockRejectedValue(new Error("semaphore rejected")),
      },
    });

    const result = await executeVoiceResponse(deps, createMockCtx());

    expect(result).toEqual(ok({ voiceSent: false, cleanedText: undefined }));
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "internal",
        hint: "Voice processing failed unexpectedly; falling back to text-only response",
      }),
      "Voice response pipeline failed",
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
  // Extended voice-out completion INFO — voice-identity fields
  // -------------------------------------------------------------------
  it("logs the voice-identity fields (provider/keyless/model/costUsd) on the 'Voice response sent' INFO", async () => {
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
        // voice-identity extension
        provider: "edge",
        keyless: true,
        model: "edge-tts",
        costUsd: 0, // keyless records 0 EXPLICITLY — "free" is visible, not absent
      }),
      "Voice response sent",
    );
  });

  it("omits costUsd on a keyed provider (no per-call cost source)", async () => {
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

  // -------------------------------------------------------------------
  // The voice-OUT WARN branches redact credential-bearing errors
  // (invariant: no secret is logged at any level).
  // Each of the 3 failure branches (:263 synth, :321 payload, :347 send) must
  // route its err: field through redactErrorMessage (relocated to @comis/core).
  // -------------------------------------------------------------------
  const LEAKY = "POST https://host/synth failed: Bearer sk-leak0123456789abcdef";

  function warnErrFor(logger: VoiceResponsePipelineDeps["logger"], msg: string): string {
    const call = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === msg,
    );
    expect(call, `expected a WARN "${msg}"`).toBeDefined();
    return (call![0] as Record<string, unknown>).err as string;
  }

  it("redacts the TTS-synthesis WARN err: (URL/Bearer/long-token scrubbed)", async () => {
    const deps = createMockDeps({
      ttsAdapter: { synthesize: vi.fn().mockResolvedValue(err(new Error(LEAKY))) },
    });

    await executeVoiceResponse(deps, createMockCtx());

    const errField = warnErrFor(deps.logger, "TTS synthesis failed");
    expect(errField).toContain("[URL]");
    expect(errField).not.toContain("https://host/synth");
    expect(errField).not.toContain("Bearer");
    expect(errField).not.toContain("sk-leak0123456789abcdef");
    expect(errField).toContain("[REDACTED]");
  });

  it("redacts the voice-payload WARN err: (URL/Bearer/long-token scrubbed)", async () => {
    mockPrepareVoicePayload.mockResolvedValue(err(new Error(LEAKY)));
    const deps = createMockDeps();

    await executeVoiceResponse(deps, createMockCtx());

    const errField = warnErrFor(deps.logger, "Voice payload preparation failed");
    expect(errField).toContain("[URL]");
    expect(errField).not.toContain("https://host/synth");
    expect(errField).not.toContain("Bearer");
    expect(errField).not.toContain("sk-leak0123456789abcdef");
    expect(errField).toContain("[REDACTED]");
  });

  it("redacts the voice-send WARN err: (URL/Bearer/long-token scrubbed)", async () => {
    const deps = createMockDeps();
    const ctx = createMockCtx({
      adapter: { sendAttachment: vi.fn().mockResolvedValue(err(new Error(LEAKY))) },
    });

    await executeVoiceResponse(deps, ctx);

    const errField = warnErrFor(deps.logger, "Voice attachment send failed");
    expect(errField).toContain("[URL]");
    expect(errField).not.toContain("https://host/synth");
    expect(errField).not.toContain("Bearer");
    expect(errField).not.toContain("sk-leak0123456789abcdef");
    expect(errField).toContain("[REDACTED]");
  });

  it("passes a clean (non-secret) error message through readable in the WARN err:", async () => {
    const deps = createMockDeps({
      ttsAdapter: { synthesize: vi.fn().mockResolvedValue(err(new Error("timeout after 30s"))) },
    });

    await executeVoiceResponse(deps, createMockCtx());

    const errField = warnErrFor(deps.logger, "TTS synthesis failed");
    expect(errField).toBe("timeout after 30s");
  });
});
