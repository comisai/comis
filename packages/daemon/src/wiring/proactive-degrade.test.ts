// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  assertProactiveFailureIsSupported,
  isAutonomyDisabledProactiveMiss,
  proactiveNotArmedLogFields,
  proactiveNotArmedMessage,
} from "./proactive-degrade.js";

const missingCapabilityEndpoint = {
  code: "dependency_unavailable",
  message: "Missing proactive dependencies: capEndpointHandle (1 of 11 unavailable)",
};

describe("proactive scheduler degradation reason", () => {
  it("accepts a missing capability endpoint only when autonomy is disabled", () => {
    expect(isAutonomyDisabledProactiveMiss(
      missingCapabilityEndpoint,
      "autonomy_disabled",
    )).toBe(true);
    expect(isAutonomyDisabledProactiveMiss(
      missingCapabilityEndpoint,
      "activation_failed",
    )).toBe(false);
  });

  it("degrades with activation-specific guidance when endpoint activation fails", () => {
    expect(() => assertProactiveFailureIsSupported(
      { ok: false, error: missingCapabilityEndpoint },
      "activation_failed",
    )).not.toThrow();
    const fields = proactiveNotArmedLogFields("activation_failed");
    expect(fields.hint).toContain("config.dataDir");
    expect(fields.hint).not.toContain("autonomy.enabled");
    expect(proactiveNotArmedMessage("activation_failed")).toContain("activation failed");
  });

  it("rejects unrelated proactive dependency failures", () => {
    expect(() => assertProactiveFailureIsSupported(
      {
        ok: false,
        error: {
          code: "dependency_unavailable",
          message: "Missing proactive dependencies: deliveryService (1 of 11 unavailable)",
        },
      },
      "activation_failed",
    )).toThrow("Proactive scheduler activation failed");
  });
});
