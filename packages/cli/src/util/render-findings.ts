// SPDX-License-Identifier: Apache-2.0
/**
 * Common operator-facing CLI render helper — consolidates 5 sites:
 *   - doctor/output.ts        : compact line-per-finding
 *   - security/output.ts      : cli-table3 5-col table
 *   - commands/health.ts      : compact line-per-finding grouped by category
 *   - commands/status.ts      : multi-section (renderKeyValue + renderTable)
 *   - commands/channel.ts     : flat 4-col table
 *
 * Discriminated-union `FindingsInput` keeps the API tight — each variant's
 * data is structurally distinct. No cross-variant option flags. The findings
 * variant carries findings-shape data plus a summary; the sections variant
 * carries layout-shape data (kv + table sections).
 *
 * @module
 */

import chalk from "chalk";
import { renderTable, renderKeyValue } from "../output/table.js";

/** Unified 6-state status across doctor / security / health. */
export type NormalizedStatus =
  | "pass"
  | "fail"
  | "warn"
  | "skip" // doctor-only
  | "critical" // security-only
  | "info"; // security-only

/** Common findings row consumed by doctor / security / health. */
export interface NormalizedFinding {
  readonly status: NormalizedStatus;
  readonly category: string;
  readonly title: string;
  readonly message: string;
  readonly hint?: string;
  readonly badge?: string;
}

/** Summary footer composition for findings variants. */
export interface FindingsSummary {
  readonly total: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly footer?: string;
}

/** Layout-shape section for status / channel variants. */
export type Section =
  | {
      readonly kind: "kv";
      readonly title: string;
      readonly pairs: ReadonlyArray<readonly [string, string]>;
    }
  | {
      readonly kind: "table";
      readonly title?: string;
      readonly headers: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<ReadonlyArray<string>>;
      readonly emptyMessage?: string;
    };

/** Discriminated input — each branch shape is structurally distinct. */
export type FindingsInput =
  | {
      readonly kind: "findings";
      readonly findings: ReadonlyArray<NormalizedFinding>;
      readonly summary: FindingsSummary;
    }
  | {
      readonly kind: "sections";
      readonly sections: ReadonlyArray<Section>;
    };

export interface RenderFindingsOptions {
  /** Group findings by category (health uses this). Ignored for "sections" variant. */
  readonly groupBy?: "none" | "category";
  /** "compact" = line-per-finding (doctor/health); "table" = cli-table3 (security). Ignored for "sections" variant. */
  readonly renderMode?: "compact" | "table";
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Unified status-to-icon mapping (lifts both doctor's 4-state and security's 3-state). */
function statusIcon(status: NormalizedStatus): string {
  switch (status) {
    case "pass":
      return chalk.green("v");
    case "fail":
      return chalk.red("X");
    case "warn":
      return chalk.yellow("!");
    case "skip":
      return chalk.gray("-");
    case "critical":
      return chalk.red("X");
    case "info":
      return chalk.blue("i");
  }
}

/** Security table-mode severity-label colorizer. */
function colorSeverity(status: NormalizedStatus): string {
  switch (status) {
    case "critical":
      return chalk.red.bold("CRITICAL");
    case "warn":
      return chalk.yellow("WARNING");
    case "info":
      return chalk.blue("INFO");
    case "pass":
      return chalk.green("PASS");
    case "fail":
      return chalk.red("FAIL");
    case "skip":
      return chalk.gray("SKIP");
  }
}

/** Compose the summary line parts from FindingsSummary counts. */
function summaryParts(summary: FindingsSummary): string[] {
  const parts: string[] = [];
  if (summary.total > 0) {
    parts.push(`${summary.total} checks`);
  }
  // Stable iteration order via Object.entries; callers control key order via
  // the literal-object spelling at the call site.
  for (const [key, count] of Object.entries(summary.counts)) {
    switch (key) {
      case "pass":
        parts.push(chalk.green(`${count} pass`));
        break;
      case "fail":
        parts.push(chalk.red(`${count} fail`));
        break;
      case "warn":
      case "warning":
        parts.push(chalk.yellow(`${count} warn`));
        break;
      case "skip":
        parts.push(chalk.gray(`${count} skip`));
        break;
      case "critical":
        parts.push(chalk.red(`${count} critical`));
        break;
      case "info":
        parts.push(chalk.blue(`${count} info`));
        break;
      default:
        parts.push(`${count} ${key}`);
    }
  }
  return parts;
}

/** Print the summary line + optional footer for findings variants. */
function emitSummary(summary: FindingsSummary): void {
  const parts = summaryParts(summary);
  if (parts.length > 0) {
    console.log(`\n  ${parts.join(", ")}.`);
  }
  if (summary.footer !== undefined && summary.footer !== "") {
    console.log(chalk.cyan(`  ${summary.footer}`));
  }
}

/** Config A — compact line-per-finding render (doctor / health-flat). */
function renderFindingsCompact(
  findings: ReadonlyArray<NormalizedFinding>,
  summary: FindingsSummary,
): void {
  console.log("");

  if (findings.length === 0) {
    console.log(chalk.green("  No findings.\n"));
  } else {
    for (const finding of findings) {
      const icon = statusIcon(finding.status);
      const badge = finding.badge ? chalk.cyan(` ${finding.badge}`) : "";
      console.log(
        `  ${icon} ${chalk.bold(finding.category)} / ${finding.title}: ${finding.message}${badge}`,
      );
      if (finding.hint) {
        console.log(chalk.gray(`      ${finding.hint}`));
      }
    }
  }

  emitSummary(summary);
  console.log("");
}

/** Config B — cli-table3 5-col render (security). */
function renderFindingsAsTable(
  findings: ReadonlyArray<NormalizedFinding>,
  summary: FindingsSummary,
): void {
  if (findings.length === 0) {
    console.log(chalk.green("\n  No security findings.\n"));
  } else {
    const rows: string[][] = findings.map((f) => [
      statusIcon(f.status),
      colorSeverity(f.status),
      f.category,
      f.message,
      f.hint ?? "",
    ]);
    renderTable(["", "Severity", "Category", "Message", "Remediation"], rows);
  }

  emitSummary(summary);
}

/** Config C — grouped-by-category compact render (health). */
function renderFindingsGroupedByCategory(
  findings: ReadonlyArray<NormalizedFinding>,
  summary: FindingsSummary,
): void {
  const grouped = new Map<string, NormalizedFinding[]>();
  for (const finding of findings) {
    const existing = grouped.get(finding.category);
    if (existing) {
      existing.push(finding);
    } else {
      grouped.set(finding.category, [finding]);
    }
  }

  for (const [category, group] of grouped) {
    console.log();
    console.log(chalk.bold(category));

    for (const finding of group) {
      const icon =
        finding.status === "fail" ? chalk.red("x") : chalk.yellow("!");
      const msg =
        finding.status === "fail"
          ? chalk.red(finding.message)
          : chalk.yellow(finding.message);
      console.log(`  ${icon} ${msg}`);

      if (finding.hint) {
        console.log(`    ${chalk.gray(finding.hint)}`);
      }
    }
  }

  console.log();
  emitSummary(summary);
}

/** Config D — sections render (status / channel). */
function renderSections(sections: ReadonlyArray<Section>): void {
  for (const section of sections) {
    if (section.kind === "kv") {
      console.log(chalk.bold(`\n  ${section.title}`));
      // renderKeyValue expects [string, string][] (mutable). The Section.pairs
      // shape is ReadonlyArray<readonly [string, string]>; copy into a mutable
      // array for the primitive's signature.
      const pairs: [string, string][] = section.pairs.map(
        ([k, v]) => [k, v] as [string, string],
      );
      renderKeyValue(pairs);
      continue;
    }

    // kind: "table"
    if (section.title !== undefined) {
      console.log(chalk.bold(`\n  ${section.title}`));
    }
    if (section.rows.length === 0 && section.emptyMessage !== undefined) {
      console.log(chalk.dim(`    ${section.emptyMessage}`));
      continue;
    }
    const headers: string[] = [...section.headers];
    const rows: string[][] = section.rows.map((r) => [...r]);
    renderTable(headers, rows);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render findings or sections to stdout.
 *
 * Single source of truth for CLI table/listing rendering across the 5 CLI
 * sites consolidated in plan 58-02. See module doc for the per-site mapping.
 *
 * @param input - Discriminated payload: "findings" or "sections" variant
 * @param options - Render-mode + grouping options for findings variant
 */
export function renderFindings(
  input: FindingsInput,
  options: RenderFindingsOptions = {},
): void {
  if (input.kind === "findings") {
    const renderMode = options.renderMode ?? "compact";
    const groupBy = options.groupBy ?? "none";

    if (renderMode === "table") {
      renderFindingsAsTable(input.findings, input.summary);
      return;
    }
    if (groupBy === "category") {
      renderFindingsGroupedByCategory(input.findings, input.summary);
      return;
    }
    renderFindingsCompact(input.findings, input.summary);
    return;
  }

  if (input.kind === "sections") {
    renderSections(input.sections);
    return;
  }

  // Exhaustiveness — AGENTS.md §2.8 closed-union discriminator.
  const _exhaustive: never = input;
  return _exhaustive;
}
