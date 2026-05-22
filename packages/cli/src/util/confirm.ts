// SPDX-License-Identifier: Apache-2.0
/**
 * One-shot CLI confirmation prompt.
 *
 * Consolidates four readline.createInterface confirms (agent delete,
 * memory clear, config rollback, config tooling-fill PromptIO) into one
 * helper backed by `@clack/prompts.p.confirm` (project default per
 * REQUIREMENTS.md L124; already a CLI dep at packages/cli/package.json:53).
 *
 * Treats user cancel (Ctrl+C, non-TTY) as `false` — DOES NOT throw
 * CancelError like the wizard adapter at clack-adapter.ts:222. The
 * wizard needs to unwind a multi-step flow; one-shot confirms have
 * nothing to unwind. Returning `false` matches the existing call sites'
 * "anything-not-yes means no" contract.
 *
 * The per-site TTY guard (e.g., agent.ts:221 `if (!options.yes &&
 * !process.stdin.isTTY) { error(...); process.exit(1); }`) stays in
 * place — confirm() is reached only when the call site decided to prompt.
 *
 * @module
 */

import * as p from "@clack/prompts";
import chalk from "chalk";

export interface ConfirmOptions {
  /** The question text to display. Wrapped in chalk.yellow for the prompt. */
  readonly message: string;
  /** Default answer when user presses Enter. Defaults to false. */
  readonly default?: boolean;
}

export async function confirm(opts: ConfirmOptions): Promise<boolean> {
  const result = await p.confirm({
    message: chalk.yellow(opts.message),
    initialValue: opts.default ?? false,
  });
  // Cancel (Ctrl+C, non-TTY) returns a Symbol → treat as "no" (defensive default).
  if (p.isCancel(result) || typeof result === "symbol") {
    return false;
  }
  return result;
}
