/**
 * CLI spinner utility using ora.
 *
 * Provides a withSpinner wrapper that shows a loading spinner while
 * an async operation runs, succeeding or failing visually.
 *
 * @module
 */

import ora from "ora";

/**
 * Run an async function while showing a spinner.
 *
 * On success: spinner shows success indicator.
 * On failure: spinner shows failure indicator, then rethrows.
 *
 * @param text - Spinner text displayed while waiting
 * @param fn - Async function to execute
 * @returns The result of fn
 */
export async function withSpinner<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const spinner = ora(text).start();
  try {
    const result = await fn();
    spinner.succeed();
    return result;
  } catch (err) {
    spinner.fail();
    throw err;
  }
}
