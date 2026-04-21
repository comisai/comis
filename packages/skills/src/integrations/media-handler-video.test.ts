// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for video attachment handler.
 */

import type { Attachment } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { processVideoAttachment, type VideoHandlerDeps } from "./media-handler-video.js";
import type { MediaProcessorLogger } from "./media-preprocessor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): MediaProcessorLogger & { debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeVideoAttachment(url = "tg-file://video1"): Attachment {
  return { type: "video", url, mimeType: "video/mp4", sizeBytes: 5_000_000 };
}

function makeVideoDescriber() {
  return vi.fn().mockResolvedValue(
    ok({ text: "A person walks through a garden", provider: "google", model: "gemini-2.0-flash" }),
  );
}

function makeResolver(): (att: Attachment) => Promise<Buffer | null> {
  return vi.fn().mockResolvedValue(Buffer.from("fake-video-data"));
}

const buildHint = (att: Attachment) =>
  `[Attached: video (${att.mimeType ?? "video/mp4"}) — use describe_video tool to view | url: ${att.url}]`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processVideoAttachment", () => {
  it("returns hint text prefix when no describer", async () => {
    const deps: VideoHandlerDeps = {
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processVideoAttachment(makeVideoAttachment(), deps, buildHint);

    expect(result.textPrefix).toContain("[Attached: video");
    expect(result.videoDescription).toBeUndefined();
  });

  it("returns description on successful describe", async () => {
    const deps: VideoHandlerDeps = {
      describeVideo: makeVideoDescriber(),
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processVideoAttachment(makeVideoAttachment(), deps, buildHint);

    expect(result.textPrefix).toBe("[Video description]: A person walks through a garden");
    expect(result.videoDescription).toEqual({
      attachmentUrl: "tg-file://video1",
      description: "A person walks through a garden",
    });
  });

  it("truncates description to maxVideoDescriptionChars", async () => {
    const longText = "x".repeat(800);
    const describeVideo = vi.fn().mockResolvedValue(
      ok({ text: longText, provider: "google", model: "gemini-2.0-flash" }),
    );
    const deps: VideoHandlerDeps = {
      describeVideo,
      resolveAttachment: makeResolver(),
      maxVideoDescriptionChars: 100,
      logger: makeLogger(),
    };

    const result = await processVideoAttachment(makeVideoAttachment(), deps, buildHint);

    expect(result.videoDescription!.description).toHaveLength(100);
  });

  it("returns empty result when describer returns error", async () => {
    const describeVideo = vi.fn().mockResolvedValue(err(new Error("Gemini quota exceeded")));
    const logger = makeLogger();
    const deps: VideoHandlerDeps = {
      describeVideo,
      resolveAttachment: makeResolver(),
      logger,
    };

    const result = await processVideoAttachment(makeVideoAttachment(), deps, buildHint);

    expect(result.textPrefix).toBeUndefined();
    expect(result.videoDescription).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns empty result when describer throws", async () => {
    const describeVideo = vi.fn().mockRejectedValue(new Error("crash"));
    const logger = makeLogger();
    const deps: VideoHandlerDeps = {
      describeVideo,
      resolveAttachment: makeResolver(),
      logger,
    };

    const result = await processVideoAttachment(makeVideoAttachment(), deps, buildHint);

    expect(result.textPrefix).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns empty result when resolve fails", async () => {
    const logger = makeLogger();
    const deps: VideoHandlerDeps = {
      describeVideo: makeVideoDescriber(),
      resolveAttachment: vi.fn().mockRejectedValue(new Error("network error")),
      logger,
    };

    const result = await processVideoAttachment(makeVideoAttachment(), deps, buildHint);

    expect(result.textPrefix).toBeUndefined();
    expect(result.videoDescription).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns empty result when resolve returns null", async () => {
    const deps: VideoHandlerDeps = {
      describeVideo: makeVideoDescriber(),
      resolveAttachment: vi.fn().mockResolvedValue(null),
      logger: makeLogger(),
    };

    const result = await processVideoAttachment(makeVideoAttachment(), deps, buildHint);

    expect(result.textPrefix).toBeUndefined();
    expect(result.videoDescription).toBeUndefined();
  });
});
