// SPDX-License-Identifier: Apache-2.0
/**
 * buildToolConfig — shared helper for tool-mode scenario tests.
 *
 * Builds a temp YAML config file patching two keys from the DEFERRED_MODES
 * matrix:
 *
 *   1. agents.default.deferredTools.mode   ("always"|"auto"|"never")
 *      — standard agent config; lives inside the `agents: → default:` block
 *
 *   2. tooling.installDetours.mode         ("observe"|"advise"|"soft-stop")
 *      — CRITICAL: lives under the TOP-LEVEL `tooling:` section, NOT under
 *        agents.default. This matches the real config schema
 *        (packages/core/src/config/schema-tooling.ts ToolingConfigSchema →
 *        installDetours field) and the product config pattern shown in
 *        test/config/config.test-install-detour-advise.yaml:
 *
 *          tooling:
 *            installDetours:
 *              mode: advise
 *
 *      Do NOT place installDetours.mode under agents.default — that key does
 *      not exist in the schema and will fail validation.
 *
 * The gateway port is NOT patched here — ConversationDriver._buildPortedConfigPath()
 * handles that separately so each driver gets its own unique port.
 *
 * Base config: test/config/config.test.yaml
 *
 * Mirrors ctx-config.ts and mem-config.ts exactly, changing only the patched
 * key paths.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const _here = dirname(fileURLToPath(import.meta.url));

/**
 * Options for building a per-DEFERRED_MODES-cell temp config.
 */
export interface ToolConfigOpts {
  /**
   * agents.default.deferredTools.mode — controls whether tools are deferred
   * for approval before execution.
   * Omit to leave at the config default.
   */
  deferredToolsMode?: "always" | "auto" | "never";
  /**
   * tooling.installDetours.mode — controls how the install-detour validator
   * reacts to pip/npm install commands that overlap with connected MCP servers.
   * Lives under the TOP-LEVEL tooling: section (not agents.default).
   * Omit to leave at the config default.
   */
  installDetourMode?: "observe" | "advise" | "soft-stop";
  /** Human-readable label used in the output filename (sanitised). */
  label: string;
  /** Short prefix for the temp filename (e.g. "tool-deferred"). Defaults to "tool". */
  filePrefix?: string;
}

/**
 * Build a temp YAML config patching deferredTools.mode and/or
 * tooling.installDetours.mode.
 *
 * The gateway port is NOT patched here — ConversationDriver._buildPortedConfigPath()
 * handles that separately so each driver gets its own unique port.
 *
 * @returns Absolute path to the written temp YAML file.
 */
export function buildToolConfig(opts: ToolConfigOpts): string {
  const base = join(_here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  // ── agents.default.deferredTools.mode ────────────────────────────────────
  // Patch only when the opt is provided.
  if (opts.deferredToolsMode !== undefined) {
    const mode = opts.deferredToolsMode;

    if (/deferredTools:/.test(content)) {
      // deferredTools block already exists — replace the mode line within it.
      content = content.replace(
        /(deferredTools:\s*\n\s*mode:\s*)\S+/,
        `$1${mode}`,
      );
    } else {
      // No deferredTools block — inject under agents.default.
      // The regex anchors to the `agents: → default:` block and appends
      // before the next top-level key (column 0, non-whitespace character).
      content = content.replace(
        /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
        `$1\n    deferredTools:\n      mode: ${mode}$2`,
      );
    }
  }

  // ── tooling.installDetours.mode ───────────────────────────────────────────
  // CRITICAL: installDetours lives under the TOP-LEVEL `tooling:` section.
  // Do NOT place it under agents.default — that path does not exist in the schema.
  if (opts.installDetourMode !== undefined) {
    const mode = opts.installDetourMode;

    if (/^tooling:/m.test(content)) {
      // A top-level tooling: block already exists.
      if (/installDetours:/.test(content)) {
        // installDetours sub-block exists — replace the mode line.
        content = content.replace(
          /(installDetours:\s*\n\s*mode:\s*)\S+/,
          `$1${mode}`,
        );
      } else {
        // tooling: exists but no installDetours sub-block — inject it.
        content = content.replace(
          /(^tooling:\s*\n)/m,
          `$1  installDetours:\n    mode: ${mode}\n`,
        );
      }
    } else {
      // No tooling: block at all — append at the end of the file.
      content =
        content.trimEnd() +
        `\ntooling:\n  installDetours:\n    mode: ${mode}\n`;
    }
  }

  const prefix = opts.filePrefix ?? "tool";
  const outPath = join(
    tmpdir(),
    `${prefix}-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}
