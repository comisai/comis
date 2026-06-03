// SPDX-License-Identifier: Apache-2.0
/**
 * Preset equivalence tests.
 *
 * Anchors:
 *   - expandPreset("anthropic", secretRef) deep-equals the hand-written anthropic BrokerBinding
 *   - expandPreset("finnhub", secretRef) deep-equals the hand-written finnhub BrokerBinding
 *   - PRESETS carries no secret value (no secretRef field on ProviderPreset)
 *   - expandPreset("unknown-id", ref) throws with message containing "Unknown preset"
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { expandPreset, PRESETS } from "./presets.js";
import type { BrokerBinding } from "./types.js";

describe("expandPreset", () => {
  it("returns a BrokerBinding deep-equal to the hand-written anthropic binding when called with id=anthropic", () => {
    const anthropicHandWritten: BrokerBinding = {
      secretRef: "ANTHROPIC_EXECUTOR_KEY",
      hostRules: [
        {
          pattern: { kind: "exact", host: "api.anthropic.com" },
          pathPolicy: ["/v1/*"],
          inject: [
            {
              kind: "setHeader",
              name: "x-api-key",
              format: "raw",
              removeAuthorization: true,
            },
          ],
        },
      ],
    };

    const result = expandPreset("anthropic", "ANTHROPIC_EXECUTOR_KEY");
    expect(result).toEqual(anthropicHandWritten);
  });

  it("returns a BrokerBinding deep-equal to the hand-written finnhub binding when called with id=finnhub", () => {
    const finnhubHandWritten: BrokerBinding = {
      secretRef: "FINNHUB_TOKEN",
      hostRules: [
        {
          pattern: { kind: "exact", host: "finnhub.io" },
          inject: [{ kind: "setParam", name: "token" }],
        },
      ],
    };

    const result = expandPreset("finnhub", "FINNHUB_TOKEN");
    expect(result).toEqual(finnhubHandWritten);
  });

  it('throws with message containing "Unknown preset" for an unrecognised preset id', () => {
    expect(() => expandPreset("unknown-id", "some-ref")).toThrow("Unknown preset");
  });
});

describe("PRESETS", () => {
  it("PRESETS contains no secret value — no secretRef field on any ProviderPreset entry", () => {
    for (const preset of PRESETS) {
      expect(
        preset,
        `Preset ${preset.id} must not carry a secretRef field`,
      ).not.toHaveProperty("secretRef");
    }
  });

  it("PRESETS has entries for both anthropic and finnhub", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("finnhub");
  });
});
