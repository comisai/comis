/**
 * Tests for audio attachment handler.
 */

import type { Attachment, TranscriptionPort } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { processAudioAttachment, type AudioHandlerDeps } from "./media-handler-audio.js";
import type { MediaProcessorLogger } from "./media-preprocessor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): MediaProcessorLogger & { debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeAudioAttachment(url = "tg-file://audio1"): Attachment {
  return { type: "audio", url, mimeType: "audio/ogg", sizeBytes: 1024 };
}

function makeTranscriber(): TranscriptionPort {
  return {
    transcribe: vi.fn().mockResolvedValue(ok({ text: "hello from voice", language: "en" })),
  };
}

function makeResolver(): (att: Attachment) => Promise<Buffer | null> {
  return vi.fn().mockResolvedValue(Buffer.from("fake-audio-data"));
}

const buildHint = (att: Attachment) =>
  `[Attached: voice message (audio/ogg) — use transcribe_audio tool to listen | url: ${att.url}]`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processAudioAttachment", () => {
  it("returns hint text prefix when no transcriber", async () => {
    const deps: AudioHandlerDeps = {
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processAudioAttachment(makeAudioAttachment(), deps, buildHint);

    expect(result.textPrefix).toContain("[Attached: voice message");
    expect(result.transcription).toBeUndefined();
  });

  it("reuses att.transcription when preflight transcription exists", async () => {
    const att = makeAudioAttachment();
    att.transcription = "preflight text";
    const deps: AudioHandlerDeps = {
      transcriber: makeTranscriber(),
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processAudioAttachment(att, deps, buildHint);

    expect(result.textPrefix).toBe("[Voice message transcription]: preflight text");
    expect(result.transcription).toEqual({ attachmentUrl: att.url, text: "preflight text" });
    expect(deps.resolveAttachment).not.toHaveBeenCalled();
  });

  it("returns transcription on successful STT", async () => {
    const transcriber = makeTranscriber();
    const deps: AudioHandlerDeps = {
      transcriber,
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processAudioAttachment(makeAudioAttachment(), deps, buildHint);

    expect(result.textPrefix).toBe("[Voice message transcription]: hello from voice");
    expect(result.transcription).toEqual({
      attachmentUrl: "tg-file://audio1",
      text: "hello from voice",
      language: "en",
    });
  });

  it("returns empty result when resolve fails", async () => {
    const resolver = vi.fn().mockRejectedValue(new Error("network error"));
    const logger = makeLogger();
    const deps: AudioHandlerDeps = {
      transcriber: makeTranscriber(),
      resolveAttachment: resolver,
      logger,
    };

    const result = await processAudioAttachment(makeAudioAttachment(), deps, buildHint);

    expect(result.textPrefix).toBeUndefined();
    expect(result.transcription).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns empty result when resolve returns null", async () => {
    const deps: AudioHandlerDeps = {
      transcriber: makeTranscriber(),
      resolveAttachment: vi.fn().mockResolvedValue(null),
      logger: makeLogger(),
    };

    const result = await processAudioAttachment(makeAudioAttachment(), deps, buildHint);

    expect(result.textPrefix).toBeUndefined();
    expect(result.transcription).toBeUndefined();
  });

  it("returns empty result when transcription fails", async () => {
    const transcriber: TranscriptionPort = {
      transcribe: vi.fn().mockResolvedValue(err(new Error("API rate limited"))),
    };
    const logger = makeLogger();
    const deps: AudioHandlerDeps = {
      transcriber,
      resolveAttachment: makeResolver(),
      logger,
    };

    const result = await processAudioAttachment(makeAudioAttachment(), deps, buildHint);

    expect(result.textPrefix).toBeUndefined();
    expect(result.transcription).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns empty result when transcriber throws unexpectedly", async () => {
    const transcriber: TranscriptionPort = {
      transcribe: vi.fn().mockRejectedValue(new Error("crash")),
    };
    const logger = makeLogger();
    const deps: AudioHandlerDeps = {
      transcriber,
      resolveAttachment: makeResolver(),
      logger,
    };

    const result = await processAudioAttachment(makeAudioAttachment(), deps, buildHint);

    expect(result.textPrefix).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
