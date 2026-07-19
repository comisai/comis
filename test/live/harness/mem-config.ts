// SPDX-License-Identifier: Apache-2.0
/**
 * buildMemConfig — shared helper for MEM scenario tests.
 *
 * Builds a temp YAML config file patching memory-specific keys at their REAL
 * schema paths. Patching embedding/memory under agents.default instead makes
 * AppConfigSchema reject them with "Unrecognized key", failing every Stage-B
 * daemon boot; keyless CI cannot catch that because Stage-B is COMIS_LIVE-gated:
 *
 *   - embedding.provider / embedding.local.gpu   → TOP-LEVEL embedding (schema.ts)
 *   - memory.recall.embeddingDimensions          → memory.recall (schema-memory.ts)
 *   - memory.enabled                             → TOP-LEVEL memory
 *   - rag.*                                      → agents.default.rag (schema-agent-runtime.ts),
 *     using the REAL RagConfigSchema shapes (schema-agent-prompt.ts):
 *       fts/vector     → rag.lanes.<lane>.weight (these lanes have NO enabled knob;
 *                        weight 0 neutralizes the lane's RRF contribution)
 *       temporal/causal/graphSpread → rag.lanes.<lane>.enabled
 *       entity         → rag.entityLane.enabled
 *       rerank → rag.rerank.mode; mmr/pinned → rag.<knob>.enabled
 *       includeTrustLevels:true → ["system","learned","external"] (TrustLevel[] —
 *                        the boolean maps to the full spectrum so trust
 *                        arbitration is actually exercised)
 *     and rag.enabled is forced true (the base config ships enabled:false —
 *     without this every lane knob is dead config).
 *
 * Operator model-path knobs (avoid a ~146MB HuggingFace download per daemon
 * boot — each ConversationDriver uses a fresh temp dataDir, so the default
 * hf: URI re-downloads into <dataDir>/models on EVERY boot):
 *   - COMIS_LIVE_EMBED_MODEL_PATH    → embedding.local.modelUri
 *   - COMIS_LIVE_RERANKER_MODEL_PATH → memory.recall.rerankerModel
 * Both are absolute paths to pre-downloaded GGUFs (see test/live/live.env.example).
 *
 * The gateway port is NOT patched here — ConversationDriver._buildPortedConfigPath()
 * handles that separately so each driver gets its own unique port.
 *
 * Base config: test/config/config.test.yaml
 * Implementation: real YAML parse → object mutation → stringify (the regex
 * approach is what allowed schema-invalid placement to ship).
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const _here = dirname(fileURLToPath(import.meta.url));

export type EmbeddingProvider = "auto" | "local" | "openai";
export type LocalGpu = "auto" | "metal" | "cuda" | "vulkan" | "false";

export interface RagConfig {
  fts?: boolean;
  vector?: boolean;
  temporal?: boolean;
  causal?: boolean;
  graphSpread?: boolean;
  entity?: boolean;
  rerank?: boolean;
  mmr?: boolean;
  pinned?: boolean;
  includeTrustLevels?: boolean;
  /** rag.rerank.timeoutMs override (MEM-03 forced-timeout scenario). */
  rerankTimeoutMs?: number;
}

export interface MemConfigOpts {
  /** TOP-LEVEL embedding.provider (schema-embedding.ts) */
  embeddingProvider?: EmbeddingProvider;
  /** TOP-LEVEL memory.embeddingDimensions (schema-memory.ts) */
  embeddingDimensions?: number;
  /** TOP-LEVEL embedding.local.gpu (schema-embedding.ts) */
  localGpu?: LocalGpu;
  /** TOP-LEVEL memory.costFeatures.enabled (schema-memory.ts) */
  costFeaturesEnabled?: boolean;
  /** agents.default.rag lane/knob config (schema-agent-prompt.ts RagConfigSchema) */
  ragConfig?: RagConfig;
  /** Human-readable label used in the output filename (sanitised). */
  label: string;
  /** Short prefix for the temp filename (e.g. "mem-golden"). Defaults to "mem". */
  filePrefix?: string;
}

type Doc = Record<string, unknown>;

function ensureObj(parent: Doc, key: string): Doc {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Doc;
  }
  const fresh: Doc = {};
  parent[key] = fresh;
  return fresh;
}

/**
 * Build a temp YAML config patching memory-specific keys at their real schema
 * paths (top-level embedding/memory; agents.default.rag).
 *
 * The gateway port is NOT patched here — ConversationDriver._buildPortedConfigPath()
 * handles that separately so each driver gets its own unique port.
 *
 * @returns Absolute path to the written temp YAML file.
 */
export function buildMemConfig(opts: MemConfigOpts): string {
  const base = join(_here, "../../config/config.test.yaml");
  const doc = parseYaml(readFileSync(base, "utf-8")) as Doc;

  // ── embedding.* — TOP-LEVEL ───────────────────────────────────────────────
  if (opts.embeddingProvider !== undefined || opts.localGpu !== undefined) {
    const embedding = ensureObj(doc, "embedding");
    embedding["enabled"] = true;
    if (opts.embeddingProvider !== undefined) {
      embedding["provider"] = opts.embeddingProvider;
    }
    if (opts.localGpu !== undefined) {
      ensureObj(embedding, "local")["gpu"] = opts.localGpu;
    }
  }
  // Operator knob: use a pre-downloaded GGUF instead of the default hf: URI
  // (which would download ~146MB into the fresh temp dataDir on EVERY boot).
  // Applied UNCONDITIONALLY (unless the test explicitly targets openai):
  // embedding.enabled defaults true with provider "auto" → local, so even
  // configs that never set embeddingProvider (e.g. MEM-03's ragConfig-only
  // lane combos) boot the local embedder — which re-downloads mid-run
  // when this knob is nested inside the embeddingProvider branch instead.
  const embedModelPath = process.env["COMIS_LIVE_EMBED_MODEL_PATH"];
  if (embedModelPath && opts.embeddingProvider !== "openai") {
    ensureObj(ensureObj(doc, "embedding"), "local")["modelUri"] = embedModelPath;
  }

  // ── memory.* — TOP-LEVEL (recall knobs nested under memory.recall;
  //    the master cost gate is memory.enabled) ──
  if (opts.embeddingDimensions !== undefined) {
    ensureObj(ensureObj(doc, "memory"), "recall")["embeddingDimensions"] = opts.embeddingDimensions;
  }
  if (opts.costFeaturesEnabled !== undefined) {
    ensureObj(doc, "memory")["enabled"] = opts.costFeaturesEnabled;
  }
  const rerankerModelPath = process.env["COMIS_LIVE_RERANKER_MODEL_PATH"];
  if (rerankerModelPath) {
    ensureObj(ensureObj(doc, "memory"), "recall")["rerankerModel"] = rerankerModelPath;
  }

  // ── rag — agents.default.rag (RagConfigSchema shapes) ────────────────────
  if (opts.ragConfig !== undefined) {
    const rc = opts.ragConfig;
    const rag = ensureObj(ensureObj(ensureObj(doc, "agents"), "default"), "rag");
    // Base config ships rag.enabled:false — without this every lane knob is dead.
    rag["enabled"] = true;

    if (rc.fts !== undefined) {
      ensureObj(ensureObj(rag, "lanes"), "fts")["weight"] = rc.fts ? 1.0 : 0;
    }
    if (rc.vector !== undefined) {
      ensureObj(ensureObj(rag, "lanes"), "vector")["weight"] = rc.vector ? 1.5 : 0;
    }
    if (rc.temporal !== undefined) {
      ensureObj(ensureObj(rag, "lanes"), "temporal")["enabled"] = rc.temporal;
    }
    if (rc.causal !== undefined) {
      ensureObj(ensureObj(rag, "lanes"), "causal")["enabled"] = rc.causal;
    }
    if (rc.graphSpread !== undefined) {
      ensureObj(ensureObj(rag, "lanes"), "graphSpread")["enabled"] = rc.graphSpread;
    }
    if (rc.entity !== undefined) {
      ensureObj(rag, "entityLane")["enabled"] = rc.entity;
    }
    if (rc.rerank !== undefined) {
      ensureObj(rag, "rerank")["mode"] = rc.rerank ? "on" : "off";
    }
    if (rc.rerankTimeoutMs !== undefined) {
      ensureObj(rag, "rerank")["timeoutMs"] = rc.rerankTimeoutMs;
    }
    if (rc.mmr !== undefined) {
      ensureObj(rag, "mmr")["enabled"] = rc.mmr;
    }
    if (rc.pinned !== undefined) {
      ensureObj(rag, "pinned")["enabled"] = rc.pinned;
    }
    if (rc.includeTrustLevels === true) {
      rag["includeTrustLevels"] = ["system", "learned", "external"];
    }
  }

  const prefix = opts.filePrefix ?? "mem";
  const outPath = join(
    tmpdir(),
    `${prefix}-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, stringifyYaml(doc), "utf-8");
  return outPath;
}
