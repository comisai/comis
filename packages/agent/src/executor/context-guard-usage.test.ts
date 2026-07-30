// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { resolveContextGuardUsage } from "./context-guard-usage.js";

describe("context guard usage", () => {
  it("prefers the assembled dispatch over the unassembled SDK transcript", () => {
    const getSdkUsage = vi.fn(() => ({
      tokens: 310_541,
      contextWindow: 272_000,
      percent: 114.16948529411766,
    }));

    expect(
      resolveContextGuardUsage({
        assembledInputTokens: 189_463,
        effectiveWindow: 272_000,
        getSdkUsage,
      }),
    ).toEqual({
      tokens: 189_463,
      contextWindow: 272_000,
      percent: (189_463 / 272_000) * 100,
      source: "assembled",
    });
    expect(getSdkUsage).not.toHaveBeenCalled();
  });

  it("falls back to SDK usage before the first assembled dispatch", () => {
    const sdkUsage = {
      tokens: 4_000,
      contextWindow: 32_000,
      percent: 12.5,
    };

    expect(
      resolveContextGuardUsage({
        assembledInputTokens: 0,
        effectiveWindow: Number.POSITIVE_INFINITY,
        getSdkUsage: () => sdkUsage,
      }),
    ).toEqual({ ...sdkUsage, source: "sdk" });
  });
});
