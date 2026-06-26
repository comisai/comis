// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { PerAgentConfigSchema } from "./schema-agent-runtime.js";

// ---------------------------------------------------------------------------
// Agent Transparency — per-agent activity + delivery config
//
// §16.3: two NEW per-agent blocks — `activity` (presentation) and `delivery`
// (final-assistant visibility). Every field defaulted so existing configs
// validate unchanged. The top-level `verbosity` (response-style
// VerbosityConfigSchema) is KEPT unchanged and is a distinct concept from the
// new `activity.verbosity` (no rename, no shim — §16.3).
//
// These cases fail on the pre-patch schema (the parsed config lacks `activity`
// and `delivery`) — RED proof.
// ---------------------------------------------------------------------------

describe("per-agent activity config block", () => {
  it("applies activity defaults for an empty agent config", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.activity.verbosity).toBe("normal");
    expect(cfg.activity.onSuccess).toBe("delete");
    expect(cfg.activity.theme).toBe("default");
    expect(cfg.activity.emergencyDisabled).toBe(false);
    expect(cfg.activity.channels).toEqual({});
    expect(cfg.activity.defaultChannelEnabled).toBe(true);
  });

  it("accepts every activity.verbosity level and rejects an unknown one", () => {
    for (const verbosity of ["silent", "quiet", "normal", "verbose"] as const) {
      const cfg = PerAgentConfigSchema.parse({ activity: { verbosity } });
      expect(cfg.activity.verbosity).toBe(verbosity);
    }
    const bad = PerAgentConfigSchema.safeParse({ activity: { verbosity: "loud" } });
    expect(bad.success).toBe(false);
  });

  it("accepts every activity.onSuccess value and rejects an unknown one", () => {
    for (const onSuccess of ["delete", "keep", "collapse"] as const) {
      const cfg = PerAgentConfigSchema.parse({ activity: { onSuccess } });
      expect(cfg.activity.onSuccess).toBe(onSuccess);
    }
    const bad = PerAgentConfigSchema.safeParse({ activity: { onSuccess: "purge" } });
    expect(bad.success).toBe(false);
  });

  it("accepts every activity.theme value and rejects an unknown one", () => {
    for (const theme of [
      "default",
      "terminal-minimal",
      "playful",
      "ascii",
    ] as const) {
      const cfg = PerAgentConfigSchema.parse({ activity: { theme } });
      expect(cfg.activity.theme).toBe(theme);
    }
    const bad = PerAgentConfigSchema.safeParse({ activity: { theme: "neon" } });
    expect(bad.success).toBe(false);
  });

  it("activity.channels is a record of { enabled } defaulting enabled to false", () => {
    const cfg = PerAgentConfigSchema.parse({
      activity: { channels: { "telegram:dm": {}, "discord:thread": { enabled: true } } },
    });
    // Missing `enabled` defaults to false — every renderer off until enabled.
    expect(cfg.activity.channels["telegram:dm"]?.enabled).toBe(false);
    expect(cfg.activity.channels["discord:thread"]?.enabled).toBe(true);
  });
});

describe("per-agent delivery.visibleReplies config block", () => {
  it("defaults visibleReplies.direct to 'automatic' and .group to 'message_tool'", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.delivery.visibleReplies.direct).toBe("automatic");
    expect(cfg.delivery.visibleReplies.group).toBe("message_tool");
  });

  it("accepts automatic|message_tool for direct and group and rejects others", () => {
    for (const mode of ["automatic", "message_tool"] as const) {
      const cfg = PerAgentConfigSchema.parse({
        delivery: { visibleReplies: { direct: mode, group: mode } },
      });
      expect(cfg.delivery.visibleReplies.direct).toBe(mode);
      expect(cfg.delivery.visibleReplies.group).toBe(mode);
    }
    const bad = PerAgentConfigSchema.safeParse({
      delivery: { visibleReplies: { direct: "loud" } },
    });
    expect(bad.success).toBe(false);
  });
});

describe("top-level verbosity stays unchanged alongside activity.verbosity (no-BC)", () => {
  it("still parses the response-style top-level verbosity (VerbosityConfigSchema)", () => {
    const cfg = PerAgentConfigSchema.parse({
      verbosity: {
        enabled: true,
        defaultLevel: "concise",
        overrides: { telegram: { level: "terse" } },
      },
    });
    // Response-style verbosity uses the auto|terse|concise|standard|detailed scale.
    expect(cfg.verbosity?.defaultLevel).toBe("concise");
    expect(cfg.verbosity?.overrides.telegram?.level).toBe("terse");
  });

  it("keeps activity.verbosity distinct from the top-level response-style verbosity", () => {
    const cfg = PerAgentConfigSchema.parse({
      verbosity: { defaultLevel: "detailed" },
      activity: { verbosity: "verbose" },
    });
    // Two independent fields with disjoint enums — they only share the word.
    expect(cfg.verbosity?.defaultLevel).toBe("detailed");
    expect(cfg.activity.verbosity).toBe("verbose");
  });
});

// ---------------------------------------------------------------------------
// The SCAFFOLD-DORMANT memory-lifecycle cron knob wired
// onto the per-agent RUNTIME config (the memoryOnlineTuning bandit sibling was
// deleted in Phase 224). `.optional()`
// so a default agent registers NO lifecycle block (byte-identical) — the cron is
// default-OFF and even when enabled the dormant adapter evicts nothing.
// These cases fail on the pre-patch schema (no `memoryLifecycle` field) — RED.
// ---------------------------------------------------------------------------
describe("per-agent memoryLifecycle config block", () => {
  it("materializes memoryLifecycle ON by default (opt-out — SCAFFOLD-DORMANT, evicts nothing)", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.memoryLifecycle).toBeDefined();
    expect(cfg.memoryLifecycle!.enabled).toBe(true);
  });

  it("accepts a memoryLifecycle subtree on a per-agent config and applies the dormant defaults", () => {
    const cfg = PerAgentConfigSchema.parse({ memoryLifecycle: { enabled: true } });
    expect(cfg.memoryLifecycle).toBeDefined();
    expect(cfg.memoryLifecycle!.enabled).toBe(true);
    // The dormant policy constants default through from MemoryLifecycleConfigSchema.
    expect(cfg.memoryLifecycle!.schedule).toBe("0 9 * * *");
    expect(cfg.memoryLifecycle!.thetaPromote).toBe(0.7);
    expect(cfg.memoryLifecycle!.thetaDemote).toBe(0.3);
  });

  it("rejects a stray field on the per-agent memoryLifecycle subtree (z.strictObject)", () => {
    const bad = PerAgentConfigSchema.safeParse({ memoryLifecycle: { enabled: true, evictNow: true } });
    expect(bad.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DET-02 (v2.22 Multilingual Excellence): agents.<id>.language — the reply
// language hint for deterministic degraded replies. `.optional()` loose string
// mirroring the transcription `language` hint (schema-integrations.ts:240):
// BCP-47 ("he") OR an English display name ("Hebrew"); auto-detect when omitted.
// A default agent registers NO language (byte-identical). The AGENTS.md §7
// config-test triplet: defaults (absent) / valid / invalid (non-string).
// These cases fail on the pre-patch schema (no `language` field) — RED.
// ---------------------------------------------------------------------------
describe("DET-02 — agents.<id>.language config key", () => {
  it("is optional — absent on a bare config (auto-detect, byte-identical default)", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.language).toBeUndefined();
  });

  it("accepts a BCP-47 tag (e.g. 'he')", () => {
    const cfg = PerAgentConfigSchema.parse({ language: "he" });
    expect(cfg.language).toBe("he");
  });

  it("accepts a BCP-47 region tag and an English display name (loose string — normalization is the resolver's job)", () => {
    expect(PerAgentConfigSchema.parse({ language: "he-IL" }).language).toBe("he-IL");
    expect(PerAgentConfigSchema.parse({ language: "Hebrew" }).language).toBe("Hebrew");
  });

  it("rejects a non-string language (number)", () => {
    const bad = PerAgentConfigSchema.safeParse({ language: 42 });
    expect(bad.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-provider stress enabler (2026-06-22): agents.<id>.capabilityClass —
// an operator pin for the capability class. Without it only codex models are
// naturally nano-classed, so the small-window context-fit fixes can't be
// exercised against OpenAI/Anthropic/Google (all resolve to "frontier" with a
// large window). When set it threads into resolveModelProfile's
// capabilityClassOverride (the reduced prompt + nano deferral + effectiveContextCap
// then apply on ANY provider). Mirrors the provider-level enum
// (provider-capabilities.ts:68). AGENTS.md §7 config-test triplet:
// default (absent) / valid / invalid. RED on the pre-patch schema (no field).
// ---------------------------------------------------------------------------
describe("per-agent capabilityClass pin", () => {
  it("is optional — absent on a bare config (auto-detect heuristic, byte-identical default)", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.capabilityClass).toBeUndefined();
  });

  it("accepts each valid class (nano/small/mid/frontier)", () => {
    for (const cls of ["nano", "small", "mid", "frontier"] as const) {
      expect(PerAgentConfigSchema.parse({ capabilityClass: cls }).capabilityClass).toBe(cls);
    }
  });

  it("rejects an invalid class", () => {
    expect(PerAgentConfigSchema.safeParse({ capabilityClass: "tiny" }).success).toBe(false);
    expect(PerAgentConfigSchema.safeParse({ capabilityClass: 1 }).success).toBe(false);
  });
});
