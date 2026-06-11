// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  compareServedWindowForProvider,
  resetServedWindowWarnForTest,
  type ServedWindowComparisonInput,
} from "./served-window-comparator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recording logger stub — captures every warn(obj, msg) call for assertions. */
function createRecordingLogger(): {
  warnCalls: Array<[Record<string, unknown>, string]>;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
} {
  const warnCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    warnCalls,
    logger: {
      warn(obj: Record<string, unknown>, msg: string): void {
        warnCalls.push([obj, msg]);
      },
    },
  };
}

/** Recording findModel stub — captures (provider, modelId) registry lookups. */
function createRecordingFindModel(result: { contextWindow?: number } | undefined): {
  findCalls: Array<[string, string]>;
  findModel: ServedWindowComparisonInput["findModel"];
} {
  const findCalls: Array<[string, string]> = [];
  return {
    findCalls,
    findModel: (provider: string, modelId: string) => {
      findCalls.push([provider, modelId]);
      return result;
    },
  };
}

/** WARN-obj field view for assertions (logger contract is Record<string, unknown>). */
interface WarnFields {
  providerId?: unknown;
  served?: unknown;
  configured?: unknown;
  probedModel?: unknown;
  errorKind?: unknown;
  submodule?: unknown;
  hint?: unknown;
}

// ---------------------------------------------------------------------------
// compareServedWindowForProvider — KNOB-01
// ---------------------------------------------------------------------------

describe("compareServedWindowForProvider", () => {
  beforeEach(() => {
    resetServedWindowWarnForTest();
  });

  it("KNOB-01-1: served 8192 < configured 131072 → ONE WARN naming both numbers, both Ollama knobs, the probed model, and the opt-out", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findModel } = createRecordingFindModel({ contextWindow: 131_072 });

    const result = compareServedWindowForProvider({
      providerId: "qwen-local",
      served: 8_192,
      providerEntry: { models: [{ id: "qwen3.6:35b" }] },
      findModel,
      logger,
    });

    expect(result).toEqual({
      providerId: "qwen-local",
      served: 8_192,
      configured: 131_072,
      probedModelId: "qwen3.6:35b",
      belowConfigured: true,
    });

    expect(warnCalls).toHaveLength(1);
    const [obj, msg] = warnCalls[0]!;
    expect(msg).toBe("Ollama served context window below configured");

    const fields = obj as WarnFields;
    expect(fields.served).toBe(8_192);
    expect(fields.configured).toBe(131_072);
    expect(fields.probedModel).toBe("qwen3.6:35b");
    expect(fields.errorKind).toBe("config");
    expect(fields.submodule).toBe("served-window-comparator");

    const hint = String(fields.hint);
    expect(hint).toContain("OLLAMA_CONTEXT_LENGTH=131072 ollama serve");
    expect(hint).toContain("PARAMETER num_ctx 131072");
    expect(hint).toContain("providers.entries.qwen-local.capabilities.probeServedWindow: false");
    expect(hint).toContain("config-yaml");
  });

  it("KNOB-01-2: served === configured (131072) → belowConfigured false and ZERO warns (healthy boot silent, R-4)", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findModel } = createRecordingFindModel({ contextWindow: 131_072 });

    const result = compareServedWindowForProvider({
      providerId: "qwen-local",
      served: 131_072,
      providerEntry: { models: [{ id: "qwen3.6:35b" }] },
      findModel,
      logger,
    });

    expect(result).toEqual({
      providerId: "qwen-local",
      served: 131_072,
      configured: 131_072,
      probedModelId: "qwen3.6:35b",
      belowConfigured: false,
    });
    expect(warnCalls).toHaveLength(0);
  });

  it("KNOB-01-3: served 200000 above configured 131072 → belowConfigured false and ZERO warns", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findModel } = createRecordingFindModel({ contextWindow: 131_072 });

    const result = compareServedWindowForProvider({
      providerId: "qwen-local",
      served: 200_000,
      providerEntry: { models: [{ id: "qwen3.6:35b" }] },
      findModel,
      logger,
    });

    expect(result?.belowConfigured).toBe(false);
    expect(result?.served).toBe(200_000);
    expect(result?.configured).toBe(131_072);
    expect(warnCalls).toHaveLength(0);
  });

  it("KNOB-01-4: probe absent (served undefined) → returns undefined, ZERO warns, no registry lookup (absent = no comparison, not zero-served)", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findCalls, findModel } = createRecordingFindModel({ contextWindow: 131_072 });

    const result = compareServedWindowForProvider({
      providerId: "qwen-local",
      served: undefined,
      providerEntry: { models: [{ id: "qwen3.6:35b" }] },
      findModel,
      logger,
    });

    expect(result).toBeUndefined();
    expect(warnCalls).toHaveLength(0);
    expect(findCalls).toHaveLength(0);
  });

  it("KNOB-01-5: two under-served calls for the SAME provider → ONE WARN total (per-provider latch) but BOTH calls return the comparison", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findModel } = createRecordingFindModel({ contextWindow: 131_072 });

    const input: ServedWindowComparisonInput = {
      providerId: "qwen-local",
      served: 8_192,
      providerEntry: { models: [{ id: "qwen3.6:35b" }] },
      findModel,
      logger,
    };

    const first = compareServedWindowForProvider(input);
    const second = compareServedWindowForProvider(input);

    expect(warnCalls).toHaveLength(1);
    expect(first).toBeDefined();
    expect(second).toEqual(first);
    expect(second?.belowConfigured).toBe(true);
  });

  it("KNOB-01-6: after resetServedWindowWarnForTest() the same provider WARNs again (latch reset)", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findModel } = createRecordingFindModel({ contextWindow: 131_072 });

    const input: ServedWindowComparisonInput = {
      providerId: "qwen-local",
      served: 8_192,
      providerEntry: { models: [{ id: "qwen3.6:35b" }] },
      findModel,
      logger,
    };

    compareServedWindowForProvider(input);
    expect(warnCalls).toHaveLength(1);

    resetServedWindowWarnForTest();
    compareServedWindowForProvider(input);
    expect(warnCalls).toHaveLength(2);
  });

  it("KNOB-01-7: findModel yields no contextWindow → configured falls back to 8192 (executor's ?? 8_192 parity); served 4096 WARNs against 8192", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findModel } = createRecordingFindModel({ contextWindow: undefined });

    const result = compareServedWindowForProvider({
      providerId: "qwen-local",
      served: 4_096,
      providerEntry: { models: [{ id: "qwen3.6:35b" }] },
      findModel,
      logger,
    });

    expect(result?.configured).toBe(8_192);
    expect(result?.belowConfigured).toBe(true);
    expect(warnCalls).toHaveLength(1);
    expect((warnCalls[0]![0] as WarnFields).configured).toBe(8_192);
  });

  it("KNOB-01-8: defaultModel takes precedence over models[0].id for the probed model (same expression as the probe)", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findCalls, findModel } = createRecordingFindModel({ contextWindow: 131_072 });

    const result = compareServedWindowForProvider({
      providerId: "qwen-local",
      served: 131_072,
      providerEntry: { defaultModel: "explicit:tag", models: [{ id: "other" }] },
      findModel,
      logger,
    });

    expect(result?.probedModelId).toBe("explicit:tag");
    expect(findCalls).toEqual([["qwen-local", "explicit:tag"]]);
    expect(warnCalls).toHaveLength(0);
  });

  it("KNOB-01-9: providerEntry undefined → probedModelId '' used for the registry lookup; comparison still runs against the findModel result", () => {
    const { warnCalls, logger } = createRecordingLogger();
    const { findCalls, findModel } = createRecordingFindModel({ contextWindow: 131_072 });

    const result = compareServedWindowForProvider({
      providerId: "qwen-local",
      served: 8_192,
      providerEntry: undefined,
      findModel,
      logger,
    });

    expect(findCalls).toEqual([["qwen-local", ""]]);
    expect(result).toEqual({
      providerId: "qwen-local",
      served: 8_192,
      configured: 131_072,
      probedModelId: "",
      belowConfigured: true,
    });
    expect(warnCalls).toHaveLength(1);
  });
});
