/**
 * Tests for operation model defaults: validates constant maps and verifies
 * all default model IDs against the pi-ai SDK registry.
 */

import { describe, it, expect } from "vitest";
import { getModels, type KnownProvider } from "@mariozechner/pi-ai";
import {
  OPERATION_MODEL_DEFAULTS,
  OPERATION_TIER_MAP,
  OPERATION_TIMEOUT_DEFAULTS,
  OPERATION_CACHE_DEFAULTS,
} from "./operation-model-defaults.js";

describe("OPERATION_MODEL_DEFAULTS", () => {
  it("has entries for anthropic, google, and openai families", () => {
    expect(OPERATION_MODEL_DEFAULTS).toHaveProperty("anthropic");
    expect(OPERATION_MODEL_DEFAULTS).toHaveProperty("google");
    expect(OPERATION_MODEL_DEFAULTS).toHaveProperty("openai");
  });

  it("each family entry has mid and fast string fields", () => {
    for (const family of ["anthropic", "google", "openai"]) {
      const entry = OPERATION_MODEL_DEFAULTS[family];
      expect(typeof entry.mid).toBe("string");
      expect(typeof entry.fast).toBe("string");
      expect(entry.mid.length).toBeGreaterThan(0);
      expect(entry.fast.length).toBeGreaterThan(0);
    }
  });

  it("has correct model IDs for anthropic", () => {
    expect(OPERATION_MODEL_DEFAULTS.anthropic.mid).toBe("claude-sonnet-4-6");
    expect(OPERATION_MODEL_DEFAULTS.anthropic.fast).toBe("claude-haiku-4-5");
  });

  it("has correct model IDs for google", () => {
    expect(OPERATION_MODEL_DEFAULTS.google.mid).toBe("gemini-3-flash");
    expect(OPERATION_MODEL_DEFAULTS.google.fast).toBe("gemini-2.5-flash-lite");
  });

  it("has correct model IDs for openai", () => {
    expect(OPERATION_MODEL_DEFAULTS.openai.mid).toBe("gpt-5.4-mini");
    expect(OPERATION_MODEL_DEFAULTS.openai.fast).toBe("gpt-5.4-nano");
  });

  it("all 6 default model IDs exist in the pi-ai SDK registry", () => {
    const modelsToCheck: Array<{ provider: KnownProvider; modelId: string; label: string }> = [
      { provider: "anthropic", modelId: OPERATION_MODEL_DEFAULTS.anthropic.mid, label: "anthropic.mid" },
      { provider: "anthropic", modelId: OPERATION_MODEL_DEFAULTS.anthropic.fast, label: "anthropic.fast" },
      { provider: "google", modelId: OPERATION_MODEL_DEFAULTS.google.mid, label: "google.mid" },
      { provider: "google", modelId: OPERATION_MODEL_DEFAULTS.google.fast, label: "google.fast" },
      { provider: "openai", modelId: OPERATION_MODEL_DEFAULTS.openai.mid, label: "openai.mid" },
      { provider: "openai", modelId: OPERATION_MODEL_DEFAULTS.openai.fast, label: "openai.fast" },
    ];

    for (const { provider, modelId, label } of modelsToCheck) {
      const registry = getModels(provider);
      // Accept exact match or preview variant (forward-looking defaults
      // may reference models that only exist as -preview in the SDK)
      const found = registry.some((m) => m.id === modelId || m.id === `${modelId}-preview`);
      expect(found, `${label} model "${modelId}" not found in ${provider} registry (also checked ${modelId}-preview)`).toBe(true);
    }
  });
});

describe("OPERATION_TIER_MAP", () => {
  it("covers all 7 ModelOperationType values", () => {
    const expectedOps = ["interactive", "cron", "heartbeat", "subagent", "compaction", "taskExtraction", "condensation"];
    for (const op of expectedOps) {
      expect(OPERATION_TIER_MAP).toHaveProperty(op);
    }
    expect(Object.keys(OPERATION_TIER_MAP)).toHaveLength(7);
  });

  it("interactive is mapped to primary tier", () => {
    expect(OPERATION_TIER_MAP.interactive).toBe("primary");
  });

  it("heartbeat is mapped to fast tier", () => {
    expect(OPERATION_TIER_MAP.heartbeat).toBe("fast");
  });

  it("cron is mapped to mid tier", () => {
    expect(OPERATION_TIER_MAP.cron).toBe("mid");
  });

  it("subagent is mapped to primary tier", () => {
    expect(OPERATION_TIER_MAP.subagent).toBe("primary");
  });

  it("compaction is mapped to fast tier", () => {
    expect(OPERATION_TIER_MAP.compaction).toBe("fast");
  });

  it("taskExtraction is mapped to fast tier", () => {
    expect(OPERATION_TIER_MAP.taskExtraction).toBe("fast");
  });

  it("condensation is mapped to fast tier", () => {
    expect(OPERATION_TIER_MAP.condensation).toBe("fast");
  });
});

describe("OPERATION_TIMEOUT_DEFAULTS", () => {
  it("has correct timeout for heartbeat (60000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.heartbeat).toBe(60_000);
  });

  it("has correct timeout for cron (150000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.cron).toBe(150_000);
  });

  it("has correct timeout for subagent (120000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.subagent).toBe(120_000);
  });

  it("has correct timeout for compaction (60000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.compaction).toBe(60_000);
  });

  it("has correct timeout for taskExtraction (30000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.taskExtraction).toBe(30_000);
  });

  it("has correct timeout for condensation (30000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.condensation).toBe(30_000);
  });

  it("does NOT have an interactive key", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS).not.toHaveProperty("interactive");
  });
});

describe("OPERATION_CACHE_DEFAULTS", () => {
  it("heartbeat cache retention is none", () => {
    expect(OPERATION_CACHE_DEFAULTS.heartbeat).toBe("none");
  });

  it("compaction cache retention is none", () => {
    expect(OPERATION_CACHE_DEFAULTS.compaction).toBe("none");
  });

  it("taskExtraction cache retention is none", () => {
    expect(OPERATION_CACHE_DEFAULTS.taskExtraction).toBe("none");
  });

  it("condensation cache retention is short", () => {
    expect(OPERATION_CACHE_DEFAULTS.condensation).toBe("short");
  });
});
