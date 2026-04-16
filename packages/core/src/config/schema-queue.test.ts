import { describe, it, expect } from "vitest";
import {
  QueueModeSchema,
  OverflowPolicySchema,
  OverflowConfigSchema,
  DebounceBufferConfigSchema,
  PerChannelQueueConfigSchema,
  FollowupConfigSchema,
  PriorityLaneConfigSchema,
  LaneAssignmentConfigSchema,
  QueueConfigSchema,
} from "./schema-queue.js";

// ---------------------------------------------------------------------------
// QueueModeSchema
// ---------------------------------------------------------------------------

describe("QueueModeSchema", () => {
  it("accepts all 4 valid values", () => {
    for (const mode of ["followup", "collect", "steer", "steer+followup"] as const) {
      const result = QueueModeSchema.safeParse(mode);
      expect(result.success).toBe(true);
    }
  });

  it("defaults to steer+followup", () => {
    const result = QueueModeSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("steer+followup");
    }
  });

  it("rejects invalid string", () => {
    const result = QueueModeSchema.safeParse("queue-all");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OverflowPolicySchema
// ---------------------------------------------------------------------------

describe("OverflowPolicySchema", () => {
  it("accepts drop-old, drop-new, summarize", () => {
    for (const policy of ["drop-old", "drop-new", "summarize"] as const) {
      const result = OverflowPolicySchema.safeParse(policy);
      expect(result.success).toBe(true);
    }
  });

  it("defaults to drop-new", () => {
    const result = OverflowPolicySchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("drop-new");
    }
  });
});

// ---------------------------------------------------------------------------
// OverflowConfigSchema
// ---------------------------------------------------------------------------

describe("OverflowConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = OverflowConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxDepth).toBe(20);
      expect(result.data.policy).toBe("drop-new");
    }
  });

  it("rejects non-positive maxDepth", () => {
    const result = OverflowConfigSchema.safeParse({ maxDepth: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DebounceBufferConfigSchema
// ---------------------------------------------------------------------------

describe("DebounceBufferConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = DebounceBufferConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.windowMs).toBe(0);
      expect(result.data.maxBufferedMessages).toBe(10);
      expect(result.data.firstMessageImmediate).toBe(true);
    }
  });

  it("accepts windowMs=0 (disabled)", () => {
    const result = DebounceBufferConfigSchema.safeParse({ windowMs: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects negative windowMs", () => {
    const result = DebounceBufferConfigSchema.safeParse({ windowMs: -1 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PerChannelQueueConfigSchema
// ---------------------------------------------------------------------------

describe("PerChannelQueueConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = PerChannelQueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("steer+followup");
      expect(result.data.overflow.maxDepth).toBe(20);
      expect(result.data.overflow.policy).toBe("drop-new");
      expect(result.data.debounceMs).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// FollowupConfigSchema
// ---------------------------------------------------------------------------

describe("FollowupConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = FollowupConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxFollowupRuns).toBe(3);
      expect(result.data.followupOnCompaction).toBe(true);
    }
  });

  it("accepts maxFollowupRuns=0 (disabled)", () => {
    const result = FollowupConfigSchema.safeParse({ maxFollowupRuns: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxFollowupRuns).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// PriorityLaneConfigSchema
// ---------------------------------------------------------------------------

describe("PriorityLaneConfigSchema", () => {
  it("produces valid defaults for optional fields", () => {
    const result = PriorityLaneConfigSchema.safeParse({ name: "normal" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concurrency).toBe(3);
      expect(result.data.priority).toBe(0);
      expect(result.data.agingPromotionMs).toBe(30_000);
    }
  });

  it("rejects empty name", () => {
    const result = PriorityLaneConfigSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LaneAssignmentConfigSchema
// ---------------------------------------------------------------------------

describe("LaneAssignmentConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = LaneAssignmentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultLane).toBe("normal");
      expect(result.data.dmLane).toBe("high");
      expect(result.data.mentionLane).toBe("normal");
      expect(result.data.followupLane).toBe("normal");
      expect(result.data.scheduledLane).toBe("low");
    }
  });
});

// ---------------------------------------------------------------------------
// QueueConfigSchema
// ---------------------------------------------------------------------------

describe("QueueConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = QueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxConcurrentSessions).toBe(10);
      expect(result.data.cleanupIdleMs).toBe(600_000);
      expect(result.data.defaultMode).toBe("steer+followup");
      expect(result.data.defaultDebounceMs).toBe(0);
      expect(result.data.perChannel).toEqual({});
      expect(result.data.perChannelDebounce).toEqual({});
      expect(result.data.priorityEnabled).toBe(false);
    }
  });

  it("includes default priorityLanes with 3 lanes (high/normal/low)", () => {
    const result = QueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priorityLanes).toHaveLength(3);

      const high = result.data.priorityLanes.find((l) => l.name === "high");
      expect(high).toBeDefined();
      expect(high!.concurrency).toBe(3);
      expect(high!.priority).toBe(2);

      const normal = result.data.priorityLanes.find((l) => l.name === "normal");
      expect(normal).toBeDefined();
      expect(normal!.concurrency).toBe(5);
      expect(normal!.priority).toBe(1);

      const low = result.data.priorityLanes.find((l) => l.name === "low");
      expect(low).toBeDefined();
      expect(low!.concurrency).toBe(2);
      expect(low!.priority).toBe(0);
    }
  });

  it("includes laneAssignment defaults", () => {
    const result = QueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.laneAssignment.defaultLane).toBe("normal");
      expect(result.data.laneAssignment.dmLane).toBe("high");
      expect(result.data.laneAssignment.scheduledLane).toBe("low");
    }
  });

  it("includes followup defaults", () => {
    const result = QueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.followup.maxFollowupRuns).toBe(3);
      expect(result.data.followup.followupOnCompaction).toBe(true);
    }
  });

  it("includes debounce defaults", () => {
    const result = QueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debounce.windowMs).toBe(0);
      expect(result.data.debounce.maxBufferedMessages).toBe(10);
      expect(result.data.debounce.firstMessageImmediate).toBe(true);
    }
  });

  it("includes defaultOverflow defaults", () => {
    const result = QueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultOverflow.maxDepth).toBe(20);
      expect(result.data.defaultOverflow.policy).toBe("drop-new");
    }
  });

  it("accepts perChannel overrides", () => {
    const result = QueueConfigSchema.safeParse({
      perChannel: {
        telegram: { mode: "collect", debounceMs: 500 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perChannel.telegram.mode).toBe("collect");
      expect(result.data.perChannel.telegram.debounceMs).toBe(500);
    }
  });
});
