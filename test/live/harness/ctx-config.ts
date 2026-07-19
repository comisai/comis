// SPDX-License-Identifier: Apache-2.0
/**
 * buildCtxConfig — shared helper for CTX scenario tests.
 *
 * Builds a temp YAML config file with contextThreshold patched under
 * agents.default. The gateway port is NOT
 * patched here — ConversationDriver._buildPortedConfigPath() handles that
 * separately so each driver gets its own unique port.
 *
 * Base config: test/config/config.test.yaml
 *
 * Shared by the context scenario files.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const _here = dirname(fileURLToPath(import.meta.url));

/**
 * Build a temp YAML config patching contextThreshold under agents.default.
 *
 * @param opts.contextThreshold - Context fill threshold [0,1]. Omit to leave at config default.
 * @param opts.label - Human-readable label used in the output filename (sanitised).
 * @param opts.filePrefix - Short prefix for the temp filename (e.g. "ctx-inv"). Defaults to "ctx".
 * @returns Absolute path to the written temp YAML file.
 */
export function buildCtxConfig(opts: {
  contextThreshold?: number;
  label: string;
  filePrefix?: string;
}): string {
  const base = join(_here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  if (!/contextEngine:/.test(content)) {
    content = content.replace(
      /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
      `$1\n    contextEngine:\n      enabled: true$2`,
    );
  }

  // Patch contextThreshold UNDER contextEngine — it is a ContextEngineConfigSchema key
  // (schema-agent-context.ts:255, attached at schema-agent-runtime.ts:371
  // `contextEngine: ContextEngineConfigSchema`), NOT a top-level agents.default key. Injecting
  // it at agents.default top-level instead fails CTX-02/05 Stage-C boot with "Bootstrap failed:
  // Config validation failed: agents.default: Unrecognized key contextThreshold". It must nest
  // inside the contextEngine block (6-space indent).
  if (opts.contextThreshold !== undefined) {
    if (/contextThreshold:\s*[\d.]+/.test(content)) {
      content = content.replace(
        /contextThreshold:\s*[\d.]+/,
        `contextThreshold: ${opts.contextThreshold}`,
      );
    } else {
      // Inject directly under the contextEngine header.
      content = content.replace(
        /(\n\s*contextEngine:\s*)/,
        `$1\n      contextThreshold: ${opts.contextThreshold}`,
      );
    }
  }

  const prefix = opts.filePrefix ?? "ctx";
  const outPath = join(
    tmpdir(),
    `${prefix}-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}
