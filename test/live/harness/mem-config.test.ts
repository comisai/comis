// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for buildMemConfig — Stage-A, no daemon required.
 *
 * Regex-patching keys at schema-INVALID paths (embedding/memory under
 * agents.default; boolean includeTrustLevels) makes every Stage-B daemon boot
 * fail with "Config validation failed: agents.default: Unrecognized key:
 * 'embedding'". Substring assertions (e.g. /provider:\s*local/) pass for both
 * the wrong and the right placement, so they cannot catch that misplacement.
 *
 * These tests now assert the produced YAML:
 *   1. parses through the REAL AppConfigSchema (any misplaced key → loud fail),
 *   2. places each patched key at its actual schema path:
 *      - embedding.*            → TOP-LEVEL (AppConfigSchema.embedding)
 *      - memory.*               → TOP-LEVEL (MemoryConfigSchema)
 *      - rag.*                  → agents.default.rag (RagConfigSchema), with
 *        the REAL lane shapes (lanes.fts.weight — no enabled knob; entityLane;
 *        includeTrustLevels as TrustLevel[]),
 *   3. honors COMIS_LIVE_EMBED_MODEL_PATH / COMIS_LIVE_RERANKER_MODEL_PATH so
 *      operator-predownloaded GGUFs are used instead of a per-boot HF download.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { AppConfigSchema } from "@comis/core";
import { buildMemConfig } from "./mem-config.js";

const made: string[] = [];
function build(opts: Parameters<typeof buildMemConfig>[0]): string {
  const p = buildMemConfig(opts);
  made.push(p);
  return p;
}
function loadDoc(p: string): Record<string, unknown> {
  return parseYaml(readFileSync(p, "utf-8")) as Record<string, unknown>;
}
/** Parse + validate through the real config schema; returns the typed config. */
function loadValid(p: string) {
  const doc = loadDoc(p);
  const result = AppConfigSchema.safeParse(doc);
  expect(
    result.success,
    result.success ? "" : `produced config is schema-INVALID: ${JSON.stringify(result.error.issues.slice(0, 5))}`,
  ).toBe(true);
  return result.success ? result.data : (undefined as never);
}

afterEach(() => {
  for (const p of made.splice(0)) {
    try { rmSync(p, { force: true }); } catch { /* ignore */ }
  }
});

describe("buildMemConfig — returns a file path that exists", () => {
  it("creates a file at the returned path", () => {
    const p = build({ label: "exists-check", embeddingProvider: "local" });
    expect(existsSync(p)).toBe(true);
  });
});

describe("buildMemConfig — every option combo produces a schema-VALID config", () => {
  it("all options together parse through AppConfigSchema", () => {
    const p = build({
      label: "all-opts",
      embeddingProvider: "local",
      embeddingDimensions: 768,
      localGpu: "false",
      costFeaturesEnabled: false,
      ragConfig: {
        fts: true, vector: true, temporal: true, causal: true,
        graphSpread: true, entity: true, rerank: true, mmr: true,
        pinned: true, includeTrustLevels: true,
      },
    });
    loadValid(p);
  });

  it("no options (label only) still parses through AppConfigSchema", () => {
    const p = build({ label: "bare" });
    loadValid(p);
  });
});

describe("buildMemConfig — Behavior A: embedding patched at TOP level", () => {
  it("writes embedding.provider at top level, NOT under agents.default", () => {
    const p = build({ label: "emb-local", embeddingProvider: "local" });
    const cfg = loadValid(p);
    expect(cfg.embedding.provider).toBe("local");
    const agentDefault = loadDoc(p)["agents"] as Record<string, Record<string, unknown>>;
    expect(agentDefault["default"]!["embedding"]).toBeUndefined();
  });

  it("writes embedding.provider openai", () => {
    const p = build({ label: "emb-openai", embeddingProvider: "openai" });
    expect(loadValid(p).embedding.provider).toBe("openai");
  });

  it("writes embedding.local.gpu at top level (Behavior E)", () => {
    const p = build({ label: "gpu-off", localGpu: "false" });
    expect(loadValid(p).embedding.local.gpu).toBe("false");
  });
});

describe("buildMemConfig — Behavior B/C: memory.* patched at TOP level", () => {
  it("writes memory.recall.embeddingDimensions nested under memory.recall", () => {
    const p = build({ label: "dims", embeddingDimensions: 768 });
    const cfg = loadValid(p);
    expect(cfg.memory.recall.embeddingDimensions).toBe(768);
    // preserves the base config's other memory keys (dbPath)
    expect(cfg.memory.dbPath).toBe("test-memory-default.db");
  });

  it("writes memory.enabled as the master cost gate", () => {
    const p = build({ label: "cost-off", costFeaturesEnabled: false });
    const cfg = loadValid(p);
    expect(cfg.memory.enabled).toBe(false);
  });
});

describe("buildMemConfig — Behavior D: rag patched under agents.default with REAL lane shapes", () => {
  it("sets rag.enabled true (base config has it false — lanes are dead otherwise)", () => {
    const p = build({ label: "rag-on", ragConfig: { fts: true } });
    const cfg = loadValid(p);
    expect(cfg.agents["default"]!.rag.enabled).toBe(true);
  });

  it("fts/vector map to lanes.<lane>.weight (no enabled knob exists)", () => {
    const p = build({ label: "lanes", ragConfig: { fts: true, vector: false } });
    const rag = loadValid(p).agents["default"]!.rag;
    expect(rag.lanes.fts.weight).toBeGreaterThan(0);
    expect(rag.lanes.vector.weight).toBe(0);
  });

  it("temporal/causal/graphSpread map to lanes.<lane>.enabled", () => {
    const p = build({
      label: "lanes-toggles",
      ragConfig: { temporal: false, causal: true, graphSpread: false },
    });
    const rag = loadValid(p).agents["default"]!.rag;
    expect(rag.lanes.temporal.enabled).toBe(false);
    expect(rag.lanes.causal.enabled).toBe(true);
    expect(rag.lanes.graphSpread.enabled).toBe(false);
  });

  it("entity maps to entityLane.enabled", () => {
    const p = build({ label: "entity", ragConfig: { entity: true } });
    expect(loadValid(p).agents["default"]!.rag.entityLane.enabled).toBe(true);
  });

  it("rerank maps to mode while mmr and pinned map to enabled", () => {
    const p = build({ label: "post", ragConfig: { rerank: true, mmr: false, pinned: true } });
    const rag = loadValid(p).agents["default"]!.rag;
    expect(rag.rerank.mode).toBe("on");
    expect(rag.mmr.enabled).toBe(false);
    expect(rag.pinned.enabled).toBe(true);
  });

  it("includeTrustLevels:true maps to the full TrustLevel[] spectrum", () => {
    const p = build({ label: "trust", ragConfig: { includeTrustLevels: true } });
    const rag = loadValid(p).agents["default"]!.rag;
    expect(rag.includeTrustLevels).toEqual(["system", "learned", "external"]);
  });

  it("rerankTimeoutMs maps to rag.rerank.timeoutMs (MEM-03 forced-timeout knob)", () => {
    const p = build({ label: "rr-timeout", ragConfig: { rerank: true, rerankTimeoutMs: 1 } });
    const rag = loadValid(p).agents["default"]!.rag;
    expect(rag.rerank.timeoutMs).toBe(1);
  });
});

describe("buildMemConfig — operator model-path env knobs (no per-boot HF download)", () => {
  it("applies COMIS_LIVE_EMBED_MODEL_PATH to embedding.local.modelUri", () => {
    const prior = process.env["COMIS_LIVE_EMBED_MODEL_PATH"];
    process.env["COMIS_LIVE_EMBED_MODEL_PATH"] = "/abs/path/embed.gguf";
    try {
      const p = build({ label: "embed-path", embeddingProvider: "local" });
      expect(loadValid(p).embedding.local.modelUri).toBe("/abs/path/embed.gguf");
    } finally {
      if (prior === undefined) delete process.env["COMIS_LIVE_EMBED_MODEL_PATH"];
      else process.env["COMIS_LIVE_EMBED_MODEL_PATH"] = prior;
    }
  });

  it("COMIS_LIVE_EMBED_MODEL_PATH applies even WITHOUT embeddingProvider (ragConfig-only configs boot the local embedder too)", () => {
    const prior = process.env["COMIS_LIVE_EMBED_MODEL_PATH"];
    process.env["COMIS_LIVE_EMBED_MODEL_PATH"] = "/abs/path/embed.gguf";
    try {
      const p = build({ label: "lanes-only", ragConfig: { fts: true, vector: true } });
      expect(loadValid(p).embedding.local.modelUri).toBe("/abs/path/embed.gguf");
    } finally {
      if (prior === undefined) delete process.env["COMIS_LIVE_EMBED_MODEL_PATH"];
      else process.env["COMIS_LIVE_EMBED_MODEL_PATH"] = prior;
    }
  });

  it("applies COMIS_LIVE_RERANKER_MODEL_PATH to memory.recall.rerankerModel", () => {
    const prior = process.env["COMIS_LIVE_RERANKER_MODEL_PATH"];
    process.env["COMIS_LIVE_RERANKER_MODEL_PATH"] = "/abs/path/rerank.gguf";
    try {
      const p = build({ label: "rr-path", embeddingProvider: "local" });
      expect(loadValid(p).memory.recall.rerankerModel).toBe("/abs/path/rerank.gguf");
    } finally {
      if (prior === undefined) delete process.env["COMIS_LIVE_RERANKER_MODEL_PATH"];
      else process.env["COMIS_LIVE_RERANKER_MODEL_PATH"] = prior;
    }
  });

  it("without the env knobs, modelUri/rerankerModel are untouched (hf: default path)", () => {
    const priorE = process.env["COMIS_LIVE_EMBED_MODEL_PATH"];
    const priorR = process.env["COMIS_LIVE_RERANKER_MODEL_PATH"];
    delete process.env["COMIS_LIVE_EMBED_MODEL_PATH"];
    delete process.env["COMIS_LIVE_RERANKER_MODEL_PATH"];
    try {
      const p = build({ label: "no-knobs", embeddingProvider: "local" });
      const doc = loadDoc(p);
      const embedding = doc["embedding"] as Record<string, Record<string, unknown>> | undefined;
      expect(embedding?.["local"]?.["modelUri"]).toBeUndefined();
      const memory = doc["memory"] as Record<string, unknown>;
      const recall = memory["recall"] as Record<string, unknown> | undefined;
      expect(recall?.["rerankerModel"]).toBeUndefined();
    } finally {
      if (priorE !== undefined) process.env["COMIS_LIVE_EMBED_MODEL_PATH"] = priorE;
      if (priorR !== undefined) process.env["COMIS_LIVE_RERANKER_MODEL_PATH"] = priorR;
    }
  });
});

describe("buildMemConfig — gateway block survives for _buildPortedConfigPath", () => {
  it("output still contains a gateway: block with an indented port: line", () => {
    const p = build({ label: "gateway-shape", embeddingProvider: "local" });
    const content = readFileSync(p, "utf-8");
    expect(content).toMatch(/\ngateway:/);
    const gatewayIdx = content.indexOf("\ngateway:");
    const block = content.slice(gatewayIdx);
    expect(block).toMatch(/\n\s+port:\s*\d+/);
  });
});

describe("buildMemConfig — Behavior F: file naming", () => {
  it("uses 'mem' as default prefix", () => {
    const p = build({ label: "naming-test" });
    expect(p).toMatch(/mem-naming-test-\d+\.yaml$/);
  });

  it("uses custom filePrefix when provided", () => {
    const p = build({ label: "prefix-test", filePrefix: "myprefix" });
    expect(p).toMatch(/myprefix-prefix-test-\d+\.yaml$/);
  });

  it("sanitises label replacing non-alphanumeric chars with underscores", () => {
    const p = build({ label: "foo bar/baz" });
    expect(p).toMatch(/mem-foo_bar_baz-\d+\.yaml$/);
  });
});
