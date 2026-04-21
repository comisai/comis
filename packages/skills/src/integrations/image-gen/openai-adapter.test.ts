// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAIImageAdapter } from "./openai-adapter.js";

const mockGenerate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      images = { generate: mockGenerate };
    },
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  mockGenerate.mockReset();
});

describe("createOpenAIImageAdapter", () => {
  it("id is openai", () => {
    const adapter = createOpenAIImageAdapter({ apiKey: "test-key" });
    expect(adapter.id).toBe("openai");
  });

  it("isAvailable returns true", () => {
    const adapter = createOpenAIImageAdapter({ apiKey: "test-key" });
    expect(adapter.isAvailable()).toBe(true);
  });

  it("calls images.generate with gpt-image-1 and decodes base64", async () => {
    const testContent = "hello image";
    const b64 = Buffer.from(testContent).toString("base64");
    mockGenerate.mockResolvedValueOnce({
      data: [{ b64_json: b64 }],
    });

    const adapter = createOpenAIImageAdapter({ apiKey: "test-key" });
    const result = await adapter.execute({ prompt: "a dog", size: "1024x1024" });

    expect(mockGenerate).toHaveBeenCalledWith({
      model: "gpt-image-1",
      prompt: "a dog",
      n: 1,
      size: "1024x1024",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("image/png");
      expect(result.value.buffer.toString()).toBe(testContent);
    }
  });

  it("returns err on API failure", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("rate limited"));

    const adapter = createOpenAIImageAdapter({ apiKey: "test-key" });
    const result = await adapter.execute({ prompt: "fail" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("rate limited");
    }
  });

  it("returns err when no b64_json in response", async () => {
    mockGenerate.mockResolvedValueOnce({ data: [{}] });

    const adapter = createOpenAIImageAdapter({ apiKey: "test-key" });
    const result = await adapter.execute({ prompt: "test" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no base64");
    }
  });
});
