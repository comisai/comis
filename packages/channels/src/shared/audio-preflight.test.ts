/**
 * Tests for audio preflight: pre-mention-gate voice transcription.
 */

import type { NormalizedMessage, Attachment, TranscriptionPort } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { audioPreflight, type PreflightDeps } from "./audio-preflight.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "group-chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "original text",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeAudioAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    type: "audio",
    url: "tg-file://voice1",
    mimeType: "audio/ogg",
    sizeBytes: 1024,
    ...overrides,
  };
}

function makeTranscriber(text = "hello from voice"): TranscriptionPort {
  return {
    transcribe: vi.fn().mockResolvedValue(ok({ text, language: "en" })),
  };
}

function makeResolver(): (att: Attachment) => Promise<Buffer | null> {
  return vi.fn().mockResolvedValue(Buffer.from("fake-audio-data"));
}

function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    transcriber: makeTranscriber(),
    resolveAttachment: makeResolver(),
    botNames: ["Comis"],
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audioPreflight", () => {
  it("returns unchanged message when no audio attachments", async () => {
    const deps = makeDeps();
    const msg = makeMessage({ attachments: [] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(false);
    expect(result.message).toBe(msg);
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("returns unchanged message when only image attachments", async () => {
    const deps = makeDeps();
    const msg = makeMessage({
      attachments: [{ type: "image", url: "tg-file://img1", mimeType: "image/jpeg" }],
    });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(false);
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("transcribes voice message and sets transcription on attachment", async () => {
    const deps = makeDeps({ transcriber: makeTranscriber("hey everyone") });
    const audioAtt = makeAudioAttachment();
    const msg = makeMessage({ attachments: [audioAtt] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(true);
    // Attachment should have transcription set
    const enrichedAtt = result.message.attachments[0]!;
    expect(enrichedAtt.transcription).toBe("hey everyone");
  });

  it("enriches message text with transcript appended to original", async () => {
    const deps = makeDeps({ transcriber: makeTranscriber("the transcript") });
    const msg = makeMessage({
      text: "original text",
      attachments: [makeAudioAttachment()],
    });

    const result = await audioPreflight(deps, msg);

    expect(result.message.text).toBe("original text\nthe transcript");
  });

  it("uses transcript as text when original text is empty", async () => {
    const deps = makeDeps({ transcriber: makeTranscriber("voice only") });
    const msg = makeMessage({
      text: "",
      attachments: [makeAudioAttachment()],
    });

    const result = await audioPreflight(deps, msg);

    expect(result.message.text).toBe("voice only");
  });

  it("sets isBotMentioned when transcript contains bot name", async () => {
    const deps = makeDeps({
      transcriber: makeTranscriber("Hey Comis, what time is it?"),
      botNames: ["Comis"],
    });
    const msg = makeMessage({ attachments: [makeAudioAttachment()] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(true);
    expect(result.message.metadata?.isBotMentioned).toBe(true);
  });

  it("matches bot name case-insensitively", async () => {
    const deps = makeDeps({
      transcriber: makeTranscriber("hey comis can you help"),
      botNames: ["Comis"],
    });
    const msg = makeMessage({ attachments: [makeAudioAttachment()] });

    const result = await audioPreflight(deps, msg);

    expect(result.message.metadata?.isBotMentioned).toBe(true);
  });

  it("does NOT set isBotMentioned when transcript does not contain bot name", async () => {
    const deps = makeDeps({
      transcriber: makeTranscriber("hey everyone, how are you?"),
      botNames: ["Comis"],
    });
    const msg = makeMessage({ attachments: [makeAudioAttachment()] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(true);
    expect(result.message.metadata?.isBotMentioned).toBeUndefined();
  });

  it("skips attachment that already has transcription set", async () => {
    const deps = makeDeps();
    const audioAtt = makeAudioAttachment({ transcription: "already done" });
    const msg = makeMessage({ attachments: [audioAtt] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(false);
    expect(result.message).toBe(msg);
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("returns unchanged message on transcription failure (graceful degradation)", async () => {
    const transcriber: TranscriptionPort = {
      transcribe: vi.fn().mockResolvedValue(err(new Error("STT service unavailable"))),
    };
    const deps = makeDeps({ transcriber });
    const msg = makeMessage({ attachments: [makeAudioAttachment()] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(false);
    expect(result.message).toBe(msg);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      "Preflight transcription failed",
    );
  });

  it("returns unchanged message on resolve failure (graceful degradation)", async () => {
    const resolver = vi.fn().mockRejectedValue(new Error("network timeout"));
    const deps = makeDeps({ resolveAttachment: resolver });
    const msg = makeMessage({ attachments: [makeAudioAttachment()] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(false);
    expect(result.message).toBe(msg);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "network" }),
      "Preflight resolve failed",
    );
  });

  it("returns unchanged message when resolve returns null", async () => {
    const resolver = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({ resolveAttachment: resolver });
    const msg = makeMessage({ attachments: [makeAudioAttachment()] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(false);
    expect(result.message).toBe(msg);
  });

  it("checks multiple bot names for voice mention", async () => {
    const deps = makeDeps({
      transcriber: makeTranscriber("yo Jarvis, do something"),
      botNames: ["Comis", "Jarvis", "Athena"],
    });
    const msg = makeMessage({ attachments: [makeAudioAttachment()] });

    const result = await audioPreflight(deps, msg);

    expect(result.message.metadata?.isBotMentioned).toBe(true);
  });

  it("ignores empty bot names", async () => {
    const deps = makeDeps({
      transcriber: makeTranscriber("hello world"),
      botNames: ["", "  "], // empty names should be ignored (empty string guard: name.length > 0)
    });
    const msg = makeMessage({ attachments: [makeAudioAttachment()] });

    const result = await audioPreflight(deps, msg);

    // Empty string should not cause false positive match
    expect(result.message.metadata?.isBotMentioned).toBeUndefined();
  });

  it("detects audio by mimeType even when type is 'file'", async () => {
    const deps = makeDeps({ transcriber: makeTranscriber("detected by mime") });
    const att: Attachment = {
      type: "file",
      url: "tg-file://audio-as-file",
      mimeType: "audio/mpeg",
    };
    const msg = makeMessage({ attachments: [att] });

    const result = await audioPreflight(deps, msg);

    expect(result.transcribed).toBe(true);
    expect(result.message.attachments[0]!.transcription).toBe("detected by mime");
  });
});
