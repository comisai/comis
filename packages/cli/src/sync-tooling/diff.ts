// SPDX-License-Identifier: Apache-2.0
/**
 * Inspect-mode renderers for `comis config sync-tooling`.
 *
 * Pure functions: take an `InspectPayload` (assembled by the action
 * callback), return a string. NO console.log calls, NO fs I/O, NO Commander.
 * The caller emits via the existing `format.ts` helpers.
 *
 * The rendered output always contains the literal `tooling:` block because
 * `payload.wouldWrite` (the post-mutation `doc.toString()` output) is
 * appended verbatim into the "Would write:" preview section.
 *
 * @module
 */

import chalk from "chalk";
import type { DiscoveredArtifacts } from "./discover.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregated payload for inspect-mode rendering (built by the action callback). */
export interface InspectPayload {
  readonly discovered: DiscoveredArtifacts;
  readonly existing: {
    readonly tooling: "present" | "absent";
    readonly mcpHintNames: string[];
    readonly skillHintNames: string[];
  };
  readonly diff: {
    readonly add: { readonly mcps: string[]; readonly skills: string[] };
    readonly remove: { readonly mcps: string[]; readonly skills: string[] };
  };
  /** Post-mutation `doc.toString()` (contains literal `tooling:`). */
  readonly wouldWrite: string;
}

// ---------------------------------------------------------------------------
// Human renderer
// ---------------------------------------------------------------------------

/**
 * Render the inspect-mode human-readable summary.
 *
 * Sections:
 *   - Discovered MCPs (N) — list each name
 *   - Discovered Skills (N) — list each name
 *   - Existing tooling block: present|absent
 *   - Would add (N) — list each name with `+ ` prefix
 *   - Would remove (N) — list each name with `- ` prefix
 *   - Would write: — verbatim YAML preview from payload.wouldWrite
 */
export function renderInspectHuman(payload: InspectPayload): string {
  const lines: string[] = [];

  // Discovered MCPs
  lines.push(chalk.bold.cyan(`Discovered MCPs (${payload.discovered.mcps.length})`));
  if (payload.discovered.mcps.length === 0) {
    lines.push(chalk.dim("  (none)"));
  } else {
    for (const m of payload.discovered.mcps) {
      lines.push(`  - ${chalk.green(m.name)}`);
    }
  }

  // Discovered Skills
  lines.push(chalk.bold.cyan(`Discovered Skills (${payload.discovered.skills.length})`));
  if (payload.discovered.skills.length === 0) {
    lines.push(chalk.dim("  (none)"));
  } else {
    for (const s of payload.discovered.skills) {
      lines.push(`  - ${chalk.green(s.name)}`);
    }
  }

  // Existing tooling block
  lines.push(
    `${chalk.bold.cyan("Existing tooling block:")} ${payload.existing.tooling}`,
  );

  // Would add
  const addCount = payload.diff.add.mcps.length + payload.diff.add.skills.length;
  lines.push(chalk.bold.cyan(`Would add (${addCount})`));
  if (addCount === 0) {
    lines.push(chalk.dim("  (none)"));
  } else {
    for (const name of payload.diff.add.mcps) {
      lines.push(`  + ${chalk.green(name)} ${chalk.dim("(mcp)")}`);
    }
    for (const name of payload.diff.add.skills) {
      lines.push(`  + ${chalk.green(name)} ${chalk.dim("(skill)")}`);
    }
  }

  // Would remove
  const removeCount =
    payload.diff.remove.mcps.length + payload.diff.remove.skills.length;
  lines.push(chalk.bold.cyan(`Would remove (${removeCount})`));
  if (removeCount === 0) {
    lines.push(chalk.dim("  (none)"));
  } else {
    for (const name of payload.diff.remove.mcps) {
      lines.push(`  - ${chalk.red(name)} ${chalk.dim("(mcp)")}`);
    }
    for (const name of payload.diff.remove.skills) {
      lines.push(`  - ${chalk.red(name)} ${chalk.dim("(skill)")}`);
    }
  }

  // Would write — verbatim YAML preview (contains "tooling:")
  lines.push(chalk.bold.cyan("Would write:"));
  lines.push(payload.wouldWrite);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON renderer
// ---------------------------------------------------------------------------

/**
 * Render the inspect-mode JSON output.
 *
 * Returns a 2-space-indented JSON string with the four canonical top-level
 * keys (`discovered`, `existing`, `diff`, `wouldWrite`) — in InspectPayload's
 * declaration order.
 */
export function renderInspectJson(payload: InspectPayload): string {
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Unified diff (line-by-line, capped)
// ---------------------------------------------------------------------------

/** Maximum number of diff lines to emit before truncation (operator UX). */
const MAX_DIFF_LINES = 50;

/**
 * Inline simple line-by-line diff: lines unique to `before` are prefixed `- `,
 * lines unique to `after` are prefixed `+ `, matching lines are skipped.
 *
 * Cap at 50 lines; longer diffs are truncated with a "(N more lines)" tail.
 *
 * Pattern mirrors the precedent at
 * `packages/daemon/src/config/last-known-good.ts:101-127`.
 */
export function renderUnifiedDiff(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < max; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined && newLine === undefined) {
      out.push(`- ${oldLine}`);
    } else if (oldLine === undefined && newLine !== undefined) {
      out.push(`+ ${newLine}`);
    } else if (oldLine !== newLine) {
      out.push(`- ${oldLine}`);
      out.push(`+ ${newLine}`);
    }
  }

  if (out.length === 0) return "(no differences)";
  if (out.length > MAX_DIFF_LINES) {
    const remainder = out.length - MAX_DIFF_LINES;
    return `${out.slice(0, MAX_DIFF_LINES).join("\n")}\n... (${remainder} more lines)`;
  }
  return out.join("\n");
}
