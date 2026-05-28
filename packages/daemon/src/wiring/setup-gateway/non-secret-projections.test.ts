// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { agentSummaries, channelSummaries } from "./non-secret-projections.js";

describe("agentSummaries", () => {
  it("projects only id/name/provider/model and drops secret-shaped fields", () => {
    const out = agentSummaries({
      default: {
        name: "Comis",
        provider: "anthropic",
        model: "claude",
        // secret-shaped fields adjacent to the projected scalars — must NOT leak
        apiKey: "sk-LEAK-TOKEN",
        modelFailover: { authProfiles: [{ keyName: "ANTHROPIC_API_KEY" }] },
      } as never,
    });

    expect(out).toEqual([
      { id: "default", name: "Comis", provider: "anthropic", model: "claude" },
    ]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("sk-LEAK-TOKEN");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
    expect(serialized).not.toContain("apiKey");
  });

  it("applies defaults for missing fields and returns [] for no agents", () => {
    expect(agentSummaries({ a: {} as never })).toEqual([
      { id: "a", name: "Comis", provider: "unknown", model: "unknown" },
    ]);
    expect(agentSummaries(undefined)).toEqual([]);
  });
});

describe("channelSummaries", () => {
  it("projects name/enabled, excludes healthCheck, and drops secret-shaped fields", () => {
    const out = channelSummaries({
      telegram: { enabled: true, botToken: "tok-LEAK" } as never,
      discord: { enabled: false, token: "tok-LEAK-2" } as never,
      healthCheck: { enabled: true } as never,
    });

    expect(out).toEqual([
      { name: "telegram", enabled: true },
      { name: "discord", enabled: false },
    ]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("tok-LEAK");
    expect(serialized).not.toContain("botToken");
  });

  it("returns [] for undefined channels", () => {
    expect(channelSummaries(undefined)).toEqual([]);
  });
});
