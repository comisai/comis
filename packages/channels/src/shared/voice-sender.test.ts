import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "@comis/shared";
import { prepareVoicePayload, type VoicePrepareDeps } from "./voice-sender.js";

// ---------------------------------------------------------------------------
// Mock @comis/core safePath
// ---------------------------------------------------------------------------
vi.mock("@comis/core", () => ({
  safePath: vi.fn((...segments: string[]) => segments.join("/")),
}));

import { safePath } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
const mockSafePath = vi.mocked(safePath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAudioConverter() {
  return {
    toOggOpus: vi.fn<
      (inputPath: string, outputPath: string) => Promise<ReturnType<typeof ok<{ durationMs: number }, Error>>>
    >(),
    verifyOpusCodec: vi.fn<
      (filePath: string) => Promise<ReturnType<typeof ok<boolean, Error>>>
    >(),
    extractWaveform: vi.fn<
      (inputPath: string, tempDir: string) => Promise<ReturnType<typeof ok<{ waveformBase64: string }, Error>>>
    >(),
  };
}

function createDeps(overrides?: Partial<VoicePrepareDeps>): VoicePrepareDeps {
  return {
    audioConverter: createMockAudioConverter(),
    tempDir: "/tmp/comis-voice",
    logger: createMockLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prepareVoicePayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafePath.mockImplementation((...segments: string[]) => segments.join("/"));
  });

  it("should return VoicePayload on happy path", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;

    converter.toOggOpus.mockResolvedValue(ok({ durationMs: 5400 }));
    converter.verifyOpusCodec.mockResolvedValue(ok(true));
    converter.extractWaveform.mockResolvedValue(ok({ waveformBase64: "AQID" }));

    const result = await prepareVoicePayload("/input/test.wav", deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.durationSecs).toBe(5);
    expect(result.value.waveformBase64).toBe("AQID");
    expect(result.value.codecVerified).toBe(true);
    expect(result.value.oggPath).toContain("voice-");
    expect(result.value.oggPath).toContain(".ogg");
  });

  it("should propagate error when toOggOpus fails", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;

    converter.toOggOpus.mockResolvedValue(err(new Error("ffmpeg crash")));

    const result = await prepareVoicePayload("/input/test.wav", deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("ffmpeg crash");

    // verifyOpusCodec and extractWaveform should not be called
    expect(converter.verifyOpusCodec).not.toHaveBeenCalled();
    expect(converter.extractWaveform).not.toHaveBeenCalled();
  });

  it("should return error when verifyOpusCodec returns false", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;

    converter.toOggOpus.mockResolvedValue(ok({ durationMs: 3000 }));
    converter.verifyOpusCodec.mockResolvedValue(ok(false));

    const result = await prepareVoicePayload("/input/test.wav", deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Codec verification failed: file is not OGG/Opus");

    // extractWaveform should not be called after codec failure
    expect(converter.extractWaveform).not.toHaveBeenCalled();
  });

  it("should return error when verifyOpusCodec itself errors", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;

    converter.toOggOpus.mockResolvedValue(ok({ durationMs: 3000 }));
    converter.verifyOpusCodec.mockResolvedValue(err(new Error("ffprobe not found")));

    const result = await prepareVoicePayload("/input/test.wav", deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("ffprobe not found");
  });

  it("should degrade gracefully when extractWaveform fails", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;
    const logger = deps.logger as ReturnType<typeof createMockLogger>;

    converter.toOggOpus.mockResolvedValue(ok({ durationMs: 7000 }));
    converter.verifyOpusCodec.mockResolvedValue(ok(true));
    converter.extractWaveform.mockResolvedValue(err(new Error("waveform extraction failed")));

    const result = await prepareVoicePayload("/input/test.wav", deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.waveformBase64).toBe("");
    expect(result.value.durationSecs).toBe(7);
    expect(result.value.codecVerified).toBe(true);

    // logger.warn should be called for waveform failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Waveform extraction failed; voice will be sent without waveform preview",
        errorKind: "dependency",
      }),
      "Waveform extraction failed",
    );
  });

  it("should use safePath for output path construction (not path.join)", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;

    converter.toOggOpus.mockResolvedValue(ok({ durationMs: 1000 }));
    converter.verifyOpusCodec.mockResolvedValue(ok(true));
    converter.extractWaveform.mockResolvedValue(ok({ waveformBase64: "AA==" }));

    await prepareVoicePayload("/input/test.wav", deps);

    expect(mockSafePath).toHaveBeenCalledWith(
      "/tmp/comis-voice",
      expect.stringMatching(/^voice-[0-9a-f-]+\.ogg$/),
    );
  });

  it("should log DEBUG on success with correct fields", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;
    const logger = deps.logger as ReturnType<typeof createMockLogger>;

    converter.toOggOpus.mockResolvedValue(ok({ durationMs: 10000 }));
    converter.verifyOpusCodec.mockResolvedValue(ok(true));
    converter.extractWaveform.mockResolvedValue(ok({ waveformBase64: "AQID" }));

    await prepareVoicePayload("/input/test.wav", deps);

    expect(logger.debug).toHaveBeenCalledWith(
      { durationSecs: 10, codecVerified: true, hasWaveform: true },
      "Voice payload prepared",
    );
  });

  it("should log DEBUG with hasWaveform=false when waveform is empty", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;
    const logger = deps.logger as ReturnType<typeof createMockLogger>;

    converter.toOggOpus.mockResolvedValue(ok({ durationMs: 2000 }));
    converter.verifyOpusCodec.mockResolvedValue(ok(true));
    converter.extractWaveform.mockResolvedValue(err(new Error("fail")));

    await prepareVoicePayload("/input/test.wav", deps);

    expect(logger.debug).toHaveBeenCalledWith(
      { durationSecs: 2, codecVerified: true, hasWaveform: false },
      "Voice payload prepared",
    );
  });

  it("should round duration to nearest second", async () => {
    const deps = createDeps();
    const converter = deps.audioConverter as ReturnType<typeof createMockAudioConverter>;

    converter.toOggOpus.mockResolvedValue(ok({ durationMs: 3700 }));
    converter.verifyOpusCodec.mockResolvedValue(ok(true));
    converter.extractWaveform.mockResolvedValue(ok({ waveformBase64: "AA==" }));

    const result = await prepareVoicePayload("/input/test.wav", deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.durationSecs).toBe(4); // 3700ms -> 4s (Math.round)
  });
});
