// SPDX-License-Identifier: Apache-2.0
/**
 * CLI output formatting utilities using chalk.
 *
 * Provides colored output functions for success, error, warning, and info messages.
 * Also provides a json() function for structured --format json output.
 *
 * @module
 */

import chalk from "chalk";
import { sanitizeLogString } from "@comis/core";

/**
 * Print a success message (green checkmark prefix).
 */
export function success(msg: string): void {
  console.log(chalk.green(`  ${msg}`));
}

/**
 * Print an error message (red cross prefix) to stderr.
 */
export function error(msg: string): void {
  // Sanitize all CLI error output to prevent credential leaks
  console.error(chalk.red(`  ${sanitizeLogString(msg)}`));
}

/**
 * Print a warning message (yellow exclamation prefix).
 */
export function warn(msg: string): void {
  console.log(chalk.yellow(`  ${msg}`));
}

/**
 * Print an info message (blue prefix).
 */
export function info(msg: string): void {
  console.log(chalk.blue(`  ${msg}`));
}

/**
 * Print data as formatted JSON. Used for --format json output.
 */
export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
