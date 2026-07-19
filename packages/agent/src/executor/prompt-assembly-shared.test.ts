// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { computeFeatureFlagHash, renderResponseLocalePolicy } from "./prompt-assembly-shared.js";

describe("prompt assembly shared helpers", () => {
  it("renders an explicit response locale without a closed language list", () => {
    expect(renderResponseLocalePolicy({ locale: "he-IL", source: "operator" })).toContain("he-IL");
  });

  it("computes stable hashes for identical feature inputs", () => {
    const input = { toolPolicy: { mode: "allowlist" }, tools: { enabledGroups: ["read"] } };
    expect(computeFeatureFlagHash(input)).toBe(computeFeatureFlagHash(input));
  });
});
