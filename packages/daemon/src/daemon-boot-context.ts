// SPDX-License-Identifier: Apache-2.0
/**
 * BootContext factory — split out of daemon-types.ts to keep that file a
 * pure type module (and under the per-file line cap). The container shape
 * itself lives in daemon-types.ts; this is the only runtime piece.
 *
 * @module
 */

import type { BootContext } from "./daemon-types.js";

/**
 * Factory that returns a BootContext with only the 2 forward-ref slot objects
 * eagerly initialized (`channelPluginsRef`, `bgNotifyRef`). All other fields —
 * including Group A (strict) — are uninitialized; the 5 `boot*` helpers populate
 * them in sequence.
 *
 * The cast through `as unknown as BootContext` is the documented trade-off:
 * Group A fields are strictly typed (no `?`) but cannot be fully populated at
 * construction time. Reads before population fail at runtime — the integration
 * test `test/integration/daemon-lifecycle.test.ts:89-99` (5 log lines in source
 * order) is the regression gate.
 *
 * Why eager init for the 2 forward refs: closures captured during
 * `bootFoundation` (`getChannelMaxChars` for setupAgents, `bgNotifyFn` for
 * backgroundTaskManager) read `.ref` at invocation time, so the container
 * object MUST exist before bootAgents/bootChannels run.
 */
export function createEmptyBootContext(): BootContext {
  return {
    channelPluginsRef: { ref: undefined },
    bgNotifyRef: { ref: undefined },
    // bgNotifyFn is non-optional but is assigned in bootFoundation; the
    // factory cast allows incremental population.
  } as unknown as BootContext;
}
