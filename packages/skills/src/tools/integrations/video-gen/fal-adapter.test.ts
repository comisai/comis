// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the FAL queue-API video adapter (DIVERGENCE 1).
 *
 * The `@fal-ai/client` MODULE mock is built INSIDE `vi.hoisted()` so the import
 * binding resolves at hoist time (the Phase-185 SDK-mock lesson). FAL exports a
 * SINGLETON object (not a class), so the mock is a plain object —
 * `{ config, queue: { submit, status, result } }` — NOT a class default export.
 *
 * The adapter MUST use `fal.queue.submit/status/result` (the durable request_id
 * path), NEVER `fal.subscribe`. The FAL status union has only IN_QUEUE /
 * IN_PROGRESS / COMPLETED — failures are THROWN, not a "FAILED" status.
 *
 * @module
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const falMock = vi.hoisted(() => {
  return {
    config: vi.fn(),
    queue: {
      submit: vi.fn(),
      status: vi.fn(),
      result: vi.fn(),
    },
  };
});

vi.mock("@fal-ai/client", () => ({ fal: falMock }));

import { createFalVideoAdapter } from "./fal-adapter.js";

function stubFetch(bytes: Buffer): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

beforeEach(() => {
  falMock.config.mockReset();
  falMock.queue.submit.mockReset();
  falMock.queue.status.mockReset();
  falMock.queue.result.mockReset();
});

describe("createFalVideoAdapter — identity + config", () => {
  it("id is fal and isAvailable returns true; fal.config is called with the credentials", () => {
    const adapter = createFalVideoAdapter({ apiKey: "test-key" });
    expect(adapter.id).toBe("fal");
    expect(adapter.isAvailable()).toBe(true);
    expect(falMock.config).toHaveBeenCalledWith({ credentials: "test-key" });
  });
});

describe("submit", () => {
  it("uses fal.queue.submit on the default endpoint and returns the request_id as jobId", async () => {
    falMock.queue.submit.mockResolvedValueOnce({ request_id: "req-abc-123" });
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.submit({ prompt: "a sunset timelapse" });

    expect(falMock.queue.submit).toHaveBeenCalledWith(
      "fal-ai/veo3.1/fast",
      expect.objectContaining({ input: expect.objectContaining({ prompt: "a sunset timelapse" }) }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.jobId).toBe("req-abc-123");
      expect(res.value.provider).toBe("fal");
      expect(res.value.model).toBe("fal-ai/veo3.1/fast");
    }
  });

  it("VPORT-03: the jobId is the opaque request_id and contains NO secret", async () => {
    falMock.queue.submit.mockResolvedValueOnce({ request_id: "req-opaque-xyz" });
    const adapter = createFalVideoAdapter({ apiKey: "super-secret-key-9999" });

    const res = await adapter.submit({ prompt: "p" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const serialized = JSON.stringify(res.value);
      expect(serialized).not.toContain("super-secret-key-9999");
      expect(res.value.jobId).toBe("req-opaque-xyz");
    }
  });
});

describe("poll", () => {
  it("maps COMPLETED -> done and passes the jobId verbatim (stable)", async () => {
    falMock.queue.status.mockResolvedValueOnce({ status: "COMPLETED" });
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.poll({ jobId: "req-1", provider: "fal", model: "m" });

    expect(falMock.queue.status).toHaveBeenCalledWith("fal-ai/veo3.1/fast", { requestId: "req-1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.state).toBe("done");
      expect(res.value.jobId).toBe("req-1");
    }
  });

  it("maps IN_QUEUE / IN_PROGRESS -> pending", async () => {
    const adapter = createFalVideoAdapter({ apiKey: "k" });
    for (const status of ["IN_QUEUE", "IN_PROGRESS"]) {
      falMock.queue.status.mockResolvedValueOnce({ status });
      const res = await adapter.poll({ jobId: "req-2", provider: "fal", model: "m" });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.state).toBe("pending");
    }
  });
});

describe("fetchResult", () => {
  it("reads data.video.url, downloads it to a Buffer, and returns a video/mp4 output", async () => {
    const bytes = Buffer.from("fake-mp4-bytes");
    falMock.queue.result.mockResolvedValueOnce({
      data: { video: { url: "https://cdn.fal.ai/out.mp4" } },
      requestId: "req-3",
    });
    const restore = stubFetch(bytes);
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.fetchResult({ jobId: "req-3", provider: "fal", model: "m" });
    restore();

    expect(falMock.queue.result).toHaveBeenCalledWith("fal-ai/veo3.1/fast", { requestId: "req-3" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.mimeType).toBe("video/mp4");
      expect(res.value.buffer).toBeInstanceOf(Buffer);
      expect(res.value.sourceUrl).toBe("https://cdn.fal.ai/out.mp4");
      expect(res.value.provider).toBe("fal");
    }
  });

  it("throws (-> err) when COMPLETED carries no video.url", async () => {
    falMock.queue.result.mockResolvedValueOnce({ data: {}, requestId: "req-4" });
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.fetchResult({ jobId: "req-4", provider: "fal", model: "m" });

    expect(res.ok).toBe(false);
  });
});

describe("execute — the inline submit -> poll -> download loop", () => {
  it("happy path: submit, poll pending then done, fetch -> ok output", async () => {
    falMock.queue.submit.mockResolvedValueOnce({ request_id: "req-h" });
    falMock.queue.status
      .mockResolvedValueOnce({ status: "IN_QUEUE" })
      .mockResolvedValueOnce({ status: "IN_PROGRESS" })
      .mockResolvedValueOnce({ status: "COMPLETED" });
    falMock.queue.result.mockResolvedValueOnce({
      data: { video: { url: "https://cdn.fal.ai/h.mp4" } },
      requestId: "req-h",
    });
    const restore = stubFetch(Buffer.from("vid"));
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.execute(
      { prompt: "p" },
      { timeoutMs: 5_000, pollIntervalMs: 1 },
    );
    restore();

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.mimeType).toBe("video/mp4");
      expect(res.value.sourceUrl).toBe("https://cdn.fal.ai/h.mp4");
    }
  });

  it("FAL-02: COMPLETED with no video.url -> empty_response with a hint", async () => {
    falMock.queue.submit.mockResolvedValueOnce({ request_id: "req-e" });
    falMock.queue.status.mockResolvedValueOnce({ status: "COMPLETED" });
    falMock.queue.result.mockResolvedValueOnce({ data: {}, requestId: "req-e" });
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.execute({ prompt: "p" }, { timeoutMs: 5_000, pollIntervalMs: 1 });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const e = res.error as { videoErrorKind?: string; hint?: string };
      expect(e.videoErrorKind).toBe("empty_response");
      expect(e.hint && e.hint.length).toBeGreaterThan(0);
    }
  });

  it("FAL-02: a thrown 401 from status -> auth_required with a FAL_KEY hint", async () => {
    falMock.queue.submit.mockResolvedValueOnce({ request_id: "req-a" });
    falMock.queue.status.mockRejectedValueOnce(new Error("Request failed with status 401"));
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.execute({ prompt: "p" }, { timeoutMs: 5_000, pollIntervalMs: 1 });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const e = res.error as { videoErrorKind?: string; hint?: string };
      expect(e.videoErrorKind).toBe("auth_required");
      expect(e.hint).toMatch(/FAL_KEY/);
    }
  });

  it("FAL-02: a thrown moderation error from status -> content_blocked", async () => {
    falMock.queue.submit.mockResolvedValueOnce({ request_id: "req-m" });
    falMock.queue.status.mockRejectedValueOnce(new Error("blocked by moderation policy"));
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.execute({ prompt: "p" }, { timeoutMs: 5_000, pollIntervalMs: 1 });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const e = res.error as { videoErrorKind?: string };
      expect(e.videoErrorKind).toBe("content_blocked");
    }
  });

  it("VPORT-02: an always-pending job exceeds timeoutMs -> job_timeout, hint carries the jobId", async () => {
    falMock.queue.submit.mockResolvedValueOnce({ request_id: "req-timeout-77" });
    falMock.queue.status.mockResolvedValue({ status: "IN_PROGRESS" });
    const adapter = createFalVideoAdapter({ apiKey: "k" });

    const res = await adapter.execute({ prompt: "p" }, { timeoutMs: 5, pollIntervalMs: 1 });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const e = res.error as { videoErrorKind?: string; hint?: string };
      expect(e.videoErrorKind).toBe("job_timeout");
      expect(e.hint).toMatch(/req-timeout-77/);
    }
  });

  it("VPORT-03: neither the job nor the output (nor the error) leaks the apiKey on the happy path", async () => {
    falMock.queue.submit.mockResolvedValueOnce({ request_id: "req-clean" });
    falMock.queue.status.mockResolvedValueOnce({ status: "COMPLETED" });
    falMock.queue.result.mockResolvedValueOnce({
      data: { video: { url: "https://cdn.fal.ai/c.mp4" } },
      requestId: "req-clean",
    });
    const restore = stubFetch(Buffer.from("v"));
    const adapter = createFalVideoAdapter({ apiKey: "leak-canary-key-42" });

    const res = await adapter.execute({ prompt: "p" }, { timeoutMs: 5_000, pollIntervalMs: 1 });
    restore();

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(JSON.stringify(res.value)).not.toContain("leak-canary-key-42");
    }
  });
});
