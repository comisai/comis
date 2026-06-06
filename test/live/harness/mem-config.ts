// SPDX-License-Identifier: Apache-2.0
/**
 * buildMemConfig — shared helper for MEM scenario tests.
 *
 * Builds a temp YAML config file patching memory-specific keys under
 * agents.default. The gateway port is NOT patched here —
 * ConversationDriver._buildPortedConfigPath() handles that separately so each
 * driver gets its own unique port.
 *
 * Base config: test/config/config.test.yaml
 *
 * Keys patched (all under agents.default):
 *   - embedding.provider  (schema-embedding.ts: EmbeddingConfigSchema.provider)
 *   - embedding.local.gpu (schema-embedding.ts: EmbeddingLocalSchema.gpu)
 *   - memory.embeddingDimensions (schema-memory.ts: MemoryConfigSchema.embeddingDimensions)
 *   - memory.costFeatures.enabled (schema-memory.ts: CostFeaturesConfigSchema.enabled)
 *   - rag.{fts,vector,temporal,causal,graphSpread,entity,rerank,mmr,pinned}.enabled
 *   - rag.includeTrustLevels
 *
 * Mirrors ctx-config.ts exactly, changing only the patched key paths.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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
}

export interface MemConfigOpts {
  /** embedding.provider under agents.default (schema-embedding.ts) */
  embeddingProvider?: EmbeddingProvider;
  /** memory.embeddingDimensions under agents.default (schema-memory.ts) */
  embeddingDimensions?: number;
  /** embedding.local.gpu under agents.default (schema-embedding.ts) */
  localGpu?: LocalGpu;
  /** memory.costFeatures.enabled under agents.default (schema-memory.ts) */
  costFeaturesEnabled?: boolean;
  /** rag lane config under agents.default */
  ragConfig?: RagConfig;
  /** Human-readable label used in the output filename (sanitised). */
  label: string;
  /** Short prefix for the temp filename (e.g. "mem-golden"). Defaults to "mem". */
  filePrefix?: string;
}

/**
 * Build a temp YAML config patching memory-specific keys under agents.default.
 *
 * The gateway port is NOT patched here — ConversationDriver._buildPortedConfigPath()
 * handles that separately so each driver gets its own unique port.
 *
 * @returns Absolute path to the written temp YAML file.
 */
export function buildMemConfig(opts: MemConfigOpts): string {
  const base = join(_here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  // ── embedding.provider ────────────────────────────────────────────────────
  if (opts.embeddingProvider !== undefined) {
    if (/embedding:/.test(content)) {
      // Patch existing embedding.provider line
      if (/provider:\s*\S+/.test(content)) {
        content = content.replace(/provider:\s*\S+/, `provider: ${opts.embeddingProvider}`);
      } else {
        // embedding block exists but no provider line — inject after "embedding:"
        content = content.replace(
          /(embedding:\s*\n)/,
          `$1      provider: ${opts.embeddingProvider}\n`,
        );
      }
    } else {
      // No embedding block — inject under agents.default
      content = content.replace(
        /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
        `$1\n    embedding:\n      enabled: true\n      provider: ${opts.embeddingProvider}$2`,
      );
    }
  }

  // ── embedding.local.gpu ───────────────────────────────────────────────────
  if (opts.localGpu !== undefined) {
    if (/gpu:\s*\S+/.test(content)) {
      content = content.replace(/gpu:\s*\S+/, `gpu: ${opts.localGpu}`);
    } else if (/embedding:/.test(content)) {
      // embedding block exists — inject local.gpu after "embedding:" or "local:"
      if (/local:\s*\n/.test(content)) {
        content = content.replace(/(local:\s*\n)/, `$1        gpu: ${opts.localGpu}\n`);
      } else {
        content = content.replace(
          /(embedding:[\s\S]*?)(\n\s{4}[a-z]|\n[^\s])/,
          `$1\n      local:\n        gpu: ${opts.localGpu}$2`,
        );
      }
    } else {
      // No embedding block — inject the full embedding.local.gpu under agents.default
      content = content.replace(
        /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
        `$1\n    embedding:\n      local:\n        gpu: ${opts.localGpu}$2`,
      );
    }
  }

  // ── memory.embeddingDimensions ────────────────────────────────────────────
  if (opts.embeddingDimensions !== undefined) {
    if (/embeddingDimensions:\s*\d+/.test(content)) {
      content = content.replace(
        /embeddingDimensions:\s*\d+/,
        `embeddingDimensions: ${opts.embeddingDimensions}`,
      );
    } else {
      // Inject under agents.default.memory block (or create it)
      if (/^\s+memory:\s*$/m.test(content) || /^\s+memory:\s*\n\s+\w/m.test(content)) {
        // memory block exists under agents.default — append embeddingDimensions
        content = content.replace(
          /(^\s+memory:\s*\n)/m,
          `$1      embeddingDimensions: ${opts.embeddingDimensions}\n`,
        );
      } else {
        // No memory block under agents.default — inject
        content = content.replace(
          /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
          `$1\n    memory:\n      embeddingDimensions: ${opts.embeddingDimensions}$2`,
        );
      }
    }
  }

  // ── memory.costFeatures.enabled ───────────────────────────────────────────
  if (opts.costFeaturesEnabled !== undefined) {
    const val = String(opts.costFeaturesEnabled);
    if (/costFeatures:/.test(content)) {
      // Patch existing costFeatures.enabled line
      content = content.replace(
        /(costFeatures:\s*\n\s*enabled:\s*)\S+/,
        `$1${val}`,
      );
    } else {
      // Inject costFeatures block under agents.default.memory
      if (/^\s+memory:\s*$/m.test(content) || /^\s+memory:\s*\n\s+\w/m.test(content)) {
        content = content.replace(
          /(^\s+memory:\s*\n)/m,
          `$1      costFeatures:\n        enabled: ${val}\n`,
        );
      } else {
        content = content.replace(
          /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
          `$1\n    memory:\n      costFeatures:\n        enabled: ${val}$2`,
        );
      }
    }
  }

  // ── rag lane config ───────────────────────────────────────────────────────
  if (opts.ragConfig !== undefined) {
    const lanes = [
      "fts", "vector", "temporal", "causal", "graphSpread",
      "entity", "rerank", "mmr", "pinned",
    ] as const;

    for (const lane of lanes) {
      const val = opts.ragConfig[lane];
      if (val !== undefined) {
        // Check if this lane block already exists: "rerank:\n   enabled:"
        const lanePattern = new RegExp(`(${lane}:\\s*\\n\\s*enabled:\\s*)\\S+`);
        if (lanePattern.test(content)) {
          content = content.replace(lanePattern, `$1${String(val)}`);
        } else if (/rag:\s*\n/.test(content)) {
          // rag block exists — inject this lane block inside it (before the next top-level key after rag)
          // Append lane after the last known rag key or after "rag:\n"
          content = content.replace(
            /(rag:\s*\n(?:\s+\S[^\n]*\n)*)/,
            `$1      ${lane}:\n        enabled: ${String(val)}\n`,
          );
        } else {
          // No rag block — inject a full rag block under agents.default
          content = content.replace(
            /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
            `$1\n    rag:\n      ${lane}:\n        enabled: ${String(val)}$2`,
          );
        }
      }
    }

    if (opts.ragConfig.includeTrustLevels !== undefined) {
      const val = String(opts.ragConfig.includeTrustLevels);
      if (/includeTrustLevels:\s*\S+/.test(content)) {
        content = content.replace(/includeTrustLevels:\s*\S+/, `includeTrustLevels: ${val}`);
      } else if (/rag:\s*\n/.test(content)) {
        content = content.replace(
          /(rag:\s*\n(?:\s+\S[^\n]*\n)*)/,
          `$1      includeTrustLevels: ${val}\n`,
        );
      } else {
        content = content.replace(
          /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
          `$1\n    rag:\n      includeTrustLevels: ${val}$2`,
        );
      }
    }
  }

  const prefix = opts.filePrefix ?? "mem";
  const outPath = join(
    tmpdir(),
    `${prefix}-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}
