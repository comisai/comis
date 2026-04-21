// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { ImageGenerationPort, ImageGenInput } from "./provider.js";

describe("Provider interface", () => {
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
      estimateCost: (_input: ImageGenInput) => 0.02,
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

  it("estimateCost returns a number", () => {
    const provider = createMockProvider();
    expect(provider.estimateCost!({ prompt: "test" })).toBe(0.02);
  });

  it("provider without estimateCost satisfies interface", async () => {
    const provider: ImageGenerationPort = {
      id: "minimal",
      isAvailable: () => false,
      execute: async () => ({
        ok: false as const,
        error: new Error("not available"),
      }),
    };
    expect(provider.estimateCost).toBeUndefined();
    const result = await provider.execute({ prompt: "test" });
    expect(result.ok).toBe(false);
  });
});
