// SPDX-License-Identifier: Apache-2.0
/**
 * Per-step timeout helper for the daemon shutdown sequence.
 *
 * Extracted from setup-shutdown.ts to keep that file under 800 lines.
 * Zero deps on ShutdownDeps — pure utility.
 * @module
 */

import type { ComisLogger } from "@comis/infra";
import { systemSetTimeout, systemClearTimeout } from "@comis/core";

/** Per-step timeout budget (5s). The outer 30s hard timeout in graceful-shutdown.ts remains unchanged. */
export const STEP_TIMEOUT_MS = 5_000;

/**
 * Race `fn` against a STEP_TIMEOUT_MS timer. If the timer fires first, log a
 * WARN and continue — the outer 30s hard timeout will force-exit if enough
 * steps hang. Clears the per-step timer when the step resolves fast so no
 * dangling timers accumulate (~30 per shutdown without this guard).
 */
export async function withStepTimeout(
  fn: () => void | Promise<void>,
  component: string,
  logger: ComisLogger,
): Promise<void> {
  let timer: ReturnType<typeof systemSetTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(fn()),
      new Promise<never>((_, reject) => {
        timer = systemSetTimeout(() => reject(new Error(`Shutdown step "${component}" timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    logger.warn(
      {
        component,
        timeoutMs: STEP_TIMEOUT_MS,
        err: err instanceof Error ? err : String(err),
        hint: `Shutdown step "${component}" hung or failed; continuing with remaining steps`,
        errorKind: "timeout" as const,
      },
      "Shutdown step timed out or failed, continuing",
    );
  } finally {
    // Clear the step timer once the race settles so a fast step does not
    // leave a dangling 5s timer (≈30 of them per shutdown otherwise).
    if (timer !== undefined) systemClearTimeout(timer);
  }
}
