// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ProviderCapabilitiesSchema } from "./provider-capabilities.js";

describe("ProviderCapabilitiesSchema — probeServedWindow", () => {
  it("parses empty object without throwing (field is optional)", () => {
    const result = ProviderCapabilitiesSchema.parse({});
    expect(result.probeServedWindow).toBeUndefined();
  });

  it("parses probeServedWindow: false", () => {
    const result = ProviderCapabilitiesSchema.parse({ probeServedWindow: false });
    expect(result.probeServedWindow).toBe(false);
  });

  it("parses probeServedWindow: true", () => {
    const result = ProviderCapabilitiesSchema.parse({ probeServedWindow: true });
    expect(result.probeServedWindow).toBe(true);
  });
});
