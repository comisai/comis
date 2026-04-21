// SPDX-License-Identifier: Apache-2.0
import type { Result } from "./result.js";
import { ok, err } from "./result.js";

/**
 * Check whether an AbortSignal has been aborted.
 *
 * Returns `ok(undefined)` when the signal is absent or not yet aborted,
 * and `err(reason)` when the signal is aborted.
 *
 * The reason is extracted from `signal.reason`:
 * - If it's already an Error, it's used directly
 * - Otherwise it's wrapped in `new Error(String(reason))`
 * - If no reason is set, defaults to "Aborted"
 *
 * @param signal - Optional AbortSignal to check
 * @returns Result indicating whether abort has occurred
 */
export function checkAborted(signal?: AbortSignal): Result<void, Error> {
  if (!signal || !signal.aborted) {
    return ok(undefined);
  }

  const reason =
    signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason ?? "Aborted"));

  return err(reason);
}
