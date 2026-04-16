/**
 * Serialize write operations to the same file while allowing
 * parallel writes to different files. Prevents sub-agent race conditions.
 *
 * Key is canonical path (via realpathSync) so symlinks to the same
 * file serialize correctly.
 *
 * @module
 */

import { realpathSync } from "node:fs";

const queues = new Map<string, Promise<unknown>>();

/**
 * Resolve a file path to its canonical form for queue keying.
 * Falls back to the raw path if realpath fails (file doesn't exist yet).
 */
function canonicalize(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Execute `fn` with exclusive access to `filePath`. Concurrent calls
 * for the same canonical path are serialized; different paths run in parallel.
 *
 * Uses a non-empty rejection handler (not empty `.catch(() => {})`) so
 * prior failures are explicitly swallowed with a reason, per project
 * conventions (eslint-plugin-security ban on empty catch).
 *
 * @param filePath - Path to the file being mutated
 * @param fn - Async function to execute with exclusive access
 * @returns The result of `fn`
 */
export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = canonicalize(filePath);
  const previous = queues.get(key) ?? Promise.resolve();

  // Chain: wait for previous (swallowing its error), then run fn.
  // The rejection handler is non-empty to satisfy the project's ban on
  // empty `.catch(() => {})`. Prior write errors are already surfaced
  // to their own callers; here we just need to ensure the chain continues.
  const current = previous.then(
    () => fn(),
    (_priorError) => fn(),
  );

  queues.set(key, current);

  try {
    return await current;
  } finally {
    if (queues.get(key) === current) {
      queues.delete(key);
    }
  }
}

/** Clear all queues. Only for testing. */
export function _clearMutationQueuesForTest(): void {
  queues.clear();
}
