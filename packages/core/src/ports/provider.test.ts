// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ok, type Result } from "@comis/shared";
import type {
  ImageGenerationPort,
  ImageGenInput,
  VideoGenInput,
  VideoGenJob,
  VideoJobStatus,
  VideoGenOutput,
  VideoGenerationPort,
} from "./provider.js";

describe("ImageGenerationPort interface", () => {
  // NOTE: Inlined the previous Provider<TInput, TOutput> generic into
  // ImageGenerationPort and dropped the optional estimateCost field
  // (zero production callers). Tests that exercised estimateCost or the
  // generic-as-Provider shape were dropped in the same commit.

  /**
   * Type-level test: a mock implementation satisfies ImageGenerationPort.
   */
  function createMockProvider(): ImageGenerationPort {
    return {
      id: "mock",
      isAvailable: () => true,
      execute: async (_input: ImageGenInput) => ({
        ok: true as const,
        value: { buffer: Buffer.from("test"), mimeType: "image/png" },
      }),
    };
  }

  it("mock provider returns ok result with buffer and mimeType", async () => {
    const provider = createMockProvider();
    const result = await provider.execute({ prompt: "a cat" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toBeInstanceOf(Buffer);
      expect(result.value.mimeType).toBe("image/png");
    }
  });

  it("isAvailable returns boolean", () => {
    const provider = createMockProvider();
    expect(provider.isAvailable()).toBe(true);
  });

  it("provider without optional fields satisfies interface", async () => {
    const provider: ImageGenerationPort = {
      id: "minimal",
      isAvailable: () => false,
      execute: async () => ({
        ok: false as const,
        error: new Error("not available"),
      }),
    };
    const result = await provider.execute({ prompt: "test" });
    expect(result.ok).toBe(false);
  });
});

/**
 * VPORT-01: a mock VideoGenerationPort must round-trip submit → poll(done) →
 * fetchResult and yield a VideoGenOutput. This pins the port's job-handle shape
 * (the inline execute() baseline is wired in Plan 03; the type must expose
 * submit/poll/fetchResult so Phase 189's background poller can drive the loop
 * externally byte-for-byte).
 *
 * VPORT-03: VideoGenJob.jobId is a plain string field documented opaque and
 * secret-free (the opaque FAL request_id). The no-secret RUNTIME assertion lands
 * in Plan 03's adapter test; here the TYPE must carry jobId: string.
 */
describe("VideoGenerationPort interface", () => {
  /** A minimal in-memory port that records a submit and returns a done status. */
  function createMockVideoPort(): VideoGenerationPort {
    return {
      id: "mock",
      isAvailable: () => true,
      submit(_input: VideoGenInput): Promise<Result<VideoGenJob, Error>> {
        return Promise.resolve(ok({ jobId: "req-abc-123", provider: "mock", model: "mock-video" }));
      },
      poll(job: VideoGenJob): Promise<Result<VideoJobStatus, Error>> {
        return Promise.resolve(ok({ jobId: job.jobId, state: "done" }));
      },
      fetchResult(job: VideoGenJob): Promise<Result<VideoGenOutput, Error>> {
        return Promise.resolve(
          ok({
            buffer: Buffer.from("fake-mp4-bytes"),
            mimeType: "video/mp4",
            durationSecs: 8,
            provider: job.provider,
            model: job.model,
          }),
        );
      },
      execute(input: VideoGenInput): Promise<Result<VideoGenOutput, Error>> {
        return Promise.resolve(
          ok({ buffer: Buffer.from("fake-mp4-bytes"), mimeType: "video/mp4", model: input.model }),
        );
      },
    };
  }

  it("round-trips submit then poll(done) then fetchResult to a VideoGenOutput (VPORT-01)", async () => {
    const port = createMockVideoPort();

    const submitted = await port.submit({ prompt: "a cat riding a skateboard" });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    // VPORT-03: the durable handle carries a plain-string opaque jobId.
    const job = submitted.value;
    expect(typeof job.jobId).toBe("string");
    expect(job.jobId.length).toBeGreaterThan(0);

    const status = await port.poll(job);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    // The jobId is stable across poll() (Phase 189 poller relies on this).
    expect(status.value.jobId).toBe(job.jobId);
    expect(status.value.state).toBe("done");

    const result = await port.fetchResult(job);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("video/mp4");
    expect(Buffer.isBuffer(result.value.buffer)).toBe(true);
  });

  it("exposes an inline execute() that yields a VideoGenOutput with mp4 mime", async () => {
    const port = createMockVideoPort();
    const result = await port.execute(
      { prompt: "a sunset timelapse" },
      { timeoutMs: 300_000, pollIntervalMs: 10_000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("video/mp4");
  });

  it("models a poll() snapshot whose state is one of the normalized lifecycle values", () => {
    const states: VideoJobStatus["state"][] = ["pending", "done", "failed"];
    expect(states).toContain("done");
  });
});
