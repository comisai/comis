// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the CHANNELS config harness.
 *
 * Pure object builders + channel enumeration tables — no daemon, no key, no
 * network. Mirrors test/live/harness/web-config.test.ts.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { StreamingConfigSchema } from "@comis/core";
import {
  ALL_CHANNELS,
  REAL_CHANNELS,
  buildStreamingConfig,
  buildQueueConfig,
  buildDmScopeConfig,
  buildDeliveryTimingConfig,
} from "./channel-config.js";

// ---------------------------------------------------------------------------
// Channel enumeration tables
// ---------------------------------------------------------------------------

describe("channel enumeration tables", () => {
  it("ALL_CHANNELS lists exactly the 10 registered adapters (9 real + echo)", () => {
    expect([...ALL_CHANNELS]).toEqual([
      "discord",
      "telegram",
      "slack",
      "whatsapp",
      "signal",
      "line",
      "irc",
      "email",
      "imessage",
      "echo",
    ]);
  });

  it("REAL_CHANNELS lists the 9 non-echo channels and excludes echo", () => {
    expect([...REAL_CHANNELS]).toEqual([
      "discord",
      "telegram",
      "slack",
      "whatsapp",
      "signal",
      "line",
      "irc",
      "email",
      "imessage",
    ]);
    expect(REAL_CHANNELS).not.toContain("echo");
    expect(REAL_CHANNELS).toHaveLength(9);
  });

  it("REAL_CHANNELS is a subset of ALL_CHANNELS", () => {
    for (const ch of REAL_CHANNELS) {
      expect(ALL_CHANNELS).toContain(ch);
    }
  });
});

// ---------------------------------------------------------------------------
// buildStreamingConfig
// ---------------------------------------------------------------------------

describe("buildStreamingConfig", () => {
  it("returns the real StreamingConfig schema defaults", () => {
    const s = buildStreamingConfig();
    expect(s.defaultChunkMode).toBe("paragraph");
    expect(s.defaultTypingMode).toBe("thinking");
    expect(s.defaultTableMode).toBe("code");
    expect(s.defaultReplyMode).toBe("first");
    expect(s.defaultUseMarkdownIR).toBe(true);
  });

  it.each(["paragraph", "newline", "sentence", "length"] as const)(
    "round-trips defaultChunkMode=%s",
    (mode) => {
      expect(buildStreamingConfig({ defaultChunkMode: mode }).defaultChunkMode).toBe(mode);
    },
  );

  it.each(["never", "instant", "thinking", "message"] as const)(
    "round-trips defaultTypingMode=%s",
    (mode) => {
      expect(buildStreamingConfig({ defaultTypingMode: mode }).defaultTypingMode).toBe(mode);
    },
  );

  it.each(["code", "bullets", "off"] as const)(
    "round-trips defaultTableMode=%s",
    (mode) => {
      expect(buildStreamingConfig({ defaultTableMode: mode }).defaultTableMode).toBe(mode);
    },
  );

  it.each(["off", "first", "all"] as const)(
    "round-trips defaultReplyMode=%s",
    (mode) => {
      expect(buildStreamingConfig({ defaultReplyMode: mode }).defaultReplyMode).toBe(mode);
    },
  );

  it("round-trips defaultUseMarkdownIR=false", () => {
    expect(buildStreamingConfig({ defaultUseMarkdownIR: false }).defaultUseMarkdownIR).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildQueueConfig
// ---------------------------------------------------------------------------

describe("buildQueueConfig", () => {
  it("returns the real QueueConfig schema defaults", () => {
    const q = buildQueueConfig();
    expect(q.defaultMode).toBe("steer+followup");
    expect(q.defaultOverflow.policy).toBe("drop-new");
  });

  it.each(["followup", "collect", "steer", "steer+followup"] as const)(
    "round-trips defaultMode=%s",
    (mode) => {
      expect(buildQueueConfig({ defaultMode: mode }).defaultMode).toBe(mode);
    },
  );

  it.each(["drop-old", "drop-new", "summarize"] as const)(
    "round-trips defaultOverflow.policy=%s",
    (policy) => {
      expect(
        buildQueueConfig({ defaultOverflow: { maxDepth: 20, policy } }).defaultOverflow.policy,
      ).toBe(policy);
    },
  );
});

// ---------------------------------------------------------------------------
// buildDmScopeConfig (REAL enum — NOT {global,agent,session,channel})
// ---------------------------------------------------------------------------

describe("buildDmScopeConfig", () => {
  it("returns a valid DmScopeConfig with a real-enum default mode", () => {
    const d = buildDmScopeConfig();
    expect(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]).toContain(d.mode);
  });

  it.each(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"] as const)(
    "round-trips mode=%s (the REAL DmScopeConfigSchema enum)",
    (mode) => {
      expect(buildDmScopeConfig({ mode }).mode).toBe(mode);
    },
  );
});

// ---------------------------------------------------------------------------
// buildDeliveryTimingConfig
// ---------------------------------------------------------------------------

describe("buildDeliveryTimingConfig", () => {
  it("returns the real DeliveryTimingConfig schema default mode 'natural'", () => {
    expect(buildDeliveryTimingConfig().mode).toBe("natural");
  });

  it.each(["off", "natural", "custom", "adaptive"] as const)(
    "round-trips mode=%s",
    (mode) => {
      expect(buildDeliveryTimingConfig({ mode }).mode).toBe(mode);
    },
  );

  it("round-trips a custom min/max window", () => {
    const t = buildDeliveryTimingConfig({ mode: "custom", minMs: 0, maxMs: 10 });
    expect(t.mode).toBe("custom");
    expect(t.minMs).toBe(0);
    expect(t.maxMs).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Round-trip integrity — a non-enum value is rejected by the real schema
// ---------------------------------------------------------------------------

describe("schema round-trip integrity", () => {
  it("StreamingConfigSchema rejects a non-enum chunk mode (config-shape guard)", () => {
    expect(() =>
      StreamingConfigSchema.parse({ defaultChunkMode: "bogus" }),
    ).toThrow();
  });
});
