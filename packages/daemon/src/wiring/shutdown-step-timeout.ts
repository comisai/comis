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

/** Default per-step timeout budget (5s). */
export const STEP_TIMEOUT_MS = 5_000;

/**
 * Race `fn` against its component timeout. If the timer fires first, log a
 * WARN and continue — the daemon hard timeout will force-exit if enough steps
 * hang. Clears the timer when the step resolves fast so no dangling timers
 * accumulate (~30 per shutdown without this guard).
 */
export async function withStepTimeout(
  fn: () => void | Promise<void>,
  component: string,
  logger: ComisLogger,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof systemSetTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(fn()),
      new Promise<never>((_, reject) => {
        timer = systemSetTimeout(() => reject(new Error(`Shutdown step "${component}" timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    logger.warn(
      {
        component,
        timeoutMs,
        err: err instanceof Error ? err : String(err),
        hint: `Shutdown step "${component}" hung or failed; continuing with remaining steps`,
        errorKind: "timeout" as const,
      },
      "Shutdown step timed out or failed, continuing",
    );
  } finally {
    // Clear the step timer once the race settles so a fast step does not
    // leave a dangling timer (≈30 of them per shutdown otherwise).
    if (timer !== undefined) systemClearTimeout(timer);
  }
}
