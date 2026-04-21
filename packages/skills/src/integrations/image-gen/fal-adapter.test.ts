// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFalAdapter } from "./fal-adapter.js";

vi.mock("@fal-ai/client", () => {
  const config = vi.fn();
  const subscribe = vi.fn();
  return { fal: { config, subscribe } };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fal } = await import("@fal-ai/client");
const mockSubscribe = fal.subscribe as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createFalAdapter", () => {
  it("isAvailable returns true", () => {
    const adapter = createFalAdapter({ apiKey: "test-key" });
    expect(adapter.isAvailable()).toBe(true);
  });

  it("id is fal", () => {
    const adapter = createFalAdapter({ apiKey: "test-key" });
    expect(adapter.id).toBe("fal");
  });

  it("calls fal.subscribe with correct model and prompt", async () => {
    const imageBytes = Buffer.from("fake-png");
    mockSubscribe.mockResolvedValueOnce({
      data: { images: [{ url: "https://cdn.fal.ai/test.png" }] },
    });

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(imageBytes.buffer),
    }) as unknown as typeof fetch;

    const adapter = createFalAdapter({ apiKey: "test-key" });
    const result = await adapter.execute({ prompt: "a cat", safetyChecker: true });

    expect(mockSubscribe).toHaveBeenCalledWith("fal-ai/flux/dev", {
      input: {
        prompt: "a cat",
        image_size: "square_hd",
        num_images: 1,
        enable_safety_checker: true,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("image/png");
      expect(result.value.buffer).toBeInstanceOf(Buffer);
    }

    globalThis.fetch = originalFetch;
  });

  it("returns err when fal.subscribe throws", async () => {
    mockSubscribe.mockRejectedValueOnce(new Error("API error"));

    const adapter = createFalAdapter({ apiKey: "test-key" });
    const result = await adapter.execute({ prompt: "fail" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("API error");
    }
  });

  it("uses custom model when provided", async () => {
    mockSubscribe.mockResolvedValueOnce({
      data: { images: [{ url: "https://cdn.fal.ai/test.png" }] },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from("img").buffer),
    }) as unknown as typeof fetch;

    const adapter = createFalAdapter({ apiKey: "key", model: "fal-ai/flux/schnell" });
    await adapter.execute({ prompt: "test" });

    expect(mockSubscribe).toHaveBeenCalledWith(
      "fal-ai/flux/schnell",
      expect.any(Object),
    );

    globalThis.fetch = originalFetch;
  });
});
