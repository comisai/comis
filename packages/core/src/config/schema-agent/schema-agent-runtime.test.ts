// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { PerAgentConfigSchema } from "./schema-agent-runtime.js";

// ---------------------------------------------------------------------------
// Agent Transparency — per-agent activity + delivery config
//
// Two per-agent blocks — `activity` (presentation) and `delivery`
// (final-assistant visibility). Every field defaulted so a config that omits
// them validates unchanged. The top-level `verbosity` (response-style
// VerbosityConfigSchema) is a distinct concept from
// `activity.verbosity` — they share only the word.
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

describe("top-level verbosity is a distinct field alongside activity.verbosity", () => {
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
// onto the per-agent RUNTIME config. Even when enabled the dormant adapter
// evicts nothing.
// ---------------------------------------------------------------------------
describe("per-agent memoryLifecycle config block", () => {
  it("materializes memoryLifecycle ON by default (opt-out — SCAFFOLD-DORMANT, evicts nothing)", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.memoryLifecycle).toBeDefined();
    expect(cfg.memoryLifecycle!.enabled).toBe(true);
  });

  it("accepts a memoryLifecycle subtree on a per-agent config and applies the trimmed defaults", () => {
    const cfg = PerAgentConfigSchema.parse({ memoryLifecycle: { enabled: true } });
    expect(cfg.memoryLifecycle).toBeDefined();
    expect(cfg.memoryLifecycle!.enabled).toBe(true);
    // The schema carries only {enabled, schedule}; decay tuning is not per-agent config.
    expect(cfg.memoryLifecycle!.schedule).toBe("0 9 * * *");
  });

  it("rejects a stray field on the per-agent memoryLifecycle subtree (z.strictObject)", () => {
    const bad = PerAgentConfigSchema.safeParse({ memoryLifecycle: { enabled: true, evictNow: true } });
    expect(bad.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agents.<id>.language — canonical open BCP-47 response locale policy.
// ---------------------------------------------------------------------------
describe("agents.<id>.language config key", () => {
  it("is optional on a bare config", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.language).toBeUndefined();
  });

  it("accepts an open canonical BCP-47 locale", () => {
    const cfg = PerAgentConfigSchema.parse({ language: "sr-Latn-RS" });
    expect(cfg.language).toBe("sr-Latn-RS");
  });

  it("rejects display names and non-canonical locale tags", () => {
    expect(PerAgentConfigSchema.safeParse({ language: "French" }).success).toBe(false);
    expect(PerAgentConfigSchema.safeParse({ language: "sr-latn-rs" }).success).toBe(false);
  });

  it("rejects a non-string language (number)", () => {
    const bad = PerAgentConfigSchema.safeParse({ language: 42 });
    expect(bad.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agents.<id>.capabilityClass —
// an operator pin for the capability class. Without it only codex models are
// naturally nano-classed, so the small-window context-fit behavior can't be
// exercised against OpenAI/Anthropic/Google (all resolve to "frontier" with a
// large window). When set it threads into resolveModelProfile's
// capabilityClassOverride (the reduced prompt + nano deferral + effectiveContextCap
// then apply on ANY provider). Mirrors the provider-level enum
// (provider-capabilities.ts). AGENTS.md §7 config-test triplet:
// default (absent) / valid / invalid.
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
