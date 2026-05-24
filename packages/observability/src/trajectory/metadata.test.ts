// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for buildTraceMetadata (LIFE-01, design §5 D4).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { buildTraceMetadata, type TraceMetadataParams } from "./metadata.js";

const baseParams: TraceMetadataParams = {
  harness: { type: "comis", version: "1.0.41", os: "linux", node: "v22.0.0" },
  model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
  config: { appName: "comis" },
  plugins: [],
  skills: [],
  prompting: {},
  redaction: { policy: "platform-aware" },
};

describe("buildTraceMetadata (LIFE-01)", () => {
  it("returns the 7 top-level keys per design §5 D4", () => {
    const payload = buildTraceMetadata(baseParams);
    expect(Object.keys(payload).sort()).toEqual(
      ["config", "harness", "model", "plugins", "prompting", "redaction", "skills"].sort(),
    );
  });

  it("redacts apiKey-shaped fields in config via sanitizeForPersistence", () => {
    const payload = buildTraceMetadata({
      ...baseParams,
      config: { apiKey: "sk-XXX", appName: "comis", db: { password: "p1" } },
    });
    const config = payload.config as Record<string, unknown>;
    expect(config.appName).toBe("comis");
    // sanitizeForPersistence redacts apiKey/password — assert NOT the original string.
    expect(JSON.stringify(payload)).not.toContain("sk-XXX");
    expect(JSON.stringify(payload)).not.toContain("p1");
  });

  it("omits undefined optional harness fields", () => {
    const payload = buildTraceMetadata(baseParams);
    // baseParams.harness has no gitSha/instanceId/workspaceDir
    expect("gitSha" in (payload.harness as Record<string, unknown>)).toBe(false);
    expect("instanceId" in (payload.harness as Record<string, unknown>)).toBe(false);
    expect("workspaceDir" in (payload.harness as Record<string, unknown>)).toBe(false);
  });

  it("omits undefined optional prompting fields", () => {
    const payload = buildTraceMetadata(baseParams);
    expect("userPromptPrefixText" in (payload.prompting as Record<string, unknown>)).toBe(false);
    expect("systemPromptDigest" in (payload.prompting as Record<string, unknown>)).toBe(false);
  });

  it("preserves provided optional fields", () => {
    const payload = buildTraceMetadata({
      ...baseParams,
      harness: { ...baseParams.harness, gitSha: "abcdef1", instanceId: "inst-1" },
      prompting: { systemPromptDigest: "sha256:xyz", systemPromptByteLen: 1234 },
    });
    expect((payload.harness as Record<string, unknown>).gitSha).toBe("abcdef1");
    expect((payload.harness as Record<string, unknown>).instanceId).toBe("inst-1");
    expect((payload.prompting as Record<string, unknown>).systemPromptDigest).toBe("sha256:xyz");
    expect((payload.prompting as Record<string, unknown>).systemPromptByteLen).toBe(1234);
  });

  it("return value satisfies Record<string, unknown> (assignable to recordEvent data param)", () => {
    const payload = buildTraceMetadata(baseParams);
    // Compile-time check: assign to a Record<string, unknown> variable
    const data: Record<string, unknown> = payload;
    expect(typeof data).toBe("object");
    expect(data).not.toBeNull();
  });
});
