// SPDX-License-Identifier: Apache-2.0
/**
 * Comis branded theme module for the init wizard.
 *
 * Provides the steel blue color palette and semantic output helpers
 * used by every wizard step. All helpers return strings (not console.log)
 * making them testable and composable.
 *
 * Color support detection uses chalk's built-in `chalk.level` which
 * already reads NO_COLOR and FORCE_COLOR env vars internally -- no
 * direct process.env access needed.
 *
 * Brand voice: competent, direct, trustworthy.
 *
 * @module
 */

import chalk from "chalk";
import type { ValidationResult } from "./types.js";

// ---------- Color Palette ----------

/**
 * Comis color palette -- steel blue identity with semantic colors.
 *
 * All values are hex strings for truecolor terminals.
 * Lower color-level terminals fall back to nearest ANSI equivalents.
 */
export const COMIS_PALETTE = {
  accent:       "#5B8DEF",  // Steel blue
  accentBright: "#7BA7FF",
  accentDim:    "#3A6CD4",
  success:      "#2FBF71",
  warn:         "#FFB020",
  error:        "#E23D2D",
  info:         "#8BA5D1",
  muted:        "#6B7280",
  dim:          "#9CA3AF",
  subtle:       "#374151",
  claw:         "#C0C0C0",
} as const;

// ---------- Color Support ----------

/** Semantic color names mapped to palette hex and ANSI fallbacks. */
type SemanticColor =
  | "accent"
  | "accentBright"
  | "accentDim"
  | "success"
  | "warn"
  | "error"
  | "info"
  | "muted"
  | "dim"
  | "subtle"
  | "claw";

/**
 * Apply a semantic color to text, respecting terminal color support.
 *
 * - Level 3 (truecolor): exact hex from COMIS_PALETTE
 * - Level 1-2 (basic/256): nearest chalk built-in color
 * - Level 0 (no color / NO_COLOR set): plain text
 */
function colorize(text: string, color: SemanticColor): string {
  if (chalk.level === 0) return text;

  if (chalk.level >= 3) {
    return chalk.hex(COMIS_PALETTE[color])(text);
  }

  // Basic/256-color fallback
  switch (color) {
    case "accent":
    case "accentBright":
    case "accentDim":
    case "info":
      return chalk.blue(text);
    case "success":
      return chalk.green(text);
    case "warn":
      return chalk.yellow(text);
    case "error":
      return chalk.red(text);
    case "muted":
    case "dim":
    case "subtle":
    case "claw":
      return chalk.gray(text);
  }
}

// ---------- Branded Output Helpers ----------

/**
 * Box-drawn heading banner for major wizard sections.
 *
 * Uses ASCII box-drawing characters (+, -, |) for maximum terminal
 * compatibility. Text is centered within the box.
 *
 * ```
 *  +-----------------------------------+
 *  |                                   |
 *  |   Comis Agent Setup            |
 *  |                                   |
 *  +-----------------------------------+
 * ```
 */
export function heading(text: string): string {
  const padding = 3;
  const minWidth = 40;
  const innerWidth = Math.max(text.length + padding * 2, minWidth);


  const horizontal = "-".repeat(innerWidth);
  const topBottom = ` +${horizontal}+`;
  const emptyLine = ` |${" ".repeat(innerWidth)}|`;

  const leftPad = Math.floor((innerWidth - text.length) / 2);
  const rightPad = innerWidth - text.length - leftPad;
  const textLine = ` |${" ".repeat(leftPad)}${text}${" ".repeat(rightPad)}|`;

  const box = [topBottom, emptyLine, textLine, emptyLine, topBottom].join("\n");

  return colorize(box, "accent");
}

/**
 * Horizontal section separator with optional label.
 *
 * ```
 * -- Label --------------------
 * ```
 *
 * Without label: a plain muted horizontal rule.
 */
export function sectionSeparator(label?: string): string {
  const totalWidth = 40;

  if (!label) {
    return colorize("-".repeat(totalWidth), "muted");
  }

  const prefix = "-- ";
  const labelPart = `${label} `;
  const remaining = totalWidth - prefix.length - labelPart.length;
  const suffix = "-".repeat(Math.max(4, remaining));

  return (
    colorize(prefix, "muted") +
    colorize(labelPart, "accent") +
    colorize(suffix, "muted")
  );
}

/**
 * Green checkmark-prefixed success message.
 *
 * Uses a check character when the terminal supports it,
 * falls back to "V" for basic/no-color terminals.
 */
export function success(text: string): string {
  const mark = chalk.level >= 1 ? "\u2713" : "V";
  return `  ${colorize(mark, "success")}  ${text}`;
}

/**
 * Yellow warning-prefixed message.
 */
export function warning(text: string): string {
  return `  ${colorize("!", "warn")}  ${text}`;
}

/**
 * Red error-prefixed message.
 *
 * Uses an X character (no Unicode cross -- works everywhere).
 */
export function error(text: string): string {
  return `  ${colorize("X", "error")}  ${text}`;
}

/**
 * Blue info-prefixed message.
 */
export function info(text: string): string {
  return `  ${colorize("i", "info")}  ${text}`;
}

/**
 * Format a ValidationResult into a styled string.
 *
 * Shows the error message and optional hint on a new line.
 */
export function formatValidationError(result: ValidationResult): string {
  let output = error(result.message);
  if (result.hint) {
    output += `\n  ${colorize(result.hint, "dim")}`;
  }
  return output;
}

/**
 * Apply the steel blue accent color to text.
 *
 * Convenience helper for inline branded coloring.
 */
export function brand(text: string): string {
  return colorize(text, "accent");
}
