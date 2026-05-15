// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `setupNotifications` wiring factory.
 *
 * Asserts deterministic factory output, port-injection contract, and
 * downstream-service registration behavior. Phase 40 / Phase C §6.3.3 row 2.
 *
 * Use-case design (§3.3 / COV-10): every `it("...")` description names a
 * use case >=20 chars ending in a recognizable shape.
 *
 * @module
 */

import { describe, it } from "vitest";

// RED: test bodies are intentionally unimplemented (.todo) so the per-commit
// gate (`pnpm build && pnpm test && pnpm lint:security`) stays green while
// the use-case names are pinned. Bodies land in the GREEN commit.

describe("setupNotifications -- daemon wiring", () => {
  it.todo("registers SessionTracker as an ephemeral in-memory instance per daemon startup");
  it.todo("builds NotificationConfig map from PerAgentConfig.notification entries");
  it.todo("dispatch table routes notification events to the configured guard pipeline by notification kind");
  it.todo("criticalBypass=true skips the quiet-hours filter for critical-priority events");
  it.todo("quietHoursConfig.timezone is applied when classifying current-time-in-quiet-window");
  it.todo("empty notification config produces a no-op dispatcher (no throws on dispatch)");
});
