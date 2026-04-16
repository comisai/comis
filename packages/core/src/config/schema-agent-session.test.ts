import { describe, it, expect } from "vitest";
import {
  SessionResetPolicySchema,
  ResetPolicyOverrideSchema,
  DmScopeConfigSchema,
  PruningConfigSchema,
  SessionCompactionConfigSchema,
} from "./schema-agent.js";

describe("SessionResetPolicySchema", () => {
  it("parses valid reset policy", () => {
    const result = SessionResetPolicySchema.safeParse({
      mode: "hybrid",
      dailyResetHour: 6,
      dailyResetTimezone: "America/New_York",
      idleTimeoutMs: 7_200_000,
      sweepIntervalMs: 60_000,
      resetTriggers: ["/reset", "/new"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("hybrid");
      expect(result.data.dailyResetHour).toBe(6);
      expect(result.data.dailyResetTimezone).toBe("America/New_York");
      expect(result.data.idleTimeoutMs).toBe(7_200_000);
      expect(result.data.resetTriggers).toEqual(["/reset", "/new"]);
    }
  });

  it("applies defaults for empty object", () => {
    const result = SessionResetPolicySchema.parse({});
    expect(result.mode).toBe("daily");
    expect(result.dailyResetHour).toBe(4);
    expect(result.dailyResetTimezone).toBe("");
    expect(result.idleTimeoutMs).toBe(14_400_000);
    expect(result.sweepIntervalMs).toBe(300_000);
    expect(result.resetTriggers).toEqual([]);
    expect(result.perType).toEqual({});
  });

  it("rejects invalid enum values for mode", () => {
    const result = SessionResetPolicySchema.safeParse({ mode: "weekly" });
    expect(result.success).toBe(false);
  });

  it("rejects dailyResetHour out of range (24)", () => {
    const result = SessionResetPolicySchema.safeParse({ dailyResetHour: 24 });
    expect(result.success).toBe(false);
  });

  it("rejects negative dailyResetHour", () => {
    const result = SessionResetPolicySchema.safeParse({ dailyResetHour: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero idleTimeoutMs", () => {
    const result = SessionResetPolicySchema.safeParse({ idleTimeoutMs: 0 });
    expect(result.success).toBe(false);
  });

  it("accepts perType overrides", () => {
    const result = SessionResetPolicySchema.safeParse({
      perType: {
        dm: { mode: "idle", idleTimeoutMs: 3_600_000 },
        group: { mode: "daily", dailyResetHour: 3 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perType.dm?.mode).toBe("idle");
      expect(result.data.perType.group?.dailyResetHour).toBe(3);
    }
  });
});

describe("ResetPolicyOverrideSchema", () => {
  it("parses valid override configuration", () => {
    const result = ResetPolicyOverrideSchema.safeParse({
      mode: "daily",
      dailyResetHour: 8,
      dailyResetTimezone: "UTC",
      idleTimeoutMs: 1_800_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("daily");
      expect(result.data.dailyResetHour).toBe(8);
    }
  });

  it("accepts empty object (all fields optional)", () => {
    const result = ResetPolicyOverrideSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBeUndefined();
      expect(result.data.dailyResetHour).toBeUndefined();
      expect(result.data.dailyResetTimezone).toBeUndefined();
      expect(result.data.idleTimeoutMs).toBeUndefined();
    }
  });

  it("rejects invalid mode enum", () => {
    const result = ResetPolicyOverrideSchema.safeParse({ mode: "weekly" });
    expect(result.success).toBe(false);
  });

  it("rejects dailyResetHour > 23", () => {
    const result = ResetPolicyOverrideSchema.safeParse({ dailyResetHour: 25 });
    expect(result.success).toBe(false);
  });
});

describe("DmScopeConfigSchema", () => {
  it("parses valid DM scope config", () => {
    const result = DmScopeConfigSchema.safeParse({
      mode: "per-peer",
      agentPrefix: true,
      threadIsolation: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("per-peer");
      expect(result.data.agentPrefix).toBe(true);
      expect(result.data.threadIsolation).toBe(true);
    }
  });

  it("applies defaults for empty object", () => {
    const result = DmScopeConfigSchema.parse({});
    expect(result.mode).toBe("per-channel-peer");
    expect(result.agentPrefix).toBe(false);
    expect(result.threadIsolation).toBe(true);
  });

  it("rejects invalid mode enum", () => {
    const result = DmScopeConfigSchema.safeParse({ mode: "global" });
    expect(result.success).toBe(false);
  });

  it("accepts per-account-channel-peer mode", () => {
    const result = DmScopeConfigSchema.safeParse({ mode: "per-account-channel-peer" });
    expect(result.success).toBe(true);
  });
});

describe("PruningConfigSchema", () => {
  it("parses valid pruning config", () => {
    const result = PruningConfigSchema.safeParse({
      enabled: true,
      softTrimThresholdChars: 10_000,
      hardClearThresholdChars: 50_000,
      preserveHeadChars: 1_000,
      preserveTailChars: 1_000,
      pruneableTools: ["bash"],
      protectedTools: ["file_read"],
      protectImageBlocks: false,
      preserveRecentCount: 4,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.softTrimThresholdChars).toBe(10_000);
      expect(result.data.protectImageBlocks).toBe(false);
      expect(result.data.pruneableTools).toEqual(["bash"]);
    }
  });

  it("applies defaults for empty object", () => {
    const result = PruningConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.softTrimThresholdChars).toBe(8_000);
    expect(result.hardClearThresholdChars).toBe(30_000);
    expect(result.preserveHeadChars).toBe(500);
    expect(result.preserveTailChars).toBe(500);
    expect(result.pruneableTools).toEqual([]);
    expect(result.protectedTools).toEqual([]);
    expect(result.protectImageBlocks).toBe(true);
    expect(result.preserveRecentCount).toBe(6);
  });

  it("rejects negative softTrimThresholdChars", () => {
    const result = PruningConfigSchema.safeParse({ softTrimThresholdChars: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero hardClearThresholdChars", () => {
    const result = PruningConfigSchema.safeParse({ hardClearThresholdChars: 0 });
    expect(result.success).toBe(false);
  });

  it("allows zero for preserveHeadChars (nonnegative)", () => {
    const result = PruningConfigSchema.safeParse({ preserveHeadChars: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preserveHeadChars).toBe(0);
    }
  });
});

describe("SessionCompactionConfigSchema", () => {
  it("parses valid compaction config", () => {
    const result = SessionCompactionConfigSchema.safeParse({
      softThresholdRatio: 0.6,
      hardThresholdRatio: 0.85,
      flushModel: "claude-haiku-3",
      chunkMaxChars: 40_000,
      chunkOverlapMessages: 3,
      chunkMergeSummaries: false,
      reserveTokens: 4096,
      keepRecentTokens: 8192,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.softThresholdRatio).toBe(0.6);
      expect(result.data.hardThresholdRatio).toBe(0.85);
      expect(result.data.flushModel).toBe("claude-haiku-3");
      expect(result.data.chunkMergeSummaries).toBe(false);
    }
  });

  it("applies defaults for empty object", () => {
    const result = SessionCompactionConfigSchema.parse({});
    expect(result.softThresholdRatio).toBe(0.75);
    expect(result.hardThresholdRatio).toBe(0.90);
    expect(result.flushModel).toBeUndefined();
    expect(result.chunkMaxChars).toBe(50_000);
    expect(result.chunkOverlapMessages).toBe(2);
    expect(result.chunkMergeSummaries).toBe(true);
    expect(result.reserveTokens).toBe(16384);
    expect(result.keepRecentTokens).toBe(32768);
  });

  it("rejects softThresholdRatio > 1", () => {
    const result = SessionCompactionConfigSchema.safeParse({ softThresholdRatio: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects negative hardThresholdRatio", () => {
    const result = SessionCompactionConfigSchema.safeParse({ hardThresholdRatio: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero reserveTokens", () => {
    const result = SessionCompactionConfigSchema.safeParse({ reserveTokens: 0 });
    expect(result.success).toBe(false);
  });

  it("round-trip: parse then re-parse produces identical result", () => {
    const first = SessionCompactionConfigSchema.parse({
      softThresholdRatio: 0.5,
      chunkMaxChars: 25_000,
    });
    const second = SessionCompactionConfigSchema.parse(first);
    expect(second).toEqual(first);
  });

  it("defaults postCompactionSections to ['Session Startup', 'Red Lines']", () => {
    const result = SessionCompactionConfigSchema.parse({});
    expect(result.postCompactionSections).toEqual(["Session Startup", "Red Lines"]);
  });

  it("accepts custom postCompactionSections array", () => {
    const result = SessionCompactionConfigSchema.parse({
      postCompactionSections: ["Custom Section", "Another"],
    });
    expect(result.postCompactionSections).toEqual(["Custom Section", "Another"]);
  });

  it("parses without postCompactionSections field (gets default)", () => {
    const result = SessionCompactionConfigSchema.safeParse({
      softThresholdRatio: 0.8,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.postCompactionSections).toEqual(["Session Startup", "Red Lines"]);
    }
  });
});
