// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the provider-agnostic replay-drift detector.
 *
 * Verifies idle gap, model id change, provider change, api change branches,
 * first-match-wins ordering, and defensive handling of malformed entries.
 */

import { describe, it, expect } from "vitest";
import {
  shouldDropSignedFields,
  shouldDropSignedFieldsForToolDefs,
} from "./replay-drift-detector.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = 1_700_000_000_000; // arbitrary fixed clock for determinism
const IDLE_30M = 30 * 60_000;

interface BuildEntryArgs {
  /** Offset from FIXED_NOW (negative = older). */
  tsOffsetMs: number;
  role?: string;
  type?: string;
  modelId?: string;
  provider?: string;
  api?: string;
}

function buildEntry(args: BuildEntryArgs) {
  const meta = (args.modelId !== undefined || args.provider !== undefined || args.api !== undefined)
    ? {
        model: {
          id: args.modelId,
          provider: args.provider,
          api: args.api,
        },
      }
    : undefined;
  return {
    type: args.type ?? "message",
    timestamp: FIXED_NOW + args.tsOffsetMs,
    message: {
      role: args.role ?? "assistant",
      content: [{ type: "text", text: "x" }],
      ...(meta ? { metadata: meta } : {}),
    },
  };
}

const baseModel = { id: "claude-opus-4-7", provider: "anthropic", api: "anthropic.messages" };

// ---------------------------------------------------------------------------
// Empty / single-side cases
// ---------------------------------------------------------------------------

describe("shouldDropSignedFields", () => {
  it("returns drop=false for empty fileEntries", () => {
    const r = shouldDropSignedFields({
      fileEntries: [],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r).toEqual({ drop: false });
  });

  it("returns drop=false when there is no prior assistant entry", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        { type: "message", timestamp: FIXED_NOW - 1000, message: { role: "user", content: [] } },
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r).toEqual({ drop: false });
  });

  // -------------------------------------------------------------------------
  // Idle branch
  // -------------------------------------------------------------------------

  it("returns drop=false when prior assistant is within idleMs", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({ tsOffsetMs: -(IDLE_30M - 1), ...baseModel }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r).toEqual({ drop: false });
  });

  it("returns drop=true reason=idle when gap = idleMs + 1", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({ tsOffsetMs: -(IDLE_30M + 1), ...baseModel }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(true);
    expect(r.reason).toBe("idle");
    expect(r.detail?.idleGapMs).toBe(IDLE_30M + 1);
  });

  it("returns drop=false at exact threshold (gap = idleMs)", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({ tsOffsetMs: -IDLE_30M, ...baseModel }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Model / provider / api change
  // -------------------------------------------------------------------------

  it("returns drop=true reason=model_change when prior model.id differs", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({ tsOffsetMs: -1000, modelId: "claude-sonnet-4", provider: "anthropic", api: "anthropic.messages" }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(true);
    expect(r.reason).toBe("model_change");
    expect(r.detail?.previousModel).toBe("claude-sonnet-4");
  });

  it("returns drop=true reason=provider_change when prior provider differs", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        // Same id (rare but possible across forks); different provider
        buildEntry({ tsOffsetMs: -1000, modelId: "claude-opus-4-7", provider: "anthropic-bedrock", api: "anthropic.messages" }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(true);
    expect(r.reason).toBe("provider_change");
    expect(r.detail?.previousProvider).toBe("anthropic-bedrock");
  });

  it("returns drop=true reason=api_change when prior api differs", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({
          tsOffsetMs: -1000,
          modelId: "claude-opus-4-7",
          provider: "anthropic",
          api: "anthropic.legacy",
        }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(true);
    expect(r.reason).toBe("api_change");
    expect(r.detail?.previousApi).toBe("anthropic.legacy");
  });

  it("returns drop=false when identity matches and idle within threshold", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({ tsOffsetMs: -1000, ...baseModel }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Ordering: idle > model_change > provider_change > api_change
  // -------------------------------------------------------------------------

  it("idle takes precedence over model_change when both fire", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({ tsOffsetMs: -(IDLE_30M + 5), modelId: "claude-sonnet-4", provider: "anthropic", api: "anthropic.messages" }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.reason).toBe("idle");
  });

  it("model_change takes precedence over provider_change when idle within threshold", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({ tsOffsetMs: -1000, modelId: "claude-sonnet-4", provider: "anthropic-bedrock", api: "anthropic.messages" }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.reason).toBe("model_change");
  });

  it("provider_change takes precedence over api_change when model id matches", () => {
    const r = shouldDropSignedFields({
      fileEntries: [
        buildEntry({
          tsOffsetMs: -1000,
          modelId: "claude-opus-4-7",
          provider: "anthropic-bedrock",
          api: "anthropic.legacy",
        }),
      ],
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.reason).toBe("provider_change");
  });

  // -------------------------------------------------------------------------
  // Defensive: malformed entries
  // -------------------------------------------------------------------------

  it("ignores entries with malformed timestamp (string)", () => {
    const fileEntries = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: "message", timestamp: "not-a-number" as any, message: { role: "assistant", content: [] } },
      buildEntry({ tsOffsetMs: -1000, ...baseModel }),
    ];
    const r = shouldDropSignedFields({
      fileEntries,
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    // Walks from end → finds the well-formed entry first, returns drop=false
    expect(r.drop).toBe(false);
  });

  it("uses the most recent assistant entry, ignoring earlier ones", () => {
    const fileEntries = [
      // older — would trigger idle if used
      buildEntry({ tsOffsetMs: -(IDLE_30M + 100), ...baseModel }),
      // newer — well within threshold, identity matches
      buildEntry({ tsOffsetMs: -1000, ...baseModel }),
    ];
    const r = shouldDropSignedFields({
      fileEntries,
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(false);
  });

  it("respects injected `now` (deterministic clock)", () => {
    const fixedNow = 5_000_000_000;
    const fileEntries = [
      // 60 min before fixedNow → exceeds 30-min threshold
      { type: "message", timestamp: fixedNow - 60 * 60_000, message: { role: "assistant", content: [] } },
    ];
    const r = shouldDropSignedFields({
      fileEntries,
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: fixedNow,
    });
    expect(r.drop).toBe(true);
    expect(r.reason).toBe("idle");
    expect(r.detail?.idleGapMs).toBe(60 * 60_000);
  });

  it("does not throw when fileEntries contains null/undefined", () => {
    const fileEntries = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undefined as any,
      buildEntry({ tsOffsetMs: -1000, ...baseModel }),
    ];
    const r = shouldDropSignedFields({
      fileEntries,
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(false);
  });

  it("returns drop=false when prior assistant has no metadata and gap is within threshold", () => {
    const fileEntries = [
      { type: "message", timestamp: FIXED_NOW - 1000, message: { role: "assistant", content: [] } },
    ];
    const r = shouldDropSignedFields({
      fileEntries,
      currentModel: baseModel,
      idleMs: IDLE_30M,
      now: FIXED_NOW,
    });
    expect(r.drop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 260428-kvl: Tool-DEFINITIONS drift dimension
// ---------------------------------------------------------------------------

describe("shouldDropSignedFieldsForToolDefs", () => {
  // Hash equality is binary, so any string works as a fixture -- the function
  // only checks string equality. Use short readable names for clarity.
  const HASH_A = "hash-a";
  const HASH_B = "hash-b";
  const HASH_C = "hash-c";

  it("returns no_drift for an empty snapshots map", () => {
    const r = shouldDropSignedFieldsForToolDefs({
      currentHash: HASH_A,
      snapshots: new Map(),
    });
    expect(r).toEqual({ shouldDrop: false, mismatchedResponseIds: [], reason: "no_drift" });
  });

  it("returns no_drift when every snapshot equals the current hash", () => {
    const r = shouldDropSignedFieldsForToolDefs({
      currentHash: HASH_A,
      snapshots: new Map([
        ["resp1", HASH_A],
        ["resp2", HASH_A],
      ]),
    });
    expect(r).toEqual({ shouldDrop: false, mismatchedResponseIds: [], reason: "no_drift" });
  });

  it("returns tool_defs_changed with the single mismatched responseId when one snapshot differs", () => {
    const r = shouldDropSignedFieldsForToolDefs({
      currentHash: HASH_A,
      snapshots: new Map([
        ["resp1", HASH_A],
        ["resp2", HASH_B], // mismatched
        ["resp3", HASH_A],
      ]),
    });
    expect(r.shouldDrop).toBe(true);
    expect(r.reason).toBe("tool_defs_changed");
    expect(r.mismatchedResponseIds).toEqual(["resp2"]);
  });

  it("collects ALL mismatched responseIds in iteration order when multiple differ", () => {
    const r = shouldDropSignedFieldsForToolDefs({
      currentHash: HASH_A,
      snapshots: new Map([
        ["respA", HASH_B], // mismatched
        ["respB", HASH_A], // equal
        ["respC", HASH_C], // mismatched
        ["respD", HASH_B], // mismatched
      ]),
    });
    expect(r.shouldDrop).toBe(true);
    expect(r.reason).toBe("tool_defs_changed");
    expect(r.mismatchedResponseIds).toEqual(["respA", "respC", "respD"]);
  });
});
