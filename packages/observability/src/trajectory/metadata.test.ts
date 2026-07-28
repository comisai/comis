// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for buildTraceMetadata.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import { PAYLOAD_BOUNDS } from "../shared/bounded-payload.js";
import { buildTraceMetadata, type TraceMetadataParams } from "./metadata.js";
import { limitTrajectoryPayloadValue } from "./runtime.js";

const baseParams: TraceMetadataParams = {
  harness: { type: "comis", version: "1.0.41", os: "linux", node: "v22.0.0" },
  model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
  config: { appName: "comis" },
  plugins: [],
  skills: [],
  prompting: {},
  redaction: { policy: "platform-aware" },
};

describe("buildTraceMetadata", () => {
  it("returns the 7 top-level keys", () => {
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

  it("records a deterministic bounded inventory of authoritative tool names", () => {
    const payload = buildTraceMetadata({
      ...baseParams,
      toolInventory: { names: ["web_search", "cron", "web_search"] },
    } as TraceMetadataParams);

    expect(payload.toolInventory).toEqual({
      count: 2,
      chunks: [["cron", "web_search"]],
      truncated: false,
    });

    const oversized = buildTraceMetadata({
      ...baseParams,
      toolInventory: {
        names: Array.from({ length: 5_000 }, (_, index) => `tool_${String(index).padStart(4, "0")}`),
      },
    } as TraceMetadataParams);
    expect(oversized.toolInventory).toMatchObject({ count: 5_000, truncated: true });
    expect(oversized.toolInventory?.chunks).toHaveLength(
      PAYLOAD_BOUNDS.maxArrayLength,
    );
    expect(oversized.toolInventory?.chunks.every(
      (chunk) => chunk.length <= PAYLOAD_BOUNDS.maxArrayLength,
    )).toBe(true);

    const persisted = limitTrajectoryPayloadValue(
      sanitizeForPersistence(oversized),
    ) as TraceMetadataParams;
    expect(persisted.toolInventory).toEqual(oversized.toolInventory);
  });

  it("keeps every live-sized skill descriptor through trajectory persistence", () => {
    const skills = Array.from({ length: 73 }, (_, index) => ({
      id: `skill_${String(index).padStart(2, "0")}`,
      version: "1.0.0",
    }));
    const payload = buildTraceMetadata({ ...baseParams, skills });

    expect(payload.skills).toMatchObject({ count: 73, truncated: false });
    expect(payload.skills.chunks.map((chunk) => chunk.length)).toEqual([64, 9]);

    const persisted = limitTrajectoryPayloadValue(
      sanitizeForPersistence(payload),
    ) as typeof payload;
    expect(persisted.skills).toEqual(payload.skills);
  });

  it("return value satisfies Record<string, unknown> (assignable to recordEvent data param)", () => {
    const payload = buildTraceMetadata(baseParams);
    // Compile-time check: assign to a Record<string, unknown> variable
    const data: Record<string, unknown> = payload;
    expect(typeof data).toBe("object");
    expect(data).not.toBeNull();
  });
});
